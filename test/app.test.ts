import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AppSettings, AppState } from '../src/shared/boost'
import type { NetworkInterfaceInfo } from '../src/shared/network'
import { BoostController } from '../src/main/boostController'
import { diagnosticsReport } from '../src/main/diagnostics'
import { listenAddress } from '../src/main/listenAddress'
import { friendlyName, friendlyNames, isVirtual } from '../src/main/network/names'
import { speedReport, systemName } from '../src/main/report'
import { DEFAULT_SETTINGS, sanitizeSettings, withNetwork, withSettings } from '../src/main/settings'
import { posixEditScript, windowsEditScript } from '../src/main/steam/elevatedHosts'
import {
  BEGIN_MARK,
  hasBlock,
  readEntry,
  withEntry,
  withoutEntry
} from '../src/main/steam/hostsFile'
import { restartSteam, tasklistHasSteam } from '../src/main/steamProcess'
import { checkForUpdate, isNewer } from '../src/main/updates'
import { dayKey, UsageBook } from '../src/main/usage'
import { loopbackNetwork, MB, runSteamClient, startMockCdn } from './fixtures'

// The app around the engine: settings, daily caps, Steam's process, updates, where it listens,
// and the controller that runs the engine the way the settings say.

// --- Settings ----------------------------------------------------------------------------------

test('settings come back whole from anything, keeping only what makes sense', () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(sanitizeSettings('nonsense'), DEFAULT_SETTINGS)
  const read = sanitizeSettings({
    enabled: false,
    addressMode: 'lan',
    httpsPassthrough: 'yes',
    startAtLogin: true,
    networks: {
      'Ethernet 3': { enabled: false, dailyCapBytes: 2.4 * MB },
      'Wi-Fi': { enabled: true, dailyCapBytes: -5 },
      junk: 'not an object',
      '': { enabled: false }
    },
    extra: 'dropped'
  })
  assert.equal(read.enabled, false)
  assert.equal(read.addressMode, 'lan')
  assert.equal(read.httpsPassthrough, true, 'a wrong type falls back to the default')
  assert.equal(read.startAtLogin, true)
  // Only what was set and makes sense is kept. On is kept too: a virtual adapter starts off.
  assert.deepEqual(read.networks, {
    'Ethernet 3': { enabled: false, dailyCapBytes: Math.round(2.4 * MB) },
    'Wi-Fi': { enabled: true }
  })
  assert.ok(!('extra' in read))
  assert.equal(sanitizeSettings({ addressMode: '10.0.0.1' }).addressMode, 'loopback')
})

test('a settings patch changes what it names; network patches set and clear caps', () => {
  const base: AppSettings = { ...DEFAULT_SETTINGS, networks: { phone: { dailyCapBytes: 100 } } }
  const patched = withSettings(base, {
    addressMode: 'lan',
    networks: { evil: {} }
  } as unknown as Partial<AppSettings>)
  assert.equal(patched.addressMode, 'lan')
  assert.deepEqual(patched.networks, base.networks, 'networks change only through withNetwork')

  const capped = withNetwork(base, 'wifi', { dailyCapBytes: 5 * MB })
  assert.deepEqual(capped.networks['wifi'], { dailyCapBytes: 5 * MB })
  const off = withNetwork(capped, 'phone', { enabled: false })
  assert.deepEqual(off.networks['phone'], { enabled: false, dailyCapBytes: 100 })
  const cleared = withNetwork(off, 'phone', { dailyCapBytes: null })
  assert.deepEqual(cleared.networks['phone'], { enabled: false })
  const on = withNetwork(cleared, 'phone', { enabled: true })
  assert.deepEqual(
    on.networks['phone'],
    { enabled: true },
    'switched on, which a VPN is not by itself'
  )
})

test('a network can be given a name of its own, kept to one tidy line', () => {
  const read = sanitizeSettings({
    networks: {
      'Ethernet 3': { name: "  Mum's\n  phone  " },
      'Wi-Fi': { name: 'x'.repeat(60) },
      'Wi-Fi 2': { name: `${'x'.repeat(39)}👍👍` },
      Ethernet: { name: '   ' },
      Other: { name: 42 }
    }
  })
  assert.deepEqual(read.networks, {
    'Ethernet 3': { name: "Mum's phone" },
    'Wi-Fi': { name: 'x'.repeat(40) },
    // Cut by character: the emoji at the end stays whole.
    'Wi-Fi 2': { name: `${'x'.repeat(39)}👍` }
  })
  const named = withNetwork(DEFAULT_SETTINGS, 'Ethernet 3', { name: 'Phone' })
  assert.deepEqual(named.networks['Ethernet 3'], { name: 'Phone' })
  assert.equal(withNetwork(named, 'Ethernet 3', { name: null }).networks['Ethernet 3'], undefined)
})

// --- Daily usage --------------------------------------------------------------------------------

test("usage counts each network's day, and starts again at midnight", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steam-boost-usage-'))
  try {
    let now = new Date(2026, 9, 26, 23, 59, 0)
    const path = join(dir, 'usage.json')
    const book = new UsageBook(path, () => now)
    assert.equal(book.add('phone', 300), 300)
    assert.equal(book.add('phone', 200), 500)
    book.add('wifi', 7)
    book.addSaved(90)
    book.addSaved(-5)
    await book.save()
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      day: '2026-10-26',
      bytes: { phone: 500, wifi: 7 },
      savedSeconds: 90
    })

    // The same day, read back after a restart.
    const again = await UsageBook.load(path, () => now)
    assert.equal(again.usedToday('phone'), 500)

    now = new Date(2026, 9, 27, 0, 0, 5)
    assert.equal(again.usedToday('phone'), 0, 'a new day')
    const nextDay = await UsageBook.load(path, () => now)
    assert.equal(nextDay.usedToday('phone'), 0, "yesterday's file isn't today's")
    assert.equal(nextDay.savedSeconds, 90, 'the time saved never starts again')
    assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- Steam's process ----------------------------------------------------------------------------

test("tasklist's answer is read in any language", () => {
  assert.equal(tasklistHasSteam('"steam.exe","1234","Console","1","45,000 K"\r\n'), true)
  assert.equal(
    tasklistHasSteam('INFO: No tasks are running which match the specified criteria.\r\n'),
    false
  )
  assert.equal(
    tasklistHasSteam('INFORMATION : aucune tâche ne correspond aux critères spécifiés.\r\n'),
    false
  )
  assert.equal(tasklistHasSteam('"steamwebhelper.exe","99","Console","1","10 K"'), false)
})

test('restarting Steam exits it, waits until it has gone, then starts it again', async () => {
  const opened: string[] = []
  let running = true
  let checks = 0
  let clock = 0
  const result = await restartSteam({
    openUrl: async (url) => {
      opened.push(url)
      if (url === 'steam://exit') running = true
    },
    isRunning: async () => {
      checks++
      // Still there for the first two looks after it was asked to exit.
      if (checks > 3) running = false
      return running
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock
  })
  assert.equal(result, 'restarted')
  assert.deepEqual(opened, ['steam://exit', 'steam://open/downloads'])

  const notRunning: string[] = []
  assert.equal(
    await restartSteam({
      openUrl: async (url) => void notRunning.push(url),
      isRunning: async () => false,
      sleep: async () => undefined
    }),
    'started'
  )
  assert.deepEqual(notRunning, ['steam://open/downloads'])

  clock = 0
  assert.equal(
    await restartSteam({
      openUrl: async () => undefined,
      isRunning: async () => true,
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock,
      timeoutMs: 5000
    }),
    'timeout'
  )

  assert.equal(
    await restartSteam({
      openUrl: async () => {
        throw new Error('no handler for steam://')
      },
      isRunning: async () => false,
      sleep: async () => undefined
    }),
    'failed'
  )
})

// --- Updates ----------------------------------------------------------------------------------

test('versions compare by number, and a release beats its pre-releases', () => {
  assert.equal(isNewer('v0.2.0', '0.1.9'), true)
  assert.equal(isNewer('0.10.0', '0.9.0'), true)
  assert.equal(isNewer('v0.1.0', '0.1.0'), false)
  assert.equal(isNewer('1.0.0', '1.0.0-rc.2'), true)
  assert.equal(isNewer('1.0.0-rc.2', '1.0.0'), false)
  assert.equal(isNewer('0.1.0', '0.2.0'), false)
})

test("the update check reads GitHub's latest release", async () => {
  const reply = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
  const found = await checkForUpdate(
    '0.1.0',
    reply({
      tag_name: 'v0.2.0',
      html_url: 'https://github.com/Abeey04/steam-boost/releases/tag/v0.2.0'
    })
  )
  assert.deepEqual(found, {
    version: '0.2.0',
    url: 'https://github.com/Abeey04/steam-boost/releases/tag/v0.2.0',
    install: null
  })
  assert.equal(await checkForUpdate('0.2.0', reply({ tag_name: 'v0.2.0' })), null)
  assert.equal(await checkForUpdate('0.1.0', reply({}, false)), null)
  // A link elsewhere isn't passed on to the window.
  const elsewhere = await checkForUpdate(
    '0.1.0',
    reply({ tag_name: 'v9.9.9', html_url: 'https://evil.example/download' })
  )
  assert.equal(elsewhere?.url, 'https://github.com/Abeey04/steam-boost/releases/latest')
})

// --- Where it listens ---------------------------------------------------------------------------

function network(
  id: string,
  address: string,
  kind: NetworkInterfaceInfo['kind'] = 'ethernet'
): NetworkInterfaceInfo {
  return { id, device: id, displayName: id, addresses: [{ address, family: 4 }], kind }
}

test("the LAN address is a Wi-Fi or Ethernet one before a phone's", () => {
  const phone = network('Ethernet 3', '192.168.42.17', 'usb')
  const wifi = network('Wi-Fi', '192.168.1.5', 'wifi')
  const vpn = network('Tailscale', '100.80.1.2', 'other')
  assert.equal(listenAddress('loopback', [phone, wifi], null), '127.0.0.1')
  assert.equal(listenAddress('lan', [phone, wifi, vpn], null), '192.168.1.5')
  assert.equal(listenAddress('lan', [phone], null), '192.168.42.17')
  // One with a way to the internet goes before one without.
  const lanOnly = network('Ethernet', '10.0.0.4')
  assert.equal(listenAddress('lan', [lanOnly, wifi], new Set(['Wi-Fi'])), '192.168.1.5')
  assert.equal(listenAddress('lan', [vpn], null), null)
})

// --- What networks are called -----------------------------------------------------------------

test('networks are called what they are, and two alike keep the names the OS gives them', () => {
  const adapter = (
    id: string,
    kind: NetworkInterfaceInfo['kind'],
    description?: string
  ): NetworkInterfaceInfo => ({ ...network(id, '192.168.0.2', kind), description })
  const cases: Array<[NetworkInterfaceInfo, string]> = [
    [
      adapter('Ethernet 3', 'usb', 'Remote NDIS based Internet Sharing Device'),
      'Phone (USB tethering)'
    ],
    [adapter('Ethernet 4', 'usb', 'Apple Mobile Device Ethernet'), 'iPhone (USB)'],
    [adapter('en6', 'usb', 'iPhone USB'), 'iPhone (USB)'],
    [adapter('Ethernet 5', 'usb', 'Realtek USB GbE Family Controller'), 'USB network adapter'],
    // Linux says what a device is called, not what it is.
    [adapter('enp0s20f0u1', 'usb'), 'Phone or USB adapter'],
    [adapter('WLAN', 'wifi', 'Intel(R) Wi-Fi 6 AX201 160MHz'), 'Wi-Fi'],
    [adapter('enp3s0', 'ethernet'), 'Ethernet'],
    [adapter('Tailscale', 'other', 'Tailscale Tunnel'), 'Tailscale']
  ]
  for (const [iface, name] of cases) assert.equal(friendlyName(iface), name, iface.id)
  const names = friendlyNames([
    adapter('Wi-Fi', 'wifi', 'Intel(R) Wi-Fi 6 AX201 160MHz'),
    adapter('Wi-Fi 2', 'wifi', 'TP-Link Wireless USB Adapter'),
    adapter('Ethernet 3', 'usb', 'Remote NDIS based Internet Sharing Device')
  ])
  assert.deepEqual([...names.values()], ['Wi-Fi', 'Wi-Fi 2', 'Phone (USB tethering)'])
})

// --- The hosts file -----------------------------------------------------------------------------

test("a block left by plexo's Steam boost is found, replaced and taken out like ours", () => {
  const plexoBlock = [
    '127.0.0.1 localhost',
    '',
    '# >>> plexo steam boost >>>',
    '127.0.0.1 lancache.steamcontent.com',
    '# <<< plexo steam boost <<<',
    ''
  ].join('\r\n')
  assert.equal(hasBlock(plexoBlock), true)
  assert.equal(readEntry(plexoBlock), '127.0.0.1')
  const replaced = withEntry(plexoBlock, '192.168.1.5')
  assert.ok(!replaced.includes('plexo steam boost'))
  assert.ok(replaced.includes(BEGIN_MARK))
  assert.equal(readEntry(replaced), '192.168.1.5')
  assert.equal(withoutEntry(plexoBlock), '127.0.0.1 localhost\r\n')
  assert.equal(hasBlock('127.0.0.1 localhost\n'), false)
})

// --- The controller -----------------------------------------------------------------------------

const fibre = loopbackNetwork('fibre', '127.0.0.2')
const phone = { ...loopbackNetwork('phone', '127.0.0.3'), kind: 'usb' as const }

function controllerFor(cdnPort: number, settings: { current: AppSettings }) {
  let hosts = '127.0.0.1 localhost\n'
  const usage = new UsageBook(null)
  const changes: number[] = []
  const controller = new BoostController({
    settings: () => settings.current,
    usage,
    networks: () => [fibre, phone],
    onChange: () => changes.push(Date.now()),
    log: () => undefined,
    defaultRoutes: async () => null,
    steamRunning: async () => false,
    steamDir: async () => null,
    resolveTrigger: async () => null,
    readHosts: async () => hosts,
    editHosts: async (address) => {
      hosts = address === null ? withoutEntry(hosts) : withEntry(hosts, address)
    },
    engine: {
      httpPort: 0,
      tlsPort: null,
      upstreamHttpPort: cdnPort,
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      stallTimeoutMs: 1500
    }
  })
  return { controller, usage, changes, hosts: () => hosts }
}

test('the controller runs the engine as the settings say, and points Steam at it', async () => {
  const cdn = await startMockCdn({ links: {} })
  const settings = { current: { ...DEFAULT_SETTINGS } }
  const { controller, hosts } = controllerFor(cdn.port, settings)
  try {
    await controller.start()
    let { boost, networks } = controller.current
    assert.equal(boost.state, 'on')
    assert.equal(boost.address, '127.0.0.1')
    assert.equal(boost.hostsEntry, 'missing')
    assert.deepEqual(
      networks.map((n) => [n.id, n.role]),
      [
        ['fibre', 'active'],
        ['phone', 'active']
      ]
    )

    await controller.setUp()
    assert.ok(hosts().includes(`${BEGIN_MARK}\n127.0.0.1 lancache.steamcontent.com`))
    assert.equal(controller.current.boost.hostsEntry, 'set')

    settings.current = withNetwork(settings.current, 'phone', { enabled: false })
    await controller.refreshNetworks()
    networks = controller.current.networks
    assert.deepEqual(
      networks.map((n) => [n.id, n.role]),
      [
        ['fibre', 'active'],
        ['phone', 'off']
      ]
    )

    settings.current = { ...settings.current, enabled: false }
    await controller.apply()
    boost = controller.current.boost
    assert.equal(boost.state, 'off')
    assert.equal(controller.listening(), null)

    await controller.tearDown()
    assert.equal(hosts(), '127.0.0.1 localhost\n')
    assert.equal(controller.current.boost.hostsEntry, 'missing')
  } finally {
    await controller.stop()
    await cdn.close()
  }
})

test('a network that uses its daily cap is let go of, and the others carry on', async (t) => {
  const cdn = await startMockCdn({
    links: {
      '127.0.0.2': { bytesPerSec: 6 * MB, latencyMs: 10 },
      '127.0.0.3': { bytesPerSec: 3 * MB, latencyMs: 10 }
    }
  })
  const cap = 4 * MB
  const settings = {
    current: withNetwork({ ...DEFAULT_SETTINGS }, 'phone', { dailyCapBytes: cap })
  }
  const { controller, usage } = controllerFor(cdn.port, settings)
  try {
    await controller.start()
    const port = Number(controller.listening()!.http!.split(':').pop())
    const result = await runSteamClient({ port, ids: cdn.ids, seconds: 5 })
    await sleep(50)
    const phoneUsed = usage.usedToday('phone')
    const fibreUsed = usage.usedToday('fibre')
    t.diagnostic(
      `phone ${(phoneUsed / MB).toFixed(1)} MB (cap 4 MB), fibre ${(fibreUsed / MB).toFixed(1)} MB, client ${(result.bytes / MB).toFixed(0)} MB`
    )
    assert.equal(result.corrupt, 0)
    assert.equal(result.errors, 0)
    assert.ok(phoneUsed >= cap, 'the phone was used up to its cap')
    // What was already arriving when it reached the cap is counted, and a little over.
    assert.ok(phoneUsed < cap + 3 * MB, `phone ${phoneUsed}`)
    assert.ok(fibreUsed > 15 * MB, `fibre ${fibreUsed}`)
    const phoneView = controller.current.networks.find((n) => n.id === 'phone')!
    assert.equal(phoneView.role, 'capped')
    assert.equal(phoneView.usedTodayBytes, phoneUsed)
  } finally {
    await controller.stop()
    await cdn.close()
  }
})

test('the controller says why it could not start, and starts once it can', async () => {
  const cdn = await startMockCdn({ links: {} })
  const settings: { current: AppSettings } = {
    current: { ...DEFAULT_SETTINGS, addressMode: 'lan' }
  }
  const { controller } = controllerFor(cdn.port, settings)
  try {
    // Loopback test networks have no LAN address to listen on.
    await controller.start()
    assert.equal(controller.current.boost.state, 'error')
    assert.match(controller.current.boost.error ?? '', /No LAN address/)
    settings.current = { ...settings.current, addressMode: 'loopback' }
    await controller.apply()
    assert.equal(controller.current.boost.state, 'on')
  } finally {
    await controller.stop()
    await cdn.close()
  }
})

test('before it starts, the controller can say whether the hosts file points Steam here', async () => {
  const hosts = `127.0.0.1 localhost\n${BEGIN_MARK}\n127.0.0.1 lancache.steamcontent.com\n# <<< Steam Boost <<<\n`
  const unstarted = (addressMode: AppSettings['addressMode']): BoostController =>
    new BoostController({
      settings: () => ({ ...DEFAULT_SETTINGS, addressMode }),
      usage: new UsageBook(null),
      // The OS's networks haven't been looked at yet.
      networks: () => null,
      onChange: () => undefined,
      log: () => undefined,
      defaultRoutes: async () => null,
      steamRunning: async () => false,
      steamDir: async () => null,
      resolveTrigger: async () => '127.0.0.1',
      readHosts: async () => hosts,
      editHosts: async () => undefined
    })
  const loopback = unstarted('loopback')
  await loopback.refresh()
  assert.equal(loopback.current.boost.state, 'off', 'not started')
  assert.equal(loopback.current.boost.hostsEntry, 'set')
  // A LAN address isn't known until the networks are: nothing to hold the file against yet.
  const lan = unstarted('lan')
  await lan.refresh()
  assert.equal(lan.current.boost.hostsEntry, 'unknown')
})

// --- Diagnostics -------------------------------------------------------------------------------

test('diagnostics hold the status, the networks, the hosts line and the logs', () => {
  const state: AppState = {
    version: '0.1.0',
    platform: 'win32',
    settings: DEFAULT_SETTINGS,
    boost: {
      state: 'on',
      address: '127.0.0.1',
      httpsPassthrough: true,
      hostsEntry: 'set',
      resolvesTo: '127.0.0.1',
      steamUsing: false,
      steamRunning: true,
      lastRequestAt: null,
      speedBytesPerSec: 0,
      sessionBytes: 0,
      requests: { active: 0, waiting: 0, done: 0, failed: 0 },
      hint: 'try-lan',
      download: null,
      savedSecondsTotal: 0
    },
    networks: [
      {
        id: 'Ethernet 3',
        label: 'Phone (USB tethering)',
        adapter: 'Ethernet 3',
        customName: null,
        kind: 'usb',
        virtual: false,
        address: '192.168.42.17',
        role: 'capped',
        enabled: true,
        dailyCapBytes: 2 * 1024 * MB,
        usedTodayBytes: 2 * 1024 * MB,
        speedBytesPerSec: 0,
        inflight: 0,
        resting: false
      }
    ],
    update: null,
    canStartAtLogin: true
  }
  const report = diagnosticsReport({
    state,
    hostsLines: ['127.0.0.1 lancache.steamcontent.com'],
    steamLog: null,
    recentLog: ['listening on 127.0.0.1:80']
  })
  for (const expected of [
    'Steam Boost 0.1.0 on win32',
    'hosts entry: set',
    'hint: try-lan',
    '- Phone (USB tethering) [Ethernet 3] usb 192.168.42.17: capped',
    '127.0.0.1 lancache.steamcontent.com',
    "couldn't find Steam's content_log.txt",
    'listening on 127.0.0.1:80'
  ]) {
    assert.ok(report.includes(expected), expected)
  }
})

test('after Steam restarts without taking 127.0.0.1, the LAN address is suggested', async () => {
  const cdn = await startMockCdn({ links: {} })
  const steamDir = mkdtempSync(join(tmpdir(), 'steam-boost-steam-'))
  mkdirSync(join(steamDir, 'logs'))
  // Steam started and logged its downloads, but never enabled a cache.
  writeFileSync(
    join(steamDir, 'logs', 'content_log.txt'),
    '[2026-10-26 09:00:00] AppID 570 update started : download 0/1024\n'
  )
  let hosts = `127.0.0.1 localhost\n${BEGIN_MARK}\n127.0.0.1 lancache.steamcontent.com\n# <<< Steam Boost <<<\n`
  const controller = new BoostController({
    settings: () => DEFAULT_SETTINGS,
    usage: new UsageBook(null),
    networks: () => [fibre],
    onChange: () => undefined,
    log: () => undefined,
    defaultRoutes: async () => null,
    steamRunning: async () => true,
    steamDir: async () => steamDir,
    resolveTrigger: async () => '127.0.0.1',
    readHosts: async () => hosts,
    editHosts: async (address) => {
      hosts = address === null ? withoutEntry(hosts) : withEntry(hosts, address)
    },
    engine: { httpPort: 0, tlsPort: null, upstreamHttpPort: cdn.port }
  })
  try {
    await controller.start()
    assert.equal(controller.current.boost.hostsEntry, 'set')
    assert.equal(controller.current.boost.steamUsing, false)
    // Just restarted: Steam gets time to find the cache first.
    controller.noteSteamRestart(Date.now())
    await controller.refresh()
    assert.equal(controller.current.boost.hint, null)
    controller.noteSteamRestart(Date.now() - 60_000)
    await controller.refresh()
    assert.equal(controller.current.boost.hint, 'try-lan')
  } finally {
    await controller.stop()
    await cdn.close()
    rmSync(steamDir, { recursive: true, force: true })
  }
})

// --- Editing the hosts file behind the administrator prompt ------------------------------------

/** Hosts files to edit, and the address to point Steam at (null: take the block out). */
const HOSTS_CASES: Array<[string, string, string | null]> = [
  ['Windows line endings', '127.0.0.1 localhost\r\n::1 localhost\r\n', '127.0.0.1'],
  ['blank lines at the end', '127.0.0.1 localhost\n\n\n', '192.168.1.5'],
  [
    'a block of ours, a line after it',
    `127.0.0.1 localhost\n${BEGIN_MARK}\n127.0.0.1 lancache.steamcontent.com\n# <<< Steam Boost <<<\n\n10.0.0.9 nas\n`,
    '10.0.0.2'
  ],
  [
    "plexo's block, taken out",
    '127.0.0.1 localhost\r\n# >>> plexo steam boost >>>\r\n127.0.0.1 lancache.steamcontent.com\r\n# <<< plexo steam boost <<<\r\n',
    null
  ],
  ['an empty file', '', '127.0.0.1'],
  ['no newline at the end', '127.0.0.1 localhost', null],
  ['lines of spaces inside', '127.0.0.1 a\n   \n127.0.0.1 b\n  \n', '127.0.0.1']
]

/** Runs an edit on each case's file and checks it gives what withEntry and withoutEntry do. */
function checkHostsEdits(run: (path: string, address: string | null) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'steam-boost-hosts-'))
  try {
    for (const [what, text, address] of HOSTS_CASES) {
      const path = join(dir, 'hosts')
      writeFileSync(path, text)
      run(path, address)
      const expected = address === null ? withoutEntry(text) : withEntry(text, address)
      assert.equal(readFileSync(path, 'utf8'), expected, what)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test(
  'the elevated edit on Windows changes the hosts file as the app would',
  { skip: process.platform !== 'win32' && 'PowerShell runs on Windows' },
  () => {
    checkHostsEdits((path, address) => {
      const encoded = Buffer.from(windowsEditScript(path, address), 'utf16le').toString('base64')
      const { status, stderr } = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { encoding: 'utf8' }
      )
      assert.equal(status, 0, stderr)
    })
  }
)

test(
  'the elevated edit on macOS and Linux changes the hosts file as the app would',
  { skip: process.platform === 'win32' && 'a POSIX shell runs on macOS and Linux' },
  () => {
    checkHostsEdits((path, address) => {
      const { status, stderr } = spawnSync('/bin/sh', ['-c', posixEditScript(path, address)], {
        encoding: 'utf8'
      })
      assert.equal(status, 0, stderr)
    })
  }
)

test('only an IP address goes into a script that runs as administrator', () => {
  assert.throws(() => windowsEditScript('hosts', "1.2.3.4'; Remove-Item C:\\"), /isn't an IP/)
  assert.throws(() => posixEditScript('/etc/hosts', '$(reboot)'), /isn't an IP/)
})

// --- Virtual adapters ---------------------------------------------------------------------------

test("virtual machines', containers' and VPNs' adapters are told apart, and start off", async () => {
  const cases: Array<[string, string | undefined, boolean]> = [
    ['vEthernet (WSL)', 'Hyper-V Virtual Ethernet Adapter', true],
    ['Ethernet 2', 'TAP-Windows Adapter V9', true],
    ['VirtualBox Host-Only Network', 'VirtualBox Host-Only Ethernet Adapter', true],
    ['VMware Network Adapter VMnet8', 'VMware Virtual Ethernet Adapter for VMnet8', true],
    ['Tailscale', 'Tailscale Tunnel', true],
    ['ZeroTier One', 'ZeroTier Virtual Port', true],
    ['utun3', undefined, true],
    ['wg0', undefined, true],
    ['docker0', undefined, true],
    ['Wi-Fi', 'Intel(R) Wi-Fi 6E AX211 160MHz', false],
    ['Ethernet', 'Realtek PCIe 2.5GbE Family Controller', false],
    ['Ethernet 3', 'Remote NDIS based Internet Sharing Device', false],
    ['enp0s20f0u1', undefined, false],
    // A mobile broadband modem is a line of its own.
    ['ppp0', undefined, false]
  ]
  for (const [name, description, virtual] of cases) {
    assert.equal(isVirtual({ device: name, displayName: name, description }), virtual, name)
  }
  // A WSL switch says it's Ethernet; it keeps its own name, and its address is the last listened on.
  const wsl: NetworkInterfaceInfo = {
    ...network('vEthernet (WSL)', '172.20.0.1', 'ethernet'),
    description: 'Hyper-V Virtual Ethernet Adapter',
    virtual: true
  }
  assert.equal(friendlyName(wsl), 'vEthernet (WSL)')
  assert.equal(
    listenAddress('lan', [wsl, network('Wi-Fi', '192.168.1.5', 'wifi')], null),
    '192.168.1.5'
  )

  const vpn: NetworkInterfaceInfo = { ...loopbackNetwork('vpn', '127.0.0.4'), virtual: true }
  const settings = { current: { ...DEFAULT_SETTINGS } }
  const controller = new BoostController({
    settings: () => settings.current,
    usage: new UsageBook(null),
    networks: () => [fibre, vpn],
    onChange: () => undefined,
    log: () => undefined,
    defaultRoutes: async () => null,
    steamRunning: async () => false,
    steamDir: async () => null,
    resolveTrigger: async () => null,
    readHosts: async () => '',
    editHosts: async () => undefined
  })
  await controller.refresh()
  const view = () => controller.current.networks.find((n) => n.id === 'vpn')
  assert.equal(view()?.virtual, true)
  assert.equal(view()?.enabled, false)
  assert.equal(view()?.role, 'off')
  settings.current = withNetwork(settings.current, 'vpn', { enabled: true })
  await controller.refresh()
  assert.equal(view()?.role, 'active', 'on once switched on')
})

// --- A port that's taken -------------------------------------------------------------------------

test('when another program has the port, the window says which one, and what to do', async () => {
  const blocker = createServer().listen(0, '127.0.0.1')
  await once(blocker, 'listening')
  const port = (blocker.address() as AddressInfo).port
  let asked = 0
  const controller = new BoostController({
    settings: () => DEFAULT_SETTINGS,
    usage: new UsageBook(null),
    networks: () => [fibre],
    onChange: () => undefined,
    log: () => undefined,
    defaultRoutes: async () => null,
    steamRunning: async () => false,
    steamDir: async () => null,
    resolveTrigger: async () => null,
    readHosts: async () => '',
    editHosts: async () => undefined,
    portOwner: async (taken) => {
      asked++
      assert.equal(taken, port)
      return { pid: 4242, process: 'httpd', service: null, serviceName: null }
    },
    engine: { httpPort: port, tlsPort: null }
  })
  try {
    await controller.start()
    assert.equal(controller.current.boost.state, 'error')
    assert.match(
      controller.current.boost.error ?? '',
      new RegExp(`^Apache \\(httpd\\) is using port ${port}`)
    )
    // Trying again soon after doesn't look the program up again.
    await controller.apply(true)
    assert.equal(asked, 1)
    assert.match(controller.current.boost.error ?? '', /Apache/)
  } finally {
    await controller.stop()
    blocker.close()
  }
})

// --- The game, and the time saved ----------------------------------------------------------------

test('the game Steam is downloading is named and followed, and the time saved counted', async (t) => {
  const cdn = await startMockCdn({
    links: {
      '127.0.0.2': { bytesPerSec: 6 * MB, latencyMs: 10 },
      '127.0.0.3': { bytesPerSec: 3 * MB, latencyMs: 10 }
    }
  })
  const steamDir = mkdtempSync(join(tmpdir(), 'steam-boost-steam-'))
  mkdirSync(join(steamDir, 'logs'))
  mkdirSync(join(steamDir, 'steamapps'))
  const total = 400 * MB
  writeFileSync(
    join(steamDir, 'steamapps', 'appmanifest_570.acf'),
    `"AppState"\n{\n\t"appid"\t\t"570"\n\t"name"\t\t"Dota 2"\n\t"BytesToDownload"\t\t"${total}"\n\t"BytesDownloaded"\t\t"0"\n}\n`
  )
  const log = join(steamDir, 'logs', 'content_log.txt')
  writeFileSync(
    log,
    `[2026-10-29 10:00:00] AppID 570 update started : download 0/${total}, store 0/0, reuse 0/0, delta 0/0, stage 0/0\n` +
      '[2026-10-29 10:00:00] AppID 570 App update changed : Running Update,Downloading,\n'
  )
  const usage = new UsageBook(null)
  const controller = new BoostController({
    settings: () => DEFAULT_SETTINGS,
    usage,
    networks: () => [fibre, phone],
    onChange: () => undefined,
    log: () => undefined,
    defaultRoutes: async () => null,
    steamRunning: async () => true,
    steamDir: async () => steamDir,
    resolveTrigger: async () => null,
    readHosts: async () => '',
    editHosts: async () => undefined,
    engine: {
      httpPort: 0,
      tlsPort: null,
      upstreamHttpPort: cdn.port,
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      stallTimeoutMs: 1500
    }
  })
  try {
    await controller.start()
    const port = Number(controller.listening()!.http!.split(':').pop())
    const result = await runSteamClient({ port, ids: cdn.ids, seconds: 5 })
    await controller.refresh()
    const { download } = controller.current.boost
    t.diagnostic(
      `carried ${(result.bytes / MB).toFixed(0)} MB, ${download?.downloadedBytes} of ${download?.totalBytes}; saved ${usage.savedSeconds.toFixed(2)} s`
    )
    assert.equal(download?.appId, 570)
    assert.equal(download?.name, 'Dota 2')
    assert.equal(download?.totalBytes, total)
    assert.ok(download.downloadedBytes > 0 && download.downloadedBytes <= total)
    // Both connections carried at once: Wi-Fi alone would have taken longer.
    assert.ok(usage.savedSeconds > 0, `saved ${usage.savedSeconds}`)

    appendFileSync(log, '[2026-10-29 10:05:00] AppID 570 App update changed : None\n')
    await controller.refresh()
    assert.equal(controller.current.boost.download, null, 'done, or paused: no game')
  } finally {
    await controller.stop()
    await cdn.close()
    rmSync(steamDir, { recursive: true, force: true })
  }
})

// --- Tell us how it went -------------------------------------------------------------------------

test('"Tell us how it went" fills in a speed report, without addresses', () => {
  const view = (
    id: string,
    label: string,
    address: string,
    speedBytesPerSec = 0
  ): AppState['networks'][number] => ({
    id,
    label,
    adapter: id,
    customName: null,
    kind: 'wifi',
    virtual: false,
    address,
    role: 'active',
    enabled: true,
    dailyCapBytes: null,
    usedTodayBytes: 0,
    speedBytesPerSec,
    inflight: 0,
    resting: false
  })
  const state: AppState = {
    version: '0.2.2',
    platform: 'win32',
    settings: DEFAULT_SETTINGS,
    boost: {
      state: 'on',
      address: '127.0.0.1',
      httpsPassthrough: true,
      hostsEntry: 'set',
      resolvesTo: '127.0.0.1',
      steamUsing: true,
      steamRunning: true,
      lastRequestAt: Date.now(),
      speedBytesPerSec: 0,
      sessionBytes: 0,
      requests: { active: 0, waiting: 0, done: 0, failed: 0 },
      hint: null,
      download: null,
      savedSecondsTotal: 75 * 60
    },
    networks: [
      view('Wi-Fi', 'Wi-Fi', '192.168.1.5', 6.2 * MB),
      view('Ethernet 3', 'Phone (USB tethering)', '192.168.42.17', 2.5 * MB)
    ],
    update: null,
    canStartAtLogin: true
  }
  assert.equal(systemName('win32', '10.0.26200', 'x64'), 'Windows 11 (build 26200, x64)')
  assert.equal(systemName('win32', '10.0.19045', 'x64'), 'Windows 10 (build 19045, x64)')
  const report = speedReport(state, systemName('win32', '10.0.26200', 'x64'))
  assert.equal(
    report,
    [
      '- **Connections:** Wi-Fi + Phone (USB tethering)',
      '- **Windows version:** Windows 11 (build 26200, x64)',
      "- **Steam's download speed without and with Steam Boost:** about 6.2 MB/s on Wi-Fi alone, 8.7 MB/s with Steam Boost (as Steam Boost measured them)",
      '- **Anything that got in the way:** ',
      '',
      'Steam Boost 0.2.2, 1 h 15 min saved so far',
      ''
    ].join('\n')
  )
  assert.ok(!report.includes('192.168'), 'no local address in it')
  // Nothing downloading: the speeds are for the person to fill in.
  const idle = {
    ...state,
    networks: state.networks.map((network) => ({ ...network, speedBytesPerSec: 0 }))
  }
  assert.match(speedReport(idle, 'Linux'), /Steam Boost:\*\* \n/)
})
