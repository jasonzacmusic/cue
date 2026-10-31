// Keeping Cue up to date, the way the other Nathaniel Labs apps do it.
//
// Cue asks a small JSON file what the newest version is, and that is all it does
// on its own. It never installs, never restarts, never interrupts: a class, a
// recording or a tab on air must not be ended by a browser deciding it is time.
// You choose Update, and only then does anything happen.
const { app, net, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const FEED = 'https://github.com/jasonzacmusic/labs-downloads/releases/download/downloads/cue-update.json';
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

function createUpdater({ onState, canInterrupt, log }) {
  // state: idle | checking | available | downloading | ready | error
  let state = { state: 'idle', version: app.getVersion(), latest: null, notes: '', percent: 0, error: '' };
  let timer = null;
  let staged = null; // the unpacked .app waiting to be swapped in

  const push = (patch) => { state = { ...state, ...patch }; onState(state); };

  async function check({ quiet = true } = {}) {
    if (state.state === 'downloading' || state.state === 'ready') return state;
    push({ state: 'checking', error: '' });
    try {
      const body = JSON.parse(String(await get(`${FEED}?t=${Date.now()}`)));
      if (!body.version || !body.url) throw new Error('the update file is incomplete');
      if (newer(body.version, app.getVersion())) {
        push({ state: 'available', latest: body.version, notes: String(body.notes || ''), feed: body });
      } else {
        push({ state: 'idle', latest: body.version, notes: '' });
      }
    } catch (e) {
      log && log({ tool: 'update', error: e.message });
      push({ state: quiet ? 'idle' : 'error', error: e.message });
    }
    return state;
  }

  // Download, check the file really is the one the feed describes, and unpack it
  // beside the old app. Nothing is swapped until you ask for it.
  async function download() {
    if (state.state !== 'available' || !state.feed) return state;
    const feed = state.feed;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-update-'));
    const dmg = path.join(dir, 'Cue.dmg');
    push({ state: 'downloading', percent: 0 });
    try {
      const bytes = await get(feed.url);
      fs.writeFileSync(dmg, bytes);
      if (feed.sha256) {
        const got = crypto.createHash('sha256').update(bytes).digest('hex');
        if (got !== feed.sha256) throw new Error('the download did not match its checksum, so it was thrown away');
      }
      push({ percent: 60 });
      const out = await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', dmg]);
      const vol = (out.match(/\/Volumes\/[^\n]*/) || [])[0];
      if (!vol) throw new Error('the disk image would not open');
      try {
        const src = path.join(vol.trim(), 'Cue.app');
        const dest = path.join(dir, 'Cue.app');
        await run('/usr/bin/ditto', [src, dest]);
        // Refuse anything that is not properly signed, even from our own link.
        await run('/usr/sbin/spctl', ['-a', '-t', 'exec', dest]).catch(() => {
          throw new Error('the downloaded copy is not signed properly, so it was thrown away');
        });
        staged = dest;
      } finally {
        await run('/usr/bin/hdiutil', ['detach', vol.trim()]).catch(() => {});
      }
      push({ state: 'ready', percent: 100 });
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      staged = null;
      log && log({ tool: 'update', error: e.message });
      push({ state: 'error', error: e.message, percent: 0 });
    }
    return state;
  }

  // The only step that closes Cue, and only ever because you clicked it.
  async function install() {
    if (state.state !== 'ready' || !staged) return state;
    const reason = canInterrupt && canInterrupt();
    if (reason) { push({ error: reason }); return state; }
    const live = path.join('/Applications', 'Cue.app');
    const keep = path.join(os.homedir(), '.Trash', `Cue-${app.getVersion()}-replaced-${Date.now()}.app`);
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

  function start() {
    if (timer) return;
    setTimeout(() => check(), FIRST_CHECK);
    timer = setInterval(() => check(), EVERY);
  }

  return { start, check, download, install, openPage: () => shell.openExternal('https://labs.nathanielschool.com/products/cue'), state: () => state };
}

module.exports = { createUpdater, newer };
