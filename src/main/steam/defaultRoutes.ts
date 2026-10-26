import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

// Which networks reach the internet on their own: the ones with a default route. Steam boost
// suggests those, and leaves out adapters that only reach a VM, a container or a VPN's far side.
// Each OS is asked its own way; when it can't be told, null (every network is a candidate).

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

/** Get-NetRoute's JSON: one object or a list, each with the adapter's alias (Node's name for it). */
export function parseWindowsRoutes(json: string): string[] {
  const parsed: unknown = JSON.parse(json.trim().replace(/^﻿/, '') || '[]')
  const routes = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  const aliases = new Set<string>()
  for (const route of routes) {
    const alias = (route as { InterfaceAlias?: unknown }).InterfaceAlias
    if (typeof alias === 'string' && alias) aliases.add(alias)
  }
  return [...aliases]
}

/** Network ids (Node's interface names) with a default route, or null when it can't be told. */
export async function defaultRouteInterfaces(): Promise<Set<string> | null> {
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
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Select-Object InterfaceAlias | ConvertTo-Json -Compress"
        ],
        { windowsHide: true, timeout: TIMEOUT_MS, encoding: 'utf8' }
      )
      return new Set(parseWindowsRoutes(stdout))
    }
  } catch {
    // Can't tell: every network is a candidate.
  }
  return null
}
