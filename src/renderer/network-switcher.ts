import { t, type TranslationKey } from './i18n.js';

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
const recoveryPanel = requiredElement<HTMLDivElement>('recovery-panel');
const recoverySummary =
  requiredElement<HTMLParagraphElement>('recovery-summary');
const restoreButton = requiredElement<HTMLButtonElement>('restore-button');
const adapterProgress = requiredElement<HTMLDivElement>('adapter-progress');
const adapterProgressMessage = requiredElement<HTMLParagraphElement>('adapter-progress-message');
const cancelAdapterButton = requiredElement<HTMLButtonElement>('cancel-adapter-button');
const helperDiagnostics = requiredElement<HTMLDetailsElement>('helper-diagnostics');
const helperDiagnosticsText = requiredElement<HTMLTextAreaElement>('helper-diagnostics-text');
const splitPrimaryAdapter = requiredElement<HTMLSelectElement>(
  'split-primary-adapter',
);
const splitProxyAdapter = requiredElement<HTMLSelectElement>(
  'split-proxy-adapter',
);
const splitIpinfo = requiredElement<HTMLInputElement>('split-ipinfo');
const splitMode = requiredElement<HTMLSelectElement>('split-mode');
const splitModeHint = requiredElement<HTMLElement>('split-mode-hint');
const splitCustomDomains = requiredElement<HTMLTextAreaElement>(
  'split-custom-domains',
);
const splitControllerPort = requiredElement<HTMLInputElement>(
  'split-controller-port',
);
const splitControllerSecret = requiredElement<HTMLInputElement>(
  'split-controller-secret',
);
const splitSaveButton = requiredElement<HTMLButtonElement>('split-save-button');
const splitPreflightButton = requiredElement<HTMLButtonElement>(
  'split-preflight-button',
);
const splitActivateButton = requiredElement<HTMLButtonElement>(
  'split-activate-button',
);
const splitDeactivateButton = requiredElement<HTMLButtonElement>(
  'split-deactivate-button',
);
const splitVerifyButton = requiredElement<HTMLButtonElement>(
  'split-verify-button',
);
const splitStatusBadge = requiredElement<HTMLSpanElement>('split-status-badge');
const splitStatusLabel = requiredElement<HTMLSpanElement>('split-status-label');
const splitDiagnostics = requiredElement<HTMLDivElement>('split-diagnostics');
const splitDiagnosticsList = requiredElement<HTMLUListElement>(
  'split-diagnostics-list',
);
const splitFeedback = requiredElement<HTMLDivElement>('split-feedback');
const splitVerification = requiredElement<HTMLDivElement>('split-verification');
const splitVerificationDirect = requiredElement<HTMLElement>(
  'split-verification-direct',
);
const splitVerificationProxy = requiredElement<HTMLElement>(
  'split-verification-proxy',
);
const splitVerificationList = requiredElement<HTMLUListElement>(
  'split-verification-list',
);

let currentState: NetworkSwitcherState | null = null;
let busy = false;
let brokerNeedsRecovery = false;
let splitFormDirty = false;
let splitTransientDiagnostics: string[] = [];
let splitVerificationResult: SplitRoutingVerificationResult | null = null;

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

function renderAdapterProgress(state: ToolboxSafetyState): void {
  helperDiagnostics.hidden = !state.helperDiagnostics;
  helperDiagnosticsText.value = state.helperDiagnostics ?? '';
  const progress = state.adapterBrokerProgress;
  const labels: Partial<Record<AdapterBrokerPhase, TranslationKey>> = {
    authorizing: 'adapterAuthorizing', connecting: 'adapterConnecting',
    handshaking: 'adapterHandshaking', applying: 'adapterApplying', restoring: 'adapterRestoring',
  };
  const label = progress ? labels[progress.phase] : undefined;
  brokerNeedsRecovery = progress?.phase === 'error';
  adapterProgress.hidden = !label && !brokerNeedsRecovery;
  adapterProgressMessage.textContent = label ? t(label) : progress?.detail ?? '';
  if (label) setFeedback();
  cancelAdapterButton.hidden = !progress?.canCancel;
  cancelAdapterButton.disabled = false;
  if (currentState) renderState(currentState);
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

function splitStatusPresentation(status: SplitRoutingStatus): {
  className: string;
  label: string;
} {
  switch (status) {
    case 'active':
      return { className: 'status-connected', label: t('splitStatusActive') };
    case 'preparing':
      return { className: 'status-disconnected', label: t('splitStatusPreparing') };
    case 'restoring':
      return { className: 'status-disconnected', label: t('splitStatusRestoring') };
    case 'error':
      return { className: 'status-disabled', label: t('splitStatusError') };
    case 'inactive':
      return { className: 'status-disabled', label: t('splitStatusInactive') };
  }
}

function replaceAdapterOptions(
  select: HTMLSelectElement,
  adapters: readonly NetworkAdapter[],
  selectedId: string | null,
): void {
  const previousValue = splitFormDirty ? select.value : selectedId ?? '';
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = t('splitChooseAdapter');
  select.append(placeholder);
  for (const adapter of adapters) {
    const option = document.createElement('option');
    option.value = adapter.id;
    option.textContent = `${adapter.name} · ${statusPresentation(adapter).label}`;
    select.append(option);
  }
  select.value = adapters.some((adapter) => adapter.id === previousValue)
    ? previousValue
    : '';
}

function renderSplitDiagnostics(messages: readonly string[]): void {
  splitDiagnosticsList.replaceChildren();
  for (const message of messages) {
    const item = document.createElement('li');
    item.textContent = message;
    splitDiagnosticsList.append(item);
  }
  splitDiagnostics.hidden = messages.length === 0;
}

function renderSplitVerification(
  result: SplitRoutingVerificationResult | null,
): void {
  splitVerification.hidden = result === null;
  if (!result) {
    splitVerificationDirect.textContent = '—';
    splitVerificationProxy.textContent = '—';
    splitVerificationList.replaceChildren();
    return;
  }
  splitVerificationDirect.textContent = result.mode === 'chatgpt-web' ? t('splitExistingPath') : t('splitVerificationPath', {
    adapter: result.direct.adapterName,
    ip: result.direct.publicIp,
  });
  splitVerificationProxy.textContent = t('splitVerificationPath', {
    adapter: result.proxied.adapterName,
    ip: result.proxied.publicIp,
  });
  const messages = [
    t(
      result.systemRoutingUnchanged
        ? 'splitVerificationSystemUnchanged'
        : 'splitVerificationSystemChanged',
    ),
    t(
      result.mode === 'chatgpt-web' ? (result.chatgptConnectionConfirmed ? 'splitChatgptConnectionConfirmed' : 'splitChatgptConnectionUnknown') : result.publicIpsDiffer
        ? 'splitVerificationIpsDiffer'
        : 'splitVerificationIpsSame',
    ),
    t(
      result.egressObservation === 'proxy'
        ? 'splitVerificationEgressProxy'
        : result.egressObservation === 'primary'
          ? 'splitVerificationEgressPrimary'
          : 'splitVerificationEgressUnknown',
    ),
  ];
  splitVerificationList.replaceChildren();
  for (const message of messages) {
    const item = document.createElement('li');
    item.textContent = message;
    splitVerificationList.append(item);
  }
}

function renderSplitRouting(state: NetworkSwitcherState): void {
  const split = state.splitRouting;
  replaceAdapterOptions(
    splitPrimaryAdapter,
    state.adapters,
    split.settings.primaryAdapterId,
  );
  replaceAdapterOptions(
    splitProxyAdapter,
    state.adapters,
    split.settings.proxyAdapterId,
  );
  if (!splitFormDirty) {
    splitMode.value = split.settings.mode;
    splitIpinfo.checked = split.settings.ipinfoEnabled;
    splitCustomDomains.value = split.settings.customDomains.join('\n');
    splitControllerPort.value = String(split.settings.controllerPort);
  }

  const status = splitStatusPresentation(split.status);
  splitStatusBadge.className = `status-badge ${status.className}`;
  splitStatusLabel.textContent = split.status === 'active' && split.settings.mode === 'chatgpt-web'
    ? `${t('splitChatgptMode')} · ${status.label}` : status.label;
  const editable =
    !busy && (split.status === 'inactive' || split.status === 'error') && !split.pendingRecovery;
  for (const control of [
    splitMode,
    splitPrimaryAdapter,
    splitProxyAdapter,
    splitIpinfo,
    splitCustomDomains,
    splitControllerPort,
  ]) {
    control.disabled = !editable;
  }
  splitControllerSecret.disabled = busy;
  splitSaveButton.disabled = !editable;
  splitPreflightButton.disabled = !editable;
  splitActivateButton.disabled = !editable;
  const chatgptWeb = splitMode.value === 'chatgpt-web';
  splitModeHint.textContent = t(chatgptWeb ? 'splitChatgptWebHint' : 'splitSitesHint');
  splitCustomDomains.disabled = !editable || chatgptWeb;
  splitIpinfo.disabled = !editable || chatgptWeb;
  splitDeactivateButton.disabled = busy || !(split.pendingRecovery || split.status === 'active' || split.status === 'error');
  splitVerifyButton.disabled = busy || split.status !== 'active';
  if (split.status !== 'active' && splitVerificationResult) {
    splitVerificationResult = null;
  }
  renderSplitVerification(splitVerificationResult);
  const diagnostics = [
    ...(split.diagnostics.length > 0
      ? split.diagnostics
      : splitTransientDiagnostics),
  ];
  if (split.status === 'active') {
    diagnostics.push(t('splitWlanDefaultsRemoved'));
  }
  if (split.pendingRecovery) {
    diagnostics.push(
      t('splitOwnedRoutes', { count: String(split.ownedRouteCount) }),
      t('splitRecoveryPending'),
    );
  }
  renderSplitDiagnostics([...new Set(diagnostics)]);
  if (split.lastError) setSplitFeedback(split.lastError, 'error');
}

function renderState(state: NetworkSwitcherState): void {
  currentState = state;
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
  const splitRecoveryPending = state.splitRouting.pendingRecovery;
  enableButton.disabled =
    busy || brokerNeedsRecovery || splitRecoveryPending || !adapter || adapter.enabled === true;
  disableButton.disabled =
    busy || brokerNeedsRecovery || splitRecoveryPending || !adapter || adapter.enabled === false;
  refreshButton.disabled = busy;
  recoveryPanel.hidden = state.pendingRestoreCount === 0 && !brokerNeedsRecovery;
  recoverySummary.textContent = brokerNeedsRecovery && state.pendingRestoreCount === 0 ? t('adapterRecoveryCheck') : t('pendingRecovery', {
    count: String(state.pendingRestoreCount),
  });
  restoreButton.disabled = busy || (state.pendingRestoreCount === 0 && !brokerNeedsRecovery);
  renderSplitRouting(state);
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

function setSplitFeedback(
  message = '',
  kind: 'error' | 'success' | 'neutral' = 'neutral',
): void {
  splitFeedback.textContent = message;
  splitFeedback.className = 'feedback';
  if (kind !== 'neutral') splitFeedback.classList.add(`feedback-${kind}`);
}

function splitSettingsInput(): SplitRoutingSettingsInput {
  return {
    mode: splitMode.value === 'chatgpt-web' ? 'chatgpt-web' : 'sites',
    chatgptEnabled: false,
    controllerPort: Number(splitControllerPort.value),
    customDomains: splitMode.value === 'chatgpt-web' ? [] : splitCustomDomains.value
      .split(/[\n,]+/u)
      .map((value) => value.trim())
      .filter(Boolean),
    ipinfoEnabled: splitMode.value === 'chatgpt-web' ? false : splitIpinfo.checked,
    primaryAdapterId: splitPrimaryAdapter.value || null,
    proxyAdapterId: splitProxyAdapter.value || null,
  };
}

async function saveSplitSettings(): Promise<void> {
  setBusy(true);
  setSplitFeedback(t('splitSaving'));
  try {
    splitFormDirty = false;
    splitTransientDiagnostics = [];
    const state =
      await window.cherryToolbox.networkSwitcher.saveSplitRoutingSettings(
        splitSettingsInput(),
      );
    renderState(state);
    setSplitFeedback(t('splitSaved'), 'success');
  } catch (error) {
    splitFormDirty = true;
    setSplitFeedback(t('failed', { message: friendlyError(error) }), 'error');
  } finally {
    setBusy(false);
  }
}

async function preflightSplit(): Promise<void> {
  setBusy(true);
  setSplitFeedback(t('splitPreflighting'));
  try {
    const result =
      await window.cherryToolbox.networkSwitcher.preflightSplitRouting(
        splitSettingsInput(),
        splitControllerSecret.value,
      );
    splitTransientDiagnostics = [...result.diagnostics];
    renderSplitDiagnostics(splitTransientDiagnostics);
    setSplitFeedback(
      t('splitPreflightReady', { count: String(result.routeEndpointCount) }),
      'success',
    );
  } catch (error) {
    setSplitFeedback(t('failed', { message: friendlyError(error) }), 'error');
  } finally {
    setBusy(false);
  }
}

async function activateSplit(): Promise<void> {
  if (!window.confirm(t(splitMode.value === 'chatgpt-web' ? 'splitConfirmChatgpt' : 'splitConfirmActivate'))) return;
  setBusy(true);
  setSplitFeedback(t('splitActivating'));
  try {
    splitFormDirty = false;
    splitTransientDiagnostics = [];
    splitVerificationResult = null;
    const state = await window.cherryToolbox.networkSwitcher.activateSplitRouting(
      splitSettingsInput(),
      splitControllerSecret.value,
    );
    splitControllerSecret.value = '';
    renderState(state);
    setSplitFeedback(t('splitActivated'), 'success');
  } catch (error) {
    splitFormDirty = true;
    setSplitFeedback(t('failed', { message: friendlyError(error) }), 'error');
  } finally {
    setBusy(false);
  }
}

async function deactivateSplit(): Promise<void> {
  setBusy(true);
  setSplitFeedback(t('splitRestoring'));
  try {
    const state =
      await window.cherryToolbox.networkSwitcher.deactivateSplitRouting(
        splitControllerSecret.value,
      );
    splitControllerSecret.value = '';
    splitFormDirty = false;
    splitTransientDiagnostics = [];
    splitVerificationResult = null;
    renderState(state);
    setSplitFeedback(t('splitRestored'), 'success');
  } catch (error) {
    setSplitFeedback(t('failed', { message: friendlyError(error) }), 'error');
  } finally {
    setBusy(false);
  }
}

async function verifySplit(): Promise<void> {
  if (!window.confirm(t(currentState?.splitRouting.settings.mode === 'chatgpt-web' ? 'splitVerifyChatgptConfirm' : 'splitVerifyConfirm'))) return;
  setBusy(true);
  setSplitFeedback(t('splitVerifying'));
  try {
    splitVerificationResult =
      await window.cherryToolbox.networkSwitcher.verifySplitRouting();
    renderSplitVerification(splitVerificationResult);
    setSplitFeedback(
      t(
        splitVerificationResult.passed
          ? (splitVerificationResult.mode === 'chatgpt-web' ? 'splitChatgptVerifiedPassed' : 'splitVerifiedPassed')
          : 'splitVerifiedFailed',
      ),
      splitVerificationResult.passed ? 'success' : 'error',
    );
  } catch (error) {
    setSplitFeedback(t('failed', { message: friendlyError(error) }), 'error');
  } finally {
    setBusy(false);
  }
}

async function refresh(showSuccess = true): Promise<void> {
  setBusy(true);
  setFeedback(t('refreshing'));
  try {
    const state = await window.cherryToolbox.networkSwitcher.getState();
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
    const state =
      await window.cherryToolbox.networkSwitcher.selectAdapter(adapterId);
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
  ) {
    return;
  }

  setBusy(true);
  setFeedback(
    t(action === 'enable' ? 'workingEnable' : 'workingDisable', {
      name: adapter.name,
    }),
  );
  try {
    const state =
      await window.cherryToolbox.networkSwitcher.setAdapterState(
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
  if (!currentState || (currentState.pendingRestoreCount === 0 && !brokerNeedsRecovery)) return;
  setBusy(true);
  setFeedback(t('restoring'));
  try {
    let state = currentState;
    if (state.splitRouting.pendingRecovery) {
      state = await window.cherryToolbox.networkSwitcher.deactivateSplitRouting(
        splitControllerSecret.value,
      );
    }
    if (state.pendingRestoreCount > 0 || brokerNeedsRecovery) {
      state = await window.cherryToolbox.networkSwitcher.restoreAdapterStates();
    }
    splitControllerSecret.value = '';
    splitFormDirty = false;
    renderState(state);
    setFeedback(t('restored'), 'success');
  } catch (error) {
    setFeedback(t('failed', { message: friendlyError(error) }), 'error');
  } finally {
    setBusy(false);
  }
}

export function initializeNetworkSwitcher(): () => void {
  refreshButton.setAttribute('aria-label', t('refresh'));

  const onAdapterChange = (): void => {
    if (adapterSelect.value) void chooseAdapter(adapterSelect.value);
  };
  const onRefresh = (): void => void refresh();
  const onEnable = (): void => void changeAdapter('enable');
  const onDisable = (): void => void changeAdapter('disable');
  const onRestore = (): void => void restoreChanges();
  const onCancelAdapter = (): void => {
    cancelAdapterButton.disabled = true;
    void window.cherryToolbox.networkSwitcher.cancelAdapterOperation().catch((error: unknown) => {
      cancelAdapterButton.disabled = false;
      setFeedback(t('failed', { message: friendlyError(error) }), 'error');
    });
  };
  const onSplitFormChange = (): void => {
    splitFormDirty = true;
    splitTransientDiagnostics = [];
    if (currentState) renderSplitRouting(currentState);
  };
  const onSplitSave = (): void => void saveSplitSettings();
  const onSplitPreflight = (): void => void preflightSplit();
  const onSplitActivate = (): void => void activateSplit();
  const onSplitDeactivate = (): void => void deactivateSplit();
  const onSplitVerify = (): void => void verifySplit();

  adapterSelect.addEventListener('change', onAdapterChange);
  refreshButton.addEventListener('click', onRefresh);
  enableButton.addEventListener('click', onEnable);
  disableButton.addEventListener('click', onDisable);
  restoreButton.addEventListener('click', onRestore);
  cancelAdapterButton.addEventListener('click', onCancelAdapter);
  for (const control of [
    splitMode,
    splitPrimaryAdapter,
    splitProxyAdapter,
    splitIpinfo,
    splitCustomDomains,
    splitControllerPort,
  ]) {
    control.addEventListener('change', onSplitFormChange);
    control.addEventListener('input', onSplitFormChange);
  }
  splitSaveButton.addEventListener('click', onSplitSave);
  splitPreflightButton.addEventListener('click', onSplitPreflight);
  splitActivateButton.addEventListener('click', onSplitActivate);
  splitDeactivateButton.addEventListener('click', onSplitDeactivate);
  splitVerifyButton.addEventListener('click', onSplitVerify);

  const unsubscribe = window.cherryToolbox.networkSwitcher.onStateChanged(
    renderState,
  );
  const unsubscribeProgress = window.cherryToolbox.safety.onStateChanged(renderAdapterProgress);
  void window.cherryToolbox.safety.getState().then(renderAdapterProgress).catch(() => undefined);
  void refresh(false);

  return () => {
    adapterSelect.removeEventListener('change', onAdapterChange);
    refreshButton.removeEventListener('click', onRefresh);
    enableButton.removeEventListener('click', onEnable);
    disableButton.removeEventListener('click', onDisable);
    restoreButton.removeEventListener('click', onRestore);
    cancelAdapterButton.removeEventListener('click', onCancelAdapter);
    for (const control of [
      splitMode,
      splitPrimaryAdapter,
      splitProxyAdapter,
      splitIpinfo,
      splitCustomDomains,
      splitControllerPort,
    ]) {
      control.removeEventListener('change', onSplitFormChange);
      control.removeEventListener('input', onSplitFormChange);
    }
    splitSaveButton.removeEventListener('click', onSplitSave);
    splitPreflightButton.removeEventListener('click', onSplitPreflight);
    splitActivateButton.removeEventListener('click', onSplitActivate);
    splitDeactivateButton.removeEventListener('click', onSplitDeactivate);
    splitVerifyButton.removeEventListener('click', onSplitVerify);
    unsubscribe();
    unsubscribeProgress();
  };
}
