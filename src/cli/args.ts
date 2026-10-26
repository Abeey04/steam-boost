// What steam-boost-cli reads from its command line, and the data caps it keeps. Apart from cli.ts
// (which runs as soon as it's loaded) so the tests can reach them.

export interface Args {
  command: string
  rest: string[]
  flags: Map<string, string | true>
}

/** Flags followed by a value: `--cap "Ethernet 3=2GB"` as well as `--cap="Ethernet 3=2GB"`. */
const TAKES_VALUE = new Set(['networks', 'address', 'cap'])

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    // Split at the first "=" only: a --cap value has one of its own.
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    const name = eq < 0 ? body : body.slice(0, eq)
    const next = argv[i + 1]
    if (eq >= 0) flags.set(name, body.slice(eq + 1))
    else if (TAKES_VALUE.has(name) && next !== undefined && !next.startsWith('--')) {
      flags.set(name, next)
      i++
    } else flags.set(name, true)
  }
  return { command: positional[0] ?? 'help', rest: positional.slice(1), flags }
}

export function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

// Binary units, as the live table shows them (gb() in cli.ts). A bare number is GB.
const UNITS: Record<string, number> = {
  '': 1024 ** 3,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4
}

/** "2GB", "1.5 G", "500MB": in bytes. */
export function parseSize(text: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text)
  const unit = match ? UNITS[match[2].toLowerCase()] : undefined
  if (!match || unit === undefined) {
    throw new Error(`"${text.trim()}" isn't a size: write it like 2GB or 500MB.`)
  }
  const bytes = Math.round(Number(match[1]) * unit)
  if (bytes <= 0) throw new Error(`A cap of ${text.trim()} leaves nothing to use.`)
  return bytes
}

/** `--cap "Ethernet 3=2GB,Wi-Fi=10GB"`: network id to bytes. */
export function parseCaps(text: string): Map<string, number> {
  const usage = 'write it as network=size, like "Ethernet 3=2GB"'
  const caps = new Map<string, number>()
  for (const part of text.split(',')) {
    if (!part.trim()) continue
    // The last "=": a size has none, a network's name just might.
    const eq = part.lastIndexOf('=')
    const id = eq < 0 ? '' : part.slice(0, eq).trim()
    if (!id) throw new Error(`--cap: ${usage}, not "${part.trim()}".`)
    caps.set(id, parseSize(part.slice(eq + 1)))
  }
  if (caps.size === 0) throw new Error(`--cap: ${usage}.`)
  return caps
}

/** What each network has carried since the boost started, held to its cap where it has one: a
 * phone's mobile data, say. Counts every byte received, chunks fetched twice included, since the
 * phone's plan counts those too. */
export class DataCaps {
  private readonly used = new Map<string, number>()
  private readonly reached = new Set<string>()

  constructor(readonly caps: ReadonlyMap<string, number> = new Map()) {}

  /** Counts `bytes` received over `id`. True the one time that brings it to its cap. */
  record(id: string, bytes: number): boolean {
    const total = (this.used.get(id) ?? 0) + bytes
    this.used.set(id, total)
    const cap = this.caps.get(id)
    if (cap === undefined || total < cap || this.reached.has(id)) return false
    this.reached.add(id)
    return true
  }

  usedBy(id: string): number {
    return this.used.get(id) ?? 0
  }

  capOf(id: string): number | undefined {
    return this.caps.get(id)
  }

  isCapped(id: string): boolean {
    return this.reached.has(id)
  }
}
