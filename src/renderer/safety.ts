import { t } from './i18n.js';

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required element #${id} is missing.`);
  return element as T;
}

const recovery = requiredElement<HTMLSpanElement>('safety-recovery');
const broker = requiredElement<HTMLSpanElement>('safety-broker');
const website = requiredElement<HTMLSpanElement>('safety-website');
const chatgpt = requiredElement<HTMLSpanElement>('safety-chatgpt');
const wechat = requiredElement<HTMLSpanElement>('safety-wechat');
const detail = requiredElement<HTMLParagraphElement>('safety-detail');

function renderValue(
  element: HTMLSpanElement,
  text: string,
  healthy: boolean,
): void {
  element.textContent = text;
  element.className = healthy
    ? 'safety-value safety-value-ok'
    : 'safety-value safety-value-warning';
}

function render(state: ToolboxSafetyState): void {
  const recoveryHealthy =
    state.recoveryHealth === 'healthy' && !state.adapterMutationsBlocked;
  renderValue(
    recovery,
    t(recoveryHealthy ? 'safetyHealthy' : 'safetyBlocked'),
    recoveryHealthy,
  );
  renderValue(
    broker,
    t(state.adapterMutationsBlocked ? 'safetyBlocked' : state.adapterBrokerActive ? 'safetyBrokerWatching' : 'safetyBrokerStandby'),
    !state.adapterMutationsBlocked,
  );
  renderValue(website, t(state.globalWebsiteNetworkWritesDisabled ? 'safetyNoGlobalWrites' : 'safetyBlocked'), state.globalWebsiteNetworkWritesDisabled);
  renderValue(chatgpt, t(state.chatGptProtected ? 'safetyProtected' : 'safetyBlocked'), state.chatGptProtected);
  renderValue(wechat, t(state.wechatRecoveryPending ? 'safetyBlocked' : 'safetyDryRunOnly'), state.wechatDryRunOnly && !state.wechatRecoveryPending);
  detail.textContent = t('safetyPendingDetail', {
    count: String(state.pendingRecoveryCount),
  });
}

export function initializeSafetyCenter(): () => void {
  const unsubscribe = window.cherryToolbox.safety.onStateChanged(render);
  void window.cherryToolbox.safety.getState().then(render).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    detail.textContent = t('failed', { message });
  });
  return unsubscribe;
}
