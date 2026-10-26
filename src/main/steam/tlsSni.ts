// The server name a TLS ClientHello asks for (RFC 8446 §4.1.2, RFC 6066 §3), read without
// decrypting anything: a Steam client that talks HTTPS to its LAN cache can only be passed
// through, as lancache's own port 443 does (ssl_preread), but the name says where to.

/** A ClientHello this long has gone wrong: real ones are a few hundred bytes to a few KB. */
export const MAX_HELLO_BYTES = 32 * 1024

export type HelloRead =
  /** Not enough bytes yet. */
  | { kind: 'incomplete' }
  /** Not a TLS handshake at all, or a broken one. */
  | { kind: 'invalid'; reason: string }
  /** The whole ClientHello: the name, or null when it sent none. */
  | { kind: 'hello'; serverName: string | null }

const RECORD_HANDSHAKE = 0x16
const HANDSHAKE_CLIENT_HELLO = 0x01
const EXT_SERVER_NAME = 0x0000
const NAME_TYPE_HOST = 0x00

/** Joins the handshake fragments of consecutive handshake records. */
function handshakeBytes(buffer: Buffer): { data: Buffer; complete: boolean } | { invalid: string } {
  const fragments: Buffer[] = []
  let offset = 0
  let needed: number | null = null
  let have = 0
  while (offset + 5 <= buffer.length) {
    if (buffer[offset] !== RECORD_HANDSHAKE) {
      return { invalid: fragments.length === 0 ? 'not a TLS handshake' : 'handshake interrupted' }
    }
    if (buffer[offset + 1] !== 0x03) return { invalid: 'unknown TLS version' }
    const length = buffer.readUInt16BE(offset + 3)
    if (length === 0 || length > 16384 + 2048) return { invalid: 'bad record length' }
    if (offset + 5 + length > buffer.length) {
      fragments.push(buffer.subarray(offset + 5))
      have += buffer.length - offset - 5
      break
    }
    fragments.push(buffer.subarray(offset + 5, offset + 5 + length))
    have += length
    offset += 5 + length
    if (needed === null && have >= 4) {
      const head = Buffer.concat(fragments)
      needed = 4 + head.readUIntBE(1, 3)
    }
    if (needed !== null && have >= needed) break
  }
  const data = Buffer.concat(fragments)
  if (needed === null && data.length >= 4) needed = 4 + data.readUIntBE(1, 3)
  return { data, complete: needed !== null && data.length >= needed }
}

export function readServerName(buffer: Buffer): HelloRead {
  if (buffer.length > MAX_HELLO_BYTES) return { kind: 'invalid', reason: 'ClientHello too long' }
  if (buffer.length > 0 && buffer[0] !== RECORD_HANDSHAKE) {
    return { kind: 'invalid', reason: 'not a TLS handshake' }
  }
  const joined = handshakeBytes(buffer)
  if ('invalid' in joined) return { kind: 'invalid', reason: joined.invalid }
  if (!joined.complete) return { kind: 'incomplete' }
  const hello = joined.data
  if (hello[0] !== HANDSHAKE_CLIENT_HELLO) return { kind: 'invalid', reason: 'not a ClientHello' }

  const end = 4 + hello.readUIntBE(1, 3)
  // legacy_version (2) and random (32).
  let at = 4 + 2 + 32
  const take = (bytes: number): boolean => {
    at += bytes
    return at <= end
  }
  if (at + 1 > end) return { kind: 'invalid', reason: 'truncated ClientHello' }
  if (!take(1 + hello[at])) return { kind: 'invalid', reason: 'truncated session id' }
  if (at + 2 > end) return { kind: 'invalid', reason: 'truncated ClientHello' }
  if (!take(2 + hello.readUInt16BE(at))) return { kind: 'invalid', reason: 'truncated ciphers' }
  if (at + 1 > end) return { kind: 'invalid', reason: 'truncated ClientHello' }
  if (!take(1 + hello[at])) return { kind: 'invalid', reason: 'truncated compression' }
  // No extensions at all: a valid (if ancient) hello with no name.
  if (at === end) return { kind: 'hello', serverName: null }
  if (at + 2 > end) return { kind: 'invalid', reason: 'truncated extensions' }
  const extensionsEnd = at + 2 + hello.readUInt16BE(at)
  if (extensionsEnd > end) return { kind: 'invalid', reason: 'truncated extensions' }
  at += 2

  while (at + 4 <= extensionsEnd) {
    const type = hello.readUInt16BE(at)
    const length = hello.readUInt16BE(at + 2)
    const dataStart = at + 4
    if (dataStart + length > extensionsEnd)
      return { kind: 'invalid', reason: 'truncated extension' }
    if (type === EXT_SERVER_NAME) {
      if (length < 2) return { kind: 'invalid', reason: 'empty server_name' }
      const listEnd = dataStart + 2 + hello.readUInt16BE(dataStart)
      if (listEnd > dataStart + length) return { kind: 'invalid', reason: 'bad server_name list' }
      let entry = dataStart + 2
      while (entry + 3 <= listEnd) {
        const nameType = hello[entry]
        const nameLength = hello.readUInt16BE(entry + 1)
        const nameStart = entry + 3
        if (nameStart + nameLength > listEnd) return { kind: 'invalid', reason: 'bad server name' }
        if (nameType === NAME_TYPE_HOST) {
          const name = hello.toString('ascii', nameStart, nameStart + nameLength).toLowerCase()
          return /^[a-z0-9.-]+$/.test(name)
            ? { kind: 'hello', serverName: name.replace(/\.$/, '') }
            : { kind: 'invalid', reason: 'server name is not a host name' }
        }
        entry = nameStart + nameLength
      }
      return { kind: 'hello', serverName: null }
    }
    at = dataStart + length
  }
  return { kind: 'hello', serverName: null }
}
