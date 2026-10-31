import { lookup } from 'node:dns/promises'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AppSettings,
  BoostState,
  BoostStatus,
  GameDownload,
  Hint,
  HostsEntry,
  NetworkRole,
  NetworkSettings,
  NetworkView
} from '../shared/boost'
import type { NetworkInterfaceInfo } from '../shared/network'
import { listenAddress, LOOPBACK } from './listenAddress'
import { friendlyNames } from './network/names'
import { findCacheSightings, findSteamDir, readContentLogTail } from './steam/contentLog'
import {
  currentDownload,
  findAppManifest,
  steamLibraries,
  type LoggedDownload
} from './steam/games'
import { defaultRouteInterfaces } from './steam/defaultRoutes'
import { editHostsElevated } from './steam/elevatedHosts'
import { otherEntries, readEntry, readHostsFile, withEntry, withoutEntry } from './steam/hostsFile'
import { describePortOwner, findPortOwner, type PortOwner } from './steam/portOwner'
import { ListenError, SteamBoost, type SteamBoostOptions } from './steam/steamBoost'
import { TRIGGER_HOST } from './steam/steamHosts'
import { isSteamRunning } from './steamProcess'
import type { UsageBook } from './usage'

// The engine (steam/steamBoost.ts), run the way the settings say: started, stopped, or moved to a
// new address as they change, and fed the networks that are switched on, have a way to the
// internet and are under their daily cap. And watched for whether Steam uses it: the hosts file,
// what Steam's cache name resolves to, Steam's own log, and whether Steam is running at all.

const TICK_MS = 1000
/** The hosts file, DNS, Steam's log and process: cheap, but no need to look every second. */
const CHECK_EVERY_TICKS = 5
/** Which networks have a way to the internet: a program to run, so less often (a network that
 * comes or goes is looked at straight away, see refreshNetworks). */
const ROUTES_EVERY_TICKS = 30
/** After it couldn't start (port 80 taken, say), it tries again this often by itself. */
const RETRY_EVERY_TICKS = 30
/** How long the program found holding the port is taken as still holding it. */
const PORT_OWNER_TTL_MS = 5 * 60_000
/** Once Steam has started with the hosts line in place, how long it gets to say in its log that it
 * took the cache before the LAN address is suggested. */
const HINT_AFTER_MS = 45_000

export interface BoostControllerDeps {
  settings: () => AppSettings
  usage: UsageBook
  /** The OS's networks now (NetworkMonitor.current); null until the first look. */
  networks: () => NetworkInterfaceInfo[] | null
  /** Something the window shows changed: `current` has it. */
  onChange: () => void
  log: (line: string) => void
  /** Seams, each with the real thing as its default. Ids of networks with a default route; null:
   * can't tell, and every network counts. */
  defaultRoutes?: (networks: NetworkInterfaceInfo[] | null) => Promise<Set<string> | null>
  steamRunning?: () => Promise<boolean | null>
  steamDir?: () => Promise<string | null>
  readHosts?: () => Promise<string>
  /** Points the hosts file's block at an address, or takes it out (null). */
  editHosts?: (address: string | null) => Promise<void>
  resolveTrigger?: () => Promise<string | null>
  /** Which program has a port that's taken. */
  portOwner?: (port: number) => Promise<PortOwner | null>
  /** Handed to the engine as they are: ports and test seams. */
  engine?: Partial<SteamBoostOptions>
}

interface Checks {
  hostsEntry: HostsEntry
  resolvesTo: string | null
  steamUsing: boolean | null
  steamRunning: boolean | null
}

export interface ControllerView {
  boost: BoostStatus
  networks: NetworkView[]
}

/** A game being downloaded, as followed from Steam's log and the game's manifest. */
interface TrackedGame {
  appId: number
  /** From its manifest; null until that's been read. */
  name: string | null
  /** From the "update started" line: what it had, and had to fetch, then. */
  startedBytes: number
  loggedTotal: number
  /** From its manifest, as last read. */
  manifestDownloaded: number
  manifestTotal: number
  /** What the boost has carried since it was first seen downloading. */
  carried: number
  savedSeconds: number
}

/** Rows stay put as networks are switched off or capped: only one without a way out goes last. */
const ROLE_ORDER: Record<NetworkRole, number> = { active: 0, capped: 0, off: 0, 'no-route': 1 }

const ROUTINE_ENGINE_LINE = / (aborted|connection closed mid-answer)$/

export class BoostController {
  private boost: SteamBoost | null = null
  private running: { address: string; https: boolean } | null = null
  private state: BoostState = 'off'
  private error: string | undefined
  private checks: Checks = {
    hostsEntry: 'unknown',
    resolvesTo: null,
    steamUsing: null,
    steamRunning: null
  }
  private routed: Set<string> | null = null
  private portOwner: { port: number; at: number; text: string | null } | null = null
  private steamLog: {
    dir: string | null
    mtimeMs: number
    using: boolean | null
    download: LoggedDownload | null
  } | null = null
  /** The game Steam's log says is downloading, and the folders its manifest may be in. */
  private game: TrackedGame | null = null
  private libraries: string[] | null = null
  /** When Steam was last seen to start (or was restarted from here). */
  private steamStartedAt: number | null = null
  private timer: NodeJS.Timeout | null = null
  private ticks = 0
  private lastJson = ''
  /** Everything carried since the engine last started, by every network it has used. */
  private sessionBytes = 0
  private applying: Promise<void> = Promise.resolve()
  /** What the window shows, as of the last change. */
  current: ControllerView

  constructor(private readonly deps: BoostControllerDeps) {
    this.current = this.view()
  }

  async start(): Promise<void> {
    await this.refreshRoutes()
    await this.apply()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  /** On quit. The hosts line stays: with nothing listening, Steam uses its own servers. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.applying.catch(() => undefined)
    await this.stopEngine()
  }

  /** Brings the engine in line with the settings, one change at a time. `force` starts it again
   * even when nothing changed (after it couldn't start). */
  apply(force = false): Promise<void> {
    this.applying = this.applying
      .catch(() => undefined)
      .then(() => this.applyNow(force))
      .catch((error: unknown) => this.deps.log(`couldn't apply the settings: ${String(error)}`))
    return this.applying
  }

  /** The networks changed (or a network's settings did): look again now, not within the second. */
  async refreshNetworks(): Promise<void> {
    await this.refreshRoutes()
    this.boost?.refreshNetworks()
    // The LAN address can move with the networks.
    await this.apply()
  }

  /** Points Steam here: our line in the hosts file, behind the OS's administrator prompt. */
  async setUp(): Promise<void> {
    const address = this.running?.address
    if (!address) {
      throw new Error("Steam Boost isn't running yet, so there's nothing to point Steam at.")
    }
    const text = await this.readHosts()
    if (withEntry(text, address) !== text) await this.editHosts(address)
    this.deps.log(`hosts file: ${TRIGGER_HOST} -> ${address}`)
    await this.runChecks()
    this.emit(true)
  }

  /** Takes our line out of the hosts file again. */
  async tearDown(): Promise<void> {
    const text = await this.readHosts()
    if (withoutEntry(text) !== text) await this.editHosts(null)
    this.deps.log('hosts file: line removed')
    await this.runChecks()
    this.emit(true)
  }

  /** Steam was just restarted from here: its log should show it taking the cache soon. */
  noteSteamRestart(now = Date.now()): void {
    this.steamStartedAt = now
  }

  /** Where the engine listens now ("127.0.0.1:80"), if it's running. */
  listening(): { http: string | null; tls: string | null } | null {
    return this.boost?.listening() ?? null
  }

  /** Looks at everything again now and tells the window. */
  async refresh(): Promise<void> {
    await this.runChecks()
    this.emit(true)
  }

  private async applyNow(force: boolean): Promise<void> {
    const settings = this.deps.settings()
    if (!settings.enabled) {
      await this.stopEngine()
      this.state = 'off'
      this.error = undefined
    } else {
      const address = this.desiredAddress()
      const https = settings.httpsPassthrough
      if (!address) {
        await this.stopEngine()
        this.state = 'error'
        this.error =
          'No LAN address to listen on. Connect to a network, or switch "Listen on" back to this PC.'
      } else if (
        force ||
        !this.boost ||
        this.running?.address !== address ||
        this.running.https !== https
      ) {
        await this.stopEngine()
        await this.startEngine(address, https)
      }
    }
    await this.runChecks()
    this.emit(true)
  }

  private desiredAddress(): string | null {
    return listenAddress(this.deps.settings().addressMode, this.deps.networks() ?? [], this.routed)
  }

  private async startEngine(address: string, https: boolean): Promise<void> {
    this.state = 'starting'
    this.error = undefined
    this.emit(true)
    const boost = new SteamBoost({
      address,
      tlsPort: https ? 443 : null,
      networks: () => this.activeNetworks(),
      take: (networkId, bytes) => this.take(networkId, bytes),
      onLog: (line) => {
        // A race that was won elsewhere, or a network let go of, cancels requests: routine.
        if (!ROUTINE_ENGINE_LINE.test(line)) this.deps.log(`engine: ${line}`)
      },
      ...this.deps.engine
    })
    try {
      await boost.start()
      this.boost = boost
      this.sessionBytes = 0
      this.running = { address, https }
      this.state = 'on'
      const { http, tls } = boost.listening()
      this.deps.log(`listening on ${http}${tls ? ` and ${tls}` : ''}`)
    } catch (error) {
      await boost.stop().catch(() => undefined)
      this.state = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      if (error instanceof ListenError && error.code === 'EADDRINUSE') {
        this.error = (await this.portTaken(error.port)) ?? this.error
      }
      this.deps.log(`couldn't start: ${this.error}`)
    }
  }

  /** Which program has `port`, in the window's words; looked up again only every few minutes
   * while it keeps the port, since it takes a PowerShell call on Windows. */
  private async portTaken(port: number, now = Date.now()): Promise<string | null> {
    const known = this.portOwner
    if (known?.port === port && now - known.at < PORT_OWNER_TTL_MS) return known.text
    const owner = await (this.deps.portOwner ?? findPortOwner)(port).catch(() => null)
    if (owner) this.deps.log(`port ${port} is held by ${JSON.stringify(owner)}`)
    const text = owner ? describePortOwner(owner, port) : null
    this.portOwner = { port, at: now, text }
    return text
  }

  private async stopEngine(): Promise<void> {
    const boost = this.boost
    this.boost = null
    this.running = null
    await boost?.stop()
  }

  private role(iface: NetworkInterfaceInfo): NetworkRole {
    const own = this.deps.settings().networks[iface.id]
    if (!enabledFor(iface, own)) return 'off'
    if (this.routed && !this.routed.has(iface.id)) return 'no-route'
    const cap = own?.dailyCapBytes
    if (cap !== undefined && this.deps.usage.usedToday(iface.id) >= cap) return 'capped'
    return 'active'
  }

  /** For the engine, which asks every second. */
  private activeNetworks(): NetworkInterfaceInfo[] {
    return (this.deps.networks() ?? []).filter(
      (iface) => iface.kind !== 'bridge' && this.role(iface) === 'active'
    )
  }

  /** Every byte that arrives over a network is counted against its day. */
  private take(networkId: string, bytes: number): number {
    this.sessionBytes += bytes
    if (this.game) this.game.carried += bytes
    const total = this.deps.usage.add(networkId, bytes)
    const cap = this.deps.settings().networks[networkId]?.dailyCapBytes
    if (cap !== undefined && total >= cap && total - bytes < cap) {
      this.deps.log(`${networkId} has used its daily cap`)
      // Outside the data handler that counted it: what it was fetching moves to the others.
      setImmediate(() => {
        this.boost?.refreshNetworks()
        this.emit(true)
      })
    }
    return 0
  }

  /** A second's worth of time saved: what the other connections carried, at the fastest one's
   * speed, is how much longer the download would have taken on that one alone. */
  private countSaved(now: number): void {
    const speeds = (this.boost?.stats(now).networks ?? [])
      .map((network) => network.speedBytesPerSec)
      .filter((speed) => speed > 0)
    if (speeds.length < 2) return
    const total = speeds.reduce((sum, speed) => sum + speed, 0)
    const seconds = (total / Math.max(...speeds) - 1) * (TICK_MS / 1000)
    this.deps.usage.addSaved(seconds)
    if (this.game) this.game.savedSeconds += seconds
  }

  private tick(): void {
    this.ticks++
    this.countSaved(Date.now())
    if (this.ticks % ROUTES_EVERY_TICKS === 0) void this.refreshRoutes()
    if (this.ticks % CHECK_EVERY_TICKS === 0) void this.runChecks().then(() => this.emit(false))
    else this.emit(false)
    if (
      this.state === 'error' &&
      this.deps.settings().enabled &&
      this.ticks % RETRY_EVERY_TICKS === 0
    ) {
      void this.apply(true)
    }
  }

  private async refreshRoutes(): Promise<void> {
    try {
      this.routed = await (this.deps.defaultRoutes ?? defaultRouteInterfaces)(this.deps.networks())
    } catch {
      this.routed = null
    }
  }

  private readHosts(): Promise<string> {
    return (this.deps.readHosts ?? (() => readHostsFile()))()
  }

  private editHosts(address: string | null): Promise<void> {
    return (this.deps.editHosts ?? ((to: string | null) => editHostsElevated(to)))(address)
  }

  private async runChecks(): Promise<void> {
    const address = this.running?.address ?? this.desiredAddress()
    let hostsEntry: HostsEntry = 'unknown'
    // With no address yet (a LAN address, before the first look at the networks) there's nothing
    // to hold the file against: unknown.
    if (address !== null) {
      try {
        const text = await this.readHosts()
        // The OS takes the first line for a name, and ours goes in last.
        const others = otherEntries(text)
        hostsEntry =
          others.length > 0 && others[0] !== address
            ? 'elsewhere'
            : readEntry(text) === address || others[0] === address
              ? 'set'
              : 'missing'
      } catch {
        // Unreadable: unknown.
      }
    }
    const [resolvesTo, steamUsing, steamRunning] = await Promise.all([
      (this.deps.resolveTrigger ?? resolveTrigger)().catch(() => null),
      address ? this.steamUsing(address) : Promise.resolve(null),
      (this.deps.steamRunning ?? isSteamRunning)().catch(() => null)
    ])
    if (this.checks.steamRunning === false && steamRunning === true)
      this.steamStartedAt = Date.now()
    this.checks = { hostsEntry, resolvesTo, steamUsing, steamRunning }
    await this.refreshGame()
  }

  /** Follows the game Steam's log says is downloading: named, and its progress read, from its
   * manifest, which is small and read again on every check. */
  private async refreshGame(): Promise<void> {
    const dir = this.steamLog?.dir
    const logged = this.steamLog?.download ?? null
    if (!dir || !logged) {
      this.game = null
      return
    }
    const game = this.game
    if (game?.appId !== logged.appId) {
      this.game = {
        appId: logged.appId,
        name: null,
        startedBytes: logged.startedBytes ?? 0,
        loggedTotal: logged.totalBytes ?? 0,
        manifestDownloaded: 0,
        manifestTotal: 0,
        carried: 0,
        savedSeconds: 0
      }
      // A game can be installed into a library added since the last look.
      this.libraries = await steamLibraries(dir)
    } else if (
      logged.totalBytes !== null &&
      (logged.totalBytes !== game.loggedTotal || logged.startedBytes !== game.startedBytes)
    ) {
      // Paused and started again: counted afresh from what Steam says it had, time saved kept.
      game.startedBytes = logged.startedBytes ?? 0
      game.loggedTotal = logged.totalBytes
      game.carried = 0
    }
    const found = await findAppManifest(this.libraries ?? [dir], logged.appId)
    const tracked = this.game
    if (found && tracked?.appId === logged.appId) {
      tracked.name = found.manifest.name
      tracked.manifestDownloaded = found.manifest.bytesDownloaded
      tracked.manifestTotal = found.manifest.bytesToDownload
    }
  }

  private gameView(): GameDownload | null {
    const game = this.game
    if (!game?.name) return null
    const totalBytes = game.manifestTotal || game.loggedTotal
    const downloaded = Math.max(game.manifestDownloaded, game.startedBytes + game.carried)
    return {
      appId: game.appId,
      name: game.name,
      downloadedBytes: totalBytes > 0 ? Math.min(downloaded, totalBytes) : downloaded,
      totalBytes,
      savedSeconds: Math.round(game.savedSeconds)
    }
  }

  /** What Steam's log says, read again only when the log has changed. */
  private async steamUsing(address: string): Promise<boolean | null> {
    this.steamLog ??= {
      dir: await (this.deps.steamDir ?? findSteamDir)().catch(() => null),
      mtimeMs: -1,
      using: null,
      download: null
    }
    const { dir } = this.steamLog
    if (!dir) return null
    try {
      const { mtimeMs } = await stat(join(dir, 'logs', 'content_log.txt'))
      if (mtimeMs !== this.steamLog.mtimeMs) {
        const text = await readContentLogTail(dir)
        const sightings = text ? findCacheSightings(text) : []
        this.steamLog.mtimeMs = mtimeMs
        this.steamLog.using =
          text === null ? null : sightings[sightings.length - 1]?.address === address
        this.steamLog.download = text ? currentDownload(text) : null
      }
      return this.steamLog.using
    } catch {
      return null
    }
  }

  private hint(lastRequestAt: number | null, now: number): Hint {
    const { hostsEntry, steamUsing, steamRunning } = this.checks
    const waitedLongEnough =
      this.steamStartedAt !== null && now - this.steamStartedAt >= HINT_AFTER_MS
    return this.running?.address === LOOPBACK &&
      hostsEntry === 'set' &&
      steamUsing === false &&
      steamRunning === true &&
      lastRequestAt === null &&
      waitedLongEnough
      ? 'try-lan'
      : null
  }

  private view(now = Date.now()): ControllerView {
    const stats = this.boost?.stats(now)
    const perNetwork = new Map((stats?.networks ?? []).map((network) => [network.id, network]))
    const settings = this.deps.settings()
    const lastRequestAt = stats?.lastRequestAt ?? null
    const shown = (this.deps.networks() ?? []).filter((iface) => iface.kind !== 'bridge')
    const names = friendlyNames(shown)
    const networks = shown
      .map((iface): NetworkView => {
        const own = settings.networks[iface.id] ?? {}
        const live = perNetwork.get(iface.id)
        return {
          id: iface.id,
          label: own.name ?? names.get(iface.id) ?? iface.displayName,
          adapter: iface.displayName,
          customName: own.name ?? null,
          kind: iface.kind,
          virtual: iface.virtual === true,
          address:
            iface.addresses.find((entry) => entry.family === 4)?.address ??
            iface.addresses[0]?.address ??
            null,
          role: this.role(iface),
          enabled: enabledFor(iface, own),
          dailyCapBytes: own.dailyCapBytes ?? null,
          usedTodayBytes: this.deps.usage.usedToday(iface.id),
          speedBytesPerSec: live?.speedBytesPerSec ?? 0,
          inflight: live?.inflight ?? 0,
          resting: live?.resting ?? false
        }
      })
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.label.localeCompare(b.label))
    return {
      boost: {
        state: this.state,
        error: this.error,
        address: this.running?.address ?? this.desiredAddress(),
        httpsPassthrough: Boolean(this.boost?.listening().tls),
        ...this.checks,
        lastRequestAt,
        speedBytesPerSec: stats?.speedBytesPerSec ?? 0,
        sessionBytes: this.boost ? this.sessionBytes : 0,
        requests: {
          active: stats?.requests.active ?? 0,
          waiting: stats?.requests.waiting ?? 0,
          done: stats?.requests.done ?? 0,
          failed: stats?.requests.failed ?? 0
        },
        hint: this.hint(lastRequestAt, now),
        download: this.gameView(),
        savedSecondsTotal: Math.round(this.deps.usage.savedSeconds)
      },
      networks
    }
  }

  /** Takes a fresh look and tells the window if anything changed (or `always`). */
  private emit(always: boolean): void {
    const view = this.view()
    const json = JSON.stringify(view)
    if (!always && json === this.lastJson) return
    this.lastJson = json
    this.current = view
    this.deps.onChange()
  }
}

/** Whether a network is switched on: as it was set here, else on, but off for a virtual one. */
function enabledFor(iface: NetworkInterfaceInfo, own: NetworkSettings | undefined): boolean {
  return own?.enabled ?? !iface.virtual
}

async function resolveTrigger(): Promise<string | null> {
  try {
    return (await lookup(TRIGGER_HOST, { family: 4 })).address
  } catch {
    return null
  }
}
