'use strict';
// Cue importer: moves bookmarks, history, passwords, cookies and open tabs in from
// other browsers (Chrome, Safari, Helium, Brave, Edge, Arc).
// Every function is defensive: a missing or locked file gives an empty result, never a throw.
// Plain Node only (node:sqlite, crypto, fs, child_process) so it also runs outside Electron.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// ---------------------------------------------------------------- browser table

// Keychain service names (mac) for the "Safe Storage" key of each Chromium-family browser.
const KEY_SERVICES = {
  helium: 'Helium Storage Key',
  chrome: 'Chrome Safe Storage',
  brave: 'Brave Safe Storage',
  edge: 'Microsoft Edge Safe Storage',
  arc: 'Arc Safe Storage',
};

// Roots per platform. Each entry is a list of candidates; the first that exists wins.
function candidateRoots(platform, home, env) {
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const mac = path.join(home, 'Library', 'Application Support');
  const cfg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  if (platform === 'darwin') {
    return {
      helium: [path.join(mac, 'net.imput.helium')],
      chrome: [path.join(mac, 'Google', 'Chrome')],
      brave: [path.join(mac, 'BraveSoftware', 'Brave-Browser')],
      edge: [path.join(mac, 'Microsoft Edge')],
      arc: [path.join(mac, 'Arc', 'User Data')],
    };
  }
  if (platform === 'win32') {
    return {
      helium: [path.join(local, 'imput', 'Helium', 'User Data'), path.join(local, 'net.imput.helium', 'User Data')],
      chrome: [path.join(local, 'Google', 'Chrome', 'User Data')],
      brave: [path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
      edge: [path.join(local, 'Microsoft', 'Edge', 'User Data')],
      arc: [path.join(local, 'Packages', 'TheBrowserCompany.Arc_ttt1ap7aakyb4', 'LocalCache', 'Local', 'Arc', 'User Data'),
        path.join(appData, 'Arc', 'User Data')],
    };
  }
  // linux and anything else
  return {
    helium: [path.join(cfg, 'net.imput.helium'), path.join(cfg, 'helium')],
    chrome: [path.join(cfg, 'google-chrome'), path.join(cfg, 'chromium')],
    brave: [path.join(cfg, 'BraveSoftware', 'Brave-Browser')],
    edge: [path.join(cfg, 'microsoft-edge')],
    arc: [],
  };
}

const NAMES = { helium: 'Helium', chrome: 'Chrome', brave: 'Brave', edge: 'Edge', arc: 'Arc', safari: 'Safari' };
const ORDER = ['helium', 'chrome', 'brave', 'edge', 'arc'];

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Profiles from Local State (profile.info_cache). Falls back to Default / Profile N folders.
function readProfiles(root) {
  const out = [];
  try {
    const cache = readJson(path.join(root, 'Local State'))?.profile?.info_cache;
    if (cache && typeof cache === 'object') {
      for (const [dir, info] of Object.entries(cache)) {
        if (!isDir(path.join(root, dir))) continue;
        out.push({
          dir,
          name: String((info && info.name) || dir),
          email: String((info && info.user_name) || ''),
        });
      }
    }
  } catch { /* fall through */ }
  if (!out.length) {
    try {
      if (isDir(path.join(root, 'Default'))) out.push({ dir: 'Default', name: 'Default', email: '' });
      for (const d of fs.readdirSync(root)) {
        if (/^Profile \d+$/.test(d) && isDir(path.join(root, d))) out.push({ dir: d, name: d, email: '' });
      }
    } catch { /* nothing */ }
  }
  return out;
}

// opts is only for tests: { platform, home, env, safariPresent }
function findBrowsers(opts = {}) {
  const found = [];
  try {
    const platform = opts.platform || process.platform;
    const home = opts.home || os.homedir();
    const env = opts.env || process.env;
    const roots = candidateRoots(platform, home, env);
    for (const id of ORDER) {
      const root = (roots[id] || []).find(isDir);
      if (!root) continue;
      const profiles = readProfiles(root);
      if (!profiles.length) continue;
      found.push({ id, name: NAMES[id], root, profiles });
    }
    if (platform === 'darwin') {
      const present = opts.safariPresent !== undefined
        ? opts.safariPresent
        : isDir('/Applications/Safari.app') || isDir('/System/Cryptexes/App/System/Applications/Safari.app')
          || isDir(path.join(home, 'Library', 'Safari'));
      if (present) {
        found.push({
          id: 'safari', name: NAMES.safari, root: path.join(home, 'Library', 'Safari'),
          profiles: [{ dir: '', name: 'Safari', email: '' }],
        });
      }
    }
  } catch { /* return what we have */ }
  return found;
}

// ---------------------------------------------------------------- helpers

function profileDir(profile) {
  if (profile == null) return 'Default';
  if (typeof profile === 'string') return profile;
  return profile.dir == null ? 'Default' : profile.dir;
}
function profilePath(browser, profile) {
  return path.join(browser.root, profileDir(profile));
}
function isSafari(browser) { return !!browser && browser.id === 'safari'; }

const EPOCH_DIFF_MS = 11644473600000; // 1601-01-01 to 1970-01-01 in ms

// Chromium time is microseconds since 1601. node:sqlite is asked for BigInt because these
// values (about 1.3e16) are larger than JS can hold exactly as a plain number.
function chromiumToMs(us) {
  try {
    const v = typeof us === 'bigint' ? us : BigInt(Math.trunc(Number(us) || 0));
    if (v <= 0n) return 0;
    return Number(v / 1000n) - EPOCH_DIFF_MS;
  } catch { return 0; }
}
function chromiumToSeconds(us) {
  try {
    const v = typeof us === 'bigint' ? us : BigInt(Math.trunc(Number(us) || 0));
    if (v <= 0n) return 0;
    return Number(v / 1000000n) - EPOCH_DIFF_MS / 1000;
  } catch { return 0; }
}
function num(x) {
  try { return Number(x) || 0; } catch { return 0; }
}
function str(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  try { return Buffer.from(x).toString('utf8'); } catch { return ''; }
}

// Copy a database to a private temp folder (the browser may hold the original locked),
// run fn(db) on a read-only handle, then delete the copy. Returns fallback on any failure.
function withDb(file, fn, fallback) {
  let dir = null;
  let db = null;
  try {
    if (!isFile(file)) return fallback;
    const { DatabaseSync } = require('node:sqlite');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-import-'));
    const copy = path.join(dir, 'db.sqlite');
    fs.copyFileSync(file, copy);
    for (const ext of ['-wal']) {
      if (isFile(file + ext)) { try { fs.copyFileSync(file + ext, copy + ext); } catch { /* skip */ } }
    }
    try {
      db = new DatabaseSync(copy, { readOnly: true });
      db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    } catch {
      try { db && db.close(); } catch { /* ignore */ }
      db = new DatabaseSync(copy); // temp copy, so a normal handle is harmless (needed for a copied WAL)
    }
    return fn(db);
  } catch {
    return fallback;
  } finally {
    try { db && db.close(); } catch { /* ignore */ }
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

function rows(db, sql, ...params) {
  const st = db.prepare(sql);
  st.setReadBigInts(true);
  return st.all(...params);
}

// ---------------------------------------------------------------- crypto

// secret -> AES-128 key. mac: 1003 rounds; linux: 1 round (secret 'peanuts').
function deriveKey(secret, platform = process.platform) {
  const rounds = platform === 'darwin' ? 1003 : 1;
  return crypto.pbkdf2Sync(secret, 'saltysalt', rounds, 16, 'sha1');
}

function decryptToBuffer(buf, key) {
  try {
    if (!buf || !key) return null;
    const b = Buffer.from(buf);
    if (b.length < 3 + 16) return null;
    const tag = b.subarray(0, 3).toString('latin1');
    if (tag !== 'v10' && tag !== 'v11') return null;
    const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    return Buffer.concat([d.update(b.subarray(3)), d.final()]);
  } catch { return null; }
}

// opts.stripHash: drop the 32-byte SHA256 prefix newer Chromium cookie databases add.
function decryptValue(buf, key, opts = {}) {
  try {
    let out = decryptToBuffer(buf, key);
    if (!out) return '';
    if (opts.stripHash) out = out.subarray(32);
    return out.toString('utf8');
  } catch { return ''; }
}

// opts is only for tests: { platform, exec } where exec(file, args, options, cb) mimics execFile.
function getKey(browser, opts = {}) {
  return new Promise((resolve) => {
    try {
      const platform = opts.platform || process.platform;
      if (platform === 'win32') return resolve(null);
      if (isSafari(browser)) return resolve(null);
      if (platform === 'linux') return resolve(deriveKey('peanuts', 'linux'));
      if (platform !== 'darwin') return resolve(null);
      const service = browser && KEY_SERVICES[browser.id];
      if (!service) return resolve(null);
      const run = opts.exec || execFile;
      run('security', ['find-generic-password', '-w', '-s', service],
        { timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          try {
            if (err) return resolve(null);
            const secret = String(stdout || '').replace(/\r?\n$/, '');
            if (!secret) return resolve(null);
            resolve(deriveKey(secret, 'darwin'));
          } catch { resolve(null); }
        });
    } catch { resolve(null); }
  });
}

// ---------------------------------------------------------------- bookmarks

function walkChromiumNode(node, trail, out) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'url') {
    if (node.url) out.push({ title: String(node.name || node.url), url: String(node.url), folder: trail.join('/') });
    return;
  }
  const next = node.name ? trail.concat(String(node.name)) : trail;
  if (Array.isArray(node.children)) for (const c of node.children) walkChromiumNode(c, next, out);
}

function walkSafariNode(node, trail, out) {
  if (!node || typeof node !== 'object') return;
  const type = node.WebBookmarkType;
  if (type === 'WebBookmarkTypeLeaf') {
    const url = node.URLString;
    if (url) out.push({ title: String((node.URIDictionary && node.URIDictionary.title) || node.Title || url), url: String(url), folder: trail.join('/') });
    return;
  }
  if (node.WebBookmarkIdentifier === 'com.apple.ReadingList' || node.Title === 'com.apple.ReadingList') return;
  let next = trail;
  const title = node.Title;
  if (title && title !== 'com.apple.ReadingList') {
    const nice = title === 'BookmarksBar' ? 'Favorites' : title === 'BookmarksMenu' ? 'Bookmarks Menu' : title;
    next = trail.concat(String(nice));
  }
  if (Array.isArray(node.Children)) for (const c of node.Children) walkSafariNode(c, next, out);
}

function readBookmarks(browser, profile) {
  try {
    if (!browser) return [];
    if (isSafari(browser)) {
      if (process.platform !== 'darwin') return [];
      return readSafariBookmarks(path.join(os.homedir(), 'Library', 'Safari', 'Bookmarks.plist'));
    }
    const data = readJson(path.join(profilePath(browser, profile), 'Bookmarks'));
    const out = [];
    const roots = data && data.roots;
    if (roots && typeof roots === 'object') {
      for (const node of Object.values(roots)) {
        if (node && typeof node === 'object') walkChromiumNode(node, [], out);
      }
    }
    return out;
  } catch { return []; }
}

function parseSafariBookmarks(json) {
  const out = [];
  try { walkSafariNode(JSON.parse(json), [], out); } catch { /* empty */ }
  return out;
}

// plutil is quick and a denied read simply fails; stays synchronous like the other readers.
function readSafariBookmarks(file) {
  try {
    const { execFileSync } = require('node:child_process');
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', file], {
      maxBuffer: 256 * 1024 * 1024, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8');
    return parseSafariBookmarks(json);
  } catch { return []; }
}

// ---------------------------------------------------------------- history

function readHistory(browser, profile, limit = 20000) {
  try {
    if (!browser || isSafari(browser)) return [];
    const lim = Math.max(1, Math.min(Number(limit) || 20000, 1000000));
    const file = path.join(profilePath(browser, profile), 'History');
    return withDb(file, (db) => {
      let list;
      try {
        list = rows(db, 'SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?', lim);
      } catch {
        list = rows(db, 'SELECT url, title, visit_count, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT ?', lim);
      }
      return list.map((r) => ({
        url: str(r.url), title: str(r.title), visits: num(r.visit_count), lastVisit: chromiumToMs(r.last_visit_time),
      }));
    }, []);
  } catch { return []; }
}

// ---------------------------------------------------------------- passwords

function readPasswords(browser, profile, key) {
  try {
    if (!browser || isSafari(browser) || !key) return [];
    const dir = profilePath(browser, profile);
    const file = isFile(path.join(dir, 'Login Data')) ? path.join(dir, 'Login Data') : path.join(dir, 'Login Data For Account');
    return withDb(file, (db) => {
      const out = [];
      for (const r of rows(db, 'SELECT origin_url, username_value, password_value FROM logins')) {
        const password = decryptValue(r.password_value, key);
        const username = str(r.username_value);
        if (!password) continue; // blocked-site markers and federated logins have no password
        out.push({ origin: str(r.origin_url), username, password });
      }
      return out;
    }, []);
  } catch { return []; }
}

// ---------------------------------------------------------------- cookies

const SAMESITE = { 0: 'no_restriction', 1: 'lax', 2: 'strict' };

function cookieFile(dir) {
  const a = path.join(dir, 'Network', 'Cookies');
  const b = path.join(dir, 'Cookies');
  if (isFile(a)) return a;
  if (isFile(b)) return b;
  return null;
}

function readCookies(browser, profile, key) {
  try {
    if (!browser || isSafari(browser)) return [];
    const file = cookieFile(profilePath(browser, profile));
    if (!file) return [];
    const nowSec = Math.floor(Date.now() / 1000);
    return withDb(file, (db) => {
      let version = 0;
      try {
        const m = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
        version = num(m && m.value);
      } catch { /* no meta table: treat as old */ }
      const out = [];
      const list = rows(db, 'SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires FROM cookies');
      for (const r of list) {
        const host = str(r.host_key);
        if (!host) continue;
        const name = str(r.name);
        const session = num(r.has_expires) === 0 || r.expires_utc === 0n;
        let expirationDate;
        if (!session) {
          expirationDate = chromiumToSeconds(r.expires_utc);
          if (expirationDate <= nowSec) continue; // already expired
        }
        let value = str(r.value);
        const enc = r.encrypted_value && Buffer.from(r.encrypted_value);
        if (!value && enc && enc.length) {
          if (!key) continue;
          const plain = decryptToBuffer(enc, key);
          if (!plain) continue;
          value = (version >= 24 ? plain.subarray(32) : plain).toString('utf8');
        }
        const secure = num(r.is_secure) === 1;
        const cpath = str(r.path) || '/';
        const bareHost = host.replace(/^\./, '');
        const cookie = {
          url: `${secure ? 'https' : 'http'}://${bareHost}${cpath}`,
          name,
          value,
          path: cpath,
          secure,
          httpOnly: num(r.is_httponly) === 1,
          sameSite: SAMESITE[num(r.samesite)] || 'unspecified',
        };
        // __Host- cookies must not carry a domain, or the browser refuses them.
        if (!name.startsWith('__Host-')) cookie.domain = host;
        if (expirationDate !== undefined) cookie.expirationDate = expirationDate;
        out.push(cookie);
      }
      return out;
    }, []);
  } catch { return []; }
}

// ---------------------------------------------------------------- open tabs

// seen maps url -> its entry; a later sighting of the same URL may fill in a missing title.
function dedupePush(out, seen, url, title) {
  if (!url) return;
  const have = seen.get(url);
  if (have) { if (!have.title && title) have.title = title; return; }
  if (out.length >= 200) return;
  const entry = { url, title: title || '' };
  seen.set(url, entry);
  out.push(entry);
}

// Arc keeps tabs in StorableSidebar.json: items carry data.tab.savedURL / savedTitle.
function walkArc(node, out, seen, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40 || out.length >= 200) return;
  if (Array.isArray(node)) { for (const n of node) walkArc(n, out, seen, depth + 1); return; }
  const tab = node.data && node.data.tab;
  if (tab && typeof tab.savedURL === 'string' && /^https?:\/\//i.test(tab.savedURL)) {
    dedupePush(out, seen, tab.savedURL, String(tab.savedTitle || node.title || ''));
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') walkArc(v, out, seen, depth + 1);
}

// Chromium session files (SNSS). A tab navigation stores the URL as a length-prefixed string,
// then the title as a length-prefixed UTF-16 string. We find "http" and trust it only when the
// 4 bytes before it hold a sane length that exactly matches printable URL bytes.
function scanSession(buf, out, seen) {
  const needles = [Buffer.from('https://'), Buffer.from('http://')];
  const hits = [];
  for (const n of needles) {
    let i = buf.indexOf(n);
    while (i !== -1) { hits.push(i); i = buf.indexOf(n, i + 1); }
  }
  hits.sort((a, b) => a - b);
  for (const i of hits) {
    if (i < 4) continue;
    const len = buf.readInt32LE(i - 4);
    if (len < 8 || len > 4096 || i + len > buf.length) continue;
    let ok = true;
    for (let k = i; k < i + len; k++) {
      const c = buf[k];
      if (c < 0x21 || c > 0x7e) { ok = false; break; }
    }
    if (!ok) continue;
    const url = buf.subarray(i, i + len).toString('latin1');
    let title = '';
    try {
      const t = i + ((len + 3) & ~3);
      if (t + 4 <= buf.length) {
        const tl = buf.readInt32LE(t);
        if (tl > 0 && tl <= 1024 && t + 4 + tl * 2 <= buf.length) {
          title = buf.subarray(t + 4, t + 4 + tl * 2).toString('utf16le');
          if (/[\u0000-\u0008\u000e-\u001f]/.test(title)) title = '';
        }
      }
    } catch { title = ''; }
    dedupePush(out, seen, url, title);
  }
}

// Chromium's session file is a log of commands: size, command number, then its data. Replaying
// it gives the tabs that are really open, each on the page it is showing. A plain scan for
// addresses also finds every page in each tab's back-and-forward list, so it is only the fallback.
function parseSession(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'SNSS') return null;
  const SET_WINDOW = 0; const NAVIGATION = 6; const SELECTED = 7; const TAB_CLOSED = 16; const WINDOW_CLOSED = 17;
  const tabs = new Map();
  const tabFor = (id) => { if (!tabs.has(id)) tabs.set(id, { win: 0, sel: -1, navs: new Map() }); return tabs.get(id); };
  let p = 8;
  while (p + 3 <= buf.length) {
    const size = buf.readUInt16LE(p); p += 2;
    if (size < 1 || p + size > buf.length) break;
    const cmd = buf[p]; const b = p + 1; const end = p + size; p = end;
    try {
      if (cmd === SET_WINDOW && b + 8 <= end) tabFor(buf.readInt32LE(b + 4)).win = buf.readInt32LE(b);
      else if (cmd === SELECTED && b + 8 <= end) tabFor(buf.readInt32LE(b)).sel = buf.readInt32LE(b + 4);
      else if (cmd === TAB_CLOSED && b + 4 <= end) tabs.delete(buf.readInt32LE(b));
      else if (cmd === WINDOW_CLOSED && b + 4 <= end) {
        const win = buf.readInt32LE(b);
        for (const [id, t] of tabs) if (t.win === win) tabs.delete(id);
      } else if (cmd === NAVIGATION && b + 16 <= end) {
        const index = buf.readInt32LE(b + 8); const len = buf.readInt32LE(b + 12); const u = b + 16;
        if (len < 0 || len > 8192 || u + len > end) continue;
        const url = buf.subarray(u, u + len).toString('latin1');
        let title = ''; const t = u + ((len + 3) & ~3);
        if (t + 4 <= end) {
          const tl = buf.readInt32LE(t);
          if (tl > 0 && tl <= 1024 && t + 4 + tl * 2 <= end) title = buf.subarray(t + 4, t + 4 + tl * 2).toString('utf16le');
        }
        tabFor(buf.readInt32LE(b + 4)).navs.set(index, { url, title });
      }
    } catch { /* a damaged command: keep the rest */ }
  }
  const out = [];
  for (const t of tabs.values()) {
    const nav = t.navs.get(t.sel) || t.navs.get(Math.max(...t.navs.keys()));
    if (nav && /^https?:\/\//i.test(nav.url)) out.push(nav);
  }
  return out;
}

function newestSessionFile(dir) {
  const sdir = path.join(dir, 'Sessions');
  let best = null;
  try {
    for (const f of fs.readdirSync(sdir)) {
      if (!/^Session_/.test(f)) continue;
      const p = path.join(sdir, f);
      const st = fs.statSync(p);
      if (st.isFile() && (!best || st.mtimeMs > best.t)) best = { p, t: st.mtimeMs };
    }
  } catch { /* none */ }
  if (best) return best.p;
  for (const legacy of ['Current Session', 'Last Session']) {
    const p = path.join(dir, legacy);
    if (isFile(p)) return p;
  }
  return null;
}

function readOpenTabs(browser, profile) {
  const out = [];
  const seen = new Map();
  try {
    if (!browser || isSafari(browser)) return [];
    if (browser.id === 'arc') {
      for (const base of [path.dirname(browser.root), browser.root]) {
        const data = readJson(path.join(base, 'StorableSidebar.json'));
        if (data) { walkArc(data, out, seen); if (out.length) return out; }
      }
    }
    const file = newestSessionFile(profilePath(browser, profile));
    if (!file) return out;
    const st = fs.statSync(file);
    if (st.size > 128 * 1024 * 1024) return out;
    const buf = fs.readFileSync(file);
    const open = parseSession(buf);
    if (open && open.length) open.forEach((n) => dedupePush(out, seen, n.url, n.title));
    else scanSession(buf, out, seen);
    return out;
  } catch { return out; }
}

// ---------------------------------------------------------------- summary

// Counts only. Never touches passwords, cookies or any key.
function summarize(browser, profile) {
  const result = { bookmarks: 0, history: 0 };
  try { result.bookmarks = readBookmarks(browser, profile).length; } catch { /* keep 0 */ }
  try {
    if (browser && !isSafari(browser)) {
      result.history = withDb(path.join(profilePath(browser, profile), 'History'), (db) => {
        let r;
        try { r = db.prepare('SELECT COUNT(*) AS n FROM urls WHERE hidden = 0').get(); }
        catch { r = db.prepare('SELECT COUNT(*) AS n FROM urls').get(); }
        return num(r && r.n);
      }, 0);
    }
  } catch { /* keep 0 */ }
  return result;
}

module.exports = {
  findBrowsers,
  readBookmarks,
  readHistory,
  readPasswords,
  readCookies,
  readOpenTabs,
  getKey,
  decryptValue,
  summarize,
  // exposed for tests and for the UI layer
  deriveKey,
  parseSafariBookmarks,
  chromiumToMs,
  chromiumToSeconds,
};
