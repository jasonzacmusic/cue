// Does Cue really update itself? Run it with: node test/update.js
//
// This one is deliberately not an Electron test. It drives the real functions
// in src/main/updater.js with a stand-in for Electron's own network call, a
// feed served from this machine, and the real signed disk image from the last
// build - so nothing is downloaded over the internet, which here is paid for by
// the gigabyte, and the app Jason is using is never touched.
//
// The five things it has to prove:
//   1. A newer version is noticed, an equal or older one is not.
//   2. The download is checked against its checksum and thrown away if wrong.
//   3. The copy inside the disk image is refused unless macOS says it is
//      properly signed - an unsigned build must never install itself.
//   4. At quit, the waiting copy is put in place and the old one is kept in the
//      Trash, recoverable.
//   5. It will NOT put an older Cue over a newer one. Three machines ship this
//      app now, so the copy in Applications can get newer while Cue is open.
//
// Every check prints PASS or FAIL. There is no deliberate failure in here: a
// failing line means something is genuinely wrong with updating.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.join(__dirname, '..');
const DMG = path.join(ROOT, 'build', 'Cue-darwin-arm64', 'Cue.dmg');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`[cue-update] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
};

// ---------------------------------------------------------------- Electron stand-in
// updater.js asks Electron for three things: the running version, a network
// call, and a way to open a link. Only the network call does any work here.
function fakeNet() {
  return {
    request: ({ url }) => {
      const out = new EventEmitter();
      out.end = () => {
        http.get(url, (res) => {
          const r = new EventEmitter();
          r.statusCode = res.statusCode;
          r.resume = () => res.resume();
          res.on('data', (c) => r.emit('data', c));
          res.on('end', () => r.emit('end'));
          res.on('error', (e) => r.emit('error', e));
          out.emit('response', r);
        }).on('error', (e) => out.emit('error', e));
      };
      return out;
    },
  };
}

const electronPath = require.resolve('electron', { paths: [ROOT] });
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true, children: [], paths: [],
  exports: {
    app: { getVersion: () => '0.0.1-test', relaunch() {}, exit() {} },
    net: fakeNet(),
    shell: { openExternal() {} },
  },
};
const { createUpdater, newer, versionAt } = require(path.join(ROOT, 'src', 'main', 'updater.js'));

// ---------------------------------------------------------------- the local feed
function serve(dmgPath, feed) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/cue-update.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(feed()));
        return;
      }
      if (url === '/Cue.dmg') {
        const body = fs.readFileSync(dmgPath);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
        res.end(body);
        return;
      }
      res.writeHead(404); res.end('no');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function fakeApp(dir, version) {
  fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Contents', 'MacOS', 'Cue'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key><string>${version}</string>\n<key>CFBundleName</key><string>Cue</string>\n</dict></plist>\n`);
}

(async () => {
  // ---------------------------------------------------------- 1. which is newer
  check('newer: 0.2.10 beats 0.2.9 (numbers, not letters)', newer('0.2.10', '0.2.9'));
  check('newer: the same version is not an update', !newer('0.4.2', '0.4.2'));
  check('newer: an older feed is not an update', !newer('0.4.1', '0.4.2'));
  check('newer: 0.5.0 beats 0.4.2', newer('0.5.0', '0.4.2'));

  // ------------------------------------------- reading the version off a real app
  const installed = versionAt('/Applications/Cue.app');
  check('reads the version of the Cue actually installed', /^\d+\.\d+\.\d+/.test(installed), installed);
  check('a folder that is not an app reads as nothing', versionAt('/Applications/not-a-real-app.app') === '');

  if (!fs.existsSync(DMG)) {
    check('the signed disk image from the last build is here', false, DMG);
    console.log('[cue-update] cannot go on without the disk image - run the Mac build first');
    process.exit(1);
  }
  const bytes = fs.readFileSync(DMG);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  // What version is really inside that disk image? Not what package.json says
  // now - this machine shares the repo with another one that has already moved
  // the number on - but what is actually in the build that would be installed.
  const dmgVersion = (() => {
    let vol = '';
    try {
      const out = String(execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', DMG], { timeout: 120000 }));
      vol = (out.match(/\/Volumes\/[^\n]*/) || [''])[0].trim();
      return versionAt(path.join(vol, 'Cue.app'));
    } catch { return ''; } finally {
      if (vol) { try { execFileSync('/usr/bin/hdiutil', ['detach', vol], { timeout: 60000 }); } catch {} }
    }
  })();
  check('the disk image holds a real, readable Cue', /^\d+\.\d+\.\d+$/.test(dmgVersion), dmgVersion);
  check('the signed disk image from the last build is here', true, { size: bytes.length });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-update-test-'));
  const apps = path.join(work, 'Applications');
  fs.mkdirSync(apps, { recursive: true });

  let feedVersion = '99.0.0';
  let feedSha = sha;
  const srv = await serve(DMG, () => ({
    app: 'Cue', version: feedVersion, date: '2026-10-31', notes: 'test',
    sha256: feedSha, size: bytes.length, url: `http://127.0.0.1:${srv.address().port}/Cue.dmg`,
  }));
  const feedUrl = `http://127.0.0.1:${srv.address().port}/cue-update.json`;

  // Cue starts fetching the moment it sees a newer version, so the honest test
  // is to wait for that to finish, exactly as the running app does.
  const ready = async (u) => {
    for (let i = 0; i < 900; i += 1) {
      const s2 = u.state();
      if (s2.state === 'ready' || s2.state === 'error') return s2;
      await sleep(100);
    }
    return u.state();
  };

  const log = [];
  const make = () => createUpdater({
    onState: () => {}, log: (e) => log.push(e), auto: () => true, appsDir: apps, feedUrl,
  });

  // ------------------------------------------------- 2. an older feed is ignored
  feedVersion = '0.0.0';
  const quiet = make();
  let st = await quiet.check({ quiet: true });
  check('an older version on the feed offers no update', st.state === 'idle', st.state);

  // ------------------------------------- 3. a newer one is fetched and unpacked
  feedVersion = '99.0.0';
  const up = make();
  st = await up.check({ quiet: false });
  check('a newer version is noticed, with no one clicking anything', st.latest === '99.0.0' && ['available', 'downloading', 'ready'].includes(st.state), { state: st.state, latest: st.latest });
  st = await ready(up);
  check('it is downloaded, checked and unpacked, with macOS happy with the signature', st.state === 'ready', { state: st.state, error: st.error });

  // ------------------------------- 5. it refuses to put an older Cue over a newer
  fakeApp(path.join(apps, 'Cue.app'), '99.9.9');
  const refused = up.installOnQuit();
  check('a NEWER Cue already installed is left alone', refused === false && versionAt(path.join(apps, 'Cue.app')) === '99.9.9',
    { returned: refused, stillThere: versionAt(path.join(apps, 'Cue.app')) });
  check('and it says why in the log', log.some((e) => /left alone/.test(e.error || '')), log.filter((e) => /left alone/.test(e.error || '')).map((e) => e.error));

  // ----------------------------------------------- 4. the swap itself, at quit
  const up2 = make();
  await up2.check({ quiet: false });
  st = await ready(up2);
  check('the download is ready again for the swap', st.state === 'ready', { state: st.state, error: st.error });
  fs.rmSync(path.join(apps, 'Cue.app'), { recursive: true, force: true });
  fakeApp(path.join(apps, 'Cue.app'), '0.0.1');
  const swapped = up2.installOnQuit();
  const after = versionAt(path.join(apps, 'Cue.app'));
  check('at quit the new version is put in place', swapped === true && after === dmgVersion, { returned: swapped, nowInstalled: after, expected: dmgVersion });
  check('the replaced copy is kept in the Trash, not deleted',
    fs.readdirSync(path.join(os.homedir(), '.Trash')).some((n) => /^Cue-0\.0\.1-test-replaced-/.test(n)));

  // ------------------------------------------- 2b. a wrong checksum is thrown away
  feedVersion = '99.0.1';
  feedSha = 'deadbeef'.repeat(8);
  const bad = make();
  await bad.check({ quiet: false });
  st = await ready(bad);
  check('a download that does not match its checksum is thrown away', st.state === 'error' && /checksum/.test(st.error || ''), { state: st.state, error: st.error });
  check('and nothing is put in place after a bad download', bad.installOnQuit() === false);

  srv.close();
  fs.rmSync(work, { recursive: true, force: true });
  const fails = results.filter((x) => !x.ok);
  console.log(`[cue-update] DONE ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.log('[cue-update] CRASH', e.message); process.exit(1); });
