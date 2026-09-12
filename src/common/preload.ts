import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Sandboxed preload scripts can only require a limited set of built-in modules.
// Keep this small channel table local so the compiled preload remains self-contained.
const IPC_CHANNELS = {
  componentLeave: 'cherry-toolbox:component:leave',
  getAppInfo: 'cherry-toolbox:get-app-info',
  safetyGetState: 'cherry-toolbox:safety:get-state',
  safetyStateChanged: 'cherry-toolbox:safety:state-changed',
  networkSwitcherGetState: 'cherry-toolbox:network-switcher:get-state',
  networkSwitcherCancelAdapterOperation: 'cherry-toolbox:network-switcher:cancel-adapter-operation',
  networkSwitcherActivateSplitRouting:
    'cherry-toolbox:network-switcher:activate-split-routing',
  networkSwitcherDeactivateSplitRouting:
    'cherry-toolbox:network-switcher:deactivate-split-routing',
  networkSwitcherPreflightSplitRouting:
    'cherry-toolbox:network-switcher:preflight-split-routing',
  networkSwitcherRestoreAdapterStates:
    'cherry-toolbox:network-switcher:restore-adapter-states',
  networkSwitcherSaveSplitRoutingSettings:
    'cherry-toolbox:network-switcher:save-split-routing-settings',
  networkSwitcherSelectAdapter:
    'cherry-toolbox:network-switcher:select-adapter',
  networkSwitcherSetAdapterState:
    'cherry-toolbox:network-switcher:set-adapter-state',
  networkSwitcherVerifySplitRouting:
    'cherry-toolbox:network-switcher:verify-split-routing',
  networkSwitcherStateChanged:
    'cherry-toolbox:network-switcher:state-changed',
  wechatAutoReplyGetState: 'cherry-toolbox:wechat-auto-reply:get-state',
  wechatAutoReplySaveSettings:
    'cherry-toolbox:wechat-auto-reply:save-settings',
  wechatAutoReplyStart: 'cherry-toolbox:wechat-auto-reply:start',
  wechatAutoReplyStateChanged:
    'cherry-toolbox:wechat-auto-reply:state-changed',
  wechatAutoReplyStop: 'cherry-toolbox:wechat-auto-reply:stop',
} as const;

const api: CherryToolboxApi = {
  app: {
    getInfo: () =>
      ipcRenderer.invoke(IPC_CHANNELS.getAppInfo) as Promise<ToolboxAppInfo>,
    leaveComponent: (component) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.componentLeave,
        component,
      ) as Promise<void>,
  },
  networkSwitcher: {
    cancelAdapterOperation: () => ipcRenderer.invoke(IPC_CHANNELS.networkSwitcherCancelAdapterOperation) as Promise<void>,
    activateSplitRouting: (settings, controllerSecret) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherActivateSplitRouting,
        settings,
        controllerSecret,
      ) as Promise<NetworkSwitcherState>,
    deactivateSplitRouting: (controllerSecret) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherDeactivateSplitRouting,
        controllerSecret,
      ) as Promise<NetworkSwitcherState>,
    getState: () =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherGetState,
      ) as Promise<NetworkSwitcherState>,
    preflightSplitRouting: (settings, controllerSecret) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherPreflightSplitRouting,
        settings,
        controllerSecret,
      ) as Promise<SplitRoutingPreflightResult>,
    restoreAdapterStates: () =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherRestoreAdapterStates,
      ) as Promise<NetworkSwitcherState>,
    selectAdapter: (adapterId) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherSelectAdapter,
        adapterId,
      ) as Promise<NetworkSwitcherState>,
    saveSplitRoutingSettings: (settings) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherSaveSplitRoutingSettings,
        settings,
      ) as Promise<NetworkSwitcherState>,
    setAdapterState: (adapterId, action) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherSetAdapterState,
        adapterId,
        action,
      ) as Promise<NetworkSwitcherState>,
    verifySplitRouting: () =>
      ipcRenderer.invoke(
        IPC_CHANNELS.networkSwitcherVerifySplitRouting,
      ) as Promise<SplitRoutingVerificationResult>,
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
  safety: {
    getState: () =>
      ipcRenderer.invoke(
        IPC_CHANNELS.safetyGetState,
      ) as Promise<ToolboxSafetyState>,
    onStateChanged: (callback) => {
      const listener = (
        _event: IpcRendererEvent,
        state: ToolboxSafetyState,
      ): void => callback(state);
      ipcRenderer.on(IPC_CHANNELS.safetyStateChanged, listener);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.safetyStateChanged, listener);
    },
  },
  wechatAutoReply: {
    getState: () =>
      ipcRenderer.invoke(
        IPC_CHANNELS.wechatAutoReplyGetState,
      ) as Promise<WeChatAutoReplyState>,
    saveSettings: (settings) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.wechatAutoReplySaveSettings,
        settings,
      ) as Promise<WeChatAutoReplyState>,
    start: (settings) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.wechatAutoReplyStart,
        settings,
      ) as Promise<WeChatAutoReplyState>,
    stop: () =>
      ipcRenderer.invoke(
        IPC_CHANNELS.wechatAutoReplyStop,
      ) as Promise<WeChatAutoReplyState>,
    onStateChanged: (callback) => {
      const listener = (
        _event: IpcRendererEvent,
        state: WeChatAutoReplyState,
      ): void => callback(state);
      ipcRenderer.on(IPC_CHANNELS.wechatAutoReplyStateChanged, listener);
      return () =>
        ipcRenderer.removeListener(
          IPC_CHANNELS.wechatAutoReplyStateChanged,
          listener,
        );
    },
  },
};

contextBridge.exposeInMainWorld('cherryToolbox', api);
