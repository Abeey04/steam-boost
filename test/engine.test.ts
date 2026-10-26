import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { NetworkInterfaceInfo } from '../src/shared/network'
import { LOOP_HEADER, SteamBoost, type SteamBoostOptions } from '../src/main/steam/steamBoost'
import { STEAM_USER_AGENT } from '../src/main/steam/steamHosts'
import {
  CDN_HOST,
  MB,
  loopbackNetwork,
  runSteamClient,
  startMockCdn,
  steamGet,
  type Link,
  type MockCdn
} from './fixtures'

// Steam boost end to end, on this computer: a mock content server that holds each loopback
// address to its own speed stands in for two internet connections, and a client that downloads
// the way Steam does through a LAN cache stands in for Steam.

const fibre = loopbackNetwork('fibre', '127.0.0.2')
const phone = loopbackNetwork('phone', '127.0.0.3')
const FIBRE: Link = { bytesPerSec: 6 * MB, latencyMs: 20 }
const PHONE: Link = { bytesPerSec: 2 * MB, latencyMs: 60 }

async function startBoost(
  cdn: MockCdn,
  networks: () => NetworkInterfaceInfo[],
  options: Partial<SteamBoostOptions> = {}
): Promise<{ boost: SteamBoost; port: number; tlsPort: number | null }> {
  const boost = new SteamBoost({
    address: '127.0.0.1',
    httpPort: 0,
    tlsPort: null,
    networks,
    upstreamHttpPort: cdn.port,
    upstreamTlsPort: cdn.tlsPort ?? undefined,
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
    stallTimeoutMs: 1500,
    ...options
  })
  await boost.start()
  const { http, tls } = boost.listening()
  const portOf = (where: string | null): number | null =>
    where ? Number(where.split(':').pop()) : null
  return { boost, port: portOf(http)!, tlsPort: portOf(tls) }
}

const mbps = (bytesPerSec: number): string => `${(bytesPerSec / MB).toFixed(2)} MB/s`

test('two networks carry Steam about as fast as both together, every chunk intact', async (t) => {
  const cdn = await startMockCdn({ links: { '127.0.0.2': FIBRE, '127.0.0.3': PHONE } })
  try {
    const one = await startBoost(cdn, () => [fibre])
    const alone = await runSteamClient({ port: one.port, ids: cdn.ids, seconds: 6 })
    await one.boost.stop()

    const both = await startBoost(cdn, () => [fibre, phone])
    const together = await runSteamClient({ port: both.port, ids: cdn.ids, seconds: 8 })
    const stats = both.boost.stats()
    await both.boost.stop()

    const phoneShare = stats.networks.find((n) => n.id === 'phone')!.bytesTotal / stats.bytesTotal
    t.diagnostic(
      `fibre alone ${mbps(alone.bytesPerSec)}; fibre + phone ${mbps(together.bytesPerSec)}`
    )
    t.diagnostic(`phone carried ${(phoneShare * 100).toFixed(1)}% (its link is 25% of the total)`)
    assert.equal(alone.errors + together.errors, 0)
    assert.equal(alone.corrupt + together.corrupt, 0)
    assert.ok(alone.bytesPerSec > 0.8 * 6 * MB, mbps(alone.bytesPerSec))
    assert.ok(together.bytesPerSec > 0.8 * 8 * MB, mbps(together.bytesPerSec))
    assert.ok(together.bytesPerSec > 1.2 * alone.bytesPerSec)
    assert.ok(phoneShare > 0.15 && phoneShare < 0.35, `${phoneShare}`)
  } finally {
    await cdn.close()
  }
})

test('a network that drops mid-download costs Steam nothing', async (t) => {
  const cdn = await startMockCdn({ links: { '127.0.0.2': FIBRE, '127.0.0.3': PHONE } })
  const { boost, port } = await startBoost(cdn, () => [fibre, phone])
  try {
    const run = runSteamClient({ port, ids: cdn.ids, seconds: 7 })
    await sleep(2500)
    // The phone's connections are reset from here on, the ones mid-answer included.
    cdn.links.set('127.0.0.3', { ...PHONE, mode: 'reset' })
    const result = await run
    const phoneNow = boost.stats().networks.find((n) => n.id === 'phone')!
    t.diagnostic(
      `${mbps(result.bytesPerSec)} with the phone dropping out; phone resting: ${phoneNow.resting}`
    )
    assert.equal(result.errors, 0)
    assert.equal(result.corrupt, 0)
    assert.ok(result.bytesPerSec > 0.6 * 6 * MB, mbps(result.bytesPerSec))
  } finally {
    await boost.stop()
    await cdn.close()
  }
})

test('a network that stalls halfway through answers is worked around', async (t) => {
  const cdn = await startMockCdn({ links: { '127.0.0.2': FIBRE, '127.0.0.3': PHONE } })
  const { boost, port } = await startBoost(cdn, () => [fibre, phone])
  try {
    const run = runSteamClient({ port, ids: cdn.ids, seconds: 7 })
    await sleep(2000)
    cdn.links.set('127.0.0.3', { ...PHONE, mode: 'stall' })
    const result = await run
    t.diagnostic(`${mbps(result.bytesPerSec)} with the phone stalling`)
    assert.equal(result.errors, 0)
    assert.equal(result.corrupt, 0)
    assert.ok(result.bytesPerSec > 0.5 * 6 * MB, mbps(result.bytesPerSec))
  } finally {
    await boost.stop()
    await cdn.close()
  }
})

test('a network that leaves is let go of, and its requests finish over the others', async () => {
  const cdn = await startMockCdn({ links: { '127.0.0.2': FIBRE, '127.0.0.3': PHONE } })
  let networks = [fibre, phone]
  const { boost, port } = await startBoost(cdn, () => networks)
  try {
    const run = runSteamClient({ port, ids: cdn.ids, seconds: 6 })
    await sleep(2000)
    networks = [fibre]
    const result = await run
    assert.equal(result.errors, 0)
    assert.equal(result.corrupt, 0)
    assert.deepEqual(
      boost.stats().networks.map((n) => n.id),
      ['fibre']
    )
  } finally {
    await boost.stop()
    await cdn.close()
  }
})

test('a server error over one network is retried over another', async () => {
  const cdn = await startMockCdn({
    links: { '127.0.0.2': { ...FIBRE, mode: 'error' }, '127.0.0.3': PHONE }
  })
  const { boost, port } = await startBoost(cdn, () => [fibre, phone])
  try {
    const result = await runSteamClient({ port, ids: cdn.ids, seconds: 4, connections: 8 })
    assert.equal(result.errors, 0)
    assert.equal(result.corrupt, 0)
    assert.ok(result.requests > 0)
  } finally {
    await boost.stop()
    await cdn.close()
  }
})

test("answers that aren't errors pass straight through: a 404, a range", async () => {
  const cdn = await startMockCdn({ links: {}, chunkCount: 2 })
  const { boost, port } = await startBoost(cdn, () => [fibre, phone])
  try {
    const missing = await steamGet(port, `/depot/731/chunk/${'0'.repeat(40)}`)
    assert.equal(missing.status, 404)
    const id = cdn.ids[0]
    const ranged = await steamGet(port, `/depot/731/chunk/${id}`, {
      headers: { Range: 'bytes=1048-2095' }
    })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers['content-range'], `bytes 1048-2095/${MB}`)
    assert.ok(ranged.body.equals(cdn.chunks.get(id)!.subarray(1048, 2096)))
    assert.ok(cdn.hostsSeen.has(CDN_HOST), 'the content server is asked by its own name')
  } finally {
    await boost.stop()
    await cdn.close()
  }
})

test('an answer too big to hold whole is streamed through', async () => {
  const cdn = await startMockCdn({ links: {}, chunkCount: 1, extraChunks: [10 * MB] })
  const { boost, port } = await startBoost(cdn, () => [fibre, phone], {
    bufferLimitBytes: 4 * MB
  })
  try {
    const big = [...cdn.chunks.entries()].find(([, body]) => body.length === 10 * MB)!
    const answer = await steamGet(port, `/depot/731/chunk/${big[0]}`)
    assert.equal(answer.status, 200)
    assert.equal(createHash('sha1').update(answer.body).digest('hex'), big[0])
  } finally {
    await boost.stop()
    await cdn.close()
  }
})

test('heartbeat, loops and requests that are not for Steam', async () => {
  const cdn = await startMockCdn({ links: {}, chunkCount: 1 })
  const { boost, port } = await startBoost(cdn, () => [fibre])
  try {
    const heartbeat = await steamGet(port, '/lancache-heartbeat')
    assert.equal(heartbeat.status, 204)
    assert.equal(heartbeat.headers['x-lancache-processed-by'], 'steam-boost')
    const loop = await steamGet(port, `/depot/731/chunk/${cdn.ids[0]}`, {
      headers: { [LOOP_HEADER]: '1' }
    })
    assert.equal(loop.status, 508)
    const other = await steamGet(port, '/', {
      host: 'example.com',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    assert.equal(other.status, 403)
    assert.equal(boost.stats().requests.rejected, 2)
  } finally {
    await boost.stop()
    await cdn.close()
  }
})

test('Steam giving up on a request stops it being fetched', async () => {
  const slow: Link = { bytesPerSec: 0.25 * MB, latencyMs: 20 }
  const cdn = await startMockCdn({ links: { '127.0.0.2': slow, '127.0.0.3': slow }, chunkCount: 1 })
  const { boost, port } = await startBoost(cdn, () => [fibre, phone])
  try {
    const controller = new AbortController()
    const asked = steamGet(port, `/depot/731/chunk/${cdn.ids[0]}`, { signal: controller.signal })
    await sleep(400)
    assert.equal(boost.stats().requests.active, 1)
    controller.abort()
    await asked.catch(() => {})
    await sleep(300)
    const stats = boost.stats()
    assert.equal(stats.requests.active, 0)
    assert.equal(
      stats.networks.reduce((sum, n) => sum + n.inflight, 0),
      0
    )
  } finally {
    await boost.stop()
    await cdn.close()
  }
})

function selfSignedCert(t: TestContext): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'steam-boost-tls-'))
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-subj',
        `/CN=${CDN_HOST}`,
        '-addext',
        `subjectAltName=DNS:${CDN_HOST}`
      ],
      { stdio: 'ignore' }
    )
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8')
    }
  } catch {
    t.skip('openssl is needed to make a certificate')
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('HTTPS to the cache is passed through to the server it names, over one of the networks', async (t) => {
  const tls = selfSignedCert(t)
  if (!tls) return
  const cdn = await startMockCdn({
    links: { '127.0.0.2': FIBRE, '127.0.0.3': PHONE },
    chunkCount: 4,
    tls
  })
  const { boost, tlsPort } = await startBoost(cdn, () => [fibre, phone], { tlsPort: 0 })
  try {
    const fetchOverTls = (id: string): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        const req = httpsRequest(
          {
            host: '127.0.0.1',
            port: tlsPort!,
            path: `/depot/731/chunk/${id}`,
            servername: CDN_HOST,
            ca: tls.cert,
            agent: false,
            headers: { Host: CDN_HOST, 'User-Agent': STEAM_USER_AGENT }
          },
          (res) => {
            const parts: Buffer[] = []
            res.on('data', (part: Buffer) => parts.push(part))
            res.on('end', () => resolve(Buffer.concat(parts)))
          }
        )
        req.on('error', reject)
        req.end()
      })
    const bodies = await Promise.all(cdn.ids.map(fetchOverTls))
    bodies.forEach((body, i) => {
      assert.equal(createHash('sha1').update(body).digest('hex'), cdn.ids[i])
    })
    const stats = boost.stats()
    const carried = stats.networks.filter((n) => n.bytesTotal > 0).map((n) => n.id)
    t.diagnostic(`HTTPS connections went over: ${carried.join(', ')}`)
    assert.ok(stats.bytesTotal >= 4 * MB)
    assert.equal(carried.length, 2, 'four connections are spread over both networks')
  } finally {
    await boost.stop()
    await cdn.close()
  }
})
