type AdapterAction = 'enable' | 'disable';

type ToolboxComponentId =
  | 'network-switcher'
  | 'split-routing'
  | 'wechat-auto-reply';

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
  splitRouting: SplitRoutingState;
}

type SplitRoutingStatus =
  | 'inactive'
  | 'preparing'
  | 'active'
  | 'restoring'
  | 'error';

type SplitRoutingMode = 'sites' | 'chatgpt-web';

interface SplitRoutingSettingsInput {
  mode?: SplitRoutingMode;
  chatgptEnabled: boolean;
  controllerPort: number;
  customDomains: string[];
  ipinfoEnabled: boolean;
  primaryAdapterId: string | null;
  proxyAdapterId: string | null;
}

interface SplitRoutingSettings extends SplitRoutingSettingsInput {
  mode: SplitRoutingMode;
  version: 1;
}

interface SplitRoutingPreflightResult {
  canonicalConfigPath: string | null;
  diagnostics: string[];
  environmentProxyWarning: boolean;
  mixedPort: number | null;
  ready: boolean;
  routeEndpointCount: number;
}

interface SplitRoutingState {
  activePacUrl: string | null;
  diagnostics: string[];
  environmentProxyWarning: boolean;
  lastError: string | null;
  mixedPort: number | null;
  ownedRouteCount: number;
  pendingRecovery: boolean;
  settings: SplitRoutingSettings;
  status: SplitRoutingStatus;
}

type SplitRoutingEgressObservation = 'primary' | 'proxy' | 'unknown';

interface SplitRoutingVerificationResult {
  mode?: SplitRoutingMode;
  chatgptConnectionConfirmed?: boolean;
  checkedAt: string;
  direct: {
    adapterName: string;
    localAddress: string;
    publicIp: string;
  };
  egressObservation: SplitRoutingEgressObservation;
  passed: boolean;
  proxied: {
    adapterName: string;
    localAddresses: string[];
    publicIp: string;
  };
  publicIpsDiffer: boolean;
  systemRoutingUnchanged: boolean;
}

interface ToolboxAppInfo {
  version: string;
  platform: 'win32';
}

interface ToolboxSafetyState {
  adapterBrokerActive: boolean;
  adapterBrokerProgress: AdapterBrokerProgress;
  helperDiagnostics: string | null;
  adapterMutationsBlocked: boolean;
  chatGptProtected: boolean;
  globalWebsiteNetworkWritesDisabled: boolean;
  pendingRecoveryCount: number;
  recoveryHealth: 'blocked' | 'degraded' | 'healthy';
  splitRoutingStatus: SplitRoutingStatus;
  wechatDryRunOnly: true;
  wechatRecoveryPending: boolean;
  wechatStatus: WeChatAutoReplyStatus;
}

type AdapterBrokerPhase = 'idle' | 'authorizing' | 'connecting' | 'handshaking' | 'ready' | 'applying' | 'restoring' | 'error';

interface AdapterBrokerProgress {
  phase: AdapterBrokerPhase;
  detail: string | null;
  canCancel: boolean;
}

interface WeChatAutoReplySettings {
  allowlist: string[];
  cooldownMinutes: number;
  dailyLimit: number;
  dryRun: boolean;
  enabled: boolean;
  replyText: string;
  version: 2;
}

interface WeChatAutoReplySettingsInput {
  allowlist: string[];
  cooldownMinutes: number;
  dailyLimit: number;
  dryRun: boolean;
  replyText: string;
}

type WeChatAutoReplyStatus =
  | 'error'
  | 'running'
  | 'starting'
  | 'stopped';

type WeChatAutoReplySkipReason =
  | 'cooldown'
  | 'daily-limit'
  | 'draft-present'
  | 'system-message'
  | 'outgoing-message';

interface WeChatAutoReplyState {
  environmentPath: string;
  environmentReady: boolean;
  lastError: string | null;
  lastEventAt: string | null;
  lastEventContact: string | null;
  lastEventType: 'detected' | 'reply' | 'skipped' | null;
  lastSkipReason: WeChatAutoReplySkipReason | null;
  settings: WeChatAutoReplySettings;
  status: WeChatAutoReplyStatus;
  upstreamCommit: string;
  wechatVersion: '4.1.12.26';
}

interface NetworkSwitcherApi {
  cancelAdapterOperation: () => Promise<void>;
  activateSplitRouting: (
    settings: SplitRoutingSettingsInput,
    controllerSecret: string,
  ) => Promise<NetworkSwitcherState>;
  deactivateSplitRouting: (
    controllerSecret: string,
  ) => Promise<NetworkSwitcherState>;
  getState: () => Promise<NetworkSwitcherState>;
  preflightSplitRouting: (
    settings: SplitRoutingSettingsInput,
    controllerSecret: string,
  ) => Promise<SplitRoutingPreflightResult>;
  restoreAdapterStates: () => Promise<NetworkSwitcherState>;
  saveSplitRoutingSettings: (
    settings: SplitRoutingSettingsInput,
  ) => Promise<NetworkSwitcherState>;
  selectAdapter: (adapterId: string) => Promise<NetworkSwitcherState>;
  setAdapterState: (
    adapterId: string,
    action: AdapterAction,
  ) => Promise<NetworkSwitcherState>;
  verifySplitRouting: () => Promise<SplitRoutingVerificationResult>;
  onStateChanged: (
    callback: (state: NetworkSwitcherState) => void,
  ) => () => void;
}

interface WeChatAutoReplyApi {
  getState: () => Promise<WeChatAutoReplyState>;
  saveSettings: (
    settings: WeChatAutoReplySettingsInput,
  ) => Promise<WeChatAutoReplyState>;
  start: (
    settings: WeChatAutoReplySettingsInput,
  ) => Promise<WeChatAutoReplyState>;
  stop: () => Promise<WeChatAutoReplyState>;
  onStateChanged: (
    callback: (state: WeChatAutoReplyState) => void,
  ) => () => void;
}

interface CherryToolboxApi {
  app: {
    getInfo: () => Promise<ToolboxAppInfo>;
    leaveComponent: (component: ToolboxComponentId) => Promise<void>;
  };
  networkSwitcher: NetworkSwitcherApi;
  safety: {
    getState: () => Promise<ToolboxSafetyState>;
    onStateChanged: (
      callback: (state: ToolboxSafetyState) => void,
    ) => () => void;
  };
  wechatAutoReply: WeChatAutoReplyApi;
}

interface Window {
  cherryToolbox: CherryToolboxApi;
}
