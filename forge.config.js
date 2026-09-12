const path = require('node:path');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');

const electronZipDirectory = process.env.ELECTRON_ZIP_DIR;
const helperVersion = require('./dist/main/native-manifest.js').NATIVE_HELPER_SHA256;
if (!/^[a-f0-9]{64}$/.test(helperVersion)) throw new Error('Build the native helper before packaging.');
const iconBasePath = path.resolve(
  __dirname,
  'static',
  'assets',
  'cherry-toolbox',
);

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
    asar: { unpack: '**/native/bin/**' },
    ...(electronZipDirectory ? { electronZipDir: electronZipDirectory } : {}),
    icon: iconBasePath,
    executableName: 'CherryToolbox',
    prune: true,
    ignore: [
      /^\/native\/bin\/(?:CherryToolbox\.Helper\.exe|helper-manifest\.json|\.staging-[^/]+)(?:\/|$)/,
      new RegExp('^/native/bin/helpers/(?!' + helperVersion + '(?:/|$))'),
      /^\/(?:\.tmp|\.pnpm-store|\.implementation-backups|\.python-envs|\.codex-backups|\.codex|\.agents)(?:\/|$)/,
      /^\/(?:src|test|scripts|\.github)(?:\/|$)/,
      /^\/node_modules\/(?:\.ignored|\.pnpm)(?:\/|$)/,
      /^\/(?:README\.md|tsconfig(?:\.renderer)?\.json|package-lock\.json|forge\.config\.js)$/,
      /^\/(?:Cherry Toolbox\.lnk|start-source\.(?:cmd|vbs))$/,
    ],
    win32metadata: {
      CompanyName: 'Cherry Toolbox Contributors',
      FileDescription: 'A personal Windows toolbox',
      InternalName: 'CherryToolbox',
      OriginalFilename: 'CherryToolbox.exe',
      ProductName: 'Cherry Toolbox',
    },
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform) => {
      if (platform !== 'win32') {
        throw new Error('Cherry Toolbox can only be packaged for Windows.');
      }
      // Resolve from the copied application module, not a source manifest that a new build can change.
      const manifest = require(path.join(buildPath, 'dist/main/native-manifest.js'));
      const expected = `helpers/${manifest.NATIVE_HELPER_SHA256}/CherryToolbox.Helper.exe`;
      if (!/^[a-f0-9]{64}$/.test(manifest.NATIVE_HELPER_SHA256) || manifest.NATIVE_HELPER_RELATIVE_PATH !== expected)
        throw new Error('Invalid packaged native helper manifest.');
      const helper = readFileSync(path.join(buildPath, 'native/bin', expected));
      if (createHash('sha256').update(helper).digest('hex') !== manifest.NATIVE_HELPER_SHA256)
        throw new Error('The packaged native helper failed integrity verification.');
      const executablePath = path.resolve(buildPath, '..', '..', 'electron.exe');
      await flipFuses(executablePath, fuseConfig);
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'cherry_toolbox',
        setupExe: 'Cherry-Toolbox-Setup.exe',
        setupIcon: `${iconBasePath}.ico`,
      },
    },
  ],
  plugins: [],
};
