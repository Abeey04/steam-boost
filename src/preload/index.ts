import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppState, RestartResult, SteamBoostApi } from '../shared/boost'
import { IPC } from '../shared/ipc'

// The window's only way to the main process: window.steamBoost, nothing more.

const api: SteamBoostApi = {
  getState: () => ipcRenderer.invoke(IPC.getState) as Promise<AppState>,
  onState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: AppState): void => listener(state)
    ipcRenderer.on(IPC.state, handler)
    return () => {
      ipcRenderer.removeListener(IPC.state, handler)
    }
  },
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  setNetwork: (id, patch) => ipcRenderer.invoke(IPC.setNetwork, id, patch),
  retry: () => ipcRenderer.invoke(IPC.retry),
  setUp: () => ipcRenderer.invoke(IPC.setUp),
  tearDown: () => ipcRenderer.invoke(IPC.tearDown),
  restartSteam: () => ipcRenderer.invoke(IPC.restartSteam) as Promise<RestartResult>,
  copyDiagnostics: () => ipcRenderer.invoke(IPC.copyDiagnostics),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs),
  openUrl: (url) => ipcRenderer.invoke(IPC.openUrl, url)
}

contextBridge.exposeInMainWorld('steamBoost', api)
