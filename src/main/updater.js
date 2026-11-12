// Keeping Cue up to date, the way the other Nathaniel Labs apps do it.
//
// Cue asks a small JSON file what the newest version is, fetches it quietly in
// the background, and puts it in place when you close Cue. You never click
// anything and you never wait: the next time you open Cue, it is the new one.
//
// The one thing it will not do is interrupt. Nothing is installed while Cue is
// open, so a class, a recording or a tab on air can never be ended by a browser
// deciding it is time. If the swap cannot be done at quit, the old version
// simply opens again and the next quit tries once more, from the copy already
// waiting in <userData>/updates - nothing is fetched twice.
//
// Mac reads the hand-written labs-downloads feed and checks every copy with
// codesign. Windows and Linux read the CI-written, Ed25519-signed feed on the
// latest GitHub release (see update-core.js), and refuse it unsigned.
//
// Switch "Update Cue by itself" off and it goes back to asking.
const { app, net, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('./update-core');
const { ensureEntries } = require('./settle');

const { newer, Plain } = core;
const FEED = 'https://github.com/jasonzacmusic/labs-downloads/releases/download/downloads/cue-update.json';
const CROSS_FEED = 'https://github.com/jasonzacmusic/cue/releases/latest/download/cue-feed.json';
// Only Cue, signed by us. Being signed by some other developer, or notarized by Apple, isn't enough.
const OURS = 'identifier "com.jasonzac.cue" and anchor apple generic and certificate leaf[subject.OU] = "R3UNCZH45H"';
const FIRST_CHECK = 25_000;      // let the window settle before touching the network
const EVERY = 6 * 60 * 60 * 1000;
const TRIES = 3;                 // downloads, or swaps, of one version before Cue stops trying it

// Every word the person can ever see. Raw errors only go to the log.
const SAY = {
  readonly: "Cue can't update itself here because this folder is read-only. Get the new version from labs.nathanielschool.com.",
  feed: 'Cue could not check for a new version just now. It will try again later.',
  download: 'Cue could not finish getting the new version. It will try again later.',
  install: 'Cue could not put the new version in place. It will try again the next time you close it.',
};

const run = core.run;

// What version is actually sitting in the app folder right now? Cue may have
// been open for hours while another build was installed by hand, or by one of
// the machines that also ships this app. Reading the real folder is the only
// honest answer; app.getVersion() only knows about the copy that is running.
function versionAt(appPath) {
  try {
    const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

// The same question for a Windows or Linux folder. Electron's fs reads inside
// app.asar; plain node cannot, and then the answer is "cannot tell".
function versionInFolder(dir) {
  try { return String(JSON.parse(fs.readFileSync(path.join(dir, 'resources', 'app.asar', 'package.json'), 'utf8')).version || ''); } catch { return ''; }
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });
    const chunks = [];
    req.on('response', (res) => {
      if (res.statusCode >= 400) { reject(new Error(`http ${res.statusCode}`)); res.resume(); return; }
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// A response to stream from, for downloads that must never sit in memory.
function request(url, onResponse, onError) {
  const req = net.request({ url, redirect: 'follow' });
  req.on('response', onResponse);
  req.on('error', onError);
  req.end();
}

function defaultUpdatesDir() {
  try { return path.join(app.getPath('userData'), 'updates'); } catch { return path.join(os.tmpdir(), `cue-updates-${process.pid}`); }
}

// Everything but onState is optional; the tests pass the rest.
//   appsDir     Mac: the folder holding Cue.app (instead of the running bundle)
//   installDir  Windows/Linux: the install folder (instead of the running one)
//   platform, arch, execPath, env, isPackaged, updatesDir, publicKey, spawnFn, failAfterAside
function createUpdater({ onState, canInterrupt, log, auto, appsDir, feedUrl, platform, arch, execPath, env, isPackaged, updatesDir, installDir, publicKey, spawnFn, failAfterAside, homedir = os.homedir() } = {}) {
  const autoOn = () => (auto ? auto() !== false : true);
  const PLATFORM = platform || process.platform;
  const MAC = PLATFORM === 'darwin';
  const KEY = core.platformKey(PLATFORM, arch || process.arch);
  const FEED_URL = feedUrl || (MAC ? FEED : CROSS_FEED);
  const PUBLIC_KEY = publicKey || core.FEED_PUBLIC_KEY;
  const UPDATES = updatesDir || defaultUpdatesDir();
  const RESULT = path.join(UPDATES, 'swap-result.json');
  const TOLD = path.join(UPDATES, 'told.json');
  const say = (e) => { if (log) log({ tool: 'update', error: String((e && e.message) || e) }); };
  // state: idle | checking | available | downloading | ready | error
  let state = { state: 'idle', version: app.getVersion(), latest: null, notes: '', percent: 0, error: '', blocked: '' };
  let timer = null;
  let staged = null; // the unpacked app waiting to be swapped in
  let refreshing = false;

  const push = (patch) => { state = { ...state, ...patch }; onState && onState(state); };

  // What would be replaced, and may it be? Only the tests ever pass a folder.
  function target() {
    if (MAC && appsDir) return { live: path.join(appsDir, 'Cue.app') };
    if (!MAC && installDir) return { live: installDir, exe: path.join(installDir, core.exeName(PLATFORM)) };
    return core.installTarget({ platform: PLATFORM, execPath: execPath || process.execPath, env: env || process.env, isPackaged: isPackaged !== undefined ? isPackaged : !!app.isPackaged });
  }

  // A small memory of what was already said and tried, per version, so that
  // nothing is ever said twice and a broken release is not fetched for ever.
  const told = () => { try { return JSON.parse(fs.readFileSync(TOLD, 'utf8')); } catch { return {}; } };
  const remember = (fn) => { try { const t = told(); fn(t); fs.mkdirSync(UPDATES, { recursive: true }); fs.writeFileSync(TOLD, JSON.stringify(t)); } catch {} };
  const count = (kind, v) => ((told()[kind] || {})[v] || 0);
  const bump = (kind, v) => remember((t) => { t[kind] = t[kind] || {}; t[kind][v] = (t[kind][v] || 0) + 1; });
  // true the first time a version goes wrong; false after that.
  function firstTime(v) {
    if ((told().errors || {})[v]) return false;
    remember((t) => { t.errors = t.errors || {}; t.errors[v] = true; });
    return true;
  }

  const inUpdates = (p) => p && path.resolve(p).startsWith(path.resolve(UPDATES) + path.sep);
  const dropCopy = (copy) => { if (copy && inUpdates(path.dirname(copy))) { try { fs.rmSync(path.dirname(copy), { recursive: true, force: true }); } catch {} } };

  // The feed, in one shape whichever platform it came from.
  function readOffer(body) {
    if (MAC) {
      if (!body.version || !body.url) throw new Error('the update file is incomplete');
      return { version: String(body.version), notes: String(body.notes || ''), url: body.url, sha256: body.sha256, size: Number(body.size) || 0 };
    }
    if (!core.verifyFeed(body, PUBLIC_KEY)) {
      throw new Error(PUBLIC_KEY === core.PLACEHOLDER_KEY ? 'no public key is built in yet, so no feed is trusted' : 'the update file is not signed by us');
    }
    const e = core.pickEntry(body, KEY);
    if (!e || !body.version) return null; // no build for this machine: nothing to do, nothing to say
    return { version: String(body.version), notes: String(body.notes || ''), ...e };
  }

  // A copy fetched by an earlier run of Cue and never put in place. Used as it
  // is, so a failed swap never costs a second download.
  function stagedFor(version) {
    try {
      const mark = JSON.parse(fs.readFileSync(path.join(UPDATES, version, 'ok.json'), 'utf8'));
      const dest = path.join(UPDATES, version, mark.dir);
      if (mark.version !== version || !fs.existsSync(dest)) return '';
      if (MAC && versionAt(dest) !== version) return '';
      return dest;
    } catch { return ''; }
  }

  // A copy that is waiting does not stop Cue asking. Left open for days, Cue could
  // otherwise sit on whatever it fetched first and put that in place at quit, even
  // though something newer had come out since. The waiting copy stays in place until
  // the newer one has passed every check, so a failed fetch costs nothing.
  async function refreshWaiting(offer) {
    if (refreshing || !autoOn() || !newer(offer.version, state.latest)) return;
    if (count('downloads', offer.version) >= TRIES) return;
    refreshing = true;
    try {
      const copy = await fetchCopy(offer, state.latest);
      const old = staged;
      if (!old) { dropCopy(copy.dest); return; } // swapped in while this was fetching
      staged = copy.dest;
      dropCopy(old);
      push({ latest: copy.version, notes: offer.notes, feed: offer });
    } catch (e) {
      bump('downloads', offer.version);
      say(e);
    } finally { refreshing = false; }
  }

  async function check({ quiet = true } = {}) {
    if (state.state === 'downloading') return state;
    const where = target();
    // Never fetch what could not be put in place. A read-only folder gets one
    // quiet line in Settings, never a bar.
    if (where.blocked) {
      push({ state: 'idle', blocked: where.blocked === 'readonly' ? 'readonly' : '', error: '' });
      return state;
    }
    if (state.blocked) push({ blocked: '' });
    const waiting = state.state === 'ready';
    if (!waiting) push({ state: 'checking', error: '' });
    let offer;
    try {
      offer = readOffer(JSON.parse(String(await get(`${FEED_URL}?t=${Date.now()}`))));
    } catch (e) {
      say(e);
      if (!waiting) push({ state: quiet ? 'idle' : 'error', error: quiet ? '' : SAY.feed });
      return state;
    }
    if (!offer) { if (!waiting) push({ state: 'idle', error: '' }); return state; }
    if (waiting) {
      await refreshWaiting(offer);
    } else if (newer(offer.version, app.getVersion())) {
      const ready = stagedFor(offer.version);
      if (ready && (!MAC || stillOurs(ready))) {
        staged = ready;
        push({ state: 'ready', latest: offer.version, notes: offer.notes, feed: offer, percent: 100 });
        return state;
      }
      push({ state: 'available', latest: offer.version, notes: offer.notes, feed: offer });
      // Fetch it now, in the background, so that by the time you close Cue
      // there is nothing left to wait for. A version that failed three times
      // is left alone until a newer one comes out.
      if (autoOn() && count('downloads', offer.version) < TRIES) download().catch(() => {});
    } else {
      push({ state: 'idle', latest: offer.version, notes: '' });
    }
    return state;
  }

  // Download into <userData>/updates, check it really is the one the feed
  // describes, and unpack it there. It must be newer than `than`. Nothing is
  // swapped here.
  async function fetchCopy(offer, than, progress = () => {}) {
    fs.mkdirSync(UPDATES, { recursive: true });
    const work = path.join(UPDATES, `${offer.version}.part-${Date.now()}`);
    const final = path.join(UPDATES, offer.version);
    const file = path.join(UPDATES, MAC ? `Cue-${offer.version}.dmg` : `Cue-${offer.version}-${KEY}${PLATFORM === 'win32' ? '.zip' : '.tar.gz'}`);
    try {
      await core.downloadTo(request, offer.url, file, { size: offer.size, sha256: offer.sha256, onProgress: progress });
      progress(60);
      let dest; let version;
      if (MAC) {
        fs.mkdirSync(work, { recursive: true });
        const out = await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', file]);
        const vol = (out.match(/\/Volumes\/[^\n]*/) || [])[0];
        if (!vol) throw new Plain('The disk image would not open.');
        try {
          const src = path.join(vol.trim(), 'Cue.app');
          dest = path.join(work, 'Cue.app');
          await run('/usr/bin/ditto', [src, dest]);
          // Refuse anything that is not properly signed, even from our own link.
          await Promise.all([
            run('/usr/sbin/spctl', ['-a', '-t', 'exec', dest]),
            run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${OURS}`, dest]),
          ]).catch(() => {
            throw new Plain('The downloaded copy is not signed properly, so it was thrown away.');
          });
          version = versionAt(dest); // what the app itself says, not what the update file claimed
          if (!version || !newer(version, than)) throw new Plain('The download is not newer than this Cue, so it was thrown away.');
        } finally {
          await run('/usr/bin/hdiutil', ['detach', vol.trim()]).catch(() => {});
        }
      } else {
        dest = await core.extract(file, work, PLATFORM);
        version = offer.version; // the feed that named it is signed
        if (!newer(version, than)) throw new Plain('The download is not newer than this Cue, so it was thrown away.');
      }
      fs.rmSync(file, { force: true });
      fs.rmSync(final, { recursive: true, force: true });
      const rel = path.relative(work, dest);
      fs.renameSync(work, final);
      fs.writeFileSync(path.join(final, 'ok.json'), JSON.stringify({ version, dir: rel }));
      progress(100);
      return { dest: path.join(final, rel), version };
    } catch (e) {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(file, { force: true }); } catch {}
      throw e;
    }
  }

  async function download() {
    if (state.state !== 'available' || !state.feed) return state;
    push({ state: 'downloading', percent: 0 });
    try {
      const copy = await fetchCopy(state.feed, app.getVersion(), (percent) => push({ percent }));
      staged = copy.dest;
      push({ state: 'ready', latest: copy.version, percent: 100 });
    } catch (e) {
      staged = null;
      bump('downloads', state.latest);
      say(e);
      // Said once per version, in plain words; after that, silence.
      const first = firstTime(state.latest);
      push({ state: first ? 'error' : 'idle', error: first ? (e instanceof Plain ? `${e.message} Cue will try again later.` : SAY.download) : '', percent: 0 });
    }
    return state;
  }

  // Never put an older Cue over a newer one. Three machines ship this app, so
  // between the moment a download finished and the moment Cue closes, the copy
  // in the app folder may already be newer than the one waiting. Then the
  // right thing to do is nothing at all.
  function stillOurs(copy = staged) {
    try { execFileSync('/usr/bin/codesign', ['--verify', '--strict', `-R=${OURS}`, copy], { timeout: 60_000 }); return true; } catch (e) {
      say(`the waiting copy changed: ${e.message}`);
      if (copy === staged) staged = null;
      return false;
    }
  }

  function wouldDowngrade(live) {
    const here = MAC ? versionAt(live) : versionInFolder(live);
    const coming = state.latest || '';
    if (!here || !coming) return false;          // cannot tell; carry on as before
    if (newer(coming, here)) return false;
    say(`left alone: ${here} is already in place, the download was ${coming}`);
    return true;
  }

  // Mac: the old bundle steps aside into the Trash (recoverable, never
  // deleted), the new one is copied in, and if that fails the old one is put
  // straight back. The same for "Install and reopen" and for quitting.
  function swapMac(live) {
    const keep = path.join(os.homedir(), '.Trash', `Cue-${app.getVersion()}-replaced-${Date.now()}.app`);
    try {
      fs.renameSync(live, keep);
    } catch (e) {
      if (e.code !== 'EXDEV') { say(`step aside: ${e.message}`); return false; }
      try { execFileSync('/bin/mv', [live, keep], { timeout: 120_000 }); } catch (e2) { say(`step aside: ${e2.message}`); return false; }
    }
    try {
      execFileSync('/usr/bin/ditto', [staged, live], { timeout: 120_000 });
    } catch (e) {
      try { fs.rmSync(live, { recursive: true, force: true }); } catch {}
      try { fs.renameSync(keep, live); } catch { try { execFileSync('/bin/mv', [keep, live], { timeout: 120_000 }); } catch {} }
      say(`put in place: ${e.message}`);
      return false;
    }
    dropCopy(staged);
    staged = null;
    return true;
  }

  function winSwap(where, relaunch) {
    bump('swaps', state.latest);
    try {
      const script = core.writeWinSwap(UPDATES);
      core.startWindowsSwap({
        script, waitPid: process.pid, live: where.live, staged, result: RESULT, version: state.latest || '',
        relaunch: relaunch ? where.exe : '', failAfterAside, spawnFn,
      });
      return true;
    } catch (e) { say(`swap: ${e.message}`); return false; }
  }

  function linuxSwap(where) {
    const r = core.swapLinux({ live: where.live, staged, failAfterAside });
    if (!r.ok) { say(`swap: ${r.why}`); bump('swaps', state.latest); return false; }
    dropCopy(staged);
    staged = null;
    return true;
  }

  // The only step that closes Cue, and only ever because you clicked it.
  async function install() {
    if (state.state !== 'ready' || !staged) return state;
    const reason = canInterrupt && canInterrupt();
    if (reason) { push({ error: reason }); return state; }
    const where = target();
    if (where.blocked) { push({ state: 'idle', blocked: where.blocked === 'readonly' ? 'readonly' : '', error: '' }); return state; }
    const live = where.live;
    if (wouldDowngrade(live)) { dropCopy(staged); staged = null; push({ state: 'idle', error: '' }); return state; }
    if (MAC) {
      if (!stillOurs()) { push({ state: 'idle', error: '' }); return state; }
      if (!swapMac(live)) { push({ state: 'error', error: SAY.install }); return state; }
      app.relaunch({ execPath: path.join(live, 'Contents', 'MacOS', 'Cue') });
      app.exit(0);
      return state;
    }
    if (PLATFORM === 'win32') {
      if (!winSwap(where, true)) { push({ state: 'error', error: SAY.install }); return state; }
      app.exit(0);
      return state;
    }
    let launcher = where.exe;
    // Use the same launcher as the apps menu. It selects the sandbox mode
    // before the new Chromium process starts, including on current Ubuntu.
    const launchEnv = env || process.env;
    if (live === core.perUserHome('linux', launchEnv, homedir)) {
      try { launcher = ensureEntries({ platform: 'linux', home: live, env: launchEnv, homedir }).launcher; }
      catch (e) { say(e); push({ state: 'error', error: SAY.install }); return state; }
    }
    if (!linuxSwap(where)) { push({ state: 'error', error: SAY.install }); return state; }
    app.relaunch({ execPath: launcher, args: process.argv.slice(1) });
    app.exit(0);
    return state;
  }

  // Called as Cue is closing. No window is left to interrupt and no page is
  // left to lose, so this is the one moment the swap is free. If any step
  // fails the old version is put straight back.
  function installOnQuit() {
    if (!staged || !autoOn() || state.state !== 'ready') return false;
    const where = target();
    if (where.blocked) return false;
    const live = where.live;
    if (!fs.existsSync(live)) return false;            // running from somewhere else; leave it alone
    if (count('swaps', state.latest) >= TRIES) return false;
    if (MAC) {
      if (wouldDowngrade(live) || !stillOurs()) { dropCopy(staged); staged = null; return false; }
      return swapMac(live);
    }
    if (wouldDowngrade(live)) { dropCopy(staged); staged = null; return false; }
    if (PLATFORM === 'win32') return winSwap(where, false);
    return linuxSwap(where);
  }

  // A copy left behind by a Cue that closed mid-download, or by an older Cue.
  function clearLeftovers() {
    const tmp = os.tmpdir();
    try {
      for (const name of fs.readdirSync(tmp)) {
        if (/^cue-update-(?!test-)/.test(name)) fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
      }
    } catch {}
    // In <userData>/updates: half-finished downloads, and anything not newer
    // than the Cue that is running now. A newer staged copy is kept.
    try {
      for (const name of fs.readdirSync(UPDATES)) {
        const p = path.join(UPDATES, name);
        if (/\.part/.test(name) || /\.(dmg|zip|tar\.gz)$/.test(name)) { fs.rmSync(p, { recursive: true, force: true }); continue; }
        if (/^\d+(\.\d+)*$/.test(name) && !newer(name, app.getVersion())) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
    // What the Windows swap script left for this launch to read.
    const r = core.readResult(RESULT);
    if (r) {
      if (!r.ok) say(`the last swap did not happen: ${r.why}`);
      try { fs.rmSync(RESULT, { force: true }); } catch {}
    }
    if (!MAC) { const where = target(); if (where.live && !where.blocked) core.clearOld(where.live); }
  }

  function start() {
    if (timer) return;
    clearLeftovers();
    setTimeout(() => check(), FIRST_CHECK);
    timer = setInterval(() => check(), EVERY);
  }

  // The once-per-version error line, put away.
  const dismiss = () => { if (state.state === 'error') push({ state: 'idle', error: '' }); };

  return {
    start, check, download, install, installOnQuit, dismiss, clearLeftovers,
    ready: () => state.state === 'ready',
    openPage: () => shell.openExternal('https://labs.nathanielschool.com/products/cue'),
    state: () => state,
  };
}

module.exports = { createUpdater, newer, versionAt, SAY, FEED, CROSS_FEED };
