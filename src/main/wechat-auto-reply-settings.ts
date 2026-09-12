import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomically } from './file-store';

const SETTINGS_FILE_NAME = 'settings.json';
const MAX_ALLOWLIST_ENTRIES = 10;
const MAX_CONTACT_NAME_LENGTH = 128;
const MAX_REPLY_TEXT_LENGTH = 2000;
const DEFAULT_COOLDOWN_MINUTES = 30;
const DEFAULT_DAILY_LIMIT = 20;
const MAX_COOLDOWN_MINUTES = 24 * 60;
const MAX_DAILY_LIMIT = 100;

function defaultSettings(): WeChatAutoReplySettings {
  return {
    allowlist: [],
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
    dailyLimit: DEFAULT_DAILY_LIMIT,
    dryRun: true,
    enabled: false,
    replyText: '',
    version: 2,
  };
}

function settingsPath(dataDirectory: string): string {
  return path.join(dataDirectory, SETTINGS_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeContactNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('The auto-reply allowlist must be a list of contact names.');
  }
  const normalized: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      throw new Error('Every allowlist entry must be a contact name.');
    }
    const contact = candidate.trim();
    if (contact.length === 0) continue;
    if (contact.length > MAX_CONTACT_NAME_LENGTH) {
      throw new Error(
        `Contact names are limited to ${MAX_CONTACT_NAME_LENGTH} characters.`,
      );
    }
    if (!normalized.includes(contact)) normalized.push(contact);
  }
  if (normalized.length > MAX_ALLOWLIST_ENTRIES) {
    throw new Error(
      `The auto-reply allowlist is limited to ${MAX_ALLOWLIST_ENTRIES} contacts.`,
    );
  }
  return normalized;
}

function normalizeInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new Error(`${label} must be a whole number from 1 to ${maximum}.`);
  }
  return value as number;
}

export function normalizeWeChatAutoReplyInput(
  value: unknown,
): WeChatAutoReplySettingsInput {
  if (!isRecord(value)) {
    throw new Error('Invalid WeChat auto-reply settings.');
  }

  const replyText =
    typeof value.replyText === 'string' ? value.replyText.trim() : '';
  if (replyText.length === 0) {
    throw new Error('Enter a reply message before saving or starting.');
  }
  if (replyText.length > MAX_REPLY_TEXT_LENGTH) {
    throw new Error(
      `The reply message is limited to ${MAX_REPLY_TEXT_LENGTH} characters.`,
    );
  }

  const allowlist = normalizeContactNames(value.allowlist);
  if (allowlist.length === 0) {
    throw new Error('Add at least one exact WeChat contact name.');
  }
  if (value.dryRun !== true) {
    throw new Error(
      'Live WeChat sending is disabled because sent messages cannot be rolled back. Dry-run mode is mandatory.',
    );
  }
  const cooldownMinutes = normalizeInteger(
    value.cooldownMinutes,
    'The per-contact cooldown',
    MAX_COOLDOWN_MINUTES,
  );
  const dailyLimit = normalizeInteger(
    value.dailyLimit,
    'The daily reply limit',
    MAX_DAILY_LIMIT,
  );
  return {
    allowlist,
    cooldownMinutes,
    dailyLimit,
    dryRun: true,
    replyText,
  };
}

export function parseWeChatAutoReplySettings(
  value: unknown,
): WeChatAutoReplySettings {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
    return defaultSettings();
  }
  if (typeof value.enabled !== 'boolean') return defaultSettings();

  try {
    const input = normalizeWeChatAutoReplyInput(
      value.version === 1
        ? {
            ...value,
            cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
            dailyLimit: DEFAULT_DAILY_LIMIT,
            dryRun: true,
          }
        : value,
    );
    return { ...input, enabled: value.enabled, version: 2 };
  } catch {
    return defaultSettings();
  }
}

export async function loadWeChatAutoReplySettings(
  dataDirectory: string,
): Promise<WeChatAutoReplySettings> {
  try {
    const contents = await readFile(settingsPath(dataDirectory), 'utf8');
    return parseWeChatAutoReplySettings(JSON.parse(contents) as unknown);
  } catch {
    return defaultSettings();
  }
}

export async function saveWeChatAutoReplySettings(
  dataDirectory: string,
  settings: WeChatAutoReplySettings,
): Promise<void> {
  const parsed = parseWeChatAutoReplySettings(settings);
  if (settings.enabled && !parsed.enabled) {
    throw new Error('Refusing to enable an invalid auto-reply configuration.');
  }
  await writeJsonAtomically(settingsPath(dataDirectory), parsed);
}
