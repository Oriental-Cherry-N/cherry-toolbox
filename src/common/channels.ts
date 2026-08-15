export const IPC_CHANNELS = {
  getState: 'connection-switcher:get-state',
  restoreAdapterStates: 'connection-switcher:restore-adapter-states',
  selectAdapter: 'connection-switcher:select-adapter',
  setAdapterState: 'connection-switcher:set-adapter-state',
  stateChanged: 'connection-switcher:state-changed',
} as const;
