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
const { execFile, execFileSync } = require('child_process');

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

// Can Cue really write here? Tests with a real tiny probe file on every OS so
// macOS read-only DMGs, APFS snapshots, ACLs, Linux mount flags and Windows NTFS
// permissions are all detected honestly instead of relying on accessSync alone.
function canWrite(dir, platform = process.platform) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    const probe = path.join(dir, `.cue-write-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

// A guaranteed-writable per-user install location when the currently running
// Cue lives on a read-only DMG, AppTranslocation, Program Files, or /opt.
// Returns null only for store/single-file packages (Snap / AppImage).
function relocateTarget({ platform = process.platform, env = process.env, homedir = require('os').homedir() } = {}) {
  if (platform === 'darwin') {
    const sysApps = '/Applications';
    const sysBundle = path.join(sysApps, 'Cue.app');
    if (canWrite(sysApps, platform) && (!fs.existsSync(sysBundle) || canWrite(sysBundle, platform))) {
      return { live: sysBundle, exe: path.join(sysBundle, 'Contents', 'MacOS', 'Cue'), relocate: true };
    }
    const userApps = path.join(homedir, 'Applications');
    const userBundle = path.join(userApps, 'Cue.app');
    return { live: userBundle, exe: path.join(userBundle, 'Contents', 'MacOS', 'Cue'), relocate: true };
  }
  if (platform === 'win32') {
    const home = perUserHome('win32', env, homedir);
    return home ? { live: home, exe: path.join(home, exeName('win32')), relocate: true } : null;
  }
  if (platform === 'linux') {
    if (env.APPIMAGE || env.SNAP) return null;
    const home = perUserHome('linux', env, homedir);
    return home ? { live: home, exe: path.join(home, exeName('linux')), relocate: true } : null;
  }
  return null;
}

// What would an update replace, and may it? Returns { live } or { blocked }:
//   blocked 'dev'       not a packaged Cue (npm start): never touch anything
//   blocked 'readonly'  a read-only disk image, a translocated copy, a system
//                       folder or a folder this user cannot write
function installTarget({ platform = process.platform, execPath = process.execPath, env = process.env, isPackaged = false } = {}) {
  if (!isPackaged) return { blocked: 'dev' };
  if (platform === 'darwin') {
    const bundle = path.resolve(execPath, '../../..');
    if (!bundle.endsWith('.app')) return { blocked: 'dev' };
    if (/\/AppTranslocation\//.test(bundle)) return { blocked: 'readonly', live: bundle, reason: 'translocated' };
    // Never reject every /Volumes/* path blindly: writable external SSDs can update
    // in place, while mounted read-only .dmg volumes fail canWrite() honestly.
    if (!canWrite(path.dirname(bundle), platform) || !canWrite(bundle, platform)) {
      return { blocked: 'readonly', live: bundle, reason: /^\/Volumes\//.test(bundle) ? 'dmg' : 'permissions' };
    }
    return { live: bundle };
  }
  if (platform === 'win32' || platform === 'linux') {
    const dir = path.dirname(execPath);
    if (platform === 'linux' && (env.APPIMAGE || env.SNAP || /^\/(opt|usr|snap)\//.test(dir))) {
      return { blocked: 'readonly', live: dir, reason: env.APPIMAGE || env.SNAP || /^\/snap\//.test(dir) ? 'package' : 'system' };
    }
    if (!canWrite(dir, platform) || !canWrite(path.dirname(dir), platform)) return { blocked: 'readonly', live: dir, reason: 'permissions' };
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
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      const finish = () => {
        try { fs.rmSync(part, { force: true }); } catch {}
        reject(error);
      };
      if (out && !out.closed) {
        out.once('close', finish);
        out.destroy();
      } else finish();
    };
    request(url, (res) => {
      if (failed) return;
      if (res.statusCode >= 400) { if (res.resume) res.resume(); fail(new Error(`http ${res.statusCode}`)); return; }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        out = fs.createWriteStream(part);
      } catch (error) { fail(error); return; }
      out.on('error', fail);
      const hash = crypto.createHash('sha256');
      let got = 0;
      let lastPct = -1;
      res.on('data', (chunk) => {
        if (failed) return;
        got += chunk.length;
        if (size && got > size) { fail(new Plain('The download was bigger than it should be, so it was thrown away.')); return; }
        hash.update(chunk);
        if (!out.write(chunk) && res.pause && res.resume) {
          res.pause();
          out.once('drain', () => res.resume());
        }
        if (size) { const pct = Math.floor(got / size * 60); if (pct !== lastPct) { lastPct = pct; onProgress(pct); } }
      });
      res.on('error', fail);
      res.on('end', () => {
        if (failed) return;
        if (size && got !== size) { fail(new Plain('The download was cut short, so it was thrown away.')); return; }
        if (hash.digest('hex') !== sha256) { fail(new Plain('The download did not match its checksum, so it was thrown away.')); return; }
        out.once('close', () => {
          if (failed) return;
          try { fs.renameSync(part, file); resolve(file); } catch (error) { fail(error); }
        });
        out.end();
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
  fs.mkdirSync(path.dirname(live), { recursive: true });
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
  const hadLive = fs.existsSync(live);
  if (hadLive) {
    try { fs.renameSync(live, old); } catch (e) { undoIncoming(); return { ok: false, why: `step aside: ${e.message}` }; }
  }
  try {
    if (failAfterAside) throw new Error('test: forced failure after stepping aside');
    fs.renameSync(incoming, live);
  } catch (e) {
    if (hadLive) {
      try { fs.renameSync(old, live); } catch (e2) { return { ok: false, why: `put back FAILED: ${e2.message}`, old }; }
    }
    undoIncoming();
    return { ok: false, why: `put in place: ${e.message}` };
  }
  return { ok: true, old: hadLive ? old : '' };
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

function startWindowsSwap({ script, waitPid, live, staged, result, version = '', relaunch = '', failAfterAside = false, timeoutSec = 90, launchFn = execFileSync, env = process.env } = {}) {
  // Pass the invocation as one PowerShell command. Script parameters like
  // -Version then belong to the script, never to powershell.exe itself.
  const literal = (value) => "'" + String(value).replace(/['\u2018-\u201b]/g, "$&$&") + "'";
  const command = [
    '&', literal(script), '-WaitPid', literal(waitPid), '-Install', literal(live),
    '-Staged', literal(staged), '-Result', literal(result), '-Version', literal(version),
    '-TimeoutSec', literal(timeoutSec),
  ];
  if (relaunch) command.push('-Relaunch', literal(relaunch));
  if (failAfterAside) command.push('-FailAfterAside');
  const encode = (text) => Buffer.from(text, 'utf16le').toString('base64');
  const workerArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' +
    encode(command.join(' ') + '; exit $LASTEXITCODE');
  const executable = powershellPath(env);
  // Let Windows launch the independent worker. Wait for the launch to
  // succeed, but let the worker wait for Cue to exit before swapping files.
  const launch = [
    'Start-Process', '-FilePath', literal(executable), '-ArgumentList', literal(workerArgs),
    '-WorkingDirectory', literal(path.dirname(script)), '-WindowStyle', 'Hidden', '-ErrorAction', 'Stop',
  ].join(' ');
  launchFn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(launch)], {
    windowsHide: true, timeout: 10_000, stdio: 'pipe',
  });
}

function readResult(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

// A ready update also goes in while Cue is open, but only at a quiet moment: nobody has
// touched the computer for twenty minutes (idleState 'idle' at a 20-minute threshold), or the
// screen has been locked for at least ten. '' means now is fine; anything else is the reason not.
function quietRefusal({ ready, auto, idle = 0, idleState = 'active', onAir, busy, downloading, vanish, temp } = {}) {
  if (!ready) return 'nothing waiting';
  if (!auto) return 'updates are by hand';
  if (!(idleState === 'idle' || (idleState === 'locked' && idle >= 600))) return 'someone is here';
  if (onAir) return 'on air';
  if (busy) return 'a page is busy';
  if (downloading) return 'downloading';
  if (vanish) return 'vanish';
  if (temp) return 'just for now';
  return '';
}

module.exports = {
  quietRefusal,
  PLACEHOLDER_KEY, FEED_PUBLIC_KEY, Plain,
  newer, canonical, signFeed, verifyFeed, publicKeyFrom, platformKey, pickEntry,
  perUserHome, canWrite, relocateTarget, installTarget,
  downloadTo, sha256Of, run, tarPath, exeName, findAppDir, extract,
  swapLinux, clearOld, WIN_SWAP, writeWinSwap, startWindowsSwap, powershellPath, readResult,
};
