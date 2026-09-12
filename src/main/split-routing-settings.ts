import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomically } from './file-store';
import { isSafeAdapterId } from './network';

const SETTINGS_FILE_NAME = 'split-routing-settings.json';
const MAX_CUSTOM_DOMAINS = 128;
const MAX_DOMAIN_LENGTH = 253;

// Website mode retains the OpenAI protection list. Only the explicit disposable
// ChatGPT browser mode uses a whole-session proxy; legacy flags and custom
// suffixes cannot silently opt in. Desktop clients are never configured here.
export const PROTECTED_OPENAI_DOMAINS = Object.freeze([
  'auth.openai.com',
  'chatgpt.com',
  'ct.sendgrid.net',
  'intercom.io',
  'intercomcdn.com',
  'oaistatic.com',
  'oaiusercontent.com',
  'openai.com',
  'oaistatsig.com',
  'android.chat.openai.com',
  'auth0.openai.com',
  'cdn.openaimerge.com',
  'cdn.workos.com',
  'challenges.cloudflare.com',
  'chat.openai.com',
  'desktop.chat.openai.com',
  'forwarder.workos.com',
  'humb.apple.com',
  'images.workoscdn.com',
  'ios.chat.openai.com',
  'js.intercomcdn.com',
  'js.stripe.com',
  'o207216.ingest.sentry.io',
  'o33249.ingest.sentry.io',
  'rum.browser-intake-datadoghq.com',
  'setup.auth.openai.com',
  'setup.workos.com',
  'tcr9i.chat.openai.com',
  'workos.imgix.net',
]);

export const IPINFO_DOMAIN_PRESET = Object.freeze(['ipinfo.io']);

export const DEFAULT_SPLIT_ROUTING_SETTINGS: SplitRoutingSettings = {
  mode: 'sites',
  chatgptEnabled: false,
  controllerPort: 9090,
  customDomains: [],
  ipinfoEnabled: true,
  primaryAdapterId: null,
  proxyAdapterId: null,
  version: 1,
};

function settingsPath(userDataDirectory: string): string {
  return path.join(userDataDirectory, SETTINGS_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeProxyDomain(value: string): string {
  let domain = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (domain.startsWith('*.')) domain = domain.slice(2);
  domain = domain.replace(/\.$/u, '');
  if (
    domain.length === 0 ||
    domain.length > MAX_DOMAIN_LENGTH ||
    domain.includes('://') ||
    /[/?#:@\s]/u.test(domain)
  ) {
    throw new Error(`Invalid proxy domain: ${value}`);
  }
  const labels = domain.split('.');
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new Error(`Invalid proxy domain: ${value}`);
  }
  return domain;
}

export function isProtectedOpenAiDomain(domain: string): boolean {
  const normalized = normalizeProxyDomain(domain);
  return PROTECTED_OPENAI_DOMAINS.some(
    (protectedDomain) =>
      normalized === protectedDomain ||
      normalized.endsWith(`.${protectedDomain}`) ||
      protectedDomain.endsWith(`.${normalized}`),
  );
}

function nullableAdapterId(value: unknown): string | null {
  if (value === null) return null;
  if (!isSafeAdapterId(value)) {
    throw new Error('Invalid network adapter identifier.');
  }
  return value;
}

export function parseSplitRoutingSettings(
  value: unknown,
): SplitRoutingSettings {
  if (!isRecord(value)) throw new Error('Invalid split-routing settings.');
  const mode = value.mode ?? 'sites';
  if (mode !== 'sites' && mode !== 'chatgpt-web') throw new Error('Unsupported isolated browser mode.');
  const controllerPort = value.controllerPort;
  if (
    !Number.isInteger(controllerPort) ||
    typeof controllerPort !== 'number' ||
    controllerPort < 1 ||
    controllerPort > 65_535
  ) {
    throw new Error('The FlClash controller port must be between 1 and 65535.');
  }
  if (
    typeof value.chatgptEnabled !== 'boolean' ||
    typeof value.ipinfoEnabled !== 'boolean' ||
    !Array.isArray(value.customDomains) ||
    value.customDomains.length > MAX_CUSTOM_DOMAINS
  ) {
    throw new Error('Invalid split-routing settings.');
  }
  const customDomains = value.customDomains.map((domain) => {
    if (typeof domain !== 'string') {
      throw new Error('Every custom proxy domain must be text.');
    }
    return normalizeProxyDomain(domain);
  });
  const uniqueDomains = [...new Set(customDomains)].sort();
  const primaryAdapterId = nullableAdapterId(value.primaryAdapterId);
  const proxyAdapterId = nullableAdapterId(value.proxyAdapterId);
  if (
    primaryAdapterId !== null &&
    primaryAdapterId === proxyAdapterId
  ) {
    throw new Error('The primary and proxy adapters must be different.');
  }
  if (uniqueDomains.some(isProtectedOpenAiDomain)) {
    throw new Error(
      'ChatGPT and OpenAI domains are protected in this safety release and cannot be routed by Cherry Toolbox.',
    );
  }
  return {
    // The old flag never authorizes desktop routing. Web routing has its own
    // explicit session mode; custom rules still cannot override protection.
    mode,
    chatgptEnabled: false,
    controllerPort,
    customDomains: uniqueDomains,
    ipinfoEnabled: value.ipinfoEnabled,
    primaryAdapterId,
    proxyAdapterId,
    version: 1,
  };
}

export function proxyDomainsForSettings(
  settings: SplitRoutingSettings,
): string[] {
  const domains = [
    ...(settings.ipinfoEnabled ? IPINFO_DOMAIN_PRESET : []),
    ...settings.customDomains,
  ];
  return [...new Set(domains.map(normalizeProxyDomain))].sort();
}

export async function loadSplitRoutingSettings(
  userDataDirectory: string,
): Promise<SplitRoutingSettings> {
  try {
    const contents = await readFile(settingsPath(userDataDirectory), 'utf8');
    const parsed = JSON.parse(contents) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) {
      return { ...DEFAULT_SPLIT_ROUTING_SETTINGS };
    }
    return parseSplitRoutingSettings(parsed);
  } catch {
    return { ...DEFAULT_SPLIT_ROUTING_SETTINGS };
  }
}

export async function saveSplitRoutingSettings(
  userDataDirectory: string,
  value: unknown,
): Promise<SplitRoutingSettings> {
  const settings = parseSplitRoutingSettings(value);
  await writeJsonAtomically(settingsPath(userDataDirectory), settings);
  return settings;
}
