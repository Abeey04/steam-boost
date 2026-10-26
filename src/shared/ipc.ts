// The channels between the window (preload/index.ts) and the main process (main/index.ts).

export const IPC = {
  getState: 'state:get',
  /** Main to window: the new AppState. */
  state: 'state:changed',
  updateSettings: 'settings:update',
  setNetwork: 'network:set',
  retry: 'boost:retry',
  setUp: 'hosts:set-up',
  tearDown: 'hosts:tear-down',
  restartSteam: 'steam:restart',
  copyDiagnostics: 'diagnostics:copy',
  openLogs: 'logs:open',
  openUrl: 'url:open'
} as const
