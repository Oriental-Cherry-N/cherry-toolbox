import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { PROTECTED_OPENAI_DOMAINS } from './split-routing-settings';

const LOOPBACK_HOST = '127.0.0.1';

function jsString(value: string): string {
  return JSON.stringify(value);
}

export function buildPacScript(
  domains: readonly string[],
  mixedPort: number,
): string {
  if (!Number.isInteger(mixedPort) || mixedPort < 1 || mixedPort > 65_535) {
    throw new Error('Invalid FlClash mixed proxy port.');
  }
  const serializedDomains = domains.map(jsString).join(', ');
  return `// Cherry Toolbox split-routing PAC\n` +
    `// Matched traffic fails closed: no DIRECT fallback is returned.\n` +
    `var CHERRY_PROXY_DOMAINS = [${serializedDomains}];\n` +
    `var CHERRY_PROTECTED_DOMAINS = ${JSON.stringify(PROTECTED_OPENAI_DOMAINS)};\n` +
    `function cherryDomainMatches(host, domain) {\n` +
    `  return host === domain || host.slice(-(domain.length + 1)) === "." + domain;\n` +
    `}\n` +
    `function cherryIsLocal(host) {\n` +
    `  if (isPlainHostName(host) || host === "localhost" || host === "::1") return true;\n` +
    `  if (/^127\\./.test(host) || /^10\\./.test(host) || /^192\\.168\\./.test(host)) return true;\n` +
    `  var match = /^(172)\\.(\\d{1,3})\\./.exec(host);\n` +
    `  return !!match && Number(match[2]) >= 16 && Number(match[2]) <= 31;\n` +
    `}\n` +
    `function FindProxyForURL(url, host) {\n` +
    `  host = String(host || "").toLowerCase().replace(/\\.$/, "");\n` +
    `  if (cherryIsLocal(host)) return "DIRECT";\n` +
    `  for (var protectedIndex = 0; protectedIndex < CHERRY_PROTECTED_DOMAINS.length; protectedIndex += 1) {\n` +
    `    if (cherryDomainMatches(host, CHERRY_PROTECTED_DOMAINS[protectedIndex])) return "DIRECT";\n` +
    `  }\n` +
    `  for (var index = 0; index < CHERRY_PROXY_DOMAINS.length; index += 1) {\n` +
    `    if (cherryDomainMatches(host, CHERRY_PROXY_DOMAINS[index])) {\n` +
    `      return "PROXY 127.0.0.1:${mixedPort}";\n` +
    `    }\n` +
    `  }\n` +
    `  return "DIRECT";\n` +
    `}\n`;
}

export class PacServer {
  private server: Server | null = null;
  private token = '';
  private script = '';
  private urlValue: string | null = null;

  get url(): string | null {
    return this.urlValue;
  }

  setFailClosed(domains: readonly string[]): void {
    if (!this.server || !this.urlValue) {
      throw new Error('The PAC server is not running.');
    }
    const failClosedPort = Number(new URL(this.urlValue).port);
    this.script = buildPacScript(domains, failClosedPort);
  }

  async start(domains: readonly string[], mixedPort: number): Promise<string> {
    if (this.server) throw new Error('The PAC server is already running.');
    this.script = buildPacScript(domains, mixedPort);
    this.token = randomBytes(24).toString('hex');
    const expectedPath = `/${this.token}.pac`;
    const server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== expectedPath) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Type': 'application/x-ns-proxy-autoconfig; charset=utf-8',
        Expires: '0',
      });
      response.end(this.script);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(0, LOOPBACK_HOST, () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Windows did not allocate a PAC server port.');
    }
    this.server = server;
    this.urlValue = `http://${LOOPBACK_HOST}:${address.port}${expectedPath}`;
    return this.urlValue;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.urlValue = null;
    this.token = '';
    this.script = '';
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
