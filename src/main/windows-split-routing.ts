import { isIP } from 'node:net';

import {
  runElevatedPowerShell,
  runPowerShellScript,
} from './network';

const PRIMARY_INTERFACE_METRIC = 5;
const PROXY_INTERFACE_METRIC = 500;
const MAX_OWNED_ROUTES = 4096;
const WININET_REGISTRY_NAMES = [
  'AutoConfigURL',
  'AutoDetect',
  'ProxyEnable',
  'ProxyOverride',
  'ProxyServer',
] as const;
const WININET_REGISTRY_KINDS = new Set([
  'DWord',
  'ExpandString',
  'MultiString',
  'QWord',
  'String',
]);
const INTERNET_SETTINGS_PATH =
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export interface RegistryValueSnapshot {
  exists: boolean;
  kind: string | null;
  name: string;
  value: number | number[] | string | string[] | null;
}

export interface IpInterfaceSnapshot {
  addressFamily: 'IPv4' | 'IPv6';
  automaticMetric: boolean;
  ignoreDefaultRoutes: boolean;
  interfaceMetric: number;
}

export interface DefaultRouteSnapshot {
  addressFamily: 'IPv4' | 'IPv6';
  destinationPrefix: '0.0.0.0/0' | '::/0';
  nextHop: string;
  routeMetric: number;
}

export interface OwnedHostRoute {
  addressFamily: 'IPv4' | 'IPv6';
  destinationPrefix: string;
  interfaceIndex: number;
  nextHop: string;
  routeMetric: number;
}

export interface AdapterNetworkSnapshot {
  adapterId: string;
  adapterName: string;
  enabled: boolean;
  interfaceIndex: number;
  ipInterfaces: IpInterfaceSnapshot[];
}

export interface WindowsSplitRoutingSnapshot {
  defaultRoutes: DefaultRouteSnapshot[];
  ownedRoutes: OwnedHostRoute[];
  primary: AdapterNetworkSnapshot;
  proxy: AdapterNetworkSnapshot;
  registryValues: RegistryValueSnapshot[];
}

interface SnapshotPayload {
  controllerPort: number;
  endpointAddresses: string[];
  primary: { guid: string | null; name: string };
  proxy: { guid: string | null; name: string };
}

interface RawSnapshot {
  defaultRoutes: unknown;
  existingRoutes: unknown;
  primary: unknown;
  primaryDefaultRouteCount: unknown;
  proxy: unknown;
  registryValues: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function items(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function adapterLocator(adapter: NetworkAdapter): {
  guid: string | null;
  name: string;
} {
  return {
    guid: adapter.id.startsWith('guid:') ? adapter.id.slice(5) : null,
    name: adapter.name,
  };
}

function encodePayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}.`);
  return value;
}

function parseNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function parseFamily(value: unknown): 'IPv4' | 'IPv6' {
  if (value === 'IPv4' || value === 'IPv6') return value;
  throw new Error('Invalid address family in Windows network snapshot.');
}

function parseIpInterfaces(value: unknown): IpInterfaceSnapshot[] {
  const candidates = items(value);
  if (candidates.length === 0 || candidates.length > 2) {
    throw new Error('Invalid IP interface snapshot.');
  }
  const parsed = candidates.map((candidate) => {
    if (!isRecord(candidate)) throw new Error('Invalid IP interface snapshot.');
    return {
      addressFamily: parseFamily(candidate.addressFamily),
      automaticMetric: parseBoolean(
        candidate.automaticMetric,
        'automatic metric state',
      ),
      ignoreDefaultRoutes: parseBoolean(
        candidate.ignoreDefaultRoutes,
        'default-route state',
      ),
      interfaceMetric: parseNumber(candidate.interfaceMetric, 'interface metric'),
    };
  });
  if (
    new Set(parsed.map((candidate) => candidate.addressFamily)).size !==
    parsed.length
  ) {
    throw new Error('Duplicate address family in Windows network snapshot.');
  }
  return parsed;
}

function parseAdapter(
  value: unknown,
  expected: NetworkAdapter,
): AdapterNetworkSnapshot {
  if (!isRecord(value)) throw new Error('Invalid Windows adapter snapshot.');
  const adapterName = value.adapterName;
  if (typeof adapterName !== 'string' || adapterName !== expected.name) {
    throw new Error('The selected network adapter changed during preflight.');
  }
  return {
    adapterId: expected.id,
    adapterName,
    enabled: parseBoolean(value.enabled, 'adapter state'),
    interfaceIndex: parseNumber(value.interfaceIndex, 'interface index'),
    ipInterfaces: parseIpInterfaces(value.ipInterfaces),
  };
}

function parseDefaultRoutes(value: unknown): DefaultRouteSnapshot[] {
  const candidates = items(value);
  if (candidates.length === 0 || candidates.length > 16) {
    throw new Error('Invalid default route snapshot.');
  }
  return candidates.map((candidate) => {
    if (!isRecord(candidate)) throw new Error('Invalid default route snapshot.');
    const addressFamily = parseFamily(candidate.addressFamily);
    const destinationPrefix = candidate.destinationPrefix;
    const expectedPrefix: '0.0.0.0/0' | '::/0' =
      addressFamily === 'IPv4' ? '0.0.0.0/0' : '::/0';
    const expectedIpVersion = addressFamily === 'IPv4' ? 4 : 6;
    if (destinationPrefix !== expectedPrefix) {
      throw new Error('Invalid default route prefix.');
    }
    if (
      typeof candidate.nextHop !== 'string' ||
      isIP(candidate.nextHop) !== expectedIpVersion
    ) {
      throw new Error('Invalid default route gateway.');
    }
    return {
      addressFamily,
      destinationPrefix: expectedPrefix,
      nextHop: candidate.nextHop,
      routeMetric: parseNumber(candidate.routeMetric, 'route metric'),
    };
  });
}

function parseRegistryValues(value: unknown): RegistryValueSnapshot[] {
  const parsed = items(value).map((candidate) => {
    if (!isRecord(candidate)) throw new Error('Invalid registry snapshot.');
    if (
      typeof candidate.name !== 'string' ||
      !WININET_REGISTRY_NAMES.includes(
        candidate.name as (typeof WININET_REGISTRY_NAMES)[number],
      ) ||
      typeof candidate.exists !== 'boolean' ||
      (candidate.kind !== null && typeof candidate.kind !== 'string')
    ) {
      throw new Error('Invalid registry value snapshot.');
    }
    const raw = candidate.value;
    const validValue =
      raw === null ||
      typeof raw === 'string' ||
      typeof raw === 'number' ||
      (Array.isArray(raw) &&
        raw.every((item) =>
          ['number', 'string'].includes(typeof item),
        ));
    if (
      !validValue ||
      (candidate.exists &&
        (typeof candidate.kind !== 'string' ||
          !WININET_REGISTRY_KINDS.has(candidate.kind))) ||
      (!candidate.exists && (candidate.kind !== null || raw !== null))
    ) {
      throw new Error('Unsupported registry value snapshot.');
    }
    return {
      exists: candidate.exists,
      kind: candidate.kind,
      name: candidate.name,
      value: raw as RegistryValueSnapshot['value'],
    };
  });
  if (
    parsed.length !== WININET_REGISTRY_NAMES.length ||
    new Set(parsed.map((candidate) => candidate.name)).size !== parsed.length
  ) {
    throw new Error('Incomplete registry value snapshot.');
  }
  return parsed;
}

function existingRoutePrefixes(value: unknown): Set<string> {
  const prefixes = new Set<string>();
  for (const candidate of items(value)) {
    if (!isRecord(candidate)) continue;
    if (
      typeof candidate.destinationPrefix === 'string' &&
      typeof candidate.nextHop === 'string'
    ) {
      prefixes.add(`${candidate.destinationPrefix}\0${candidate.nextHop}`);
    }
  }
  return prefixes;
}

export function isRoutableEndpointAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    return !(
      first === 0 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      first >= 224
    );
  }
  if (family === 6) {
    const normalized = address
      .split('%', 1)[0]
      ?.toLocaleLowerCase('en-US');
    if (!normalized) return false;
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized === '0:0:0:0:0:0:0:0' ||
      normalized === '0:0:0:0:0:0:0:1' ||
      /^fe[89ab]/u.test(normalized) ||
      normalized.startsWith('ff')
    );
  }
  return false;
}

export function planOwnedHostRoutes(
  endpointAddresses: readonly string[],
  proxy: AdapterNetworkSnapshot,
  defaultRoutes: readonly DefaultRouteSnapshot[],
  existingRoutes: Set<string>,
): OwnedHostRoute[] {
  const routableAddresses = [
    ...new Set(endpointAddresses.filter(isRoutableEndpointAddress)),
  ];
  if (routableAddresses.length === 0 && endpointAddresses.length > 0) {
    throw new Error('No routable unicast FlClash endpoint addresses were found.');
  }
  const routes: OwnedHostRoute[] = [];
  for (const address of routableAddresses) {
    const familyNumber = isIP(address);
    if (familyNumber === 0) throw new Error(`Invalid endpoint address: ${address}`);
    const addressFamily = familyNumber === 4 ? 'IPv4' : 'IPv6';
    const defaultRoute = defaultRoutes.find(
      (route) => route.addressFamily === addressFamily,
    );
    if (!defaultRoute) continue;
    const destinationPrefix = `${address}/${familyNumber === 4 ? '32' : '128'}`;
    const key = `${destinationPrefix}\0${defaultRoute.nextHop}`;
    if (existingRoutes.has(key)) continue;
    routes.push({
      addressFamily,
      destinationPrefix,
      interfaceIndex: proxy.interfaceIndex,
      nextHop: defaultRoute.nextHop,
      routeMetric: 5,
    });
  }
  if (routes.length === 0 && routableAddresses.length > 0) {
    const allExisting = routableAddresses.every((address) => {
      const familyNumber = isIP(address);
      const defaultRoute = defaultRoutes.find(
        (route) => route.addressFamily === (familyNumber === 4 ? 'IPv4' : 'IPv6'),
      );
      if (!defaultRoute) return false;
      const prefix = `${address}/${familyNumber === 4 ? '32' : '128'}`;
      return existingRoutes.has(`${prefix}\0${defaultRoute.nextHop}`);
    });
    if (!allExisting) {
      throw new Error('WLAN has no usable gateway for the FlClash endpoints.');
    }
  }
  if (routes.length > MAX_OWNED_ROUTES) {
    throw new Error('Too many temporary WLAN routes would be required.');
  }
  return routes;
}

function snapshotScript(payload: SnapshotPayload): string {
  const encoded = encodePayload(payload);
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$controllerListeners = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$payload.controllerPort) -ErrorAction SilentlyContinue)
if ($controllerListeners.Count -eq 0) {
  throw 'The FlClash controller is not listening on the configured port.'
}
$unsafeControllerListeners = @($controllerListeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') })
if ($unsafeControllerListeners.Count -gt 0) {
  throw 'The FlClash controller is exposed beyond localhost. Bind it only to 127.0.0.1 or ::1 before activation.'
}
$adapters = @(Get-NetAdapter -Name '*' -IncludeHidden -ErrorAction Stop)
function Find-Adapter($locator) {
  $adapter = $null
  if (-not [string]::IsNullOrWhiteSpace([string]$locator.guid)) {
    $requestedGuid = [Guid]$locator.guid
    $adapter = @($adapters | Where-Object { $_.InterfaceGuid -eq $requestedGuid })[0]
  }
  if ($null -eq $adapter) {
    $adapter = @($adapters | Where-Object { $_.Name -ceq [string]$locator.name })[0]
  }
  if ($null -eq $adapter) { throw "The selected adapter no longer exists." }
  return $adapter
}
function Interface-Snapshot($adapter) {
  $interfaces = @(Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -ErrorAction Stop | ForEach-Object {
    [PSCustomObject]@{
      addressFamily = $_.AddressFamily.ToString()
      automaticMetric = $_.AutomaticMetric.ToString() -eq 'Enabled'
      ignoreDefaultRoutes = $_.IgnoreDefaultRoutes.ToString() -eq 'Enabled'
      interfaceMetric = [int]$_.InterfaceMetric
    }
  })
  return [PSCustomObject]@{
    adapterName = $adapter.Name
    enabled = $adapter.AdminStatus.ToString() -eq 'Up'
    interfaceIndex = [int]$adapter.ifIndex
    ipInterfaces = $interfaces
  }
}
$primary = Find-Adapter $payload.primary
$proxy = Find-Adapter $payload.proxy
$defaultRoutes = @(Get-NetRoute -InterfaceIndex $proxy.ifIndex -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0','::/0') } | ForEach-Object {
  [PSCustomObject]@{
    addressFamily = $_.AddressFamily.ToString()
    destinationPrefix = $_.DestinationPrefix
    nextHop = $_.NextHop
    routeMetric = [int]$_.RouteMetric
  }
})
$endpointPrefixes = @($payload.endpointAddresses | ForEach-Object {
  if ([Net.IPAddress]::Parse([string]$_).AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) { "$_/32" } else { "$_/128" }
})
$existingRoutes = @(Get-NetRoute -InterfaceIndex $proxy.ifIndex -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -in $endpointPrefixes } | ForEach-Object {
  [PSCustomObject]@{ destinationPrefix = $_.DestinationPrefix; nextHop = $_.NextHop }
})
$primaryDefaultRouteCount = @(Get-NetRoute -InterfaceIndex $primary.ifIndex -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0','::/0') }).Count
$registryPath = '${INTERNET_SETTINGS_PATH}'
$registryKey = Get-Item -LiteralPath $registryPath -ErrorAction Stop
$registryValues = @('AutoConfigURL','ProxyEnable','AutoDetect','ProxyServer','ProxyOverride') | ForEach-Object {
  $name = $_
  try {
    [PSCustomObject]@{ name = $name; exists = $true; kind = $registryKey.GetValueKind($name).ToString(); value = $registryKey.GetValue($name, $null, 'DoNotExpandEnvironmentNames') }
  } catch {
    [PSCustomObject]@{ name = $name; exists = $false; kind = $null; value = $null }
  }
}
[PSCustomObject]@{
  primary = Interface-Snapshot $primary
  primaryDefaultRouteCount = $primaryDefaultRouteCount
  proxy = Interface-Snapshot $proxy
  defaultRoutes = $defaultRoutes
  existingRoutes = $existingRoutes
  registryValues = $registryValues
} | ConvertTo-Json -Compress -Depth 8
`;
}

export async function captureWindowsSplitRoutingSnapshot(
  primary: NetworkAdapter,
  proxy: NetworkAdapter,
  endpointAddresses: readonly string[],
  controllerPort: number,
): Promise<WindowsSplitRoutingSnapshot> {
  if (primary.id === proxy.id) {
    throw new Error('The primary and proxy adapters must be different.');
  }
  if (
    !Number.isInteger(controllerPort) ||
    controllerPort < 1 ||
    controllerPort > 65_535
  ) {
    throw new Error('Invalid FlClash controller port.');
  }
  if (endpointAddresses.length > MAX_OWNED_ROUTES) {
    throw new Error('Too many FlClash endpoint addresses were resolved.');
  }
  const payload: SnapshotPayload = {
    controllerPort,
    endpointAddresses: [...endpointAddresses],
    primary: adapterLocator(primary),
    proxy: adapterLocator(proxy),
  };
  const output = await runPowerShellScript(snapshotScript(payload));
  let raw: unknown;
  try {
    raw = JSON.parse(output.replace(/^\uFEFF/u, '').trim()) as unknown;
  } catch (error) {
    throw new Error('Windows returned an invalid split-routing snapshot.', {
      cause: error,
    });
  }
  if (!isRecord(raw)) throw new Error('Invalid split-routing snapshot.');
  const parsed = raw as unknown as RawSnapshot;
  const parsedProxy = parseAdapter(parsed.proxy, proxy);
  const defaultRoutes = parseDefaultRoutes(parsed.defaultRoutes);
  if (!parsedProxy.enabled || defaultRoutes.length === 0) {
    throw new Error('The WLAN adapter must be enabled and have a default route.');
  }
  const parsedPrimary = parseAdapter(parsed.primary, primary);
  if (!parsedPrimary.enabled) {
    throw new Error('The primary Ethernet adapter must be enabled.');
  }
  if (parseNumber(parsed.primaryDefaultRouteCount, 'primary default route count') === 0) {
    throw new Error('The primary Ethernet adapter has no default route.');
  }
  return {
    defaultRoutes,
    ownedRoutes: planOwnedHostRoutes(
      endpointAddresses,
      parsedProxy,
      defaultRoutes,
      existingRoutePrefixes(parsed.existingRoutes),
    ),
    primary: parsedPrimary,
    proxy: parsedProxy,
    registryValues: parseRegistryValues(parsed.registryValues),
  };
}

function networkMutationScript(snapshot: WindowsSplitRoutingSnapshot): string {
  const encoded = encodePayload(snapshot);
  return String.raw`
$ErrorActionPreference = 'Stop'
$state = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
foreach ($adapter in @($state.primary, $state.proxy)) {
  $currentAdapter = Get-NetAdapter -InterfaceIndex ([int]$adapter.interfaceIndex) -ErrorAction Stop
  if ($currentAdapter.Name -cne [string]$adapter.adapterName -or $currentAdapter.AdminStatus.ToString() -ne 'Up') {
    throw "Adapter '$($adapter.adapterName)' changed after preflight; activation stopped before making changes."
  }
  foreach ($original in @($adapter.ipInterfaces)) {
    $current = @(Get-NetIPInterface -InterfaceIndex ([int]$adapter.interfaceIndex) -AddressFamily $original.addressFamily -ErrorAction SilentlyContinue)[0]
    if ($null -eq $current) { throw "Adapter '$($adapter.adapterName)' lost its $($original.addressFamily) interface after preflight." }
    $automaticMetric = $current.AutomaticMetric.ToString() -eq 'Enabled'
    $ignoreDefaultRoutes = $current.IgnoreDefaultRoutes.ToString() -eq 'Enabled'
    if ($automaticMetric -ne [bool]$original.automaticMetric -or $ignoreDefaultRoutes -ne [bool]$original.ignoreDefaultRoutes -or [int]$current.InterfaceMetric -ne [int]$original.interfaceMetric) {
      throw "Adapter '$($adapter.adapterName)' settings changed after preflight; activation stopped before making changes."
    }
  }
}
foreach ($route in @($state.defaultRoutes)) {
  $current = @(Get-NetRoute -InterfaceIndex ([int]$state.proxy.interfaceIndex) -DestinationPrefix $route.destinationPrefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -eq $route.nextHop })
  if ($current.Count -ne 1 -or [int]$current[0].RouteMetric -ne [int]$route.routeMetric) {
    throw "WLAN default route '$($route.destinationPrefix)' changed after preflight; activation stopped before making changes."
  }
}
foreach ($route in @($state.ownedRoutes)) {
  $current = @(Get-NetRoute -InterfaceIndex ([int]$route.interfaceIndex) -DestinationPrefix $route.destinationPrefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -eq $route.nextHop })
  if ($current.Count -ne 0) {
    throw "A planned temporary route '$($route.destinationPrefix)' appeared after preflight; activation stopped before making changes."
  }
}
foreach ($route in @($state.ownedRoutes)) {
  New-NetRoute -DestinationPrefix $route.destinationPrefix -InterfaceIndex ([int]$route.interfaceIndex) -NextHop $route.nextHop -RouteMetric ([int]$route.routeMetric) -PolicyStore ActiveStore -ErrorAction Stop | Out-Null
}
foreach ($family in @('IPv4','IPv6')) {
  if (@($state.primary.ipInterfaces | Where-Object { $_.addressFamily -eq $family }).Count -gt 0) {
    Set-NetIPInterface -InterfaceIndex ([int]$state.primary.interfaceIndex) -AddressFamily $family -AutomaticMetric Disabled -InterfaceMetric ${PRIMARY_INTERFACE_METRIC} -ErrorAction Stop
  }
  if (@($state.proxy.ipInterfaces | Where-Object { $_.addressFamily -eq $family }).Count -gt 0) {
    Set-NetIPInterface -InterfaceIndex ([int]$state.proxy.interfaceIndex) -AddressFamily $family -AutomaticMetric Disabled -InterfaceMetric ${PROXY_INTERFACE_METRIC} -IgnoreDefaultRoutes Enabled -ErrorAction Stop
  }
}
foreach ($route in @($state.defaultRoutes)) {
  Get-NetRoute -InterfaceIndex ([int]$state.proxy.interfaceIndex) -DestinationPrefix $route.destinationPrefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue |
    Where-Object { $_.NextHop -eq $route.nextHop } |
    Remove-NetRoute -Confirm:$false -ErrorAction Stop
}
`;
}

function networkRestoreScript(snapshot: WindowsSplitRoutingSnapshot): string {
  const encoded = encodePayload(snapshot);
  return String.raw`
$ErrorActionPreference = 'Stop'
$state = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
foreach ($adapter in @($state.primary, $state.proxy)) {
  $currentAdapter = Get-NetAdapter -InterfaceIndex ([int]$adapter.interfaceIndex) -ErrorAction Stop
  if ($currentAdapter.Name -cne [string]$adapter.adapterName) {
    throw "Adapter '$($adapter.adapterName)' no longer owns its original interface index; automatic restore stopped."
  }
  $isProxy = [int]$adapter.interfaceIndex -eq [int]$state.proxy.interfaceIndex
  $appliedMetric = if ($isProxy) { ${PROXY_INTERFACE_METRIC} } else { ${PRIMARY_INTERFACE_METRIC} }
  foreach ($original in @($adapter.ipInterfaces)) {
    $current = @(Get-NetIPInterface -InterfaceIndex ([int]$adapter.interfaceIndex) -AddressFamily $original.addressFamily -ErrorAction SilentlyContinue)[0]
    if ($null -eq $current) { throw "Adapter '$($adapter.adapterName)' no longer has its $($original.addressFamily) interface; automatic restore stopped." }
    $currentAutomaticMetric = $current.AutomaticMetric.ToString() -eq 'Enabled'
    $currentIgnoreDefaultRoutes = $current.IgnoreDefaultRoutes.ToString() -eq 'Enabled'
    $automaticMetricIsOwned = $currentAutomaticMetric -eq $false -or $currentAutomaticMetric -eq [bool]$original.automaticMetric
    $interfaceMetricIsOwned = [int]$current.InterfaceMetric -eq $appliedMetric -or [int]$current.InterfaceMetric -eq [int]$original.interfaceMetric
    $ignoreDefaultRoutesIsOwned = if ($isProxy) {
      $currentIgnoreDefaultRoutes -eq $true -or $currentIgnoreDefaultRoutes -eq [bool]$original.ignoreDefaultRoutes
    } else {
      $currentIgnoreDefaultRoutes -eq [bool]$original.ignoreDefaultRoutes
    }
    if (-not $automaticMetricIsOwned -or -not $interfaceMetricIsOwned -or -not $ignoreDefaultRoutesIsOwned) {
      throw "Adapter '$($adapter.adapterName)' $($original.addressFamily) settings changed outside Cherry Toolbox; automatic restore stopped to avoid overwriting them."
    }
  }
}
foreach ($route in @($state.defaultRoutes)) {
  $current = @(Get-NetRoute -InterfaceIndex ([int]$state.proxy.interfaceIndex) -DestinationPrefix $route.destinationPrefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -eq $route.nextHop })
  if ($current.Count -gt 1 -or ($current.Count -eq 1 -and [int]$current[0].RouteMetric -ne [int]$route.routeMetric)) {
    throw "WLAN default route '$($route.destinationPrefix)' changed outside Cherry Toolbox; automatic restore stopped to avoid overwriting it."
  }
}
foreach ($route in @($state.ownedRoutes)) {
  $current = @(Get-NetRoute -InterfaceIndex ([int]$route.interfaceIndex) -DestinationPrefix $route.destinationPrefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -eq $route.nextHop })
  if ($current.Count -gt 1 -or ($current.Count -eq 1 -and [int]$current[0].RouteMetric -ne [int]$route.routeMetric)) {
    throw "Temporary route '$($route.destinationPrefix)' changed outside Cherry Toolbox; automatic restore stopped to avoid deleting it."
  }
}
foreach ($adapter in @($state.primary, $state.proxy)) {
  foreach ($interface in @($adapter.ipInterfaces)) {
    $ignoreDefaultRoutes = if ([bool]$interface.ignoreDefaultRoutes) { 'Enabled' } else { 'Disabled' }
    if ([bool]$interface.automaticMetric) {
      Set-NetIPInterface -InterfaceIndex ([int]$adapter.interfaceIndex) -AddressFamily $interface.addressFamily -AutomaticMetric Enabled -IgnoreDefaultRoutes $ignoreDefaultRoutes -ErrorAction Stop
    } else {
      Set-NetIPInterface -InterfaceIndex ([int]$adapter.interfaceIndex) -AddressFamily $interface.addressFamily -AutomaticMetric Disabled -InterfaceMetric ([int]$interface.interfaceMetric) -IgnoreDefaultRoutes $ignoreDefaultRoutes -ErrorAction Stop
    }
  }
}
Start-Sleep -Milliseconds 250
foreach ($route in @($state.defaultRoutes)) {
  $existing = @(Get-NetRoute -InterfaceIndex ([int]$state.proxy.interfaceIndex) -DestinationPrefix $route.destinationPrefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -eq $route.nextHop })
  if ($existing.Count -eq 0) {
    New-NetRoute -DestinationPrefix $route.destinationPrefix -InterfaceIndex ([int]$state.proxy.interfaceIndex) -NextHop $route.nextHop -RouteMetric ([int]$route.routeMetric) -PolicyStore ActiveStore -ErrorAction Stop | Out-Null
  } elseif ($existing.Count -eq 1 -and [int]$existing[0].RouteMetric -ne [int]$route.routeMetric) {
    Set-NetRoute -InputObject $existing[0] -RouteMetric ([int]$route.routeMetric) -ErrorAction Stop | Out-Null
  } elseif ($existing.Count -gt 1) {
    throw "WLAN default route '$($route.destinationPrefix)' was restored more than once."
  }
}
foreach ($route in @($state.ownedRoutes)) {
  $matchingRoutes = @(Get-NetRoute -InterfaceIndex ([int]$route.interfaceIndex) -DestinationPrefix $route.destinationPrefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -eq $route.nextHop })
  if ($matchingRoutes.Count -eq 0) { continue }
  try {
    $matchingRoutes | Remove-NetRoute -Confirm:$false -ErrorAction Stop
  } catch {
    $destination = ([string]$route.destinationPrefix).Split('/')[0]
    $isIPv4Loopback = [string]$route.addressFamily -eq 'IPv4' -and $destination -like '127.*'
    if (-not $isIPv4Loopback) { throw }
    $routeExe = Join-Path $env:SystemRoot 'System32\route.exe'
    & $routeExe DELETE $destination MASK 255.255.255.255 ([string]$route.nextHop) IF ([int]$route.interfaceIndex) | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Windows could not delete temporary loopback route '$($route.destinationPrefix)' (route.exe exit $LASTEXITCODE)."
    }
  }
}
`;
}

function internetRefreshScript(): string {
  return String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CherryInternetSettings {
  [DllImport("wininet.dll", SetLastError = true)]
  public static extern bool InternetSetOption(IntPtr hInternet, int option, IntPtr buffer, int length);
}
'@
[CherryInternetSettings]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[CherryInternetSettings]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
`;
}

export async function applyWindowsNetworkIsolation(
  snapshot: WindowsSplitRoutingSnapshot,
): Promise<void> {
  await runElevatedPowerShell(networkMutationScript(snapshot));
}

export async function restoreWindowsNetworkIsolation(
  snapshot: WindowsSplitRoutingSnapshot,
): Promise<void> {
  await runElevatedPowerShell(networkRestoreScript(snapshot));
}

async function verifyNetworkState(
  snapshot: WindowsSplitRoutingSnapshot,
  expected: 'isolated' | 'restored',
): Promise<void> {
  const encoded = encodePayload({ expected, snapshot });
  await runPowerShellScript(String.raw`
$ErrorActionPreference = 'Stop'
$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$state = $payload.snapshot
$defaults = @(Get-NetRoute -InterfaceIndex ([int]$state.proxy.interfaceIndex) -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0','::/0') })
if ([string]$payload.expected -eq 'isolated') {
  if ($defaults.Count -ne 0) { throw 'WLAN still has a default route after isolation.' }
  foreach ($route in @($state.ownedRoutes)) {
    $found = @(Get-NetRoute -InterfaceIndex ([int]$route.interfaceIndex) -DestinationPrefix $route.destinationPrefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -eq $route.nextHop })
    if ($found.Count -ne 1 -or [int]$found[0].RouteMetric -ne [int]$route.routeMetric) { throw "Temporary route '$($route.destinationPrefix)' is missing or changed." }
  }
  foreach ($family in @('IPv4','IPv6')) {
    $primaryInterface = @(Get-NetIPInterface -InterfaceIndex ([int]$state.primary.interfaceIndex) -AddressFamily $family -ErrorAction SilentlyContinue)[0]
    if ($null -ne $primaryInterface -and ($primaryInterface.AutomaticMetric.ToString() -ne 'Disabled' -or [int]$primaryInterface.InterfaceMetric -ne ${PRIMARY_INTERFACE_METRIC})) {
      throw "Ethernet $family priority settings were not applied."
    }
    $proxyInterface = @(Get-NetIPInterface -InterfaceIndex ([int]$state.proxy.interfaceIndex) -AddressFamily $family -ErrorAction SilentlyContinue)[0]
    if ($null -ne $proxyInterface -and ($proxyInterface.AutomaticMetric.ToString() -ne 'Disabled' -or $proxyInterface.IgnoreDefaultRoutes.ToString() -ne 'Enabled' -or [int]$proxyInterface.InterfaceMetric -ne ${PROXY_INTERFACE_METRIC})) {
      throw "WLAN $family isolation settings were not applied."
    }
  }
} else {
  foreach ($route in @($state.defaultRoutes)) {
    $found = @($defaults | Where-Object { $_.DestinationPrefix -eq $route.destinationPrefix -and $_.NextHop -eq $route.nextHop })
    if ($found.Count -ne 1 -or [int]$found[0].RouteMetric -ne [int]$route.routeMetric) { throw "Original default route '$($route.destinationPrefix)' was not restored exactly." }
  }
  foreach ($route in @($state.ownedRoutes)) {
    $found = @(Get-NetRoute -InterfaceIndex ([int]$route.interfaceIndex) -DestinationPrefix $route.destinationPrefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -eq $route.nextHop })
    if ($found.Count -gt 0) { throw "Temporary route '$($route.destinationPrefix)' was not removed." }
  }
  foreach ($adapter in @($state.primary, $state.proxy)) {
    foreach ($original in @($adapter.ipInterfaces)) {
      $current = @(Get-NetIPInterface -InterfaceIndex ([int]$adapter.interfaceIndex) -AddressFamily $original.addressFamily -ErrorAction SilentlyContinue)[0]
      if ($null -eq $current) { throw "Original $($original.addressFamily) interface state is unavailable." }
      $automaticMetric = $current.AutomaticMetric.ToString() -eq 'Enabled'
      $ignoreDefaultRoutes = $current.IgnoreDefaultRoutes.ToString() -eq 'Enabled'
      $metricChanged = -not [bool]$original.automaticMetric -and [int]$current.InterfaceMetric -ne [int]$original.interfaceMetric
      if ($automaticMetric -ne [bool]$original.automaticMetric -or $ignoreDefaultRoutes -ne [bool]$original.ignoreDefaultRoutes -or $metricChanged) {
        throw "Original $($original.addressFamily) interface settings were not restored."
      }
    }
  }
}
`);
}

export function verifyWindowsNetworkIsolation(
  snapshot: WindowsSplitRoutingSnapshot,
): Promise<void> {
  return verifyNetworkState(snapshot, 'isolated');
}

export function verifyWindowsNetworkRestored(
  snapshot: WindowsSplitRoutingSnapshot,
): Promise<void> {
  return verifyNetworkState(snapshot, 'restored');
}

export async function applyWinInetPac(
  pacUrl: string,
  registryValues: readonly RegistryValueSnapshot[],
): Promise<void> {
  const encoded = encodePayload({ pacUrl, registryValues });
  await runPowerShellScript(String.raw`
$ErrorActionPreference = 'Stop'
$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$path = '${INTERNET_SETTINGS_PATH}'
$registryKey = Get-Item -LiteralPath $path -ErrorAction Stop
$valueNames = @($registryKey.GetValueNames())
$records = @($payload.registryValues | Where-Object { $_.name -in @('AutoConfigURL','ProxyEnable','AutoDetect') })
if ($records.Count -ne 3) { throw 'The WinINET recovery snapshot is incomplete.' }
foreach ($record in $records) {
  $hasCurrent = $valueNames -contains [string]$record.name
  $matchesOriginal = if ([bool]$record.exists) {
    $currentValue = if ($hasCurrent) { $registryKey.GetValue([string]$record.name, $null, 'DoNotExpandEnvironmentNames') } else { $null }
    $currentKind = if ($hasCurrent) { $registryKey.GetValueKind([string]$record.name).ToString() } else { $null }
    $hasCurrent -and ($currentKind -eq [string]$record.kind) -and ((ConvertTo-Json -InputObject $currentValue -Compress -Depth 4) -ceq (ConvertTo-Json -InputObject $record.value -Compress -Depth 4))
  } else {
    -not $hasCurrent
  }
  if (-not $matchesOriginal) {
    throw "WinINET value '$($record.name)' changed after preflight; activation stopped before changing the system proxy."
  }
}
New-ItemProperty -LiteralPath $path -Name AutoConfigURL -Value ([string]$payload.pacUrl) -PropertyType String -Force -ErrorAction Stop | Out-Null
New-ItemProperty -LiteralPath $path -Name ProxyEnable -Value 0 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
New-ItemProperty -LiteralPath $path -Name AutoDetect -Value 0 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
${internetRefreshScript()}
`);
}

export async function refreshWinInetProxy(): Promise<void> {
  await runPowerShellScript(internetRefreshScript());
}

export async function restoreWinInetPac(
  registryValues: readonly RegistryValueSnapshot[],
  expectedPacUrl: string,
): Promise<void> {
  const encoded = encodePayload({ expectedPacUrl, registryValues });
  await runPowerShellScript(String.raw`
$ErrorActionPreference = 'Stop'
$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$path = '${INTERNET_SETTINGS_PATH}'
$registryKey = Get-Item -LiteralPath $path -ErrorAction Stop
$valueNames = @($registryKey.GetValueNames())
$records = @($payload.registryValues | Where-Object { $_.name -in @('AutoConfigURL','ProxyEnable','AutoDetect') })
foreach ($record in $records) {
  $hasCurrent = $valueNames -contains [string]$record.name
  $currentValue = if ($hasCurrent) { $registryKey.GetValue([string]$record.name, $null, 'DoNotExpandEnvironmentNames') } else { $null }
  $currentKind = if ($hasCurrent) { $registryKey.GetValueKind([string]$record.name).ToString() } else { $null }
  $matchesApplied = switch ([string]$record.name) {
    'AutoConfigURL' { $hasCurrent -and $currentKind -eq 'String' -and [string]$currentValue -ceq [string]$payload.expectedPacUrl }
    'ProxyEnable' { $hasCurrent -and $currentKind -eq 'DWord' -and [int]$currentValue -eq 0 }
    'AutoDetect' { $hasCurrent -and $currentKind -eq 'DWord' -and [int]$currentValue -eq 0 }
    default { $false }
  }
  $matchesOriginal = if ([bool]$record.exists) {
    $hasCurrent -and ($currentKind -eq [string]$record.kind) -and ((ConvertTo-Json -InputObject $currentValue -Compress -Depth 4) -ceq (ConvertTo-Json -InputObject $record.value -Compress -Depth 4))
  } else {
    -not $hasCurrent
  }
  if (-not $matchesApplied -and -not $matchesOriginal) {
    throw "WinINET value '$($record.name)' changed outside Cherry Toolbox; automatic restore stopped to avoid overwriting it."
  }
}
foreach ($record in $records) {
  if (-not [bool]$record.exists) {
    Remove-ItemProperty -LiteralPath $path -Name $record.name -ErrorAction SilentlyContinue
    continue
  }
  switch ([string]$record.kind) {
    'DWord' { New-ItemProperty -LiteralPath $path -Name $record.name -Value ([int]$record.value) -PropertyType DWord -Force -ErrorAction Stop | Out-Null }
    'QWord' { New-ItemProperty -LiteralPath $path -Name $record.name -Value ([long]$record.value) -PropertyType QWord -Force -ErrorAction Stop | Out-Null }
    'ExpandString' { New-ItemProperty -LiteralPath $path -Name $record.name -Value ([string]$record.value) -PropertyType ExpandString -Force -ErrorAction Stop | Out-Null }
    'MultiString' { New-ItemProperty -LiteralPath $path -Name $record.name -Value @($record.value) -PropertyType MultiString -Force -ErrorAction Stop | Out-Null }
    default { New-ItemProperty -LiteralPath $path -Name $record.name -Value ([string]$record.value) -PropertyType String -Force -ErrorAction Stop | Out-Null }
  }
}
${internetRefreshScript()}
`);
}

export async function restoreWinInetSnapshot(
  registryValues: readonly RegistryValueSnapshot[],
): Promise<void> {
  const encoded = encodePayload({ registryValues });
  await runPowerShellScript(String.raw`
$ErrorActionPreference = 'Stop'
$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$path = '${INTERNET_SETTINGS_PATH}'
$records = @($payload.registryValues)
if ($records.Count -ne 5 -or @($records.name | Select-Object -Unique).Count -ne 5) {
  throw 'The WinINET recovery snapshot is incomplete.'
}
foreach ($record in $records) {
  if (-not [bool]$record.exists) {
    Remove-ItemProperty -LiteralPath $path -Name $record.name -ErrorAction SilentlyContinue
    continue
  }
  switch ([string]$record.kind) {
    'DWord' { New-ItemProperty -LiteralPath $path -Name $record.name -Value ([int]$record.value) -PropertyType DWord -Force -ErrorAction Stop | Out-Null }
    'QWord' { New-ItemProperty -LiteralPath $path -Name $record.name -Value ([long]$record.value) -PropertyType QWord -Force -ErrorAction Stop | Out-Null }
    'ExpandString' { New-ItemProperty -LiteralPath $path -Name $record.name -Value ([string]$record.value) -PropertyType ExpandString -Force -ErrorAction Stop | Out-Null }
    'MultiString' { New-ItemProperty -LiteralPath $path -Name $record.name -Value @($record.value) -PropertyType MultiString -Force -ErrorAction Stop | Out-Null }
    default { New-ItemProperty -LiteralPath $path -Name $record.name -Value ([string]$record.value) -PropertyType String -Force -ErrorAction Stop | Out-Null }
  }
}
$registryKey = Get-Item -LiteralPath $path -ErrorAction Stop
$valueNames = @($registryKey.GetValueNames())
foreach ($record in $records) {
  $hasCurrent = $valueNames -contains [string]$record.name
  if ([bool]$record.exists) {
    $currentValue = if ($hasCurrent) { $registryKey.GetValue([string]$record.name, $null, 'DoNotExpandEnvironmentNames') } else { $null }
    $currentKind = if ($hasCurrent) { $registryKey.GetValueKind([string]$record.name).ToString() } else { $null }
    $matches = $hasCurrent -and $currentKind -eq [string]$record.kind -and ((ConvertTo-Json -InputObject $currentValue -Compress -Depth 4) -ceq (ConvertTo-Json -InputObject $record.value -Compress -Depth 4))
  } else {
    $matches = -not $hasCurrent
  }
  if (-not $matches) { throw "WinINET value '$($record.name)' was not restored exactly." }
}
${internetRefreshScript()}
`);
}
