import { colorStyle, HISTORY_SECONDS, type Sample } from '../api'
import { speedText, type SpeedUnit } from '../format'

// The last minute, each network's speed stacked on the ones below it: the gap between the top
// line and any one band is what the other connections add.

const WIDTH = 600
const HEIGHT = 132
const MiB = 1024 * 1024

/** A round top for the scale, in bytes a second: 1, 1.5, 2, 3, 5 or 7.5 times a power of ten, in
 * MB/s, close enough above the fastest second that the bands fill most of the chart. */
export function niceMax(bytesPerSec: number): number {
  const mb = Math.max(bytesPerSec / MiB, 1)
  const power = 10 ** Math.floor(Math.log10(mb))
  const step = [1, 1.5, 2, 3, 5, 7.5, 10].find((candidate) => candidate * power >= mb) ?? 10
  return step * power * MiB
}

export function SpeedChart({
  samples,
  series,
  colorOf,
  unit
}: {
  samples: Sample[]
  /** Network ids, bottom band first. */
  series: string[]
  colorOf: (id: string) => string
  unit: SpeedUnit
}): React.JSX.Element {
  const recent = samples.slice(-HISTORY_SECONDS)
  // Fewer samples than a minute's worth sit at the right, as if the chart had been scrolling.
  const offset = HISTORY_SECONDS - recent.length
  const totals = recent.map((sample) =>
    series.reduce((sum, id) => sum + (sample.speeds[id] ?? 0), 0)
  )
  const top = niceMax(Math.max(0, ...totals) * 1.1)
  const x = (index: number): number => ((index + offset) / (HISTORY_SECONDS - 1)) * WIDTH
  const y = (value: number): number => HEIGHT - (value / top) * (HEIGHT - 4)

  let below = recent.map(() => 0)
  const bands = series.map((id) => {
    const above = recent.map((sample, index) => below[index] + (sample.speeds[id] ?? 0))
    const upper = above.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
    const lower = below.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
    below = above
    // A network that carried nothing all minute draws nothing, not a line along the bottom.
    const drawn = upper.length > 1 && recent.some((sample) => (sample.speeds[id] ?? 0) > 0)
    return {
      id,
      area: drawn ? `M${upper.join('L')}L${lower.reverse().join('L')}Z` : '',
      line: drawn ? `M${upper.join('L')}` : ''
    }
  })

  return (
    <div className="chart">
      <span className="chart-scale">{speedText(top, unit)}</span>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Download speed over the last minute, by connection"
      >
        <line className="chart-grid" x1="0" x2={WIDTH} y1={HEIGHT / 2} y2={HEIGHT / 2} />
        <line className="chart-base" x1="0" x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} />
        {bands.map((band) => (
          <g key={band.id} style={colorStyle(colorOf(band.id))}>
            <path className="chart-band" d={band.area} />
            <path className="chart-edge" d={band.line} />
          </g>
        ))}
      </svg>
    </div>
  )
}
