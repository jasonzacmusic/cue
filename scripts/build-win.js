// Builds Cue for Windows (x64). Not code-signed: Windows SmartScreen will warn on first run.
// Meant to run in CI (see .github/workflows/build.yml); packager downloads the Windows Electron itself.
// Usage: node scripts/build-win.js            -> build/Cue-win32-x64/Cue.exe
const { packager } = require('@electron/packager');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

// Cue runs castLabs' Electron (it carries Widevine for protected video), so the engine comes from
// their releases, not Electron's: Electron's own site has no "+wvcus" build and answered 404.
const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;

packager({
  dir: root,
  electronVersion,
  download: { mirrorOptions: { mirror: 'https://github.com/castlabs/electron-releases/releases/download/', customDir: `v${electronVersion}` } },
  out: path.join(root, 'build'),
  overwrite: true,
  platform: 'win32',
  arch: 'x64',
  name: 'Cue',
  executableName: 'Cue',
  appVersion: pkg.version,
  buildVersion: pkg.version,
  appCopyright: 'Nathaniel School of Music. Free and open source (GPL-3.0).',
  icon: path.join(root, 'assets', 'icon.ico'),
  asar: { unpackDir: 'bin' },
  prune: true,
  ignore: [/^\/build($|\/)/, /^\/dist($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/\.git($|\/)/, /^\/\.github($|\/)/, /\.md$/],
  win32metadata: {
    CompanyName: 'Nathaniel School of Music',
    FileDescription: 'Cue',
    ProductName: 'Cue',
    InternalName: 'Cue',
    OriginalFilename: 'Cue.exe',
  },
}).then(async (paths) => {
  // The fuses stop another program running Cue as a plain script host (and borrowing what the
  // computer lets Cue do), and keep its cookies encrypted on disk. Asar integrity and
  // "only load from asar" stay off: these builds embed no integrity hash, so with them on
  // Cue could refuse to start. The Mac build has no fuses at all; see build-mac.js.
  for (const dir of paths) {
    await flipFuses(path.join(dir, 'Cue.exe'), {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
    });
  }
  console.log('built', paths.join(', '));
})
  .catch((e) => { console.error(e); process.exit(1); });
