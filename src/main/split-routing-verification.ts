import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import { runPowerShellScript } from './network';

export interface SplitRoutingVerificationAdapters {
  primary: {
    adapterName: string;
    interfaceIndex: number;
  };
  proxy: {
    adapterName: string;
    interfaceIndex: number;
  };
}

const IPINFO_HOST = 'ipinfo.io';
const IPINFO_PATH = '/json';
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;

interface NetworkEvidence {
  egressAddresses: string[];
  primaryAddresses: string[];
  primarySourceAddress: string;
  proxyAddresses: string[];
}

interface RawNetworkEvidence {
  egressAddresses?: unknown;
  primaryAddresses?: unknown;
  primarySourceAddress?: unknown;
  proxyAddresses?: unknown;
}

function encodePayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function stringArray(value: unknown, label: string): string[] {
  const values = value === null || value === undefined
    ? []
    : Array.isArray(value)
      ? value
      : [value];
  if (
    values.length > 128 ||
    !values.every((item) => typeof item === 'string' && isIP(item) !== 0)
  ) {
    throw new Error(`Windows returned invalid ${label}.`);
  }
  return [...new Set(values as string[])];
}

function parseNetworkEvidence(value: string): NetworkEvidence {
  let parsed: RawNetworkEvidence;
  try {
    parsed = JSON.parse(value) as RawNetworkEvidence;
  } catch (error) {
    throw new Error('Windows returned invalid traffic-path evidence.', {
      cause: error,
    });
  }
  const primaryAddresses = stringArray(
    parsed.primaryAddresses,
    'primary adapter addresses',
  );
  const proxyAddresses = stringArray(
    parsed.proxyAddresses,
    'proxy adapter addresses',
  );
  const egressAddresses = stringArray(
    parsed.egressAddresses,
    'FlClash egress addresses',
  );
  const primarySourceAddress = parsed.primarySourceAddress;
  if (
    typeof primarySourceAddress !== 'string' ||
    isIP(primarySourceAddress) === 0 ||
    !primaryAddresses.includes(primarySourceAddress)
  ) {
    throw new Error('The primary adapter has no usable source IP address.');
  }
  return {
    egressAddresses,
    primaryAddresses,
    primarySourceAddress,
    proxyAddresses,
  };
}

function evidenceScript(
  adapters: SplitRoutingVerificationAdapters,
  controllerPort: number,
): string {
  const encoded = encodePayload({
    controllerPort,
    primaryInterfaceIndex: adapters.primary.interfaceIndex,
    proxyInterfaceIndex: adapters.proxy.interfaceIndex,
  });
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
function Interface-Addresses([int]$interfaceIndex) {
  @(Get-NetIPAddress -InterfaceIndex $interfaceIndex -AddressState Preferred -ErrorAction SilentlyContinue | Where-Object {
    -not $_.SkipAsSource -and
    $_.IPAddress -notin @('0.0.0.0','::','::1') -and
    $_.IPAddress -notlike '127.*' -and
    $_.IPAddress -notlike '169.254.*' -and
    $_.IPAddress -notlike 'fe80:*'
  } | Select-Object -ExpandProperty IPAddress -Unique)
}
$primaryAddresses = @(Interface-Addresses ([int]$payload.primaryInterfaceIndex))
$proxyAddresses = @(Interface-Addresses ([int]$payload.proxyInterfaceIndex))
$primarySourceAddress = @($primaryAddresses | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })[0]
if ([string]::IsNullOrWhiteSpace([string]$primarySourceAddress)) {
  $primarySourceAddress = $primaryAddresses[0]
}
if ([string]::IsNullOrWhiteSpace([string]$primarySourceAddress)) {
  throw 'The primary adapter has no preferred unicast address.'
}
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$payload.controllerPort) -ErrorAction SilentlyContinue)
$processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
$egressAddresses = @()
if ($processIds.Count -gt 0) {
  $tcpAddresses = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object {
    $_.OwningProcess -in $processIds -and
    $_.LocalAddress -notin @('0.0.0.0','::','127.0.0.1','::1')
  } | Select-Object -ExpandProperty LocalAddress -Unique)
  $udpAddresses = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object {
    $_.OwningProcess -in $processIds -and
    $_.LocalAddress -notin @('0.0.0.0','::','127.0.0.1','::1')
  } | Select-Object -ExpandProperty LocalAddress -Unique)
  $egressAddresses = @($tcpAddresses + $udpAddresses | Select-Object -Unique)
}
[PSCustomObject]@{
  egressAddresses = $egressAddresses
  primaryAddresses = $primaryAddresses
  primarySourceAddress = $primarySourceAddress
  proxyAddresses = $proxyAddresses
} | ConvertTo-Json -Compress -Depth 4
`;
}

async function inspectNetworkEvidence(
  adapters: SplitRoutingVerificationAdapters,
  controllerPort: number,
): Promise<NetworkEvidence> {
  return parseNetworkEvidence(
    await runPowerShellScript(evidenceScript(adapters, controllerPort)),
  );
}

function readJsonResponse(response: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
      else response.destroy(new Error('The verification service returned too much data.'));
    });
    response.on('error', reject);
    response.on('end', () => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        reject(new Error(`ipinfo.io returned HTTP ${statusCode}.`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch (error) {
        reject(new Error('ipinfo.io returned invalid JSON.', { cause: error }));
      }
    });
  });
}

function publicIp(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('ip' in value) ||
    typeof value.ip !== 'string' ||
    isIP(value.ip) === 0
  ) {
    throw new Error('ipinfo.io did not return a valid public IP address.');
  }
  return value.ip;
}

function fetchDirectPublicIp(localAddress: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        agent: false,
        family: isIP(localAddress),
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Cherry-Toolbox-Split-Routing-Verification/1',
        },
        hostname: IPINFO_HOST,
        localAddress,
        method: 'GET',
        path: IPINFO_PATH,
        port: 443,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        void readJsonResponse(response).then(
          (value) => resolve(publicIp(value)),
          reject,
        );
      },
    );
    request.once('timeout', () =>
      request.destroy(new Error('The Ethernet verification request timed out.')),
    );
    request.once('error', reject);
    request.end();
  });
}

function decodeChunkedBody(value: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < value.length) {
    const lineEnd = value.indexOf('\r\n', offset, 'utf8');
    if (lineEnd < 0) throw new Error('The proxy response has invalid chunk framing.');
    const sizeText = value.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0];
    const size = Number.parseInt(sizeText ?? '', 16);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('The proxy response has an invalid chunk size.');
    }
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks);
    const end = offset + size;
    if (end + 2 > value.length || value.subarray(end, end + 2).toString() !== '\r\n') {
      throw new Error('The proxy response ended inside a chunk.');
    }
    chunks.push(value.subarray(offset, end));
    offset = end + 2;
  }
  throw new Error('The proxy response did not terminate its chunks.');
}

function parseRawHttpJson(value: Buffer): unknown {
  const headerEnd = value.indexOf('\r\n\r\n', 0, 'utf8');
  if (headerEnd < 0) throw new Error('The proxy response has no HTTP headers.');
  const headerText = value.subarray(0, headerEnd).toString('latin1');
  const lines = headerText.split('\r\n');
  const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/u.exec(lines[0] ?? '');
  const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`ipinfo.io returned HTTP ${statusCode} through FlClash.`);
  }
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      headers.set(
        line.slice(0, separator).trim().toLocaleLowerCase('en-US'),
        line.slice(separator + 1).trim(),
      );
    }
  }
  const rawBody = value.subarray(headerEnd + 4);
  const body = headers.get('transfer-encoding')?.toLocaleLowerCase('en-US').includes('chunked')
    ? decodeChunkedBody(rawBody)
    : rawBody;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('ipinfo.io returned invalid JSON through FlClash.', {
      cause: error,
    });
  }
}

function fetchProxiedPublicIp(mixedPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: { Host: `${IPINFO_HOST}:443` },
      host: '127.0.0.1',
      method: 'CONNECT',
      path: `${IPINFO_HOST}:443`,
      port: mixedPort,
      timeout: REQUEST_TIMEOUT_MS,
    });
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(
          new Error(
            `FlClash rejected the HTTPS tunnel with HTTP ${response.statusCode ?? 0}.`,
          ),
        );
        return;
      }
      if (head.length > 0) socket.unshift(head);
      const secureSocket = tlsConnect({
        ALPNProtocols: ['http/1.1'],
        servername: IPINFO_HOST,
        socket,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      secureSocket.setTimeout(REQUEST_TIMEOUT_MS, () =>
        secureSocket.destroy(
          new Error('The FlClash verification request timed out.'),
        ),
      );
      secureSocket.once('secureConnect', () => {
        secureSocket.write(
          `GET ${IPINFO_PATH} HTTP/1.1\r\n` +
            `Host: ${IPINFO_HOST}\r\n` +
            'Accept: application/json\r\n' +
            'Accept-Encoding: identity\r\n' +
            'Connection: close\r\n' +
            'User-Agent: Cherry-Toolbox-Split-Routing-Verification/1\r\n\r\n',
        );
      });
      secureSocket.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else {
          secureSocket.destroy(
            new Error('The proxy verification response was too large.'),
          );
        }
      });
      secureSocket.once('error', reject);
      secureSocket.once('end', () => {
        try {
          resolve(publicIp(parseRawHttpJson(Buffer.concat(chunks))));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('timeout', () =>
      request.destroy(new Error('The FlClash proxy connection timed out.')),
    );
    request.once('error', reject);
    request.end();
  });
}

function classifyEgress(
  evidence: NetworkEvidence,
): SplitRoutingEgressObservation {
  const primary = new Set(evidence.primaryAddresses);
  const proxy = new Set(evidence.proxyAddresses);
  if (evidence.egressAddresses.some((address) => primary.has(address))) {
    return 'primary';
  }
  if (evidence.egressAddresses.some((address) => proxy.has(address))) {
    return 'proxy';
  }
  return 'unknown';
}

export async function verifySplitRoutingPaths(
  adapters: SplitRoutingVerificationAdapters,
  controllerPort: number,
  mixedPort: number,
  systemRoutingUnchanged: boolean,
): Promise<SplitRoutingVerificationResult> {
  const before = await inspectNetworkEvidence(adapters, controllerPort);
  const directPublicIp = await fetchDirectPublicIp(before.primarySourceAddress);
  const proxyPublicIp = await fetchProxiedPublicIp(mixedPort);
  const after = await inspectNetworkEvidence(adapters, controllerPort);
  const combined: NetworkEvidence = {
    ...after,
    egressAddresses: [
      ...new Set([...before.egressAddresses, ...after.egressAddresses]),
    ],
  };
  const egressObservation = classifyEgress(combined);
  const publicIpsDiffer = directPublicIp !== proxyPublicIp;
  return {
    checkedAt: new Date().toISOString(),
    direct: {
      adapterName: adapters.primary.adapterName,
      localAddress: before.primarySourceAddress,
      publicIp: directPublicIp,
    },
    egressObservation,
    passed:
      systemRoutingUnchanged &&
      publicIpsDiffer &&
      egressObservation === 'proxy',
    proxied: {
      adapterName: adapters.proxy.adapterName,
      localAddresses: combined.egressAddresses.filter((address) =>
        combined.proxyAddresses.includes(address),
      ),
      publicIp: proxyPublicIp,
    },
    publicIpsDiffer,
    systemRoutingUnchanged,
  };
}
