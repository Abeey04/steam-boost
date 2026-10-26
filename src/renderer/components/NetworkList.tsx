import { useState } from 'react'
import { api, useAction } from '../api'
import { formatBytes, KIND_LABEL, speedText, type SpeedUnit } from '../format'
import { KindIcon } from '../icons'
import type { NetworkView } from '../types'
import { Switch } from './Switch'

const GB = 1024 ** 3
const MB = 1024 ** 2

/** What a network is doing, in a word or two. */
function activity(
  network: NetworkView,
  unit: SpeedUnit,
  running: boolean
): { text: string; tone?: string } {
  if (network.role === 'off') return { text: 'Off' }
  if (network.role === 'no-route') return { text: 'No internet', tone: 'muted' }
  if (network.role === 'capped') return { text: 'Cap reached', tone: 'warn' }
  // With the boost off (or not listening), nothing is carried.
  if (!running) return { text: 'Idle', tone: 'muted' }
  if (network.resting) return { text: 'Retrying', tone: 'warn' }
  if (network.speedBytesPerSec > 0) {
    return { text: speedText(network.speedBytesPerSec, unit), tone: 'live' }
  }
  return { text: 'Ready', tone: 'muted' }
}

function CapEditor({
  network,
  busy,
  onSave,
  onClose
}: {
  network: NetworkView
  busy: boolean
  onSave: (bytes: number | null) => void
  onClose: () => void
}): React.JSX.Element {
  const current = network.dailyCapBytes
  const [unit, setUnit] = useState<'GB' | 'MB'>(current !== null && current < GB ? 'MB' : 'GB')
  const [text, setText] = useState(
    current !== null ? String(Number((current / (current < GB ? MB : GB)).toFixed(2))) : ''
  )
  const amount = Number(text)
  const valid = text.trim() !== '' && Number.isFinite(amount) && amount > 0
  return (
    <form
      className="cap-editor"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) onSave(Math.round(amount * (unit === 'GB' ? GB : MB)))
      }}
    >
      <label className="cap-label" htmlFor={`cap-${network.id}`}>
        Daily cap
      </label>
      <input
        id={`cap-${network.id}`}
        className="cap-input"
        inputMode="decimal"
        placeholder="2"
        value={text}
        autoFocus
        onChange={(event) => setText(event.target.value)}
      />
      <select
        className="cap-unit"
        value={unit}
        aria-label="Unit"
        onChange={(event) => setUnit(event.target.value as 'GB' | 'MB')}
      >
        <option value="GB">GB</option>
        <option value="MB">MB</option>
      </select>
      <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
        Save
      </button>
      {current !== null && (
        <button type="button" className="btn" disabled={busy} onClick={() => onSave(null)}>
          No cap
        </button>
      )}
      <button type="button" className="link" onClick={onClose}>
        Cancel
      </button>
      <p className="cap-help">
        Counted from midnight. Stops using {network.label} for Steam Boost once it&apos;s reached; a
        phone plan counts a little more for its own overhead, so leave some room.
      </p>
    </form>
  )
}

function NetworkRow({
  network,
  color,
  unit,
  running,
  editing,
  busy,
  onEdit,
  onChange
}: {
  network: NetworkView
  color: string
  unit: SpeedUnit
  running: boolean
  editing: boolean
  busy: boolean
  onEdit: (open: boolean) => void
  onChange: (patch: { enabled?: boolean; dailyCapBytes?: number | null }) => void
}): React.JSX.Element {
  const { text, tone } = activity(network, unit, running)
  const cap = network.dailyCapBytes
  const share = cap ? Math.min(1, network.usedTodayBytes / cap) : 0
  return (
    <li className={`network role-${network.role}`}>
      <span className="net-icon" style={{ color }}>
        <KindIcon kind={network.kind} size={18} />
      </span>
      <div className="net-main">
        <div className="net-name">{network.label}</div>
        <div className="net-meta">
          {KIND_LABEL[network.kind]}
          {network.address ? ` · ${network.address}` : ''}
        </div>
        <div className="net-usage">
          <span>
            {formatBytes(network.usedTodayBytes)}
            {cap ? ` of ${formatBytes(cap)}` : ''} today
          </span>
          {network.role !== 'no-route' && (
            <button type="button" className="link" onClick={() => onEdit(!editing)}>
              {cap ? 'Change cap' : 'Set daily cap'}
            </button>
          )}
        </div>
        {cap !== null && (
          <div className="meter" aria-hidden>
            <span
              className={share >= 1 ? 'full' : share > 0.85 ? 'near' : ''}
              style={{ width: `${share * 100}%` }}
            />
          </div>
        )}
      </div>
      <div className="net-side">
        <span className={`net-activity ${tone ?? ''}`}>{text}</span>
        <Switch
          size="sm"
          checked={network.enabled}
          disabled={busy}
          label={`Use ${network.label}`}
          onChange={(enabled) => onChange({ enabled })}
        />
      </div>
      {editing && (
        <CapEditor
          network={network}
          busy={busy}
          onClose={() => onEdit(false)}
          onSave={(bytes) => {
            onChange({ dailyCapBytes: bytes })
            onEdit(false)
          }}
        />
      )}
    </li>
  )
}

/** Every connection the computer has, what each is carrying, and its switch and daily cap. */
export function NetworkList({
  networks,
  running,
  colorOf,
  unit,
  onError
}: {
  networks: NetworkView[]
  /** The boost is on and listening. */
  running: boolean
  colorOf: (id: string) => string
  unit: SpeedUnit
  onError: (message: string) => void
}): React.JSX.Element {
  const { busy, run } = useAction(onError)
  const [editing, setEditing] = useState<string | null>(null)
  const active = networks.filter((network) => network.role === 'active').length
  // Ones switched off or capped are still there to use: the tip is for when there's no second.
  const usable = networks.filter((network) => network.role !== 'no-route').length
  return (
    <section className="card networks">
      <header className="card-head">
        <h2>Connections</h2>
        <span className="muted">
          {active} {running ? 'in use' : 'ready'}
        </span>
      </header>
      {networks.length === 0 ? (
        <p className="empty">Looking for connections…</p>
      ) : (
        <ul className="network-list">
          {networks.map((network) => (
            <NetworkRow
              key={network.id}
              network={network}
              color={colorOf(network.id)}
              unit={unit}
              running={running}
              editing={editing === network.id}
              busy={busy === network.id}
              onEdit={(open) => setEditing(open ? network.id : null)}
              onChange={(patch) => void run(network.id, () => api().setNetwork(network.id, patch))}
            />
          ))}
        </ul>
      )}
      {usable < 2 && networks.length > 0 && (
        <p className="tip">
          Steam Boost adds speed when there&apos;s a second connection with its own internet: tether
          your phone over USB, or plug in a line from another provider. Wi-Fi and Ethernet to the
          same router share one line.
        </p>
      )}
      <p className="fine">
        Each piece of a download goes to whichever connection will finish it first.
      </p>
    </section>
  )
}
