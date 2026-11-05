// Builds Cue.app for macOS (Apple Silicon), signed with the Developer ID so Gatekeeper trusts it.
// Usage: node scripts/build-mac.js            -> build/Cue-darwin-arm64/Cue.app
// Notarizing happens after, with ~/.claude/skills/nsm-mac-app/scripts/nsm-notarize.sh --no-resign
const { packager } = require('@electron/packager');
const { sign } = require('@electron/osx-sign');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('path');
const fs = require('fs');
const { execSync, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

// Cue runs on castLabs' Electron, which carries Widevine. It ships from castLabs' own repo rather
// than electron/electron, so the packager has to be pointed at it. npm already
// pulled the zip into the cache; use that rather than downloading it again,
// because the internet here is paid by the gigabyte.
const arch = process.env.CUE_ARCH || 'arm64';
const electronVersion = fs.readFileSync(path.join(root, 'node_modules', 'electron', 'dist', 'version'), 'utf8').trim();
const zipName = `electron-v${electronVersion}-darwin-${arch}.zip`;
const cacheRoot = path.join(process.env.HOME || '', 'Library', 'Caches', 'electron');
let electronZipDir = '';
try {
  electronZipDir = fs.readdirSync(cacheRoot).map((d) => path.join(cacheRoot, d))
    .find((d) => fs.existsSync(path.join(d, zipName))) || '';
} catch {}
if (electronZipDir) console.log(`Using ${zipName} from the cache.`);

packager({
  dir: root,
  electronVersion,
  ...(electronZipDir ? { electronZipDir } : {
    download: { mirrorOptions: { mirror: 'https://github.com/castlabs/electron-releases/releases/download/', customDir: `v${electronVersion}` } },
  }),
  out: path.join(root, 'build'),
  overwrite: true,
  platform: 'darwin',
  arch,
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
    // Stops another program using Cue's camera and microphone rights by running Cue as a plain script host.
    await flipFuses(path.resolve(buildPath, '..', '..', '..'), {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });
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
  // VMP writes into the bundle, so Apple signing must happen afterwards.
  osxSign: undefined,
}).then(async (paths) => {
  const app = path.join(paths[0], 'Cue.app');
  // Netflix refuses a Widevine player that castLabs has not signed. Everything
  // else - every other site, and all of Cue - works without it, so a build may
  // skip it deliberately with CUE_NO_VMP=1 while the castLabs account is still
  // being set up. Never skip it by accident: without that flag a failure here
  // stops the build.
  if (process.env.CUE_NO_VMP) {
    console.log('CUE_NO_VMP is set: skipping castLabs VMP. Netflix will not play in this build.');
  } else {
    console.log('Signing the packaged app with castLabs VMP...');
    execFileSync('python3', ['-m', 'castlabs_evs.vmp', '-n', 'sign-pkg', app], { stdio: 'inherit' });
  }
  if (!process.env.CUE_NO_SIGN) {
    console.log('Signing nested code and the app with Developer ID...');
    await sign({
      app,
      identity: 'Developer ID Application: Jason Zachariah (R3UNCZH45H)',
      optionsForFile: (filePath) => ({
        hardenedRuntime: true,
        entitlements: path.join(root, 'scripts', /Helper/.test(filePath) ? 'entitlements.helper.plist' : 'entitlements.mac.plist'),
      }),
    });
  }
  // A browser that creeps up by a few megabytes every release ends up huge, so growth has to be a decision.
  const BUDGET_MB = 270;
  const mb = Math.round(Number(execSync(`du -sk "${path.join(paths[0], 'Cue.app')}"`).toString().split('\t')[0]) / 1024);
  console.log('built', paths.join(', '), `${mb} MB of ${BUDGET_MB} MB budget`);
  if (mb > BUDGET_MB) { console.error(`Cue.app is ${mb} MB, over the ${BUDGET_MB} MB budget.`); process.exit(1); }
})
  .catch((e) => { console.error(e); process.exit(1); });
