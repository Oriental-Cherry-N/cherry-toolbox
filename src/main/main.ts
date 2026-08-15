import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  type MenuItemConstructorOptions,
  net,
  protocol,
  session,
  shell,
  Tray,
  type WebFrameMain,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { IPC_CHANNELS } from '../common/channels';
import { watchAdapterConnection } from './connection-monitor';
import {
  isAdapterAction,
  isSafeAdapterId,
  listNetworkAdapters,
  resolveSelectedAdapterId,
  setNetworkAdapterState,
  setNetworkAdapterStates,
} from './network';
import {
  buildRecoveryPlan,
  loadRecoveryJournal,
  reconcileRecoveryJournal,
  saveRecoveryJournal,
  trackAdapterChange,
  type RecoveryJournal,
} from './recovery';
import { loadSelectedAdapterId, saveSelectedAdapterId } from './settings';

const isSquirrelStartup = Boolean(require('electron-squirrel-startup'));
const hasSingleInstanceLock = isSquirrelStartup
  ? false
  : app.requestSingleInstanceLock();

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const INDEX_HTML_PATH = path.join(PROJECT_ROOT, 'static', 'index.html');
const ICON_PATH = path.join(PROJECT_ROOT, 'static', 'assets', 'icon.ico');
const START_HIDDEN_ARGUMENT = '--hidden';
const APP_SCHEME = 'connection-switcher';
const APP_HOST = 'bundle';
const INDEX_URL = `${APP_SCHEME}://${APP_HOST}/static/index.html`;
const APP_RESOURCES = new Map<string, string>([
  ['/static/index.html', INDEX_HTML_PATH],
  ['/static/assets/icon.ico', ICON_PATH],
  ['/static/styles.css', path.join(PROJECT_ROOT, 'static', 'styles.css')],
  [
    '/dist/renderer/renderer.js',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'renderer.js'),
  ],
  [
    '/dist/renderer/renderer.js.map',
    path.join(PROJECT_ROOT, 'dist', 'renderer', 'renderer.js.map'),
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
let selectedAdapterId: string | null = null;
let userDataDirectory = '';
let refreshInProgress: Promise<AppState> | null = null;
let recoveryJournal: RecoveryJournal | null = null;
let recoveryJournalLoadError: Error | null = null;
let adapterMutationInFlight = false;
const recoverySessionId = randomUUID();
const connectionMonitors = new Map<string, AbortController>();
let currentState: AppState = {
  adapters: [],
  pendingRestoreCount: 0,
  platform: 'win32',
  selectedAdapterId: null,
  version: app.getVersion(),
};

interface TrayLabels {
  adapters: string;
  disable: string;
  enable: string;
  noAdapters: string;
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
  discard: string;
  crashMessage: string;
  crashTitle: string;
  keep: string;
  keepAndExit: string;
  later: string;
  quit: string;
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
      quit: '退出',
      refresh: '刷新',
      restore: '恢复更改',
      selected: '当前网卡',
      show: '显示 Connection Switcher',
    };
  }
  if (locale.startsWith('fr')) {
    return {
      adapters: 'Choisir une carte',
      disable: 'Désactiver',
      enable: 'Activer',
      noAdapters: 'Aucune carte réseau',
      quit: 'Quitter',
      refresh: 'Actualiser',
      restore: 'Restaurer les modifications',
      selected: 'Carte sélectionnée',
      show: 'Afficher Connection Switcher',
    };
  }
  return {
    adapters: 'Choose adapter',
    disable: 'Disable',
    enable: 'Enable',
    noAdapters: 'No network adapters',
    quit: 'Quit',
    refresh: 'Refresh',
    restore: 'Restore changes',
    selected: 'Selected adapter',
    show: 'Show Connection Switcher',
  };
}

function recoveryDialogLabels(): RecoveryDialogLabels {
  const locale = app.getLocale().toLocaleLowerCase('en-US');
  if (locale.startsWith('zh')) {
    return {
      cancel: '取消',
      damagedMessage:
        '恢复记录已损坏，无法安全判断原始网卡状态。可以保留当前网卡状态并删除损坏的记录，或退出程序。',
      damagedTitle: '无法读取恢复记录',
      discard: '保留当前状态并删除记录',
      crashMessage:
        '检测到上次运行留下的网卡状态更改。是否恢复到更改前的状态？',
      crashTitle: '发现未完成的恢复记录',
      keep: '保留当前状态',
      keepAndExit: '保留更改并退出',
      later: '稍后处理',
      quit: '退出程序',
      restore: '立即恢复',
      restoreFailedMessage:
        '部分网卡未能恢复。恢复记录仍已保留，可以重试或保留当前状态。',
      restoreFailedTitle: '网卡恢复未完成',
      retry: '重试',
    };
  }
  if (locale.startsWith('fr')) {
    return {
      cancel: 'Annuler',
      damagedMessage:
        "Le journal de récupération est endommagé. Conservez l'état actuel et supprimez-le, ou quittez l'application.",
      damagedTitle: 'Journal de récupération illisible',
      discard: "Conserver l'état et supprimer",
      crashMessage:
        "Des modifications de cartes réseau d'une session précédente restent à restaurer.",
      crashTitle: 'Récupération inachevée détectée',
      keep: "Conserver l'état actuel",
      keepAndExit: 'Conserver et quitter',
      later: 'Plus tard',
      quit: 'Quitter',
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
      'The recovery journal is damaged, so the original adapter state cannot be determined safely. Keep the current state and discard the journal, or quit.',
    damagedTitle: 'Recovery journal could not be read',
    discard: 'Keep state and discard',
    crashMessage:
      'Network adapter changes from the previous session are still pending. Restore them now?',
    crashTitle: 'Unfinished recovery detected',
    keep: 'Keep current state',
    keepAndExit: 'Keep changes and quit',
    later: 'Later',
    quit: 'Quit',
    restore: 'Restore now',
    restoreFailedMessage:
      'Some adapters could not be restored. The recovery journal was kept.',
    restoreFailedTitle: 'Recovery incomplete',
    retry: 'Retry',
  };
}

function selectedAdapter(state = currentState): NetworkAdapter | null {
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
  dialog.showErrorBox('Connection Switcher', errorMessage(error));
}

function pendingRestoreCount(): number {
  return recoveryJournal?.adapters.length ?? 0;
}

function applyRecoveryMetadata(): void {
  currentState = {
    ...currentState,
    pendingRestoreCount: pendingRestoreCount(),
  };
}

async function replaceRecoveryJournal(
  nextJournal: RecoveryJournal | null,
): Promise<void> {
  await saveRecoveryJournal(userDataDirectory, nextJournal);
  recoveryJournal = nextJournal;
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

async function discardRecoveryJournal(): Promise<void> {
  await replaceRecoveryJournal(null);
  rebuildTrayMenu();
  notifyStateChanged();
}

function notifyStateChanged(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.stateChanged, currentState);
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

  const template: MenuItemConstructorOptions[] = [
    {
      click: showMainWindow,
      label: labels.show,
    },
    { type: 'separator' },
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
        Boolean(selected) && selected?.enabled !== true && !operationInProgress,
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
        !operationInProgress,
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

async function refreshState(): Promise<AppState> {
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = (async () => {
    const adapters = await listNetworkAdapters();
    await reconcileTrackedChanges(adapters);
    const resolvedId = resolveSelectedAdapterId(adapters, selectedAdapterId);
    if (resolvedId !== selectedAdapterId) {
      selectedAdapterId = resolvedId;
      await saveSelectedAdapterId(userDataDirectory, selectedAdapterId);
    }

    currentState = {
      adapters,
      pendingRestoreCount: pendingRestoreCount(),
      platform: 'win32',
      selectedAdapterId,
      version: app.getVersion(),
    };
    rebuildTrayMenu();
    return currentState;
  })().finally(() => {
    refreshInProgress = null;
  });

  return refreshInProgress;
}

async function selectAdapter(adapterId: string): Promise<AppState> {
  if (!isSafeAdapterId(adapterId))
    throw new Error('Invalid network adapter identifier.');

  const state = await refreshState();
  if (!state.adapters.some((adapter) => adapter.id === adapterId)) {
    throw new Error('The selected network adapter no longer exists.');
  }

  selectedAdapterId = adapterId;
  currentState = { ...state, selectedAdapterId };
  await saveSelectedAdapterId(userDataDirectory, selectedAdapterId);
  rebuildTrayMenu();
  notifyStateChanged();
  return currentState;
}

async function changeAdapterState(
  adapterId: string,
  action: AdapterAction,
): Promise<AppState> {
  if (!isSafeAdapterId(adapterId))
    throw new Error('Invalid network adapter identifier.');
  if (!isAdapterAction(action)) throw new Error('Unsupported adapter action.');
  if (recoveryJournalLoadError) {
    throw new Error(
      'The recovery journal could not be loaded, so network changes are disabled.',
    );
  }
  if (operationInProgress)
    throw new Error('Another network adapter operation is still running.');

  stopConnectionMonitors();
  operationInProgress = true;
  rebuildTrayMenu();
  try {
    const state = await refreshState();
    const adapter = state.adapters.find(
      (candidate) => candidate.id === adapterId,
    );
    if (!adapter)
      throw new Error('The selected network adapter no longer exists.');

    const requestedEnabled = action === 'enable';
    if (adapter.enabled === requestedEnabled) return state;
    const nextJournal = trackAdapterChange(
      recoveryJournal,
      adapter,
      requestedEnabled,
      recoverySessionId,
    );
    await replaceRecoveryJournal(nextJournal);
    rebuildTrayMenu();
    notifyStateChanged();

    adapterMutationInFlight = true;
    try {
      await setNetworkAdapterState(adapter, action);
    } finally {
      adapterMutationInFlight = false;
    }
    selectedAdapterId = adapter.id;
    await saveSelectedAdapterId(userDataDirectory, selectedAdapterId);
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
    try {
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

async function restoreTrackedAdapterStates(): Promise<AppState> {
  if (recoveryJournalLoadError) throw recoveryJournalLoadError;
  if (operationInProgress)
    throw new Error('Another network adapter operation is still running.');

  stopConnectionMonitors();
  operationInProgress = true;
  rebuildTrayMenu();
  try {
    const state = await refreshState();
    const plan = buildRecoveryPlan(recoveryJournal, state.adapters);
    if (plan.actions.length > 0) {
      await setNetworkAdapterStates(plan.actions);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    const refreshed = await refreshState();
    notifyStateChanged();
    if (refreshed.pendingRestoreCount > 0) {
      const names =
        recoveryJournal?.adapters
          .map((record) => record.adapterName)
          .join(', ') ?? '';
      throw new Error(
        `Some network adapters are still awaiting recovery${names ? `: ${names}` : '.'}`,
      );
    }
    if (!quitInProgress) {
      for (const change of plan.actions) {
        if (change.action === 'enable')
          startConnectionMonitor(change.adapter.id);
      }
    }
    return refreshed;
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

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getState, async (event) => {
    assertTrustedSender(event);
    return refreshState();
  });
  ipcMain.handle(IPC_CHANNELS.restoreAdapterStates, async (event) => {
    assertTrustedSender(event);
    return restoreTrackedAdapterStates();
  });
  ipcMain.handle(
    IPC_CHANNELS.selectAdapter,
    async (event, adapterId: unknown) => {
      assertTrustedSender(event);
      if (typeof adapterId !== 'string')
        throw new Error('Invalid network adapter identifier.');
      return selectAdapter(adapterId);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.setAdapterState,
    async (event, adapterId: unknown, action: unknown) => {
      assertTrustedSender(event);
      if (typeof adapterId !== 'string')
        throw new Error('Invalid network adapter identifier.');
      if (!isAdapterAction(action))
        throw new Error('Unsupported adapter action.');
      return changeAdapterState(adapterId, action);
    },
  );
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && url.hostname === 'www.flaticon.com';
  } catch {
    return false;
  }
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    height: 620,
    icon: ICON_PATH,
    minHeight: 540,
    minWidth: 640,
    show: false,
    title: 'Connection Switcher',
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      preload: path.join(__dirname, '..', 'common', 'preload.js'),
      sandbox: true,
      webSecurity: true,
    },
    width: 760,
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
    window.hide();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
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
  tray.setToolTip('Connection Switcher');
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
  const result = await dialog.showMessageBox({
    buttons: [labels.discard, labels.quit],
    cancelId: 1,
    defaultId: 0,
    detail: errorMessage(recoveryJournalLoadError),
    message: labels.damagedMessage,
    noLink: true,
    title: labels.damagedTitle,
    type: 'error',
  });
  if (result.response !== 0) return false;

  await saveRecoveryJournal(userDataDirectory, null);
  recoveryJournalLoadError = null;
  return true;
}

async function handleInterruptedRecovery(): Promise<void> {
  if (pendingRestoreCount() === 0 || recoveryJournalLoadError) return;
  const labels = recoveryDialogLabels();
  const result = await dialog.showMessageBox({
    buttons: [labels.restore, labels.keep, labels.later],
    cancelId: 2,
    defaultId: 0,
    detail:
      recoveryJournal?.adapters
        .map((record) => record.adapterName)
        .join('\n') ?? '',
    message: labels.crashMessage,
    noLink: true,
    title: labels.crashTitle,
    type: 'warning',
  });

  if (result.response === 0) {
    try {
      await restoreTrackedAdapterStates();
    } catch (error) {
      await showRecoveryFailure(error);
    }
  } else if (result.response === 1) {
    await discardRecoveryJournal();
  }
}

async function requestApplicationQuit(): Promise<void> {
  if (quitApproved || quitInProgress) return;
  if (operationInProgress) {
    showError(
      new Error(
        'Wait for the current network adapter operation to finish before quitting.',
      ),
    );
    return;
  }

  quitInProgress = true;
  try {
    const labels = recoveryDialogLabels();
    while (pendingRestoreCount() > 0) {
      try {
        await restoreTrackedAdapterStates();
      } catch (error) {
        const result = await dialog.showMessageBox({
          buttons: [labels.retry, labels.keepAndExit, labels.cancel],
          cancelId: 2,
          defaultId: 0,
          detail: errorMessage(error),
          message: labels.restoreFailedMessage,
          noLink: true,
          title: labels.restoreFailedTitle,
          type: 'error',
        });
        if (result.response === 0) continue;
        if (result.response === 1) {
          await discardRecoveryJournal();
          break;
        }
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
      'Connection Switcher supports Windows only.',
    );
    app.quit();
    return;
  }

  app.setAppUserModelId('com.nzosifou.connection-switcher');
  Menu.setApplicationMenu(null);
  configureAppProtocol();
  configureSessionSecurity();
  userDataDirectory = app.getPath('userData');
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
  registerIpcHandlers();
  createMainWindow();
  createTray();

  try {
    await refreshState();
    notifyStateChanged();
    await handleInterruptedRecovery();
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
  app.on('will-quit', stopConnectionMonitors);
  app.on('activate', showMainWindow);
  app.on('second-instance', showMainWindow);
  void app.whenReady().then(startApplication).catch(showError);
}
