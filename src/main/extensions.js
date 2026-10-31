// Chrome extensions. Cue copies an extension out of Chrome or Helium, so it keeps working
// after that browser is gone, then loads it into every login except Vanish.
const fs = require('fs');
const path = require('path');

// What an extension can actually do, said the way a person would say it.
// An extension is the one piece of software you install into a browser that
// can read every page you are signed in to, so "permissions" in a list of
// jargon is no warning at all.
// Worst first, because only the first three are shown.
const CAN = {
  debugger: 'take complete control of any page',
  nativeMessaging: 'talk to other software on your Mac',
  proxy: 'send everything you load through a server of its own',
  cookies: 'read the cookies that keep you signed in',
  identity: 'sign in as you',
  desktopCapture: 'record your screen',
  clipboardRead: 'read whatever you last copied',
  history: 'read everywhere you have been',
  webRequest: 'watch and redirect everything the page loads',
  management: 'switch your other extensions on and off',
  pageCapture: 'save a copy of any page you open',
  tabCapture: 'record what is on a tab',
  privacy: 'change your privacy settings',
  declarativeNetRequest: 'block and redirect what pages load',
  downloads: 'start downloads and see what you download',
  bookmarks: 'read and change your bookmarks',
  tabs: 'see the address and title of every tab',
  geolocation: 'ask where you are',
};
const EVERYWHERE = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*)$/;

function readsWhat(manifest) {
  const hosts = [
    ...(manifest.host_permissions || []),
    ...(manifest.permissions || []).filter((p) => p.includes('://') || p === '<all_urls>'),
    ...(manifest.content_scripts || []).flatMap((c) => c.matches || []),
  ];
  if (hosts.some((h) => EVERYWHERE.test(h))) return 'read and change every page you open';
  const sites = [...new Set(hosts.map((h) => {
    const m = String(h).match(/:\/\/([^/]+)/);
    return m ? m[1].replace(/^\*\./, '').replace(/^\*$/, '') : '';
  }).filter(Boolean))];
  if (!sites.length) return '';
  const few = sites.slice(0, 3);
  const shown = few.length === 1 ? few[0] : `${few.slice(0, -1).join(', ')} and ${few[few.length - 1]}`;
  return `read and change pages on ${shown}${sites.length > 3 ? `, and ${sites.length - 3} more site${sites.length - 3 === 1 ? '' : 's'}` : ''}`;
}

// One sentence, strongest first, at most three things. The long tail of
// harmless permissions (storage, alarms, notifications) is left out: listing
// them buries the one line that matters.
function canDo(manifest) {
  const parts = [];
  const reads = readsWhat(manifest);
  if (reads) parts.push(reads);
  for (const key of Object.keys(CAN)) {
    if ((manifest.permissions || []).includes(key) || (manifest.optional_permissions || []).includes(key)) parts.push(CAN[key]);
  }
  if (!parts.length) return 'It cannot see the pages you open.';
  const three = parts.slice(0, 3);
  const rest = parts.length - three.length;
  const list = three.length === 1 ? three[0] : `${three.slice(0, -1).join(', ')} and ${three[three.length - 1]}`;
  return `It can ${list}${rest > 0 ? `, and ${rest} more thing${rest === 1 ? '' : 's'}` : ''}.`;
}

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
      if (name && manifest.manifest_version) out.push({ id, name, dir, version: manifest.version, can: canDo(manifest) });
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
    try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); return { id, dir, name: nameOf(dir, m), version: m.version, can: canDo(m) }; } catch { return null; }
  }).filter(Boolean);
}

async function loadAll(ses, extDir) {
  const res = [];
  for (const e of installed(extDir)) {
    try { await ses.extensions.loadExtension(e.dir); res.push({ ...e, ok: true }); } catch (err) { res.push({ ...e, ok: false, error: err.message }); }
  }
  return res;
}

module.exports = { scan, adopt, installed, loadAll, canDo };
