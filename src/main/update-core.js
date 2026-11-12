// The parts of updating Cue that do not need Electron, so that they can be
// tested with plain `node` (test/update-cross.js) and used by CI
// (scripts/feed-write.js). updater.js wires them to the running app.
//
// Two feeds:
//   Mac            labs-downloads `cue-update.json` (written by hand, old shape:
//                  { version, date, notes, sha256, size, url }). The DMG is
//                  signed and notarised, and every copy is checked by codesign.
//   Windows/Linux  `cue-feed.json` on the latest GitHub release of
//                  jasonzacmusic/cue, written and signed by CI:
//                  { app, version, date, notes,
//                    platforms: { "win32-x64": {url, sha256, size}, "linux-x64": {...} },
//                    sig }
//                  These builds are not code-signed, so the Ed25519 signature
//                  over the feed is their only proof that it came from us.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

// Paste the public key printed by `node scripts/feed-keygen.js` here. While
// this placeholder is in place, Windows and Linux refuse every feed (and
// test/update-cross.js fails, on purpose, saying so).
const PLACEHOLDER_KEY = 'PASTE-THE-PUBLIC-KEY-PRINTED-BY-scripts/feed-keygen.js-HERE';
const FEED_PUBLIC_KEY = 'MCowBQYDK2VwAyEAjVm64U/L1CX9dql7toNJlkfA9so3ot7+l54cbfFQ1tE=';

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

// ---------------------------------------------------------------- the signed feed
// The exact bytes that are signed. Fixed key order, every field forced to its
// type, platforms sorted by key, `sig` left out. CI signs this string and the
// client verifies this string, through this one function, so the two can never
// disagree about spacing or order:
//   JSON.stringify({ app, version, date, notes,
//                    platforms: { <key, sorted>: { url, sha256, size } } })
function canonical(feed) {
  const f = feed || {};
  const p = (f.platforms && typeof f.platforms === 'object') ? f.platforms : {};
  const platforms = {};
  for (const k of Object.keys(p).sort()) {
    const e = p[k] || {};
    platforms[k] = { url: String(e.url || ''), sha256: String(e.sha256 || ''), size: Number(e.size) || 0 };
  }
  return JSON.stringify({
    app: String(f.app || ''), version: String(f.version || ''), date: String(f.date || ''),
    notes: String(f.notes || ''), platforms,
  });
}

// The public key is the base64 of its DER (SPKI) form: one line, nothing to mangle.
function publicKeyFrom(b64) {
  return crypto.createPublicKey({ key: Buffer.from(String(b64), 'base64'), format: 'der', type: 'spki' });
}

function signFeed(feed, privateKeyPem) {
  const body = { ...feed }; delete body.sig;
  const sig = crypto.sign(null, Buffer.from(canonical(body)), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { ...body, sig };
}

// true only for a feed that carries a good signature from the given key.
function verifyFeed(feed, publicKeyB64 = FEED_PUBLIC_KEY) {
  if (!feed || typeof feed !== 'object' || typeof feed.sig !== 'string' || !feed.sig) return false;
  if (!publicKeyB64 || publicKeyB64 === PLACEHOLDER_KEY) return false;
  try {
    return crypto.verify(null, Buffer.from(canonical(feed)), publicKeyFrom(publicKeyB64), Buffer.from(feed.sig, 'base64'));
  } catch { return false; }
}

const platformKey = (platform, arch) => `${platform}-${arch}`;

// This machine's entry in the feed, or null when there is none (a client with
// no entry does nothing at all) or it is not well formed.
function pickEntry(feed, key) {
  const e = feed && feed.platforms && feed.platforms[key];
  if (!e || typeof e.url !== 'string' || !e.url) return null;
  if (!/^[0-9a-f]{64}$/.test(String(e.sha256 || ''))) return null;
  if (!Number.isInteger(e.size) || e.size <= 0) return null;
  return { url: e.url, sha256: e.sha256, size: e.size };
}

// ---------------------------------------------------------------- where Cue lives
// The per-user home a Windows or Linux Cue settles into, and updates in place.
function perUserHome(platform, env = process.env, homedir = require('os').homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local'), 'Programs', 'Cue');
  if (platform === 'linux') return path.join(env.XDG_DATA_HOME || path.join(homedir, '.local', 'share'), 'cue');
  return '';
}

// Can Cue really write here? On Windows the access() call only looks at the
// read-only flag, not at who may write, so it writes a tiny file and removes it.
function canWrite(dir, platform = process.platform) {
  try {
    if (platform !== 'win32') { fs.accessSync(dir, fs.constants.W_OK); return true; }
    const probe = path.join(dir, `.cue-write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

// What would an update replace, and may it? Returns { live } or { blocked }:
//   blocked 'dev'       not a packaged Cue (npm start): never touch anything
//   blocked 'readonly'  a disk image, a translocated copy, a system folder or
//                       a folder this user cannot write: never download
function installTarget({ platform = process.platform, execPath = process.execPath, env = process.env, isPackaged = false } = {}) {
  if (!isPackaged) return { blocked: 'dev' };
  if (platform === 'darwin') {
    const bundle = path.resolve(execPath, '../../..');
    if (!bundle.endsWith('.app')) return { blocked: 'dev' };
    if (/^\/Volumes\//.test(bundle) || /\/AppTranslocation\//.test(bundle)) return { blocked: 'readonly', live: bundle };
    if (!canWrite(path.dirname(bundle), platform) || !canWrite(bundle, platform)) return { blocked: 'readonly', live: bundle };
    return { live: bundle };
  }
  if (platform === 'win32' || platform === 'linux') {
    const dir = path.dirname(execPath);
    if (platform === 'linux' && (env.APPIMAGE || /^\/(opt|usr|snap)\//.test(dir))) return { blocked: 'readonly', live: dir };
    if (!canWrite(dir, platform) || !canWrite(path.dirname(dir), platform)) return { blocked: 'readonly', live: dir };
    return { live: dir, exe: execPath };
  }
  return { blocked: 'dev' };
}

// ---------------------------------------------------------------- download
// Streams `url` into `file`, never into memory. `request(url, onResponse, onError)`
// calls onResponse with a response that has statusCode and data/end/error
// events (Electron's net, or a stand-in in the tests). The listeners are put on
// inside that call, before a small body can have arrived and gone. Refuses anything bigger than `size` as it arrives,
// then checks the size and the sha256. The file only gets its final name
// once both match, so a half-written copy can never be mistaken for a good one.
class Plain extends Error {}

function downloadTo(request, url, file, { size, sha256, onProgress = () => {} } = {}) {
  const part = `${file}.part`;
  return new Promise((resolve, reject) => {
    let out = null;
    const fail = (e) => {
      try { if (out) out.destroy(); } catch {}
      try { fs.rmSync(part, { force: true }); } catch {}
      reject(e);
    };
    request(url, (res) => {
      if (res.statusCode >= 400) { if (res.resume) res.resume(); fail(new Error(`http ${res.statusCode}`)); return; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      out = fs.createWriteStream(part);
      const hash = crypto.createHash('sha256');
      let got = 0; let stopped = false; let lastPct = -1;
      res.on('data', (c) => {
        if (stopped) return;
        got += c.length;
        if (size && got > size) { stopped = true; fail(new Plain('The download was bigger than it should be, so it was thrown away.')); return; }
        hash.update(c); out.write(c);
        if (size) { const pct = Math.floor((got / size) * 60); if (pct !== lastPct) { lastPct = pct; onProgress(pct); } }
      });
      res.on('error', (e) => { if (!stopped) { stopped = true; fail(e); } });
      res.on('end', () => {
        if (stopped) return;
        stopped = true;
        out.end(() => {
          if (size && got !== size) { fail(new Plain('The download was cut short, so it was thrown away.')); return; }
          if (hash.digest('hex') !== sha256) { fail(new Plain('The download did not match its checksum, so it was thrown away.')); return; }
          try { fs.renameSync(part, file); } catch (e) { fail(e); return; }
          resolve(file);
        });
      });
    }, fail);
  });
}

const sha256Of = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

// ---------------------------------------------------------------- unpack
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 300_000, windowsHide: true, ...opts }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

// Windows 10 1803 and later carry bsdtar as tar.exe, which reads .zip too.
function tarPath(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return 'tar';
  const sys = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(sys) ? sys : 'tar';
}

const exeName = (platform) => (platform === 'win32' ? 'Cue.exe' : 'Cue');

// The folder inside an unpacked archive that holds Cue's own executable.
function findAppDir(root, platform) {
  const want = exeName(platform);
  if (fs.existsSync(path.join(root, want))) return root;
  for (const name of fs.readdirSync(root)) {
    const d = path.join(root, name);
    try { if (fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, want))) return d; } catch {}
  }
  return '';
}

async function extract(archive, into, platform = process.platform) {
  fs.mkdirSync(into, { recursive: true });
  await run(tarPath(platform), ['-xf', archive, '-C', into]);
  const dir = findAppDir(into, platform);
  if (!dir) throw new Plain('The download did not hold a copy of Cue, so it was thrown away.');
  return dir;
}

// ---------------------------------------------------------------- swap, Linux
// At quit: the staged folder takes the place of the running one. Every step
// is a rename on the same disk; if the update folder is on another disk
// (EXDEV) it is copied beside the install first. If any step fails the old
// folder is put straight back and the staged copy is kept for the next try.
// The old folder is left as `<install>.old` and removed at the next launch.
function swapLinux({ live, staged, failAfterAside = false } = {}) {
  const incoming = `${live}.incoming`;
  let old = `${live}.old`;
  try { fs.rmSync(incoming, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(old, { recursive: true, force: true }); } catch {}
  if (fs.existsSync(old)) old = `${live}.old-${Date.now()}`;
  let moved = false;
  try {
    fs.renameSync(staged, incoming); moved = true;
  } catch (e) {
    if (e.code !== 'EXDEV') return { ok: false, why: `stage: ${e.message}` };
    // Electron's fs treats app.asar as a folder; the copy has to see a file.
    const asar = process.noAsar; process.noAsar = true;
    try { fs.cpSync(staged, incoming, { recursive: true, verbatimSymlinks: true }); } catch (e2) {
      process.noAsar = asar;
      try { fs.rmSync(incoming, { recursive: true, force: true }); } catch {}
      return { ok: false, why: `copy: ${e2.message}` };
    }
    process.noAsar = asar;
  }
  const undoIncoming = () => {
    if (moved) { try { fs.renameSync(incoming, staged); } catch {} } else { try { fs.rmSync(incoming, { recursive: true, force: true }); } catch {} }
  };
  try { fs.renameSync(live, old); } catch (e) { undoIncoming(); return { ok: false, why: `step aside: ${e.message}` }; }
  try {
    if (failAfterAside) throw new Error('test: forced failure after stepping aside');
    fs.renameSync(incoming, live);
  } catch (e) {
    try { fs.renameSync(old, live); } catch (e2) { return { ok: false, why: `put back FAILED: ${e2.message}`, old }; }
    undoIncoming();
    return { ok: false, why: `put in place: ${e.message}` };
  }
  return { ok: true, old };
}

// Folders a finished swap left beside the install (`Cue.old`, `cue.old-…`).
function clearOld(live) {
  if (!live) return;
  const parent = path.dirname(live); const base = path.basename(live);
  try {
    for (const name of fs.readdirSync(parent)) {
      if (name === `${base}.old` || name.startsWith(`${base}.old-`) || name === `${base}.incoming`) {
        try { fs.rmSync(path.join(parent, name), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
}

// ---------------------------------------------------------------- swap, Windows
// A running Windows program cannot replace its own folder, so at quit Cue
// starts win-swap.ps1, hidden and detached, and leaves. The script waits for
// this process to end, swaps the folders with the same roll-back as Linux and
// writes a small result file that the next launch reads.
const WIN_SWAP = path.join(__dirname, 'win-swap.ps1');

function powershellPath(env = process.env) {
  const p = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : 'powershell.exe';
}

// The template lives inside app.asar, where PowerShell cannot read it, so a
// copy is written beside the staged update each time.
function writeWinSwap(dir) {
  const out = path.join(dir, 'win-swap.ps1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, fs.readFileSync(WIN_SWAP));
  return out;
}

function startWindowsSwap({ script, waitPid, live, staged, result, version = '', relaunch = '', failAfterAside = false, timeoutSec = 90, spawnFn = spawn, env = process.env } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-WaitPid', String(waitPid), '-Install', live, '-Staged', staged, '-Result', result, '-Version', String(version), '-TimeoutSec', String(timeoutSec)];
  if (relaunch) args.push('-Relaunch', relaunch);
  if (failAfterAside) args.push('-FailAfterAside');
  // Node hides the detached process. PowerShell's -WindowStyle expects a
  // console window, and inheriting Cue's cwd can lock the install directory.
  const child = spawnFn(powershellPath(env), args, {
    cwd: path.dirname(script), detached: true, windowsHide: true, stdio: 'ignore',
  });
  child.unref();
  return child;
}

function readResult(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

module.exports = {
  PLACEHOLDER_KEY, FEED_PUBLIC_KEY, Plain,
  newer, canonical, signFeed, verifyFeed, publicKeyFrom, platformKey, pickEntry,
  perUserHome, canWrite, installTarget,
  downloadTo, sha256Of, run, tarPath, exeName, findAppDir, extract,
  swapLinux, clearOld, WIN_SWAP, writeWinSwap, startWindowsSwap, powershellPath, readResult,
};
