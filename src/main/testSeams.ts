import { isIP } from 'node:net'
import type { NetworkInterfaceInfo, NetworkInterfaceKind } from '../shared/network'

// Stand-ins for testing, read from the environment, and only once main/index.ts has said this
// isn't a packaged build (allowTestSeams): a shipped app can't be steered through its environment.

let allowed = false

export function allowTestSeams(): void {
  allowed = true
}

const KINDS = new Set<NetworkInterfaceKind>(['wifi', 'usb', 'ethernet', 'other'])

/** `STEAM_BOOST_TEST_NETWORKS=fibre=127.0.0.2=wifi,phone=127.0.0.3=usb`: these networks in place
 * of the OS's, each a local address it connects from (`vpn=127.0.0.4=other=virtual` for a
 * virtual one). Read on every call, so a test can change it while the app runs. */
export function testInterfaces(): NetworkInterfaceInfo[] | null {
  if (!allowed) return null
  const raw = process.env['STEAM_BOOST_TEST_NETWORKS']
  if (!raw) return null
  return raw
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [id, address, kind, virtual] = entry.split('=')
      return {
        id,
        // Loopback test addresses all live on lo (SO_BINDTODEVICE needs a real device on Linux).
        device: address.startsWith('127.') ? 'lo' : id,
        displayName: id,
        addresses: [{ address, family: isIP(address) === 6 ? 6 : 4 }],
        kind: KINDS.has(kind as NetworkInterfaceKind) ? (kind as NetworkInterfaceKind) : 'ethernet',
        ...(virtual === 'virtual' ? { virtual: true } : {})
      }
    })
}

/** Test networks have no routes to look up: every one counts as having a way out. */
export function usingTestNetworks(): boolean {
  return allowed && Boolean(process.env['STEAM_BOOST_TEST_NETWORKS'])
}
