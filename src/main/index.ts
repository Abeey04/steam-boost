import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  screen,
  shell
} from 'electron'
import type { AppState, NetworkPatch, SettingsPatch, UpdateInfo } from '../shared/boost'
import { IPC } from '../shared/ipc'
import { OPENABLE_PREFIXES, PROJECT } from '../shared/project'
import { BoostController } from './boostController'
import { diagnosticsReport } from './diagnostics'
import { initLog, log, logDirectory, recentLog } from './logger'
import { NetworkMonitor } from './network/interfaces'
import { SettingsStore, withNetwork, withSettings } from './settings'
import { findSteamDir, readContentLogTail } from './steam/contentLog'
import { BEGIN_MARK, END_MARK, readHostsFile } from './steam/hostsFile'
import { TRIGGER_HOST } from './steam/steamHosts'
import { isSteamRunning, restartSteam } from './steamProcess'
import { allowTestSeams, usingTestNetworks } from './testSeams'
import { AppTray } from './tray'
import { checkForUpdate } from './updates'
import { UsageBook } from './usage'

// Steam Boost's main process: one window, a tray icon, and the boost (boostController.ts),
// running for as long as the app does.

const APP_ID = 'app.steamboost.desktop'
const UPDATE_CHECK_MS = 12 * 60 * 60 * 1000
const USAGE_SAVE_MS = 15_000

if (!app.isPackaged) {
  // A development build takes test settings from its environment (testSeams.ts); a packaged one
  // never does.
  allowTestSeams()
  const userData = process.env['STEAM_BOOST_USER_DATA']
  if (userData) app.setPath('userData', userData)
}

let settings: SettingsStore | null = null
let usage: UsageBook | null = null
let controller: BoostController | null = null
let window: BrowserWindow | null = null
let tray: AppTray | null = null
let update: UpdateInfo | null = null
let quitting = false
let cleanedUp = false
let trayNoticeShown = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(main, (error: unknown) => {
    log('failed to start:', error)
    app.quit()
  })
}

function assets(): string {
  return join(__dirname, 'assets')
}

function isOpenable(url: string): boolean {
  return OPENABLE_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`))
}

function currentState(): AppState | null {
  if (!settings || !controller) return null
  return {
    version: app.getVersion(),
    platform: process.platform,
    settings: settings.current,
    boost: controller.current.boost,
    networks: controller.current.networks,
    update,
    canStartAtLogin: process.platform === 'win32' || process.platform === 'darwin'
  }
}

function broadcast(): void {
  const state = currentState()
  if (!state) return
  if (window && !window.isDestroyed()) window.webContents.send(IPC.state, state)
  tray?.update(state)
}

async function main(): Promise<void> {
  const userData = app.getPath('userData')
  initLog(join(userData, 'logs'))
  log(`${PROJECT.name} ${app.getVersion()} on ${process.platform} ${process.arch}`)
  app.setAppUserModelId(APP_ID)
  const theme = app.isPackaged ? undefined : process.env['STEAM_BOOST_THEME']
  if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null
  )

  const store = (settings = await SettingsStore.load(join(userData, 'settings.json')))
  const book = (usage = await UsageBook.load(join(userData, 'usage.json')))
  const monitor = new NetworkMonitor(() => void controller?.refreshNetworks())
  const boost = (controller = new BoostController({
    settings: () => store.current,
    usage: book,
    networks: () => monitor.current,
    onChange: broadcast,
    log: (line) => log(line),
    // Made-up test networks have no routes to look up.
    defaultRoutes: usingTestNetworks() ? async () => null : undefined
  }))

  registerIpc(store, boost)
  tray = new AppTray(assets(), {
    show: () => showWindow(),
    setEnabled: (enabled) => void changeSettings(store, boost, { enabled }),
    quit: () => app.quit()
  })

  const startHidden =
    process.argv.includes('--hidden') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)
  if (!startHidden) showWindow()

  // The hosts file, Steam's log and a DNS lookup answer in milliseconds, the network lookups below
  // in a second or more each: looked at first, so a window that opens on a set-up PC doesn't show
  // setup steps until those finish.
  void boost.refresh()
  await monitor.refresh()
  await boost.start()
  broadcast()

  setInterval(() => void book.save(), USAGE_SAVE_MS).unref()
  setTimeout(() => void lookForUpdate(), 10_000).unref()
  setInterval(() => void lookForUpdate(), UPDATE_CHECK_MS).unref()
}

async function changeSettings(
  store: SettingsStore,
  boost: BoostController,
  patch: SettingsPatch
): Promise<void> {
  const before = store.current
  await store.set(withSettings(before, patch))
  if (store.current.startAtLogin !== before.startAtLogin) applyLoginItem(store.current.startAtLogin)
  await boost.apply()
  broadcast()
}

function registerIpc(store: SettingsStore, boost: BoostController): void {
  ipcMain.handle(IPC.getState, () => currentState())
  ipcMain.handle(IPC.updateSettings, (_event, patch: unknown) =>
    changeSettings(store, boost, (patch ?? {}) as SettingsPatch)
  )
  ipcMain.handle(IPC.setNetwork, async (_event, id: unknown, patch: unknown) => {
    if (typeof id !== 'string' || !id) return
    await store.set(withNetwork(store.current, id, (patch ?? {}) as NetworkPatch))
    await boost.refreshNetworks()
    broadcast()
  })
  ipcMain.handle(IPC.retry, () => boost.apply(true))
  ipcMain.handle(IPC.setUp, () => boost.setUp())
  ipcMain.handle(IPC.tearDown, () => boost.tearDown())
  ipcMain.handle(IPC.restartSteam, async () => {
    boost.noteSteamRestart()
    const result = await restartSteam({
      openUrl: (url) => shell.openExternal(url),
      isRunning: () => isSteamRunning()
    })
    log(`restarting Steam: ${result}`)
    boost.noteSteamRestart()
    void boost.refresh()
    return result
  })
  ipcMain.handle(IPC.copyDiagnostics, async () => {
    clipboard.writeText(await collectDiagnostics())
  })
  ipcMain.handle(IPC.openLogs, async () => {
    const dir = logDirectory()
    if (dir) await shell.openPath(dir)
  })
  ipcMain.handle(IPC.openUrl, async (_event, url: unknown) => {
    if (typeof url === 'string' && isOpenable(url)) await shell.openExternal(url)
  })
}

async function collectDiagnostics(): Promise<string> {
  const state = currentState()
  if (!state) return `${PROJECT.name} is still starting.`
  let hostsLines: string[] = []
  try {
    hostsLines = (await readHostsFile())
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.includes(TRIGGER_HOST) || line.includes(BEGIN_MARK) || line.includes(END_MARK)
      )
  } catch (error) {
    hostsLines = [`(couldn't read the hosts file: ${String(error)})`]
  }
  const steamDir = await findSteamDir().catch(() => null)
  const steamLog = steamDir ? await readContentLogTail(steamDir).catch(() => null) : null
  return diagnosticsReport({ state, hostsLines, steamLog, recentLog: recentLog() })
}

function createWindow(show: boolean): BrowserWindow {
  // Tall enough for everything on a big screen; no taller than a small laptop's.
  const { height: available } = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: 480,
    height: Math.max(560, Math.min(820, available - 40)),
    minWidth: 400,
    minHeight: 560,
    show: false,
    title: PROJECT.name,
    // The window's --bg (docs/theme.css), so nothing flashes before the page draws.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d11' : '#f6f7f9',
    autoHideMenuBar: true,
    icon: process.platform === 'linux' ? join(assets(), 'icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  // Links go to the browser (only the project's own); the window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOpenable(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.once('ready-to-show', () => {
    if (show) win.show()
  })
  win.on('close', (event) => {
    if (quitting || !settings?.current.closeToTray) return
    event.preventDefault()
    win.hide()
    if (!trayNoticeShown && Notification.isSupported()) {
      trayNoticeShown = true
      new Notification({
        title: PROJECT.name,
        body: 'Still running in the tray, so Steam downloads keep their boost. Quit it from the tray icon.'
      }).show()
    }
  })
  win.on('closed', () => {
    if (window === win) window = null
  })
  void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function showWindow(): void {
  if (!app.isReady()) return
  if (!window || window.isDestroyed()) {
    window = createWindow(true)
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function applyLoginItem(openAtLogin: boolean): void {
  // A development build would register Electron itself.
  if (!app.isPackaged || (process.platform !== 'win32' && process.platform !== 'darwin')) return
  // Windows passes the args; macOS says wasOpenedAtLogin instead (see main()).
  app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })
}

async function lookForUpdate(): Promise<void> {
  if (!app.isPackaged) return
  try {
    update = await checkForUpdate(app.getVersion())
    if (update) log(`update available: ${update.version}`)
    broadcast()
  } catch (error) {
    log(`update check failed: ${String(error)}`)
  }
}

app.on('before-quit', (event) => {
  quitting = true
  if (cleanedUp) return
  event.preventDefault()
  const cleanup = Promise.allSettled([controller?.stop(), usage?.save()])
  void Promise.race([cleanup, sleep(3000)]).finally(() => {
    cleanedUp = true
    tray?.destroy()
    tray = null
    app.quit()
  })
})

// With "keep running in the tray" off, closing the window quits.
app.on('window-all-closed', () => {
  if (!settings?.current.closeToTray) app.quit()
})

// macOS: a click on the Dock icon opens the window again.
app.on('activate', () => showWindow())
