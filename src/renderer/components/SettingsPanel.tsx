import { useState } from 'react'
import { api, useAction } from '../api'
import { ChevronIcon } from '../icons'
import type { AppState, SettingsPatch } from '../types'
import { Switch } from './Switch'

function ToggleRow({
  title,
  detail,
  checked,
  disabled,
  onChange
}: {
  title: string
  detail: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <div className="setting">
      <div>
        <div className="setting-title">{title}</div>
        <div className="setting-detail">{detail}</div>
      </div>
      <Switch size="sm" checked={checked} disabled={disabled} label={title} onChange={onChange} />
    </div>
  )
}

export function SettingsPanel({
  state,
  onError
}: {
  state: AppState
  onError: (message: string) => void
}): React.JSX.Element {
  const { busy, run } = useAction(onError)
  const [copied, setCopied] = useState(false)
  const { settings } = state
  const change = (patch: SettingsPatch): void => {
    void run('settings', () => api().updateSettings(patch))
  }

  return (
    <details className="card settings">
      <summary>
        <h2>Settings</h2>
        <ChevronIcon size={16} className="chevron" />
      </summary>

      <div className="setting">
        <div>
          <div className="setting-title">Listen on</div>
          <div className="setting-detail">
            Where Steam finds Steam Boost. Try the LAN address if Steam ignores this PC&apos;s
            127.0.0.1. Changing it means setting up again.
          </div>
        </div>
        <div className="segmented" role="group" aria-label="Listen on">
          <button
            type="button"
            aria-pressed={settings.addressMode === 'loopback'}
            disabled={busy !== null}
            onClick={() => change({ addressMode: 'loopback' })}
          >
            This PC
          </button>
          <button
            type="button"
            aria-pressed={settings.addressMode === 'lan'}
            disabled={busy !== null}
            onClick={() => change({ addressMode: 'lan' })}
          >
            LAN address
          </button>
        </div>
      </div>

      <ToggleRow
        title="HTTPS pass-through"
        detail="Also answers on port 443, for Steam versions that talk HTTPS to a cache (seen on Linux and the Steam Deck)."
        checked={settings.httpsPassthrough}
        disabled={busy !== null}
        onChange={(httpsPassthrough) => change({ httpsPassthrough })}
      />
      {state.canStartAtLogin && (
        <ToggleRow
          title={state.platform === 'darwin' ? 'Open at login' : 'Start with Windows'}
          detail="Starts in the tray, so the boost is there whenever Steam downloads."
          checked={settings.startAtLogin}
          disabled={busy !== null}
          onChange={(startAtLogin) => change({ startAtLogin })}
        />
      )}
      <ToggleRow
        title="Keep running in the tray"
        detail="Closing the window leaves the boost on. Quit from the tray icon."
        checked={settings.closeToTray}
        disabled={busy !== null}
        onChange={(closeToTray) => change({ closeToTray })}
      />

      <div className="settings-actions">
        <button
          type="button"
          className="btn"
          onClick={() => void run('report', () => api().report())}
        >
          Tell us how it went
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            void run('copy', async () => {
              await api().copyDiagnostics()
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
          }
        >
          {copied ? 'Copied' : 'Copy diagnostics'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void run('logs', () => api().openLogs())}
        >
          Open logs
        </button>
        {state.boost.hostsEntry === 'set' && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy !== null}
            onClick={() => void run('teardown', () => api().tearDown())}
          >
            {busy === 'teardown' ? 'Undoing…' : 'Undo setup'}
          </button>
        )}
      </div>
      <p className="fine">
        Tell us how it went opens the Speed reports discussion on GitHub, with a reply filled in on
        your clipboard to paste. If something didn&apos;t work, open an issue and paste in Copy
        diagnostics. Undo setup takes Steam Boost&apos;s line out of your hosts file; uninstalling
        does that too.
      </p>
    </details>
  )
}
