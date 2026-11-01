// Keeping Cue up to date, the way the other Nathaniel Labs apps do it.
//
// Cue asks a small JSON file what the newest version is, fetches it quietly in
// the background, and puts it in place when you close Cue. You never click
// anything and you never wait: the next time you open Cue, it is the new one.
//
// The one thing it will not do is interrupt. Nothing is installed while Cue is
// open, so a class, a recording or a tab on air can never be ended by a browser
// deciding it is time. If the swap cannot be done at quit, the old version
// simply opens again and the next quit tries once more.
//
// Switch "Update Cue by itself" off and it goes back to asking.
const { app, net, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const FEED = 'https://github.com/jasonzacmusic/labs-downloads/releases/download/downloads/cue-update.json';
// Only Cue, signed by us. Being signed by some other developer, or notarized by Apple, isn't enough.
const OURS = 'identifier "com.jasonzac.cue" and anchor apple generic and certificate leaf[subject.OU] = "R3UNCZH45H"';
const FIRST_CHECK = 25_000;      // let the window settle before touching the network
const EVERY = 6 * 60 * 60 * 1000;

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 180_000, ...opts }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

// "0.2.10" is newer than "0.2.9": compare the numbers, never the strings.
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// What version is actually sitting in /Applications right now? Cue may have
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

function createUpdater({ onState, canInterrupt, log, auto, appsDir, feedUrl } = {}) {
  const autoOn = () => (auto ? auto() !== false : true);
  // Where the real app lives, and where the version file is asked for. Only
  // the tests ever pass anything else.
  const APPS = appsDir || '/Applications';
  const FEED_URL = feedUrl || FEED;
  // state: idle | checking | available | downloading | ready | error
  let state = { state: 'idle', version: app.getVersion(), latest: null, notes: '', percent: 0, error: '' };
  let timer = null;
  let staged = null; // the unpacked .app waiting to be swapped in
  let refreshing = false;

  const push = (patch) => { state = { ...state, ...patch }; onState(state); };

  const dropCopy = (copy) => { if (copy) { try { fs.rmSync(path.dirname(copy), { recursive: true, force: true }); } catch {} } };

  // A copy that is waiting does not stop Cue asking. Left open for days, Cue could
  // otherwise sit on whatever it fetched first and put that in place at quit, even
  // though something newer had come out since. The waiting copy stays in place until
  // the newer one has passed every check, so a failed fetch costs nothing.
  async function refreshWaiting(body) {
    if (refreshing || !autoOn() || !newer(body.version, state.latest)) return;
    refreshing = true;
    try {
      const copy = await fetchCopy(body, state.latest);
      const old = staged;
      if (!old) { dropCopy(copy.dest); return; } // swapped in while this was fetching
      staged = copy.dest;
      dropCopy(old);
      push({ latest: copy.version, notes: String(body.notes || ''), feed: body });
    } catch (e) {
      log && log({ tool: 'update', error: e.message });
    } finally { refreshing = false; }
  }

  async function check({ quiet = true } = {}) {
    if (state.state === 'downloading') return state;
    const waiting = state.state === 'ready';
    if (!waiting) push({ state: 'checking', error: '' });
    try {
      const body = JSON.parse(String(await get(`${FEED_URL}?t=${Date.now()}`)));
      if (!body.version || !body.url) throw new Error('the update file is incomplete');
      if (waiting) {
        await refreshWaiting(body);
      } else if (newer(body.version, app.getVersion())) {
        push({ state: 'available', latest: body.version, notes: String(body.notes || ''), feed: body });
        // Fetch it now, in the background, so that by the time you close Cue
        // there is nothing left to wait for.
        if (autoOn()) download().catch(() => {});
      } else {
        push({ state: 'idle', latest: body.version, notes: '' });
      }
    } catch (e) {
      log && log({ tool: 'update', error: e.message });
      if (!waiting) push({ state: quiet ? 'idle' : 'error', error: e.message });
    }
    return state;
  }

  // Download, check the file really is the one the feed describes, and unpack it
  // beside the old app. It must be newer than `than`. Nothing is swapped here.
  async function fetchCopy(feed, than, progress = () => {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-update-'));
    const dmg = path.join(dir, 'Cue.dmg');
    try {
      const bytes = await get(feed.url);
      fs.writeFileSync(dmg, bytes);
      const got = crypto.createHash('sha256').update(bytes).digest('hex');
      if (got !== feed.sha256) throw new Error('the download did not match its checksum, so it was thrown away');
      progress(60);
      const out = await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', dmg]);
      const vol = (out.match(/\/Volumes\/[^\n]*/) || [])[0];
      if (!vol) throw new Error('the disk image would not open');
      try {
        const src = path.join(vol.trim(), 'Cue.app');
        const dest = path.join(dir, 'Cue.app');
        await run('/usr/bin/ditto', [src, dest]);
        // Refuse anything that is not properly signed, even from our own link.
        await Promise.all([
          run('/usr/sbin/spctl', ['-a', '-t', 'exec', dest]),
          run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${OURS}`, dest]),
        ]).catch(() => {
          throw new Error('the downloaded copy is not signed properly, so it was thrown away');
        });
        const inside = versionAt(dest); // what the app itself says, not what the update file claimed
        if (!inside || !newer(inside, than)) throw new Error('the download is not newer than this Cue, so it was thrown away');
        fs.rmSync(dmg, { force: true });
        return { dest, version: inside };
      } finally {
        await run('/usr/bin/hdiutil', ['detach', vol.trim()]).catch(() => {});
      }
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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
      log && log({ tool: 'update', error: e.message });
      push({ state: 'error', error: e.message, percent: 0 });
    }
    return state;
  }

  // Never put an older Cue over a newer one. Three machines ship this app, so
  // between the moment a download finished and the moment Cue closes, the copy
  // in /Applications may already be newer than the one waiting. Then the right
  // thing to do is nothing at all.
  const stillOurs = () => {
    try { execFileSync('/usr/bin/codesign', ['--verify', '--strict', `-R=${OURS}`, staged], { timeout: 60_000 }); return true; } catch (e) {
      log && log({ tool: 'update', error: `the waiting copy changed: ${e.message}` });
      staged = null;
      return false;
    }
  };

  function wouldDowngrade(live) {
    const here = versionAt(live);
    const coming = state.latest || '';
    if (!here || !coming) return false;          // cannot tell; carry on as before
    if (newer(coming, here)) return false;
    log && log({ tool: 'update', error: `left alone: ${here} is already in place, the download was ${coming}` });
    return true;
  }

  // The only step that closes Cue, and only ever because you clicked it.
  async function install() {
    if (state.state !== 'ready' || !staged) return state;
    const reason = canInterrupt && canInterrupt();
    if (reason) { push({ error: reason }); return state; }
    const live = path.join(APPS, 'Cue.app');
    const keep = path.join(os.homedir(), '.Trash', `Cue-${app.getVersion()}-replaced-${Date.now()}.app`);
    if (wouldDowngrade(live)) { staged = null; push({ state: 'idle', error: '' }); return state; }
    if (!stillOurs()) { push({ state: 'idle', error: '' }); return state; }
    try {
      if (fs.existsSync(live)) await run('/bin/mv', [live, keep]); // recoverable, never deleted
      await run('/usr/bin/ditto', [staged, live]);
    } catch (e) {
      push({ state: 'error', error: `could not put the new version in place: ${e.message}` });
      return state;
    }
    app.relaunch({ execPath: path.join(live, 'Contents', 'MacOS', 'Cue') });
    app.exit(0);
    return state;
  }

  // Called as Cue is closing. No window is left to interrupt and no page is
  // left to lose, so this is the one moment the swap is free. It is done with
  // plain file moves rather than a helper process: fewer moving parts, and if
  // any step fails the old version is put straight back.
  function installOnQuit() {
    if (!staged || !autoOn() || state.state !== 'ready') return false;
    const live = path.join(APPS, 'Cue.app');
    const keep = path.join(os.homedir(), '.Trash', `Cue-${app.getVersion()}-replaced-${Date.now()}.app`);
    if (!fs.existsSync(live)) return false;            // running from somewhere else; leave it alone
    if (wouldDowngrade(live) || !stillOurs()) { dropCopy(staged); staged = null; return false; }
    try {
      fs.renameSync(live, keep);                        // recoverable, never deleted
    } catch (e) { log && log({ tool: 'update', error: `step aside: ${e.message}` }); return false; }
    try {
      execFileSync('/usr/bin/ditto', [staged, live], { timeout: 120_000 });
    } catch (e) {
      try { fs.renameSync(keep, live); } catch {}       // put the old one back, exactly as it was
      log && log({ tool: 'update', error: `put in place: ${e.message}` });
      return false;
    }
    dropCopy(staged);
    staged = null;
    return true;
  }

  // A copy left behind by a Cue that closed mid-download, or by an older Cue.
  function clearLeftovers() {
    const tmp = os.tmpdir();
    try {
      for (const name of fs.readdirSync(tmp)) {
        if (/^cue-update-(?!test-)/.test(name)) fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
      }
    } catch {}
  }

  function start() {
    if (timer) return;
    clearLeftovers();
    setTimeout(() => check(), FIRST_CHECK);
    timer = setInterval(() => check(), EVERY);
  }

  return { start, check, download, install, installOnQuit, ready: () => state.state === 'ready', openPage: () => shell.openExternal('https://labs.nathanielschool.com/products/cue'), state: () => state };
}

module.exports = { createUpdater, newer, versionAt };
