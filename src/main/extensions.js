// Chrome extensions. Cue copies an extension out of Chrome or Helium, so it keeps working
// after that browser is gone, then loads it into every login except Vanish.
const fs = require('fs');
const path = require('path');

function nameOf(dir, manifest) {
  let n = manifest.name || '';
  const m = n.match(/^__MSG_(\w+)__$/);
  if (m) {
    for (const loc of [manifest.default_locale, 'en', 'en_US'].filter(Boolean)) {
      try {
        const msgs = JSON.parse(fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8'));
        const hit = msgs[m[1]] || msgs[Object.keys(msgs).find((k) => k.toLowerCase() === m[1].toLowerCase())];
        if (hit) { n = hit.message; break; }
      } catch {}
    }
  }
  return n;
}

// Installed extensions in a Chromium profile: Extensions/<id>/<version>/manifest.json
function scan(profileDir) {
  const root = path.join(profileDir, 'Extensions'); const out = [];
  let ids = []; try { ids = fs.readdirSync(root); } catch { return out; }
  for (const id of ids) {
    if (id === 'Temp') continue;
    try {
      const vers = fs.readdirSync(path.join(root, id)).filter((v) => !v.startsWith('.')).sort();
      const dir = path.join(root, id, vers[vers.length - 1]);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      const name = nameOf(dir, manifest);
      if (name && manifest.manifest_version) out.push({ id, name, dir, version: manifest.version });
    } catch {}
  }
  return out;
}

function adopt(extDir, item) {
  const to = path.join(extDir, item.id);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(item.dir, to, { recursive: true });
  fs.rmSync(path.join(to, '_metadata'), { recursive: true, force: true }); // Chromium's own folder name is refused when loading unpacked
  return to;
}

function installed(extDir) {
  let names = []; try { names = fs.readdirSync(extDir); } catch {}
  return names.map((id) => {
    const dir = path.join(extDir, id);
    try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); return { id, dir, name: nameOf(dir, m), version: m.version }; } catch { return null; }
  }).filter(Boolean);
}

async function loadAll(ses, extDir) {
  const res = [];
  for (const e of installed(extDir)) {
    try { await ses.extensions.loadExtension(e.dir); res.push({ ...e, ok: true }); } catch (err) { res.push({ ...e, ok: false, error: err.message }); }
  }
  return res;
}

module.exports = { scan, adopt, installed, loadAll };
