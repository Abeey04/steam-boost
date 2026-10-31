import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Which program holds a port Steam Boost needs, and what to do about it, so the window can say
// "IIS (World Wide Web Publishing Service) is using port 80" rather than hand over a netstat
// command. Windows is asked with PowerShell, macOS with lsof and Linux with ss. Another user's
// program can be hidden from the last two, and then there's no answer.

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 8000

export interface PortOwner {
  /** Its process id. On Windows, 4 is the system itself: a program that registered the port with
   * Windows' HTTP service (IIS does) listens through it. */
  pid: number | null
  /** Its program's name, without .exe ("httpd"). */
  process: string | null
  /** The Windows service it runs as: its name ("W3SVC") and the one Services shows. */
  service: string | null
  serviceName: string | null
}

/** Services that take port 80 through Windows' HTTP service, so they show up as the system. */
const HTTP_SERVICES = ['W3SVC', 'MsDepSvc', 'PeerDistSvc', 'ReportServer*']

function windowsScript(port: number): string {
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if (-not $c) { exit 0 }',
    '$id = [int]$c.OwningProcess',
    '$o = [ordered]@{ pid = $id; process = $null; service = $null; serviceName = $null }',
    'if ($id -eq 4) {',
    `  $s = Get-Service -Name ${HTTP_SERVICES.map((name) => `'${name}'`).join(',')} -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' } | Select-Object -First 1`,
    '  if ($s) { $o.service = $s.Name; $o.serviceName = $s.DisplayName }',
    '} else {',
    '  $p = Get-Process -Id $id -ErrorAction SilentlyContinue',
    '  if ($p) { $o.process = $p.ProcessName }',
    '  $s = Get-CimInstance Win32_Service -Filter "ProcessId=$id" -ErrorAction SilentlyContinue | Select-Object -First 1',
    '  if ($s) { $o.service = $s.Name; $o.serviceName = $s.DisplayName }',
    '}',
    '$o | ConvertTo-Json -Compress'
  ].join('\n')
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** The JSON the PowerShell above prints; nothing (no listener) is null. */
export function parseWindowsOwner(json: string): PortOwner | null {
  const trimmed = json.trim().replace(/^﻿/, '')
  if (!trimmed) return null
  const raw = JSON.parse(trimmed) as Record<string, unknown>
  return {
    pid: typeof raw['pid'] === 'number' ? raw['pid'] : null,
    process: text(raw['process']),
    service: text(raw['service']),
    serviceName: text(raw['serviceName'])
  }
}

/** `lsof -nP -iTCP:80 -sTCP:LISTEN -Fpc`: a "p123" line, then the program as "cnginx". */
export function parseLsof(output: string): PortOwner | null {
  const pid = /^p(\d+)$/m.exec(output)
  const command = /^c(.+)$/m.exec(output)
  if (!pid && !command) return null
  return {
    pid: pid ? Number(pid[1]) : null,
    process: command ? command[1].trim() : null,
    service: null,
    serviceName: null
  }
}

/** `ss -ltnpH sport = :80`: the program shows as users:(("nginx",pid=123,fd=6)), for a program
 * this user may look at. */
export function parseSs(output: string): PortOwner | null {
  const match = /users:\(\("([^"]+)",pid=(\d+)/.exec(output)
  if (!match) return null
  return { pid: Number(match[2]), process: match[1], service: null, serviceName: null }
}

export async function findPortOwner(port: number): Promise<PortOwner | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsScript(port)],
        { windowsHide: true, timeout: TIMEOUT_MS, encoding: 'utf8' }
      )
      return parseWindowsOwner(stdout)
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync(
        'lsof',
        ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
        { timeout: TIMEOUT_MS }
      )
      return parseLsof(stdout)
    }
    const { stdout } = await execFileAsync('ss', ['-ltnpH', `sport = :${port}`], {
      timeout: TIMEOUT_MS
    })
    return parseSs(stdout)
  } catch {
    // lsof exits 1 when it finds nothing; any failure means there's no name to give.
    return null
  }
}

/** What the window says: who has the port, and what to do so Steam Boost can have it. */
export function describePortOwner(owner: PortOwner, port: number): string {
  const has = (who: string, todo: string): string =>
    `${who} is using port ${port}, the one port Steam looks for a cache on. ${todo}`
  const services = 'Stop it in Services (press Windows, type "services"), then try again.'
  const service = owner.service?.toLowerCase() ?? ''
  const program = owner.process?.toLowerCase() ?? ''
  if (service === 'w3svc' || program === 'w3wp') {
    return has(
      `IIS (${owner.serviceName ?? 'World Wide Web Publishing Service'})`,
      'Stop it in Services, or turn IIS off in Windows Features if you don’t use it, then try again.'
    )
  }
  if (service === 'peerdistsvc') return has('BranchCache', services)
  if (service === 'msdepsvc') return has('Web Deploy (Web Deployment Agent Service)', services)
  if (service.startsWith('reportserver')) return has('SQL Server Reporting Services', services)
  if (owner.serviceName) return has(`${owner.serviceName} (a Windows service)`, services)
  if (program === 'httpd' || program === 'apache2') {
    return has(
      'Apache (httpd)',
      'Stop it, or give it another port (in XAMPP: Config, then httpd.conf, Listen), then try again.'
    )
  }
  if (program === 'nginx') return has('nginx', 'Stop it, or give it another port, then try again.')
  if (program === 'skype') {
    return has(
      'Skype',
      'Turn off its use of ports 80 and 443 in its connection settings, or quit it, then try again.'
    )
  }
  if (owner.pid === 4 && !owner.process) {
    return has(
      "A program registered with Windows' HTTP service",
      'In a command prompt, "netsh http show servicestate" shows which one. Stop it, then try again.'
    )
  }
  const who = owner.process
    ? `${owner.process}${owner.pid !== null ? ` (process ${owner.pid})` : ''}`
    : `Process ${owner.pid}`
  return has(who, 'Close it, or give it another port, then try again.')
}
