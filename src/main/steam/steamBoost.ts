import {
  createServer,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse
} from 'node:http'
import {
  createServer as createTcpServer,
  isIP,
  type Server as TcpServer,
  type Socket
} from 'node:net'
import { networkInterfaces } from 'node:os'
import type { NetworkInterfaceInfo } from '../../shared/network'
import type { SteamBoostNetworkStatus } from '../../shared/boost'
import { Meter } from './meter'
import { deviceBindingSupported } from '../network/deviceBinding'
import { connectOnInterface, StreamConnection, type RemoteAddress } from '../network/routes'
import {
  DEFAULT_POLICY,
  Dispatcher,
  type AttemptOutcome,
  type DispatcherPolicy,
  type StartAction
} from './dispatcher'
import { isSteamHost, judgeRequest, rangeLength, type Target } from './steamHosts'
import { readServerName } from './tlsSni'

// Steam Boost's engine: Steam's own downloads, over every network. Nothing can fetch for Steam —
// Steam fetches its games itself, over HTTPS, from content servers it picks — but Steam will hand its
// requests to a LAN cache when it finds one (see steamHosts.ts). This is one: Steam sends it each
// request for a chunk of a game (about a megabyte, named by its SHA-1), and it fetches the chunk
// from the content server the request names, over whichever network the dispatcher picks, and
// hands it back.
//
// - Answers are held whole before Steam gets them (up to bufferLimitBytes; chunks are far
//   smaller), so one that fails or stalls halfway is fetched again over another network without
//   Steam seeing anything, and a slow one can be raced. Bigger ones are passed on as they arrive.
// - Nothing is changed or decrypted on the way: chunks are encrypted with the depot's key and
//   Steam checks each against its checksum, so a bad one can only be rejected, never installed.
// - Steam falls back to its content servers by itself when the cache can't be reached or keeps
//   failing, so a boost that stops, or was never started, costs a Steam download nothing.
// - A Steam that talks HTTPS to its cache (seen on Linux and the Steam Deck) is passed through
//   on port 443, each connection over one network, as lancache does: it can't be split per
//   request, but its connections still spread over the networks.

/** Marks a request this boost forwarded, so one that comes back (a DNS loop) is refused. */
export const LOOP_HEADER = 'x-steam-boost'

/** What lancache answers its heartbeat with; prefill tools look for it (lancache-prefill-common). */
const HEARTBEAT_HEADER = 'X-LanCache-Processed-By'

/** Its own status, as JSON (SteamBoostStats), for this computer only. */
export const STATUS_PATH = '/steam-boost/status'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

const TICK_MS = 250
const REFRESH_EVERY_TICKS = 4
const LOCAL_ADDRESSES_MS = 5000
const HELLO_TIMEOUT_MS = 10_000
/** How much of a server's error page is kept, to pass on if no network does better. */
const ERROR_BODY_BYTES = 64 * 1024

export interface SteamBoostOptions {
  /** Where Steam reaches it: what the hosts file points lancache.steamcontent.com at. */
  address: string
  /** Steam only ever uses 80; others are for tests. */
  httpPort?: number
  /** For a Steam that talks HTTPS to its cache; null: not listened on. */
  tlsPort?: number | null
  /** The networks to spread Steam's requests over, as they are now. Asked again every second. */
  networks: () => NetworkInterfaceInfo[]
  /** Told of every byte received over a network; answers how many ms to stop reading for (the
   * app counts each network's daily usage here, see main/usage.ts). */
  take?: (networkId: string, bytes: number) => number
  /** Takes requests from other computers too, as a LAN cache for them. Off: this computer only. */
  allowLan?: boolean
  /** Forwards to any host, not only Steam's content servers. */
  anyHost?: boolean
  extraHosts?: readonly string[]
  policy?: Partial<DispatcherPolicy>
  /** The largest answer held whole before Steam gets it. */
  bufferLimitBytes?: number
  /** A response that sends nothing for this long is given up on and fetched again. */
  stallTimeoutMs?: number
  /** How long a request may take to get its response headers, connecting included. */
  responseTimeoutMs?: number
  connectTimeoutMs?: number
  /** Test seams: where content servers listen, and how their names resolve. */
  upstreamHttpPort?: number
  upstreamTlsPort?: number
  resolveHost?: (host: string) => Promise<RemoteAddress[]>
  onLog?: (line: string) => void
}

export interface SteamBoostStats {
  /** Where it listens: "127.0.0.1:80", or null for a port it isn't listening on. */
  listening: { http: string | null; tls: string | null }
  /** When Steam last sent a request this boost forwarded (or a Steam HTTPS connection it passed
   * through); null: never. */
  lastRequestAt: number | null
  requests: { active: number; waiting: number; done: number; failed: number; rejected: number }
  speedBytesPerSec: number
  bytesTotal: number
  networks: SteamBoostNetworkStatus[]
  /** The content servers Steam asked for most recently, newest first. */
  recentHosts: string[]
}

interface Lane {
  info: NetworkInterfaceInfo
  /** Its addresses as they were when its sockets opened: a change means reconnecting. */
  key: string
  connection: StreamConnection
  tunnels: number
  tunnelBytes: number
  tunnelMeter: Meter
  tunnelSpeed: number
}

interface Run {
  attemptId: number
  networkId: string
  abort: AbortController
  upstream: ClientRequest | null
  stall: NodeJS.Timeout | null
  done: boolean
}

interface Answer {
  status: number
  headers: OutgoingHttpHeaders
  body: Buffer
}

interface Exchange {
  jobId: number
  res: ServerResponse
  method: 'GET' | 'HEAD'
  url: URL
  headers: Record<string, string>
  runs: Map<number, Run>
  /** Steam has its answer, has gone away, or has been told it failed. */
  settled: boolean
  /** The run already streaming to Steam, which no other can replace. */
  committed: number | null
  /** The last server error, passed on if nothing better comes. */
  lastError: Answer | null
}

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError')

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** The request headers to send on: Steam's own, less those for this hop only. */
export function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const named = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  )
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name) || name === LOOP_HEADER) {
      continue
    }
    out[name] = Array.isArray(value) ? value.join(', ') : value
  }
  out[LOOP_HEADER] = '1'
  return out
}

/** The response headers to pass back, less those for the hop they came over. */
export function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  )
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue
    out[name] = value
  }
  return out
}

function reply(res: ServerResponse, status: number, message = ''): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = Buffer.from(message ? `${message}\n` : '')
  res.writeHead(status, { 'content-type': 'text/plain', 'content-length': body.length })
  res.end(body)
}

function addressKey(info: NetworkInterfaceInfo): string {
  return info.addresses.map((address) => address.address).join(',')
}

export class SteamBoost {
  private readonly dispatcher: Dispatcher
  private readonly lanes = new Map<string, Lane>()
  private readonly exchanges = new Map<number, Exchange>()
  /** Which exchange each running attempt belongs to. */
  private readonly runIndex = new Map<number, Exchange>()
  private http: Server | null = null
  private tls: TcpServer | null = null
  /** Pass-through connections from Steam, closed with the boost. */
  private readonly tunnelClients = new Set<Socket>()
  private timer: NodeJS.Timeout | null = null
  private ticks = 0
  private localAddresses: { at: number; set: Set<string> } | null = null
  private lastRequestAt: number | null = null
  private done = 0
  private failed = 0
  private rejected = 0
  private recentHosts: string[] = []
  private readonly bufferLimit: number
  private readonly stallMs: number

  constructor(private readonly options: SteamBoostOptions) {
    this.dispatcher = new Dispatcher({ ...DEFAULT_POLICY, ...options.policy })
    this.bufferLimit = options.bufferLimitBytes ?? 4 * 1024 * 1024
    this.stallMs = options.stallTimeoutMs ?? 8000
  }

  /** Opens its ports. Rejects, with nothing left open, when one can't be listened on. */
  async start(): Promise<void> {
    if (this.http) return
    // Loads what Linux needs to pin a socket to its network (network/deviceBinding.ts).
    await deviceBindingSupported()
    this.refreshNetworks()

    const http = createServer((req, res) => this.onRequest(req, res))
    http.keepAliveTimeout = 60_000
    http.headersTimeout = 65_000
    http.on('clientError', (_error, socket) => socket.destroy())
    await listen(http, this.options.httpPort ?? 80, this.options.address)
    this.http = http
    // Only a Steam that talks HTTPS to its cache needs this, so a port 443 that's taken costs
    // the rest nothing.
    if (this.options.tlsPort !== null) {
      const tls = createTcpServer((socket) => this.onTlsConnection(socket))
      try {
        await listen(tls, this.options.tlsPort ?? 443, this.options.address)
        this.tls = tls
      } catch (error) {
        this.log(`HTTPS pass-through is off: ${error instanceof Error ? error.message : error}`)
      }
    }
    this.timer = setInterval(() => this.onTick(), TICK_MS)
    this.timer.unref?.()
    this.log(`listening on ${this.listening().http ?? '?'}`)
  }

  /** Closes its ports and stops everything it was fetching. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const exchange of [...this.exchanges.values()]) {
      this.abandon(exchange)
      if (!exchange.res.writableEnded) exchange.res.destroy()
    }
    for (const socket of this.tunnelClients) socket.destroy()
    this.tunnelClients.clear()
    const closing = [this.http, this.tls].map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server) return resolve()
          server.close(() => resolve())
          if ('closeAllConnections' in server) server.closeAllConnections()
        })
    )
    this.http = null
    this.tls = null
    for (const lane of this.lanes.values()) lane.connection.close()
    this.lanes.clear()
    await Promise.all(closing)
  }

  listening(): SteamBoostStats['listening'] {
    const where = (server: Server | TcpServer | null): string | null => {
      const address = server?.address()
      if (!address || typeof address === 'string') return null
      return address.family === 'IPv6'
        ? `[${address.address}]:${address.port}`
        : `${address.address}:${address.port}`
    }
    return { http: where(this.http), tls: where(this.tls) }
  }

  stats(now = Date.now()): SteamBoostStats {
    const snapshots = new Map(this.dispatcher.snapshot(now).map((network) => [network.id, network]))
    const networks: SteamBoostNetworkStatus[] = [...this.lanes.values()].map((lane) => {
      const snapshot = snapshots.get(lane.info.id)
      return {
        id: lane.info.id,
        label: lane.info.displayName,
        speedBytesPerSec: (snapshot?.speedBytesPerSec ?? 0) + lane.tunnelSpeed,
        bytesTotal: (snapshot?.bytesTotal ?? 0) + lane.tunnelBytes,
        inflight: snapshot?.inflight ?? 0,
        tunnels: lane.tunnels,
        resting: snapshot?.resting ?? false
      }
    })
    return {
      listening: this.listening(),
      lastRequestAt: this.lastRequestAt,
      requests: {
        active: this.exchanges.size,
        waiting: this.dispatcher.waiting,
        done: this.done,
        failed: this.failed,
        rejected: this.rejected
      },
      speedBytesPerSec: networks.reduce((sum, network) => sum + network.speedBytesPerSec, 0),
      bytesTotal: networks.reduce((sum, network) => sum + network.bytesTotal, 0),
      networks,
      recentHosts: [...this.recentHosts]
    }
  }

  /** Takes up the networks as they are now: new ones join, gone ones leave (what they were
   * fetching goes to the others), and one with new addresses reconnects. */
  refreshNetworks(): void {
    const list = this.options.networks()
    for (const info of list) {
      const lane = this.lanes.get(info.id)
      if (!lane) {
        this.lanes.set(info.id, this.newLane(info))
        this.log(`network ${info.displayName} (${info.id}) joined`)
      } else {
        lane.info = info
        const key = addressKey(info)
        if (key !== lane.key) {
          lane.key = key
          lane.connection.reconnect()
        }
      }
    }
    for (const [id, lane] of this.lanes) {
      if (list.some((info) => info.id === id)) continue
      this.lanes.delete(id)
      lane.connection.close()
      this.log(`network ${lane.info.displayName} (${id}) left`)
    }
    for (const attemptId of this.dispatcher.setNetworks(list.map((info) => info.id))) {
      this.stopRun(attemptId)
    }
    this.pump()
  }

  private newLane(info: NetworkInterfaceInfo): Lane {
    const id = info.id
    return {
      info,
      key: addressKey(info),
      connection: new StreamConnection(() => this.lanes.get(id)?.info, {
        timeoutMs: this.options.responseTimeoutMs ?? 15_000,
        connectTimeoutMs: this.options.connectTimeoutMs ?? 8000,
        resolveHost: this.options.resolveHost
      }),
      tunnels: 0,
      tunnelBytes: 0,
      tunnelMeter: new Meter(),
      tunnelSpeed: 0
    }
  }

  private onTick(): void {
    const now = Date.now()
    this.dispatcher.tick(now)
    for (const lane of this.lanes.values()) lane.tunnelSpeed = lane.tunnelMeter.read(now)
    if (++this.ticks % REFRESH_EVERY_TICKS === 0) this.refreshNetworks()
    else this.pump()
  }

  private log(line: string): void {
    this.options.onLog?.(line)
  }

  /** Whether a connection comes from this computer (or from anywhere, with allowLan). */
  private allowed(socket: Socket): boolean {
    if (this.options.allowLan) return true
    const address = (socket.remoteAddress ?? '').replace(/^::ffff:/i, '')
    if (address === '::1' || address.startsWith('127.')) return true
    const now = Date.now()
    if (!this.localAddresses || now - this.localAddresses.at > LOCAL_ADDRESSES_MS) {
      const set = new Set<string>()
      for (const list of Object.values(networkInterfaces())) {
        for (const entry of list ?? []) set.add(entry.address.toLowerCase())
      }
      this.localAddresses = { at: now, set }
    }
    return this.localAddresses.set.has(address.toLowerCase())
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const now = Date.now()
    if (!this.allowed(req.socket)) {
      this.rejected++
      return reply(res, 403, 'This Steam boost only serves this computer.')
    }
    const path = req.url ?? '/'
    if (path === '/lancache-heartbeat') {
      res.writeHead(204, { [HEARTBEAT_HEADER]: 'steam-boost' })
      res.end()
      return
    }
    // What it's doing, for `steam-boost-cli check` (see src/cli/cli.ts).
    if (path === STATUS_PATH) {
      const body = Buffer.from(JSON.stringify(this.stats(now)))
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length })
      res.end(body)
      return
    }
    if (req.headers[LOOP_HEADER] !== undefined) {
      this.rejected++
      return reply(res, 508, 'This request has been through Steam boost already.')
    }
    const verdict = judgeRequest(
      {
        method: req.method,
        hostHeader: req.headers.host,
        path,
        userAgent: req.headers['user-agent']
      },
      { anyHost: this.options.anyHost, extraHosts: this.options.extraHosts }
    )
    if (!verdict.forward) {
      this.rejected++
      this.log(`refused ${req.method} ${req.headers.host ?? '(no host)'}${path}: ${verdict.reason}`)
      return reply(res, verdict.status, verdict.reason)
    }
    // Only a request it forwards is Steam using the boost: a heartbeat, a status check or a
    // refused request says nothing about Steam.
    this.lastRequestAt = now
    this.noteHost(verdict.target.host)
    const method = req.method?.toUpperCase() === 'HEAD' ? 'HEAD' : 'GET'
    const exchange: Exchange = {
      jobId: this.dispatcher.submit(method === 'HEAD' ? 0 : rangeLength(req.headers.range)),
      res,
      method,
      url: this.upstreamUrl(verdict.target, path),
      headers: forwardHeaders(req.headers),
      runs: new Map(),
      settled: false,
      committed: null,
      lastError: null
    }
    this.exchanges.set(exchange.jobId, exchange)
    // Steam gave up on it (a pause, a cancel, its own timeout): so does the boost.
    res.once('close', () => {
      if (!exchange.settled) this.abandon(exchange)
    })
    this.pump()
  }

  private upstreamUrl(target: Target, path: string): URL {
    const port = target.secure
      ? (this.options.upstreamTlsPort ?? target.port)
      : (this.options.upstreamHttpPort ?? target.port)
    const host = isIP(target.host) === 6 ? `[${target.host}]` : target.host
    return new URL(`${target.secure ? 'https' : 'http'}://${host}:${port}${path}`)
  }

  private noteHost(host: string): void {
    if (this.recentHosts[0] === host) return
    this.recentHosts = [host, ...this.recentHosts.filter((seen) => seen !== host)].slice(0, 5)
  }

  /** Starts whatever the dispatcher says should start now. */
  private pump(): void {
    for (const action of this.dispatcher.schedule(Date.now())) this.begin(action)
  }

  private begin(action: StartAction): void {
    const exchange = this.exchanges.get(action.jobId)
    const lane = this.lanes.get(action.networkId)
    if (!exchange || exchange.settled || exchange.committed !== null || !lane) {
      this.dispatcher.onFinish(action.attemptId, 'cancelled', Date.now())
      return
    }
    const run: Run = {
      attemptId: action.attemptId,
      networkId: action.networkId,
      abort: new AbortController(),
      upstream: null,
      stall: null,
      done: false
    }
    exchange.runs.set(run.attemptId, run)
    this.runIndex.set(run.attemptId, exchange)
    lane.connection.request(exchange.url, exchange.headers, run.abort.signal, exchange.method).then(
      ({ req, res }) => this.onUpstream(exchange, run, req, res),
      (error: unknown) => this.endRun(exchange, run, isAbort(error) ? 'cancelled' : 'network')
    )
  }

  private onUpstream(
    exchange: Exchange,
    run: Run,
    upstreamReq: ClientRequest,
    upstream: IncomingMessage
  ): void {
    if (run.done || exchange.settled) {
      upstreamReq.destroy()
      return
    }
    run.upstream = upstreamReq
    const status = upstream.statusCode ?? 502
    const lengthHeader = upstream.headers['content-length']
    const length =
      lengthHeader !== undefined && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null
    const bodyless =
      exchange.method === 'HEAD' ||
      status === 204 ||
      status === 304 ||
      (status >= 100 && status < 200)
    const serverError = status >= 500 || status === 429
    this.dispatcher.onHeaders(run.attemptId, bodyless ? 0 : length, Date.now())

    const failed = (error?: Error): void => {
      if (error) this.log(`${run.networkId}: ${exchange.url.host} ${error.message}`)
      this.endRun(exchange, run, 'network')
    }
    upstreamReq.on('error', (error) => failed(error))
    upstream.on('error', (error) => failed(error))
    upstream.on('close', () => {
      if (!upstream.complete) failed(new Error('connection closed mid-answer'))
    })

    const chunks: Buffer[] = []
    let received = 0
    let kept = 0
    // Reading stops while Steam's connection is full, or a speed limit says to wait; the stall
    // watchdog stops with it, since neither says anything about the network.
    let holds = 0
    const arm = (): void => {
      if (run.stall) clearTimeout(run.stall)
      run.stall = setTimeout(() => failed(new Error('stalled')), this.stallMs)
    }
    const hold = (): void => {
      if (holds++ === 0) {
        if (run.stall) clearTimeout(run.stall)
        run.stall = null
        upstream.pause()
      }
    }
    const release = (): void => {
      if (--holds > 0 || run.done) return
      arm()
      upstream.resume()
    }
    const commit = (): void => {
      this.commit(exchange, run, status, responseHeaders(upstream.headers))
      for (const chunk of chunks) exchange.res.write(chunk)
      chunks.length = 0
    }
    // Too big to hold whole: Steam gets it as it comes, and it can't be fetched again or raced.
    if (!serverError && !bodyless && length !== null && length > this.bufferLimit) commit()
    arm()

    upstream.on('data', (chunk: Buffer) => {
      if (run.done) return
      arm()
      received += chunk.length
      this.dispatcher.onBytes(run.attemptId, chunk.length, Date.now())
      if (exchange.committed === run.attemptId) {
        if (!exchange.res.write(chunk)) {
          hold()
          exchange.res.once('drain', release)
        }
      } else if (serverError) {
        // Only passed on if nothing better comes: the start of it is plenty.
        if (kept < ERROR_BODY_BYTES) {
          chunks.push(chunk.subarray(0, ERROR_BODY_BYTES - kept))
          kept += Math.min(chunk.length, ERROR_BODY_BYTES - kept)
        }
      } else {
        chunks.push(chunk)
        if (received > this.bufferLimit) commit()
      }
      const wait = this.options.take?.(run.networkId, chunk.length) ?? 0
      if (wait > 0) {
        hold()
        setTimeout(release, wait)
      }
    })

    upstream.on('end', () => {
      if (run.done) return
      if (run.stall) clearTimeout(run.stall)
      run.stall = null
      if (!bodyless && !serverError && length !== null && received !== length) {
        return failed(new Error(`answer cut short: ${received} of ${length} bytes`))
      }
      if (exchange.committed === run.attemptId) {
        exchange.res.end()
        return this.endRun(exchange, run, 'ok')
      }
      const answer: Answer = {
        status,
        headers: responseHeaders(upstream.headers),
        body: Buffer.concat(chunks)
      }
      if (serverError) {
        exchange.lastError = answer
        return this.endRun(exchange, run, 'server')
      }
      this.endRun(exchange, run, 'ok', answer)
    })
  }

  /** `run`'s answer goes to Steam as it arrives: every other copy is stopped. */
  private commit(exchange: Exchange, run: Run, status: number, headers: OutgoingHttpHeaders): void {
    exchange.committed = run.attemptId
    this.dispatcher.noHedges(exchange.jobId)
    for (const otherId of [...exchange.runs.keys()]) {
      if (otherId === run.attemptId) continue
      this.dispatcher.onFinish(otherId, 'cancelled', Date.now())
      this.stopRun(otherId)
    }
    exchange.res.writeHead(status, { ...headers, [LOOP_HEADER]: run.networkId })
  }

  private endRun(exchange: Exchange, run: Run, outcome: AttemptOutcome, answer?: Answer): void {
    if (run.done) return
    run.done = true
    if (run.stall) clearTimeout(run.stall)
    run.stall = null
    if (outcome !== 'ok') run.upstream?.destroy()
    exchange.runs.delete(run.attemptId)
    this.runIndex.delete(run.attemptId)
    const now = Date.now()

    if (exchange.settled) {
      this.dispatcher.onFinish(run.attemptId, 'cancelled', now)
      return
    }
    if (exchange.committed === run.attemptId) {
      // Steam already has the start of this answer: there's nothing to fetch it again with.
      this.dispatcher.onFinish(run.attemptId, outcome === 'ok' ? 'ok' : 'network', now)
      exchange.settled = true
      this.exchanges.delete(exchange.jobId)
      if (outcome === 'ok') this.done++
      else {
        this.dispatcher.cancelJob(exchange.jobId)
        this.failed++
        exchange.res.destroy()
      }
      this.pump()
      return
    }

    const result = this.dispatcher.onFinish(run.attemptId, outcome, now)
    for (const other of result.abort) this.stopRun(other)
    if (result.settled === 'done' && answer) {
      this.settle(exchange)
      this.done++
      const headers: OutgoingHttpHeaders = { ...answer.headers, [LOOP_HEADER]: run.networkId }
      if (exchange.method === 'GET') headers['content-length'] = answer.body.length
      exchange.res.writeHead(answer.status, headers)
      exchange.res.end(exchange.method === 'GET' ? answer.body : undefined)
    } else if (result.settled === 'failed') {
      this.settle(exchange)
      this.failed++
      const error = exchange.lastError
      if (error) {
        exchange.res.writeHead(error.status, {
          ...error.headers,
          'content-length': error.body.length
        })
        exchange.res.end(exchange.method === 'GET' ? error.body : undefined)
      } else {
        reply(exchange.res, 502, 'No network could fetch this.')
      }
    }
    this.pump()
  }

  private settle(exchange: Exchange): void {
    exchange.settled = true
    this.exchanges.delete(exchange.jobId)
  }

  /** Stops an attempt the dispatcher has already let go of. */
  private stopRun(attemptId: number): void {
    const exchange = this.runIndex.get(attemptId)
    if (!exchange) return
    const run = exchange.runs.get(attemptId)
    this.runIndex.delete(attemptId)
    if (!run) return
    exchange.runs.delete(attemptId)
    run.done = true
    if (run.stall) clearTimeout(run.stall)
    run.stall = null
    run.abort.abort(abortError())
    run.upstream?.destroy()
  }

  /** Steam went away before its answer: everything fetching it stops. */
  private abandon(exchange: Exchange): void {
    exchange.settled = true
    this.exchanges.delete(exchange.jobId)
    for (const attemptId of this.dispatcher.cancelJob(exchange.jobId)) this.stopRun(attemptId)
  }

  // --- HTTPS pass-through -------------------------------------------------------------------

  private onTlsConnection(client: Socket): void {
    client.on('error', () => client.destroy())
    if (!this.allowed(client)) {
      this.rejected++
      client.destroy()
      return
    }
    this.tunnelClients.add(client)
    client.once('close', () => this.tunnelClients.delete(client))
    let hello = Buffer.alloc(0)
    const timer = setTimeout(() => client.destroy(), HELLO_TIMEOUT_MS)
    const onData = (chunk: Buffer): void => {
      hello = Buffer.concat([hello, chunk])
      const read = readServerName(hello)
      if (read.kind === 'incomplete') return
      client.off('data', onData)
      clearTimeout(timer)
      client.pause()
      const name = read.kind === 'hello' ? read.serverName : null
      if (!name || (!this.options.anyHost && !isSteamHost(name, this.options.extraHosts))) {
        this.rejected++
        this.log(`refused HTTPS to ${name ?? '(no name)'}`)
        client.destroy()
        return
      }
      this.lastRequestAt = Date.now()
      this.noteHost(name)
      void this.tunnel(client, name, hello)
    }
    client.on('data', onData)
  }

  /** The network for a new pass-through connection: the one with the fewest for its speed. */
  private tunnelLane(): Lane | null {
    const now = Date.now()
    const snapshots = new Map(this.dispatcher.snapshot(now).map((network) => [network.id, network]))
    let fastest = 0
    for (const lane of this.lanes.values()) {
      const speed = lane.tunnels > 0 ? lane.tunnelSpeed / lane.tunnels : 0
      fastest = Math.max(fastest, speed, snapshots.get(lane.info.id)?.rateBytesPerSec ?? 0)
    }
    let best: { lane: Lane; load: number } | null = null
    for (const lane of this.lanes.values()) {
      if (snapshots.get(lane.info.id)?.resting) continue
      const perTunnel = lane.tunnels > 0 ? lane.tunnelSpeed / lane.tunnels : 0
      const rate = perTunnel || snapshots.get(lane.info.id)?.rateBytesPerSec || fastest || 1
      const load = (lane.tunnels + 1) / rate
      if (!best || load < best.load) best = { lane, load }
    }
    return best?.lane ?? [...this.lanes.values()][0] ?? null
  }

  private async tunnel(client: Socket, host: string, hello: Buffer): Promise<void> {
    const lane = this.tunnelLane()
    if (!lane) {
      client.destroy()
      return
    }
    const controller = new AbortController()
    const onClose = (): void => controller.abort()
    client.once('close', onClose)
    lane.tunnels++
    let upstream: Socket
    try {
      upstream = await connectOnInterface(
        lane.info,
        host,
        this.options.upstreamTlsPort ?? 443,
        null,
        this.options.connectTimeoutMs ?? 8000,
        controller.signal,
        this.options.resolveHost
      )
    } catch (error) {
      lane.tunnels--
      client.off('close', onClose)
      if (!isAbort(error)) this.log(`${lane.info.id}: HTTPS to ${host} failed: ${String(error)}`)
      client.destroy()
      return
    }
    client.off('close', onClose)
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      lane.tunnels--
      client.destroy()
      upstream.destroy()
    }
    upstream.on('error', close)
    upstream.on('close', close)
    client.on('close', close)
    // Steam hung up while the connection was being made.
    if (client.destroyed) return close()
    upstream.write(hello)
    client.pipe(upstream)
    upstream.on('data', (chunk: Buffer) => {
      lane.tunnelBytes += chunk.length
      lane.tunnelMeter.add(chunk.length)
      if (!client.write(chunk)) {
        upstream.pause()
        client.once('drain', () => upstream.resume())
      }
      const wait = this.options.take?.(lane.info.id, chunk.length) ?? 0
      if (wait > 0) {
        upstream.pause()
        setTimeout(() => upstream.resume(), wait)
      }
    })
    upstream.on('end', () => client.end())
    client.resume()
  }
}

function listen(server: Server | TcpServer, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      reject(explainListenError(error, port, address))
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, address)
  })
}

/** Why a port couldn't be listened on, in words, with the OS's code (EADDRINUSE: another program
 * has it) and the port, so the app can find out which program that is (portOwner.ts). */
export class ListenError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly port: number,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

function explainListenError(error: NodeJS.ErrnoException, port: number, address: string): Error {
  const where = `${address}:${port}`
  if (error.code === 'EADDRINUSE') {
    return new ListenError(
      `Another program is using ${where}. Steam only looks for a cache on port ${port}, so it has to be free` +
        (process.platform === 'win32'
          ? ' (netstat -ano | findstr :' + port + ' shows which program).'
          : ' (sudo lsof -i :' + port + ' shows which program).'),
      error.code,
      port,
      { cause: error }
    )
  }
  if (error.code === 'EACCES') {
    return new Error(
      `Not allowed to listen on ${where}: ports below 1024 need administrator rights here` +
        (process.platform === 'linux'
          ? ' (or: sudo sysctl net.ipv4.ip_unprivileged_port_start=80).'
          : '.'),
      { cause: error }
    )
  }
  if (error.code === 'EADDRNOTAVAIL') {
    return new Error(`${address} isn't an address of this computer.`, { cause: error })
  }
  return error
}
