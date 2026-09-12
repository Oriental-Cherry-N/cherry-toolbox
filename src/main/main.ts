import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  type MenuItemConstructorOptions,
  net,
  powerMonitor,
  protocol,
  session,
  shell,
  Tray,
  type WebFrameMain,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { cleanupAll } from './lifecycle';
import { nativeHelperDiagnostics } from './native-helper';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { IPC_CHANNELS } from '../common/channels';
import { AdapterRecoveryBroker } from './structured-adapter-broker';
import { watchAdapterConnection } from './connection-monitor';
import {
  isAdapterAction,
  isSafeAdapterId,
  listNetworkAdapters,
  resolveSelectedAdapterId,
  setNetworkAdapterStates,
} from './network';
import {
  buildRecoveryPlan,
  loadRecoveryJournal,
  recoveryJournalHealth,
  pendingRecoveryCount,
  reconcileRecoveryJournal,
  saveRecoveryJournal,
  trackAdapterChange,
  type RecoveryJournal,
} from './recovery';
import { loadSelectedAdapterId } from './settings';
import {
  assertAdapterMutationIsSafe,
  inspectProtectedNetworkClients,
} from './safety-guard';
import { SplitRoutingService } from './split-routing';
import { DEFAULT_SPLIT_ROUTING_SETTINGS } from './split-routing-settings';
import { WeChatAutoReplyService } from './wechat-auto-reply';

const isSquirrelStartup = Boolean(require('electron-squirrel-startup'));
app.setName('Cherry Toolbox');
const hasSingleInstanceLock = isSquirrelStartup
  ? false
  : app.requestSingleInstanceLock();

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const INDEX_HTML_PATH = path.join(PROJECT_ROOT, 'static', 'index.html');
const ICON_PATH = path.join(
  PROJECT_ROOT,
  'static',
  'assets',
  'cherry-toolbox.ico',
);
const BRAND_IMAGE_PATH = path.join(
  PROJECT_ROOT,
  'static',
  'assets',
  'cherry-toolbox.png',
);
const START_HIDDEN_ARGUMENT = '--hidden';
const APP_SCHEME = 'cherry-toolbox';
const APP_HOST = 'bundle';
const INDEX_URL = `${APP_SCHEME}://${APP_HOST}/static/index.html`;
const APP_RESOURCES = new Map<string, string>([
  ['/static/index.html', INDEX_HTML_PATH],
  ['/static/assets/cherry-toolbox.ico', ICON_PATH],
  ['/static/assets/cherry-toolbox.png', BRAND_IMAGE_PATH],
  ['/static/styles.css', path.join(PROJECT_ROOT, 'static', 'styles.css')],
  [
    '/dist/renderer/renderer.js',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'renderer.js'),
  ],
  [
    '/dist/renderer/renderer.js.map',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'renderer.js.map'),
  ],
  [
    '/dist/renderer/i18n.js',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'i18n.js'),
  ],
  [
    '/dist/renderer/i18n.js.map',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'i18n.js.map'),
  ],
  [
    '/dist/renderer/tools.js',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'tools.js'),
  ],
  [
    '/dist/renderer/tools.js.map',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'tools.js.map'),
  ],
  [
    '/dist/renderer/network-switcher.js',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'network-switcher.js'),
  ],
  [
    '/dist/renderer/network-switcher.js.map',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'network-switcher.js.map'),
  ],
  [
    '/dist/renderer/safety.js',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'safety.js'),
  ],
  [
    '/dist/renderer/safety.js.map',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'safety.js.map'),
  ],
  [
    '/dist/renderer/wechat-auto-reply.js',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'wechat-auto-reply.js'),
  ],
  [
    '/dist/renderer/wechat-auto-reply.js.map',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'wechat-auto-reply.js.map'),
  ],
]);

protocol.registerSchemesAsPrivileged([
  {
    privileges: {
      corsEnabled: true,
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
    scheme: APP_SCHEME,
  },
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let quitApproved = false;
let quitInProgress = false;
let operationInProgress = false;
let cleanupInProgress: Promise<void> | null = null;
let recoveryHealth: ToolboxSafetyState['recoveryHealth'] = 'blocked';
let protectedClientCheckSucceeded = false;
let selectedAdapterId: string | null = null;
let userDataDirectory = '';
let refreshInProgress: Promise<NetworkSwitcherState> | null = null;
let recoveryJournal: RecoveryJournal | null = null;
let recoveryJournalLoadError: Error | null = null;
let adapterMutationInFlight = false;
let adapterRecoveryBroker: AdapterRecoveryBroker | null = null;
let adapterRecoveryBrokerError: Error | null = null;
let windowCloseCleanupInProgress = false;
let weChatAutoReplyService: WeChatAutoReplyService | null = null;
let splitRoutingService: SplitRoutingService | null = null;
let weChatSafetyHandlersRegistered = false;
const recoverySessionId = randomUUID();
const connectionMonitors = new Map<string, AbortController>();
let currentState: NetworkSwitcherState = {
  adapters: [],
  pendingRestoreCount: 0,
  selectedAdapterId: null,
  splitRouting: {
    activePacUrl: null,
    diagnostics: [],
    environmentProxyWarning: false,
    lastError: null,
    mixedPort: null,
    ownedRouteCount: 0,
    pendingRecovery: false,
    settings: { ...DEFAULT_SPLIT_ROUTING_SETTINGS },
    status: 'inactive',
  },
};

interface TrayLabels {
  adapters: string;
  disable: string;
  enable: string;
  noAdapters: string;
  networkSwitcher: string;
  quit: string;
  refresh: string;
  restore: string;
  selected: string;
  show: string;
}

interface RecoveryDialogLabels {
  cancel: string;
  damagedMessage: string;
  damagedTitle: string;
  crashMessage: string;
  crashTitle: string;
  restore: string;
  restoreFailedMessage: string;
  restoreFailedTitle: string;
  retry: string;
}

function trayLabels(): TrayLabels {
  const locale = app.getLocale().toLocaleLowerCase('en-US');
  if (locale.startsWith('zh')) {
    return {
      adapters: '选择网卡',
      disable: '禁用',
      enable: '启用',
      noAdapters: '未发现网卡',
      networkSwitcher: '网络切换器',
      quit: '退出',
      refresh: '刷新',
      restore: '恢复更改',
      selected: '当前网卡',
      show: '显示 Cherry Toolbox',
    };
  }
  if (locale.startsWith('fr')) {
    return {
      adapters: 'Choisir une carte',
      disable: 'Désactiver',
      enable: 'Activer',
      noAdapters: 'Aucune carte réseau',
      networkSwitcher: 'Sélecteur de connexion',
      quit: 'Quitter',
      refresh: 'Actualiser',
      restore: 'Restaurer les modifications',
      selected: 'Carte sélectionnée',
      show: 'Afficher Cherry Toolbox',
    };
  }
  return {
    adapters: 'Choose adapter',
    disable: 'Disable',
    enable: 'Enable',
    noAdapters: 'No network adapters',
    networkSwitcher: 'Network Switcher',
    quit: 'Quit',
    refresh: 'Refresh',
    restore: 'Restore changes',
    selected: 'Selected adapter',
    show: 'Show Cherry Toolbox',
  };
}

function recoveryDialogLabels(): RecoveryDialogLabels {
  const locale = app.getLocale().toLocaleLowerCase('en-US');
  if (locale.startsWith('zh')) {
    return {
      cancel: '取消',
      damagedMessage:
        '所有恢复记录副本均无法读取。文件将原样保留，所有变更功能已锁定；请先使用安全恢复中心处理。',
      damagedTitle: '无法读取恢复记录',
      crashMessage:
        '检测到上次运行留下的网络更改，程序将立即尝试恢复。',
      crashTitle: '发现未完成的恢复记录',
      restore: '立即恢复',
      restoreFailedMessage:
        '部分网络更改未能恢复。恢复记录和恢复守护仍会保留；安全退出将被拒绝。',
      restoreFailedTitle: '网卡恢复未完成',
      retry: '重试',
    };
  }
  if (locale.startsWith('fr')) {
    return {
      cancel: 'Annuler',
      damagedMessage:
        "Toutes les copies du journal sont illisibles. Elles sont conservées et toutes les mutations sont verrouillées.",
      damagedTitle: 'Journal de récupération illisible',
      crashMessage:
        "Des modifications d'une session précédente seront restaurées immédiatement.",
      crashTitle: 'Récupération inachevée détectée',
      restore: 'Restaurer maintenant',
      restoreFailedMessage:
        "Certaines cartes n'ont pas pu être restaurées. Le journal a été conservé.",
      restoreFailedTitle: 'Restauration inachevée',
      retry: 'Réessayer',
    };
  }
  return {
    cancel: 'Cancel',
    damagedMessage:
      'Every redundant recovery copy is unreadable. The files were preserved and all mutation features are locked until recovery is resolved.',
    damagedTitle: 'Recovery journal could not be read',
    crashMessage:
      'Changes from the previous session are pending and will be restored immediately.',
    crashTitle: 'Unfinished recovery detected',
    restore: 'Restore now',
    restoreFailedMessage:
      'Some network changes could not be restored. The recovery journal was kept.',
    restoreFailedTitle: 'Recovery incomplete',
    retry: 'Retry',
  };
}

function selectedAdapter(
  state: NetworkSwitcherState = currentState,
): NetworkAdapter | null {
  return (
    state.adapters.find((adapter) => adapter.id === state.selectedAdapterId) ??
    null
  );
}

function trustedRendererFrame(frame: WebFrameMain | null): boolean {
  return frame?.url === INDEX_URL;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!trustedRendererFrame(event.senderFrame)) {
    throw new Error('Rejected an IPC request from an untrusted page.');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'An unexpected error occurred.';
}

function showError(error: unknown): void {
  dialog.showErrorBox('Cherry Toolbox', errorMessage(error));
}

function pendingRestoreCount(): number {
  return pendingRecoveryCount(recoveryJournal);
}

function pendingRecoveryDetails(): string {
  return [
    ...(recoveryJournal?.adapters.map((record) => record.adapterName) ?? []),
    ...(recoveryJournal?.splitRouting
      ? ['Website split routing (PAC, FlClash, and WLAN routes)']
      : []),
  ].join('\n');
}

function applyRecoveryMetadata(): void {
  currentState = {
    ...currentState,
    pendingRestoreCount: pendingRestoreCount(),
    splitRouting: splitRoutingService?.getState() ?? currentState.splitRouting,
  };
}

async function replaceRecoveryJournal(
  nextJournal: RecoveryJournal | null,
): Promise<void> {
  await saveRecoveryJournal(userDataDirectory, nextJournal);
  recoveryJournal = nextJournal;
  recoveryHealth = await recoveryJournalHealth(userDataDirectory);
  applyRecoveryMetadata();
}

async function reconcileTrackedChanges(
  adapters: readonly NetworkAdapter[],
): Promise<void> {
  if (adapterMutationInFlight) return;
  const nextJournal = reconcileRecoveryJournal(recoveryJournal, adapters);
  if (nextJournal !== recoveryJournal)
    await replaceRecoveryJournal(nextJournal);
}

function notifyStateChanged(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    IPC_CHANNELS.networkSwitcherStateChanged,
    currentState,
  );
  notifySafetyStateChanged();
}

function safetyState(): ToolboxSafetyState {
  const split = splitRoutingService?.getState() ?? currentState.splitRouting;
  const wechatRecoveryPending = weChatAutoReplyService?.pendingRecovery ?? false;
  return {
    adapterBrokerActive: adapterRecoveryBroker?.isActive ?? false,
    adapterBrokerProgress: adapterRecoveryBroker?.progress ?? { phase: 'idle', detail: null, canCancel: false },
    helperDiagnostics: nativeHelperDiagnostics(),
    adapterMutationsBlocked:
      recoveryJournalLoadError !== null || adapterRecoveryBrokerError !== null || adapterRecoveryBroker?.progress?.phase === 'error' || recoveryHealth !== 'healthy' || split.pendingRecovery || wechatRecoveryPending,
    chatGptProtected: protectedClientCheckSucceeded,
    globalWebsiteNetworkWritesDisabled: !recoveryJournal?.splitRouting,
    pendingRecoveryCount: pendingRestoreCount() +
      Number(split.pendingRecovery && !recoveryJournal?.splitRouting) + Number(wechatRecoveryPending),
    recoveryHealth,
    splitRoutingStatus: split.status,
    wechatDryRunOnly: true,
    wechatRecoveryPending,
    wechatStatus: weChatAutoReplyService?.getState().status ?? 'stopped',
  };
}

function notifySafetyStateChanged(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    IPC_CHANNELS.safetyStateChanged,
    safetyState(),
  );
}

function notifySplitRoutingStateChanged(): void {
  applyRecoveryMetadata();
  rebuildTrayMenu();
  notifyStateChanged();
}

function notifyWeChatAutoReplyStateChanged(
  state: WeChatAutoReplyState,
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    IPC_CHANNELS.wechatAutoReplyStateChanged,
    state,
  );
  notifySafetyStateChanged();
}

function stopConnectionMonitors(): void {
  for (const controller of connectionMonitors.values()) controller.abort();
  connectionMonitors.clear();
}

function startConnectionMonitor(adapterId: string): void {
  connectionMonitors.get(adapterId)?.abort();
  const controller = new AbortController();
  connectionMonitors.set(adapterId, controller);

  void watchAdapterConnection(
    adapterId,
    refreshState,
    () => notifyStateChanged(),
    {
      onError: (error) =>
        console.warn('Unable to refresh the connecting adapter:', error),
      signal: controller.signal,
    },
  ).finally(() => {
    if (connectionMonitors.get(adapterId) === controller)
      connectionMonitors.delete(adapterId);
  });
}

function rebuildTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return;

  const labels = trayLabels();
  const selected = selectedAdapter();
  const adapterItems: MenuItemConstructorOptions[] = currentState.adapters
    .length
    ? currentState.adapters.map((adapter) => ({
        checked: adapter.id === currentState.selectedAdapterId,
        click: () => {
          void selectAdapter(adapter.id).catch(showError);
        },
        label: adapter.name,
        type: 'radio',
      }))
    : [{ enabled: false, label: labels.noAdapters }];

  const networkSwitcherItems: MenuItemConstructorOptions[] = [
    {
      enabled: false,
      label: `${labels.selected}: ${selected?.name ?? '—'}`,
    },
    {
      label: labels.adapters,
      submenu: adapterItems,
    },
    { type: 'separator' },
    {
      click: () => {
        if (selected)
          void changeAdapterState(selected.id, 'enable').catch(showError);
      },
      enabled:
        Boolean(selected) &&
        selected?.enabled !== true &&
        !operationInProgress &&
        !recoveryJournal?.splitRouting,
      label: labels.enable,
    },
    {
      click: () => {
        if (selected)
          void changeAdapterState(selected.id, 'disable').catch(showError);
      },
      enabled:
        Boolean(selected) &&
        selected?.enabled !== false &&
        !operationInProgress &&
        !recoveryJournal?.splitRouting,
      label: labels.disable,
    },
    {
      click: () => {
        void refreshState().then(notifyStateChanged).catch(showError);
      },
      enabled: !operationInProgress,
      label: labels.refresh,
    },
    {
      click: () => {
        void restoreTrackedAdapterStates().catch(showError);
      },
      enabled: pendingRestoreCount() > 0 && !operationInProgress,
      label: `${labels.restore}${pendingRestoreCount() > 0 ? ` (${pendingRestoreCount()})` : ''}`,
    },
  ];

  const template: MenuItemConstructorOptions[] = [
    {
      click: showMainWindow,
      label: labels.show,
    },
    { type: 'separator' },
    {
      label: labels.networkSwitcher,
      submenu: networkSwitcherItems,
    },
    { type: 'separator' },
    {
      click: () => {
        app.quit();
      },
      label: labels.quit,
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

async function refreshState(): Promise<NetworkSwitcherState> {
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = (async () => {
    const adapters = await listNetworkAdapters();
    recoveryHealth = await recoveryJournalHealth(userDataDirectory);
    try { await inspectProtectedNetworkClients(); protectedClientCheckSucceeded = true; }
    catch { protectedClientCheckSucceeded = false; }
    const resolvedId = resolveSelectedAdapterId(adapters, selectedAdapterId);
    if (resolvedId !== selectedAdapterId) {
      selectedAdapterId = resolvedId;
    }

    currentState = {
      adapters,
      pendingRestoreCount: pendingRestoreCount(),
      selectedAdapterId,
      splitRouting: splitRoutingService?.getState() ?? currentState.splitRouting,
    };
    rebuildTrayMenu();
    return currentState;
  })().finally(() => {
    refreshInProgress = null;
  });

  return refreshInProgress;
}

async function selectAdapter(
  adapterId: string,
): Promise<NetworkSwitcherState> {
  assertMutationAdmission();
  if (!isSafeAdapterId(adapterId))
    throw new Error('Invalid network adapter identifier.');

  const state = await refreshState();
  if (!state.adapters.some((adapter) => adapter.id === adapterId)) {
    throw new Error('The selected network adapter no longer exists.');
  }

  selectedAdapterId = adapterId;
  currentState = { ...state, selectedAdapterId };
  rebuildTrayMenu();
  notifyStateChanged();
  return currentState;
}

function requireSplitRoutingService(): SplitRoutingService {
  if (!splitRoutingService) {
    throw new Error('Split routing is not initialized.');
  }
  return splitRoutingService;
}

async function saveSplitRoutingSettings(
  settings: unknown,
): Promise<NetworkSwitcherState> {
  assertMutationAdmission();
  if (operationInProgress) {
    throw new Error('Another network operation is still running.');
  }
  const service = requireSplitRoutingService();
  await service.saveSettings(settings);
  return refreshState();
}

async function preflightSplitRouting(
  settings: unknown,
  controllerSecret: unknown,
): Promise<SplitRoutingPreflightResult> {
  if (typeof controllerSecret !== 'string') {
    throw new Error('Invalid FlClash controller secret.');
  }
  if (operationInProgress) {
    throw new Error('Another network operation is still running.');
  }
  operationInProgress = true;
  rebuildTrayMenu();
  try {
    const state = await refreshState();
    return await requireSplitRoutingService().preflight(
      settings,
      controllerSecret,
      state.adapters,
    );
  } finally {
    operationInProgress = false;
    rebuildTrayMenu();
  }
}

async function activateSplitRouting(
  settings: unknown,
  controllerSecret: unknown,
): Promise<NetworkSwitcherState> {
  assertMutationAdmission();
  if (typeof controllerSecret !== 'string') {
    throw new Error('Invalid FlClash controller secret.');
  }
  if (operationInProgress) {
    throw new Error('Another network operation is still running.');
  }
  stopConnectionMonitors();
  operationInProgress = true;
  rebuildTrayMenu();
  try {
    const state = await refreshState();
    await requireSplitRoutingService().activate(
      settings,
      controllerSecret,
      state.adapters,
    );
    return await refreshState();
  } finally {
    operationInProgress = false;
    rebuildTrayMenu();
    notifySplitRoutingStateChanged();
  }
}

async function deactivateSplitRouting(
  controllerSecret: unknown,
): Promise<NetworkSwitcherState> {
  if (typeof controllerSecret !== 'string') {
    throw new Error('Invalid FlClash controller secret.');
  }
  if (operationInProgress) {
    throw new Error('Another network operation is still running.');
  }
  stopConnectionMonitors();
  operationInProgress = true;
  rebuildTrayMenu();
  try {
    const restoringGlobalNetworking = Boolean(recoveryJournal?.splitRouting);
    await requireSplitRoutingService().restore(controllerSecret);
    // Isolated browsing never changes adapters. Only legacy global recovery
    // needs a fresh Windows network scan before navigation can finish.
    if (restoringGlobalNetworking) return await refreshState();
    applyRecoveryMetadata();
    return currentState;
  } finally {
    operationInProgress = false;
    rebuildTrayMenu();
    notifySplitRoutingStateChanged();
  }
}

async function verifySplitRouting(): Promise<SplitRoutingVerificationResult> {
  if (operationInProgress) {
    throw new Error('Another network operation is still running.');
  }
  operationInProgress = true;
  rebuildTrayMenu();
  try {
    return await requireSplitRoutingService().verifyPaths();
  } finally {
    operationInProgress = false;
    rebuildTrayMenu();
  }
}

async function changeAdapterState(
  adapterId: string,
  action: AdapterAction,
): Promise<NetworkSwitcherState> {
  assertMutationAdmission();
  if (!isSafeAdapterId(adapterId))
    throw new Error('Invalid network adapter identifier.');
  if (!isAdapterAction(action)) throw new Error('Unsupported adapter action.');
  if (recoveryJournalLoadError) {
    throw new Error(
      'The recovery journal could not be loaded, so network changes are disabled.',
    );
  }
  if (adapterRecoveryBrokerError) {
    throw new Error(
      `The independent adapter recovery broker needs attention: ${adapterRecoveryBrokerError.message}`,
    );
  }
  if (recoveryJournal?.splitRouting) {
    throw new Error('Restore split routing before changing adapter state.');
  }
  const split = splitRoutingService?.getState();
  if (split && (split.pendingRecovery || split.status === 'active' || split.status === 'preparing' || split.status === 'restoring')) {
    throw new Error('Close and clean up the isolated browser before changing its network adapters.');
  }
  if (operationInProgress)
    throw new Error('Another network adapter operation is still running.');

  stopConnectionMonitors();
  operationInProgress = true;
  rebuildTrayMenu();
  let brokerAttempted = false;
  const previousJournal = recoveryJournal;
  let journalRecorded = false;
  try {
    const state = await refreshState();
    const adapter = state.adapters.find(
      (candidate) => candidate.id === adapterId,
    );
    if (!adapter)
      throw new Error('The selected network adapter no longer exists.');

    const protectedClients = await inspectProtectedNetworkClients();
    assertAdapterMutationIsSafe(
      state.adapters,
      adapter,
      action,
      protectedClients,
    );

    const requestedEnabled = action === 'enable';
    if (adapter.enabled === requestedEnabled) return state;
    if (!adapterRecoveryBroker) throw new Error('The independent adapter recovery broker is unavailable.');
    await adapterRecoveryBroker.prepare();
    assertMutationAdmission();
    const nextJournal = trackAdapterChange(
      recoveryJournal,
      adapter,
      requestedEnabled,
      recoverySessionId,
    );
    await replaceRecoveryJournal(nextJournal);
    journalRecorded = true;
    rebuildTrayMenu();
    notifyStateChanged();

    adapterMutationInFlight = true;
    try {
      if (!adapterRecoveryBroker) {
        throw new Error('The independent adapter recovery broker is unavailable.');
      }
      if (cleanupInProgress || quitInProgress || windowCloseCleanupInProgress) {
        throw new Error('Adapter startup was cancelled because the application is stopping.');
      }
      brokerAttempted = true;
      await adapterRecoveryBroker.apply(nextJournal.adapters);
    } finally {
      adapterMutationInFlight = false;
    }
    selectedAdapterId = adapter.id;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const refreshed = await refreshState();
    notifyStateChanged();
    if (
      action === 'enable' &&
      refreshed.adapters.find((candidate) => candidate.id === adapter.id)
        ?.connected !== true
    ) {
      startConnectionMonitor(adapter.id);
    }
    return refreshed;
  } catch (error) {
    let recoveryConfirmed = false;
    if (!brokerAttempted && journalRecorded) {
      // Nothing was submitted to the broker. Undo only this request's intent,
      // preserving all recovery evidence from earlier operations.
      await replaceRecoveryJournal(previousJournal);
    }
    if (brokerAttempted && adapterRecoveryBroker) {
      adapterRecoveryBrokerError =
        error instanceof Error
          ? error
          : new Error('The independent adapter recovery broker failed.');
      try {
        await adapterRecoveryBroker.restore();
        recoveryConfirmed = true;
      } catch (recoveryError) {
        console.warn('Independent adapter recovery remains pending:', recoveryError);
      }
    }
    try {
      if (recoveryConfirmed) {
        await reconcileTrackedChanges(await listNetworkAdapters());
        if (pendingRestoreCount() === 0) adapterRecoveryBrokerError = null;
      }
      await refreshState();
      notifyStateChanged();
    } catch (refreshError) {
      console.warn(
        'Unable to reconcile the recovery journal after a failed change:',
        refreshError,
      );
    }
    throw error;
  } finally {
    operationInProgress = false;
    rebuildTrayMenu();
  }
}

async function restoreTrackedAdapterStates(
  includeSplitRouting = true,
): Promise<NetworkSwitcherState> {
  if (operationInProgress)
    throw new Error('Another network adapter operation is still running.');

  stopConnectionMonitors();
  operationInProgress = true;
  rebuildTrayMenu();
  try {
    const restorationErrors: Error[] = [];
    if (includeSplitRouting && splitRoutingService) {
      try { await requireSplitRoutingService().restore(); }
      catch (error) { restorationErrors.push(error instanceof Error ? error : new Error(String(error))); }
    }
    let brokerRestoreError: Error | null = null;
    let brokerRestored = false;
    if (adapterRecoveryBroker) {
      try {
        // A failed UAC launch may leave a durable marker without a live pipe.
        brokerRestored = await adapterRecoveryBroker.restore();
        if (brokerRestored)
          await new Promise((resolve) => setTimeout(resolve, 750));
      } catch (error) {
        brokerRestoreError =
          error instanceof Error
            ? error
            : new Error('The independent recovery broker failed.');
      }
    }
    // Corrupt user evidence must not prevent the isolated session or the
    // independent, administrator-owned recovery store from being cleaned up.
    if (recoveryJournalLoadError) {
      throw new AggregateError([
        ...restorationErrors,
        ...(brokerRestoreError ? [brokerRestoreError] : []),
        recoveryJournalLoadError,
      ], 'Independent cleanup was attempted; the damaged recovery journal still needs attention.');
    }
    if (!brokerRestored && !brokerRestoreError && !adapterRecoveryBrokerError &&
        restorationErrors.length === 0 && pendingRestoreCount() === 0) {
      recoveryHealth = await recoveryJournalHealth(userDataDirectory);
      if (recoveryHealth === 'healthy') {
        // Nothing changed at the OS level. Restore the page's selection using
        // its existing adapter list instead of launching seven PowerShell reads.
        selectedAdapterId = resolveSelectedAdapterId(
          currentState.adapters, await loadSelectedAdapterId(userDataDirectory),
        );
        currentState = { ...currentState, selectedAdapterId };
        applyRecoveryMetadata();
        rebuildTrayMenu();
        notifyStateChanged();
        return currentState;
      }
    }
    const state = await refreshState();
    const plan = buildRecoveryPlan(recoveryJournal, state.adapters);
    if (plan.actions.length > 0) {
      // A one-shot elevated restore is the independent fallback for legacy
      // journals or a broker that exited before it could acknowledge cleanup.
      try {
        await cleanupAll(plan.actions.map(change => () => setNetworkAdapterStates([change])));
      } catch (error) {
        const fallbackError =
          error instanceof Error
            ? error
            : new Error('The one-shot adapter restore failed.');
        if (brokerRestoreError) {
          throw new AggregateError(
            [brokerRestoreError, fallbackError],
            'Both independent adapter recovery methods failed.',
          );
        }
        throw fallbackError;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    if (brokerRestoreError) {
      try {
        if (!await adapterRecoveryBroker?.confirmRestored()) throw brokerRestoreError;
      } catch (confirmationError) {
        adapterRecoveryBrokerError = brokerRestoreError;
        throw new AggregateError([brokerRestoreError, confirmationError],
          'Adapter recovery is not yet confirmed. Original states have been retained.');
      }
    }
    await reconcileTrackedChanges(await listNetworkAdapters());
    const refreshed = await refreshState();
    notifyStateChanged();
    if (refreshed.pendingRestoreCount > 0) {
      const names = pendingRecoveryDetails().replaceAll('\n', ', ');
      throw new AggregateError(
        [
          ...(brokerRestoreError ? [brokerRestoreError] : []),
          new Error(
            `Some network adapters are still awaiting recovery${names ? `: ${names}` : '.'}`,
          ),
        ],
        `Some network adapters are still awaiting recovery${names ? `: ${names}` : '.'}`,
      );
    }
    adapterRecoveryBrokerError = null;
    if (restorationErrors.length) throw new AggregateError(restorationErrors, restorationErrors.map(error => error.message).join('\n'));
    await replaceRecoveryJournal(recoveryJournal);
    selectedAdapterId = await loadSelectedAdapterId(userDataDirectory);
    const restored = await refreshState();
    notifyStateChanged();
    if (!quitInProgress) {
      for (const change of plan.actions) {
        if (change.action === 'enable')
          startConnectionMonitor(change.adapter.id);
      }
    }
    return restored;
  } catch (error) {
    try {
      await refreshState();
      notifyStateChanged();
    } catch (refreshError) {
      console.warn(
        'Unable to reconcile the recovery journal after recovery failed:',
        refreshError,
      );
    }
    throw error;
  } finally {
    operationInProgress = false;
    rebuildTrayMenu();
  }
}

function assertMutationAdmission(): void {
  if (cleanupInProgress || quitInProgress || windowCloseCleanupInProgress) throw new Error('The application is stopping; new changes are refused.');
  if (recoveryJournalLoadError || recoveryHealth !== 'healthy') throw new Error('Recovery evidence needs attention; new changes are refused.');
  if (adapterRecoveryBrokerError) throw adapterRecoveryBrokerError;
  if (adapterRecoveryBroker?.progress?.phase === 'error') throw new Error(adapterRecoveryBroker.progress.detail ?? 'The adapter connection needs recovery.');
  if (splitRoutingService?.getState().pendingRecovery || weChatAutoReplyService?.pendingRecovery)
    throw new Error('A component still has pending cleanup; retry recovery before starting new changes.');
}

function cleanupApplicationComponents(): Promise<void> {
  if (cleanupInProgress) return cleanupInProgress;
  adapterRecoveryBroker?.cancelPendingStart();
  cleanupInProgress = cleanupAll([
    async () => { await weChatAutoReplyService?.shutdown(); },
    async () => {
      const deadline = Date.now() + 130_000;
      while (operationInProgress) {
        if (Date.now() > deadline) throw new Error('A network operation did not settle; recovery remains pending.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await restoreTrackedAdapterStates();
    },
  ]).finally(() => { cleanupInProgress = null; notifySafetyStateChanged(); });
  return cleanupInProgress;
}

function registerIpcHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.componentLeave,
    async (event, component: unknown): Promise<void> => {
      assertTrustedSender(event);
      if (
        component !== 'network-switcher' &&
        component !== 'split-routing' &&
        component !== 'wechat-auto-reply'
      ) {
        throw new Error('Invalid toolbox component identifier.');
      }
      if (cleanupInProgress || quitInProgress) throw new Error('Application cleanup is already in progress.');
      if (component === 'wechat-auto-reply') {
        if (!weChatAutoReplyService) {
          throw new Error('WeChat Auto Reply is not initialized.');
        }
        await weChatAutoReplyService.stop();
        return;
      }
      if (component === 'split-routing') {
        await deactivateSplitRouting('');
        return;
      }
      await restoreTrackedAdapterStates(false);
    },
  );
  ipcMain.handle(IPC_CHANNELS.getAppInfo, (event): ToolboxAppInfo => {
    assertTrustedSender(event);
    return { platform: 'win32', version: app.getVersion() };
  });
  ipcMain.handle(IPC_CHANNELS.safetyGetState, (event): ToolboxSafetyState => {
    assertTrustedSender(event);
    return safetyState();
  });
  ipcMain.handle(IPC_CHANNELS.networkSwitcherGetState, async (event) => {
    assertTrustedSender(event);
    return refreshState();
  });
  ipcMain.handle(IPC_CHANNELS.networkSwitcherCancelAdapterOperation, (event) => {
    assertTrustedSender(event);
    adapterRecoveryBroker?.cancelPendingStart();
  });
  ipcMain.handle(
    IPC_CHANNELS.networkSwitcherSaveSplitRoutingSettings,
    async (event, settings: unknown) => {
      assertTrustedSender(event);
      return saveSplitRoutingSettings(settings);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.networkSwitcherPreflightSplitRouting,
    async (event, settings: unknown, controllerSecret: unknown) => {
      assertTrustedSender(event);
      return preflightSplitRouting(settings, controllerSecret);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.networkSwitcherActivateSplitRouting,
    async (event, settings: unknown, controllerSecret: unknown) => {
      assertTrustedSender(event);
      return activateSplitRouting(settings, controllerSecret);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.networkSwitcherDeactivateSplitRouting,
    async (event, controllerSecret: unknown) => {
      assertTrustedSender(event);
      return deactivateSplitRouting(controllerSecret);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.networkSwitcherVerifySplitRouting,
    async (event) => {
      assertTrustedSender(event);
      return verifySplitRouting();
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.networkSwitcherRestoreAdapterStates,
    async (event) => {
      assertTrustedSender(event);
      return restoreTrackedAdapterStates();
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.networkSwitcherSelectAdapter,
    async (event, adapterId: unknown) => {
      assertTrustedSender(event);
      if (typeof adapterId !== 'string')
        throw new Error('Invalid network adapter identifier.');
      return selectAdapter(adapterId);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.networkSwitcherSetAdapterState,
    async (event, adapterId: unknown, action: unknown) => {
      assertTrustedSender(event);
      if (typeof adapterId !== 'string')
        throw new Error('Invalid network adapter identifier.');
      if (!isAdapterAction(action))
        throw new Error('Unsupported adapter action.');
      return changeAdapterState(adapterId, action);
    },
  );
  ipcMain.handle(IPC_CHANNELS.wechatAutoReplyGetState, (event) => {
    assertTrustedSender(event);
    if (!weChatAutoReplyService)
      throw new Error('WeChat Auto Reply is not initialized.');
    return weChatAutoReplyService.getState();
  });
  ipcMain.handle(
    IPC_CHANNELS.wechatAutoReplySaveSettings,
    async (event, settings: unknown) => {
      assertTrustedSender(event);
      if (!weChatAutoReplyService)
        throw new Error('WeChat Auto Reply is not initialized.');
      assertMutationAdmission();
      return weChatAutoReplyService.saveSettings(settings);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.wechatAutoReplyStart,
    async (event, settings: unknown) => {
      assertTrustedSender(event);
      if (!weChatAutoReplyService)
        throw new Error('WeChat Auto Reply is not initialized.');
      assertMutationAdmission();
      return weChatAutoReplyService.start(settings);
    },
  );
  ipcMain.handle(IPC_CHANNELS.wechatAutoReplyStop, async (event) => {
    assertTrustedSender(event);
    if (!weChatAutoReplyService)
      throw new Error('WeChat Auto Reply is not initialized.');
    return weChatAutoReplyService.stop();
  });
}

function stopWeChatAutoReplyForSafety(reason: string): void {
  void cleanupApplicationComponents().catch((error: unknown) => {
    console.warn(reason);
    console.warn('Unable to stop WeChat Auto Reply safely:', error);
  });
}

function registerWeChatSafetyHandlers(): void {
  if (weChatSafetyHandlersRegistered) return;
  weChatSafetyHandlersRegistered = true;
  powerMonitor.on('lock-screen', () => {
    stopWeChatAutoReplyForSafety(
      'Auto reply stopped because Windows was locked. Start it manually when you return.',
    );
  });
  powerMonitor.on('suspend', () => {
    stopWeChatAutoReplyForSafety(
      'Auto reply stopped because Windows entered sleep. Start it manually after resume.',
    );
  });
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.search === '' &&
      url.hash === '' &&
      (url.href ===
        'https://github.com/Oriental-Cherry-N/cherry-toolbox' ||
        url.href ===
          'https://github.com/Oriental-Cherry-N/cherry-toolbox/blob/main/LICENSE' ||
        url.href === 'https://github.com/Hello-Mr-Crab/pywechat')
    );
  } catch {
    return false;
  }
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#120b11',
    height: 680,
    icon: ICON_PATH,
    minHeight: 560,
    minWidth: 760,
    show: false,
    title: 'Cherry Toolbox',
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      preload: path.join(__dirname, '..', 'common', 'preload.js'),
      sandbox: true,
      webSecurity: true,
    },
    width: 980,
  });

  mainWindow = window;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== INDEX_URL) event.preventDefault();
  });
  window.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    if (windowCloseCleanupInProgress) return;
    windowCloseCleanupInProgress = true;
    void (async () => {
      try {
        await cleanupApplicationComponents();
        window.hide();
      } catch (error) {
        showError(error);
      } finally {
        windowCloseCleanupInProgress = false;
      }
    })();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.on('render-process-gone', () => {
    void cleanupApplicationComponents().catch(showError);
  });
  window.webContents.on('unresponsive', () => {
    void cleanupApplicationComponents().catch(showError);
  });
  window.on('query-session-end', event => {
    event.preventDefault();
    void cleanupApplicationComponents().catch(showError);
  });
  window.on('minimize', () => {
    window.hide();
  });
  window.once('ready-to-show', () => {
    if (!process.argv.includes(START_HIDDEN_ARGUMENT)) window.show();
  });
  void window.loadURL(INDEX_URL).catch(showError);
}

function createTray(): void {
  if (tray && !tray.isDestroyed()) return;
  tray = new Tray(ICON_PATH);
  tray.setToolTip('Cherry Toolbox');
  tray.on('click', showMainWindow);
  rebuildTrayMenu();
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  mainWindow?.show();
  mainWindow?.focus();
  void refreshState().then(notifyStateChanged).catch(showError);
}

function configureSessionSecurity(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );
}

function configureAppProtocol(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const requestUrl = new URL(request.url);
    const resourcePath =
      request.method === 'GET' && requestUrl.hostname === APP_HOST
        ? APP_RESOURCES.get(requestUrl.pathname)
        : undefined;
    if (!resourcePath) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(resourcePath).href);
  });
}

async function showRecoveryFailure(error: unknown): Promise<void> {
  const labels = recoveryDialogLabels();
  await dialog.showMessageBox({
    detail: errorMessage(error),
    message: labels.restoreFailedMessage,
    title: labels.restoreFailedTitle,
    type: 'error',
  });
}

async function handleRecoveryLoadFailure(): Promise<boolean> {
  if (!recoveryJournalLoadError) return true;
  const labels = recoveryDialogLabels();
  await dialog.showMessageBox({
    buttons: [labels.cancel],
    cancelId: 0,
    defaultId: 0,
    detail: errorMessage(recoveryJournalLoadError),
    message: labels.damagedMessage,
    noLink: true,
    title: labels.damagedTitle,
    type: 'error',
  });
  // Never delete damaged recovery evidence.  The application continues in a
  // read-only recovery-blocked mode; every mutating IPC checks this error.
  return true;
}

async function handleInterruptedRecovery(): Promise<boolean> {
  if (pendingRestoreCount() === 0 || recoveryJournalLoadError) return true;
  const labels = recoveryDialogLabels();
  await dialog.showMessageBox({
    buttons: [labels.restore],
    cancelId: 0,
    defaultId: 0,
    detail: pendingRecoveryDetails(),
    message: labels.crashMessage,
    noLink: true,
    title: labels.crashTitle,
    type: 'warning',
  });
  try {
    await restoreTrackedAdapterStates();
  } catch (error) {
    await showRecoveryFailure(error);
  }
  return true;
}

async function requestApplicationQuit(): Promise<void> {
  if (quitApproved || quitInProgress) return;

  quitInProgress = true;
  try {
    const labels = recoveryDialogLabels();
    while (true) {
      try {
        await cleanupApplicationComponents();
        break;
      } catch (error) {
        const result = await dialog.showMessageBox({
          buttons: [labels.retry, labels.cancel],
          cancelId: 1,
          defaultId: 0,
          detail: errorMessage(error),
          message: labels.restoreFailedMessage,
          noLink: true,
          title: labels.restoreFailedTitle,
          type: 'error',
        });
        if (result.response === 0) continue;
        return;
      }
    }

    stopConnectionMonitors();
    quitApproved = true;
    isQuitting = true;
    app.quit();
  } catch (error) {
    showError(error);
  } finally {
    if (!quitApproved) quitInProgress = false;
  }
}

async function startApplication(): Promise<void> {
  if (process.platform !== 'win32') {
    dialog.showErrorBox(
      'Incompatible OS',
      'Cherry Toolbox supports Windows only.',
    );
    app.quit();
    return;
  }

  app.setAppUserModelId('io.github.orientalcherryn.cherrytoolbox');
  Menu.setApplicationMenu(null);
  configureAppProtocol();
  configureSessionSecurity();
  userDataDirectory = path.join(
    app.getPath('userData'),
    'network-switcher',
  );
  adapterRecoveryBroker = new AdapterRecoveryBroker(userDataDirectory, notifySafetyStateChanged);
  try {
    await adapterRecoveryBroker.recoverOrphanedSession();
  } catch (error) {
    adapterRecoveryBrokerError =
      error instanceof Error
        ? error
        : new Error('The independent adapter recovery broker failed.');
    console.error(
      'The independent adapter recovery broker could not finish startup recovery:',
      adapterRecoveryBrokerError,
    );
  }
  weChatAutoReplyService = new WeChatAutoReplyService({
    dataDirectory: path.join(
      app.getPath('userData'),
      'wechat-auto-reply',
    ),
    projectRoot: PROJECT_ROOT,
    sourceMode: !app.isPackaged,
    stateChanged: notifyWeChatAutoReplyStateChanged,
  });
  await weChatAutoReplyService.initialize();
  registerWeChatSafetyHandlers();
  selectedAdapterId = await loadSelectedAdapterId(userDataDirectory);
  try {
    recoveryJournal = await loadRecoveryJournal(userDataDirectory);
  } catch (error) {
    recoveryJournalLoadError =
      error instanceof Error
        ? error
        : new Error('The recovery journal could not be loaded.');
  }
  if (!(await handleRecoveryLoadFailure())) {
    app.quit();
    return;
  }
  splitRoutingService = new SplitRoutingService({
    dataDirectory: userDataDirectory,
    getRecoveryJournal: () => recoveryJournal,
    replaceRecoveryJournal,
    sessionId: recoverySessionId,
    stateChanged: notifySplitRoutingStateChanged,
  });
  await splitRoutingService.initialize();
  applyRecoveryMetadata();
  registerIpcHandlers();
  createMainWindow();
  createTray();

  try {
    await refreshState();
    notifyStateChanged();
    if (!(await handleInterruptedRecovery())) return;
  } catch (error) {
    console.error('Unable to enumerate network adapters:', error);
  }
}

if (isSquirrelStartup || !hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('before-quit', (event) => {
    if (quitApproved) {
      isQuitting = true;
      return;
    }
    event.preventDefault();
    void requestApplicationQuit();
  });
  app.on('will-quit', () => {
    stopConnectionMonitors();
  });
  app.on('activate', showMainWindow);
  app.on('second-instance', (_event, _arguments, _directory, data) => {
    // The launcher checks ownership before releasing its build lock without unhiding a tray launch.
    if (typeof data !== 'object' || data === null || !('sourceProbe' in data) ||
        data.sourceProbe !== true || !('focus' in data) || data.focus !== false) showMainWindow();
  });
  void app.whenReady().then(startApplication).catch(showError);
}
