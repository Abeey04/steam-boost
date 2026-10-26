import { useState } from 'react'
import { api, useAction } from '../api'
import { secondsAgo } from '../format'
import { AlertIcon, CheckIcon, SpinnerIcon } from '../icons'
import type { AppState, RestartResult } from '../types'

type StepState = 'done' | 'todo' | 'bad' | 'busy'

function Step({
  number,
  state,
  title,
  detail,
  action,
  children
}: {
  number: number
  state: StepState
  title: string
  detail?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <li className={`step step-${state}`}>
      <span className="step-mark" aria-hidden>
        {state === 'done' ? (
          <CheckIcon size={14} />
        ) : state === 'busy' ? (
          <SpinnerIcon size={14} />
        ) : state === 'bad' ? (
          <AlertIcon size={14} />
        ) : (
          number
        )}
      </span>
      <div className="step-body">
        <div className="step-title">{title}</div>
        {detail && <div className="step-detail">{detail}</div>}
        {children}
      </div>
      {action && <div className="step-action">{action}</div>}
    </li>
  )
}

const RESTART_SAID: Record<RestartResult, string | null> = {
  restarted: 'Steam is starting again. Once it is back, start a download.',
  started: 'Steam is starting. Once it is up, start a download.',
  timeout: "Steam didn't close. Exit it from its menu (Steam > Exit), then open it again.",
  failed: "Couldn't reach Steam. Is it installed? Open it yourself, then start a download."
}

/** The three things between switching it on and Steam using it: listening, the hosts-file line,
 * and Steam starting again to find it. Folds away to one line once all three are done. */
export function SetupCard({
  state,
  onError
}: {
  state: AppState
  onError: (message: string) => void
}): React.JSX.Element | null {
  const { busy, run } = useAction(onError)
  const [expanded, setExpanded] = useState(false)
  const [restartNote, setRestartNote] = useState<string | null>(null)
  const { boost, platform } = state
  if (!state.settings.enabled) return null

  const listening = boost.state === 'on'
  const pointed = boost.hostsEntry === 'set'
  const using = boost.lastRequestAt !== null || boost.steamUsing === true
  const port443 = boost.httpsPassthrough ? ' (and 443)' : ''
  const prompt =
    platform === 'win32'
      ? 'Windows will ask for permission.'
      : platform === 'darwin'
        ? 'macOS will ask for your password.'
        : 'Your system will ask for your password.'

  if (listening && pointed && using && !expanded) {
    return (
      <section className="card setup-done">
        <CheckIcon size={16} />
        <span>Set up. Steam is using Steam Boost.</span>
        <button type="button" className="link" onClick={() => setExpanded(true)}>
          Details
        </button>
      </section>
    )
  }

  const restart = async (): Promise<void> => {
    setRestartNote(null)
    const result = await run('restart', () => api().restartSteam())
    if (result) setRestartNote(RESTART_SAID[result])
  }

  const useLan = async (): Promise<void> => {
    await run('lan', async () => {
      await api().updateSettings({ addressMode: 'lan' })
      await api().setUp()
      const result = await api().restartSteam()
      setRestartNote(RESTART_SAID[result])
    })
  }

  return (
    <section className="card setup">
      <header className="card-head">
        <h2>Get Steam using it</h2>
        {listening && pointed && using && (
          <button type="button" className="link" onClick={() => setExpanded(false)}>
            Hide
          </button>
        )}
      </header>
      <ol className="steps">
        {listening ? (
          <Step
            number={1}
            state="done"
            title={`Listening on ${boost.address}:80${port443}`}
            detail="Steam will hand its downloads to this address."
          />
        ) : boost.state === 'error' ? (
          <Step
            number={1}
            state="bad"
            title="Couldn't listen for Steam"
            detail={boost.error}
            action={
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => void run('retry', () => api().retry())}
              >
                {busy === 'retry' ? 'Trying…' : 'Try again'}
              </button>
            }
          />
        ) : (
          <Step number={1} state="busy" title="Starting…" />
        )}

        {pointed ? (
          <Step
            number={2}
            state="done"
            title="Steam is pointed here"
            detail={`Your hosts file sends lancache.steamcontent.com to ${boost.address}.`}
          />
        ) : boost.hostsEntry === 'elsewhere' ? (
          <Step
            number={2}
            state="bad"
            title="Another line points Steam elsewhere"
            detail={`Your hosts file already sends lancache.steamcontent.com to ${boost.resolvesTo ?? 'another address'}, and the first line wins. Remove that line (a LAN-cache tool may have added it), then set up again.`}
          />
        ) : (
          <Step
            number={2}
            state={busy === 'setup' ? 'busy' : 'todo'}
            title="Point Steam here"
            detail={`Adds one line to your hosts file. ${prompt}`}
            action={
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null || !listening}
                onClick={() => void run('setup', () => api().setUp())}
              >
                Set up…
              </button>
            }
          />
        )}

        {using ? (
          <Step
            number={3}
            state="done"
            title="Steam is using it"
            detail={
              boost.lastRequestAt !== null
                ? `Steam last asked ${secondsAgo(boost.lastRequestAt)}.`
                : 'Start a download in Steam to see the boost.'
            }
          />
        ) : (
          <Step
            number={3}
            state={busy === 'restart' ? 'busy' : 'todo'}
            title="Restart Steam"
            detail={
              boost.steamRunning === false
                ? "Steam isn't running. Start it, and it will find Steam Boost."
                : 'Steam looks for a cache only when it starts.'
            }
            action={
              <button
                type="button"
                className="btn"
                disabled={busy !== null || !pointed}
                onClick={() => void restart()}
              >
                {boost.steamRunning === false ? 'Start Steam' : 'Restart Steam'}
              </button>
            }
          >
            {restartNote && <div className="note">{restartNote}</div>}
            {boost.hint === 'try-lan' && (
              <div className="callout">
                <div>
                  Steam started, but didn&apos;t take the cache at 127.0.0.1. Some Steam versions
                  only use a cache on a LAN address.
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== null}
                  onClick={() => void useLan()}
                >
                  {busy === 'lan' ? 'Switching…' : 'Use my LAN address'}
                </button>
              </div>
            )}
          </Step>
        )}
      </ol>
    </section>
  )
}
