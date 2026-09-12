import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomically } from './file-store';

const RATE_LIMIT_FILE_NAME = 'rate-limit.json';
const MAX_STORED_CONTACTS = 10;
const MAX_STORED_DAILY_COUNT = 100;

export interface WeChatAutoReplyRateLimitState {
  dailyCount: number;
  date: string;
  lastReplyAtByContact: Record<string, string>;
  version: 1;
}

export function localDateKey(value = new Date()): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function defaultState(): WeChatAutoReplyRateLimitState {
  return {
    dailyCount: 0,
    date: localDateKey(),
    lastReplyAtByContact: {},
    version: 1,
  };
}

function blockedState(): WeChatAutoReplyRateLimitState {
  return {
    ...defaultState(),
    dailyCount: MAX_STORED_DAILY_COUNT,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00');
  return !Number.isNaN(parsed.valueOf()) && localDateKey(parsed) === value;
}

function isValidTimestamp(value: string): boolean {
  return value.length <= 64 && !Number.isNaN(new Date(value).valueOf());
}

export function parseWeChatAutoReplyRateLimitState(
  value: unknown,
): WeChatAutoReplyRateLimitState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.date !== 'string' ||
    !isValidDateKey(value.date) ||
    !Number.isInteger(value.dailyCount) ||
    (value.dailyCount as number) < 0 ||
    (value.dailyCount as number) > MAX_STORED_DAILY_COUNT ||
    !isRecord(value.lastReplyAtByContact)
  ) {
    return blockedState();
  }

  const entries = Object.entries(value.lastReplyAtByContact);
  if (entries.length > MAX_STORED_CONTACTS) return blockedState();
  const lastReplyAtByContact: Record<string, string> = {};
  for (const [contact, timestamp] of entries) {
    if (
      contact.trim() !== contact ||
      contact.length === 0 ||
      contact.length > 128 ||
      typeof timestamp !== 'string' ||
      !isValidTimestamp(timestamp)
    ) {
      return blockedState();
    }
    lastReplyAtByContact[contact] = timestamp;
  }

  return {
    dailyCount:
      value.date === localDateKey() ? (value.dailyCount as number) : 0,
    date: localDateKey(),
    lastReplyAtByContact,
    version: 1,
  };
}

export async function loadWeChatAutoReplyRateLimitState(
  dataDirectory: string,
): Promise<WeChatAutoReplyRateLimitState> {
  let contents: string;
  try {
    contents = await readFile(
      path.join(dataDirectory, RATE_LIMIT_FILE_NAME),
      'utf8',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultState();
    }
    return blockedState();
  }
  try {
    return parseWeChatAutoReplyRateLimitState(
      JSON.parse(contents) as unknown,
    );
  } catch {
    return blockedState();
  }
}

export async function saveWeChatAutoReplyRateLimitState(
  dataDirectory: string,
  state: WeChatAutoReplyRateLimitState,
): Promise<void> {
  const parsed = parseWeChatAutoReplyRateLimitState(state);
  if (
    parsed.dailyCount !== state.dailyCount ||
    parsed.date !== state.date ||
    Object.keys(parsed.lastReplyAtByContact).length !==
      Object.keys(state.lastReplyAtByContact).length
  ) {
    throw new Error('Refusing to persist invalid WeChat rate-limit state.');
  }
  await writeJsonAtomically(
    path.join(dataDirectory, RATE_LIMIT_FILE_NAME),
    parsed,
  );
}
