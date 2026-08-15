import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Sandboxed preload scripts can only require a limited set of built-in modules.
// Keep this small channel table local so the compiled preload remains self-contained.
const IPC_CHANNELS = {
  getState: 'connection-switcher:get-state',
  restoreAdapterStates: 'connection-switcher:restore-adapter-states',
  selectAdapter: 'connection-switcher:select-adapter',
  setAdapterState: 'connection-switcher:set-adapter-state',
  stateChanged: 'connection-switcher:state-changed',
} as const;

const api: ConnectionSwitcherApi = {
  getState: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getState) as Promise<AppState>,
  restoreAdapterStates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.restoreAdapterStates) as Promise<AppState>,
  selectAdapter: (adapterId) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.selectAdapter,
      adapterId,
    ) as Promise<AppState>,
  setAdapterState: (adapterId, action) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.setAdapterState,
      adapterId,
      action,
    ) as Promise<AppState>,
  onStateChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, state: AppState): void =>
      callback(state);
    ipcRenderer.on(IPC_CHANNELS.stateChanged, listener);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, listener);
  },
};

contextBridge.exposeInMainWorld('connectionSwitcher', api);
