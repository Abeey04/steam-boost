import { arch, release } from 'node:os'
import type { AppState } from '../shared/boost'
import { cacheLines } from './steam/contentLog'

// "Copy diagnostics": one block of text with what's needed to look into a problem: versions, the
// settings, Steam Boost's state, each network, the hosts-file line, what Steam's log says about
// caches, and the end of Steam Boost's own log. No account details exist to leak: Steam Boost
// never sees any.

export interface DiagnosticsInput {
  state: AppState
  /** Our block (or the lines naming Steam's cache) from the hosts file. */
  hostsLines: string[]
  steamLog: string | null
  recentLog: string[]
}

const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`

export function diagnosticsReport({
  state,
  hostsLines,
  steamLog,
  recentLog
}: DiagnosticsInput): string {
  const { boost, settings } = state
  const lines = [
    `Steam Boost ${state.version} on ${state.platform} ${release()} (${arch()})`,
    `Generated ${new Date().toISOString()}`,
    '',
    '## Status',
    `state: ${boost.state}${boost.error ? ` (${boost.error})` : ''}`,
    `address: ${boost.address ?? '-'}; https pass-through: ${boost.httpsPassthrough}`,
    `hosts entry: ${boost.hostsEntry}; lancache.steamcontent.com resolves to: ${boost.resolvesTo ?? 'nothing'}`,
    `Steam running: ${boost.steamRunning}; Steam using it (its log): ${boost.steamUsing}`,
    `last request: ${boost.lastRequestAt ? new Date(boost.lastRequestAt).toISOString() : 'never'}`,
    `requests: ${JSON.stringify(boost.requests)}; this session: ${mb(boost.sessionBytes)}`,
    `hint: ${boost.hint ?? '-'}`,
    '',
    '## Settings',
    JSON.stringify(settings, null, 2),
    '',
    '## Networks',
    ...state.networks.map(
      (network) =>
        `- ${network.label} [${network.id}] ${network.kind} ${network.address ?? ''}: ${network.role}` +
        `${network.resting ? ', resting' : ''}; today ${mb(network.usedTodayBytes)}` +
        `${network.dailyCapBytes ? ` of ${mb(network.dailyCapBytes)}` : ''}`
    ),
    '',
    '## Hosts file',
    ...(hostsLines.length > 0 ? hostsLines : ['(no line for lancache.steamcontent.com)']),
    '',
    "## Steam's log: caches",
    ...(steamLog === null
      ? ["(couldn't find Steam's content_log.txt)"]
      : cacheLines(steamLog, 10).map((line) => line.trim())),
    '',
    '## Steam Boost log',
    ...recentLog.slice(-120)
  ]
  return lines.join('\n')
}
