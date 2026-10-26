import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  Agent,
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import type { NetworkInterfaceInfo } from '../src/shared/network'
import { STEAM_USER_AGENT } from '../src/main/steam/steamHosts'

// A stand-in for Steam's side of things: a content server, reachable over "networks" that are
// loopback addresses (127.0.0.2, 127.0.0.3, …) the server tells apart by where a connection comes
// from and holds each to its own speed, as two internet connections would be; and a client that
// asks for chunks the way Steam does through a LAN cache.

export const MB = 1024 * 1024
export const CDN_HOST = 'cache1-test.steamcontent.com'

export function loopbackNetwork(id: string, address: string): NetworkInterfaceInfo {
  return {
    id,
    device: 'lo',
    displayName: id,
    addresses: [{ address, family: 4 }],
    kind: 'ethernet'
  }
}

export interface Link {
  bytesPerSec: number
  latencyMs?: number
  /** Bytes a second one connection manages at most. */
  perConnectionBytesPerSec?: number
  /** ok: serves. reset: drops connections. stall: sends half an answer, then nothing.
   * error: answers 503. */
  mode?: 'ok' | 'reset' | 'stall' | 'error'
}

/** Bytes go out at `rate`, in the order they were asked for: one internet connection. */
class Pipe {
  private nextFree = 0
  constructor(public rate: number) {}

  /** ms to wait before sending `bytes`. */
  reserve(bytes: number): number {
    const now = performance.now()
    const start = Math.max(now, this.nextFree)
    this.nextFree = start + (bytes / this.rate) * 1000
    return this.nextFree - now
  }
}

const SLICE = 64 * 1024

export interface MockCdn {
  port: number
  tlsPort: number | null
  chunks: Map<string, Buffer>
  /** Chunk ids, for clients to ask for. */
  ids: string[]
  /** Body bytes served, by the address the connection came from. */
  servedBy: Map<string, number>
  hostsSeen: Set<string>
  links: Map<string, Link>
  close(): Promise<void>
}

export async function startMockCdn({
  links,
  chunkCount = 48,
  chunkBytes = MB,
  extraChunks = [],
  tls,
  listen = { host: '127.0.0.1', port: 0 }
}: {
  links: Record<string, Link>
  chunkCount?: number
  chunkBytes?: number
  /** Chunks of other sizes. */
  extraChunks?: number[]
  tls?: { key: string; cert: string }
  /** Where it listens: anywhere free on loopback, unless a test needs a fixed place. */
  listen?: { host: string; port: number }
}): Promise<MockCdn> {
  const chunks = new Map<string, Buffer>()
  const ids: string[] = []
  for (let i = 0; i < chunkCount + extraChunks.length; i++) {
    const body = randomBytes(i < chunkCount ? chunkBytes : extraChunks[i - chunkCount])
    const id = createHash('sha1').update(body).digest('hex')
    chunks.set(id, body)
    if (i < chunkCount) ids.push(id)
  }
  const linkMap = new Map(Object.entries(links))
  const pipes = new Map<string, Pipe>()
  const servedBy = new Map<string, number>()
  const hostsSeen = new Set<string>()

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    const link = linkMap.get(from) ?? { bytesPerSec: 1000 * MB }
    hostsSeen.add(req.headers.host ?? '')
    if (link.mode === 'reset') {
      req.socket.destroy()
      return
    }
    await sleep(link.latencyMs ?? 5)
    if (link.mode === 'error') {
      res.writeHead(503, { 'content-type': 'text/plain', 'content-length': 4 })
      res.end('busy')
      return
    }
    const match = /^\/depot\/\d+\/chunk\/([0-9a-f]{40})$/.exec(req.url ?? '')
    const chunk = match ? chunks.get(match[1]) : undefined
    if (!chunk) {
      res.writeHead(404, { 'content-length': 0 })
      res.end()
      return
    }
    let body = chunk
    let status = 200
    const headers: Record<string, string | number> = {
      'content-type': 'application/x-steam-chunk',
      'accept-ranges': 'bytes'
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
    if (range) {
      const start = Number(range[1])
      const end = Math.min(Number(range[2]), chunk.length - 1)
      body = chunk.subarray(start, end + 1)
      status = 206
      headers['content-range'] = `bytes ${start}-${end}/${chunk.length}`
    }
    headers['content-length'] = body.length
    res.writeHead(status, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    let pipe = pipes.get(from)
    if (!pipe) pipes.set(from, (pipe = new Pipe(link.bytesPerSec)))
    pipe.rate = link.bytesPerSec
    const own = new Pipe(link.perConnectionBytesPerSec ?? Infinity)
    for (let offset = 0; offset < body.length; offset += SLICE) {
      if (res.destroyed) return
      const current = linkMap.get(from) ?? link
      if (current.mode === 'reset') {
        req.socket.destroy()
        return
      }
      if (current.mode === 'stall' && offset >= body.length / 2) {
        // Says nothing more, and doesn't hang up either.
        await new Promise<void>((resolve) => res.once('close', () => resolve()))
        return
      }
      const slice = body.subarray(offset, offset + SLICE)
      const wait = Math.max(pipe.reserve(slice.length), own.reserve(slice.length))
      if (wait > 1) await sleep(wait)
      servedBy.set(from, (servedBy.get(from) ?? 0) + slice.length)
      if (!res.write(slice)) await once(res, 'drain').catch(() => {})
    }
    res.end()
  }

  const server = createServer((req, res) => void handler(req, res).catch(() => res.destroy()))
  server.keepAliveTimeout = 30_000
  server.listen(listen.port, listen.host)
  await once(server, 'listening')
  let tlsServer: Server | null = null
  if (tls) {
    tlsServer = createHttpsServer(
      tls,
      (req, res) => void handler(req, res).catch(() => res.destroy())
    )
    tlsServer.listen(0, '127.0.0.1')
    await once(tlsServer, 'listening')
  }
  return {
    port: (server.address() as AddressInfo).port,
    tlsPort: tlsServer ? (tlsServer.address() as AddressInfo).port : null,
    chunks,
    ids,
    servedBy,
    hostsSeen,
    links: linkMap,
    close: async () => {
      for (const s of [server, tlsServer]) {
        if (!s) continue
        s.closeAllConnections()
        await new Promise<void>((resolve) => s.close(() => resolve()))
      }
    }
  }
}

export interface ClientResult {
  bytes: number
  requests: number
  /** Requests that failed outright (a connection error, a status that isn't 200). */
  errors: number
  /** Answers whose bytes didn't match the chunk's SHA-1. */
  corrupt: number
  statuses: Map<number, number>
  bytesPerSec: number
}

/** One request, as Steam sends it to a LAN cache: to the cache, naming the content server. */
export function steamGet(
  port: number,
  path: string,
  {
    agent,
    host = CDN_HOST,
    headers = {},
    signal
  }: { agent?: Agent; host?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<{ status: number; body: Buffer; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        agent,
        signal,
        headers: {
          Host: host,
          'User-Agent': STEAM_USER_AGENT,
          Accept: 'text/html,*/*;q=0.9',
          'Accept-Encoding': 'gzip,identity,*;q=0',
          ...headers
        }
      },
      (res) => {
        const parts: Buffer[] = []
        res.on('data', (part: Buffer) => parts.push(part))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts), headers: res.headers })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** Steam downloading through the cache at `port`: `connections` at once, each asking for the next
 * chunk as one arrives, until `seconds` have passed. Every answer is checked against its SHA-1. */
export async function runSteamClient({
  port,
  ids,
  seconds,
  connections = 32,
  depot = 731
}: {
  port: number
  ids: string[]
  seconds: number
  connections?: number
  depot?: number
}): Promise<ClientResult> {
  const agent = new Agent({ keepAlive: true, maxSockets: connections })
  const result: ClientResult = {
    bytes: 0,
    requests: 0,
    errors: 0,
    corrupt: 0,
    statuses: new Map(),
    bytesPerSec: 0
  }
  const startedAt = performance.now()
  const deadline = startedAt + seconds * 1000
  let next = 0
  const worker = async (): Promise<void> => {
    while (performance.now() < deadline) {
      const id = ids[next++ % ids.length]
      try {
        const { status, body } = await steamGet(port, `/depot/${depot}/chunk/${id}`, { agent })
        result.requests++
        result.statuses.set(status, (result.statuses.get(status) ?? 0) + 1)
        if (status !== 200) {
          result.errors++
          continue
        }
        if (createHash('sha1').update(body).digest('hex') !== id) result.corrupt++
        result.bytes += body.length
      } catch {
        result.errors++
        await sleep(50)
      }
    }
  }
  await Promise.all(Array.from({ length: connections }, worker))
  agent.destroy()
  result.bytesPerSec = result.bytes / ((performance.now() - startedAt) / 1000)
  return result
}
