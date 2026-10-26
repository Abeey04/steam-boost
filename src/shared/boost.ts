import type { NetworkInterfaceKind } from './network'

// Steam Boost as the window sees it. The main process keeps it (main/boostController.ts and
// main/index.ts) and sends the whole thing whenever any of it changes; the window only ever asks
// for changes through SteamBoostApi.

/** One network's part in the engine's work right now (main/steam/steamBoost.ts). */
export interface SteamBoostNetworkStatus {
  /** A NetworkInterfaceInfo id. */
  id: string
  label: string
  speedBytesPerSec: number
  /** Everything Steam received over it since the boost started. */
  bytesTotal: number
  /** Steam's requests it is carrying now. */
  inflight: number
  /** HTTPS connections passed through it now (a Steam that won't talk plain HTTP to a cache). */
  tunnels: number
  /** Its connections kept failing, so it gets nothing for a while. */
  resting: boolean
}

/** - off: switched off.
 * - starting: opening its port.
 * - on: listening; whether Steam uses it is BoostStatus.steamUsing.
 * - error: couldn't listen (`error` says why: port 80 taken, …). */
export type BoostState = 'off' | 'starting' | 'on' | 'error'

/** Whether the hosts file sends Steam here: our line is there (set), isn't (missing), or another
 * line gives the name another address first (elsewhere). */
export type HostsEntry = 'set' | 'missing' | 'elsewhere' | 'unknown'

/** How a network takes part:
 * - active: carries Steam's requests.
 * - off: switched off here.
 * - no-route: has no way to the internet (no default gateway), so it can't reach Steam.
 * - capped: has used its daily cap. */
export type NetworkRole = 'active' | 'off' | 'no-route' | 'capped'

export interface NetworkView {
  id: string
  label: string
  kind: NetworkInterfaceKind
  /** Its IPv4 address, to tell two adapters apart. */
  address: string | null
  role: NetworkRole
  enabled: boolean
  dailyCapBytes: number | null
  /** What it has carried today (the computer's local day) for Steam Boost. */
  usedTodayBytes: number
  speedBytesPerSec: number
  inflight: number
  resting: boolean
}

/** Where the boost listens: 127.0.0.1, or this computer's LAN address for a Steam that won't take
 * a cache on loopback. */
export type AddressMode = 'loopback' | 'lan'

export interface NetworkSettings {
  /** Unset: on. */
  enabled?: boolean
  /** Bytes a day; unset: no cap. */
  dailyCapBytes?: number
}

export interface AppSettings {
  /** The boost runs while the app does. */
  enabled: boolean
  addressMode: AddressMode
  /** Passes HTTPS to the cache through on port 443, for a Steam that won't talk HTTP to it. */
  httpsPassthrough: boolean
  /** By NetworkInterfaceInfo id. */
  networks: Record<string, NetworkSettings>
  /** Starts with the computer, in the tray (Windows and macOS). */
  startAtLogin: boolean
  /** Closing the window keeps the boost running in the tray. */
  closeToTray: boolean
}

/** Something worth suggesting:
 * - try-lan: Steam has started since the hosts line went in, and still didn't take the cache at
 *   127.0.0.1. Some Steam builds won't use a loopback cache; the LAN address may work. */
export type Hint = 'try-lan' | null

export interface BoostStatus {
  state: BoostState
  error?: string
  /** Where it listens, and where the hosts line points Steam. Null until it knows. */
  address: string | null
  /** Listening on 443 too. */
  httpsPassthrough: boolean
  hostsEntry: HostsEntry
  /** What lancache.steamcontent.com resolves to on this computer now; null: nothing. */
  resolvesTo: string | null
  /** From Steam's own log: true once it says it enabled the cache at this address since it last
   * started, false when it didn't, null when there's no log to read. */
  steamUsing: boolean | null
  /** Null when it can't be told. */
  steamRunning: boolean | null
  /** When Steam last sent a request, in ms since the epoch. */
  lastRequestAt: number | null
  speedBytesPerSec: number
  /** Everything carried since the boost started. */
  sessionBytes: number
  requests: { active: number; waiting: number; done: number; failed: number }
  hint: Hint
}

export interface UpdateInfo {
  version: string
  url: string
}

export interface AppState {
  version: string
  platform: string
  settings: AppSettings
  boost: BoostStatus
  networks: NetworkView[]
  update: UpdateInfo | null
  /** Whether "start with the computer" can be offered here (not on Linux). */
  canStartAtLogin: boolean
}

export interface NetworkPatch {
  enabled?: boolean
  /** Null removes the cap. */
  dailyCapBytes?: number | null
}

export type SettingsPatch = Partial<Omit<AppSettings, 'networks'>>

/** - restarted: Steam exited and was started again.
 * - started: Steam wasn't running; it was started.
 * - timeout: Steam didn't exit in time; exit it by hand.
 * - failed: Steam couldn't be reached (not installed?). */
export type RestartResult = 'restarted' | 'started' | 'timeout' | 'failed'

/** What the window can do: preload/index.ts hands it over as window.steamBoost. */
export interface SteamBoostApi {
  getState(): Promise<AppState>
  /** Called with every new state. Returns a function that stops it. */
  onState(listener: (state: AppState) => void): () => void
  updateSettings(patch: SettingsPatch): Promise<void>
  setNetwork(id: string, patch: NetworkPatch): Promise<void>
  /** Starts the boost again after it couldn't (port 80 was taken, say). */
  retry(): Promise<void>
  /** Points Steam here: one hosts-file line, behind the OS's administrator prompt. Rejects with a
   * message to show when it couldn't. */
  setUp(): Promise<void>
  /** Takes the hosts-file line out again. */
  tearDown(): Promise<void>
  /** Exits Steam and starts it again, so it looks for the cache. */
  restartSteam(): Promise<RestartResult>
  /** Puts a report on the clipboard: versions, settings, status, logs. */
  copyDiagnostics(): Promise<void>
  openLogs(): Promise<void>
  /** Opens one of the project's links in the browser. */
  openUrl(url: string): Promise<void>
}
