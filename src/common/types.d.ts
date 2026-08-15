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

interface AppState {
  adapters: NetworkAdapter[];
  pendingRestoreCount: number;
  selectedAdapterId: string | null;
  version: string;
  platform: 'win32';
}

interface ConnectionSwitcherApi {
  getState: () => Promise<AppState>;
  restoreAdapterStates: () => Promise<AppState>;
  selectAdapter: (adapterId: string) => Promise<AppState>;
  setAdapterState: (
    adapterId: string,
    action: AdapterAction,
  ) => Promise<AppState>;
  onStateChanged: (callback: (state: AppState) => void) => () => void;
}

interface Window {
  connectionSwitcher: ConnectionSwitcherApi;
}
