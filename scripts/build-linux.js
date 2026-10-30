// Builds Cue for Linux (x64). Not signed.
// Meant to run in CI (see .github/workflows/build.yml); packager downloads the Linux Electron itself.
// Usage: node scripts/build-linux.js          -> build/Cue-linux-x64/Cue
const { packager } = require('@electron/packager');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

packager({
  dir: root,
  out: path.join(root, 'build'),
  overwrite: true,
  platform: 'linux',
  arch: 'x64',
  name: 'Cue',
  executableName: 'Cue',
  appVersion: pkg.version,
  buildVersion: pkg.version,
  appCopyright: 'Nathaniel School of Music. Free and open source (GPL-3.0).',
  asar: { unpackDir: 'bin' },
  prune: true,
  ignore: [/^\/build($|\/)/, /^\/dist($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/\.git($|\/)/, /^\/\.github($|\/)/, /\.md$/],
}).then((paths) => console.log('built', paths.join(', ')))
  .catch((e) => { console.error(e); process.exit(1); });
