// Builds Cue.app for macOS (Apple Silicon), signed with the Developer ID so Gatekeeper trusts it.
// Usage: node scripts/build-mac.js            -> build/Cue-darwin-arm64/Cue.app
// Notarizing happens after, with ~/.claude/skills/nsm-mac-app/scripts/nsm-notarize.sh --no-resign
const { packager } = require('@electron/packager');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

packager({
  dir: root,
  out: path.join(root, 'build'),
  overwrite: true,
  platform: 'darwin',
  arch: process.env.CUE_ARCH || 'arm64',
  name: 'Cue',
  executableName: 'Cue',
  appBundleId: 'com.jasonzac.cue',
  appCategoryType: 'public.app-category.productivity',
  appVersion: pkg.version,
  buildVersion: pkg.version,
  appCopyright: 'Nathaniel School of Music. Free and open source (GPL-3.0).',
  icon: path.join(root, 'assets', 'icon.icns'),
  asar: { unpackDir: 'bin' },
  // Chromium ships every language it knows, about 40 MB Cue never shows. English stays.
  afterCopy: [async ({ buildPath }) => {
    const res = path.join(buildPath, '..', '..', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources');
    for (const f of fs.readdirSync(res)) { if (f.endsWith('.lproj') && !/^en(_GB)?\.lproj$/.test(f)) fs.rmSync(path.join(res, f), { recursive: true }); }
  }],
  prune: true,
  ignore: [/^\/build($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/\.git($|\/)/, /\.md$/],
  extendInfo: {
    NSMicrophoneUsageDescription: 'Websites you allow (Zoom, Meet, YouTube Live) can use your microphone.',
    NSCameraUsageDescription: 'Websites you allow (Zoom, Meet, YouTube Live) can use your camera.',
    NSBluetoothAlwaysUsageDescription: 'Websites you allow can talk to Bluetooth MIDI devices.',
    LSApplicationCategoryType: 'public.app-category.productivity',
    CFBundleURLTypes: [{ CFBundleURLName: 'Web site URL', CFBundleURLSchemes: ['http', 'https'] }],
    CFBundleDocumentTypes: [{ CFBundleTypeName: 'HTML document', CFBundleTypeRole: 'Viewer', LSItemContentTypes: ['public.html', 'public.xhtml'] }],
  },
  osxSign: process.env.CUE_NO_SIGN ? undefined : {
    identity: 'Developer ID Application: Jason Zachariah (R3UNCZH45H)',
    optionsForFile: () => ({
      hardenedRuntime: true,
      entitlements: path.join(root, 'scripts', 'entitlements.mac.plist'),
    }),
  },
}).then((paths) => {
  // A browser that creeps up by a few megabytes every release ends up huge, so growth has to be a decision.
  const BUDGET_MB = 270;
  const mb = Math.round(Number(execSync(`du -sk "${path.join(paths[0], 'Cue.app')}"`).toString().split('\t')[0]) / 1024);
  console.log('built', paths.join(', '), `${mb} MB of ${BUDGET_MB} MB budget`);
  if (mb > BUDGET_MB) { console.error(`Cue.app is ${mb} MB, over the ${BUDGET_MB} MB budget.`); process.exit(1); }
})
  .catch((e) => { console.error(e); process.exit(1); });
