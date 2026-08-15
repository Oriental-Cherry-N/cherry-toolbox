import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomically } from './file-store';
import { isSafeAdapterId } from './network';

const RECOVERY_FILE_NAME = 'recovery.json';
const MAX_RECOVERY_RECORDS = 64;
const MAX_ADAPTER_NAME_LENGTH = 256;

export interface AdapterRecoveryRecord {
  adapterId: string;
  adapterName: string;
  originalEnabled: boolean;
  requestedEnabled: boolean;
}

export interface RecoveryJournal {
  adapters: AdapterRecoveryRecord[];
  createdAt: string;
  sessionId: string;
  updatedAt: string;
  version: 1;
}

export interface RecoveryAction {
  action: AdapterAction;
  adapter: NetworkAdapter;
}

export interface RecoveryPlan {
  actions: RecoveryAction[];
  unavailable: AdapterRecoveryRecord[];
}

function recoveryPath(userDataDirectory: string): string {
  return path.join(userDataDirectory, RECOVERY_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function parseRecoveryRecord(value: unknown): AdapterRecoveryRecord | null {
  if (!isRecord(value)) return null;
  const { adapterId, adapterName, originalEnabled, requestedEnabled } = value;
  if (!isSafeAdapterId(adapterId)) return null;
  if (
    typeof adapterName !== 'string' ||
    adapterName.trim().length === 0 ||
    adapterName.length > MAX_ADAPTER_NAME_LENGTH
  ) {
    return null;
  }
  if (
    typeof originalEnabled !== 'boolean' ||
    typeof requestedEnabled !== 'boolean'
  )
    return null;
  return {
    adapterId,
    adapterName: adapterName.trim(),
    originalEnabled,
    requestedEnabled,
  };
}

export function parseRecoveryJournal(value: unknown): RecoveryJournal {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('The recovery journal has an unsupported format.');
  }
  if (
    typeof value.sessionId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,64}$/u.test(value.sessionId) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !Array.isArray(value.adapters) ||
    value.adapters.length > MAX_RECOVERY_RECORDS
  ) {
    throw new Error('The recovery journal is invalid.');
  }

  const adapters = value.adapters.map(parseRecoveryRecord);
  if (adapters.some((record) => record === null)) {
    throw new Error('The recovery journal contains an invalid adapter record.');
  }
  const validAdapters = adapters as AdapterRecoveryRecord[];
  if (
    new Set(validAdapters.map((record) => record.adapterId)).size !==
    validAdapters.length
  ) {
    throw new Error('The recovery journal contains duplicate adapter records.');
  }

  return {
    adapters: validAdapters,
    createdAt: value.createdAt,
    sessionId: value.sessionId,
    updatedAt: value.updatedAt,
    version: 1,
  };
}

export async function loadRecoveryJournal(
  userDataDirectory: string,
): Promise<RecoveryJournal | null> {
  try {
    const contents = await readFile(recoveryPath(userDataDirectory), 'utf8');
    return parseRecoveryJournal(JSON.parse(contents) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new Error('The recovery journal is not valid JSON.', {
        cause: error,
      });
    }
    throw error;
  }
}

export async function saveRecoveryJournal(
  userDataDirectory: string,
  journal: RecoveryJournal | null,
): Promise<void> {
  const filePath = recoveryPath(userDataDirectory);
  if (journal === null || journal.adapters.length === 0) {
    await rm(filePath, { force: true });
    return;
  }
  await writeJsonAtomically(filePath, parseRecoveryJournal(journal));
}

export function trackAdapterChange(
  journal: RecoveryJournal | null,
  adapter: NetworkAdapter,
  requestedEnabled: boolean,
  sessionId: string,
  timestamp = new Date().toISOString(),
): RecoveryJournal {
  if (!isSafeAdapterId(adapter.id))
    throw new Error('Invalid network adapter identifier.');
  if (adapter.enabled === null) {
    throw new Error(
      'The current adapter state is unknown, so a safe recovery point cannot be saved.',
    );
  }

  const existing = journal?.adapters.find(
    (record) => record.adapterId === adapter.id,
  );
  const record: AdapterRecoveryRecord = {
    adapterId: adapter.id,
    adapterName: adapter.name,
    originalEnabled: existing?.originalEnabled ?? adapter.enabled,
    requestedEnabled,
  };
  const adapters = [
    ...(journal?.adapters.filter(
      (candidate) => candidate.adapterId !== adapter.id,
    ) ?? []),
    record,
  ].sort((left, right) => left.adapterName.localeCompare(right.adapterName));

  if (adapters.length > MAX_RECOVERY_RECORDS) {
    throw new Error('Too many network adapters are awaiting recovery.');
  }
  return {
    adapters,
    createdAt: journal?.createdAt ?? timestamp,
    sessionId: journal?.sessionId ?? sessionId,
    updatedAt: timestamp,
    version: 1,
  };
}

export function reconcileRecoveryJournal(
  journal: RecoveryJournal | null,
  adapters: readonly NetworkAdapter[],
  timestamp = new Date().toISOString(),
): RecoveryJournal | null {
  if (!journal) return null;
  const currentAdapters = new Map(
    adapters.map((adapter) => [adapter.id, adapter]),
  );
  const pending = journal.adapters.filter((record) => {
    const adapter = currentAdapters.get(record.adapterId);
    return adapter?.enabled !== record.originalEnabled;
  });
  if (pending.length === 0) return null;
  if (pending.length === journal.adapters.length) return journal;
  return { ...journal, adapters: pending, updatedAt: timestamp };
}

export function buildRecoveryPlan(
  journal: RecoveryJournal | null,
  adapters: readonly NetworkAdapter[],
): RecoveryPlan {
  if (!journal) return { actions: [], unavailable: [] };
  const currentAdapters = new Map(
    adapters.map((adapter) => [adapter.id, adapter]),
  );
  const actions: RecoveryAction[] = [];
  const unavailable: AdapterRecoveryRecord[] = [];

  for (const record of journal.adapters) {
    const adapter = currentAdapters.get(record.adapterId);
    if (!adapter || adapter.enabled === null) {
      unavailable.push(record);
      continue;
    }
    if (adapter.enabled !== record.originalEnabled) {
      actions.push({
        action: record.originalEnabled ? 'enable' : 'disable',
        adapter,
      });
    }
  }
  return { actions, unavailable };
}
