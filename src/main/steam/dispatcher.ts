// Which network carries each of Steam's requests. Steam asks for its content in small pieces
// (chunks of about a megabyte, see steamBoost.ts), many at a time, so the decision is made per
// request, the way Plexo's scheduler hands out blocks of a file (github.com/anmolkapil/plexo).
//
// - A request goes to the network that would finish it soonest: its time to first byte, plus
//   what it already has in flight and this request, at the rate it has shown it can move. That
//   keeps every network's backlog in step with its speed, so a slow phone tether takes a fair
//   share without holding back requests a faster line would have finished first.
// - A network with room is used while its estimate is within `slack` of the best one, which keeps
//   a little more on it than its measured rate says: what it manages with more requests in flight
//   is how its rate is found to be higher. Otherwise the request waits for the better network.
// - An idle network is used on a looser test (`idleSlack`): whatever it carries is on top of what
//   the others do, and with few requests about (Steam's own limit) a strict test would leave a
//   slower line idle all download. One judged too slow even for that is given a request now and
//   then (`probeEveryMs`), so a line that has recovered is noticed.
// - Once nothing is waiting, a network with room may race a request that is running slowly
//   elsewhere (a hedge, as in scheduler.ts). The first copy to arrive is the one Steam gets.
// - A network whose connections keep failing is rested, for longer each time, and comes back on
//   its own. With every network rested, each may still try one request, so none is stranded.
//
// No I/O and no clock of its own: every call is told the time, so each rule can be checked
// against exact situations.

export interface DispatcherPolicy {
  /** Most requests one network carries at once. */
  maxInflightPerNetwork: number
  /** A network with room is used while its finish estimate is within this factor of the best. */
  slack: number
  /** The same for a network carrying nothing at all. */
  idleSlack: number
  /** How often an idle network judged too slow is given a request anyway, to measure it again. */
  probeEveryMs: number
  /** What a network is assumed to move before any network has been measured. */
  priorBytesPerSec: number
  /** The size assumed for a request until its response says (a Steam chunk is about 1 MB). */
  defaultRequestBytes: number
  /** How far back a network's rate is measured. */
  rateWindowMs: number
  /** A request is only raced once it has run this long: long enough to have a real speed. */
  hedgeAfterMs: number
  maxHedgesPerJob: number
  /** Connection failures in a row before a network is rested. */
  failuresToRest: number
  restBaseMs: number
  restMaxMs: number
  /** Attempts a request gets, hedges included, before Steam is told it failed. */
  maxAttemptsPerJob: number
}

export const DEFAULT_POLICY: DispatcherPolicy = {
  maxInflightPerNetwork: 24,
  slack: 1.25,
  idleSlack: 4,
  probeEveryMs: 10_000,
  priorBytesPerSec: 1024 * 1024,
  defaultRequestBytes: 1024 * 1024,
  rateWindowMs: 3000,
  hedgeAfterMs: 2000,
  maxHedgesPerJob: 1,
  failuresToRest: 3,
  restBaseMs: 2000,
  restMaxMs: 30_000,
  maxAttemptsPerJob: 4
}

/** How an attempt ended. `network`: the connection failed, stalled or was cut short (says
 * something about the network). `server`: the server answered with an error worth one try
 * elsewhere (5xx). `cancelled`: called off — a raced copy lost, or Steam went away. */
export type AttemptOutcome = 'ok' | 'network' | 'server' | 'cancelled'

export interface StartAction {
  jobId: number
  attemptId: number
  networkId: string
  hedge: boolean
}

export interface FinishResult {
  /** The job is over (done or failed) and its other attempts are in `abort`. */
  settled: 'done' | 'failed' | null
  abort: number[]
}

export interface NetworkSnapshot {
  id: string
  inflight: number
  /** Bytes a second it moves while it has requests in flight; null until measured. */
  rateBytesPerSec: number | null
  /** Bytes a second it actually moved over the last window. */
  speedBytesPerSec: number
  ttfbMs: number | null
  resting: boolean
  bytesTotal: number
  requestsDone: number
  failures: number
  hedgesWon: number
}

interface Sample {
  bytes: number
  busyMs: number
  wallMs: number
}

interface NetworkState {
  id: string
  inflight: Set<number>
  samples: Sample[]
  pendingBytes: number
  rate: number | null
  speed: number
  ttfbMs: number | null
  failuresInRow: number
  rests: number
  restUntil: number
  /** When it was last given an attempt (see probeEveryMs). */
  lastStartAt: number
  bytesTotal: number
  requestsDone: number
  failures: number
  hedgesWon: number
}

interface Attempt {
  id: number
  jobId: number
  networkId: string
  hedge: boolean
  startedAt: number
  firstByteAt: number | null
  received: number
  expected: number | null
}

interface Job {
  id: number
  expected: number | null
  attempts: Set<number>
  tries: number
  hedges: number
  /** The network its last attempt failed on: another one takes it if it can. */
  avoid: string | null
  /** Networks that answered it with a server error: it is retried on another one only. */
  serverErrors: Set<string>
}

const TTFB_WEIGHT = 0.3
/** A network measured over less busy time than this keeps the rate it had. */
const MIN_BUSY_MS = 500
/** Bytes a second taken for a network that had requests in flight and delivered nothing. */
const STALLED_RATE = 1024

export class Dispatcher {
  private readonly networks = new Map<string, NetworkState>()
  private readonly jobs = new Map<number, Job>()
  private readonly attempts = new Map<number, Attempt>()
  /** Jobs waiting for a network, oldest first. */
  private queue: number[] = []
  private nextJobId = 1
  private nextAttemptId = 1
  private lastTick: number | null = null

  constructor(private readonly policy: DispatcherPolicy = DEFAULT_POLICY) {}

  /** The networks in use. One that leaves takes its attempts with it: they are returned, for the
   * caller to stop, and their jobs go back to the front of the queue. */
  setNetworks(ids: readonly string[]): number[] {
    const aborted: number[] = []
    for (const [id, network] of this.networks) {
      if (ids.includes(id)) continue
      for (const attemptId of network.inflight) {
        aborted.push(attemptId)
        this.dropAttempt(attemptId, true)
      }
      this.networks.delete(id)
    }
    for (const id of ids) if (!this.networks.has(id)) this.networks.set(id, freshNetwork(id))
    return aborted
  }

  networkIds(): string[] {
    return [...this.networks.keys()]
  }

  /** A new request from Steam. `expectedBytes`: its size when the request says (a Range). */
  submit(expectedBytes: number | null): number {
    const id = this.nextJobId++
    this.jobs.set(id, {
      id,
      expected: expectedBytes,
      attempts: new Set(),
      tries: 0,
      hedges: 0,
      avoid: null,
      serverErrors: new Set()
    })
    this.queue.push(id)
    return id
  }

  /** No more races for this job: its answer is already on its way to Steam. */
  noHedges(jobId: number): void {
    const job = this.jobs.get(jobId)
    if (job) job.hedges = Number.POSITIVE_INFINITY
  }

  /** Steam went away, or the job was answered: every attempt still running is returned. */
  cancelJob(jobId: number): number[] {
    const job = this.jobs.get(jobId)
    if (!job) return []
    const running = [...job.attempts]
    for (const attemptId of running) this.dropAttempt(attemptId, false)
    this.jobs.delete(jobId)
    this.queue = this.queue.filter((id) => id !== jobId)
    return running
  }

  /** Waiting jobs that should start now, and hedges worth racing. */
  schedule(now: number): StartAction[] {
    const actions: StartAction[] = []
    while (this.queue.length > 0) {
      const job = this.jobs.get(this.queue[0])
      if (!job) {
        this.queue.shift()
        continue
      }
      const networkId = this.placeFor(job, now)
      if (networkId === null) break
      this.queue.shift()
      actions.push(this.begin(job, networkId, false, now))
    }
    if (this.queue.length === 0) actions.push(...this.hedges(now))
    return actions
  }

  /** Response headers arrived: how long it took, and the size if the response gave one. */
  onHeaders(attemptId: number, contentLength: number | null, now: number): void {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return
    if (contentLength !== null && contentLength >= 0) {
      attempt.expected = contentLength
      const job = this.jobs.get(attempt.jobId)
      if (job) job.expected = contentLength
    }
    const network = this.networks.get(attempt.networkId)
    if (network) {
      const ttfb = now - attempt.startedAt
      network.ttfbMs =
        network.ttfbMs === null ? ttfb : network.ttfbMs + (ttfb - network.ttfbMs) * TTFB_WEIGHT
    }
  }

  onBytes(attemptId: number, bytes: number, now: number): void {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return
    attempt.firstByteAt ??= now
    attempt.received += bytes
    const network = this.networks.get(attempt.networkId)
    if (network) {
      network.pendingBytes += bytes
      network.bytesTotal += bytes
    }
  }

  onFinish(attemptId: number, outcome: AttemptOutcome, now: number): FinishResult {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return { settled: null, abort: [] }
    const job = this.jobs.get(attempt.jobId)
    const network = this.networks.get(attempt.networkId)
    this.dropAttempt(attemptId, false)
    if (!job) return { settled: null, abort: [] }

    if (outcome === 'ok') {
      if (network) {
        network.failuresInRow = 0
        network.rests = 0
        network.requestsDone++
        if (attempt.hedge) network.hedgesWon++
      }
      const abort = [...job.attempts]
      for (const other of abort) this.dropAttempt(other, false)
      this.jobs.delete(job.id)
      return { settled: 'done', abort }
    }
    if (outcome === 'cancelled') return { settled: null, abort: [] }

    if (network) {
      network.failures++
      if (outcome === 'network') {
        network.failuresInRow++
        if (network.failuresInRow >= this.policy.failuresToRest) {
          network.restUntil =
            now + Math.min(this.policy.restBaseMs * 2 ** network.rests, this.policy.restMaxMs)
          network.rests++
          network.failuresInRow = 0
        }
      }
    }
    // Another copy is still on its way: it may yet succeed.
    if (job.attempts.size > 0) return { settled: null, abort: [] }

    const otherNetwork = [...this.networks.keys()].some(
      (id) => id !== attempt.networkId && !job.serverErrors.has(id)
    )
    if (outcome === 'server') job.serverErrors.add(attempt.networkId)
    const retry =
      job.tries < this.policy.maxAttemptsPerJob && (outcome === 'network' || otherNetwork)
    if (!retry) {
      this.jobs.delete(job.id)
      return { settled: 'failed', abort: [] }
    }
    job.avoid = attempt.networkId
    // At the front: it has waited longest, and Steam is waiting on it.
    this.queue.unshift(job.id)
    return { settled: null, abort: [] }
  }

  /** Brings each network's measured rate up to `now`. Called every few hundred ms. */
  tick(now: number): void {
    const wallMs = this.lastTick === null ? 0 : Math.max(0, now - this.lastTick)
    this.lastTick = now
    if (wallMs === 0) return
    for (const network of this.networks.values()) {
      const busy = network.inflight.size > 0 || network.pendingBytes > 0
      network.samples.push({ bytes: network.pendingBytes, busyMs: busy ? wallMs : 0, wallMs })
      network.pendingBytes = 0
      let span = network.samples.reduce((sum, sample) => sum + sample.wallMs, 0)
      while (
        network.samples.length > 1 &&
        span - network.samples[0].wallMs >= this.policy.rateWindowMs
      ) {
        span -= network.samples[0].wallMs
        network.samples.shift()
      }
      const bytes = network.samples.reduce((sum, sample) => sum + sample.bytes, 0)
      const busyMs = network.samples.reduce((sum, sample) => sum + sample.busyMs, 0)
      network.speed = span > 0 ? (bytes / span) * 1000 : 0
      if (busyMs >= MIN_BUSY_MS && bytes > 0) network.rate = (bytes / busyMs) * 1000
      // Busy the whole window and nothing came: stalled, whatever it managed before. A rate this
      // low keeps new requests off it until it delivers again.
      else if (busyMs >= this.policy.rateWindowMs && bytes === 0) network.rate = STALLED_RATE
    }
  }

  snapshot(now: number): NetworkSnapshot[] {
    return [...this.networks.values()].map((network) => ({
      id: network.id,
      inflight: network.inflight.size,
      rateBytesPerSec: network.rate,
      speedBytesPerSec: network.speed,
      ttfbMs: network.ttfbMs,
      resting: network.restUntil > now,
      bytesTotal: network.bytesTotal,
      requestsDone: network.requestsDone,
      failures: network.failures,
      hedgesWon: network.hedgesWon
    }))
  }

  /** Jobs waiting for a network. */
  get waiting(): number {
    return this.queue.length
  }

  /** Requests in flight on any network, hedges included. */
  get inflight(): number {
    return this.attempts.size
  }

  /** The network that takes this job now, or null to keep it waiting. */
  private placeFor(job: Job, now: number): string | null {
    const size = job.expected ?? this.policy.defaultRequestBytes
    let candidates = [...this.networks.values()].filter((network) => network.restUntil <= now)
    let cap = this.policy.maxInflightPerNetwork
    if (candidates.length === 0) {
      // Every network is resting: each may still try one, so the job isn't stranded.
      candidates = [...this.networks.values()]
      cap = 1
    }
    // A network the job just failed on leaves it to another, if another has room.
    if (job.avoid !== null && candidates.some((n) => n.id !== job.avoid && n.inflight.size < cap)) {
      candidates = candidates.filter((network) => network.id !== job.avoid)
    }
    // A server error is only worth trying again elsewhere.
    if (job.serverErrors.size > 0) {
      const others = candidates.filter((network) => !job.serverErrors.has(network.id))
      if (others.length > 0) candidates = others
    }
    if (candidates.length === 0) return null

    let best = Infinity
    let bestFree: { network: NetworkState; eta: number } | null = null
    let bestIdle: { network: NetworkState; eta: number } | null = null
    for (const network of candidates) {
      const eta = this.eta(network, size)
      best = Math.min(best, eta)
      if (network.inflight.size >= cap) continue
      if (!bestFree || eta < bestFree.eta) bestFree = { network, eta }
      if (network.inflight.size === 0 && (!bestIdle || eta < bestIdle.eta)) {
        bestIdle = { network, eta }
      }
    }
    // An idle network goes first: what it carries adds to what the others do.
    if (bestIdle && bestIdle.eta <= best * this.policy.idleSlack) return bestIdle.network.id
    if (bestFree && bestFree.eta <= best * this.policy.slack) return bestFree.network.id
    if (bestIdle && now - bestIdle.network.lastStartAt >= this.policy.probeEveryMs) {
      return bestIdle.network.id
    }
    return null
  }

  /** When a request of `size` bytes would be done on `network`, in ms from now. */
  private eta(network: NetworkState, size: number): number {
    return (network.ttfbMs ?? 0) + ((this.backlog(network) + size) / this.rateOf(network)) * 1000
  }

  /** Bytes still to come over `network` for the attempts it has in flight. */
  private backlog(network: NetworkState): number {
    let bytes = 0
    for (const attemptId of network.inflight) {
      const attempt = this.attempts.get(attemptId)
      if (!attempt) continue
      bytes += Math.max(0, (attempt.expected ?? this.policy.defaultRequestBytes) - attempt.received)
    }
    return bytes
  }

  /** Its measured rate. Unmeasured, it's assumed as fast as the fastest one measured, so it gets
   * tried rather than written off. */
  private rateOf(network: NetworkState): number {
    if (network.rate !== null && network.rate > 0) return network.rate
    let fastest = 0
    for (const other of this.networks.values()) fastest = Math.max(fastest, other.rate ?? 0)
    return fastest > 0 ? fastest : this.policy.priorBytesPerSec
  }

  /** Races for requests running slowly, each on a network with room that would clearly be done
   * first. One per network per call. */
  private hedges(now: number): StartAction[] {
    const actions: StartAction[] = []
    for (const network of this.networks.values()) {
      if (network.restUntil > now || network.inflight.size >= this.policy.maxInflightPerNetwork) {
        continue
      }
      let target: { job: Job; late: number } | null = null
      for (const job of this.jobs.values()) {
        if (job.attempts.size !== 1 || job.hedges >= this.policy.maxHedgesPerJob) continue
        if (job.tries >= this.policy.maxAttemptsPerJob) continue
        const attempt = this.attempts.get([...job.attempts][0])
        if (!attempt || attempt.networkId === network.id) continue
        if (now - attempt.startedAt < this.policy.hedgeAfterMs) continue
        const size = attempt.expected ?? this.policy.defaultRequestBytes
        const remaining = Math.max(0, size - attempt.received)
        if (remaining === 0) continue
        const elapsed = attempt.firstByteAt === null ? 0 : now - attempt.firstByteAt
        const speed = elapsed > 0 ? (attempt.received / elapsed) * 1000 : 0
        // Nothing yet after hedgeAfterMs has no finish time at all.
        const left = speed > 0 ? (remaining / speed) * 1000 : Infinity
        const fresh = this.eta(network, size)
        if (left < 2 * fresh) continue
        if (!target || left > target.late) target = { job, late: left }
      }
      if (target) {
        target.job.hedges++
        actions.push(this.begin(target.job, network.id, true, now))
      }
    }
    return actions
  }

  private begin(job: Job, networkId: string, hedge: boolean, now: number): StartAction {
    const attemptId = this.nextAttemptId++
    job.tries++
    job.attempts.add(attemptId)
    this.attempts.set(attemptId, {
      id: attemptId,
      jobId: job.id,
      networkId,
      hedge,
      startedAt: now,
      firstByteAt: null,
      received: 0,
      expected: job.expected
    })
    const network = this.networks.get(networkId)
    if (network) {
      network.inflight.add(attemptId)
      network.lastStartAt = now
    }
    return { jobId: job.id, attemptId, networkId, hedge }
  }

  /** Forgets an attempt. `requeue`: its job goes back to the front of the queue when nothing
   * else is fetching it (its network left). */
  private dropAttempt(attemptId: number, requeue: boolean): void {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return
    this.attempts.delete(attemptId)
    this.networks.get(attempt.networkId)?.inflight.delete(attemptId)
    const job = this.jobs.get(attempt.jobId)
    if (!job) return
    job.attempts.delete(attemptId)
    if (requeue && job.attempts.size === 0 && !this.queue.includes(job.id)) {
      // A network leaving isn't the job's fault: it doesn't count against its tries.
      job.tries = Math.max(0, job.tries - 1)
      this.queue.unshift(job.id)
    }
  }
}

function freshNetwork(id: string): NetworkState {
  return {
    id,
    inflight: new Set(),
    samples: [],
    pendingBytes: 0,
    rate: null,
    speed: 0,
    ttfbMs: null,
    failuresInRow: 0,
    rests: 0,
    restUntil: 0,
    lastStartAt: Number.NEGATIVE_INFINITY,
    bytesTotal: 0,
    requestsDone: 0,
    failures: 0,
    hedgesWon: 0
  }
}
