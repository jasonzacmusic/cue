// Does Cue update itself on Windows and Linux, and does the Mac still read its
// old feed? Run it with: node test/update-cross.js   (no Electron window needed)
//
// It drives src/main/updater.js, update-core.js and settle.js with a stand-in
// for Electron, a feed and a tiny archive served from this machine on a random
// port, and throwaway folders. Nothing is fetched from the internet and no real
// install is touched. Temp folders go under $CUE_UPDATE_TMP (or the system temp).
//
// On Windows it also runs the real win-swap.ps1 against a dummy install, a
// dummy staged copy and a short-lived dummy process (swap AND roll-back).
//
// Every check prints PASS or FAIL. The one expected FAIL until the key is made:
// "the real public key is built in" - see scripts/feed-keygen.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`[cue-update-cross] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
};

// ---------------------------------------------------------------- Electron stand-in
let running = '1.0.0';
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
const relaunched = [];
const electronPath = require.resolve('electron', { paths: [ROOT] });
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true, children: [], paths: [],
  exports: {
    app: { getVersion: () => running, isPackaged: false, relaunch: (o) => relaunched.push(o), exit() {}, getPath() { throw new Error('no userData in tests'); } },
    net: fakeNet(),
    shell: { openExternal() {} },
  },
};
const core = require(path.join(ROOT, 'src', 'main', 'update-core.js'));
const { createUpdater, versionAt, SAY } = require(path.join(ROOT, 'src', 'main', 'updater.js'));
const settleMod = require(path.join(ROOT, 'src', 'main', 'settle.js'));

// ---------------------------------------------------------------- folders
const BASE = path.join(process.env.CUE_UPDATE_TMP || os.tmpdir(), `update-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true });
let n = 0;
const fresh = (name) => { n += 1; const d = path.join(BASE, `${n}-${name}`); fs.mkdirSync(d, { recursive: true }); return d; };

// P is the platform whose archives and tools are used for the real round trips.
const P = WIN ? 'win32' : 'linux';
const KEYNAME = core.platformKey(P, 'x64');
const EXE = core.exeName(P);
const APPDIR = WIN ? 'Cue-win32-x64' : 'Cue-linux-x64';

function fakeInstall(dir, marker) {
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, EXE), WIN ? 'not a real exe' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'marker.txt'), marker);
}
const markerOf = (dir) => { try { return fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8'); } catch { return ''; } };

// A tiny archive shaped like CI's: one top folder holding Cue's executable.
function makeArchive(version) {
  const src = fresh(`archive-src-${version}`);
  fakeInstall(path.join(src, APPDIR), `new ${version}`);
  const file = path.join(fresh('archive'), WIN ? `Cue-${version}-win-x64.zip` : `Cue-${version}-linux-x64.tar.gz`);
  if (WIN) execFileSync(core.tarPath('win32'), ['-a', '-cf', file, '-C', src, APPDIR]);
  else execFileSync('tar', ['-czf', file, '-C', src, APPDIR]);
  return file;
}

// ---------------------------------------------------------------- the local server
const keys = crypto.generateKeyPairSync('ed25519');
const PUB = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PEM = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const other = crypto.generateKeyPairSync('ed25519');
const OTHER_PEM = other.privateKey.export({ type: 'pkcs8', format: 'pem' });

const hits = {};
let routes = {};
const srv = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  hits[url] = (hits[url] || 0) + 1;
  const r = routes[url];
  if (!r) { res.writeHead(404); res.end('no'); return; }
  const body = typeof r === 'function' ? r() : r;
  res.writeHead(200, { 'content-length': body.length });
  res.end(body);
});
let BASE_URL = '';

function feedFor({ version, archive, size, sha, platforms, sign = PEM, tamper }) {
  const bytes = fs.readFileSync(archive);
  const entry = { url: `${BASE_URL}/archive`, sha256: sha || crypto.createHash('sha256').update(bytes).digest('hex'), size: size || bytes.length };
  let feed = { app: 'Cue', version, date: '2026-11-12', notes: 'test', platforms: platforms || { [KEYNAME]: entry } };
  feed = sign ? core.signFeed(feed, sign) : feed;
  if (tamper) tamper(feed);
  return feed;
}
const serveFeed = (feed, archive) => {
  routes = { '/cue-feed.json': Buffer.from(JSON.stringify(feed)) };
  if (archive) routes['/archive'] = fs.readFileSync(archive);
};
const resetHits = () => { for (const k of Object.keys(hits)) delete hits[k]; };

const settle = async (u) => {
  for (let i = 0; i < 300; i += 1) {
    const s = u.state();
    if (!['checking', 'available', 'downloading'].includes(s.state)) return s;
    await sleep(50);
  }
  return u.state();
};

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  const FEED_URL = `${BASE_URL}/cue-feed.json`;

  // ------------------------------------------------------------- the key
  check('the real public key is built in (paste it from `node scripts/feed-keygen.js` into FEED_PUBLIC_KEY in src/main/update-core.js)',
    core.FEED_PUBLIC_KEY !== core.PLACEHOLDER_KEY, core.FEED_PUBLIC_KEY === core.PLACEHOLDER_KEY ? 'still the placeholder' : 'set');
  if (core.FEED_PUBLIC_KEY !== core.PLACEHOLDER_KEY) {
    check('the built-in key is a real Ed25519 public key', (() => { try { return core.publicKeyFrom(core.FEED_PUBLIC_KEY).asymmetricKeyType === 'ed25519'; } catch { return false; } })());
  }

  // ------------------------------------------------------------- versions
  check('newer: 0.2.10 beats 0.2.9', core.newer('0.2.10', '0.2.9'));
  check('newer: same is not newer', !core.newer('0.7.0', '0.7.0'));
  check('newer: older is not newer', !core.newer('0.6.18', '0.7.0'));
  check('newer: 1.0 beats 0.99.99', core.newer('1.0', '0.99.99'));

  // ------------------------------------------------------------- signatures
  const arch1 = makeArchive('1.1.0');
  const good = feedFor({ version: '1.1.0', archive: arch1 });
  check('a feed signed with our key is accepted', core.verifyFeed(good, PUB));
  check('a feed with no signature is refused', !core.verifyFeed({ ...good, sig: undefined }, PUB));
  check('a feed with an empty signature is refused', !core.verifyFeed({ ...good, sig: '' }, PUB));
  check('a feed with a garbage signature is refused', !core.verifyFeed({ ...good, sig: 'AAAA' }, PUB));
  check('a feed signed by another key is refused', !core.verifyFeed(feedFor({ version: '1.1.0', archive: arch1, sign: OTHER_PEM }), PUB));
  check('a tampered version is refused', !core.verifyFeed({ ...good, version: '9.9.9' }, PUB));
  check('a tampered download link is refused', !core.verifyFeed({ ...good, platforms: { [KEYNAME]: { ...good.platforms[KEYNAME], url: 'https://evil.example/x' } } }, PUB));
  check('a tampered checksum is refused', !core.verifyFeed({ ...good, platforms: { [KEYNAME]: { ...good.platforms[KEYNAME], sha256: '0'.repeat(64) } } }, PUB));
  check('an added platform is refused', !core.verifyFeed({ ...good, platforms: { ...good.platforms, 'linux-arm64': good.platforms[KEYNAME] } }, PUB));
  check('key order in the file does not matter (canonical form)', core.verifyFeed(JSON.parse(JSON.stringify({ sig: good.sig, platforms: good.platforms, notes: good.notes, date: good.date, version: good.version, app: good.app })), PUB));
  check('the placeholder key trusts nothing', !core.verifyFeed(good, core.PLACEHOLDER_KEY));

  // ------------------------------------------------------------- where Cue lives
  const roDir = fresh('readonly');
  fs.mkdirSync(path.join(roDir, 'Cue.app', 'Contents', 'MacOS'), { recursive: true });
  check('Mac: a development run is never updated', core.installTarget({ platform: 'darwin', execPath: '/x/Electron.app/Contents/MacOS/Electron', isPackaged: false }).blocked === 'dev');
  check('Mac: running from a disk image is read-only', core.installTarget({ platform: 'darwin', execPath: '/Volumes/Cue/Cue.app/Contents/MacOS/Cue', isPackaged: true }).blocked === 'readonly');
  check('Mac: a translocated copy is read-only', core.installTarget({ platform: 'darwin', execPath: '/private/var/folders/x/T/AppTranslocation/ABC/d/Cue.app/Contents/MacOS/Cue', isPackaged: true }).blocked === 'readonly');
  const macLive = core.installTarget({ platform: 'darwin', execPath: path.join(roDir, 'Cue.app', 'Contents', 'MacOS', 'Cue'), isPackaged: true });
  check('Mac: the bundle Cue runs from is the one replaced, not /Applications', macLive.live === path.join(roDir, 'Cue.app'), macLive);
  check('Linux: /opt is read-only', core.installTarget({ platform: 'linux', execPath: '/opt/Cue/Cue', isPackaged: true, env: {} }).blocked === 'readonly');
  check('Linux: an AppImage is read-only', core.installTarget({ platform: 'linux', execPath: '/tmp/.mount_x/Cue', isPackaged: true, env: { APPIMAGE: '/home/a/Cue.AppImage' } }).blocked === 'readonly');
  if (!WIN && process.getuid && process.getuid() !== 0) {
    const locked = fresh('locked'); const inner = path.join(locked, 'cue'); fs.mkdirSync(inner);
    fs.chmodSync(inner, 0o555); fs.chmodSync(locked, 0o555);
    check('Linux: a folder this user cannot write is read-only', core.installTarget({ platform: 'linux', execPath: path.join(inner, 'Cue'), isPackaged: true, env: {} }).blocked === 'readonly');
    fs.chmodSync(locked, 0o755); fs.chmodSync(inner, 0o755);
  }
  check('per-user home on Windows', core.perUserHome('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a').endsWith(path.join('Programs', 'Cue')));
  check('per-user home on Linux', core.perUserHome('linux', {}, '/home/a') === path.join('/home/a', '.local', 'share', 'cue'));

  // ------------------------------------------------------------- an unwritable install: no download at all
  {
    resetHits();
    serveFeed(good, arch1);
    const u = createUpdater({ onState() {}, platform: 'linux', arch: 'x64', execPath: '/opt/Cue/Cue', isPackaged: true, env: {}, updatesDir: fresh('updates-ro'), feedUrl: FEED_URL, publicKey: PUB });
    const s = await u.check({ quiet: true });
    check('read-only install: nothing is fetched, not even the feed', !hits['/cue-feed.json'] && !hits['/archive'], hits);
    check('read-only install: one quiet line, no error bar', s.blocked === 'readonly' && s.state === 'idle' && !s.error, s);
    check('the quiet line says it in plain words', /read-only\. Get the new version from labs\.nathanielschool\.com\.$/.test(SAY.readonly));
  }

  // ------------------------------------------------------------- feed refusals in the updater
  const make = (o = {}) => createUpdater({ onState() {}, log: (e) => (o.logs || []).push(e), platform: P, arch: 'x64', feedUrl: FEED_URL, publicKey: PUB, auto: () => true, ...o });
  {
    resetHits();
    serveFeed({ ...good, sig: undefined }, arch1);
    const logs = [];
    const u = make({ installDir: fresh('inst-nosig'), updatesDir: fresh('updates-nosig'), logs });
    const s = await settle(u) && await u.check({ quiet: true });
    check('updater: an unsigned feed is refused and nothing is fetched', !hits['/archive'] && s.state === 'idle', { hits, state: s.state });
    check('updater: the refusal is logged, not shown', logs.some((e) => /not signed/.test(e.error || '')) && !s.error, logs);
    serveFeed({ ...good, version: '9.9.9' }, arch1);
    const s2 = await u.check({ quiet: false });
    check('updater: a tampered feed is refused; asked by hand, it says so in plain words', !hits['/archive'] && s2.state === 'error' && s2.error === SAY.feed, s2.error);
  }
  {
    resetHits();
    const other = feedFor({ version: '1.1.0', archive: arch1, platforms: { 'freebsd-x64': { url: `${BASE_URL}/archive`, sha256: 'a'.repeat(64), size: 10 } } });
    serveFeed(other, arch1);
    const u = make({ installDir: fresh('inst-nokey'), updatesDir: fresh('updates-nokey') });
    const s = await u.check({ quiet: false });
    check('no entry for this machine: nothing happens, silently', s.state === 'idle' && !s.error && !hits['/archive'], { state: s.state, error: s.error, hits });
  }

  // ------------------------------------------------------------- size and checksum
  {
    const upd = fresh('updates-size');
    serveFeed(feedFor({ version: '1.1.0', archive: arch1, size: fs.statSync(arch1).size + 5 }), arch1);
    const u = make({ installDir: fresh('inst-size'), updatesDir: upd });
    await u.check(); const s = await settle(u);
    check('a download shorter than its signed size is thrown away', s.state === 'error' && /cut short/.test(s.error), s.error);
    check('and nothing is left in the updates folder but the memory file', fs.readdirSync(upd).every((f) => f === 'told.json'), fs.readdirSync(upd));
    serveFeed(feedFor({ version: '1.1.1', archive: arch1, size: 10 }), arch1);
    await u.check(); const s2 = await settle(u);
    check('a download bigger than its signed size is stopped', s2.state === 'error' && /bigger/.test(s2.error), s2.error);
  }
  {
    const upd = fresh('updates-sha');
    serveFeed(feedFor({ version: '1.1.0', archive: arch1, sha: 'b'.repeat(64) }), arch1);
    const u = make({ installDir: fresh('inst-sha'), updatesDir: upd });
    await u.check(); const s = await settle(u);
    check('a download that does not match its checksum is thrown away', s.state === 'error' && /checksum/.test(s.error), s.error);
    check('the error is plain words, never a raw message', !/ENOENT|http \d|Error:/.test(s.error), s.error);
    const u2 = make({ installDir: fresh('inst-sha2'), updatesDir: upd });
    await u2.check(); const s2 = await settle(u2);
    check('the same version failing again is not said twice', s2.state === 'idle' && !s2.error, s2);
    resetHits();
    const u3 = make({ installDir: fresh('inst-sha3'), updatesDir: upd });
    await u3.check(); await settle(u3);
    const u4 = make({ installDir: fresh('inst-sha4'), updatesDir: upd });
    await u4.check(); await settle(u4);
    check('after three failed downloads of one version Cue stops fetching it', hits['/archive'] === 1, hits['/archive']);
  }

  // ------------------------------------------------------------- the round trip
  {
    const upd = fresh('updates-good');
    const inst = path.join(fresh('home'), 'cue');
    fakeInstall(inst, 'old 1.0.0');
    resetHits();
    serveFeed(good, arch1);
    const states = [];
    const u = make({ installDir: inst, updatesDir: upd, onState: (s) => states.push(s.state) });
    await u.check(); const s = await settle(u);
    check('a newer signed version is fetched and unpacked with no one clicking', s.state === 'ready' && s.latest === '1.1.0', { state: s.state, error: s.error });
    check('it went to the updates folder, streamed (no temp copy left)', fs.existsSync(path.join(upd, '1.1.0', APPDIR, EXE)) && !fs.readdirSync(upd).some((f) => /\.part|\.zip$|\.tar\.gz$/.test(f)), fs.readdirSync(upd));
    check('no bar was ever asked for: the states were quiet', !states.includes('error'), states);

    if (P === 'linux') {
      // A swap that fails half-way puts everything back.
      const failing = make({ installDir: inst, updatesDir: upd, failAfterAside: true });
      await failing.check(); await settle(failing);
      const hitsBefore = hits['/archive'];
      check('next launch finds the staged copy instead of downloading again', failing.state().state === 'ready' && hits['/archive'] === hitsBefore, { state: failing.state().state, hits: hits['/archive'] });
      const did = failing.installOnQuit();
      check('Linux: a swap that fails half-way returns false', did === false);
      check('Linux: and the old version is back exactly as it was', markerOf(inst) === 'old 1.0.0', markerOf(inst));
      check('Linux: and the staged copy is kept for the next try', fs.existsSync(path.join(upd, '1.1.0', APPDIR, EXE)));
      check('Linux: and no half-made folder is left beside the install', !fs.existsSync(`${inst}.incoming`) && !fs.existsSync(`${inst}.old`));

      const again = make({ installDir: inst, updatesDir: upd });
      await again.check(); await settle(again);
      check('after the failed swap, still no second download', hits['/archive'] === 1, hits['/archive']);
      const ok = again.installOnQuit();
      check('Linux: at quit the staged copy takes the install folder\'s place', ok === true && markerOf(inst) === 'new 1.1.0', markerOf(inst));
      check('Linux: the old folder is kept beside it until the next launch', fs.existsSync(`${inst}.old`) && markerOf(`${inst}.old`) === 'old 1.0.0');
      running = '1.1.0';
      const next = make({ installDir: inst, updatesDir: upd });
      next.clearLeftovers();
      check('next launch removes the old folder and the used staged copy', !fs.existsSync(`${inst}.old`) && !fs.existsSync(path.join(upd, '1.1.0')), fs.readdirSync(upd));
      running = '1.0.0';
    } else {
      // Windows: the updater hands the swap to win-swap.ps1, detached and hidden.
      const calls = [];
      const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { calls[calls.length - 1].unref = true; } }; };
      const w = make({ installDir: inst, updatesDir: upd, spawnFn: fakeSpawn });
      await w.check(); await settle(w);
      const did = w.installOnQuit();
      const c = calls[0] || { args: [], opts: {} };
      check('Windows: at quit a hidden, detached swap script is started and let go', did === true && c.opts.detached === true && c.opts.windowsHide === true && c.unref === true, c.opts);
      check('Windows: it is told to wait for this process', c.args[c.args.indexOf('-WaitPid') + 1] === String(process.pid));
      check('Windows: the script was written outside app.asar, beside the update', fs.existsSync(path.join(upd, 'win-swap.ps1')));
    }
  }

  // ------------------------------------------------------------- swap with an EXDEV-free, staged-missing edge
  {
    const live = path.join(fresh('edge'), 'cue'); fakeInstall(live, 'old');
    const r = core.swapLinux({ live, staged: path.join(BASE, 'does-not-exist') });
    check('Linux: a missing staged copy changes nothing', r.ok === false && markerOf(live) === 'old', r);
  }

  // ------------------------------------------------------------- Mac: the old feed shape still works
  {
    resetHits();
    const old = { app: 'Cue', version: '9.0.0', date: '2026-10-31', notes: 'old shape', sha256: 'c'.repeat(64), size: 123, url: `${BASE_URL}/downloads/Cue.dmg` };
    routes = { '/cue-update.json': Buffer.from(JSON.stringify(old)) };
    const apps = fresh('mac-apps');
    const u = createUpdater({ onState() {}, platform: 'darwin', appsDir: apps, feedUrl: `${BASE_URL}/cue-update.json`, updatesDir: fresh('mac-updates'), auto: () => false });
    const s = await u.check({ quiet: false });
    check('Mac: the old, unsigned labs-downloads feed shape is still read', s.state === 'available' && s.latest === '9.0.0', { state: s.state, error: s.error });
    check('Mac: and the old download link is the one it would fetch', s.feed && s.feed.url === old.url && s.feed.sha256 === old.sha256, s.feed);
    check('Mac: the feed default is still labs-downloads cue-update.json', require(path.join(ROOT, 'src', 'main', 'updater.js')).FEED.endsWith('/labs-downloads/releases/download/downloads/cue-update.json'));
    check('Mac: versionAt still reads a bundle', (() => { const a = path.join(fresh('mac-ver'), 'Cue.app'); fs.mkdirSync(path.join(a, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(a, 'Contents', 'Info.plist'), '<key>CFBundleShortVersionString</key><string>0.6.18</string>'); return versionAt(a) === '0.6.18'; })());
    const dev = createUpdater({ onState() {}, platform: 'darwin', isPackaged: false, feedUrl: `${BASE_URL}/cue-update.json`, updatesDir: fresh('mac-dev') });
    resetHits();
    await dev.check();
    check('Mac: npm start never fetches or swaps anything', !hits['/cue-update.json'] && dev.installOnQuit() === false);
  }

  // ------------------------------------------------------------- the first-run settle
  {
    const homedir = fresh('user');
    const unzipped = path.join(fresh('Downloads'), APPDIR);
    fakeInstall(unzipped, 'from downloads');
    const fakeApp = { isPackaged: true, getVersion: () => '1.0.0' };
    const links = [];
    const fakeShell = { readShortcutLink: () => { throw new Error('none'); }, writeShortcutLink: (...a) => { links.push(a); return true; } };
    const env = P === 'win32' ? { LOCALAPPDATA: path.join(homedir, 'AppData', 'Local'), APPDATA: path.join(homedir, 'AppData', 'Roaming') } : {};
    const none = await settleMod.settle({ app: fakeApp, shell: fakeShell, platform: P, execPath: path.join(unzipped, EXE), env: { ...env, CUE_TEST: '1' }, homedir });
    check('settle: never under CUE_TEST', !none.relaunch);
    const noneMac = await settleMod.settle({ app: fakeApp, shell: fakeShell, platform: 'darwin', execPath: path.join(unzipped, EXE), env, homedir });
    check('settle: never on a Mac', !noneMac.relaunch);
    const noneDev = await settleMod.settle({ app: { ...fakeApp, isPackaged: false }, shell: fakeShell, platform: P, execPath: path.join(unzipped, EXE), env, homedir });
    check('settle: never in development', !noneDev.relaunch);
    const r = await settleMod.settle({ app: fakeApp, shell: fakeShell, platform: P, execPath: path.join(unzipped, EXE), env, homedir, argv: ['cue'] });
    const home = core.perUserHome(P, env, homedir);
    check('settle: Cue copies itself to its per-user home', markerOf(home) === 'from downloads', home);
    check('settle: and opens again from there, saying so once', r.relaunch && r.relaunch.args.includes(settleMod.FLAG), r.relaunch);
    check('settle: the message is plain words', /moved itself to a permanent place/.test(settleMod.settledMessage(P, ['cue', settleMod.FLAG])) && settleMod.settledMessage(P, ['cue']) === '');
    if (P === 'win32') {
      check('settle: a Start menu shortcut to the new place', links.length === 1 && links[0][0].endsWith(path.join('Programs', 'Cue.lnk')) && links[0][2].target === path.join(home, 'Cue.exe'), links);
    } else {
      const desktop = path.join(homedir, '.local', 'share', 'applications', 'cue.desktop');
      const launcher = path.join(homedir, '.local', 'bin', 'cue');
      check('settle: a .desktop entry pointing at the launcher', fs.existsSync(desktop) && fs.readFileSync(desktop, 'utf8').includes(`Exec="${launcher}"`));
      check('settle: an executable launcher that only turns the sandbox off where the system forbids it',
        (fs.statSync(launcher).mode & 0o111) && /apparmor_restrict_unprivileged_userns/.test(fs.readFileSync(launcher, 'utf8')) && fs.readFileSync(launcher, 'utf8').includes(`CUE_HOME="${home}"`));
      check('settle: Linux relaunches through the launcher', r.relaunch.execPath === launcher);
    }
    const again = await settleMod.settle({ app: fakeApp, shell: fakeShell, platform: P, execPath: path.join(home, EXE), env, homedir });
    check('settle: from its home it does nothing more (idempotent)', !again.relaunch && fs.existsSync(path.join(home, EXE)));
  }

  // ------------------------------------------------------------- Windows: the real swap script
  if (WIN) {
    const script = core.writeWinSwap(fresh('ps'));
    const runSwap = async ({ fail = false } = {}) => {
      const root = fresh(fail ? 'win-rollback' : 'win-swap');
      const live = path.join(root, 'Cue'); fakeInstall(live, 'old');
      const staged = path.join(fresh('win-staged'), APPDIR); fakeInstall(staged, 'new');
      const result = path.join(root, 'swap-result.json');
      // The dummy "Cue": a process that lives for two seconds.
      const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'ignore' });
      const started = Date.now();
      let exited = false;
      let launchError = '';
      let output = '';
      const spawnObserved = (cmd, args, opts) => {
        const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
        child.on('error', (error) => { launchError = error.message; exited = true; });
        child.on('close', () => { exited = true; });
        return child;
      };
      core.startWindowsSwap({ script, waitPid: dummy.pid, live, staged, result, version: '1.1.0', failAfterAside: fail, timeoutSec: 30, spawnFn: spawnObserved });
      for (let i = 0; i < 240 && !exited && !fs.existsSync(result); i += 1) await sleep(250);
      const report = core.readResult(result);
      if (!report) console.log('[cue-update-cross] Windows swap produced no result:', launchError || output.trim() || '(no PowerShell output)');
      return { live, staged, result: report, waited: Date.now() - started };
    };
    const a = await runSwap();
    check('Windows script: it waited for the dummy Cue to exit', a.waited >= 1800, a.waited);
    check('Windows script: the swap happened and was reported', a.result && a.result.ok === true && markerOf(a.live) === 'new', a.result);
    check('Windows script: the old folder is kept as Cue.old for the next launch', markerOf(`${a.live}.old`) === 'old');
    core.clearOld(a.live);
    check('Windows: the next launch clears Cue.old', !fs.existsSync(`${a.live}.old`));
    const b = await runSwap({ fail: true });
    check('Windows script: a failure after stepping aside rolls back', b.result && b.result.ok === false && markerOf(b.live) === 'old', b.result);
    check('Windows script: and the staged copy is back where it was', markerOf(b.staged) === 'new' && !fs.existsSync(`${b.live}.incoming`));
    // The swap must outlive the process that starts it, as Cue quits.
    const root = fresh('win-detached');
    const live = path.join(root, 'Cue'); fakeInstall(live, 'old');
    const staged = path.join(fresh('win-staged2'), APPDIR); fakeInstall(staged, 'new');
    const result = path.join(root, 'swap-result.json');
    const coreFile = path.join(ROOT, 'src', 'main', 'update-core.js');
    spawn(process.execPath, ['-e', `require(${JSON.stringify(coreFile)}).startWindowsSwap({ script: ${JSON.stringify(script)}, waitPid: process.pid, live: ${JSON.stringify(live)}, staged: ${JSON.stringify(staged)}, result: ${JSON.stringify(result)}, version: '1.1.0' }); setTimeout(() => process.exit(0), 1000);`], { stdio: 'ignore' });
    for (let i = 0; i < 240 && !fs.existsSync(result); i += 1) await sleep(250);
    const rr = core.readResult(result);
    check('Windows script: it survives the quitting process that started it, then swaps', rr && rr.ok === true && markerOf(live) === 'new', rr);
  } else {
    console.log('[cue-update-cross] SKIP the real win-swap.ps1 run: only on Windows (CI covers it)');
  }

  srv.close();
  const fails = results.filter((x) => !x.ok);
  console.log(`[cue-update-cross] DONE ${results.length - fails.length}/${results.length} passed${fails.length ? ` - failing: ${fails.map((f) => f.name).join(' | ')}` : ''}`);
  console.log(`[cue-update-cross] temp folders left in ${BASE}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.log('[cue-update-cross] CRASH', e.stack || e.message); process.exit(1); });
