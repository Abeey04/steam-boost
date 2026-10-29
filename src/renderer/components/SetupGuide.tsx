import { useState } from 'react'
import { api, useAction } from '../api'
import { phaseOf } from '../format'
import { AlertIcon, KindIcon, SpinnerIcon } from '../icons'
import type { AppState, RestartResult } from '../types'

// The window until Steam has used Steam Boost: in place of a speed and a chart with nothing to show
// yet, one card that says what will change and the one thing to do next. Setting up and
// restarting Steam always go together, so they're one button.

const RESTART_SAID: Record<RestartResult, string> = {
  restarted: 'Steam is starting again. Once it is back, start a download.',
  started: 'Steam is starting. Once it is up, start a download.',
  timeout: "Steam didn't close. Exit it from its menu (Steam > Exit), then open it again.",
  failed: "Couldn't reach Steam. Is it installed? Open it yourself, then start a download."
}

/** What the OS asks before the hosts file changes, as the card says it. */
function promptFor(platform: string): { once: string; now: string } {
  if (platform === 'win32') {
    return {
      once: 'Windows asks for permission once.',
      now: 'Approve the Windows prompt to add the line.'
    }
  }
  if (platform === 'darwin') {
    return {
      once: 'macOS asks for your password once.',
      now: 'Enter your password in the macOS prompt to add the line.'
    }
  }
  return {
    once: 'Your system asks for your password once.',
    now: 'Enter your password to add the line.'
  }
}

interface View {
  eyebrow?: string
  title: string
  text: string
  icon?: 'spin' | 'alert'
  body?: React.ReactNode
  action?: React.ReactNode
  fine?: string
}

export function SetupGuide({
  state,
  colorOf,
  onError
}: {
  state: AppState
  colorOf: (id: string) => string
  onError: (message: string) => void
}): React.JSX.Element {
  const { busy, run } = useAction(onError)
  /** The step a button started that is still going: the hosts-file prompt, or Steam's restart. */
  const [doing, setDoing] = useState<'hosts' | 'restart' | null>(null)
  const [restarted, setRestarted] = useState<RestartResult | null>(null)
  const { phase } = phaseOf(state)
  const { boost, platform } = state
  const steamOff = boost.steamRunning === false
  const connected = state.networks.filter((network) => network.role === 'active')
  const prompt = promptFor(platform)

  /** Points Steam here (unless it already is) and restarts it, saying which step it's on. */
  const pointAndRestart = (
    key: string,
    setUpFirst: boolean,
    before?: () => Promise<void>
  ): void => {
    void run(key, async () => {
      try {
        await before?.()
        if (setUpFirst) {
          setDoing('hosts')
          await api().setUp()
        }
        setDoing('restart')
        setRestarted(await api().restartSteam())
      } finally {
        setDoing(null)
      }
    })
  }
  /** The card's main button: green, unless a callout above it has the step to take first (a
   * screen has one green button). */
  const main = (
    label: string,
    onClick: () => void,
    { disabled = false, quiet = false } = {}
  ): React.ReactNode => (
    <button
      type="button"
      className={`btn btn-wide${quiet ? '' : ' btn-primary'}`}
      disabled={busy !== null || disabled}
      onClick={onClick}
    >
      {label}
    </button>
  )

  let view: View
  if (doing === 'hosts') {
    view = { title: 'Setting up…', text: prompt.now, icon: 'spin' }
  } else if (doing === 'restart') {
    view = {
      title: 'Restarting Steam…',
      text: 'Steam closes, then opens again. This can take a minute.',
      icon: 'spin'
    }
  } else if (phase === 'starting') {
    view = { title: 'Starting…', text: 'Opening port 80 for Steam.', icon: 'spin' }
  } else if (phase === 'error') {
    view = {
      title: "Steam Boost couldn't start",
      text: boost.error ?? "It couldn't listen for Steam.",
      icon: 'alert',
      action: (
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void run('retry', () => api().retry())}
        >
          {busy === 'retry' ? 'Trying…' : 'Try again'}
        </button>
      )
    }
  } else if (phase === 'elsewhere') {
    view = {
      title: 'Another line points Steam elsewhere',
      text: `Your hosts file already sends lancache.steamcontent.com to ${boost.resolvesTo ?? 'another address'}, and the first line wins. Remove that line (a LAN-cache tool may have added it), and Steam Boost picks it up within a few seconds.`,
      icon: 'alert'
    }
  } else if (phase === 'restart') {
    const tryLan =
      boost.hint === 'try-lan' ? (
        <div className="callout">
          <div>
            Steam started, but didn&apos;t take the cache at 127.0.0.1. Some Steam versions only use
            a cache on a LAN address.
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() =>
              pointAndRestart('lan', true, () => api().updateSettings({ addressMode: 'lan' }))
            }
          >
            Use my LAN address
          </button>
        </div>
      ) : undefined
    if (restarted === 'restarted' || restarted === 'started') {
      view = {
        title: 'Waiting for Steam',
        text: RESTART_SAID[restarted],
        body: tryLan,
        action: (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => pointAndRestart('restart', false)}
          >
            Restart Steam again
          </button>
        )
      }
    } else {
      view = {
        title: steamOff ? 'Start Steam to begin' : 'Restart Steam to begin',
        text: restarted
          ? RESTART_SAID[restarted]
          : steamOff
            ? 'Steam Boost is set up. Steam finds it when it starts.'
            : 'Steam Boost is set up. Steam looks for it only when it starts.',
        body: tryLan,
        action: main(
          steamOff ? 'Start Steam' : 'Restart Steam',
          () => pointAndRestart('restart', false),
          { quiet: tryLan !== undefined }
        )
      }
    }
  } else {
    view = {
      eyebrow: 'Setup · about a minute',
      title:
        connected.length >= 2
          ? `Let Steam download over ${connected.length === 2 ? 'both' : `all ${connected.length}`} connections`
          : 'Set up Steam Boost',
      text: `Steam Boost adds one line to your hosts file so Steam sends its downloads here, then ${steamOff ? 'starts' : 'restarts'} Steam. You can undo it in Settings.`,
      body: (
        <>
          {connected.length > 0 && (
            <ul className="chips" aria-label="Connections with internet">
              {connected.map((network) => (
                <li key={network.id} className="chip">
                  <span style={{ color: colorOf(network.id) }}>
                    <KindIcon kind={network.kind} size={14} />
                  </span>
                  {network.label}
                </li>
              ))}
            </ul>
          )}
          {connected.length < 2 && (
            <p className="tip">
              {connected.length === 0
                ? 'No connection has internet right now. '
                : 'That is one connection so far. '}
              For the boost, add a second with its own internet: plug in your phone with USB
              tethering on. It can join any time, before or after setup.
            </p>
          )}
        </>
      ),
      action: main(
        steamOff ? 'Set up and start Steam' : 'Set up and restart Steam',
        () => pointAndRestart('setup', true),
        { disabled: boost.state !== 'on' }
      ),
      fine: `${prompt.once}${steamOff ? '' : ' Steam closes and opens again.'}`
    }
  }

  return (
    <section className="card guide">
      <div className="guide-head" aria-live="polite" aria-atomic="true">
        {view.eyebrow && <div className="eyebrow">{view.eyebrow}</div>}
        <h2 className={`guide-title${view.icon === 'alert' ? ' bad' : ''}`}>
          {view.icon === 'spin' && <SpinnerIcon size={16} />}
          {view.icon === 'alert' && <AlertIcon size={16} />}
          {view.title}
        </h2>
        <p className="guide-text">{view.text}</p>
      </div>
      {view.body}
      {view.action}
      {view.fine && <p className="guide-fine">{view.fine}</p>}
    </section>
  )
}
