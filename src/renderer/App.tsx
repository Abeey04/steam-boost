import { useCallback, useEffect, useState } from 'react'
import { PROJECT } from '../shared/project'
import {
  api,
  errorMessage,
  useAppState,
  useNetworkColors,
  useSpeedHistory,
  useStoredState
} from './api'
import { Hero } from './components/Hero'
import { NetworkList } from './components/NetworkList'
import { SettingsPanel } from './components/SettingsPanel'
import { SetupCard } from './components/SetupCard'
import { SetupGuide } from './components/SetupGuide'
import { Switch } from './components/Switch'
import { phaseOf, SPEED_UNITS, type Phase, type SpeedUnit } from './format'
import { CloseIcon, ExternalIcon, Logo } from './icons'
import type { AppState } from './types'

const SETTING_UP = new Set<Phase>(['starting', 'error', 'elsewhere', 'setup', 'restart'])

/** Until Steam has used Steam Boost, the window opens on what to do next (SetupGuide) rather than
 * on a speed with nothing to show. Starting counts only before setup: the engine starts again
 * whenever the boost is switched back on. */
function settingUp(state: AppState): boolean {
  const { phase } = phaseOf(state)
  return phase === 'starting' ? state.boost.hostsEntry !== 'set' : SETTING_UP.has(phase)
}

function ExternalLink({
  href,
  children
}: {
  href: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        void api().openUrl(href)
      }}
    >
      {children}
    </a>
  )
}

export function App(): React.JSX.Element {
  const state = useAppState()
  const samples = useSpeedHistory(state)
  const { colorOf, rankOf } = useNetworkColors(state?.networks ?? [])
  const [unit, setUnit] = useStoredState<SpeedUnit>('speed-unit', 'MB/s', SPEED_UNITS)
  const [error, setError] = useState<string | null>(null)
  const [toggling, setToggling] = useState(false)
  const showError = useCallback((message: string) => setError(message), [])

  // An error stays long enough to read, then goes.
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 12_000)
    return () => clearTimeout(timer)
  }, [error])

  if (!state) {
    return (
      <div className="loading">
        <Logo size={44} />
      </div>
    )
  }

  const toggle = (enabled: boolean): void => {
    setToggling(true)
    api()
      .updateSettings({ enabled })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setToggling(false))
  }

  return (
    <div className="app">
      {state.update && (
        <div className="banner">
          <span>
            {PROJECT.name} {state.update.version} is out.
          </span>
          <ExternalLink href={state.update.url}>
            Download <ExternalIcon size={13} />
          </ExternalLink>
        </div>
      )}
      <header className="topbar">
        <Logo size={30} />
        <div className="brand">
          <div className="brand-name">{PROJECT.name}</div>
          <div className="brand-sub">Steam downloads over every connection</div>
        </div>
        <Switch
          size="lg"
          checked={state.settings.enabled}
          disabled={toggling}
          label={state.settings.enabled ? 'Turn Steam Boost off' : 'Turn Steam Boost on'}
          onChange={toggle}
        />
      </header>

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss"
            onClick={() => setError(null)}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      <main>
        {settingUp(state) ? (
          <SetupGuide state={state} colorOf={colorOf} onError={showError} />
        ) : (
          <>
            <Hero
              state={state}
              samples={samples}
              colorOf={colorOf}
              rankOf={rankOf}
              unit={unit}
              onUnit={setUnit}
            />
            <SetupCard state={state} />
          </>
        )}
        <NetworkList
          networks={state.networks}
          running={state.settings.enabled && state.boost.state === 'on'}
          colorOf={colorOf}
          unit={unit}
          onError={showError}
        />
        <SettingsPanel state={state} onError={showError} />
      </main>

      <footer className="footer">
        <span>
          {PROJECT.name} {state.version}
        </span>
        <ExternalLink href={PROJECT.github}>GitHub</ExternalLink>
        <ExternalLink href={PROJECT.site}>Website</ExternalLink>
        <span className="footer-note">Not affiliated with Valve.</span>
      </footer>
    </div>
  )
}
