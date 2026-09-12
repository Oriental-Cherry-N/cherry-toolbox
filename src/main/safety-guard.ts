import { runPowerShellScript } from './network';

const PROTECTED_NETWORK_CLIENTS = Object.freeze([
  'ChatGPT',
  'ChatGPT.Windows',
  'OpenAI.ChatGPT',
]);

export interface ProtectedClientStatus {
  checked: boolean;
  running: string[];
}

function parseProtectedClients(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error('Windows returned invalid protected-client status.', {
      cause: error,
    });
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (
    values.length > PROTECTED_NETWORK_CLIENTS.length ||
    values.some((item) => typeof item !== 'string' || item.length > 128)
  ) {
    throw new Error('Windows returned invalid protected-client status.');
  }
  return [...new Set(values as string[])].sort();
}

export async function inspectProtectedNetworkClients(): Promise<ProtectedClientStatus> {
  const names = Buffer.from(
    JSON.stringify(PROTECTED_NETWORK_CLIENTS),
    'utf8',
  ).toString('base64');
  const output = await runPowerShellScript(String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$protectedNames = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${names}')) | ConvertFrom-Json)
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -in $protectedNames
} | Select-Object -ExpandProperty ProcessName -Unique)
ConvertTo-Json -InputObject @($running) -Compress
`);
  return { checked: true, running: parseProtectedClients(output) };
}

export function assertAdapterMutationIsSafe(
  adapters: readonly NetworkAdapter[],
  target: NetworkAdapter,
  action: AdapterAction,
  protectedClients: ProtectedClientStatus,
): void {
  if (!protectedClients.checked) {
    throw new Error(
      'Protected-client status could not be verified, so adapter changes are disabled.',
    );
  }
  if (protectedClients.running.length > 0) {
    throw new Error(
      `Close the protected ChatGPT client before changing adapters: ${protectedClients.running.join(', ')}.`,
    );
  }
  if (action !== 'disable') return;
  if (target.enabled !== true) return;
  const alternatives = adapters.filter(
    (adapter) =>
      adapter.id !== target.id &&
      adapter.enabled === true &&
      adapter.connected === true,
  );
  if (target.connected === true && alternatives.length === 0) {
    throw new Error(
      'Cherry Toolbox will not disable the last connected network adapter.',
    );
  }
}
