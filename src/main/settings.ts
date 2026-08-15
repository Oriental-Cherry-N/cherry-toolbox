import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomically } from './file-store';
import { isSafeAdapterId } from './network';

const SETTINGS_FILE_NAME = 'settings.json';

interface StoredSettings {
  selectedAdapterId: string | null;
  version: 1;
}

function settingsPath(userDataDirectory: string): string {
  return path.join(userDataDirectory, SETTINGS_FILE_NAME);
}

export async function loadSelectedAdapterId(
  userDataDirectory: string,
): Promise<string | null> {
  try {
    const contents = await readFile(settingsPath(userDataDirectory), 'utf8');
    const parsed = JSON.parse(contents) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return null;
    const selectedAdapterId = (parsed as Record<string, unknown>)
      .selectedAdapterId;
    return isSafeAdapterId(selectedAdapterId) ? selectedAdapterId : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export async function saveSelectedAdapterId(
  userDataDirectory: string,
  selectedAdapterId: string | null,
): Promise<void> {
  if (selectedAdapterId !== null && !isSafeAdapterId(selectedAdapterId)) {
    throw new Error(
      'Refusing to persist an invalid network adapter identifier.',
    );
  }

  const settings: StoredSettings = { selectedAdapterId, version: 1 };
  await writeJsonAtomically(settingsPath(userDataDirectory), settings);
}
