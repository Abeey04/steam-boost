import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// JSON files in the app's data folder (settings.json, usage.json).

/** The file's contents, or undefined when it's missing or isn't JSON. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

const writing = new Map<string, Promise<void>>()

/** Writes through a temporary file, so a crash halfway leaves the old file whole. Writes to one
 * path go one at a time, in order. */
export function writeJson(path: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const next = (writing.get(path) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => writeNow(path, text))
  writing.set(path, next)
  return next
}

async function writeNow(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text, 'utf8')
  // Windows refuses a rename over a file another program has open for a moment (an antivirus
  // scanning it, say): try again shortly.
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(temporary, path)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      await sleep(50 * attempt)
    }
  }
}
