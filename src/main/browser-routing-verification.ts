import { isIP } from 'node:net';
import type { BrowserControl } from './browser-control';
import type { DedicatedRouting } from './dedicated-routing';
import type { IsolatedBrowserSession } from './isolated-browser';
import { runPowerShellScript } from './network';
import type { SplitRoutingVerificationAdapters } from './split-routing-verification';

export async function browserPublicIp(browser: BrowserControl, url: string): Promise<string> {
  const target = await browser.command('Target.createTarget', { url: 'about:blank' });
  if (typeof target.targetId !== 'string') throw new Error('The browser could not create a verification tab.');
  try {
    const attached = await browser.command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const session = String(attached.sessionId);
    await browser.command('Page.navigate', { url }, session);
    for (let attempt = 0; attempt < 80; attempt++) {
      const response = await browser.command('Runtime.evaluate', { expression: 'JSON.stringify({href:location.href,text:document.body?.innerText})', returnByValue: true }, session);
      const result = response.result as { value?: string } | undefined;
      try {
        const document = JSON.parse(result?.value ?? '') as { href?: string; text?: string };
        if (document.href === url) {
          const body = JSON.parse(document.text ?? '') as { ip?: unknown };
          if (typeof body.ip === 'string' && isIP(body.ip.trim()) !== 0) return body.ip.trim();
        }
      } catch { /* Wait for the isolated IP-check document, never inspect a chat. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('The browser did not receive an IP response through its configured proxy.');
  } finally { await browser.command('Target.closeTarget', { targetId: target.targetId }); }
}

export async function confirmChatGptDocument(browser: BrowserControl): Promise<boolean> {
  const result = await browser.command('Target.getTargets');
  const targets = result.targetInfos as { type: string; url: string; targetId: string }[];
  const target = targets.find(value => {
    try { return value.type === 'page' && new URL(value.url).origin === 'https://chatgpt.com'; }
    catch { return false; }
  });
  if (!target) return false;
  const attached = await browser.command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  try {
    // Only origin/readiness/security metadata; no cookies, page text or inputs.
    const response = await browser.command('Runtime.evaluate', { expression: '({origin:location.origin,ready:document.readyState,secure:isSecureContext})', returnByValue: true }, String(attached.sessionId));
    const document = (response.result as { value?: { origin?: string; ready?: string; secure?: boolean } })?.value;
    return document?.origin === 'https://chatgpt.com' && document.secure === true && (document.ready === 'complete' || document.ready === 'interactive');
  } finally { await browser.command('Target.detachFromTarget', { sessionId: attached.sessionId }); }
}

export function evaluateBrowserEgress(
  evidence: { addresses: string[]; sockets: string[] },
  observations: readonly Record<string, unknown>[],
  mode: SplitRoutingMode, started: number, chatgptDocument: boolean,
): { confirmed: boolean; direct: Record<string, unknown> | undefined; proxy: Record<string, unknown> | undefined; chatgpt: boolean } {
  if (!Array.isArray(evidence.addresses) || !Array.isArray(evidence.sockets) || [...evidence.addresses, ...evidence.sockets].some(value => typeof value !== 'string' || isIP(value) === 0)) throw new Error('Windows returned invalid browser egress evidence.');
  const direct = observations.find(value => value.host === 'api.ipify.org' && value.lane === 'primary' && Date.parse(String(value.at)) >= started);
  const proxy = observations.find(value => value.host === 'ipinfo.io' && value.lane === 'proxy' && Date.parse(String(value.at)) >= started);
  const chatgpt = chatgptDocument && observations.some(value => value.host === 'chatgpt.com' && value.lane === 'proxy');
  const sockets = evidence.sockets.length > 0 && evidence.sockets.every(value => evidence.addresses.includes(value));
  const confirmed = Boolean(sockets && proxy && (mode === 'sites' ? direct : chatgpt && !observations.some(value => value.lane === 'primary')));
  return { confirmed, direct, proxy, chatgpt };
}

export async function verifyBrowserRouting(
  session: IsolatedBrowserSession,
  adapters: SplitRoutingVerificationAdapters,
  routing: Pick<DedicatedRouting, 'corePid' | 'isRunning' | 'evidence'>,
  systemRoutingUnchanged: boolean,
  mode: SplitRoutingMode = 'sites',
): Promise<SplitRoutingVerificationResult> {
  if (!routing.isRunning || !routing.corePid || !session.control) throw new Error('The private browser or dedicated routing processes are unavailable.');
  const started = Date.now(), browser = session.control;
  const directIp = mode === 'sites' ? await browserPublicIp(browser, 'https://api.ipify.org/?format=json&cherry=' + started) : '';
  const proxyIp = await browserPublicIp(browser, 'https://ipinfo.io/json?cherry=' + started);
  const chatgptDocument = mode === 'chatgpt-web' && await confirmChatGptDocument(browser);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$addresses = @(Get-NetIPAddress -InterfaceIndex ' + adapters.proxy.interfaceIndex + ' -AddressFamily IPv4 -ErrorAction Stop | Select-Object -ExpandProperty IPAddress)',
    '$sockets = @(Get-NetTCPConnection -OwningProcess ' + routing.corePid + " -State Established -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -notin @('127.0.0.1','::1') } | Select-Object -ExpandProperty LocalAddress -Unique)",
    'ConvertTo-Json -InputObject @{ addresses = @($addresses); sockets = @($sockets) } -Compress',
  ].join('\n');
  const evidence = JSON.parse(await runPowerShellScript(script)) as { addresses: string[]; sockets: string[] };
  const evaluated = evaluateBrowserEgress(evidence, routing.evidence, mode, started, chatgptDocument);
  return {
    mode, chatgptConnectionConfirmed: evaluated.chatgpt,
    checkedAt: new Date().toISOString(),
    direct: { adapterName: adapters.primary.adapterName, localAddress: String(evaluated.direct?.localAddress ?? ''), publicIp: directIp },
    proxied: { adapterName: adapters.proxy.adapterName, localAddresses: evidence.sockets, publicIp: proxyIp },
    egressObservation: evaluated.confirmed ? 'proxy' : 'unknown',
    passed: evaluated.confirmed && systemRoutingUnchanged && routing.isRunning,
    publicIpsDiffer: mode === 'sites' && directIp !== proxyIp, systemRoutingUnchanged,
  };
}
