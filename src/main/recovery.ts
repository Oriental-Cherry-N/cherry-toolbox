import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

import { writeJsonAtomically } from './file-store';
import { isSafeAdapterId } from './network';
import { parseSplitRoutingSettings } from './split-routing-settings';
import type { WindowsSplitRoutingSnapshot } from './windows-split-routing';

const LEGACY_RECOVERY_FILE_NAME = 'recovery.json';
const RECOVERY_FILE_NAMES = Object.freeze([
  'recovery.v4.json',
  'recovery.v4.backup.json',
  'recovery.v4.previous.json',
]);
const MAX_RECOVERY_RECORDS = 64;
const MAX_ADAPTER_NAME_LENGTH = 256;
const MAX_PATH_LENGTH = 32_768;
const MAX_RECOVERY_SEQUENCE = Number.MAX_SAFE_INTEGER - 1;

export interface AdapterRecoveryRecord {
  adapterId: string;
  adapterName: string;
  originalEnabled: boolean;
  requestedEnabled: boolean;
}

export type SplitRoutingRecoveryPhase =
  | 'prepared'
  | 'network-applied'
  | 'flclash-applied'
  | 'pac-started'
  | 'active'
  | 'restoring';

export interface SplitRoutingRecoveryRecord {
  canonicalConfigHash: string;
  canonicalConfigPath: string;
  createdAt: string;
  networkIsolationApplied: boolean;
  pacUrl: string | null;
  phase: SplitRoutingRecoveryPhase;
  selectorChoices: Record<string, string>;
  settings: SplitRoutingSettings;
  snapshot: WindowsSplitRoutingSnapshot;
  temporaryConfigApplied: boolean;
  updatedAt: string;
  watchedFiles: string[];
}

export interface RecoveryJournal {
  adapters: AdapterRecoveryRecord[];
  createdAt: string;
  sessionId: string;
  splitRouting: SplitRoutingRecoveryRecord | null;
  updatedAt: string;
  version: 3;
}

interface RecoveryEnvelope {
  checksum: string;
  journal: RecoveryJournal | null;
  sequence: number;
  version: 4;
}

export interface RecoveryAction {
  action: AdapterAction;
  adapter: NetworkAdapter;
}

export interface RecoveryPlan {
  actions: RecoveryAction[];
  unavailable: AdapterRecoveryRecord[];
}

function recoveryPaths(userDataDirectory: string): string[] {
  return RECOVERY_FILE_NAMES.map((name) => path.join(userDataDirectory, name));
}

function legacyRecoveryPath(userDataDirectory: string): string {
  return path.join(userDataDirectory, LEGACY_RECOVERY_FILE_NAME);
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
  ) {
    return null;
  }
  return {
    adapterId,
    adapterName: adapterName.trim(),
    originalEnabled,
    requestedEnabled,
  };
}

function parseAdapters(value: unknown): AdapterRecoveryRecord[] {
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_RECORDS) {
    throw new Error('The recovery journal is invalid.');
  }
  const adapters = value.map(parseRecoveryRecord);
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
  return validAdapters;
}

function isRecoveryPhase(value: unknown): value is SplitRoutingRecoveryPhase {
  return [
    'prepared',
    'network-applied',
    'flclash-applied',
    'pac-started',
    'active',
    'restoring',
  ].includes(String(value));
}

function parseSelectorChoices(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > 512) {
    throw new Error('The split-routing selector recovery data is invalid.');
  }
  const result: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, selected] of Object.entries(value)) {
    if (
      name.length === 0 ||
      name.length > 512 ||
      typeof selected !== 'string' ||
      selected.length === 0 ||
      selected.length > 512
    ) {
      throw new Error('The split-routing selector recovery data is invalid.');
    }
    result[name] = selected;
  }
  return result;
}

function parseWindowsSnapshot(value: unknown): WindowsSplitRoutingSnapshot {
  if (!isRecord(value)) {
    throw new Error('The split-routing Windows snapshot is invalid.');
  }
  if (
    !isRecord(value.primary) ||
    !isRecord(value.proxy) ||
    !Array.isArray(value.defaultRoutes) ||
    !Array.isArray(value.ownedRoutes) ||
    !Array.isArray(value.registryValues) ||
    value.ownedRoutes.length > 4096
  ) {
    throw new Error('The split-routing Windows snapshot is invalid.');
  }
  const parseInteger = (candidate: unknown, maximum: number): number => {
    if (
      typeof candidate !== 'number' ||
      !Number.isInteger(candidate) ||
      candidate < 0 ||
      candidate > maximum
    ) {
      throw new Error('The split-routing numeric snapshot is invalid.');
    }
    return candidate;
  };
  const parseFamily = (candidate: unknown): 'IPv4' | 'IPv6' => {
    if (candidate === 'IPv4' || candidate === 'IPv6') return candidate;
    throw new Error('The split-routing address family is invalid.');
  };
  const parseAdapter = (adapter: Record<string, unknown>) => {
    if (
      !isSafeAdapterId(adapter.adapterId) ||
      typeof adapter.adapterName !== 'string' ||
      adapter.adapterName.trim().length === 0 ||
      adapter.adapterName.length > MAX_ADAPTER_NAME_LENGTH ||
      typeof adapter.enabled !== 'boolean' ||
      !Array.isArray(adapter.ipInterfaces) ||
      adapter.ipInterfaces.length === 0 ||
      adapter.ipInterfaces.length > 2
    ) {
      throw new Error('The split-routing adapter snapshot is invalid.');
    }
    const ipInterfaces = adapter.ipInterfaces.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.automaticMetric !== 'boolean' ||
        typeof item.ignoreDefaultRoutes !== 'boolean'
      ) {
        throw new Error('The split-routing IP interface snapshot is invalid.');
      }
      return {
        addressFamily: parseFamily(item.addressFamily),
        automaticMetric: item.automaticMetric,
        ignoreDefaultRoutes: item.ignoreDefaultRoutes,
        interfaceMetric: parseInteger(item.interfaceMetric, 9_999),
      };
    });
    if (
      new Set(ipInterfaces.map((item) => item.addressFamily)).size !==
      ipInterfaces.length
    ) {
      throw new Error('The split-routing IP interface snapshot is duplicated.');
    }
    return {
      adapterId: adapter.adapterId,
      adapterName: adapter.adapterName.trim(),
      enabled: adapter.enabled,
      interfaceIndex: parseInteger(adapter.interfaceIndex, 65_535),
      ipInterfaces,
    };
  };
  const primary = parseAdapter(value.primary);
  const proxy = parseAdapter(value.proxy);
  if (
    primary.adapterId === proxy.adapterId ||
    primary.interfaceIndex === proxy.interfaceIndex
  ) {
    throw new Error('The split-routing adapters must be different.');
  }

  if (value.defaultRoutes.length === 0 || value.defaultRoutes.length > 16) {
    throw new Error('The split-routing default-route snapshot is too large.');
  }
  const defaultRoutes = value.defaultRoutes.map((route) => {
    if (!isRecord(route) || typeof route.nextHop !== 'string') {
      throw new Error('The split-routing default-route snapshot is invalid.');
    }
    const addressFamily = parseFamily(route.addressFamily);
    const expectedPrefix: '0.0.0.0/0' | '::/0' =
      addressFamily === 'IPv4' ? '0.0.0.0/0' : '::/0';
    const expectedIpVersion = addressFamily === 'IPv4' ? 4 : 6;
    if (
      route.destinationPrefix !== expectedPrefix ||
      isIP(route.nextHop) !== expectedIpVersion
    ) {
      throw new Error('The split-routing default-route snapshot is invalid.');
    }
    return {
      addressFamily,
      destinationPrefix: expectedPrefix,
      nextHop: route.nextHop,
      routeMetric: parseInteger(route.routeMetric, 9_999),
    };
  });

  const ownedRoutes = value.ownedRoutes.map((route) => {
    if (
      !isRecord(route) ||
      typeof route.destinationPrefix !== 'string' ||
      typeof route.nextHop !== 'string'
    ) {
      throw new Error('The split-routing host-route snapshot is invalid.');
    }
    const addressFamily = parseFamily(route.addressFamily);
    const prefixMatch = route.destinationPrefix.match(/^(.*)\/(32|128)$/u);
    const expectedIpVersion = addressFamily === 'IPv4' ? 4 : 6;
    if (
      !prefixMatch ||
      Number(prefixMatch[2]) !== (addressFamily === 'IPv4' ? 32 : 128) ||
      isIP(prefixMatch[1] ?? '') !== expectedIpVersion ||
      isIP(route.nextHop) !== expectedIpVersion ||
      parseInteger(route.interfaceIndex, 65_535) !== proxy.interfaceIndex
    ) {
      throw new Error('The split-routing host-route snapshot is invalid.');
    }
    return {
      addressFamily,
      destinationPrefix: route.destinationPrefix,
      interfaceIndex: proxy.interfaceIndex,
      nextHop: route.nextHop,
      routeMetric: parseInteger(route.routeMetric, 9_999),
    };
  });

  const allowedRegistryNames = new Set([
    'AutoConfigURL',
    'AutoDetect',
    'ProxyEnable',
    'ProxyOverride',
    'ProxyServer',
  ]);
  const allowedRegistryKinds = new Set([
    'DWord',
    'ExpandString',
    'MultiString',
    'QWord',
    'String',
  ]);
  const registryValues = value.registryValues.map((record) => {
    if (
      !isRecord(record) ||
      typeof record.name !== 'string' ||
      !allowedRegistryNames.has(record.name) ||
      typeof record.exists !== 'boolean'
    ) {
      throw new Error('The split-routing registry snapshot is invalid.');
    }
    const validValue =
      record.value === null ||
      typeof record.value === 'string' ||
      typeof record.value === 'number' ||
      (Array.isArray(record.value) &&
        record.value.length <= 1024 &&
        record.value.every(
          (item) => typeof item === 'string' || typeof item === 'number',
        ));
    if (
      !validValue ||
      (record.exists &&
        (typeof record.kind !== 'string' ||
          !allowedRegistryKinds.has(record.kind))) ||
      (!record.exists && (record.kind !== null || record.value !== null))
    ) {
      throw new Error('The split-routing registry snapshot is invalid.');
    }
    return {
      exists: record.exists,
      kind: record.kind as string | null,
      name: record.name,
      value: record.value as
        | number
        | number[]
        | string
        | string[]
        | null,
    };
  });
  if (
    new Set(registryValues.map((record) => record.name)).size !==
      registryValues.length ||
    registryValues.length !== allowedRegistryNames.size ||
    [...allowedRegistryNames].some(
      (name) => !registryValues.some((record) => record.name === name),
    )
  ) {
    throw new Error('The split-routing registry snapshot is incomplete.');
  }

  return {
    defaultRoutes,
    ownedRoutes,
    primary,
    proxy,
    registryValues,
  };
}

function parseSplitRoutingRecord(
  value: unknown,
): SplitRoutingRecoveryRecord | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error('The split-routing recovery data is invalid.');
  }
  const appDataDirectory = process.env.APPDATA;
  const expectedConfigPath = appDataDirectory && path.isAbsolute(appDataDirectory)
    ? path.join(appDataDirectory, 'com.follow', 'clash', 'config.yaml')
    : null;
  if (
    typeof value.canonicalConfigHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.canonicalConfigHash) ||
    typeof value.canonicalConfigPath !== 'string' ||
    value.canonicalConfigPath.length === 0 ||
    value.canonicalConfigPath.length > MAX_PATH_LENGTH ||
    !path.isAbsolute(value.canonicalConfigPath) ||
    expectedConfigPath === null ||
    path.resolve(value.canonicalConfigPath).toLocaleLowerCase('en-US') !==
      path.resolve(expectedConfigPath).toLocaleLowerCase('en-US') ||
    path.basename(value.canonicalConfigPath).toLocaleLowerCase('en-US') !==
      'config.yaml' ||
    path
      .basename(path.dirname(value.canonicalConfigPath))
      .toLocaleLowerCase('en-US') !== 'clash' ||
    path
      .basename(path.dirname(path.dirname(value.canonicalConfigPath)))
      .toLocaleLowerCase('en-US') !== 'com.follow' ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isRecoveryPhase(value.phase) ||
    typeof value.temporaryConfigApplied !== 'boolean' ||
    (value.networkIsolationApplied !== undefined &&
      typeof value.networkIsolationApplied !== 'boolean') ||
    (value.pacUrl !== null &&
      (typeof value.pacUrl !== 'string' ||
        !/^http:\/\/127\.0\.0\.1:\d{1,5}\/[a-f0-9]{48}\.pac$/u.test(
          value.pacUrl,
        ))) ||
    !Array.isArray(value.watchedFiles) ||
    value.watchedFiles.length > 256 ||
    value.watchedFiles.some(
      (file) =>
        typeof file !== 'string' ||
        file.length === 0 ||
        file.length > MAX_PATH_LENGTH ||
        !path.isAbsolute(file),
    )
  ) {
    throw new Error('The split-routing recovery data is invalid.');
  }
  const configDirectory = path.dirname(value.canonicalConfigPath);
  const normalizedConfigPath = path
    .resolve(value.canonicalConfigPath)
    .toLocaleLowerCase('en-US');
  if (
    !value.watchedFiles.some(
      (file) =>
        path.resolve(file).toLocaleLowerCase('en-US') === normalizedConfigPath,
    ) ||
    value.watchedFiles.some((file) => {
      const relative = path.relative(configDirectory, path.resolve(file));
      return relative.startsWith('..') || path.isAbsolute(relative);
    })
  ) {
    throw new Error('The split-routing watched-file recovery data is invalid.');
  }
  const settings = parseSplitRoutingSettings(value.settings);
  const snapshot = parseWindowsSnapshot(value.snapshot);
  const phaseRequiresTemporaryConfig = new Set<SplitRoutingRecoveryPhase>([
    'flclash-applied',
    'pac-started',
    'active',
  ]);
  const phaseRequiresPac = new Set<SplitRoutingRecoveryPhase>([
    'pac-started',
    'active',
  ]);
  const networkIsolationApplied =
    typeof value.networkIsolationApplied === 'boolean'
      ? value.networkIsolationApplied
      : true;
  const phaseRequiresNetworkIsolation = new Set<SplitRoutingRecoveryPhase>([
    'network-applied',
    'pac-started',
    'active',
  ]);
  if (
    settings.primaryAdapterId !== snapshot.primary.adapterId ||
    settings.proxyAdapterId !== snapshot.proxy.adapterId ||
    (phaseRequiresTemporaryConfig.has(value.phase) &&
      !value.temporaryConfigApplied) ||
    (phaseRequiresNetworkIsolation.has(value.phase) &&
      !networkIsolationApplied) ||
    (phaseRequiresPac.has(value.phase) && value.pacUrl === null)
  ) {
    throw new Error('The split-routing recovery state is inconsistent.');
  }
  return {
    canonicalConfigHash: value.canonicalConfigHash,
    canonicalConfigPath: value.canonicalConfigPath,
    createdAt: value.createdAt,
    networkIsolationApplied,
    pacUrl: value.pacUrl,
    phase: value.phase,
    selectorChoices: parseSelectorChoices(value.selectorChoices),
    settings,
    snapshot,
    temporaryConfigApplied: value.temporaryConfigApplied,
    updatedAt: value.updatedAt,
    watchedFiles: [...value.watchedFiles] as string[],
  };
}

export function parseRecoveryJournal(value: unknown): RecoveryJournal {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3)
  ) {
    throw new Error('The recovery journal has an unsupported format.');
  }
  if (
    typeof value.sessionId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,64}$/u.test(value.sessionId) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw new Error('The recovery journal is invalid.');
  }
  return {
    adapters: parseAdapters(value.adapters),
    createdAt: value.createdAt,
    sessionId: value.sessionId,
    splitRouting:
      value.version === 1 ? null : parseSplitRoutingRecord(value.splitRouting),
    updatedAt: value.updatedAt,
    version: 3,
  };
}

function recoveryChecksum(journal: unknown, sequence: number): string {
  return createHash('sha256').update(JSON.stringify({ journal, sequence, version: 4 }), 'utf8').digest('hex');
}

function parseRecoveryEnvelope(value: unknown): RecoveryEnvelope {
  if (!isRecord(value) || value.version !== 4 || !Number.isSafeInteger(value.sequence) ||
      typeof value.sequence !== 'number' || value.sequence < 1 || value.sequence > MAX_RECOVERY_SEQUENCE ||
      typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(value.checksum)) {
    throw new Error('The recovery envelope is invalid.');
  }
  // Verify exactly what was persisted before schema normalization adds defaults.
  if (recoveryChecksum(value.journal, value.sequence) !== value.checksum) {
    throw new Error('The recovery envelope checksum does not match.');
  }
  const journal = value.journal === null ? null : parseRecoveryJournal(value.journal);
  return { journal, sequence: value.sequence, checksum: value.checksum, version: 4 };
}

interface RecoveryEnvelopeRead {
  envelope: RecoveryEnvelope | null;
  error: Error | null;
  exists: boolean;
}

async function recoveryEnvelopeReads(directory: string): Promise<RecoveryEnvelopeRead[]> {
  return Promise.all(recoveryPaths(directory).map(async filePath => {
    try {
      return { envelope: parseRecoveryEnvelope(JSON.parse(await readFile(filePath, 'utf8')) as unknown), error: null, exists: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { envelope: null, error: null, exists: false };
      return { envelope: null, error: error instanceof Error ? error : new Error(String(error)), exists: true };
    }
  }));
}

function newestEnvelope(reads: readonly RecoveryEnvelopeRead[]): RecoveryEnvelope | null {
  const valid = reads.flatMap(read => read.envelope ? [read.envelope] : []).sort((a, b) => b.sequence - a.sequence);
  const newest = valid[0];
  if (!newest) {
    if (reads.some(read => read.exists)) throw new Error('Every redundant recovery journal copy is damaged. Network changes are disabled and the files were preserved.');
    return null;
  }
  if (valid.some(value => value.sequence === newest.sequence && value.checksum !== newest.checksum)) {
    throw new Error('Recovery copies conflict at the same sequence. All evidence was preserved.');
  }
  return newest;
}

const LEGACY_V3_NAMES = ['recovery.v3.json', 'recovery.v3.backup.json', 'recovery.v3.previous.json'];
async function loadLegacyRecovery(directory: string): Promise<RecoveryJournal | null> {
  // v3 rotated historical snapshots. A missing/damaged primary cannot prove that
  // the backups contain every applied change, so never silently accept them.
  let anyV3 = false;
  let primary: RecoveryJournal | null = null;
  for (const [index, name] of LEGACY_V3_NAMES.entries()) {
    try {
      const raw = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as unknown;
      anyV3 = true;
      if (!isRecord(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.sequence) || typeof raw.checksum !== 'string') throw new Error('Invalid v3 recovery envelope.');
      const checksum = createHash('sha256').update(JSON.stringify({ journal: raw.journal, sequence: raw.sequence, version: 1 })).digest('hex');
      if (checksum !== raw.checksum) throw new Error('Invalid v3 recovery checksum.');
      const journal = parseRecoveryJournal(raw.journal);
      if (index === 0) primary = journal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') anyV3 = true;
    }
  }
  if (anyV3) {
    if (!primary) throw new Error('The legacy v3 primary is unavailable. Historical backups cannot prove complete recovery; all evidence was preserved.');
    return primary;
  }
  try { return parseRecoveryJournal(JSON.parse(await readFile(legacyRecoveryPath(directory), 'utf8')) as unknown); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('The legacy recovery journal is not valid JSON.', { cause: error });
    throw error;
  }
}

export async function loadRecoveryJournal(directory: string): Promise<RecoveryJournal | null> {
  const newest = newestEnvelope(await recoveryEnvelopeReads(directory));
  return newest ? newest.journal : loadLegacyRecovery(directory);
}

export async function recoveryJournalHealth(directory: string): Promise<'healthy' | 'degraded' | 'blocked'> {
  try {
    const reads = await recoveryEnvelopeReads(directory);
    const newest = newestEnvelope(reads);
    if (!newest) { await loadLegacyRecovery(directory); return 'healthy'; }
    return reads.every(read => read.envelope?.checksum === newest.checksum && read.envelope.sequence === newest.sequence) ? 'healthy' : 'degraded';
  } catch { return 'blocked'; }
}

const journalWrites = new Map<string, Promise<void>>();
export function saveRecoveryJournal(directory: string, journal: RecoveryJournal | null): Promise<void> {
  const key = path.resolve(directory).toLocaleLowerCase('en-US');
  const previous = journalWrites.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(async () => {
    const reads = await recoveryEnvelopeReads(directory);
    const newest = newestEnvelope(reads);
    if (!newest) await loadLegacyRecovery(directory); // Do not overwrite unreadable evidence.
    const normalized = journal && (journal.adapters.length || journal.splitRouting) ? parseRecoveryJournal(journal) : null;
    if (!newest && normalized === null && !(await loadLegacyRecovery(directory))) return;
    const sequence = (newest?.sequence ?? 0) + 1;
    if (sequence > MAX_RECOVERY_SEQUENCE) throw new Error('The recovery journal sequence is exhausted.');
    const next: RecoveryEnvelope = { checksum: recoveryChecksum(normalized, sequence), journal: normalized, sequence, version: 4 };
    // All CURRENT replicas contain the new write-ahead intent, never older history.
    for (const filePath of recoveryPaths(directory)) await writeJsonAtomically(filePath, next);
    const verified = await recoveryEnvelopeReads(directory);
    if (!verified.every(read => read.envelope?.sequence === sequence && read.envelope.checksum === next.checksum)) {
      throw new Error('The redundant recovery journal could not be verified after writing.');
    }
    // A durable null tombstone is retained. Interrupted deletion cannot resurrect
    // an older mutation, and an unreadable v4 set never falls back to legacy data.
    for (const name of [...LEGACY_V3_NAMES, LEGACY_RECOVERY_FILE_NAME]) await rm(path.join(directory, name), { force: true });
  });
  journalWrites.set(key, result);
  void result.finally(() => { if (journalWrites.get(key) === result) journalWrites.delete(key); }).catch(() => undefined);
  return result;
}

function emptyJournal(
  sessionId: string,
  timestamp: string,
): RecoveryJournal {
  return {
    adapters: [],
    createdAt: timestamp,
    sessionId,
    splitRouting: null,
    updatedAt: timestamp,
    version: 3,
  };
}

export function trackAdapterChange(
  journal: RecoveryJournal | null,
  adapter: NetworkAdapter,
  requestedEnabled: boolean,
  sessionId: string,
  timestamp = new Date().toISOString(),
): RecoveryJournal {
  if (!isSafeAdapterId(adapter.id)) {
    throw new Error('Invalid network adapter identifier.');
  }
  if (adapter.enabled === null) {
    throw new Error(
      'The current adapter state is unknown, so a safe recovery point cannot be saved.',
    );
  }
  const base = journal ?? emptyJournal(sessionId, timestamp);
  const existing = base.adapters.find(
    (record) => record.adapterId === adapter.id,
  );
  const record: AdapterRecoveryRecord = {
    adapterId: adapter.id,
    adapterName: adapter.name,
    originalEnabled: existing?.originalEnabled ?? adapter.enabled,
    requestedEnabled,
  };
  const adapters = [
    ...base.adapters.filter((candidate) => candidate.adapterId !== adapter.id),
    record,
  ].sort((left, right) => left.adapterName.localeCompare(right.adapterName));
  if (adapters.length > MAX_RECOVERY_RECORDS) {
    throw new Error('Too many network adapters are awaiting recovery.');
  }
  return { ...base, adapters, updatedAt: timestamp };
}

export function setSplitRoutingRecovery(
  journal: RecoveryJournal | null,
  record: SplitRoutingRecoveryRecord | null,
  sessionId: string,
  timestamp = new Date().toISOString(),
): RecoveryJournal | null {
  const base = journal ?? emptyJournal(sessionId, timestamp);
  const next: RecoveryJournal = {
    ...base,
    splitRouting: record,
    updatedAt: timestamp,
  };
  return next.adapters.length === 0 && next.splitRouting === null ? null : next;
}

export function pendingRecoveryCount(
  journal: RecoveryJournal | null,
): number {
  return (journal?.adapters.length ?? 0) + (journal?.splitRouting ? 1 : 0);
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
  if (pending.length === journal.adapters.length) return journal;
  if (pending.length === 0 && journal.splitRouting === null) return null;
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
