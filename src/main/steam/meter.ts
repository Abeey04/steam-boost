// A rate meter: bytes counted as they arrive, read as bytes a second over the last few seconds.
// From Plexo's download/transfer.ts (MIT License, Copyright (c) 2026 Anmol Kapil; see LICENSE).

const SPEED_WINDOW_MS = 3000

export class Meter {
  private total = 0
  private readings: { bytes: number; time: number }[] = []

  add(bytes: number): void {
    this.total += bytes
  }

  /** The rate over the last SPEED_WINDOW_MS, as of `now`. Bytes before the first reading are
   * the meter's starting point, not part of any rate. */
  read(now: number): number {
    const { readings } = this
    readings.push({ bytes: this.total, time: now })
    while (readings.length > 2 && readings[1].time <= now - SPEED_WINDOW_MS) readings.shift()
    const oldest = readings[0]
    // At least a second: the clock can come round again ms later, and one burst over a few ms
    // reads as a speed the connection never had.
    return (this.total - oldest.bytes) / Math.max((now - oldest.time) / 1000, 1)
  }
}
