type AdapterAction = 'enable' | 'disable';

interface NetworkAdapter {
  id: string;
  name: string;
  description: string;
  interfaceIndex: number | null;
  adminStatus: string;
  connectionStatus: string;
  enabled: boolean | null;
  connected: boolean | null;
}

interface NetworkSwitcherState {
  adapters: NetworkAdapter[];
  pendingRestoreCount: number;
  selectedAdapterId: string | null;
}

interface ToolboxAppInfo {
  version: string;
  platform: 'win32';
}

interface NetworkSwitcherApi {
  getState: () => Promise<NetworkSwitcherState>;
  restoreAdapterStates: () => Promise<NetworkSwitcherState>;
  selectAdapter: (adapterId: string) => Promise<NetworkSwitcherState>;
  setAdapterState: (
    adapterId: string,
    action: AdapterAction,
  ) => Promise<NetworkSwitcherState>;
  onStateChanged: (
    callback: (state: NetworkSwitcherState) => void,
  ) => () => void;
}

interface CherryToolboxApi {
  app: {
    getInfo: () => Promise<ToolboxAppInfo>;
  };
  networkSwitcher: NetworkSwitcherApi;
}

interface Window {
  cherryToolbox: CherryToolboxApi;
}
