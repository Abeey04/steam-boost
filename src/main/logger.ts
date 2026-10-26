import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'

// A plain log file, so a problem on someone's computer can be looked into: logs/main.log in the
// app's data folder, kept to about a megabyte (the one before is main.old.log). The last few
// hundred lines are also kept in memory for "Copy diagnostics".

const MAX_BYTES = 1024 * 1024
const RECENT_LINES = 300

let file: string | null = null
let directory: string | null = null
const recent: string[] = []

export function initLog(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    directory = dir
    file = join(dir, 'main.log')
  } catch {
    // No log file, then; the console still has it.
  }
}

export function logDirectory(): string | null {
  return directory
}

export function log(...parts: unknown[]): void {
  const text = parts
    .map((part) => (typeof part === 'string' ? part : inspect(part, { depth: 4 })))
    .join(' ')
  const line = `${new Date().toISOString()} ${text}`
  console.log(line)
  recent.push(line)
  if (recent.length > RECENT_LINES) recent.shift()
  if (!file) return
  try {
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) {
      renameSync(file, file.replace(/\.log$/, '.old.log'))
    }
    appendFileSync(file, `${line}\n`)
  } catch {
    // Logging must never break the app.
  }
}

export function recentLog(): string[] {
  return [...recent]
}
