// Saved passwords, encrypted with the operating system's own keychain through safeStorage.
// Each folder has its own list, and nothing in one folder's list is offered in another unless the
// person has paired those two folders. Vanish never saves or fills.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');
const presets = require('./presets');

// Multi-part public suffixes so foo.co.uk and bar.co.uk are never treated as the same site.
const MULTI_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.in', 'org.in', 'net.in', 'gov.in', 'ac.in',
  'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br',
  'com.mx', 'com.sg', 'com.hk', 'com.tw', 'co.kr', 'co.za', 'com.tr', 'com.cn', 'com.my',
]);

function siteKey(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return '';
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return '';
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const last2 = parts.slice(-2).join('.');
    if (MULTI_TLDS.has(last2) && parts.length >= 3) return parts.slice(-3).join('.');
    return last2;
  } catch { return ''; }
}

function sameSite(a, b) {
  if (a === b) return true;
  const ka = siteKey(a), kb = siteKey(b);
  return !!ka && ka === kb;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

class Vault {
  constructor(dir) {
    this.file = path.join(dir, 'passwords.json');
    this.items = [];
    this.never = [];
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.items = j.items || []; this.never = j.never || []; } catch {}
  }

  available() { return safeStorage.isEncryptionAvailable(); }

  storageBackend() {
    try { return typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : 'unknown'; } catch { return 'unknown'; }
  }

  isWeakStorage() { return process.platform === 'linux' && this.storageBackend() === 'basic_text'; }

  static siteKey(origin) { return siteKey(origin); }
  static sameSite(a, b) { return sameSite(a, b); }

  write() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items, never: this.never }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // Exact-origin matches first, then same-site HTTPS subdomain matches (e.g. accounts.example.com <-> example.com).
  matches(identity, origin) {
    const key = siteKey(origin);
    const exact = [];
    const related = [];
    for (const i of this.items) {
      if (i.identity !== identity) continue;
      if (i.origin === origin) exact.push(i);
      else if (key && siteKey(i.origin) === key) related.push(i);
    }
    const byUsed = (a, b) => (b.used || 0) - (a.used || 0);
    exact.sort(byUsed);
    related.sort(byUsed);
    return [...exact, ...related];
  }

  findAll(identity, origin) {
    const out = [];
    const seen = new Set();
    for (const m of this.matches(identity, origin)) {
      let password;
      try { password = safeStorage.decryptString(Buffer.from(m.enc, 'base64')); } catch { continue; }
      const k = `${m.username}\0${password}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ id: m.id, origin: m.origin, username: m.username, password, auto: !!m.auto, exact: m.origin === origin });
    }
    return out;
  }

  find(identity, origin) {
    const first = this.findAll(identity, origin)[0];
    if (!first) return null;
    return { id: first.id, username: first.username, password: first.password, auto: first.auto, origin: first.origin };
  }

  reveal(id) {
    const m = this.items.find((x) => x.id === id);
    if (!m) return null;
    try { return safeStorage.decryptString(Buffer.from(m.enc, 'base64')); } catch { return null; }
  }

  has(identity, origin, username, password) {
    const m = this.items.find((i) => i.identity === identity && i.origin === origin && i.username === username);
    if (!m) return false;
    try { return safeStorage.decryptString(Buffer.from(m.enc, 'base64')) === password; } catch { return false; }
  }

  save({ identity, origin, username, password, auto }) {
    if (!this.available() || !password) return false;
    let cleanOrigin = origin;
    try { cleanOrigin = new URL(origin).origin; } catch { return false; }
    const enc = safeStorage.encryptString(password).toString('base64');
    const u = String(username || '');
    const cur = this.items.find((i) => i.identity === identity && i.origin === cleanOrigin && i.username === u);
    if (cur) { cur.enc = enc; cur.used = Date.now(); if (auto !== undefined) cur.auto = !!auto; }
    else this.items.push({ id: crypto.randomUUID(), identity, origin: cleanOrigin, username: u, enc, auto: !!auto, used: Date.now() });
    this.write();
    return true;
  }

  update(id, { username, password, auto } = {}) {
    const cur = this.items.find((x) => x.id === id);
    if (!cur) return false;
    if (username !== undefined) cur.username = String(username || '');
    if (password !== undefined && password !== '') {
      if (!this.available()) return false;
      cur.enc = safeStorage.encryptString(String(password)).toString('base64');
    }
    if (auto !== undefined) cur.auto = !!auto;
    this.write();
    return true;
  }

  importMany(identity, rows) {
    if (!this.available()) return 0;
    let n = 0;
    for (const r of rows) {
      let origin; try { origin = new URL(r.origin).origin; } catch { continue; }
      if (!r.password || !/^https?:/.test(origin)) continue;
      const enc = safeStorage.encryptString(r.password).toString('base64');
      const cur = this.items.find((i) => i.identity === identity && i.origin === origin && i.username === (r.username || ''));
      if (cur) cur.enc = enc; else this.items.push({ id: crypto.randomUUID(), identity, origin, username: r.username || '', enc, auto: Vault.ownSite(origin), used: 0 });
      n++;
    }
    if (n) this.write();
    return n;
  }

  exportCsv(identity) {
    const lines = ['name,url,username,password'];
    const rows = this.items.filter((x) => x.identity === identity);
    let count = 0;
    for (const m of rows) {
      let password;
      try { password = safeStorage.decryptString(Buffer.from(m.enc, 'base64')); } catch { continue; }
      let host = m.origin;
      try { host = new URL(m.origin).hostname.replace(/^www\./, ''); } catch {}
      lines.push([csvCell(host), csvCell(m.origin), csvCell(m.username || ''), csvCell(password)].join(','));
      count++;
    }
    return { csv: lines.join('\n') + '\n', count };
  }

  used(id) { const i = this.items.find((x) => x.id === id); if (i) { i.used = Date.now(); this.write(); } }
  // An organisation's own sites sign themselves in - but only while its starting setup is on
  // (presets.js). With no preset there is no such site: every login stays off until the person
  // turns it on for that one site.
  static ownSite(origin) { return presets.ownSite(origin); }

  // Switch auto sign-in on for every login held for the preset's own sites. Safe to run on every
  // launch: it only ever turns those sites on, and does nothing with no preset.
  // Answers the ids it turned on, so switching the setup off again can turn exactly those off.
  autoForOwnSites() {
    const ids = [];
    for (const i of this.items) {
      if (!i.auto && Vault.ownSite(i.origin)) { i.auto = true; ids.push(i.id); }
    }
    if (ids.length) this.write();
    return ids;
  }

  get(id) { return this.items.find((x) => x.id === id) || null; }
  setAuto(id, on) { const i = this.items.find((x) => x.id === id); if (i) { i.auto = !!on; this.write(); } }
  remove(id) { this.items = this.items.filter((x) => x.id !== id); this.write(); }
  // A folder that is removed takes its passwords and "never save" choices with it.
  removeIdentity(identity) {
    const before = this.items.length;
    const neverBefore = this.never.length;
    this.items = this.items.filter((x) => x.identity !== identity);
    this.never = this.never.filter((x) => !(x && typeof x === 'object' && x.identity === identity));
    if (this.items.length !== before || this.never.length !== neverBefore) this.write();
    return before - this.items.length;
  }

  isNever(origin, identity) {
    return this.never.some((x) => (typeof x === 'string' ? x === origin : x && x.origin === origin && (!identity || x.identity === identity)));
  }

  neverFor(origin, identity) {
    if (!origin) return;
    if (identity) {
      if (!this.never.some((x) => x && typeof x === 'object' && x.identity === identity && x.origin === origin)) {
        this.never.push({ identity, origin });
        this.write();
      }
    } else if (!this.never.includes(origin)) {
      this.never.push(origin);
      this.write();
    }
  }

  listNever(identity) {
    const out = new Set();
    for (const x of this.never) {
      if (typeof x === 'string') out.add(x);
      else if (x && typeof x === 'object' && (!identity || x.identity === identity) && x.origin) out.add(x.origin);
    }
    return [...out].sort();
  }

  clearNever(origin, identity) {
    const before = this.never.length;
    this.never = this.never.filter((x) => {
      if (typeof x === 'string') return x !== origin;
      if (x && typeof x === 'object') return !(x.origin === origin && (!identity || x.identity === identity));
      return true;
    });
    if (this.never.length !== before) this.write();
  }

  // One folder's saved logins, never the names and sites another folder keeps. With no folder named
  // it is every list, which only the tests and the agent's own checks ask for.
  list(identity) {
    const rows = identity === undefined ? this.items : this.items.filter((x) => x.identity === identity);
    return rows.map(({ id, identity: who, origin, username, auto }) => ({ id, identity: who, origin, username, auto }));
  }
}

module.exports = { Vault };
