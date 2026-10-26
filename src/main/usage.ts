import { readJson, writeJson } from './jsonStore'

// What each network has carried today for Steam Boost, so a daily cap (a phone plan's daily data,
// say) holds across restarts. A day is the computer's own: the counts start again at midnight.
// Counted as bytes arrive (the engine's `take`), chunks fetched twice included, since a phone
// plan counts those too.

/** The local calendar day of `date`, as YYYY-MM-DD. */
export function dayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export class UsageBook {
  private day: string
  private readonly bytes = new Map<string, number>()
  private dirty = false

  constructor(
    private readonly path: string | null,
    private readonly now: () => Date = () => new Date()
  ) {
    this.day = dayKey(now())
  }

  /** Today's counts from `path`, if it holds today's. */
  static async load(path: string, now?: () => Date): Promise<UsageBook> {
    const book = new UsageBook(path, now)
    const saved = (await readJson(path)) as { day?: unknown; bytes?: unknown } | undefined
    if (saved && saved.day === book.day && saved.bytes && typeof saved.bytes === 'object') {
      for (const [id, value] of Object.entries(saved.bytes as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          book.bytes.set(id, value)
        }
      }
    }
    return book
  }

  /** Counts `bytes` for network `id`. Returns its total for today. */
  add(id: string, bytes: number): number {
    this.roll()
    const total = (this.bytes.get(id) ?? 0) + bytes
    this.bytes.set(id, total)
    this.dirty = true
    return total
  }

  usedToday(id: string): number {
    this.roll()
    return this.bytes.get(id) ?? 0
  }

  /** Writes the counts if they changed since the last time. */
  async save(): Promise<void> {
    this.roll()
    if (!this.dirty || !this.path) return
    this.dirty = false
    await writeJson(this.path, { day: this.day, bytes: Object.fromEntries(this.bytes) })
  }

  private roll(): void {
    const today = dayKey(this.now())
    if (today === this.day) return
    this.day = today
    this.bytes.clear()
    this.dirty = true
  }
}
