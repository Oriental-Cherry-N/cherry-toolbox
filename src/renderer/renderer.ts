const TRANSLATIONS = {
  en: {
    refresh: 'Refresh network adapters',
    adapterLabel: 'Network adapter',
    adapterSelectLabel: 'Available adapters',
    adminDisabled: 'Disabled',
    adminEnabled: 'Enabled',
    adminState: 'Administrative state',
    chooseAdapter: 'Choose an adapter',
    confirmDisable:
      'Disable “{name}”? This may interrupt your network connection.',
    connected: 'Connected',
    disable: 'Disable adapter',
    disabled: 'Disabled',
    disconnected: 'Disconnected',
    enable: 'Enable adapter',
    enabled: 'Enabled',
    failed: 'Operation failed: {message}',
    iconCredit: 'Icon credit',
    interface: 'Interface',
    loading: 'Loading…',
    noAdapters: 'No network adapters found',
    noAdaptersHint: 'Connect or install an adapter, then refresh.',
    permissionNotice:
      'Windows asks for administrator permission only when an adapter is changed.',
    pendingRecovery:
      '{count} adapter change(s) will be restored when the app exits.',
    recoveryTitle: 'Recovery protection is active',
    refreshed: 'Adapter information refreshed.',
    refreshing: 'Refreshing network adapters…',
    restoreNow: 'Restore now',
    restored: 'Network adapter states were restored.',
    restoring: 'Waiting for permission to restore network adapters…',
    selected: 'Selected “{name}”.',
    subtitle:
      'Change network adapters without digging through Windows settings.',
    successDisable: '“{name}” was disabled.',
    successEnable: '“{name}” was enabled.',
    title: 'Connection Switcher',
    unknown: 'Unknown',
    utility: 'Windows network utility',
    version: 'Version {version}',
    workingDisable: 'Waiting for permission to disable “{name}”…',
    workingEnable: 'Waiting for permission to enable “{name}”…',
  },
  fr: {
    refresh: 'Actualiser les cartes r\u00e9seau',
    adapterLabel: 'Carte réseau',
    adapterSelectLabel: 'Cartes disponibles',
    adminDisabled: 'Désactivée',
    adminEnabled: 'Activée',
    adminState: 'État administratif',
    chooseAdapter: 'Choisir une carte',
    confirmDisable:
      'Désactiver « {name} » ? Votre connexion réseau peut être interrompue.',
    connected: 'Connectée',
    disable: 'Désactiver la carte',
    disabled: 'Désactivée',
    disconnected: 'Déconnectée',
    enable: 'Activer la carte',
    enabled: 'Activée',
    failed: 'Échec : {message}',
    iconCredit: 'Crédit de l’icône',
    interface: 'Interface',
    loading: 'Chargement…',
    noAdapters: 'Aucune carte réseau trouvée',
    noAdaptersHint: 'Connectez ou installez une carte, puis actualisez.',
    permissionNotice:
      'Windows demande les droits administrateur uniquement lors d’un changement.',
    pendingRecovery:
      '{count} modification(s) seront restaurées à la fermeture.',
    recoveryTitle: 'La protection de récupération est active',
    refreshed: 'Informations actualisées.',
    refreshing: 'Actualisation des cartes réseau…',
    restoreNow: 'Restaurer maintenant',
    restored: 'Les cartes réseau ont été restaurées.',
    restoring: 'Autorisation requise pour restaurer les cartes réseau…',
    selected: '« {name} » sélectionnée.',
    subtitle: 'Changez de carte réseau sans parcourir les paramètres Windows.',
    successDisable: '« {name} » a été désactivée.',
    successEnable: '« {name} » a été activée.',
    title: 'Connection Switcher',
    unknown: 'Inconnu',
    utility: 'Utilitaire réseau Windows',
    version: 'Version {version}',
    workingDisable: 'Autorisation requise pour désactiver « {name} »…',
    workingEnable: 'Autorisation requise pour activer « {name} »…',
  },
  zh: {
    refresh: '\u5237\u65b0\u7f51\u7edc\u9002\u914d\u5668',
    adapterLabel: '网络适配器',
    adapterSelectLabel: '可用网卡',
    adminDisabled: '已禁用',
    adminEnabled: '已启用',
    adminState: '管理状态',
    chooseAdapter: '选择一个网卡',
    confirmDisable: '要禁用“{name}”吗？这可能会中断当前网络连接。',
    connected: '已连接',
    disable: '禁用网卡',
    disabled: '已禁用',
    disconnected: '未连接',
    enable: '启用网卡',
    enabled: '已启用',
    failed: '操作失败：{message}',
    iconCredit: '图标来源',
    interface: '接口',
    loading: '正在加载…',
    noAdapters: '未发现网络适配器',
    noAdaptersHint: '请连接或安装网卡，然后刷新。',
    permissionNotice: '只有在更改网卡状态时，Windows 才会请求管理员权限。',
    pendingRecovery: '退出程序时将恢复 {count} 项网卡状态更改。',
    recoveryTitle: '恢复保护已启用',
    refreshed: '网卡信息已刷新。',
    refreshing: '正在刷新网卡信息…',
    restoreNow: '立即恢复',
    restored: '网卡状态已恢复。',
    restoring: '正在等待恢复网卡所需的管理员授权…',
    selected: '已选择“{name}”。',
    subtitle: '无需打开多层 Windows 设置，即可快速切换网卡。',
    successDisable: '已禁用“{name}”。',
    successEnable: '已启用“{name}”。',
    title: 'Connection Switcher',
    unknown: '未知',
    utility: 'Windows 网络工具',
    version: '版本 {version}',
    workingDisable: '正在等待禁用“{name}”的管理员授权…',
    workingEnable: '正在等待启用“{name}”的管理员授权…',
  },
} as const;

type Locale = keyof typeof TRANSLATIONS;
type TranslationKey = keyof (typeof TRANSLATIONS)['en'];

const locale: Locale = (() => {
  const language = navigator.language.toLocaleLowerCase('en-US');
  if (language.startsWith('zh')) return 'zh';
  if (language.startsWith('fr')) return 'fr';
  return 'en';
})();

function t(key: TranslationKey, values: Record<string, string> = {}): string {
  let message: string = TRANSLATIONS[locale][key];
  for (const [name, value] of Object.entries(values)) {
    message = message.replaceAll(`{${name}}`, value);
  }
  return message;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required element #${id} is missing.`);
  return element as T;
}

const adapterSelect = requiredElement<HTMLSelectElement>('adapter-select');
const refreshButton = requiredElement<HTMLButtonElement>('refresh-button');
const enableButton = requiredElement<HTMLButtonElement>('enable-button');
const disableButton = requiredElement<HTMLButtonElement>('disable-button');
const adapterDetails = requiredElement<HTMLDivElement>('adapter-details');
const adapterDescription = requiredElement<HTMLParagraphElement>(
  'adapter-description',
);
const adapterMeta = requiredElement<HTMLParagraphElement>('adapter-meta');
const emptyState = requiredElement<HTMLDivElement>('empty-state');
const connectionBadge = requiredElement<HTMLSpanElement>('connection-badge');
const connectionStatus = requiredElement<HTMLSpanElement>('connection-status');
const feedback = requiredElement<HTMLDivElement>('feedback');
const appVersion = requiredElement<HTMLSpanElement>('app-version');
const recoveryPanel = requiredElement<HTMLDivElement>('recovery-panel');
const recoverySummary =
  requiredElement<HTMLParagraphElement>('recovery-summary');
const restoreButton = requiredElement<HTMLButtonElement>('restore-button');

let currentState: AppState | null = null;
let busy = false;

function applyTranslations(): void {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : locale;
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset.i18n as TranslationKey | undefined;
    if (key && key in TRANSLATIONS.en) element.textContent = t(key);
  }
  refreshButton.setAttribute('aria-label', t('refresh'));
}

function selectedAdapter(): NetworkAdapter | null {
  if (!currentState) return null;
  return (
    currentState.adapters.find(
      (adapter) => adapter.id === currentState?.selectedAdapterId,
    ) ?? null
  );
}

function setFeedback(
  message = '',
  kind: 'error' | 'success' | 'neutral' = 'neutral',
): void {
  feedback.textContent = message;
  feedback.className = 'feedback';
  if (kind !== 'neutral') feedback.classList.add(`feedback-${kind}`);
}

function statusPresentation(adapter: NetworkAdapter | null): {
  className: string;
  label: string;
} {
  if (!adapter) return { className: 'status-unknown', label: t('unknown') };
  if (adapter.enabled === false)
    return { className: 'status-disabled', label: t('disabled') };
  if (adapter.connected === true)
    return { className: 'status-connected', label: t('connected') };
  if (adapter.connected === false) {
    return { className: 'status-disconnected', label: t('disconnected') };
  }
  if (adapter.enabled === true)
    return { className: 'status-connected', label: t('enabled') };
  return {
    className: 'status-unknown',
    label: adapter.connectionStatus || adapter.adminStatus || t('unknown'),
  };
}

function renderState(state: AppState): void {
  currentState = state;
  appVersion.textContent = t('version', { version: state.version });

  adapterSelect.replaceChildren();
  for (const adapter of state.adapters) {
    const option = document.createElement('option');
    option.value = adapter.id;
    option.textContent = adapter.name;
    adapterSelect.append(option);
  }
  if (state.selectedAdapterId) adapterSelect.value = state.selectedAdapterId;

  const adapter = selectedAdapter();
  const hasAdapters = state.adapters.length > 0;
  adapterSelect.disabled = busy || !hasAdapters;
  emptyState.hidden = hasAdapters;
  adapterDetails.hidden = !adapter;

  if (adapter) {
    adapterDescription.textContent = adapter.description || adapter.name;
    const interfaceLabel =
      adapter.interfaceIndex === null ? '—' : String(adapter.interfaceIndex);
    const adminLabel =
      adapter.enabled === null
        ? adapter.adminStatus || t('unknown')
        : adapter.enabled
          ? t('adminEnabled')
          : t('adminDisabled');
    adapterMeta.textContent = `${t('interface')} ${interfaceLabel} · ${t('adminState')}: ${adminLabel}`;
  } else {
    adapterDescription.textContent = '';
    adapterMeta.textContent = '';
  }

  const status = statusPresentation(adapter);
  connectionBadge.className = `status-badge ${status.className}`;
  connectionStatus.textContent = status.label;
  enableButton.disabled = busy || !adapter || adapter.enabled === true;
  disableButton.disabled = busy || !adapter || adapter.enabled === false;
  refreshButton.disabled = busy;
  recoveryPanel.hidden = state.pendingRestoreCount === 0;
  recoverySummary.textContent = t('pendingRecovery', {
    count: String(state.pendingRestoreCount),
  });
  restoreButton.disabled = busy || state.pendingRestoreCount === 0;
}

function setBusy(value: boolean): void {
  busy = value;
  refreshButton.classList.toggle('is-spinning', value);
  if (currentState) renderState(currentState);
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^Error invoking remote method '[^']+': Error:\s*/u,
    '',
  );
}

async function refresh(showSuccess = true): Promise<void> {
  setBusy(true);
  setFeedback(t('refreshing'));
  try {
    const state = await window.connectionSwitcher.getState();
    renderState(state);
    setFeedback(
      showSuccess ? t('refreshed') : '',
      showSuccess ? 'success' : 'neutral',
    );
  } catch (error) {
    setFeedback(t('failed', { message: friendlyError(error) }), 'error');
  } finally {
    setBusy(false);
  }
}

async function chooseAdapter(adapterId: string): Promise<void> {
  setBusy(true);
  try {
    const state = await window.connectionSwitcher.selectAdapter(adapterId);
    renderState(state);
    const adapter = selectedAdapter();
    if (adapter) setFeedback(t('selected', { name: adapter.name }), 'success');
  } catch (error) {
    setFeedback(t('failed', { message: friendlyError(error) }), 'error');
    await refresh(false);
  } finally {
    setBusy(false);
  }
}

async function changeAdapter(action: AdapterAction): Promise<void> {
  const adapter = selectedAdapter();
  if (!adapter) return;
  if (
    action === 'disable' &&
    !window.confirm(t('confirmDisable', { name: adapter.name }))
  )
    return;

  setBusy(true);
  setFeedback(
    t(action === 'enable' ? 'workingEnable' : 'workingDisable', {
      name: adapter.name,
    }),
  );
  try {
    const state = await window.connectionSwitcher.setAdapterState(
      adapter.id,
      action,
    );
    renderState(state);
    setFeedback(
      t(action === 'enable' ? 'successEnable' : 'successDisable', {
        name: adapter.name,
      }),
      'success',
    );
  } catch (error) {
    setFeedback(t('failed', { message: friendlyError(error) }), 'error');
  } finally {
    setBusy(false);
  }
}

async function restoreChanges(): Promise<void> {
  if (!currentState || currentState.pendingRestoreCount === 0) return;
  setBusy(true);
  setFeedback(t('restoring'));
  try {
    const state = await window.connectionSwitcher.restoreAdapterStates();
    renderState(state);
    setFeedback(t('restored'), 'success');
  } catch (error) {
    setFeedback(t('failed', { message: friendlyError(error) }), 'error');
  } finally {
    setBusy(false);
  }
}

applyTranslations();
adapterSelect.addEventListener('change', () => {
  if (adapterSelect.value) void chooseAdapter(adapterSelect.value);
});
refreshButton.addEventListener('click', () => void refresh());
enableButton.addEventListener('click', () => void changeAdapter('enable'));
disableButton.addEventListener('click', () => void changeAdapter('disable'));
restoreButton.addEventListener('click', () => void restoreChanges());

const unsubscribe = window.connectionSwitcher.onStateChanged((state) =>
  renderState(state),
);
window.addEventListener('beforeunload', unsubscribe, { once: true });
void refresh(false);
