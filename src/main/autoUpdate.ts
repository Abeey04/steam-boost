import { autoUpdater } from 'electron-updater'
import { isNewer } from './updates'

// Installing an update from the window, on Windows: electron-updater reads the release's
// latest.yml (which the Release workflow uploads), downloads the installer for this computer's
// architecture, checks it against the sha512 there, and runs it once the app quits. That works
// without code signing; macOS needs it signed first, and Linux packages update with the system.
// Nothing downloads until asked to (the window's Update button).

export interface InstallableUpdate {
  version: string
}

export class WindowsUpdater {
  constructor(
    log: (line: string) => void,
    private readonly onProgress: (fraction: number) => void
  ) {
    autoUpdater.autoDownload = false
    // An update that was fetched but not installed goes in when the app is next quit.
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = {
      info: (message: unknown) => log(`updater: ${String(message)}`),
      warn: (message: unknown) => log(`updater: ${String(message)}`),
      error: (message: unknown) => log(`updater error: ${String(message)}`),
      debug: () => undefined
    }
    autoUpdater.on('download-progress', (progress: { percent: number }) =>
      this.onProgress(Math.max(0, Math.min(1, progress.percent / 100)))
    )
  }

  /** The newer release, if there is one this app can install itself. */
  async check(current: string): Promise<InstallableUpdate | null> {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo.version
    return version && isNewer(version, current) ? { version } : null
  }

  /** Fetches the installer; resolves once it's downloaded and checked. */
  async download(): Promise<void> {
    await autoUpdater.downloadUpdate()
  }

  /** Quits, runs the installer without asking anything, and starts the new version. */
  installNow(): void {
    autoUpdater.quitAndInstall(true, true)
  }
}
