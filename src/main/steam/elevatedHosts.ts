import { execFile } from 'node:child_process'
import { isIP } from 'node:net'
import { promisify } from 'node:util'
import {
  ALL_BEGIN_MARKS,
  ALL_END_MARKS,
  blockLines,
  hasBlock,
  hostsFilePath,
  readEntry,
  readHostsFile,
  withEntry,
  withoutEntry,
  writeHostsFile
} from './hostsFile'

// Changes the hosts file from an app that doesn't run as administrator. The edit itself runs
// behind the OS's own prompt (UAC on Windows, the password sheet on macOS, polkit on Linux) and
// reads the file there and then: it takes out any block of ours and puts the new one in, just as
// withEntry and withoutEntry do. So a change another program makes while the prompt is open is
// kept, and no copy of ours waits in a folder other programs can write to. The prompt can be
// declined, so the file is read back afterwards to see whether it took.

const execFileAsync = promisify(execFile)
const PROMPT_TIMEOUT_MS = 5 * 60_000
const DECLINED = "The hosts file wasn't changed: the administrator prompt was declined or failed."

/** A PowerShell string literal: single quotes, any inside doubled. */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/** A POSIX shell string literal. */
function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** An AppleScript string literal. */
function appleQuote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function denied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES'
}

/** Our block's lines pointing Steam at `address`; none (null) takes the block out. Only an IP
 * address goes into a script that runs as administrator. */
function newBlock(address: string | null): string[] {
  if (address === null) return []
  if (!isIP(address)) throw new Error(`${address} isn't an IP address.`)
  return blockLines(address)
}

/** PowerShell that edits the hosts file at `path` as withEntry (withoutEntry, for a null address)
 * would: any block of ours out, the blank lines at the end trimmed, the new block in last, the
 * file's own line endings kept, and no byte-order mark. */
export function windowsEditScript(path: string, address: string | null): string {
  const list = (items: string[]): string => `@(${items.map(psQuote).join(', ')})`
  return [
    "$ErrorActionPreference = 'Stop'",
    `$path = ${psQuote(path)}`,
    `$begin = ${list(ALL_BEGIN_MARKS)}`,
    `$end = ${list(ALL_END_MARKS)}`,
    `$block = ${list(newBlock(address))}`,
    "$text = if (Test-Path -LiteralPath $path) { [IO.File]::ReadAllText($path) } else { '' }",
    '$eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }',
    '$kept = New-Object System.Collections.Generic.List[string]',
    '$inside = $false',
    'foreach ($line in ($text -split "\\r?\\n")) {',
    '  $trimmed = $line.Trim()',
    '  if ($begin -ccontains $trimmed) { $inside = $true }',
    '  elseif ($end -ccontains $trimmed) { $inside = $false }',
    '  elseif (-not $inside) { $kept.Add($line) }',
    '}',
    "while ($kept.Count -gt 0 -and $kept[$kept.Count - 1].Trim() -eq '') { $kept.RemoveAt($kept.Count - 1) }",
    "if ($block.Count -gt 0) { if ($kept.Count -gt 0) { $kept.Add('') }; $kept.AddRange([string[]]$block) }",
    "$out = if ($kept.Count -gt 0) { ($kept -join $eol) + $eol } else { '' }",
    '[IO.File]::WriteAllText($path, $out, (New-Object System.Text.UTF8Encoding $false))'
  ].join('\n')
}

/** The same edit as a POSIX shell command line, for macOS and Linux. The new text is built in a
 * file next to the hosts file (so in /etc, which only the administrator can write), then copied
 * over it in place, keeping its owner and permissions. */
export function posixEditScript(path: string, address: string | null): string {
  const marks = [
    ...ALL_BEGIN_MARKS.map((mark, i) => `-v b${i}=${shQuote(mark)}`),
    ...ALL_END_MARKS.map((mark, i) => `-v e${i}=${shQuote(mark)}`)
  ].join(' ')
  const keys = [
    ...ALL_BEGIN_MARKS.map((_mark, i) => `b[b${i}]`),
    ...ALL_END_MARKS.map((_mark, i) => `e[e${i}]`)
  ].join('; ')
  // Blank lines are held back until a line follows them, so the ones at the end are dropped.
  const program =
    `BEGIN { ${keys} } ` +
    '{ l = $0; sub(/\\r$/, "", l); gsub(/^[ \\t]+|[ \\t]+$/, "", l) } ' +
    '(l in b) { inside = 1; next } (l in e) { inside = 0; next } inside { next } ' +
    'l == "" { held[++n] = $0; next } ' +
    '{ for (i = 1; i <= n; i++) print held[i]; n = 0; print }'
  const block = newBlock(address)
  return [
    'set -e',
    `f=${shQuote(path)}`,
    't=$(mktemp "$f.steam-boost.XXXXXX")',
    `trap 'rm -f "$t"' EXIT`,
    // The file's own line endings for the lines added, as withEntry keeps them.
    `if grep -q "$(printf '\\r')" "$f"; then e='\\r\\n'; else e='\\n'; fi`,
    `awk ${marks} ${shQuote(program)} "$f" > "$t"`,
    ...(block.length > 0
      ? [
          `if [ -s "$t" ]; then printf "$e" >> "$t"; fi`,
          `printf "%s$e" ${block.map(shQuote).join(' ')} >> "$t"`
        ]
      : []),
    'cat "$t" > "$f"'
  ].join('; ')
}

/** Points the hosts file's block at `address`, or takes it out (null), behind the OS's
 * administrator prompt unless this process may write the file already. */
export async function editHostsElevated(
  address: string | null,
  path = hostsFilePath()
): Promise<void> {
  // Running as administrator already: no prompt needed.
  try {
    const text = await readHostsFile(path)
    await writeHostsFile(address === null ? withoutEntry(text) : withEntry(text, address), path)
    return
  } catch (error) {
    if (!denied(error)) throw error
  }

  try {
    if (process.platform === 'win32') {
      // Encoded, so nothing in the script can break out of the elevated command.
      const script = `${windowsEditScript(path, address)}\nipconfig /flushdns | Out-Null`
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      await execFileAsync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.ExitCode`
        ],
        { windowsHide: true, timeout: PROMPT_TIMEOUT_MS }
      )
    } else if (process.platform === 'darwin') {
      const script = `${posixEditScript(path, address)}; /usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder 2>/dev/null || true`
      await execFileAsync(
        'osascript',
        [
          '-e',
          `do shell script "/bin/sh -c " & quoted form of ${appleQuote(script)} with administrator privileges`
        ],
        { timeout: PROMPT_TIMEOUT_MS }
      )
    } else {
      const script = `${posixEditScript(path, address)}; resolvectl flush-caches 2>/dev/null || true`
      await execFileAsync('pkexec', ['/bin/sh', '-c', script], { timeout: PROMPT_TIMEOUT_MS })
    }
  } catch (error) {
    throw new Error(DECLINED, { cause: error })
  }
  const text = await readHostsFile(path)
  if (address === null ? hasBlock(text) : readEntry(text) !== address) throw new Error(DECLINED)
}
