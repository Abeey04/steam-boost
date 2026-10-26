import type { Sample } from '../api'
import { formatBytes, formatSpeed, phaseOf, speedText, type Phase, type SpeedUnit } from '../format'
import type { AppState } from '../types'
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

/** Where things stand, the combined speed, and the last minute by connection. */
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
  const moving = state.networks.filter((network) => network.speedBytesPerSec > 0)
  const { sessionBytes, requests } = state.boost

  return (
    <section className={`card hero phase-${phase}`} aria-live="polite">
      <div className="hero-status">
        <span className={`dot tone-${TONE[phase]}`} aria-hidden />
        <div>
          <div className="hero-title">{title}</div>
          <div className="hero-detail">{detail}</div>
        </div>
      </div>
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
      <div className="legend">
        {moving.length === 0 ? (
          <span className="legend-empty">
            {enabled ? 'Nothing downloading right now.' : 'Turn it on to boost Steam downloads.'}
          </span>
        ) : (
          moving.map((network) => (
            <span key={network.id} className="legend-item">
              <span className="swatch" style={{ background: colorOf(network.id) }} />
              {network.label}
              <span className="legend-speed">{speedText(network.speedBytesPerSec, unit)}</span>
            </span>
          ))
        )}
      </div>
      {sessionBytes > 0 && (
        <div className="hero-foot">
          {formatBytes(sessionBytes)} carried since it started · {requests.done.toLocaleString()}{' '}
          pieces{requests.failed > 0 ? ` · ${requests.failed} failed` : ''}
        </div>
      )}
    </section>
  )
}
