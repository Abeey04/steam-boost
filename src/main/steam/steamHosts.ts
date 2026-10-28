import { isIP } from 'node:net'

// What Steam boost forwards, and where to. Steam finds a LAN cache by looking up TRIGGER_HOST:
// when that resolves to a private address, Steam connects there instead of to its content
// servers, over plain HTTP on port 80, and names the content server each request is for in its
// Host header (lancache.net, "Steam client now supports lancache!", 2020-01-14). Lancache's own
// proxy forwards on exactly that: `proxy_pass http://$host$request_uri`.

export const TRIGGER_HOST = 'lancache.steamcontent.com'

/** The user agent Steam's downloader sends, which lancache keys its Steam cache on too. */
export const STEAM_USER_AGENT = 'Valve/Steam HTTP Client 1.0'

/** Valve's own caches (cache12-lhr1.steamcontent.com) and the CDNs its content server directory
 * hands out. Others are let through only when the request looks like Steam's (see judgeRequest),
 * so an ISP-run cache with a name of its own still works. */
const STEAM_HOSTS: readonly RegExp[] = [
  /(^|\.)steamcontent\.com$/,
  /(^|\.)steamstatic\.com$/,
  /^steampipe[a-z0-9-]*\.akamaized\.net$/,
  /^steamcdn-[a-z0-9-]*\.akamaihd\.net$/,
  // Steam China's CDNs (seen in the directory's answers to Chinese addresses).
  /^st\.dl\.eccdnx\.com$/,
  /^xz\.pphimalayanrt\.com$/,
  /^dl\.steam\.clngaa\.com$/
]

/** What content servers serve: depot chunks, manifests and patches, and their status page. */
const STEAM_PATH = /^\/(depot\/\d+\/|server-status(\/|\?|$))/

export interface Target {
  /** As the Host header named it, lowercased, without a port (IPv6 without brackets). */
  host: string
  port: number
  secure: boolean
}

/** `Host: name[:port]`, or `[v6]:port`. Null when it isn't a usable host. */
export function parseHostHeader(
  value: string | undefined
): { host: string; port: number | null } | null {
  if (!value) return null
  const trimmed = value.trim().toLowerCase()
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(trimmed)
  if (bracketed) {
    if (isIP(bracketed[1]) !== 6) return null
    return { host: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : null }
  }
  const plain = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(trimmed)
  if (!plain) return null
  const host = plain[1].replace(/\.$/, '')
  if (!host || host.startsWith('.') || host.includes('..')) return null
  const port = plain[2] ? Number(plain[2]) : null
  if (port !== null && (port < 1 || port > 65535)) return null
  return { host, port }
}

export function isSteamHost(host: string, extraHosts: readonly string[] = []): boolean {
  const name = host.toLowerCase()
  return (
    STEAM_HOSTS.some((pattern) => pattern.test(name)) ||
    extraHosts.some((extra) => {
      const wanted = extra.toLowerCase()
      return wanted.startsWith('.')
        ? name.endsWith(wanted) || name === wanted.slice(1)
        : name === wanted
    })
  )
}

export interface RequestFacts {
  method: string | undefined
  hostHeader: string | undefined
  /** Path and query, as the request line had it. */
  path: string
  userAgent: string | undefined
}

export interface JudgeOptions {
  extraHosts?: readonly string[]
  /** Forward to any host at all: only for a boost nobody else can reach. */
  anyHost?: boolean
}

export type Verdict =
  { forward: true; target: Target } | { forward: false; status: number; reason: string }

/** Whether to forward a request, and where. Port 443 in the Host header means HTTPS onward;
 * anything else is plain HTTP, as Steam would have sent it to a LAN cache. */
export function judgeRequest(request: RequestFacts, options: JudgeOptions = {}): Verdict {
  const method = request.method?.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return { forward: false, status: 405, reason: `method ${request.method ?? '(none)'}` }
  }
  if (!request.path.startsWith('/')) {
    return { forward: false, status: 400, reason: 'not a path' }
  }
  const parsed = parseHostHeader(request.hostHeader)
  if (!parsed) return { forward: false, status: 400, reason: 'no usable Host header' }
  // It resolves to this boost: forwarding there would only come back here.
  if (parsed.host === TRIGGER_HOST) {
    return { forward: false, status: 508, reason: `${TRIGGER_HOST} names this boost` }
  }
  const looksLikeSteam =
    (request.userAgent ?? '').startsWith('Valve/Steam') && STEAM_PATH.test(request.path)
  const allowed =
    options.anyHost === true || isSteamHost(parsed.host, options.extraHosts) || looksLikeSteam
  if (!allowed) {
    return { forward: false, status: 403, reason: `not a Steam content server: ${parsed.host}` }
  }
  const port = parsed.port ?? 80
  return { forward: true, target: { host: parsed.host, port, secure: port === 443 } }
}

/** Bytes a `Range: bytes=a-b` asks for, when it names one bounded range. */
export function rangeLength(value: string | undefined): number | null {
  if (!value) return null
  const match = /^\s*bytes\s*=\s*(\d+)\s*-\s*(\d+)\s*$/i.exec(value)
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start
    ? end - start + 1
    : null
}
