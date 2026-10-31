import { averageSpeeds, colorStyle, useGameArt, type Sample } from '../api'
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  phaseOf,
  speedText,
  type Phase,
  type SpeedUnit
} from '../format'
import type { AppState, GameDownload } from '../types'
import { SpeedChart } from './SpeedChart'

const TONE: Record<Phase, 'off' | 'wait' | 'good' | 'bad'> = {
  off: 'off',
  starting: 'wait',
  error: 'bad',
  setup: 'wait',
  elsewhere: 'bad',
  restart: 'wait',
  ready: 'good',
  boosting: 'good'
}

/** Seconds of speeds the shares and the gain are averaged over, so they don't jump every second. */
const STEADY_SECONDS = 5

/** The game Steam is downloading: its art, how far along it is, the time left at today's speed,
 * and the time the boost has saved on it. */
function Game({
  download,
  speed
}: {
  download: GameDownload
  /** Bytes a second, steadied. */
  speed: number
}): React.JSX.Element {
  const art = useGameArt(download.appId)
  const { downloadedBytes: done, totalBytes: total } = download
  const fraction = total > 0 ? Math.min(1, done / total) : null
  const left = total > done && speed > 0 ? (total - done) / speed : null
  return (
    <div className="game">
      {art ? (
        <img className="game-art" src={art} alt="" />
      ) : (
        <span className="game-art" aria-hidden />
      )}
      <div className="game-main">
        <div className="game-head">
          <span className="game-name">{download.name}</span>
          {fraction !== null && <span className="game-percent">{Math.floor(fraction * 100)}%</span>}
        </div>
        {fraction !== null && (
          <div className="game-progress" aria-hidden>
            <span style={{ width: `${fraction * 100}%` }} />
          </div>
        )}
        <div className="game-meta">
          {total > 0 ? `${formatBytes(done)} of ${formatBytes(total)}` : 'Downloading'}
          {left !== null && ` · ${formatDuration(left)} left`}
          {download.savedSeconds >= 60 && ` · ${formatDuration(download.savedSeconds)} saved`}
        </div>
      </div>
    </div>
  )
}

/** Where things stand, the combined speed and what the other connections add, the last minute by
 * connection, and each one's share. */
export function Hero({
  state,
  samples,
  colorOf,
  rankOf,
  unit,
  onUnit
}: {
  state: AppState
  samples: Sample[]
  colorOf: (id: string) => string
  rankOf: (id: string) => number
  unit: SpeedUnit
  onUnit: (unit: SpeedUnit) => void
}): React.JSX.Element {
  const { phase, title, detail } = phaseOf(state)
  const enabled = state.settings.enabled
  const speed = formatSpeed(enabled ? state.boost.speedBytesPerSec : 0, unit)
  // Bands for every network that's in use or shows in the last minute.
  const series = state.networks
    .filter(
      (network) =>
        network.role === 'active' || samples.some((sample) => sample.speeds[network.id] > 0)
    )
    .map((network) => network.id)
    .sort((a, b) => rankOf(a) - rankOf(b))
  // What each connection has carried lately, in the chart's order.
  const steady = averageSpeeds(samples, STEADY_SECONDS)
  const parts = enabled
    ? state.networks
        .filter((network) => (steady[network.id] ?? 0) > 0)
        .map((network) => ({ network, speed: steady[network.id] }))
        .sort((a, b) => rankOf(a.network.id) - rankOf(b.network.id))
    : []
  const total = parts.reduce((sum, part) => sum + part.speed, 0)
  const fastest = parts.reduce<(typeof parts)[number] | null>(
    (best, part) => (!best || part.speed > best.speed ? part : best),
    null
  )
  // What the others carry on top of the fastest connection's own speed.
  const gain =
    fastest && parts.length > 1 ? Math.round(((total - fastest.speed) / fastest.speed) * 100) : 0
  const { sessionBytes, requests, download, savedSecondsTotal } = state.boost

  // Only where things stand is announced as it changes: the speed, chart and shares below it
  // change every second, and a screen reader would read them out every second too.
  return (
    <section className={`card hero phase-${phase}`}>
      <div className="hero-status">
        <span className={`dot tone-${TONE[phase]}`} aria-hidden />
        <div className="hero-text" aria-live="polite" aria-atomic="true">
          <div className="hero-title">{title}</div>
          <div className="hero-detail">{detail}</div>
        </div>
        {fastest && gain >= 5 && (
          <span className="gain">
            +{gain}% on top of {fastest.network.label}
          </span>
        )}
      </div>
      {enabled && download && <Game download={download} speed={total} />}
      <button
        type="button"
        className="speed"
        onClick={() => onUnit(unit === 'MB/s' ? 'Mbps' : 'MB/s')}
        title="Show in MB/s or Mbps"
      >
        <span className="speed-value">{enabled ? speed.value : '–'}</span>
        <span className="speed-unit">{speed.unit}</span>
      </button>
      <SpeedChart samples={samples} series={series} colorOf={colorOf} unit={unit} />
      {parts.length > 0 && (
        <div className="share-bar" aria-hidden>
          {parts.map(({ network, speed: carried }) => (
            <span
              key={network.id}
              style={{ ...colorStyle(colorOf(network.id)), flexGrow: carried }}
            />
          ))}
        </div>
      )}
      <div className="legend">
        {parts.length === 0 ? (
          <span className="legend-empty">
            {enabled ? 'Nothing downloading right now.' : 'Turn it on to boost Steam downloads.'}
          </span>
        ) : (
          parts.map(({ network, speed: carried }) => (
            <span key={network.id} className="legend-item" style={colorStyle(colorOf(network.id))}>
              <span className="swatch" />
              {network.label}
              <span className="legend-speed">
                {speedText(network.speedBytesPerSec, unit)}
                {parts.length > 1 ? ` · ${Math.round((carried / total) * 100)}%` : ''}
              </span>
            </span>
          ))
        )}
      </div>
      {(sessionBytes > 0 || savedSecondsTotal >= 60) && (
        <div className="hero-foot">
          {/* A piece that failed went to another connection: retried, not lost. */}
          {sessionBytes > 0 && (
            <div>
              {formatBytes(sessionBytes)} carried since it started ·{' '}
              {requests.done.toLocaleString()} pieces
              {requests.failed > 0 ? ` · ${requests.failed} retried` : ''}
            </div>
          )}
          {savedSecondsTotal >= 60 && (
            <div className="hero-saved">
              {formatDuration(savedSecondsTotal)} saved in all, every download counted
            </div>
          )}
        </div>
      )}
    </section>
  )
}
