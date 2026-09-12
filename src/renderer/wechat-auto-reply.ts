import { t, type TranslationKey } from './i18n.js';

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required element #${id} is missing.`);
  return element as T;
}

const replyText = requiredElement<HTMLTextAreaElement>('wechat-reply-text');
const allowlist = requiredElement<HTMLTextAreaElement>('wechat-allowlist');
const dryRun = requiredElement<HTMLInputElement>('wechat-dry-run');
const cooldownMinutes = requiredElement<HTMLInputElement>(
  'wechat-cooldown-minutes',
);
const dailyLimit = requiredElement<HTMLInputElement>('wechat-daily-limit');
const saveButton = requiredElement<HTMLButtonElement>('wechat-save-button');
const startButton = requiredElement<HTMLButtonElement>('wechat-start-button');
const stopButton = requiredElement<HTMLButtonElement>('wechat-stop-button');
const statusBadge = requiredElement<HTMLSpanElement>('wechat-status-badge');
const statusLabel = requiredElement<HTMLSpanElement>('wechat-status-label');
const environmentPanel = requiredElement<HTMLDivElement>(
  'wechat-environment-panel',
);
const environmentLabel = requiredElement<HTMLSpanElement>(
  'wechat-environment-label',
);
const setupInstructions = requiredElement<HTMLDivElement>(
  'wechat-setup-instructions',
);
const activity = requiredElement<HTMLParagraphElement>('wechat-last-activity');
const feedback = requiredElement<HTMLDivElement>('wechat-feedback');
const versionTarget = requiredElement<HTMLParagraphElement>(
  'wechat-version-target',
);

let currentState: WeChatAutoReplyState | null = null;
let busy = false;
let dirty = false;
let fieldsInitialized = false;

const STATUS_KEYS: Record<WeChatAutoReplyStatus, TranslationKey> = {
  error: 'wechatStatusError',
  running: 'wechatStatusRunning',
  starting: 'wechatStatusStarting',
  stopped: 'wechatStatusStopped',
};

function setFeedback(
  message = '',
  kind: 'error' | 'success' | 'neutral' = 'neutral',
): void {
  feedback.textContent = message;
  feedback.className = 'feedback wechat-feedback';
  if (kind !== 'neutral') feedback.classList.add(`feedback-${kind}`);
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^Error invoking remote method '[^']+': Error:\s*/u,
    '',
  );
}

function renderState(state: WeChatAutoReplyState): void {
  currentState = state;
  if (!fieldsInitialized || !dirty) {
    replyText.value = state.settings.replyText;
    allowlist.value = state.settings.allowlist.join('\n');
    dryRun.checked = true;
    cooldownMinutes.value = String(state.settings.cooldownMinutes);
    dailyLimit.value = String(state.settings.dailyLimit);
    fieldsInitialized = true;
    dirty = false;
  }

  statusLabel.textContent = t(STATUS_KEYS[state.status]);
  versionTarget.textContent = t('wechatVersionTarget', {
    version: state.wechatVersion,
  });
  statusBadge.className = `status-badge wechat-status status-${state.status}`;
  environmentPanel.classList.toggle(
    'environment-missing',
    !state.environmentReady,
  );
  environmentLabel.textContent = t(
    state.environmentReady
      ? 'wechatEnvironmentReady'
      : 'wechatEnvironmentMissing',
  );
  setupInstructions.hidden = state.environmentReady;

  const active = state.status === 'running' || state.status === 'starting';
  replyText.disabled = busy;
  allowlist.disabled = busy;
  dryRun.disabled = true;
  cooldownMinutes.disabled = busy;
  dailyLimit.disabled = busy;
  saveButton.disabled = busy;
  startButton.disabled = busy || active || !state.environmentReady;
  stopButton.disabled = busy || (!active && !state.settings.enabled);

  if (state.lastEventAt && state.lastEventContact && state.lastEventType) {
    const timestamp = new Date(state.lastEventAt).toLocaleString();
    let key: TranslationKey = 'wechatLastReply';
    if (state.lastEventType === 'detected') key = 'wechatLastDetection';
    if (state.lastEventType === 'skipped') {
      if (state.lastSkipReason === 'cooldown') key = 'wechatSkippedCooldown';
      if (state.lastSkipReason === 'daily-limit') key = 'wechatSkippedDailyLimit';
      if (state.lastSkipReason === 'draft-present') key = 'wechatSkippedDraft';
      if (state.lastSkipReason === 'system-message') {
        key = 'wechatSkippedSystem';
      }
      if (state.lastSkipReason === 'outgoing-message') {
        key = 'wechatSkippedOutgoing';
      }
    }
    activity.textContent = t(key, {
        contact: state.lastEventContact,
        time: timestamp,
    });
  } else {
    activity.textContent = t('wechatNoActivity');
  }

  if (state.lastError) {
    setFeedback(state.lastError, 'error');
  }
}

function collectSettings(): WeChatAutoReplySettingsInput {
  return {
    allowlist: allowlist.value.split(/\r?\n/u),
    cooldownMinutes: Number(cooldownMinutes.value),
    dailyLimit: Number(dailyLimit.value),
    dryRun: true,
    replyText: replyText.value,
  };
}

function setBusy(value: boolean): void {
  busy = value;
  if (currentState) renderState(currentState);
}

async function saveSettings(showSuccess = true): Promise<WeChatAutoReplyState> {
  const state = await window.cherryToolbox.wechatAutoReply.saveSettings(
    collectSettings(),
  );
  dirty = false;
  renderState(state);
  if (showSuccess) setFeedback(t('wechatSaved'), 'success');
  return state;
}

async function handleSave(): Promise<void> {
  setBusy(true);
  try {
    await saveSettings();
  } catch (error) {
    setFeedback(friendlyError(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function handleStart(): Promise<void> {
  setBusy(true);
  try {
    const state = await window.cherryToolbox.wechatAutoReply.start(
      collectSettings(),
    );
    dirty = false;
    renderState(state);
    setFeedback(t('wechatStarted'), 'success');
  } catch (error) {
    setFeedback(friendlyError(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function handleStop(): Promise<void> {
  setBusy(true);
  try {
    const state = await window.cherryToolbox.wechatAutoReply.stop();
    renderState(state);
    setFeedback(t('wechatStopped'), 'success');
  } catch (error) {
    setFeedback(friendlyError(error), 'error');
  } finally {
    setBusy(false);
  }
}

export function initializeWeChatAutoReply(): () => void {
  const markDirty = (): void => {
    dirty = true;
  };
  const onSave = (): void => void handleSave();
  const onStart = (): void => void handleStart();
  const onStop = (): void => void handleStop();

  replyText.addEventListener('input', markDirty);
  allowlist.addEventListener('input', markDirty);
  dryRun.addEventListener('change', markDirty);
  cooldownMinutes.addEventListener('input', markDirty);
  dailyLimit.addEventListener('input', markDirty);
  saveButton.addEventListener('click', onSave);
  startButton.addEventListener('click', onStart);
  stopButton.addEventListener('click', onStop);

  const unsubscribe = window.cherryToolbox.wechatAutoReply.onStateChanged(
    renderState,
  );
  void window.cherryToolbox.wechatAutoReply
    .getState()
    .then(renderState)
    .catch((error: unknown) => {
      setFeedback(friendlyError(error), 'error');
    });

  return () => {
    replyText.removeEventListener('input', markDirty);
    allowlist.removeEventListener('input', markDirty);
    dryRun.removeEventListener('change', markDirty);
    cooldownMinutes.removeEventListener('input', markDirty);
    dailyLimit.removeEventListener('input', markDirty);
    saveButton.removeEventListener('click', onSave);
    startButton.removeEventListener('click', onStart);
    stopButton.removeEventListener('click', onStop);
    unsubscribe();
  };
}
