import { execFile } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { hostsFilePath, readHostsFile, writeHostsFile } from './hostsFile'

// Writes the hosts file from an app that doesn't run as administrator: the new text goes to a
// file of our own, and a copy is made over the hosts file behind the OS's own prompt (UAC on
// Windows, the password sheet on macOS, polkit on Linux). The prompt can be declined, so the file
// is read back afterwards to see whether it took.

const execFileAsync = promisify(execFile)
const PROMPT_TIMEOUT_MS = 5 * 60_000

/** A PowerShell string literal: single quotes, any inside doubled. */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/** An AppleScript string literal. */
function appleQuote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function denied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES'
}

export async function writeHostsElevated(text: string, path = hostsFilePath()): Promise<void> {
  // Running as administrator already: no prompt needed.
  try {
    await writeHostsFile(text, path)
    return
  } catch (error) {
    if (!denied(error)) throw error
  }

  const staged = join(tmpdir(), `steam-boost-hosts-${process.pid}-${Date.now()}`)
  await writeFile(staged, text, 'utf8')
  try {
    if (process.platform === 'win32') {
      // Encoded, so no path or quote in it can break out of the elevated command.
      const command = `Copy-Item -LiteralPath ${psQuote(staged)} -Destination ${psQuote(path)} -Force; ipconfig /flushdns | Out-Null`
      const encoded = Buffer.from(command, 'utf16le').toString('base64')
      await execFileAsync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`
        ],
        { windowsHide: true, timeout: PROMPT_TIMEOUT_MS }
      )
    } else if (process.platform === 'darwin') {
      const script =
        `do shell script "/bin/cp " & quoted form of ${appleQuote(staged)} & " " & ` +
        `quoted form of ${appleQuote(path)} & " && /usr/bin/dscacheutil -flushcache" ` +
        'with administrator privileges'
      await execFileAsync('osascript', ['-e', script], { timeout: PROMPT_TIMEOUT_MS })
    } else {
      await execFileAsync('pkexec', ['/bin/cp', staged, path], { timeout: PROMPT_TIMEOUT_MS })
    }
  } catch (error) {
    throw new Error(
      "The hosts file wasn't changed: the administrator prompt was declined or failed.",
      {
        cause: error
      }
    )
  } finally {
    await rm(staged, { force: true })
  }
  if ((await readHostsFile(path)) !== text) {
    throw new Error(
      "The hosts file wasn't changed: the administrator prompt was declined or failed."
    )
  }
}
