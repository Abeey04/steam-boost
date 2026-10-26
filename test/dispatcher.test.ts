import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_POLICY, Dispatcher, type DispatcherPolicy } from '../src/main/steam/dispatcher'

const MB = 1024 * 1024

interface Link {
  /** Bytes a second the network carries in all. */
  rate: number
  /** Bytes a second one connection manages at most (TCP over a long path). */
  perConnection?: number
  /** ms from a request to its first byte. */
  latency?: number
}

/**
 * Steam-like load on a dispatcher, in simulated time: `outstanding` requests of `size` bytes are
 * always in flight or waiting (Steam asks for the next as one finishes), and each network shares
 * its rate evenly between the requests it carries. Returns the bytes each network delivered.
 */
function simulate(
  links: Record<string, Link | ((t: number) => Link)>,
  {
    seconds = 60,
    outstanding = 32,
    size = MB,
    policy = DEFAULT_POLICY,
    from = 0
  }: {
    seconds?: number
    outstanding?: number
    size?: number
    policy?: DispatcherPolicy
    from?: number
  } = {}
): { delivered: Record<string, number>; total: number; done: number } {
  const dispatcher = new Dispatcher(policy)
  dispatcher.setNetworks(Object.keys(links))
  const running = new Map<
    number,
    { network: string; startedAt: number; got: number; headers: boolean }
  >()
  const delivered: Record<string, number> = Object.fromEntries(
    Object.keys(links).map((id) => [id, 0])
  )
  let done = 0
  let total = 0
  const linkAt = (id: string, t: number): Link => {
    const link = links[id]
    return typeof link === 'function' ? link(t) : link
  }
  for (let i = 0; i < outstanding; i++) dispatcher.submit(null)

  const stepMs = 50
  for (let t = 0; t <= seconds * 1000; t += stepMs) {
    for (const action of dispatcher.schedule(t)) {
      running.set(action.attemptId, {
        network: action.networkId,
        startedAt: t,
        got: 0,
        headers: false
      })
    }
    for (const id of Object.keys(links)) {
      const link = linkAt(id, t)
      const mine = [...running.entries()].filter(([, run]) => run.network === id)
      const flowing = mine.filter(([, run]) => t - run.startedAt >= (link.latency ?? 20))
      if (flowing.length === 0) continue
      const share = Math.min(
        (link.rate * stepMs) / 1000 / flowing.length,
        ((link.perConnection ?? Infinity) * stepMs) / 1000
      )
      for (const [attemptId, run] of flowing) {
        if (!run.headers) {
          run.headers = true
          dispatcher.onHeaders(attemptId, size, t)
        }
        const bytes = Math.min(share, size - run.got)
        run.got += bytes
        dispatcher.onBytes(attemptId, bytes, t)
        if (t >= from) {
          delivered[id] += bytes
          total += bytes
        }
        if (run.got >= size) {
          running.delete(attemptId)
          const result = dispatcher.onFinish(attemptId, 'ok', t)
          for (const other of result.abort) running.delete(other)
          if (result.settled === 'done') {
            done++
            dispatcher.submit(null)
          }
        }
      }
    }
    dispatcher.tick(t)
  }
  return { delivered, total, done }
}

test('a request goes to whichever unmeasured network has least on it', () => {
  const dispatcher = new Dispatcher()
  dispatcher.setNetworks(['a', 'b'])
  for (let i = 0; i < 6; i++) dispatcher.submit(null)
  const started = dispatcher.schedule(0)
  assert.equal(started.length, 6)
  assert.deepEqual(
    started.map((action) => action.networkId),
    ['a', 'b', 'a', 'b', 'a', 'b']
  )
})

test('two networks together carry about what both can, each in proportion to its speed', () => {
  const { delivered, total } = simulate(
    { fibre: { rate: 6 * MB, latency: 30 }, phone: { rate: 2 * MB, latency: 80 } },
    { seconds: 60, from: 10_000 }
  )
  const seconds = 50
  assert.ok(total / seconds > 0.9 * 8 * MB, `combined ${(total / seconds / MB).toFixed(2)} MB/s`)
  const share = delivered.phone / total
  assert.ok(share > 0.18 && share < 0.32, `phone carried ${(share * 100).toFixed(1)}%`)
})

test('with only a few requests about, an idle slower network still carries its part', () => {
  const { delivered, total } = simulate(
    { fibre: { rate: 6 * MB, latency: 30 }, phone: { rate: 2 * MB, latency: 80 } },
    { seconds: 40, outstanding: 4, from: 10_000 }
  )
  assert.ok(delivered.phone / 30 > 1 * MB, `phone ${(delivered.phone / 30 / MB).toFixed(2)} MB/s`)
  assert.ok(total / 30 > 0.85 * 8 * MB, `combined ${(total / 30 / MB).toFixed(2)} MB/s`)
})

test('a network judged stalled is tried again now and then, and taken back once it delivers', () => {
  const { delivered } = simulate(
    {
      fibre: { rate: 6 * MB },
      // Nothing at all for the first 15 s (a phone that lost signal), then 2 MB/s.
      phone: (t) => ({ rate: t < 15_000 ? 0 : 2 * MB })
    },
    { seconds: 60, from: 35_000 }
  )
  assert.ok(delivered.phone / 25 > 1.5 * MB, `phone ${(delivered.phone / 25 / MB).toFixed(2)} MB/s`)
})

test('a slow network is not handed so much that the fast one runs dry', () => {
  // A tenth of the speed: what it is given must not hold Steam's requests back from the fast one.
  const { total } = simulate(
    { fibre: { rate: 10 * MB }, slow: { rate: 1 * MB, latency: 150 } },
    { seconds: 40, from: 10_000 }
  )
  assert.ok(total / 30 > 0.9 * 11 * MB, `combined ${(total / 30 / MB).toFixed(2)} MB/s`)
})

test('a network that needs several connections to fill gets them', () => {
  // Each connection over the phone manages 0.4 MB/s of its 2 MB/s: it needs five at once.
  const { delivered, total } = simulate(
    { fibre: { rate: 6 * MB }, phone: { rate: 2 * MB, perConnection: 0.4 * MB, latency: 120 } },
    { seconds: 60, from: 15_000 }
  )
  const seconds = 45
  assert.ok(
    delivered.phone / seconds > 1.5 * MB,
    `phone ${(delivered.phone / seconds / MB).toFixed(2)} MB/s`
  )
  assert.ok(total / seconds > 0.85 * 8 * MB, `combined ${(total / seconds / MB).toFixed(2)} MB/s`)
})

test('when a network slows down, its share moves to the other', () => {
  const { delivered } = simulate(
    {
      // Fibre drops to an eighth of its speed 20 s in.
      fibre: (t) => ({ rate: t < 20_000 ? 8 * MB : 1 * MB }),
      phone: { rate: 3 * MB }
    },
    { seconds: 50, from: 30_000 }
  )
  assert.ok(delivered.phone > delivered.fibre * 2, JSON.stringify(delivered))
})

test('a request waits for the much faster network rather than start on a crawling one', () => {
  const policy = { ...DEFAULT_POLICY, maxInflightPerNetwork: 2 }
  const dispatcher = new Dispatcher(policy)
  dispatcher.setNetworks(['fast', 'slow'])
  // Teach it the rates: fast 10 MB/s, slow 0.1 MB/s.
  for (let i = 0; i < 2; i++) dispatcher.submit(MB)
  const first = dispatcher.schedule(0)
  assert.deepEqual(
    first.map((action) => action.networkId),
    ['fast', 'slow']
  )
  for (let t = 0; t <= 1000; t += 100) {
    dispatcher.onBytes(first[0].attemptId, MB / 10, t)
    dispatcher.onBytes(first[1].attemptId, 10_000, t)
    dispatcher.tick(t)
  }
  dispatcher.onFinish(first[0].attemptId, 'ok', 1000)
  // Fill the fast network, then offer one more: the slow one has room but would take ages.
  dispatcher.submit(MB)
  dispatcher.submit(MB)
  dispatcher.submit(MB)
  const next = dispatcher.schedule(1000)
  assert.deepEqual(
    next.map((action) => action.networkId),
    ['fast', 'fast']
  )
  assert.equal(dispatcher.waiting, 1)
})

test('a network whose connections keep failing rests, then comes back', () => {
  const dispatcher = new Dispatcher({ ...DEFAULT_POLICY, failuresToRest: 2, restBaseMs: 1000 })
  dispatcher.setNetworks(['a', 'b'])
  let now = 0
  for (let i = 0; i < 2; i++) {
    dispatcher.submit(null)
    const [action] = dispatcher.schedule(now).filter((start) => start.networkId === 'a')
    assert.ok(action, 'a request on a')
    dispatcher.onFinish(action.attemptId, 'network', now)
    // The retry goes to b.
    const retry = dispatcher.schedule(now)
    assert.ok(retry.every((start) => start.networkId === 'b'))
    for (const start of retry) dispatcher.onFinish(start.attemptId, 'ok', now)
  }
  assert.equal(dispatcher.snapshot(now).find((network) => network.id === 'a')?.resting, true)
  for (let i = 0; i < 3; i++) dispatcher.submit(null)
  assert.ok(dispatcher.schedule(now).every((start) => start.networkId === 'b'))
  now += 1001
  assert.equal(dispatcher.snapshot(now).find((network) => network.id === 'a')?.resting, false)
  dispatcher.submit(null)
  assert.ok(dispatcher.schedule(now).some((start) => start.networkId === 'a'))
})

test('a request that failed on one network is retried on another', () => {
  const dispatcher = new Dispatcher()
  dispatcher.setNetworks(['a', 'b'])
  dispatcher.submit(null)
  const [first] = dispatcher.schedule(0)
  assert.equal(first.networkId, 'a')
  assert.deepEqual(dispatcher.onFinish(first.attemptId, 'network', 0), { settled: null, abort: [] })
  const [retry] = dispatcher.schedule(0)
  assert.equal(retry.jobId, first.jobId)
  assert.equal(retry.networkId, 'b')
})

test('a server error is tried once on each other network, then passed on', () => {
  const dispatcher = new Dispatcher()
  dispatcher.setNetworks(['a', 'b'])
  dispatcher.submit(null)
  const [first] = dispatcher.schedule(0)
  assert.equal(dispatcher.onFinish(first.attemptId, 'server', 0).settled, null)
  const [second] = dispatcher.schedule(0)
  assert.equal(second.networkId, 'b')
  assert.equal(dispatcher.onFinish(second.attemptId, 'server', 0).settled, 'failed')
  assert.equal(dispatcher.schedule(0).length, 0)
})

test('a request gives up after its last attempt', () => {
  const dispatcher = new Dispatcher({ ...DEFAULT_POLICY, maxAttemptsPerJob: 3, failuresToRest: 99 })
  dispatcher.setNetworks(['a'])
  dispatcher.submit(null)
  const outcomes: (string | null)[] = []
  for (let i = 0; i < 3; i++) {
    const [action] = dispatcher.schedule(i)
    outcomes.push(dispatcher.onFinish(action.attemptId, 'network', i).settled)
  }
  assert.deepEqual(outcomes, [null, null, 'failed'])
})

test('a slow request is raced on an idle network once nothing is waiting, and the first wins', () => {
  const dispatcher = new Dispatcher({ ...DEFAULT_POLICY, hedgeAfterMs: 2000 })
  dispatcher.setNetworks(['a', 'b'])
  dispatcher.submit(MB)
  dispatcher.submit(MB)
  const [onA, onB] = dispatcher.schedule(0)
  assert.equal(onA.networkId, 'a')
  // a finishes quickly; b crawls.
  for (let t = 0; t <= 500; t += 100) {
    dispatcher.onBytes(onA.attemptId, MB / 5, t)
    dispatcher.onBytes(onB.attemptId, 2000, t)
    dispatcher.tick(t)
  }
  dispatcher.onFinish(onA.attemptId, 'ok', 500)
  assert.equal(dispatcher.schedule(1000).length, 0, 'too early to race')
  for (let t = 600; t <= 2500; t += 100) {
    dispatcher.onBytes(onB.attemptId, 2000, t)
    dispatcher.tick(t)
  }
  const [hedge] = dispatcher.schedule(2500)
  assert.ok(hedge, 'a hedge')
  assert.equal(hedge.hedge, true)
  assert.equal(hedge.networkId, 'a')
  assert.equal(hedge.jobId, onB.jobId)
  const won = dispatcher.onFinish(hedge.attemptId, 'ok', 2600)
  assert.deepEqual(won, { settled: 'done', abort: [onB.attemptId] })
  assert.equal(dispatcher.snapshot(2600).find((network) => network.id === 'a')?.hedgesWon, 1)
})

test('a network that leaves hands its requests back, without counting it against them', () => {
  const dispatcher = new Dispatcher({ ...DEFAULT_POLICY, maxAttemptsPerJob: 1 })
  dispatcher.setNetworks(['a', 'b'])
  dispatcher.submit(null)
  dispatcher.submit(null)
  const started = dispatcher.schedule(0)
  const onB = started.find((action) => action.networkId === 'b')!
  assert.deepEqual(dispatcher.setNetworks(['a']), [onB.attemptId])
  const [again] = dispatcher.schedule(0)
  assert.equal(again.jobId, onB.jobId)
  assert.equal(again.networkId, 'a')
})

test('with every network resting, each still gets one request', () => {
  const dispatcher = new Dispatcher({ ...DEFAULT_POLICY, failuresToRest: 1, restBaseMs: 60_000 })
  dispatcher.setNetworks(['a'])
  dispatcher.submit(null)
  const [first] = dispatcher.schedule(0)
  dispatcher.onFinish(first.attemptId, 'network', 0)
  assert.equal(dispatcher.snapshot(0)[0].resting, true)
  dispatcher.submit(null)
  const probes = dispatcher.schedule(1)
  assert.equal(probes.length, 1)
})

test('Steam leaving takes its request away, attempts and all', () => {
  const dispatcher = new Dispatcher()
  dispatcher.setNetworks(['a'])
  const job = dispatcher.submit(null)
  const [action] = dispatcher.schedule(0)
  assert.deepEqual(dispatcher.cancelJob(job), [action.attemptId])
  assert.equal(dispatcher.inflight, 0)
  assert.deepEqual(dispatcher.onFinish(action.attemptId, 'ok', 1), { settled: null, abort: [] })
})
