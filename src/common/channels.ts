export const IPC_CHANNELS = {
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
