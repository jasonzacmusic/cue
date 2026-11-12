// Starting setups ("presets"). Cue on its own is a plain browser for anyone. Everything that only
// makes sense for one organisation - its Spaces, its apps in search, its own sites trusted to sign
// in and use MIDI, its start-page tiles - lives in one JSON file under presets/, and is consulted
// only while settings().preset names that file. With no preset none of it exists: no trusted
// third-party domain, no school apps, no tiles.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'presets');
const cache = new Map();
let current = () => null; // set by main: () => settings().preset

function load(id) {
  if (!/^[a-z0-9-]{1,40}$/.test(String(id || ''))) return null;
  if (cache.has(id)) return cache.get(id);
  let p = null;
  try {
    p = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
    p.id = id;
    // The app list is its own file (it is long, and other tools read it too).
    p.appList = typeof p.apps === 'string' ? JSON.parse(fs.readFileSync(path.join(DIR, p.apps), 'utf8')) : (Array.isArray(p.apps) ? p.apps : []);
    p.nameRules = (p.siteNames || []).map(([re, v]) => [new RegExp(re, 'i'), v]);
    p.logoRules = (p.siteLogos || []).map(([re, v]) => [new RegExp(re, 'i'), v]);
  } catch { p = null; }
  cache.set(id, p);
  return p;
}

function configure(getId) { current = typeof getId === 'function' ? getId : () => null; }
// The preset that is on, or null.
function active() { try { return load(current()); } catch { return null; } }

const hostIn = (host, list) => {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return !!h && (list || []).some((x) => { const q = String(x || '').toLowerCase(); return !!q && (h === q || h.endsWith(`.${q}`)); });
};
const hostOfOrigin = (origin) => { try { return new URL(origin).hostname; } catch { return ''; } };

// A site the organisation owns: it may sign itself in and talk to MIDI gear without asking.
// Only ever true while a preset is on.
function ownSite(origin) {
  const p = active();
  return !!p && hostIn(hostOfOrigin(origin), p.ownHosts);
}

const apps = () => { const p = active(); return p ? p.appList : []; };
const field = (k, fallback) => { const p = active(); return p && p[k] !== undefined ? p[k] : fallback; };
// Every preset that ships, for Settings.
function available() {
  try { return fs.readdirSync(DIR).filter((f) => /^[a-z0-9-]+\.json$/.test(f) && !/apps\.json$/.test(f)).map((f) => load(f.replace(/\.json$/, ''))).filter(Boolean).map((p) => ({ id: p.id, name: p.name, about: p.about || '' })); } catch { return []; }
}

module.exports = { configure, active, load, ownSite, apps, field, hostIn, available };
