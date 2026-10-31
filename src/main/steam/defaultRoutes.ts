import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { NetworkInterfaceInfo } from '../../shared/network'

// Which networks reach the internet on their own: the ones with a default route. Steam boost
// suggests those, and leaves out adapters that only reach a VM, a container or a VPN's far side.
// Each OS is asked its own way, with a small program that starts quickly, since this runs every
// half a minute for as long as the app does; when it can't be told, null (every network is a
// candidate).

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 5000

/** /proc/net/route: a destination of 00000000 is a default route; its first column the device. */
export function parseProcNetRoute(text: string): string[] {
  const devices = new Set<string>()
  for (const line of text.split('\n').slice(1)) {
    const [device, destination, , , , , , mask] = line.trim().split(/\s+/)
    if (device && destination === '00000000' && (mask === undefined || mask === '00000000')) {
      devices.add(device)
    }
  }
  return [...devices]
}

/** `netstat -rn -f inet` on macOS: "default  192.168.1.1  UGScg  en0", the device last. */
export function parseNetstatDefaults(text: string): string[] {
  const devices = new Set<string>()
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns[0] === 'default' && columns.length >= 4) devices.add(columns[columns.length - 1])
  }
  return [...devices]
}

/** `route print -4` on Windows: under Active Routes, "0.0.0.0  0.0.0.0  192.168.1.1  192.168.1.23
 * 35" is a default route, the fourth column the address of the adapter it leaves by. Only the
 * numbers are read, so it works in any language. (Persistent routes have no such column.) */
export function parseRoutePrint(text: string): string[] {
  const addresses = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3})\s+\d+\s*$/.exec(
      line
    )
    if (match) addresses.add(match[1])
  }
  return [...addresses]
}

/** Network ids (Node's interface names) with a default route, or null when it can't be told.
 * Windows names the way out by address, so `networks` is what an address is matched to. */
export async function defaultRouteInterfaces(
  networks: readonly NetworkInterfaceInfo[] | null
): Promise<Set<string> | null> {
  try {
    if (process.platform === 'linux') {
      return new Set(parseProcNetRoute(await readFile('/proc/net/route', 'utf8')))
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('netstat', ['-rn', '-f', 'inet'], {
        timeout: TIMEOUT_MS
      })
      return new Set(parseNetstatDefaults(stdout))
    }
    if (process.platform === 'win32') {
      if (!networks) return null
      const { stdout } = await execFileAsync('route', ['print', '-4'], {
        windowsHide: true,
        timeout: TIMEOUT_MS
      })
      const ways = new Set(parseRoutePrint(stdout))
      return new Set(
        networks
          .filter((iface) => iface.addresses.some((entry) => ways.has(entry.address)))
          .map((iface) => iface.id)
      )
    }
  } catch {
    // Can't tell: every network is a candidate.
  }
  return null
}
