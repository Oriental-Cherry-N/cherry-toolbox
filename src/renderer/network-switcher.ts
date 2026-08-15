import { t } from './i18n.js';

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

let currentState: NetworkSwitcherState | null = null;
let busy = false;

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
  if (!currentState || currentState.pendingRestoreCount === 0) return;
  setBusy(true);
  setFeedback(t('restoring'));
  try {
    const state =
      await window.cherryToolbox.networkSwitcher.restoreAdapterStates();
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

  adapterSelect.addEventListener('change', onAdapterChange);
  refreshButton.addEventListener('click', onRefresh);
  enableButton.addEventListener('click', onEnable);
  disableButton.addEventListener('click', onDisable);
  restoreButton.addEventListener('click', onRestore);

  const unsubscribe = window.cherryToolbox.networkSwitcher.onStateChanged(
    renderState,
  );
  void refresh(false);

  return () => {
    adapterSelect.removeEventListener('change', onAdapterChange);
    refreshButton.removeEventListener('click', onRefresh);
    enableButton.removeEventListener('click', onEnable);
    disableButton.removeEventListener('click', onDisable);
    restoreButton.removeEventListener('click', onRestore);
    unsubscribe();
  };
}
