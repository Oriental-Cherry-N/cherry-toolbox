import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFile, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { connect, isIP } from 'node:net';
import path from 'node:path';

import { parse, stringify } from 'yaml';

import { runPowerShellScript } from './network';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ENDPOINT_HOSTS = 2048;
const REQUEST_TIMEOUT_MS = 7_500;
const MIXED_PORT_READY_TIMEOUT_MS = 30_000;

type YamlRecord = Record<string, unknown>;

export interface FlClashPreparedRuntime {
  canonicalConfigHash: string;
  canonicalConfigPath: string;
  endpointHosts: string[];
  mixedPort: number;
  mixedPortSource: 'canonical' | 'runtime';
  selectorChoices: Record<string, string>;
  temporaryPayload: string;
  watchedFiles: string[];
}

export interface FlClashReadOnlyRuntime {
  controller: string;
  mixedPort: number;
}

export async function readDedicatedProxyNode(options: ControllerOptions): Promise<YamlRecord> {
  const configPath = defaultFlClashConfigPath();
  const [contents, response] = await Promise.all([readFile(configPath, 'utf8'), controllerRequest(options, 'GET', '/proxies')]);
  const config = parseYamlRecord(contents, 'FlClash config');
  const nodes: unknown[] = Array.isArray(config.proxies) ? [...config.proxies] : [];
  if (isRecord(config['proxy-providers'])) {
    for (const provider of Object.values(config['proxy-providers'])) {
      if (!isRecord(provider)) continue;
      if (Array.isArray(provider.payload)) nodes.push(...provider.payload);
      else if (typeof provider.path === 'string') {
        const providerConfig = parseYamlRecord(await readFile(safeProviderPath(configPath, provider.path), 'utf8'), 'FlClash provider cache');
        if (Array.isArray(providerConfig.proxies)) nodes.push(...providerConfig.proxies);
      }
    }
  }
  if (!isRecord(response) || !isRecord(response.proxies)) throw new Error('FlClash did not return its selected node.');
  let selected = 'GLOBAL';
  const seen = new Set<string>();
  while (true) {
    if (seen.has(selected)) throw new Error('FlClash selected a cyclic proxy group.');
    seen.add(selected);
    const entry = response.proxies[selected];
    if (isRecord(entry) && typeof entry.now === 'string') { selected = entry.now; continue; }
    break;
  }
  const matches = nodes.filter((value): value is YamlRecord => isRecord(value) && value.name === selected);
  if (matches.length !== 1) throw new Error('Choose a concrete proxy node in FlClash GLOBAL before starting isolated routing. DIRECT, REJECT and ambiguous nodes are not allowed.');
  const node = structuredClone(matches[0] as YamlRecord);
  if (!['ss', 'vmess', 'vless', 'trojan', 'http', 'socks5', 'anytls', 'snell'].includes(String(node.type)) || node.plugin || node['dialer-proxy'] || node['ip-version'] === 'ipv6') {
    throw new Error('The selected node requires an unsupported transport or plugin. Choose a TCP proxy node for the isolated session.');
  }
  if (typeof node.server !== 'string' || typeof node.port !== 'number' || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) throw new Error('The selected proxy node has an invalid endpoint.');
  for (const key of ['certificate', 'private-key', 'client-certificate', 'client-key']) if (key in node) throw new Error('Nodes with external certificate files are not supported by isolated routing.');
  node.name = 'CHERRY-SELECTED';
  node.udp = false;
  node['skip-cert-verify'] = false;
  delete node['routing-mark'];
  delete node['interface-name'];
  return node;
}

interface ControllerOptions {
  port: number;
  secret: string;
}

function isRecord(value: unknown): value is YamlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertControllerOptions(options: ControllerOptions): void {
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65_535
  ) {
    throw new Error('Invalid FlClash controller port.');
  }
  if (options.secret.length > 4096) {
    throw new Error('The FlClash controller secret is too long.');
  }
}

async function controllerRequest(
  options: ControllerOptions,
  method: 'GET' | 'PUT',
  requestPath: string,
  body?: unknown,
): Promise<unknown> {
  assertControllerOptions(options);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { Accept: 'application/json' };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (options.secret) headers.Authorization = `Bearer ${options.secret}`;

    const outgoing = request(
      {
        headers,
        host: LOOPBACK_HOST,
        method,
        path: requestPath,
        port: options.port,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
          else outgoing.destroy(new Error('FlClash returned too much data.'));
        });
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            const detail = statusCode === 401
              ? 'FlClash rejected the controller secret.'
              : `FlClash controller returned HTTP ${statusCode}.`;
            reject(new Error(detail));
            return;
          }
          if (!responseBody.trim()) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(responseBody) as unknown);
          } catch (error) {
            reject(new Error('FlClash returned invalid JSON.', { cause: error }));
          }
        });
      },
    );
    outgoing.on('timeout', () =>
      outgoing.destroy(new Error('FlClash controller timed out.')),
    );
    outgoing.on('error', reject);
    if (payload !== null) outgoing.write(payload);
    outgoing.end();
  });
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseYamlRecord(contents: string, label: string): YamlRecord {
  let parsed: unknown;
  try {
    parsed = parse(contents) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid YAML.`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${label} must contain a YAML map.`);
  return parsed;
}

function proxyEndpoint(proxy: unknown): string | null {
  if (!isRecord(proxy)) return null;
  const type = typeof proxy.type === 'string'
    ? proxy.type.toLocaleLowerCase('en-US')
    : '';
  if (['compatible', 'direct', 'dns', 'pass', 'reject'].includes(type)) {
    return null;
  }
  return typeof proxy.server === 'string' && proxy.server.trim()
    ? proxy.server.trim()
    : null;
}

function endpointFromDnsValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().split('#', 1)[0] ?? '';
  if (!trimmed || /^(?:dhcp|rcode|system)(?::|$)/iu.test(trimmed)) return null;
  if (isIP(trimmed)) return trimmed;
  try {
    const parsedUrl = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
        ? trimmed
        : `dns://${trimmed}`,
    );
    return parsedUrl.hostname.replace(/^\[|\]$/gu, '') || null;
  } catch {
    return null;
  }
}

function addDnsEndpoints(config: YamlRecord, endpoints: Set<string>): void {
  if (!isRecord(config.dns)) return;
  for (const key of [
    'default-nameserver',
    'direct-nameserver',
    'fallback',
    'nameserver',
    'proxy-server-nameserver',
    'proxy-server-nameserver-policy',
    'nameserver-policy',
  ]) {
    const value = config.dns[key];
    const values = Array.isArray(value)
      ? value
      : isRecord(value)
        ? Object.values(value).flatMap((item) =>
            Array.isArray(item) ? item : [item],
          )
        : [value];
    for (const candidate of values) {
      const endpoint = endpointFromDnsValue(candidate);
      if (endpoint) endpoints.add(endpoint);
    }
  }
}

function addRemoteResourceEndpoints(
  config: YamlRecord,
  endpoints: Set<string>,
): void {
  for (const sectionName of ['proxy-providers', 'rule-providers']) {
    const section = config[sectionName];
    if (!isRecord(section)) continue;
    for (const provider of Object.values(section)) {
      if (!isRecord(provider)) continue;
      const endpoint = endpointFromDnsValue(provider.url);
      if (endpoint) endpoints.add(endpoint);
    }
  }
}

function safeProviderPath(configPath: string, providerPath: string): string {
  const configDirectory = path.dirname(configPath);
  const resolved = path.resolve(configDirectory, providerPath);
  const relative = path.relative(configDirectory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('A FlClash proxy provider path escapes its config directory.');
  }
  return resolved;
}

async function collectProviderEndpoints(
  configPath: string,
  config: YamlRecord,
  proxyAdapterName: string,
  endpoints: Set<string>,
  watchedFiles: Set<string>,
): Promise<void> {
  if (!isRecord(config['proxy-providers'])) return;
  for (const provider of Object.values(config['proxy-providers'])) {
    if (!isRecord(provider)) continue;
    const override = isRecord(provider.override) ? provider.override : {};
    override['interface-name'] = proxyAdapterName;
    provider.override = override;
    if (Array.isArray(provider.payload)) {
      for (const proxy of provider.payload) {
        const endpoint = proxyEndpoint(proxy);
        if (endpoint) endpoints.add(endpoint);
      }
      continue;
    }
    if (typeof provider.path !== 'string' || !provider.path.trim()) {
      throw new Error(
        'Every proxy provider needs a local cache path for fail-closed routing.',
      );
    }
    const providerPath = safeProviderPath(configPath, provider.path.trim());
    const contents = await readFile(providerPath, 'utf8');
    const providerConfig = parseYamlRecord(contents, 'FlClash proxy provider');
    const proxies = Array.isArray(providerConfig.proxies)
      ? providerConfig.proxies
      : [];
    for (const proxy of proxies) {
      const endpoint = proxyEndpoint(proxy);
      if (endpoint) endpoints.add(endpoint);
    }
    watchedFiles.add(providerPath);
  }
}

function bindInlineProxies(
  config: YamlRecord,
  proxyAdapterName: string,
  endpoints: Set<string>,
): void {
  const proxies = Array.isArray(config.proxies) ? config.proxies : [];
  for (const proxy of proxies) {
    const endpoint = proxyEndpoint(proxy);
    if (endpoint) endpoints.add(endpoint);
    if (endpoint && isRecord(proxy)) proxy['interface-name'] = proxyAdapterName;
  }
}

function selectorChoices(value: unknown): Record<string, string> {
  if (!isRecord(value) || !isRecord(value.proxies)) return {};
  const choices: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, proxy] of Object.entries(value.proxies)) {
    if (
      isRecord(proxy) &&
      typeof proxy.type === 'string' &&
      proxy.type.toLocaleLowerCase('en-US') === 'selector' &&
      typeof proxy.now === 'string' &&
      proxy.now.length > 0 &&
      proxy.now.length <= 512
    ) {
      choices[name] = proxy.now;
    }
  }
  return choices;
}

function validPort(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
    ? value
    : null;
}

function mixedPortFromConfigs(
  runtimeConfig: unknown,
  canonicalConfig: YamlRecord,
): { port: number; source: 'canonical' | 'runtime' } {
  if (!isRecord(runtimeConfig)) {
    throw new Error('FlClash returned invalid config data.');
  }
  const runtimePort = validPort(runtimeConfig['mixed-port']);
  if (runtimePort !== null) return { port: runtimePort, source: 'runtime' };

  // FlClash may keep its GUI-managed mixed listener alive while Mihomo's
  // /configs response reports mixed-port: 0. The canonical config is the exact
  // payload we validate and temporarily reload during activation, so it is the
  // authoritative fallback in that case.
  const canonicalPort = validPort(canonicalConfig['mixed-port']);
  if (canonicalPort !== null) {
    return { port: canonicalPort, source: 'canonical' };
  }
  throw new Error(
    'FlClash mixed-port is disabled or invalid in both the runtime API and canonical config.',
  );
}

function assertLoopbackController(value: unknown, expectedPort: number): void {
  if (!isRecord(value)) throw new Error('FlClash returned invalid config data.');
  const controller = value['external-controller'];
  if (controller === undefined || controller === null || controller === '') {
    return;
  }
  if (typeof controller !== 'string') {
    throw new Error('FlClash returned an invalid external-controller value.');
  }
  const normalized = controller.trim().toLocaleLowerCase('en-US');
  const allowed = new Set([
    `127.0.0.1:${expectedPort}`,
    `[::1]:${expectedPort}`,
    `localhost:${expectedPort}`,
  ]);
  if (!allowed.has(normalized)) {
    throw new Error(
      'FlClash external-controller must be bound only to 127.0.0.1 or ::1.',
    );
  }
}

export async function inspectFlClashRuntimeReadOnly(
  options: ControllerOptions,
): Promise<FlClashReadOnlyRuntime> {
  const runtime = await controllerRequest(options, 'GET', '/configs');
  assertLoopbackController(runtime, options.port);
  if (!isRecord(runtime)) {
    throw new Error('FlClash returned invalid config data.');
  }
  const mixedPort = validPort(runtime['mixed-port']);
  if (mixedPort === null) {
    throw new Error(
      'FlClash mixed-port must already be enabled. Cherry Toolbox safety mode will not change FlClash.',
    );
  }
  return {
    controller: `127.0.0.1:${options.port}`,
    mixedPort,
  };
}

export async function assertFlClashMixedPortIsLoopbackOnly(
  port: number,
): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Invalid FlClash mixed proxy port.');
  }
  const output = await runPowerShellScript(String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress -Unique)
ConvertTo-Json -InputObject @($listeners) -Compress
`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim()) as unknown;
  } catch (error) {
    throw new Error('Windows returned invalid FlClash listener data.', {
      cause: error,
    });
  }
  const listeners = Array.isArray(parsed) ? parsed : [parsed];
  if (
    listeners.length === 0 ||
    listeners.some(
      (address) =>
        address !== '127.0.0.1' &&
        address !== '::1' &&
        address !== '::ffff:127.0.0.1',
    )
  ) {
    throw new Error(
      `FlClash mixed proxy on port ${port} must listen only on localhost; wildcard or LAN listeners are refused.`,
    );
  }
}

export function defaultFlClashConfigPath(): string {
  const appData = process.env.APPDATA;
  if (!appData || !path.isAbsolute(appData)) {
    throw new Error('Windows APPDATA is unavailable.');
  }
  return path.join(appData, 'com.follow', 'clash', 'config.yaml');
}

export async function prepareFlClashRuntime(
  proxyAdapterName: string,
  options: ControllerOptions,
  configPath = defaultFlClashConfigPath(),
): Promise<FlClashPreparedRuntime> {
  assertControllerOptions(options);
  const [runtimeConfig, proxiesResponse, canonicalContents] = await Promise.all([
    controllerRequest(options, 'GET', '/configs'),
    controllerRequest(options, 'GET', '/proxies'),
    readFile(configPath, 'utf8'),
  ]);
  const config = parseYamlRecord(canonicalContents, 'FlClash config');
  const mixedPort = mixedPortFromConfigs(runtimeConfig, config);
  assertLoopbackController(runtimeConfig, options.port);
  const endpoints = new Set<string>();
  const watchedFiles = new Set<string>([configPath]);

  bindInlineProxies(config, proxyAdapterName, endpoints);
  await collectProviderEndpoints(
    configPath,
    config,
    proxyAdapterName,
    endpoints,
    watchedFiles,
  );
  addDnsEndpoints(config, endpoints);
  addRemoteResourceEndpoints(config, endpoints);
  config['interface-name'] = proxyAdapterName;
  config['external-controller'] = `${LOOPBACK_HOST}:${options.port}`;
  config.secret = options.secret;

  if (endpoints.size === 0) {
    throw new Error('No routable FlClash proxy endpoints were found.');
  }
  if (endpoints.size > MAX_ENDPOINT_HOSTS) {
    throw new Error('The FlClash config contains too many proxy endpoints.');
  }

  return {
    canonicalConfigHash: hashText(canonicalContents),
    canonicalConfigPath: configPath,
    endpointHosts: [...endpoints].sort(),
    mixedPort: mixedPort.port,
    mixedPortSource: mixedPort.source,
    selectorChoices: selectorChoices(proxiesResponse),
    temporaryPayload: stringify(config, { lineWidth: 0 }),
    watchedFiles: [...watchedFiles],
  };
}

export async function resolveEndpointAddresses(
  endpoints: readonly string[],
): Promise<string[]> {
  const addresses = new Set<string>();
  for (const endpoint of endpoints) {
    if (isIP(endpoint)) {
      addresses.add(endpoint);
      continue;
    }
    let resolved;
    try {
      resolved = await lookup(endpoint, { all: true, verbatim: true });
    } catch (error) {
      throw new Error(`Unable to resolve FlClash endpoint ${endpoint}.`, {
        cause: error,
      });
    }
    if (resolved.length === 0) {
      throw new Error(`FlClash endpoint ${endpoint} resolved to no addresses.`);
    }
    for (const item of resolved) addresses.add(item.address);
  }
  return [...addresses].sort();
}

export async function applyFlClashRuntime(
  prepared: FlClashPreparedRuntime,
  options: ControllerOptions,
): Promise<void> {
  await controllerRequest(options, 'PUT', '/configs?force=true', {
    payload: prepared.temporaryPayload,
  });
  await applySelectorChoices(prepared.selectorChoices, options);
}

export function waitForFlClashMixedPort(
  port: number,
  timeoutMs = MIXED_PORT_READY_TIMEOUT_MS,
): Promise<void> {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60_000
  ) {
    return Promise.reject(new Error('Invalid FlClash mixed-port readiness check.'));
  }
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      let finished = false;
      const socket = connect({ host: LOOPBACK_HOST, port });
      const finishAttempt = (ready: boolean): void => {
        if (finished) return;
        finished = true;
        socket.destroy();
        if (ready) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(
            new Error(
              `FlClash mixed proxy did not start listening on 127.0.0.1:${port}.`,
            ),
          );
          return;
        }
        setTimeout(attempt, 100).unref();
      };
      socket.setTimeout(500, () => finishAttempt(false));
      socket.once('connect', () => finishAttempt(true));
      socket.once('error', () => finishAttempt(false));
    };
    attempt();
  });
}

async function applySelectorChoices(
  choices: Readonly<Record<string, string>>,
  options: ControllerOptions,
): Promise<void> {
  for (const [groupName, selectedName] of Object.entries(choices)) {
    try {
      await controllerRequest(
        options,
        'PUT',
        `/proxies/${encodeURIComponent(groupName)}`,
        { name: selectedName },
      );
    } catch (error) {
      throw new Error(
        `Unable to restore the FlClash selection for ${groupName}.`,
        { cause: error },
      );
    }
  }
}

export async function restoreFlClashRuntime(
  canonicalConfigPath: string,
  options: ControllerOptions,
  choices: Readonly<Record<string, string>>,
): Promise<void> {
  const canonicalContents = await readFile(canonicalConfigPath, 'utf8');
  parseYamlRecord(canonicalContents, 'FlClash config');
  await controllerRequest(options, 'PUT', '/configs?force=true', {
    payload: canonicalContents,
  });
  await applySelectorChoices(choices, options);
}

export async function flClashControllerIsAlive(
  options: ControllerOptions,
): Promise<boolean> {
  try {
    await controllerRequest(options, 'GET', '/configs');
    return true;
  } catch {
    return false;
  }
}

export async function watchedFileSignature(files: readonly string[]): Promise<string> {
  const records: string[] = [];
  for (const file of [...files].sort()) {
    const details = await stat(file);
    records.push(`${file}\0${details.size}\0${details.mtimeMs}`);
  }
  return hashText(records.join('\n'));
}
