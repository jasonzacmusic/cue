// Builds Cue for Windows (x64). Not code-signed: Windows SmartScreen will warn on first run.
// Meant to run in CI (see .github/workflows/build.yml); packager downloads the Windows Electron itself.
// Usage: node scripts/build-win.js            -> build/Cue-win32-x64/Cue.exe
const { packager } = require('@electron/packager');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

packager({
  dir: root,
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
}).then((paths) => console.log('built', paths.join(', ')))
  .catch((e) => { console.error(e); process.exit(1); });
