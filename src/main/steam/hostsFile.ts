import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TRIGGER_HOST } from './steamHosts'

// The one line that turns Steam boost on for this computer: TRIGGER_HOST pointing at the boost.
// Kept between markers so it can be found again, changed and taken out without touching anything
// else in the file. Editing the hosts file needs administrator rights on every OS.

export const BEGIN_MARK = '# >>> Steam Boost >>>'
export const END_MARK = '# <<< Steam Boost <<<'

/** What plexo's Steam boost (plexo-steam-boost) marks its block with: read as ours, so a block it
 * left behind is replaced or taken out rather than left to compete. */
const LEGACY_MARKS: Array<[string, string]> = [
  ['# >>> plexo steam boost >>>', '# <<< plexo steam boost <<<']
]
const BEGIN_MARKS = new Set([BEGIN_MARK, ...LEGACY_MARKS.map(([begin]) => begin)])
const END_MARKS = new Set([END_MARK, ...LEGACY_MARKS.map(([, end]) => end)])

export function hostsFilePath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'win32') {
    return join(
      env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows',
      'System32',
      'drivers',
      'etc',
      'hosts'
    )
  }
  return '/etc/hosts'
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** The lines of `text` outside our block, and the block's own lines (markers excluded). */
function split(text: string): { outside: string[]; inside: string[] } {
  const lines = text.split(/\r?\n/)
  const outside: string[] = []
  const inside: string[] = []
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (BEGIN_MARKS.has(trimmed)) inBlock = true
    else if (END_MARKS.has(trimmed)) inBlock = false
    else if (inBlock) inside.push(line)
    else outside.push(line)
  }
  return { outside, inside }
}

function mentionsTrigger(line: string): string | null {
  const content = line.replace(/#.*/, '').trim()
  if (!content) return null
  const [address, ...names] = content.split(/\s+/)
  return names.some((name) => name.toLowerCase() === TRIGGER_HOST) ? address : null
}

/** Whether our block (or plexo's) is in `text`, set to an address or not. */
export function hasBlock(text: string): boolean {
  return text.split(/\r?\n/).some((line) => BEGIN_MARKS.has(line.trim()))
}

/** The address our block points TRIGGER_HOST at, if the block is there. */
export function readEntry(text: string): string | null {
  for (const line of split(text).inside) {
    const address = mentionsTrigger(line)
    if (address) return address
  }
  return null
}

/** Addresses other lines, outside our block, give TRIGGER_HOST: the OS uses the first one, so one
 * of these would win over ours (or another cache is set up on purpose). */
export function otherEntries(text: string): string[] {
  return split(text)
    .outside.map(mentionsTrigger)
    .filter((address): address is string => address !== null)
}

/** `text` with our block pointing TRIGGER_HOST at `address`, in place of any block before. */
export function withEntry(text: string, address: string): string {
  const eol = eolOf(text)
  const { outside } = split(text)
  while (outside.length > 0 && outside[outside.length - 1].trim() === '') outside.pop()
  const block = [BEGIN_MARK, `${address} ${TRIGGER_HOST}`, END_MARK]
  return [...outside, ...(outside.length > 0 ? [''] : []), ...block, ''].join(eol)
}

/** `text` without our block. Everything else is kept as it was. */
export function withoutEntry(text: string): string {
  const eol = eolOf(text)
  const { outside } = split(text)
  while (outside.length > 0 && outside[outside.length - 1].trim() === '') outside.pop()
  return outside.length > 0 ? [...outside, ''].join(eol) : ''
}

export async function readHostsFile(path = hostsFilePath()): Promise<string> {
  return readFile(path, 'utf8')
}

/** Writes the hosts file. Fails with EPERM/EACCES unless this process runs as administrator. */
export async function writeHostsFile(text: string, path = hostsFilePath()): Promise<void> {
  await writeFile(path, text, 'utf8')
}
