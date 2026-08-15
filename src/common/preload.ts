import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Sandboxed preload scripts can only require a limited set of built-in modules.
// Keep this small channel table local so the compiled preload remains self-contained.
const IPC_CHANNELS = {
  getAppInfo: 'cherry-toolbox:get-app-info',
  networkSwitcherGetState: 'cherry-toolbox:network-switcher:get-state',
  networkSwitcherRestoreAdapterStates:
    'cherry-toolbox:network-switcher:restore-adapter-states',
  networkSwitcherSelectAdapter:
    'cherry-toolbox:network-switcher:select-adapter',
  networkSwitcherSetAdapterState:
    'cherry-toolbox:network-switcher:set-adapter-state',
  networkSwitcherStateChanged:
    'cherry-toolbox:network-switcher:state-changed',
} as const;

const api: CherryToolboxApi = {
  app: {
    getInfo: () =>
      ipcRenderer.invoke(IPC_CHANNELS.getAppInfo) as Promise<ToolboxAppInfo>,
  },
  networkSwitcher: {
    getState: () =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherGetState,
      ) as Promise<NetworkSwitcherState>,
    restoreAdapterStates: () =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherRestoreAdapterStates,
      ) as Promise<NetworkSwitcherState>,
    selectAdapter: (adapterId) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherSelectAdapter,
        adapterId,
      ) as Promise<NetworkSwitcherState>,
    setAdapterState: (adapterId, action) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherSetAdapterState,
        adapterId,
        action,
      ) as Promise<NetworkSwitcherState>,
    onStateChanged: (callback) => {
      const listener = (
        _event: IpcRendererEvent,
        state: NetworkSwitcherState,
      ): void => callback(state);
      ipcRenderer.on(IPC_CHANNELS.networkSwitcherStateChanged, listener);
      return () =>
        ipcRenderer.removeListener(
          IPC_CHANNELS.networkSwitcherStateChanged,
          listener,
        );
    },
  },
};

contextBridge.exposeInMainWorld('cherryToolbox', api);
