const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isAdapterAction,
  isSafeAdapterId,
  parseNetshAdapters,
  parsePowerShellAdapters,
  resolveSelectedAdapterId,
  setNetworkAdapterStates,
} = require('../dist/main/network.js');

const WIFI_GUID = 'F67053B5-6802-4989-9869-6105783C240B';
const ETHERNET_GUID = '0CEB962B-5463-4B13-B939-0993E29BCBEF';

test('PowerShell output is validated, normalized, and sorted', () => {
  const output = JSON.stringify([
    {
      id: `{${WIFI_GUID.toLowerCase()}}`,
      name: 'Wi-Fi',
      description: 'Wireless adapter',
      ifIndex: 12,
      status: 'Up',
      adminStatus: 'Up',
      mediaState: 'Connected',
    },
    {
      id: ETHERNET_GUID,
      name: 'Ethernet',
      description: 'Ethernet adapter',
      ifIndex: 4,
      status: 'Disconnected',
      adminStatus: 'Down',
      mediaState: 'Disconnected',
    },
  ]);

  const adapters = parsePowerShellAdapters(`\uFEFF${output}`);

  assert.deepEqual(
    adapters.map(({ id, name, enabled, connected }) => ({
      id,
      name,
      enabled,
      connected,
    })),
    [
      {
        id: `guid:${ETHERNET_GUID}`,
        name: 'Ethernet',
        enabled: false,
        connected: false,
      },
      {
        id: `guid:${WIFI_GUID}`,
        name: 'Wi-Fi',
        enabled: true,
        connected: true,
      },
    ],
  );
});

test('PowerShell returns a stable fallback id when no GUID is available', () => {
  const [adapter] = parsePowerShellAdapters(
    JSON.stringify({
      id: '',
      name: 'VPN Adapter',
      description: '',
      ifIndex: null,
      status: 'Down',
      adminStatus: 'Up',
      mediaState: 'Disconnected',
    }),
  );

  assert.match(adapter.id, /^name:[a-f0-9]{32}$/);
  assert.equal(adapter.enabled, true);
  assert.equal(adapter.connected, false);
});

test('malformed PowerShell adapter output is rejected', () => {
  assert.throws(
    () => parsePowerShellAdapters('{not-json'),
    /malformed network adapter data/,
  );
  assert.throws(
    () =>
      parsePowerShellAdapters(JSON.stringify({ id: WIFI_GUID, name: '   ' })),
    /has no name/,
  );
});

test('netsh fallback preserves adapter names containing spaces', () => {
  const output = [
    'Admin State    State          Type             Interface Name',
    '-------------------------------------------------------------------------',
    'Enabled        Connected      Dedicated        Wi-Fi Adapter 2',
    'Disabled       Disconnected   Dedicated        Ethernet',
  ].join('\r\n');

  const adapters = parseNetshAdapters(output);

  assert.deepEqual(
    adapters.map(({ name, enabled, connected }) => ({
      name,
      enabled,
      connected,
    })),
    [
      { name: 'Ethernet', enabled: false, connected: false },
      { name: 'Wi-Fi Adapter 2', enabled: true, connected: true },
    ],
  );
});

test('IPC-facing action and adapter identifiers reject injection-shaped input', () => {
  assert.equal(isAdapterAction('enable'), true);
  assert.equal(isAdapterAction('disable'), true);
  assert.equal(isAdapterAction('disable; Remove-Item C:\\'), false);
  assert.equal(isSafeAdapterId(`guid:${WIFI_GUID}`), true);
  assert.equal(isSafeAdapterId('name:0123456789abcdef0123456789abcdef'), true);
  assert.equal(isSafeAdapterId('guid:x; Start-Process calc.exe'), false);
  assert.equal(isSafeAdapterId('../settings.json'), false);
});

test('adapter selection prefers saved, connected, enabled, then first adapter', () => {
  const adapters = parsePowerShellAdapters(
    JSON.stringify([
      {
        id: ETHERNET_GUID,
        name: 'Ethernet',
        status: 'Disconnected',
        adminStatus: 'Up',
      },
      {
        id: WIFI_GUID,
        name: 'Wi-Fi',
        status: 'Up',
        adminStatus: 'Up',
      },
    ]),
  );

  assert.equal(
    resolveSelectedAdapterId(adapters, `guid:${ETHERNET_GUID}`),
    `guid:${ETHERNET_GUID}`,
  );
  assert.equal(
    resolveSelectedAdapterId(
      adapters,
      'guid:00000000-0000-0000-0000-000000000000',
    ),
    `guid:${WIFI_GUID}`,
  );
  assert.equal(resolveSelectedAdapterId([], null), null);
});

test('batch adapter changes reject duplicate targets before executing a command', async () => {
  const adapter = {
    id: `guid:${WIFI_GUID}`,
    name: 'Wi-Fi',
    description: '',
    interfaceIndex: 12,
    adminStatus: 'Up',
    connectionStatus: 'Up',
    enabled: true,
    connected: true,
  };

  await assert.rejects(
    setNetworkAdapterStates([
      { action: 'disable', adapter },
      { action: 'enable', adapter },
    ]),
    /Duplicate network adapter change/,
  );
  await setNetworkAdapterStates([]);
});
