import { useState } from 'react'
import { phaseOf, secondsAgo } from '../format'
import { CheckIcon } from '../icons'
import type { AppState } from '../types'

function Step({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return (
    <li className="step step-done">
      <span className="step-mark" aria-hidden>
        <CheckIcon size={14} />
      </span>
      <div className="step-body">
        <div className="step-title">{title}</div>
        <div className="step-detail">{detail}</div>
      </div>
    </li>
  )
}

/** Once Steam uses Steam Boost: one line saying so, which opens to the three things that make it
 * work (listening, the hosts-file line, Steam having found it). Until then the window shows
 * SetupGuide in its place. */
export function SetupCard({ state }: { state: AppState }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const { boost } = state
  const { phase } = phaseOf(state)
  // Starting, or off: it can't say yet that Steam uses it.
  if (phase !== 'ready' && phase !== 'boosting') return null

  if (!expanded) {
    return (
      <section className="card setup-done">
        <span className="step-mark" aria-hidden>
          <CheckIcon size={14} />
        </span>
        <span>Set up. Steam is using Steam Boost.</span>
        <button type="button" className="link" onClick={() => setExpanded(true)}>
          Details
        </button>
      </section>
    )
  }

  return (
    <section className="card setup">
      <header className="card-head">
        <h2>Set up</h2>
        <button type="button" className="link" onClick={() => setExpanded(false)}>
          Hide
        </button>
      </header>
      <ol className="steps">
        <Step
          title={`Listening on ${boost.address}:80${boost.httpsPassthrough ? ' (and 443)' : ''}`}
          detail="Steam hands its downloads to this address."
        />
        <Step
          title="Steam is pointed here"
          detail={`Your hosts file sends lancache.steamcontent.com to ${boost.address}.`}
        />
        <Step
          title="Steam is using it"
          detail={
            boost.lastRequestAt !== null
              ? `Steam last asked ${secondsAgo(boost.lastRequestAt)}.`
              : 'Start a download in Steam to see the boost.'
          }
        />
      </ol>
    </section>
  )
}
