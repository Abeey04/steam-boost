import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RestartResult } from '../shared/boost'

// Steam itself: whether it's running, and restarting it. Steam looks for a LAN cache only as it
// starts, so after the hosts line goes in it has to be started again; doing that from here saves
// people finding Steam > Exit (closing its window only hides it).

const execFileAsync = promisify(execFile)

/** tasklist's CSV (/FO CSV /NH) has a line starting "steam.exe" for each match; with none it
 * prints an INFO line, in the system's language. */
export function tasklistHasSteam(stdout: string): boolean {
  return stdout.split(/\r?\n/).some((line) => /^"steam\.exe"/i.test(line.trim()))
}

/** Whether Steam is running: null when it can't be told. */
export async function isSteamRunning(platform = process.platform): Promise<boolean | null> {
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileAsync(
        'tasklist',
        ['/FI', 'IMAGENAME eq steam.exe', '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 5000 }
      )
      return tasklistHasSteam(stdout)
    }
    await execFileAsync('pgrep', ['-x', platform === 'darwin' ? 'steam_osx' : 'steam'], {
      timeout: 5000
    })
    return true
  } catch (error) {
    // pgrep says "none" by exiting with 1.
    return (error as { code?: unknown }).code === 1 ? false : null
  }
}

export interface RestartSteamDeps {
  /** Opens a steam:// link (shell.openExternal). */
  openUrl: (url: string) => Promise<void>
  isRunning: () => Promise<boolean | null>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How long Steam gets to exit. */
  timeoutMs?: number
}

/** Exits Steam (steam://exit), waits until it's gone, and starts it again on its Downloads page
 * (steam://open/downloads), which also starts a Steam that wasn't running. */
export async function restartSteam(deps: RestartSteamDeps): Promise<RestartResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const now = deps.now ?? Date.now
  const running = await deps.isRunning()
  try {
    if (running !== false) {
      await deps.openUrl('steam://exit')
      if (running === null) {
        // No way to watch it go: give it the time an exit usually takes.
        await sleep(8000)
      } else {
        const deadline = now() + (deps.timeoutMs ?? 45_000)
        for (;;) {
          await sleep(1000)
          const still = await deps.isRunning()
          if (still === false) break
          if (now() > deadline) return 'timeout'
        }
        // Its helper processes take a moment longer to let go of their files.
        await sleep(2000)
      }
    }
    await deps.openUrl('steam://open/downloads')
  } catch {
    return 'failed'
  }
  return running === false ? 'started' : 'restarted'
}
