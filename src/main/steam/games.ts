import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Which game Steam is downloading, from Steam's own files, so the window can name it, show how
// far along it is, and its art:
//
// - logs/content_log.txt says what each download is doing ("AppID 1422450 App update changed :
//   Running Update,Downloading,") and how much it has to fetch ("update started : download
//   0/23045488").
// - steamapps/libraryfolders.vdf lists the folders games are installed in; each has an
//   appmanifest_<id>.acf with the game's name and its BytesToDownload and BytesDownloaded.
// - appcache/librarycache keeps the art Steam shows in its library.

/** Valve's KeyValues text, as .vdf and .acf files hold it: nested "key" "value" pairs. */
export type Vdf = { [key: string]: string | Vdf }

/** Reads KeyValues text: quoted keys and values, { } for a nested block, // comments. */
export function parseVdf(text: string): Vdf {
  const tokens: Array<string | '{' | '}'> = []
  const pattern = /"((?:[^"\\]|\\.)*)"|([{}])|\/\/[^\n]*|[^\s{}"]+/g
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) {
      tokens.push(
        match[1].replace(/\\(.)/g, (_all, char: string) =>
          char === 'n' ? '\n' : char === 't' ? '\t' : char
        )
      )
    } else if (match[2] !== undefined) {
      tokens.push(match[2] as '{' | '}')
    } else if (!match[0].startsWith('//')) {
      tokens.push(match[0])
    }
  }
  let position = 0
  const block = (): Vdf => {
    const result: Vdf = {}
    while (position < tokens.length) {
      const key = tokens[position++]
      if (key === '}') break
      if (key === '{') continue
      const value = tokens[position++]
      if (value === '{') result[key] = block()
      else if (value !== undefined && value !== '}') result[key] = value
      else break
    }
    return result
  }
  return block()
}

const child = (node: Vdf | string | undefined, key: string): Vdf | string | undefined => {
  if (!node || typeof node === 'string') return undefined
  const found = Object.keys(node).find((name) => name.toLowerCase() === key.toLowerCase())
  return found === undefined ? undefined : node[found]
}

/** The folders libraryfolders.vdf lists, Steam's own first. Older files give each folder's path as
 * the value itself ("1" "D:\\SteamLibrary"), newer ones as a "path" inside a block. */
export function libraryPaths(vdf: Vdf, steamDir: string): string[] {
  const root = child(vdf, 'libraryfolders')
  // The registry writes Steam's folder "c:/program files (x86)/steam", the file "C:\\Program
  // Files (x86)\\Steam": one folder.
  const same = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const paths = [steamDir]
  if (root && typeof root !== 'string') {
    for (const [key, value] of Object.entries(root)) {
      if (!/^\d+$/.test(key)) continue
      const path = typeof value === 'string' ? value : child(value, 'path')
      if (typeof path === 'string' && path && !paths.some((known) => same(known) === same(path))) {
        paths.push(path)
      }
    }
  }
  return paths
}

export interface AppManifest {
  appId: number
  name: string
  bytesToDownload: number
  bytesDownloaded: number
}

/** The parts of an appmanifest_<id>.acf the window uses; null when it isn't one. */
export function parseAppManifest(text: string): AppManifest | null {
  const state = child(parseVdf(text), 'AppState')
  const field = (key: string): string | undefined => {
    const value = child(state, key)
    return typeof value === 'string' ? value : undefined
  }
  const appId = Number(field('appid'))
  const name = field('name')
  if (!Number.isInteger(appId) || appId <= 0 || !name) return null
  const bytes = (key: string): number => {
    const value = Number(field(key))
    return Number.isFinite(value) && value > 0 ? value : 0
  }
  return {
    appId,
    name,
    bytesToDownload: bytes('BytesToDownload'),
    bytesDownloaded: bytes('BytesDownloaded')
  }
}

export interface LoggedDownload {
  appId: number
  /** From the last "update started" line for it: what it had, and had to fetch, then. */
  startedBytes: number | null
  totalBytes: number | null
}

const UPDATE_CHANGED = /AppID (\d+) App update changed : (.*)$/
const UPDATE_STARTED = /AppID (\d+) update started : download (\d+)\/(\d+)/

/** The game Steam is updating or installing now, from its content log: the last app whose last
 * word on its update was "Running Update" (downloading, then staging and committing what came),
 * not "None" (done, paused or stopped). */
export function currentDownload(log: string): LoggedDownload | null {
  let latest: { appId: number; running: boolean } | null = null
  const started = new Map<number, { done: number; total: number }>()
  for (const line of log.split(/\r?\n/)) {
    const changed = UPDATE_CHANGED.exec(line)
    if (changed) {
      latest = { appId: Number(changed[1]), running: /Running Update/.test(changed[2]) }
      continue
    }
    const start = UPDATE_STARTED.exec(line)
    if (start) started.set(Number(start[1]), { done: Number(start[2]), total: Number(start[3]) })
  }
  if (!latest?.running) return null
  const counts = started.get(latest.appId)
  return {
    appId: latest.appId,
    startedBytes: counts?.done ?? null,
    totalBytes: counts?.total ?? null
  }
}

/** Every library folder Steam knows, from libraryfolders.vdf. */
export async function steamLibraries(steamDir: string): Promise<string[]> {
  try {
    const text = await readFile(join(steamDir, 'steamapps', 'libraryfolders.vdf'), 'utf8')
    return libraryPaths(parseVdf(text), steamDir)
  } catch {
    return [steamDir]
  }
}

/** A game's manifest, from whichever library holds it, with when it was last written. */
export async function findAppManifest(
  libraries: readonly string[],
  appId: number
): Promise<{ manifest: AppManifest; mtimeMs: number } | null> {
  for (const library of libraries) {
    const path = join(library, 'steamapps', `appmanifest_${appId}.acf`)
    try {
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      const manifest = parseAppManifest(text)
      if (manifest) return { manifest, mtimeMs: info.mtimeMs }
    } catch {
      // Not in this library.
    }
  }
  return null
}

/** The wide header art Steam shows for a game (460 × 215): appcache/librarycache/<id>/<hash>/
 * library_header.jpg since 2024, <id>_header.jpg before. */
export async function findGameArt(steamDir: string, appId: number): Promise<string | null> {
  const cache = join(steamDir, 'appcache', 'librarycache')
  const folder = join(cache, String(appId))
  try {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const candidates = entry.isDirectory()
        ? [join(folder, entry.name, 'library_header.jpg'), join(folder, entry.name, 'header.jpg')]
        : entry.name === 'library_header.jpg' || entry.name === 'header.jpg'
          ? [join(folder, entry.name)]
          : []
      for (const path of candidates) {
        if (await isFile(path)) return path
      }
    }
  } catch {
    // No folder of its own: the older layout.
  }
  const old = join(cache, `${appId}_header.jpg`)
  return (await isFile(old)) ? old : null
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
