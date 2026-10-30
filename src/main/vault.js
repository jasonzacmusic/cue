// Saved passwords, encrypted with the operating system's own keychain through safeStorage.
// Each login (Personal, School, AI agent) has its own list. Vanish never saves or fills.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');

class Vault {
  constructor(dir) {
    this.file = path.join(dir, 'passwords.json');
    this.items = [];
    this.never = [];
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.items = j.items || []; this.never = j.never || []; } catch {}
  }

  available() { return safeStorage.isEncryptionAvailable(); }

  write() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items, never: this.never }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  matches(identity, origin) {
    return this.items.filter((i) => i.identity === identity && i.origin === origin).sort((a, b) => (b.used || 0) - (a.used || 0));
  }

  find(identity, origin) {
    const m = this.matches(identity, origin)[0];
    if (!m) return null;
    try { return { id: m.id, username: m.username, password: safeStorage.decryptString(Buffer.from(m.enc, 'base64')), auto: !!m.auto }; } catch { return null; }
  }

  has(identity, origin, username, password) {
    const m = this.matches(identity, origin).find((i) => i.username === username);
    if (!m) return false;
    try { return safeStorage.decryptString(Buffer.from(m.enc, 'base64')) === password; } catch { return false; }
  }

  save({ identity, origin, username, password, auto }) {
    if (!this.available()) return false;
    const enc = safeStorage.encryptString(password).toString('base64');
    const cur = this.items.find((i) => i.identity === identity && i.origin === origin && i.username === username);
    if (cur) { cur.enc = enc; if (auto !== undefined) cur.auto = auto; } else this.items.push({ id: crypto.randomUUID(), identity, origin, username, enc, auto: !!auto, used: Date.now() });
    this.write();
    return true;
  }

  importMany(identity, rows) {
    let n = 0;
    for (const r of rows) {
      let origin; try { origin = new URL(r.origin).origin; } catch { continue; }
      if (!r.password || !/^https?:/.test(origin)) continue;
      const enc = safeStorage.encryptString(r.password).toString('base64');
      const cur = this.items.find((i) => i.identity === identity && i.origin === origin && i.username === (r.username || ''));
      if (cur) cur.enc = enc; else this.items.push({ id: crypto.randomUUID(), identity, origin, username: r.username || '', enc, auto: Vault.ownSite(origin), used: 0 });
      n++;
    }
    this.write();
    return n;
  }

  used(id) { const i = this.items.find((x) => x.id === id); if (i) { i.used = Date.now(); this.write(); } }
  // Our own apps sign themselves in. These are sites the school owns, so there is
  // nothing to weigh up: Jason should never type a password into his own portal.
  // Everything else stays off until he turns it on for that one site himself.
  static ownSite(origin) {
    try {
      const h = new URL(origin).hostname;
      return h === 'nathanielschool.com' || h.endsWith('.nathanielschool.com');
    } catch { return false; }
  }

  // Switch auto sign-in on for every login we hold for our own sites. Safe to
  // run on every launch: it only ever turns our own sites on.
  autoForOwnSites() {
    let n = 0;
    for (const i of this.items) {
      if (!i.auto && Vault.ownSite(i.origin)) { i.auto = true; n++; }
    }
    if (n) this.write();
    return n;
  }

  setAuto(id, on) { const i = this.items.find((x) => x.id === id); if (i) { i.auto = !!on; this.write(); } }
  remove(id) { this.items = this.items.filter((x) => x.id !== id); this.write(); }
  neverFor(origin) { if (!this.never.includes(origin)) { this.never.push(origin); this.write(); } }
  list() { return this.items.map(({ id, identity, origin, username, auto }) => ({ id, identity, origin, username, auto })); }
}

module.exports = { Vault };
