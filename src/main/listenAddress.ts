import type { AddressMode } from '../shared/boost'
import type { NetworkInterfaceInfo } from '../shared/network'

// Where the boost listens, which is where the hosts line points Steam.

export const LOOPBACK = '127.0.0.1'

export function isPrivateV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** 127.0.0.1, or for 'lan' this computer's LAN address. A Wi-Fi or Ethernet address goes before
 * a phone's (whose address is gone the moment it's unplugged), and one with a way to the internet
 * before one without. Null when there's no LAN address to be had. */
export function listenAddress(
  mode: AddressMode,
  networks: NetworkInterfaceInfo[],
  routed: Set<string> | null
): string | null {
  if (mode === 'loopback') return LOOPBACK
  const rank = (iface: NetworkInterfaceInfo): number =>
    (routed && !routed.has(iface.id) ? 10 : 0) +
    (iface.kind === 'usb' ? 5 : iface.kind === 'other' ? 3 : 0)
  const candidates = networks
    .filter((iface) => iface.kind !== 'bridge')
    .map((iface) => ({
      iface,
      address: iface.addresses.find((entry) => entry.family === 4 && isPrivateV4(entry.address))
    }))
    .filter((candidate) => candidate.address !== undefined)
    .sort((a, b) => rank(a.iface) - rank(b.iface))
  return candidates[0]?.address?.address ?? null
}
