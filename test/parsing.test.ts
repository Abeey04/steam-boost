import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { connect as tlsConnect } from 'node:tls'
import {
  cacheLines,
  findCacheSightings,
  normalizeLoggedAddress,
  steamDirCandidates
} from '../src/main/steam/contentLog'
import {
  BEGIN_MARK,
  END_MARK,
  hostsFilePath,
  otherEntries,
  readEntry,
  withEntry,
  withoutEntry
} from '../src/main/steam/hostsFile'
import {
  isSteamHost,
  judgeRequest,
  parseHostHeader,
  rangeLength,
  STEAM_USER_AGENT,
  TRIGGER_HOST
} from '../src/main/steam/steamHosts'
import { readServerName } from '../src/main/steam/tlsSni'
import {
  parseNetstatDefaults,
  parseProcNetRoute,
  parseRoutePrint
} from '../src/main/steam/defaultRoutes'
import { currentDownload, libraryPaths, parseAppManifest, parseVdf } from '../src/main/steam/games'
import {
  describePortOwner,
  parseLsof,
  parseSs,
  parseWindowsOwner,
  type PortOwner
} from '../src/main/steam/portOwner'
import { DataCaps, flag, parseArgs, parseCaps, parseSize } from '../src/cli/args'

// --- Which requests are forwarded -----------------------------------------------------------

const steamRequest = {
  method: 'GET',
  hostHeader: 'cache12-lhr1.steamcontent.com',
  path: '/depot/228983/chunk/664e2e318c697aa4f47e4bf517c0b9d682fb43d8',
  userAgent: STEAM_USER_AGENT
}

test("Steam's chunk requests go on to the content server they name, over HTTP on port 80", () => {
  assert.deepEqual(judgeRequest(steamRequest), {
    forward: true,
    target: { host: 'cache12-lhr1.steamcontent.com', port: 80, secure: false }
  })
})

test('a Host naming port 443 goes on over HTTPS', () => {
  const verdict = judgeRequest({ ...steamRequest, hostHeader: 'cache4-ord1.steamcontent.com:443' })
  assert.deepEqual(verdict, {
    forward: true,
    target: { host: 'cache4-ord1.steamcontent.com', port: 443, secure: true }
  })
})

test('a request for the trigger name itself is a loop', () => {
  const verdict = judgeRequest({ ...steamRequest, hostHeader: TRIGGER_HOST })
  assert.equal(verdict.forward, false)
  assert.equal(!verdict.forward && verdict.status, 508)
})

test('other hosts are refused unless the request is plainly Steam asking for content', () => {
  const browserRequest = {
    method: 'GET',
    hostHeader: 'example.com',
    path: '/',
    userAgent: 'Mozilla/5.0'
  }
  const browser = judgeRequest(browserRequest)
  assert.equal(!browser.forward && browser.status, 403)
  // An ISP's own Steam cache has a name of its own.
  const ispCache = judgeRequest({ ...steamRequest, hostHeader: 'steam.cache.isp.example' })
  assert.equal(ispCache.forward, true)
  // Steam's agent on a path no content server serves is still refused.
  const elsewhere = judgeRequest({ ...steamRequest, hostHeader: 'example.com', path: '/admin' })
  assert.equal(!elsewhere.forward && elsewhere.status, 403)
  assert.equal(judgeRequest(browserRequest, { anyHost: true }).forward, true)
})

test('only GET and HEAD are forwarded', () => {
  const post = judgeRequest({ ...steamRequest, method: 'POST' })
  assert.equal(!post.forward && post.status, 405)
  assert.equal(judgeRequest({ ...steamRequest, method: 'HEAD' }).forward, true)
})

test('Steam content hosts are recognised, and only those', () => {
  for (const host of [
    'cache1-sin1.steamcontent.com',
    'steamcontent.com',
    'steampipe.akamaized.net',
    'steampipe-kr.akamaized.net',
    'cdn.akamai.steamstatic.com',
    'st.dl.eccdnx.com'
  ]) {
    assert.ok(isSteamHost(host), host)
  }
  for (const host of [
    'evilsteamcontent.com',
    'steamcontent.com.evil.net',
    'akamaized.net',
    'x.akamaized.net'
  ]) {
    assert.ok(!isSteamHost(host), host)
  }
  assert.ok(isSteamHost('cdn.example.net', ['.example.net']))
  assert.ok(isSteamHost('example.net', ['.example.net']))
  assert.ok(!isSteamHost('badexample.net', ['.example.net']))
})

test('Host headers are parsed, ports and all, and junk is turned away', () => {
  assert.deepEqual(parseHostHeader('Cache1-SIN1.steamcontent.com.'), {
    host: 'cache1-sin1.steamcontent.com',
    port: null
  })
  assert.deepEqual(parseHostHeader('10.0.0.5:8080'), { host: '10.0.0.5', port: 8080 })
  assert.deepEqual(parseHostHeader('[2001:db8::1]:80'), { host: '2001:db8::1', port: 80 })
  for (const junk of [undefined, '', 'a b', 'host:99999', 'host:0', '..', 'a..b', 'x/y']) {
    assert.equal(parseHostHeader(junk), null, String(junk))
  }
})

test('a bounded Range gives the size of the request', () => {
  assert.equal(rangeLength('bytes=0-1048575'), 1048576)
  assert.equal(rangeLength('bytes=1048576-2097151'), 1048576)
  assert.equal(rangeLength('bytes=100-'), null)
  assert.equal(rangeLength('bytes=0-1,5-9'), null)
  assert.equal(rangeLength(undefined), null)
})

// --- TLS server names ---------------------------------------------------------------------

/** The first bytes a real TLS client sends, as Node's TLS stack makes them. */
async function clientHello(servername?: string): Promise<Buffer> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const got = new Promise<Buffer>((resolve) => {
    server.once('connection', (socket) => {
      socket.once('data', (data: Buffer) => {
        resolve(data)
        socket.destroy()
      })
    })
  })
  const client = tlsConnect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false })
  client.on('error', () => {})
  const hello = await got
  client.destroy()
  server.close()
  return hello
}

test('the server name is read out of a real ClientHello', async () => {
  const hello = await clientHello('cache5-bom1.steamcontent.com')
  assert.deepEqual(readServerName(hello), {
    kind: 'hello',
    serverName: 'cache5-bom1.steamcontent.com'
  })
})

test('a ClientHello is incomplete until all of it has come, whatever the split', async () => {
  const hello = await clientHello('cache5-bom1.steamcontent.com')
  for (const cut of [1, 5, 9, 43, hello.length - 1]) {
    assert.deepEqual(
      readServerName(hello.subarray(0, cut)),
      { kind: 'incomplete' },
      `cut at ${cut}`
    )
  }
})

test('a ClientHello split over two TLS records is joined', async () => {
  const hello = await clientHello('steampipe.akamaized.net')
  const body = hello.subarray(5)
  const half = Math.floor(body.length / 2)
  const record = (part: Buffer): Buffer =>
    Buffer.concat([Buffer.from([0x16, 0x03, 0x01, part.length >> 8, part.length & 0xff]), part])
  const split = Buffer.concat([record(body.subarray(0, half)), record(body.subarray(half))])
  assert.deepEqual(readServerName(split), { kind: 'hello', serverName: 'steampipe.akamaized.net' })
})

test('a hello without a name, and bytes that are not TLS, are told apart', async () => {
  // Node leaves the name out for an IP address.
  assert.deepEqual(readServerName(await clientHello()), { kind: 'hello', serverName: null })
  assert.equal(readServerName(Buffer.from('GET / HTTP/1.1\r\n\r\n')).kind, 'invalid')
  assert.equal(readServerName(Buffer.from([0x16, 0x02, 0x00, 0x00, 0x10])).kind, 'invalid')
})

// --- The hosts file -------------------------------------------------------------------------

const windowsHosts = [
  '# Copyright (c) 1993-2009 Microsoft Corp.',
  '#',
  '# localhost name resolution is handled within DNS itself.',
  '#\t127.0.0.1       localhost',
  '192.168.1.20 nas.local',
  ''
].join('\r\n')

test('the entry is added between its markers, keeping Windows line endings', () => {
  const added = withEntry(windowsHosts, '127.0.0.1')
  assert.ok(added.includes(`\r\n${BEGIN_MARK}\r\n127.0.0.1 ${TRIGGER_HOST}\r\n${END_MARK}\r\n`))
  assert.ok(!/[^\r]\n/.test(added), 'every line ends in CRLF')
  assert.equal(readEntry(added), '127.0.0.1')
  assert.ok(added.startsWith('# Copyright (c) 1993-2009 Microsoft Corp.\r\n'))
})

test('adding again replaces the entry rather than adding a second', () => {
  const twice = withEntry(withEntry(windowsHosts, '127.0.0.1'), '192.168.1.5')
  assert.equal(twice.split(BEGIN_MARK).length, 2)
  assert.equal(readEntry(twice), '192.168.1.5')
})

test('removing the entry gives back the file as it was', () => {
  assert.equal(withoutEntry(withEntry(windowsHosts, '127.0.0.1')), windowsHosts)
  const unix = '127.0.0.1 localhost\n::1 localhost\n'
  assert.equal(withoutEntry(withEntry(unix, '127.0.0.1')), unix)
  assert.equal(readEntry(unix), null)
})

test('a line of its own for the trigger name, outside the block, is found', () => {
  const other = `${windowsHosts}10.0.0.9 ${TRIGGER_HOST} # my real lancache\r\n`
  assert.deepEqual(otherEntries(withEntry(other, '127.0.0.1')), ['10.0.0.9'])
  assert.deepEqual(otherEntries(withEntry(windowsHosts, '127.0.0.1')), [])
})

test('the hosts file is where each OS keeps it', () => {
  assert.equal(
    hostsFilePath('win32', { SystemRoot: 'C:\\Windows' }),
    'C:\\Windows\\System32\\drivers\\etc\\hosts'
  )
  assert.equal(hostsFilePath('darwin', {}), '/etc/hosts')
  assert.equal(hostsFilePath('linux', {}), '/etc/hosts')
})

// --- Steam's content log --------------------------------------------------------------------

const log = [
  '[2019-12-21 17:15:12] Client version: 1576019640',
  `[2019-12-21 17:15:14] Enabling local content cache at '::ffff:c0a8:1e80' from lookup of ${TRIGGER_HOST}.`,
  "[2019-12-21 17:15:14] Adding cache type 'LANCache' on host '::ffff:c0a8:1e80'",
  `[2026-10-25 21:02:00] Enabling local content cache at '::ffff:7f00:1' from lookup of ${TRIGGER_HOST}.`,
  `[2026-10-25 21:05:00] Enabling local content cache at '::ffff:127.0.0.1' from lookup of ${TRIGGER_HOST}.`
].join('\r\n')

test('each time Steam enabled a cache is found, with where and when', () => {
  assert.deepEqual(findCacheSightings(log), [
    { at: '2019-12-21 17:15:14', address: '192.168.30.128' },
    { at: '2026-10-25 21:02:00', address: '127.0.0.1' },
    { at: '2026-10-25 21:05:00', address: '127.0.0.1' }
  ])
  assert.equal(cacheLines(log).length, 4)
})

test('IPv4-mapped addresses are shown as IPv4', () => {
  assert.equal(normalizeLoggedAddress('::ffff:c0a8:1e80'), '192.168.30.128')
  assert.equal(normalizeLoggedAddress('::ffff:7f00:1'), '127.0.0.1')
  assert.equal(normalizeLoggedAddress('::FFFF:10.0.0.4'), '10.0.0.4')
  assert.equal(normalizeLoggedAddress('fd00::4'), 'fd00::4')
})

test('Steam is looked for where each OS installs it', () => {
  const windows = steamDirCandidates(
    'win32',
    { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    'C:\\Users\\a'
  )
  // Each OS's paths as that OS writes them, whichever OS the tests run on.
  assert.equal(windows[0], 'C:\\Program Files (x86)\\Steam')
  assert.deepEqual(steamDirCandidates('darwin', {}, '/Users/a'), [
    '/Users/a/Library/Application Support/Steam'
  ])
  assert.ok(steamDirCandidates('linux', {}, '/home/a').includes('/home/a/.local/share/Steam'))
})

// --- The command line -------------------------------------------------------------------------

test('flags take a value after a space or an "=", and a --cap value keeps its own "="', () => {
  const args = parseArgs([
    'start',
    '--cap=Ethernet 3=2GB',
    '--networks',
    'Wi-Fi,Ethernet 3',
    '--hosts'
  ])
  assert.equal(args.command, 'start')
  assert.equal(flag(args, 'cap'), 'Ethernet 3=2GB')
  assert.equal(flag(args, 'networks'), 'Wi-Fi,Ethernet 3')
  assert.equal(args.flags.get('hosts'), true)
  assert.equal(flag(parseArgs(['start', '--cap', 'Ethernet 3=500MB']), 'cap'), 'Ethernet 3=500MB')
  // A flag that wants a value but is followed by another flag is left without one.
  assert.equal(parseArgs(['start', '--cap', '--hosts']).flags.get('cap'), true)
  assert.equal(parseArgs([]).command, 'help')
})

test('sizes read the way people write them, in the units the live table shows', () => {
  assert.equal(parseSize('2GB'), 2 * 1024 ** 3)
  assert.equal(parseSize('1.5 g'), 1.5 * 1024 ** 3)
  assert.equal(parseSize('500MB'), 500 * 1024 ** 2)
  assert.equal(parseSize('2 GiB'), 2 * 1024 ** 3)
  assert.equal(parseSize('3'), 3 * 1024 ** 3)
  for (const bad of ['', 'GB', 'two GB', '-1GB', '0', '2 GBs']) {
    assert.throws(() => parseSize(bad), /size|nothing/, bad)
  }
})

test('a cap names a network and a size; names may hold spaces', () => {
  assert.deepEqual(
    [...parseCaps('Ethernet 3=2GB, Wi-Fi=500MB')],
    [
      ['Ethernet 3', 2 * 1024 ** 3],
      ['Wi-Fi', 500 * 1024 ** 2]
    ]
  )
  for (const bad of ['', ',', '2GB', '=2GB', 'Ethernet 3', 'Ethernet 3=lots']) {
    assert.throws(() => parseCaps(bad), /--cap|size/, bad)
  }
})

test('a network is held to its cap once, counting every byte it carried', () => {
  const caps = new DataCaps(new Map([['phone', 100]]))
  assert.equal(caps.record('phone', 60), false)
  assert.equal(caps.record('wifi', 1000), false)
  assert.equal(caps.isCapped('phone'), false)
  assert.equal(caps.record('phone', 40), true)
  assert.equal(caps.isCapped('phone'), true)
  // What was still on its way when it was let go of is counted, but it's capped only once.
  assert.equal(caps.record('phone', 10), false)
  assert.equal(caps.usedBy('phone'), 110)
  assert.equal(caps.isCapped('wifi'), false)
  assert.equal(caps.usedBy('wifi'), 1000)
  assert.equal(caps.capOf('wifi'), undefined)
})

// --- Which networks reach the internet ------------------------------------------------------

test("Windows' default routes are read from route print, in any language", () => {
  const english = [
    'IPv4 Route Table',
    '===========================================================================',
    'Active Routes:',
    'Network Destination        Netmask          Gateway       Interface  Metric',
    '          0.0.0.0          0.0.0.0      192.168.1.1      192.168.1.4     40',
    '          0.0.0.0          0.0.0.0   192.168.42.129   192.168.42.17     25',
    '        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331',
    '      192.168.1.0    255.255.255.0         On-link       192.168.1.4    296',
    '===========================================================================',
    'Persistent Routes:',
    '  Network Address          Netmask  Gateway Address  Metric',
    '          0.0.0.0          0.0.0.0         10.0.0.1  Default',
    ''
  ].join('\r\n')
  assert.deepEqual(parseRoutePrint(english), ['192.168.1.4', '192.168.42.17'])
  // A VPN's default route goes out "on-link"; the headers are in German here.
  const german = [
    'Aktive Routen:',
    '     Netzwerkziel    Netzwerkmaske          Gateway    Schnittstelle Metrik',
    '          0.0.0.0          0.0.0.0          Auf Verbindung       10.8.0.2     35',
    '          0.0.0.0          0.0.0.0          On-link       10.8.0.6     35'
  ].join('\r\n')
  assert.deepEqual(parseRoutePrint(german), ['10.8.0.6'])
})

test('Linux and macOS default routes are read from the kernel and netstat', () => {
  const procNetRoute = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'wlp2s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
    'wlp2s0\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0',
    'usb0\t00000000\t812AA8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0'
  ].join('\n')
  assert.deepEqual(parseProcNetRoute(procNetRoute), ['wlp2s0', 'usb0'])
  const netstat = [
    'Routing tables',
    '',
    'Internet:',
    'Destination        Gateway            Flags               Netif Expire',
    'default            192.168.1.1        UGScg                 en0',
    'default            172.20.10.1        UGScIg                en7',
    '127                127.0.0.1          UCS                   lo0'
  ].join('\n')
  assert.deepEqual(parseNetstatDefaults(netstat), ['en0', 'en7'])
})

// --- Steam's own files: the game being downloaded --------------------------------------------

test("Steam's library list is read, old layout and new, each folder once", () => {
  const current = parseVdf(
    [
      '"libraryfolders"',
      '{',
      '\t"0"',
      '\t{',
      '\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"',
      '\t\t"apps"',
      '\t\t{',
      '\t\t\t"228980"\t\t"25674515"',
      '\t\t}',
      '\t}',
      '\t"1"',
      '\t{',
      '\t\t"path"\t\t"D:\\\\SteamLibrary"',
      '\t}',
      '}'
    ].join('\n')
  )
  assert.deepEqual(libraryPaths(current, 'c:/program files (x86)/steam'), [
    'c:/program files (x86)/steam',
    'D:\\SteamLibrary'
  ])
  const older = parseVdf(
    '"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t\t"1700000000"\n\t"1"\t\t"E:\\\\Games\\\\Steam"\n}\n'
  )
  assert.deepEqual(libraryPaths(older, '/home/me/.steam/steam'), [
    '/home/me/.steam/steam',
    'E:\\Games\\Steam'
  ])
})

test("a game's manifest gives its name and how much it has to download", () => {
  const manifest = [
    '"AppState"',
    '{',
    '\t"appid"\t\t"1422450"',
    '\t"name"\t\t"Deadlock"',
    '\t"StateFlags"\t\t"1026"',
    '\t"BytesToDownload"\t\t"32623696"',
    '\t"BytesDownloaded"\t\t"1048576"',
    '\t"InstalledDepots"',
    '\t{',
    '\t\t"1422451"',
    '\t\t{',
    '\t\t\t"manifest"\t\t"7027095991257036524"',
    '\t\t}',
    '\t}',
    '}'
  ].join('\n')
  assert.deepEqual(parseAppManifest(manifest), {
    appId: 1422450,
    name: 'Deadlock',
    bytesToDownload: 32623696,
    bytesDownloaded: 1048576
  })
  assert.equal(parseAppManifest('"AppState" { "name" "No id" }'), null)
})

test("the game being downloaded is the last one Steam's log says is running an update", () => {
  const log = [
    '[2026-10-29 03:41:59] Current download rate: 61.456 Mbps',
    '[2026-10-29 03:42:05] AppID 493520 App update changed : Running Update,Downloading,Staging,Stopping,',
    '[2026-10-29 03:42:10] AppID 493520 App update changed : None',
    '[2026-10-29 03:42:10] AppID 228980 App update changed : Running Update,Preallocating,',
    '[2026-10-29 03:42:10] AppID 228980 update started : download 0/23045488, store 0/0, reuse 0/0, delta 0/0, stage 0/29759921 ',
    '[2026-10-29 03:42:10] AppID 228980 App update changed : Running Update,Downloading,Staging,',
    '[2026-10-29 03:42:10] Downloading 28 chunks for depot 228986 (8782296191957114623)'
  ]
  assert.deepEqual(currentDownload(log.join('\n')), {
    appId: 228980,
    startedBytes: 0,
    totalBytes: 23045488
  })
  // Between downloading and committing it's still running an update.
  const committing = [
    ...log,
    '[2026-10-29 03:42:21] AppID 228980 App update changed : Running Update,Committing,'
  ]
  assert.equal(currentDownload(committing.join('\r\n'))?.appId, 228980)
  // Done, paused or stopped: nothing.
  const done = [...committing, '[2026-10-29 03:42:21] AppID 228980 App update changed : None']
  assert.equal(currentDownload(done.join('\n')), null)
  assert.equal(currentDownload(''), null)
})

// --- A program on port 80 ----------------------------------------------------------------------

test('the program on a port is read from what each OS says, and named with what to do', () => {
  assert.deepEqual(
    parseWindowsOwner(
      '\uFEFF{"pid":4,"process":null,"service":"W3SVC","serviceName":"World Wide Web Publishing Service"}'
    ),
    { pid: 4, process: null, service: 'W3SVC', serviceName: 'World Wide Web Publishing Service' }
  )
  assert.equal(parseWindowsOwner('  \r\n'), null)
  assert.deepEqual(parseLsof('p812\ncnginx\n'), {
    pid: 812,
    process: 'nginx',
    service: null,
    serviceName: null
  })
  assert.equal(parseLsof(''), null)
  assert.deepEqual(
    parseSs(
      'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("apache2",pid=1200,fd=4),("apache2",pid=1201,fd=4))'
    ),
    { pid: 1200, process: 'apache2', service: null, serviceName: null }
  )
  assert.equal(parseSs('LISTEN 0 511 0.0.0.0:80 0.0.0.0:*'), null)

  const owner: PortOwner = { pid: null, process: null, service: null, serviceName: null }
  const said = (parts: Partial<PortOwner>): string => describePortOwner({ ...owner, ...parts }, 80)
  assert.match(
    said({ pid: 4, service: 'W3SVC', serviceName: 'World Wide Web Publishing Service' }),
    /^IIS \(World Wide Web Publishing Service\) is using port 80, the one port Steam looks for a cache on\. Stop it in Services/
  )
  assert.match(
    said({ pid: 4 }),
    /^A program registered with Windows' HTTP service .*"netsh http show servicestate"/
  )
  assert.match(said({ pid: 3021, process: 'httpd' }), /^Apache \(httpd\) is using port 80/)
  assert.match(said({ pid: 77, process: 'Skype' }), /^Skype is using port 80/)
  assert.match(
    said({ pid: 1176, process: 'svchost', service: 'Foo', serviceName: 'Foo Service' }),
    /^Foo Service \(a Windows service\)/
  )
  assert.match(
    said({ pid: 9001, process: 'node' }),
    /^node \(process 9001\) is using port 80\. *|^node \(process 9001\) is using port 80, /
  )
})
