import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';

import { writeJsonAtomically } from './file-store';
import { waitForFlClashMixedPort, readDedicatedProxyNode } from './flclash';
import { cleanupAll, ComponentLifecycle } from './lifecycle';
import { nativeHelperPath, startNativeHelper, stopNativeHelper, type NativeEvent } from './native-helper';
import { runPowerShellScript } from './network';
import { PROTECTED_OPENAI_DOMAINS } from './split-routing-settings';

interface RoutingAdapter { id: string; name: string; interfaceIndex: number }
export interface DedicatedPreparation { node: Record<string, unknown>; corePath: string }

export async function inspectDedicatedRouting(port: number, secret: string): Promise<DedicatedPreparation> {
  await nativeHelperPath();
  const corePath = path.resolve(__dirname, '../../native/bin/mihomo.exe').replace(/app\.asar([\\/])/u, 'app.asar.unpacked$1');
  const manifest = JSON.parse(await readFile(path.resolve(__dirname, '../../native/core-manifest.json'), 'utf8')) as { binarySha256: string };
  const binary = await readFile(corePath);
  if (createHash('sha256').update(binary).digest('hex') !== manifest.binarySha256) throw new Error('The dedicated proxy core does not match the pinned official version. Run scripts/setup-routing-core.cjs.');
  return { corePath, node: await readDedicatedProxyNode({ port, secret }) };
}

async function vacantPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback endpoint.');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export function buildDedicatedConfig(node: Record<string, unknown>, adapter: RoutingAdapter, address: string, dns: string[], port: number, username: string, password: string): Record<string, unknown> {
  if (isIP(address) !== 4 || dns.length === 0 || dns.some(value => isIP(value) !== 4) || /[#\r\n]/u.test(adapter.name)) throw new Error('Dedicated routing requires a valid IPv4 endpoint and interface DNS servers.');
  const selected = { ...node, server: address, 'interface-name': adapter.name, udp: false, 'skip-cert-verify': false };
  if (isIP(String(node.server)) === 0) {
    if (!('servername' in selected)) Object.assign(selected, { servername: node.server });
    if (!('sni' in selected)) Object.assign(selected, { sni: node.server });
  }
  return {
    'mixed-port': port, 'allow-lan': false, 'bind-address': '127.0.0.1', authentication: [`${username}:${password}`],
    'skip-auth-prefixes': [], mode: 'rule', ipv6: false, 'log-level': 'silent',
    'interface-name': adapter.name, 'external-controller': '', 'external-controller-pipe': '',
    'geodata-mode': false, 'geo-auto-update': false, 'unified-delay': false,
    tun: { enable: false }, sniffer: { enable: false }, profile: { 'store-selected': false, 'store-fake-ip': false },
    dns: { enable: true, ipv6: false, 'use-system-hosts': false, 'enhanced-mode': 'redir-host',
      nameserver: dns.map(value => `tcp://${value}#${adapter.name}`), 'default-nameserver': dns.map(value => `tcp://${value}#${adapter.name}`),
      'proxy-server-nameserver': dns.map(value => `tcp://${value}#${adapter.name}`), fallback: [] },
    proxies: [selected], 'proxy-groups': [], rules: [
      'DOMAIN-SUFFIX,localhost,REJECT', 'DOMAIN-SUFFIX,local,REJECT',
      ...['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4'].map(cidr => `IP-CIDR,${cidr},REJECT`),
      'MATCH,CHERRY-SELECTED',
    ],
  };
}

export class DedicatedRouting {
  private frontend: ChildProcessWithoutNullStreams | null = null;
  private core: ChildProcessWithoutNullStreams | null = null;
  private readonly lifecycle = new ComponentLifecycle();
  private directory: string | null = null;
  private endpoint: string | null = null;
  private readonly pending = new Map<string, (event: NativeEvent) => void>();
  private readonly observations: NativeEvent[] = [];
  private failure: Error | null = null;
  private coreProcessId: number | null = null;
  constructor(private readonly dataDirectory: string) {}
  get url(): string | null { return this.endpoint; }
  get corePid(): number | null { return this.coreProcessId; }
  get isRunning(): boolean { return !this.failure && Boolean(this.core && this.frontend && this.core.exitCode === null && this.core.signalCode === null && this.frontend.exitCode === null && this.frontend.signalCode === null); }
  get evidence(): NativeEvent[] { return this.observations.map(value => ({ ...value })); }
  private get marker(): string { return path.join(this.dataDirectory, 'dedicated-routing-session.json'); }

  async recover(): Promise<void> {
    let record: { directory: string; version: number };
    try { record = JSON.parse(await readFile(this.marker, 'utf8')) as typeof record; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const full = path.resolve(record.directory);
    if (record.version !== 1 || path.dirname(full).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(full).startsWith('cherry-toolbox-routing-')) throw new Error('Invalid dedicated proxy recovery record.');
    const encoded = Buffer.from(full, 'utf8').toString('base64');
    await runPowerShellScript(String.raw`
$ErrorActionPreference = 'Stop'
$directory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$pattern = '(?:^|\s)"?-d"?\s+"?' + [regex]::Escape($directory) + '(?:"|\s|$)'
$owned = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -eq 'mihomo.exe' -and $_.CommandLine -match $pattern })
foreach ($item in $owned) { Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop }
foreach ($item in $owned) {
  if (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue) { Wait-Process -Id $item.ProcessId -Timeout 10 -ErrorAction Stop }
}
$remaining = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -eq 'mihomo.exe' -and $_.CommandLine -match $pattern })
if ($remaining.Count -gt 0) { throw 'The dedicated proxy is still running; recovery remains pending.' }
`);
    try { if ((await lstat(full)).isSymbolicLink()) throw new Error('Refusing a linked routing directory.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rm(full, { recursive: true, force: true, maxRetries: 4 });
    await rm(this.marker, { force: true });
  }

  start(prepared: DedicatedPreparation, primary: RoutingAdapter, proxy: RoutingAdapter, domains: string[], mode: SplitRoutingMode = 'sites'): Promise<string> {
    return this.lifecycle.run(async () => {
      if (this.frontend || this.core) throw new Error('Stop the dedicated routing session first.');
      await this.recover(); this.failure = null; this.observations.length = 0;
      const event = (value: NativeEvent): void => {
        if (value.type === 'error') this.failure = new Error(String(value.message));
        if (value.type === 'connection') { this.observations.push(value); if (this.observations.length > 512) this.observations.shift(); }
        if (typeof value.id === 'string') this.pending.get(value.id)?.(value);
      };
      try {
        const frontend = await startNativeHelper('proxy', { mode, primaryId: primary.id, primaryIndex: primary.interfaceIndex, proxyId: proxy.id, proxyIndex: proxy.interfaceIndex, domains, protectedDomains: PROTECTED_OPENAI_DOMAINS }, event);
        this.frontend = frontend.child;
        const id = randomUUID();
        const resolved = await new Promise<NativeEvent>((resolve, reject) => {
          const timer = setTimeout(() => { this.pending.delete(id); reject(this.failure ?? new Error('Interface-bound proxy node DNS timed out.')); }, 30000);
          this.pending.set(id, value => { clearTimeout(timer); this.pending.delete(id); resolve(value); });
          this.frontend?.stdin.write(JSON.stringify({ type: 'resolve', id, host: prepared.node.server }) + '\n');
        });
        const port = await vacantPort(), username = 'cherry', password = randomBytes(32).toString('hex');
        const config = buildDedicatedConfig(prepared.node, proxy, String(resolved.address), frontend.ready.proxyDns as string[], port, username, password);
        this.directory = path.join(os.tmpdir(), 'cherry-toolbox-routing-' + randomUUID());
        await writeJsonAtomically(this.marker, { version: 1, directory: this.directory });
        await mkdir(this.directory);
        const configPath = path.join(this.directory, 'config.yaml');
        await writeFile(configPath, stringify(config), { flag: 'wx', mode: 0o600, flush: true });
        const core = await startNativeHelper('job', { executable: prepared.corePath, arguments: ['-d', this.directory, '-f', configPath], workingDirectory: this.directory, cleanupDirectory: this.directory });
        this.core = core.child;
        if (typeof core.ready.pid !== 'number') throw new Error('The dedicated core did not identify its process.');
        this.coreProcessId = core.ready.pid;
        await waitForFlClashMixedPort(port);
        const upstreamId = randomUUID();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { this.pending.delete(upstreamId); reject(this.failure ?? new Error('The routing gateway did not confirm its upstream.')); }, 15000);
          this.pending.set(upstreamId, value => {
            clearTimeout(timer); this.pending.delete(upstreamId);
            if (value.type === 'upstream-ready') resolve();
            else reject(new Error('The routing gateway returned an unexpected upstream response.'));
          });
          this.frontend?.stdin.write(JSON.stringify({ type: 'upstream', id: upstreamId, port, username, password }) + '\n');
        });
        if (!this.isRunning) throw new Error('The dedicated interface-bound routing processes stopped during startup.');
        this.endpoint = `http://127.0.0.1:${String(frontend.ready.port)}`;
        return this.endpoint;
      } catch (error) { try { await this.stopInternal(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Dedicated routing startup and cleanup failed; recovery remains pending.'); } throw error; }
    });
  }
  stop(): Promise<void> { return this.lifecycle.stop(() => this.stopInternal()); }
  private async stopInternal(): Promise<void> {
    await cleanupAll([
      async () => { if (this.frontend) { await stopNativeHelper(this.frontend); this.frontend = null; } },
      async () => { if (this.core) { await stopNativeHelper(this.core); this.core = null; } },
    ]);
    await this.recover(); this.directory = null; this.endpoint = null; this.failure = null; this.coreProcessId = null;
  }
}
