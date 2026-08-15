const path = require('node:path');
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');

const electronZipDirectory = process.env.ELECTRON_ZIP_DIR;

const fuseConfig = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
};

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  packagerConfig: {
    asar: true,
    ...(electronZipDirectory ? { electronZipDir: electronZipDirectory } : {}),
    icon: path.resolve(__dirname, 'static', 'assets', 'icon'),
    executableName: 'ConnectionSwitcher',
    prune: true,
    ignore: [
      /^\/(?:\.tmp|\.pnpm-store)(?:\/|$)/,
      /^\/(?:src|test|scripts|\.github)(?:\/|$)/,
      /^\/node_modules\/(?:\.ignored|\.pnpm)(?:\/|$)/,
      /^\/(?:README\.md|tsconfig\.json|package-lock\.json|forge\.config\.js)$/,
    ],
    win32metadata: {
      CompanyName: 'Connection Switcher',
      FileDescription: 'Safely enable and disable Windows network adapters',
      InternalName: 'ConnectionSwitcher',
      OriginalFilename: 'ConnectionSwitcher.exe',
      ProductName: 'Connection Switcher',
    },
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform) => {
      if (platform !== 'win32') {
        throw new Error('Connection Switcher can only be packaged for Windows.');
      }
      const executablePath = path.resolve(buildPath, '..', '..', 'electron.exe');
      await flipFuses(executablePath, fuseConfig);
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'connection_switcher',
        setupExe: 'Connection-Switcher-Setup.exe',
        setupIcon: path.resolve(__dirname, 'static', 'assets', 'icon.ico'),
      },
    },
  ],
  plugins: [],
};
