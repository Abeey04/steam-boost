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
