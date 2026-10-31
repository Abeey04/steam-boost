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
  /** What the window calls it: the name it was given here, else what it is ("Phone (USB
   * tethering)", main/network/names.ts). */
  label: string
  /** The OS's own name for it ("Ethernet 3"), as Windows' network settings show it. */
  adapter: string
  /** The name it was given here; null: none. */
  customName: string | null
  kind: NetworkInterfaceKind
  /** A virtual machine's, a container's or a VPN's adapter: off unless switched on, and listed
   * apart from the connections people plug in. */
  virtual: boolean
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
  /** Unset: on, or off for a virtual machine's, a container's or a VPN's adapter. */
  enabled?: boolean
  /** Bytes a day; unset: no cap. */
  dailyCapBytes?: number
  /** A name of its own ("Home fibre"); unset: what it is. */
  name?: string
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

/** The game Steam is downloading, from Steam's own files (main/steam/games.ts). */
export interface GameDownload {
  /** Steam's id for it, which its art is asked for by (SteamBoostApi.gameArt). */
  appId: number
  name: string
  /** How far along it is, as far as can be told: what Steam's manifest says, or what it had when
   * the download started plus what the boost has carried since, whichever is more. A total of 0:
   * not known. */
  downloadedBytes: number
  totalBytes: number
  /** The time the other connections have saved on it so far, against the fastest one alone. */
  savedSeconds: number
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
  /** The game Steam is downloading now; null: none, or it can't be told. */
  download: GameDownload | null
  /** All the time the boost has saved, every download on this computer counted. */
  savedSecondsTotal: number
}

export interface UpdateInfo {
  version: string
  /** The release's page, to download it from by hand. */
  url: string
  /** Where installing it from the window stands, on Windows, where the app can fetch the new
   * installer and run it itself (main/autoUpdate.ts): available to download, downloading
   * (`progress` from 0 to 1), ready to install on a restart. Null: only the page link. */
  install: 'available' | 'downloading' | 'ready' | null
  progress?: number
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
  /** Null goes back to the name it has by default. */
  name?: string | null
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
  /** "Tell us how it went": a reply for the Speed reports discussion, filled in from what the app
   * knows, on the clipboard, and the discussion opened in the browser to paste it into. */
  report(): Promise<void>
  openLogs(): Promise<void>
  /** Opens one of the project's links in the browser. */
  openUrl(url: string): Promise<void>
  /** A game's header art from Steam's library cache, as a data: URL; null when there's none. */
  gameArt(appId: number): Promise<string | null>
  /** Downloads the update (AppState.update.install 'available'), or once it's 'ready', quits
   * and installs it. */
  installUpdate(): Promise<void>
}
