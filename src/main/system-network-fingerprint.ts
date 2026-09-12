import { createHash } from 'node:crypto';

import { runPowerShellScript } from './network';

export interface SystemNetworkFingerprint {
  capturedAt: string;
  hash: string;
}

function fingerprintScript(flClashConfigPath: string): string {
  const encoded = Buffer.from(flClashConfigPath, 'utf8').toString('base64');
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$internetPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$internetKey = Get-Item -LiteralPath $internetPath -ErrorAction Stop
$internetNames = @('AutoConfigURL','ProxyEnable','AutoDetect','ProxyServer','ProxyOverride')
$winInet = @($internetNames | ForEach-Object {
  $name = $_
  $exists = @($internetKey.GetValueNames()) -contains $name
  [PSCustomObject]@{
    name = $name
    exists = $exists
    kind = if ($exists) { $internetKey.GetValueKind($name).ToString() } else { $null }
    value = if ($exists) { $internetKey.GetValue($name, $null, 'DoNotExpandEnvironmentNames') } else { $null }
  }
})
$interfaces = @(Get-NetIPInterface -ErrorAction Stop | Sort-Object InterfaceIndex,AddressFamily | ForEach-Object {
  [PSCustomObject]@{
    addressFamily = $_.AddressFamily.ToString()
    automaticMetric = $_.AutomaticMetric.ToString()
    ignoreDefaultRoutes = $_.IgnoreDefaultRoutes.ToString()
    interfaceIndex = [int]$_.InterfaceIndex
    interfaceMetric = [int]$_.InterfaceMetric
  }
})
$defaults = @(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop | Where-Object {
  $_.DestinationPrefix -in @('0.0.0.0/0','::/0')
} | Sort-Object InterfaceIndex,DestinationPrefix,NextHop,RouteMetric | ForEach-Object {
  [PSCustomObject]@{
    destinationPrefix = [string]$_.DestinationPrefix
    interfaceIndex = [int]$_.InterfaceIndex
    nextHop = [string]$_.NextHop
    routeMetric = [int]$_.RouteMetric
  }
})
$dns = @(Get-DnsClientServerAddress -ErrorAction Stop | Sort-Object InterfaceIndex,AddressFamily | ForEach-Object {
  [PSCustomObject]@{
    addressFamily = [int]$_.AddressFamily
    interfaceIndex = [int]$_.InterfaceIndex
    serverAddresses = @($_.ServerAddresses)
  }
})
$winHttpPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings\Connections'
$winHttp = $null
if (Test-Path -LiteralPath $winHttpPath) {
  $winHttp = (Get-ItemProperty -LiteralPath $winHttpPath -Name WinHttpSettings -ErrorAction SilentlyContinue).WinHttpSettings
  if ($null -ne $winHttp) { $winHttp = [Convert]::ToBase64String([byte[]]$winHttp) }
}
$configPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$flClashHash = if (Test-Path -LiteralPath $configPath) {
  (Get-FileHash -LiteralPath $configPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
} else { $null }
[PSCustomObject]@{
  defaultRoutes = $defaults
  dns = $dns
  flClashConfigHash = $flClashHash
  interfaces = $interfaces
  winHttp = $winHttp
  winInet = $winInet
} | ConvertTo-Json -Compress -Depth 8
`;
}

export async function captureSystemNetworkFingerprint(
  flClashConfigPath: string,
): Promise<SystemNetworkFingerprint> {
  const raw = (await runPowerShellScript(
    fingerprintScript(flClashConfigPath),
  )).trim();
  try {
    JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('Windows returned an invalid network safety snapshot.', {
      cause: error,
    });
  }
  return {
    capturedAt: new Date().toISOString(),
    hash: createHash('sha256').update(raw, 'utf8').digest('hex'),
  };
}

export function systemNetworkFingerprintsMatch(
  before: SystemNetworkFingerprint,
  after: SystemNetworkFingerprint,
): boolean {
  return before.hash === after.hash;
}
