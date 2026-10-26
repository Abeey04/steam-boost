import { execFile } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { TRIGGER_HOST } from './steamHosts'

// Whether Steam took the boost up, from what Steam itself logs. On startup it looks the trigger
// up and, finding a private address, writes (logs/content_log.txt):
//
//   [2019-12-21 17:15:14] Enabling local content cache at '::ffff:c0a8:1e80' from lookup of
//   lancache.steamcontent.com.
//
// (one line; the address as an IPv4-mapped IPv6 one), then "Adding cache type 'LANCache' on host
// ...". Steam only looks when it starts, so a boost set up while it runs needs a Steam restart.

const execFileAsync = promisify(execFile)

export interface CacheSighting {
  /** As Steam stamped the line ("2019-12-21 17:15:14"), local time. */
  at: string | null
  /** The address Steam will send its requests to, as IPv4 when it is one. */
  address: string
}

const SIGHTING = new RegExp(
  String.raw`^(?:\[([^\]]+)\]\s*)?Enabling local content cache at '([^']+)' from lookup of ` +
    TRIGGER_HOST.replace(/\./g, '\\.'),
  'i'
)

/** `::ffff:c0a8:1e80` and `::ffff:192.168.30.128` as 192.168.30.128; anything else as it is. */
export function normalizeLoggedAddress(address: string): string {
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mappedDotted) return mappedDotted[1]
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16)
    const low = parseInt(mappedHex[2], 16)
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
  }
  return address
}

/** Every time the log says Steam enabled a LAN cache, oldest first. */
export function findCacheSightings(log: string): CacheSighting[] {
  const sightings: CacheSighting[] = []
  for (const line of log.split(/\r?\n/)) {
    const match = SIGHTING.exec(line.trim())
    if (match) sightings.push({ at: match[1] ?? null, address: normalizeLoggedAddress(match[2]) })
  }
  return sightings
}

/** The lines Steam logged mentioning a LAN cache, newest last: what to show someone checking. */
export function cacheLines(log: string, limit = 8): string[] {
  return log
    .split(/\r?\n/)
    .filter((line) => /local content cache|LANCache/i.test(line))
    .slice(-limit)
}

/** Where Steam is usually installed, most likely first. */
export function steamDirCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string[] {
  if (platform === 'win32') {
    return [
      join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam'),
      join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Steam')
    ]
  }
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', 'Steam')]
  return [
    join(home, '.steam', 'steam'),
    join(home, '.local', 'share', 'Steam'),
    join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')
  ]
}

/** The Steam folder: on Windows from the registry (where Steam records it), else the first
 * candidate that has a logs folder. */
export async function findSteamDir(): Promise<string | null> {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'reg',
        ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
        { windowsHide: true, timeout: 5000 }
      )
      const match = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout)
      if (match) candidates.push(match[1].trim().replace(/\//g, '\\'))
    } catch {
      // No Steam in the registry; fall back to where it usually is.
    }
  }
  candidates.push(...steamDirCandidates())
  for (const dir of candidates) {
    try {
      if ((await stat(join(dir, 'logs'))).isDirectory()) return dir
    } catch {
      // Not this one.
    }
  }
  return null
}

/** The end of Steam's content log: the last `bytes` of it, which hold the latest start. */
export async function readContentLogTail(
  steamDir: string,
  bytes = 1024 * 1024
): Promise<string | null> {
  const path = join(steamDir, 'logs', 'content_log.txt')
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}
