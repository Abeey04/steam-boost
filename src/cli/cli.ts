import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { isIP } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import packageJson from '../../package.json'
import type { NetworkInterfaceInfo } from '../shared/network'
import { LOOPBACK as STEAM_BOOST_DEFAULT_ADDRESS } from '../main/listenAddress'
import { deviceBindingSupported } from '../main/network/deviceBinding'
import { listActiveInterfaces, NetworkMonitor } from '../main/network/interfaces'
import {
  cacheLines,
  findCacheSightings,
  findSteamDir,
  readContentLogTail
} from '../main/steam/contentLog'
import { defaultRouteInterfaces } from '../main/steam/defaultRoutes'
import {
  hasBlock,
  hostsFilePath,
  otherEntries,
  readEntry,
  readHostsFile,
  withEntry,
  withoutEntry
} from '../main/steam/hostsFile'
import { STATUS_PATH, SteamBoost, type SteamBoostStats } from '../main/steam/steamBoost'
import { TRIGGER_HOST } from '../main/steam/steamHosts'
import { DataCaps, flag, parseArgs, parseCaps, type Args } from './args'

// steam-boost-cli: Steam Boost without the app. The same engine (src/main/steam), run from a
// terminal: `npm run build:cli` makes one file that runs on Node 20+ with nothing installed.

const execFileAsync = promisify(execFile)
const VERSION = packageJson.version

const HELP = `steam-boost-cli ${VERSION}: Steam downloads over every internet connection at once

Usage:
  steam-boost-cli networks             List this computer's networks
  steam-boost-cli start [options]      Run the boost; Ctrl+C stops it
  steam-boost-cli hosts on [--address IP]
                                         Point Steam at the boost (administrator)
  steam-boost-cli hosts off            Undo that (administrator)
  steam-boost-cli check                Is it set up, and is Steam using it?

Options for start:
  --networks a,b   Network ids to use (see "networks"); default: every one with an internet route
  --address IP     Where to listen; default ${STEAM_BOOST_DEFAULT_ADDRESS}. "lan" picks this computer's
                   LAN address, for a Steam that ignores loopback (see "check")
  --hosts          Add the hosts entry while running and take it out on exit (administrator)
  --cap a=2GB,b=1GB
                   Stop using a network once it has carried that much since "start" (a phone's
                   data, say). Once every network has used its cap, the boost stops
  --no-https       Don't pass HTTPS through on port 443
  --lan            Serve other computers on your network too (they point at this one)
  --verbose        Log network changes and refused requests

Steam reads the hosts entry when it starts: restart Steam after setting it up.
Ctrl+C, Ctrl+Break or closing the window all stop it and take out what --hosts added.`

const gb = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(0)} MB`
const mbps = (bytesPerSec: number): string => `${(bytesPerSec / 1024 ** 2).toFixed(2)} MB/s`
const pad = (text: string, width: number): string =>
  text.length >= width ? text.slice(0, width - 1) + '…' : text.padEnd(width)

function isPrivateV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** The networks to suggest: every one with a default route, else every one but bridges. */
async function suggested(all: NetworkInterfaceInfo[]): Promise<NetworkInterfaceInfo[]> {
  const routed = await defaultRouteInterfaces(all)
  const candidates = all.filter((iface) => iface.kind !== 'bridge')
  if (!routed || routed.size === 0) return candidates
  return candidates.filter((iface) => routed.has(iface.id))
}

async function resolveAddress(
  wanted: string | undefined,
  networks: NetworkInterfaceInfo[]
): Promise<string> {
  if (!wanted) return STEAM_BOOST_DEFAULT_ADDRESS
  if (wanted !== 'lan') {
    if (!isIP(wanted)) throw new Error(`--address needs an IP address or "lan", not ${wanted}`)
    return wanted
  }
  for (const iface of networks) {
    const address = iface.addresses.find(
      (entry) => entry.family === 4 && isPrivateV4(entry.address)
    )
    if (address) return address.address
  }
  throw new Error('None of the networks has a private (LAN) IPv4 address to listen on.')
}

function explainHostsError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EPERM' || code === 'EACCES') {
    return new Error(
      process.platform === 'win32'
        ? 'Changing the hosts file needs administrator rights: open Terminal (or PowerShell) with "Run as administrator" and run this again.'
        : 'Changing the hosts file needs administrator rights: run this again with sudo.'
    )
  }
  return error instanceof Error ? error : new Error(String(error))
}

async function flushDns(): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('ipconfig', ['/flushdns'], { windowsHide: true, timeout: 10_000 })
    } else if (process.platform === 'darwin') {
      await execFileAsync('dscacheutil', ['-flushcache'], { timeout: 10_000 })
      await execFileAsync('killall', ['-HUP', 'mDNSResponder'], { timeout: 10_000 }).catch(() => {})
    }
  } catch {
    // The OS picks up a hosts change soon enough on its own.
  }
}

/** Points TRIGGER_HOST at `address` (or nowhere). Synchronous, so it's done before anything else
 * can happen: a Ctrl+C can't land halfway through, and a closing console window, which leaves
 * this process seconds to live, doesn't cut it short. Says what it did. */
function setHostsEntrySync(address: string | null): { message: string; changed: boolean } {
  const path = hostsFilePath()
  const before = readFileSync(path, 'utf8')
  if (address === null && !hasBlock(before)) {
    return { message: `No Steam Boost line in ${path}: nothing to undo.`, changed: false }
  }
  const after = address === null ? withoutEntry(before) : withEntry(before, address)
  if (after !== before) {
    try {
      writeFileSync(path, after, 'utf8')
    } catch (error) {
      throw explainHostsError(error)
    }
  }
  const others = otherEntries(after)
  const lines = [
    address === null
      ? `Removed the Steam Boost line from ${path}.`
      : `${path}: ${TRIGGER_HOST} -> ${address}`
  ]
  if (others.length > 0) {
    lines.push(
      `Note: another line in that file gives ${TRIGGER_HOST} ${others.join(', ')}; the first one wins.`
    )
  }
  return { message: lines.join('\n'), changed: after !== before }
}

async function setHostsEntry(address: string | null): Promise<string> {
  const { message, changed } = setHostsEntrySync(address)
  if (changed) await flushDns()
  return message
}

function fetchStatus(address: string): Promise<SteamBoostStats | null> {
  return new Promise((resolve) => {
    const req = request(
      { host: address, port: 80, path: STATUS_PATH, timeout: 2000, headers: { Host: address } },
      (res) => {
        const parts: Buffer[] = []
        res.on('data', (part: Buffer) => parts.push(part))
        res.on('end', () => {
          try {
            resolve(
              res.statusCode === 200 ? JSON.parse(Buffer.concat(parts).toString('utf8')) : null
            )
          } catch {
            resolve(null)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })
}

async function networksCommand(): Promise<void> {
  const all = await listActiveInterfaces()
  const picks = new Set((await suggested(all)).map((iface) => iface.id))
  if (all.length === 0) {
    console.log('No networks found.')
    return
  }
  console.log(`${pad('ID', 26)}${pad('KIND', 10)}${pad('ADDRESSES', 40)}USED BY DEFAULT`)
  for (const iface of all) {
    const addresses = iface.addresses.map((entry) => entry.address).join(', ')
    console.log(
      `${pad(iface.id, 26)}${pad(iface.kind, 10)}${pad(addresses, 40)}${picks.has(iface.id) ? 'yes' : ''}`
    )
  }
  console.log(
    '\nEach network needs its own internet connection to add speed (Wi-Fi + a USB-tethered'
  )
  console.log("phone, say). Wi-Fi and Ethernet to the same router share one, so they don't.")
}

async function checkCommand(): Promise<void> {
  let ok = true
  const mark = (good: boolean): string => (good ? 'OK ' : '!! ')

  // 1. The hosts file.
  const path = hostsFilePath()
  let entry: string | null = null
  try {
    const text = await readHostsFile(path)
    entry = readEntry(text)
    const others = otherEntries(text)
    console.log(
      `${mark(entry !== null)}Hosts file ${path}: ${entry ? `${TRIGGER_HOST} -> ${entry}` : 'no Steam Boost line (run "hosts on" as administrator)'}`
    )
    if (others.length > 0)
      console.log(`   Another line gives it ${others.join(', ')}, and the first one wins.`)
    ok &&= entry !== null
  } catch (error) {
    console.log(`!! Couldn't read ${path}: ${(error as Error).message}`)
    ok = false
  }

  // 2. What the name resolves to.
  let resolved: string[] = []
  try {
    resolved = (await lookup(TRIGGER_HOST, { all: true })).map((result) => result.address)
  } catch {
    // Nothing: Steam won't find a cache.
  }
  const resolvesHere = entry !== null && resolved.includes(entry)
  console.log(
    `${mark(resolvesHere)}${TRIGGER_HOST} resolves to ${resolved.join(', ') || 'nothing'}`
  )
  ok &&= resolvesHere

  // 3. Whether the boost answers there.
  const address = resolved.find((candidate) => isIP(candidate) === 4) ?? entry
  const status = address ? await fetchStatus(address) : null
  if (status) {
    const age = status.lastRequestAt
      ? `${Math.round((Date.now() - status.lastRequestAt) / 1000)} s ago`
      : 'never'
    const count = status.networks.length
    console.log(
      `OK Steam Boost answers at ${address}:80 over ${count} ${count === 1 ? 'network' : 'networks'}; Steam last asked ${age}`
    )
  } else {
    console.log(
      `!! Nothing answers as Steam Boost at ${address ?? '?'}:80 (is "steam-boost-cli start" running?)`
    )
    if (entry !== null) {
      console.log(
        '   Done with it? "hosts off" (administrator) takes the line out, so Steam stops looking here.'
      )
    }
    ok = false
  }

  // 4. What Steam itself says.
  const steamDir = await findSteamDir()
  const log = steamDir ? await readContentLogTail(steamDir) : null
  if (!log) {
    console.log(`?? Couldn't find Steam's content log${steamDir ? ` in ${steamDir}` : ''}.`)
  } else {
    const sightings = findCacheSightings(log)
    const last = sightings[sightings.length - 1]
    const usingThis = last !== undefined && last.address === address
    console.log(
      `${mark(usingThis)}Steam's log: ${last ? `enabled a cache at ${last.address}${last.at ? ` (${last.at})` : ''}` : 'no cache enabled since the log began'}`
    )
    for (const line of cacheLines(log, 3)) console.log(`     ${line.trim()}`)
    if (!usingThis) {
      ok = false
      console.log(
        '   Steam looks for a cache when it starts: exit Steam fully (Steam > Exit) and start it again.'
      )
      if (address === STEAM_BOOST_DEFAULT_ADDRESS) {
        console.log(
          '   If it still says nothing after a restart, it may not take a loopback address: run'
        )
        console.log('   "start --address lan" and "hosts on --address <that address>" instead.')
      }
    }
  }
  console.log(
    ok ? '\nAll set: Steam downloads go through the boost.' : '\nNot all set yet (see !! above).'
  )
}

async function startCommand(args: Args): Promise<void> {
  const all = await listActiveInterfaces()
  const wantedIds = flag(args, 'networks')
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  const picked = wantedIds
    ? all.filter((iface) => wantedIds.includes(iface.id))
    : await suggested(all)
  if (wantedIds) {
    const missing = wantedIds.filter((id) => !all.some((iface) => iface.id === id))
    if (missing.length > 0)
      throw new Error(`No network called ${missing.join(', ')} (see "networks").`)
  }
  if (picked.length === 0) throw new Error('No networks to use (see "networks").')
  const ids = new Set(picked.map((iface) => iface.id))
  const names = new Map(picked.map((iface) => [iface.id, iface.displayName]))
  if (args.flags.get('cap') === true) {
    throw new Error('--cap: write it as network=size, like "Ethernet 3=2GB".')
  }
  const capText = flag(args, 'cap')
  const caps = new DataCaps(capText === undefined ? undefined : parseCaps(capText))
  for (const id of caps.caps.keys()) {
    if (!ids.has(id)) {
      throw new Error(
        `--cap names ${id}, which this run doesn't use; it uses ${[...ids].join(', ')} (see "networks").`
      )
    }
  }
  const address = await resolveAddress(flag(args, 'address'), picked)
  const verbose = args.flags.has('verbose')

  // Linux needs koffi to pin a socket to its network (network/deviceBinding.ts); said once here,
  // in a line, rather than as the stack trace the app logs.
  const warn = console.warn
  console.warn = () => {}
  const pinned = await deviceBindingSupported().finally(() => (console.warn = warn))
  if (!pinned && picked.length > 1) {
    console.log(
      'Note: without the koffi package next to this file, Linux sends every connection out its default\n' +
        'route, so only one network carries traffic. Run "npm install koffi" in this folder to fix that.'
    )
  }

  // Closing the window takes the console away: a write that fails then mustn't stop the cleanup.
  process.stdout.on('error', () => {})
  const say = (line: string): void => {
    try {
      console.log(line)
    } catch {
      // Nowhere left to say it.
    }
  }
  const tty = process.stdout.isTTY && !verbose
  // What happened along the way: under the live table, or printed as it happens without one.
  const notes: string[] = []
  const note = (line: string): void => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`
    notes.push(stamped)
    if (notes.length > 4) notes.shift()
    if (!tty) say(stamped)
  }
  let timer: NodeJS.Timeout | undefined
  let hostsAdded = false
  let stopping = false

  // The networks as they come and go: one that drops out is let go of, and comes back on its own.
  // One that has used its cap is let go of for good.
  const monitor = new NetworkMonitor(() => {})
  await monitor.refresh()
  const boost = new SteamBoost({
    address,
    tlsPort: args.flags.has('no-https') ? null : 443,
    allowLan: args.flags.has('lan'),
    networks: () =>
      (monitor.current ?? []).filter((iface) => ids.has(iface.id) && !caps.isCapped(iface.id)),
    take: (networkId, bytes) => {
      if (caps.record(networkId, bytes)) capReached(networkId)
      return 0
    },
    onLog: verbose ? (line) => say(`[${new Date().toLocaleTimeString()}] ${line}`) : undefined
  })

  function capReached(id: string): void {
    note(
      `${names.get(id) ?? id} has used its ${gb(caps.capOf(id) ?? 0)} cap: not using it any more.`
    )
    if ([...ids].every((each) => caps.isCapped(each))) {
      note(
        'Every network has used its cap, so Steam Boost stops; Steam goes back to its own servers.'
      )
      setImmediate(stop)
    } else {
      // Outside the data handler that counted it: what it was fetching moves to the others.
      setImmediate(() => boost.refreshNetworks())
    }
  }

  /** Takes out the line --hosts added, at once (see setHostsEntrySync). Says what it did. */
  function takeOutHostsLine(): string | null {
    if (!hostsAdded) return null
    hostsAdded = false
    try {
      return setHostsEntrySync(null).message
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  function stop(): void {
    if (stopping) {
      // Pressed again: the hosts line is out already, so don't wait for the rest.
      process.exit(1)
    }
    stopping = true
    if (timer) clearInterval(timer)
    say('\nStopping…')
    const removed = takeOutHostsLine()
    if (removed) say(removed)
    const done = Promise.all([boost.stop(), removed ? flushDns() : undefined])
    // Windows ends a process about 10 s after its console window is closed: finish well inside that.
    void Promise.race([done, sleep(4000)]).finally(() => process.exit(0))
  }

  // Ctrl+C, a kill, the window closing (Windows sends SIGHUP for that) and Ctrl+Break.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => stop())
  }
  // Whatever else ends it, a crash included: the line doesn't outlive the boost.
  process.on('exit', () => {
    takeOutHostsLine()
  })

  await boost.start()
  if (args.flags.has('hosts')) {
    const { message, changed } = setHostsEntrySync(address)
    hostsAdded = true
    say(message)
    if (changed) await flushDns()
  }
  const listening = boost.listening()
  say(
    `Steam Boost listening on ${listening.http}${listening.tls ? ` (HTTPS pass-through on ${listening.tls})` : ''}, over: ${picked.map((iface) => `${iface.displayName} [${iface.id}]`).join(', ')}`
  )
  if (caps.caps.size > 0) {
    say(
      `Caps: ${[...caps.caps].map(([id, cap]) => `${names.get(id) ?? id} ${gb(cap)}`).join(', ')}, counted from now.`
    )
  }
  if (!hostsAdded) {
    say(
      `Steam finds it through the hosts file: "steam-boost-cli hosts on${address === STEAM_BOOST_DEFAULT_ADDRESS ? '' : ` --address ${address}`}" (administrator), then restart Steam.`
    )
  }
  say('Ctrl+C stops it.\n')

  let drawn = 0
  let lastPrinted = 0
  const draw = (): void => {
    const stats = boost.stats()
    const age = stats.lastRequestAt
      ? `${Math.round((Date.now() - stats.lastRequestAt) / 1000)}s ago`
      : 'not yet'
    // A network that has used its cap has left the boost, so it's no longer in its stats.
    const spent = [...ids].filter(
      (id) => caps.isCapped(id) && !stats.networks.some((network) => network.id === id)
    )
    const total = stats.bytesTotal + spent.reduce((sum, id) => sum + caps.usedBy(id), 0)
    const capNote = (id: string): string => {
      const cap = caps.capOf(id)
      return cap === undefined ? '' : ` | ${gb(caps.usedBy(id))} of ${gb(cap)} cap`
    }
    const lines = [
      `Steam last asked: ${age} | done ${stats.requests.done} | failed ${stats.requests.failed} | in flight ${stats.requests.active} | waiting ${stats.requests.waiting}`,
      `  ${pad('Total', 22)}${pad(mbps(stats.speedBytesPerSec), 13)}${gb(total)}`,
      ...stats.networks.map((network) => {
        const share =
          stats.speedBytesPerSec > 0 ? network.speedBytesPerSec / stats.speedBytesPerSec : 0
        const bar = '#'.repeat(Math.round(share * 20)).padEnd(20, '.')
        const state = network.resting ? ' (resting)' : ''
        const extra = network.tunnels > 0 ? ` ${network.tunnels} https` : ''
        return `  ${pad(network.label, 22)}${pad(mbps(network.speedBytesPerSec), 13)}${pad(gb(network.bytesTotal), 10)}[${bar}] ${network.inflight} in flight${extra}${state}${capNote(network.id)}`
      }),
      ...spent.map(
        (id) =>
          `  ${pad(names.get(id) ?? id, 22)}${pad('-', 13)}${pad(gb(caps.usedBy(id)), 10)}cap used up: not in use`
      )
    ]
    if (tty) {
      lines.push(...notes.map((line) => `  ${line}`))
      if (drawn > 0) process.stdout.write(`\x1b[${drawn}A`)
      for (const line of lines) process.stdout.write(`\x1b[2K${line}\n`)
      // What's left of a longer table before (a network that has gone) is cleared.
      if (lines.length < drawn) process.stdout.write('\x1b[J')
      drawn = lines.length
    } else if (Date.now() - lastPrinted >= 5000) {
      lastPrinted = Date.now()
      say(lines.join('\n'))
    }
  }
  if (!stopping) timer = setInterval(draw, 1000)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'networks':
      return networksCommand()
    case 'start':
      return startCommand(args)
    case 'check':
      return checkCommand()
    case 'hosts': {
      const action = args.rest[0]
      if (action === 'on') {
        const all = await listActiveInterfaces()
        console.log(
          await setHostsEntry(await resolveAddress(flag(args, 'address'), await suggested(all)))
        )
        console.log('Restart Steam (Steam > Exit, then open it again) so it picks this up.')
        return
      }
      if (action === 'off') {
        console.log(await setHostsEntry(null))
        return
      }
      throw new Error('Use "hosts on" or "hosts off".')
    }
    case 'version':
      console.log(VERSION)
      return
    default:
      console.log(args.flags.has('version') ? VERSION : HELP)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
