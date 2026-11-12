// First-run test: CUE_QUIET=1 CUE_AGENT_PORT=18851 CUE_TEST=first-run CUE_USER_DATA=<new dir> CUE_OUT=<new dir> npx electron .
//
// Proves Cue is a general browser for a stranger and still exactly the owner's browser after an
// upgrade:
//  1. stranger: a fresh profile - the first-run sheet names the one folder, nothing is pinned, the
//     AI door is shut (nothing listening), and no owner or school word appears in the sidebar state,
//     Settings, the start page, Cmd+K or the menus. A control applies the school's setup and the
//     same scan must find those words. A school page gets no auto sign-in and MIDI has to ask.
//  2. owner upgrade: a second, hidden Cue on a cue.json in the 0.6.18 shape (two folders, tabs in
//     Teach and Create, no spaces/quickKeys/kits saved) - same Spaces, keys, pinned four, kits,
//     school apps, AI door and preset 'nsm'; then a third start on the same profile changes nothing.
//  3. applying then removing the setup on the stranger profile is clean and touches no folder,
//     tab or cookie.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
fs.mkdirSync(OUT, { recursive: true });
const PHASE = process.env.CUE_FIRSTRUN || 'stranger';
const TAG = PHASE === 'stranger' ? 'cue-first-run' : `cue-first-run:${PHASE}`;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`[${TAG}] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(100); } return null; };
const listening = (port) => new Promise((ok) => {
  const s = net.connect({ port, host: '127.0.0.1' });
  const done = (v) => { s.destroy(); ok(v); };
  s.once('connect', () => done(true)); s.once('error', () => done(false)); setTimeout(() => done(false), 1500);
});
const SCHOOL = 'https://learning-portal.nathanielschool.com';
const WORDS = [/jason/i, /nathaniel/i, /nathanielschool/i, /\bTeach\b/, /pitara/i, /\blipi\b/i];
const hits = (text) => WORDS.filter((w) => w.test(String(text))).map(String);
const menuLabels = () => {
  const out = [];
  const walk = (m) => { for (const it of (m && m.items) || []) { if (it.label) out.push(it.label); if (it.submenu) walk(it.submenu); } };
  walk(require('electron').Menu.getApplicationMenu());
  return out;
};
const PRESET_KEYS = () => require('../src/main/presets/nsm.json').quickKeys.map((q) => `${q.name}|${q.url}`);

async function loaded(t) { await until(() => t.view && !t.view.webContents.isLoading() && t.view.webContents.getURL(), 15000); await sleep(300); }

// The window is parked far off every screen, made solid for the picture, and put back.
async function shot(c, name) {
  const w = c.win(); const was = w.getBounds();
  w.setBounds({ ...was, x: -9000, y: 0 }); w.setOpacity(1);
  await sleep(600);
  let img = null;
  try { img = await c.ui().webContents.capturePage(); } catch (e) { console.log(`[${TAG}] shot ${name} failed: ${e.message}`); }
  w.setOpacity(0); w.setBounds(was);
  if (img) fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  return !!img;
}

// Every surface the person reads, as text: the sidebar state, every Settings room but Starting
// setup (the one place the choice of setup has to be named), the start page, Cmd+K and the menus.
async function surfaces(c) {
  const ui = (code) => c.ui().webContents.executeJavaScript(code, true);
  c.sendState(); await sleep(200);
  const state = JSON.stringify(c.lastState());
  c.sendEvent('open-settings', 'tabs'); await sleep(500);
  const settings = await ui(`(async () => {
    const out = [];
    for (const b of [...document.querySelectorAll('.snav button')]) {
      if (b.dataset.id === 'setup') continue;
      b.click(); await new Promise((r) => setTimeout(r, 450));
      out.push(b.textContent + ' :: ' + (document.querySelector('.spane') || {}).innerHTML);
    }
    document.querySelector('#modal').click();
    return out.join('\\n');
  })()`);
  await ui(`(() => { const m = document.querySelector('#modal'); if (!m.hidden) { m.hidden = true; m.innerHTML = ''; } })()`);
  const t = c.openTab({ identity: c.openFolder() }); await loaded(t); await sleep(500);
  const start = await t.view.webContents.executeJavaScript('document.documentElement.outerHTML', true);
  c.closeTab(t.id); await sleep(200);
  c.sendEvent('palette-open'); await sleep(400);
  const qs = [...'abcdefghijklmnopqrstuvwxyz', 'pitara', 'lipi', 'teach', 'nathaniel', 'learning', 'portal', 'nsm'];
  const palette = await ui(`(async () => {
    const out = [];
    const box = document.querySelector('.sheet.cmdk input');
    for (const q of ${JSON.stringify(qs)}) {
      box.value = q; box.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 160));
      // the web rows echo whatever was typed; everything else is what Cue suggests
      for (const r of document.querySelectorAll('.cmdlist .sg')) { const v = (r.querySelector('.v') || {}).textContent || ''; if (v.trim().toLowerCase() !== q) out.push(r.textContent); }
    }
    const m = document.querySelector('#modal'); m.hidden = true; m.innerHTML = '';
    return out.join('\\n');
  })()`);
  const menus = menuLabels().join("\n");
  return { state, settings, start, palette, menus };
}
const scan = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, hits(v)]));

// ================================================================== a stranger
async function stranger(c) {
  const ui = (code) => c.ui().webContents.executeJavaScript(code, true);
  const s = () => c.store.data.settings;
  check('fresh: Cue knows this is a new install', c.store.fresh === true && c.store.data.welcome === 'pending');
  check('fresh: the first-run sheet stays away in a test run', !(await ui('!!document.querySelector(".sheet.welcome")')));
  check('fresh: one folder, id personal, no picture of anybody', c.userFolders().length === 1 && c.userFolders()[0].id === 'personal' && !c.userFolders()[0].picture, c.userFolders());

  // ---- the first-run sheet, asked for
  c.showWelcome(); await sleep(500);
  check('sheet: it opens in the sidebar window, not a dialog', await ui('!!document.querySelector(".sheet.welcome")'));
  const parts = await ui(`(() => { const sh = document.querySelector('.sheet.welcome'); return { text: sh.textContent, boxes: sh.querySelectorAll('.welcomesites input').length, ticked: sh.querySelectorAll('.welcomesites input:checked').length, swatches: sh.querySelectorAll('.wswatch').length, choices: [...sh.querySelectorAll('.choice')].map((b) => b.dataset.id) }; })()`);
  check('sheet: asks for a name', /What should we call you\?/.test(parts.text), parts.text.slice(0, 200));
  check('sheet: ten-odd everyday sites, none ticked', parts.boxes >= 10 && parts.ticked === 0, parts);
  check('sheet: colour swatches', parts.swatches >= 6, parts.swatches);
  check('sheet: Plain and the school setup, Plain first', parts.choices[0] === '' && parts.choices.includes('nsm'), parts.choices);
  check('sheet: says how to add people', /Add more people later with the \+ under your name\. Each person.s sign-ins stay separate\./.test(parts.text));
  check('sheet: can be skipped', /Skip/.test(parts.text));
  await ui(`(() => { const sh = document.querySelector('.sheet.welcome'); const i = sh.querySelector('input[type=text]'); i.value = 'Robin'; i.dispatchEvent(new Event('input')); sh.querySelectorAll('.wswatch')[2].click(); })()`);
  await sleep(200);
  check('screenshot: the first-run sheet', await shot(c, 'first-run-sheet'));
  await ui(`[...document.querySelectorAll('.sheet.welcome .foot button')].find((b) => b.textContent === 'Start').click()`);
  await until(() => c.store.data.welcome === 'done', 5000); await sleep(500);
  const f = c.userFolders();
  check('after: one folder with the typed name, same id', f.length === 1 && f[0].id === 'personal' && f[0].name === 'Robin', f);
  check('after: its picture is a coloured initial in the chosen colour', f[0].picture === '' && f[0].color === c.welcomeData().colors[2], f[0]);
  check('after: nothing is pinned', !c.tabs.some((t) => t.pinned), c.tabs.filter((t) => t.pinned).map((t) => t.url));
  check('after: no starting setup', !s().preset);
  check('screenshot: a fresh sidebar', await shot(c, 'fresh-sidebar'));

  // ---- the plain defaults
  check('plain: one Space, called Home', JSON.stringify(c.spaces()) === '["Home"]' && c.store.data.space === 'Home', c.spaces());
  check('plain: the Spaces row stays hidden with one Space', await ui('document.getElementById("spaces").hidden'));
  const keys = c.quickKeys('personal');
  check('plain: number keys 1-8 empty, 9 a new tab', keys.slice(0, 8).every((q) => !q.name && !q.url) && keys[8].name === 'New tab' && !keys[8].url, keys);
  const fileMenu = require('electron').Menu.getApplicationMenu().items.find((m) => m.label === 'File');
  const numbered = fileMenu.submenu.items.filter((i) => /^CmdOrCtrl\+[1-9]$/.test(String(i.accelerator || ''))).map((i) => `${i.label} ${i.accelerator}`);
  check('plain: File menu has only Command-9, a new tab', numbered.length === 1 && numbered[0] === 'New tab CmdOrCtrl+9', numbered);
  check('plain: opens on the last tab', s().openOn === 'last');
  check('plain: nothing silent, nothing quiet', !(s().muteSites || []).length && !(s().quietSites || []).length, { mute: s().muteSites, quiet: s().quietSites });
  check('plain: Teacher and Business kits off, the others on', s().kits.teacher === false && s().kits.business === false && ['music', 'creator', 'designer', 'video'].every((k) => s().kits[k] !== false), s().kits);
  check('plain: no Live menu, no Bills in Tools', !menuLabels().includes('Live') && !menuLabels().includes('Bills and Alerts'));
  check('plain: no Live class room in Settings', !(await (async () => { c.sendEvent('open-settings', 'tabs'); await sleep(400); const has = await ui('[...document.querySelectorAll(".snav button")].some((b) => b.dataset.id === "live")'); await ui('(() => { const m = document.querySelector("#modal"); m.hidden = true; m.innerHTML = ""; })()'); return has; })()));
  check('plain: the AI door is off and nothing is listening', s().agentPort === false && !c.portUp() && !(await listening(c.agentPort)), { agentPort: s().agentPort, port: c.agentPort });
  check('plain: the AI row in the sidebar is hidden', await ui('document.getElementById("airow").hidden'));
  check('plain: no on-air box in the sidebar (Teacher kit off)', await ui('document.getElementById("livebox").hidden'));
  check('plain: WhatsApp and Gmail are not handed to agents', s().agentSites.whatsapp === false && s().agentSites.gmail === false, s().agentSites);
  check('plain: nothing is kept in the strip for ever', !(s().alwaysPinned || []).length && !c.alwaysPinned('https://web.whatsapp.com/'));
  const cur = c.store.data.currency;
  check('plain: the money is this computer\'s own currency', /^[A-Z]{3}$/.test(cur || '') && c.store.data.usdToInr > 0, { cur, rate: c.store.data.usdToInr, country: c.app.getLocaleCountryCode() });
  {
    const b = c.openTab({ url: 'cue://bills', identity: 'personal' }); await loaded(b); await sleep(600);
    const r = await b.view.webContents.executeJavaScript(`(() => { const want = new Intl.NumberFormat(undefined, { style: 'currency', currency: '${cur}', maximumFractionDigits: 0 }).format(0); return { want, has: document.body.innerText.includes(want), text: document.body.innerText.slice(0, 300) }; })()`, true);
    check('plain: the bills page shows that currency', r.has, r);
    c.closeTab(b.id);
  }

  // ---- 1. the word scan, and its control
  const clean = await surfaces(c);
  const found = scan(clean);
  check('words: none in the sidebar state', !found.state.length, found.state);
  check('words: none in Settings (every room but Starting setup)', !found.settings.length, found.settings);
  check('words: none on the start page', !found.start.length, found.start);
  check('words: none in Cmd+K for a..z and the school words', !found.palette.length, found.palette);
  check('words: none in the menus', !found.menus.length, found.menus);
  fs.writeFileSync(path.join(OUT, 'surfaces-stranger.txt'), Object.entries(clean).map(([k, v]) => `==== ${k}\n${v}`).join('\n\n'));

  // ---- 3. apply, scan as the control, remove, compare
  const ses = c.sessionFor('personal');
  await ses.cookies.set({ url: 'https://cookie-probe.test/', name: 'probe', value: 'kept', expirationDate: Date.now() / 1000 + 86400 });
  const snap = async () => ({
    settings: JSON.stringify(c.store.data.settings), spaces: JSON.stringify(c.store.data.spaces), space: c.store.data.space,
    money: `${c.store.data.currency}/${c.store.data.usdToInr}`, folders: JSON.stringify(c.userFolders()),
    tabs: JSON.stringify(c.tabs.map((t) => [t.id, t.url, t.identity, t.space, t.pinned, t.name])),
    cookies: JSON.stringify((await ses.cookies.get({})).map((k) => `${k.domain}|${k.name}|${k.value}`).sort()),
  });
  const before = await snap();
  const r = c.applyPreset('nsm'); await sleep(900);
  check('apply: it switches on', r.ok && c.store.data.settings.preset === 'nsm', r);
  check('apply: its Spaces join, Home stays because it holds tabs', JSON.stringify(c.spaces()) === '["Home","Teach","Create","Finance","Build"]', c.spaces());
  check('apply: unsaved number keys follow it', JSON.stringify(c.quickKeys('personal').map((q) => `${q.name}|${q.url}`)) === JSON.stringify(PRESET_KEYS()));
  check('apply: every kit on, money in rupees', Object.values(c.store.data.settings.kits).every(Boolean) && c.store.data.currency === 'INR' && c.store.data.usdToInr === 88);
  check('apply: school apps in search', c.suggestions('pitara').apps.length > 0);
  const control = scan(await surfaces(c));
  check('control: the scan finds the words in the sidebar state', control.state.length > 0, control.state);
  check('control: the scan finds them in Settings', control.settings.length > 0, control.settings);
  check('control: the scan finds them on the start page', control.start.length > 0, control.start);
  check('control: the scan finds them in Cmd+K', control.palette.length > 0, control.palette);
  check('control: the scan finds them in the menus', control.menus.length > 0, control.menus);
  const r2 = c.removePreset(); await sleep(900);
  const after = await snap();
  check('remove: it switches off', r2.ok && !c.store.data.settings.preset);
  const diff = (a, b) => { try { const x = JSON.parse(a); const y = JSON.parse(b); if (x && y && typeof x === 'object' && !Array.isArray(x)) return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k])).map((k) => ({ k, before: x[k], after: y[k] })); } catch {} return { before: String(a).slice(0, 300), after: String(b).slice(0, 300) }; };
  for (const k of Object.keys(before)) check(`remove: ${k} exactly as before`, before[k] === after[k], before[k] === after[k] ? undefined : diff(before[k], after[k]));
  const again = scan(await surfaces(c));
  check('remove: the scan is clean again everywhere', Object.values(again).every((x) => !x.length), again);

  // ---- a school page: no auto sign-in, MIDI asks (and the control, with the setup on)
  ses.protocol.handle('https', (req) => {
    const u = new URL(req.url);
    if (u.hostname === 'learning-portal.nathanielschool.com') {
      return new Response('<!doctype html><meta charset=utf-8><title>Portal</title><form onsubmit="event.preventDefault()"><input id=u type=email><input id=pw type=password><button>Sign in</button></form>', { headers: { 'content-type': 'text/html' } });
    }
    return require('electron').net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
  c.vault.importMany('personal', [{ origin: SCHOOL, username: 'staff@example.test', password: 'not-a-real-password' }]);
  const item = c.vault.list('personal').find((x) => x.origin === SCHOOL);
  check('school site: an imported login is not set to sign in by itself', item && item.auto === false, item);
  check('school site: Cue does not offer to sign it in hands-free', c.credReady('personal', SCHOOL) && c.credReady('personal', SCHOOL).handsFree === false, c.credReady('personal', SCHOOL));
  check('school site: MIDI is not pre-allowed', c.midiOk('personal', SCHOOL) === false);
  const page = c.openTab({ url: `${SCHOOL}/`, identity: 'personal' }); await loaded(page);
  const asks = c.midiAsks().length;
  const midi = await page.view.webContents.executeJavaScript('navigator.requestMIDIAccess().then(() => "granted", (e) => "refused: " + e.name)', true).catch((e) => `error: ${e.message}`);
  await sleep(300);
  check('school site: a page asking for MIDI is asked about, not waved through', /refused/.test(midi) && c.midiAsks().length === asks + 1 && c.midiAsks().includes(SCHOOL), { midi, asks: c.midiAsks() });
  await sleep(1500);
  const filled = await page.view.webContents.executeJavaScript('document.getElementById("pw").value', true);
  check('school site: the password box is left empty', filled === '', filled);
  c.closeTab(page.id);
  c.applyPreset('nsm'); await sleep(500);
  check('control: with the setup on, the same login signs in hands-free', c.credReady('personal', SCHOOL).handsFree === true && c.vault.list('personal').find((x) => x.origin === SCHOOL).auto === true);
  check('control: with the setup on, MIDI is allowed without asking', c.midiOk('personal', SCHOOL) === true);
  const page2 = c.openTab({ url: `${SCHOOL}/?again`, identity: 'personal' }); await loaded(page2);
  const asks2 = c.midiAsks().length;
  const midi2 = await page2.view.webContents.executeJavaScript('navigator.requestMIDIAccess().then(() => "granted", (e) => "refused: " + e.name)', true).catch((e) => `error: ${e.message}`);
  check('control: the page gets MIDI and nobody is asked', midi2 === 'granted' && c.midiAsks().length === asks2, { midi2 });
  c.closeTab(page2.id);
  c.removePreset(); await sleep(400);
  check('remove: the login it turned on is off again', c.vault.list('personal').find((x) => x.origin === SCHOOL).auto === false && c.credReady('personal', SCHOOL).handsFree === false);
  ses.protocol.unhandle('https');
}

// ================================================================== the owner's 0.6.18 profile
function ownerFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const tab = (uid, identity, space, url, extra = {}) => ({ uid, url, title: uid, identity, space, pinned: false, order: now, lastActive: now, volume: 1, muted: false, ...extra });
  const cue = {
    tabs: [
      tab('t1', 'school', 'Teach', 'about:blank#teach-school'),
      tab('t2', 'personal', 'Teach', 'about:blank#teach-personal'),
      tab('c1', 'personal', 'Create', 'about:blank#create-personal'),
      tab('w1', 'school', 'Teach', 'https://web.whatsapp.com/', { pinned: true }),
    ],
    activeIndex: 0, folder: 'school', space: 'Teach', aiWhich: 'claudecode', bills: [], alerts: [], archived: [], installersOpened: [],
    financeNamed: true, tidyDefaults: true, quietDefaults: true, stripDefaults: true, groupsRepaired: true, lastVersion: '0.6.18',
    settings: {
      identityLabels: { personal: 'owner-personal@example.test', school: 'owner-school@example.test', agent: '' },
      spaceLogins: { Teach: 'school', Create: 'personal' }, aiDoor: true, sideWidth: 248, autoGroup: true,
    },
  };
  fs.writeFileSync(path.join(dir, 'cue.json'), JSON.stringify(cue, null, 2));
}
const KEEP = ['spaces', 'space', 'folder', 'currency', 'usdToInr', 'aiWhich', 'folders', 'migrated', 'everydayPinned'];
const KEEP_S = ['preset', 'quickKeys', 'kits', 'alwaysPinned', 'everyday', 'spaceLogins', 'muteSites', 'quietSites', 'openOn', 'homeApp', 'agentPort', 'agentSites', 'sharedPairs'];
const picture = (data) => ({ ...Object.fromEntries(KEEP.map((k) => [k, data[k]])), settings: Object.fromEntries(KEEP_S.map((k) => [k, (data.settings || {})[k]])), pinned: (data.tabs || []).filter((t) => t.pinned).map((t) => `${t.identity}|${t.url}`).sort() });

async function owner1(c) {
  const s = () => c.store.data.settings;
  const L = require('../src/main/presets/nsm.json');
  check('upgrade: not a fresh install, the freeze ran once', !c.store.fresh && c.store.data.migrated['legacy-freeze-0.7'] === true);
  check('upgrade: the school setup is on', s().preset === 'nsm');
  check('upgrade: the same four Spaces, in Teach', JSON.stringify(c.spaces()) === JSON.stringify(L.spaces) && c.store.data.space === 'Teach', c.spaces());
  check('upgrade: tabs are still in Teach and Create', c.tabs.find((t) => t.uid === 't1').space === 'Teach' && c.tabs.find((t) => t.uid === 'c1').space === 'Create');
  check('upgrade: the same Space logins', JSON.stringify(s().spaceLogins) === JSON.stringify({ Teach: 'school', Create: 'personal', Finance: 'school', Build: 'personal' }), s().spaceLogins);
  for (const f of ['personal', 'school']) check(`upgrade: ${f} has the same nine number keys`, JSON.stringify(c.quickKeys(f).map((q) => `${q.name}|${q.url}`)) === JSON.stringify(PRESET_KEYS()), c.quickKeys(f));
  c.setFolder('school'); await sleep(300);
  check('upgrade: the menu still says Go to Pitara on Command-5', require('electron').Menu.getApplicationMenu().items.some((m) => m.submenu && m.submenu.items.some((i) => i.label === 'Go to Pitara' && /5$/.test(String(i.accelerator)))));
  const hosts = ['mail.google.com', 'facebook.com', 'instagram.com', 'web.whatsapp.com'];
  const pinnedIn = (f) => hosts.filter((h) => c.tabs.some((t) => t.identity === f && t.pinned && new URL(t.url).hostname.replace(/^www\./, '') === h));
  check('upgrade: the four are pinned in both folders', pinnedIn('personal').length === 4 && pinnedIn('school').length === 4, { personal: pinnedIn('personal'), school: pinnedIn('school') });
  const wa = c.tabs.find((t) => t.uid === 'w1');
  c.command('pin', { id: wa.id, on: false }); await sleep(200);
  check('upgrade: and they still cannot be unpinned', wa.pinned === true);
  check('upgrade: every kit on', Object.values(s().kits).every(Boolean) && Object.keys(s().kits).length >= 6, s().kits);
  check('upgrade: the Live menu and Bills are there', menuLabels().includes('Live') && menuLabels().includes('Bills and Alerts'));
  check('upgrade: the school apps are in Cmd+K', c.suggestions('pitara').apps.length > 0 && c.suggestions('lipi').apps.length > 0);
  c.sendState(); await sleep(100);
  check('upgrade: the AI door is as it was: listening and open', s().agentPort === true && c.lastState().agent.on === true && await listening(c.agentPort));
  check('upgrade: WhatsApp silent and quiet, Cue opens on WhatsApp', JSON.stringify(s().muteSites) === '["web.whatsapp.com"]' && JSON.stringify(s().quietSites) === '["web.whatsapp.com"]' && s().openOn === 'home' && s().homeApp === 'https://web.whatsapp.com/');
  check('upgrade: WhatsApp and Gmail still handed to agents', s().agentSites.whatsapp === true && s().agentSites.gmail === true);
  check('upgrade: bills in rupees at 88', c.store.data.currency === 'INR' && c.store.data.usdToInr === 88);
  const f = c.userFolders();
  check('upgrade: his two folders with their pictures', f.length === 2 && f[0].picture === 'folder-personal.png' && f[1].picture === 'folder-school.png');
  check('upgrade: school pages keep their names and group', c.siteName({ url: 'https://pitara.nathanielschool.com', title: 'Pitara: piano | Nathaniel School of Music' }) === 'Pitara' && require('../src/main/groups').groupFor('https://learning-portal.nathanielschool.com/') === 'nsm');
  check('upgrade: school sites still trusted for MIDI', c.midiOk('school', SCHOOL) === true);
  const t = c.openTab({ identity: 'school' }); await loaded(t); await sleep(500);
  const html = await t.view.webContents.executeJavaScript('document.documentElement.outerHTML', true);
  check('upgrade: the start page has the school tiles and "Our code"', /Learning Portal/.test(html) && /github\.com\/jasonzacmusic/.test(html) && /Our code/.test(html));
  c.closeTab(t.id);
  c.persist(); c.store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(c.app.getPath('userData'), 'cue.json'), 'utf8'));
  check('upgrade: the frozen values are written into cue.json', Array.isArray(saved.spaces) && saved.settings.kits && saved.settings.quickKeys && Array.isArray(saved.settings.alwaysPinned) && saved.settings.preset === 'nsm' && saved.currency === 'INR', Object.keys(saved.settings));
  fs.writeFileSync(path.join(OUT, 'owner-picture.json'), JSON.stringify(picture(saved), null, 2));
}

async function owner2(c) {
  c.persist(); c.store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(c.app.getPath('userData'), 'cue.json'), 'utf8'));
  const was = JSON.parse(fs.readFileSync(path.join(process.env.CUE_PICTURE), 'utf8'));
  const now = picture(saved);
  for (const k of Object.keys(was)) {
    if (k === 'settings') for (const sk of Object.keys(was.settings)) check(`second start: settings.${sk} unchanged`, JSON.stringify(was.settings[sk]) === JSON.stringify(now.settings[sk]), JSON.stringify(was.settings[sk]) === JSON.stringify(now.settings[sk]) ? undefined : { was: was.settings[sk], now: now.settings[sk] });
    else check(`second start: ${k} unchanged`, JSON.stringify(was[k]) === JSON.stringify(now[k]), JSON.stringify(was[k]) === JSON.stringify(now[k]) ? undefined : { was: was[k], now: now[k] });
  }
}

function runChild(phase, dir, out, extra = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..')], {
      env: { ...process.env, CUE_TEST: 'first-run', CUE_FIRSTRUN: phase, CUE_USER_DATA: dir, CUE_OUT: out, CUE_AGENT_PORT: String(Number(process.env.CUE_AGENT_PORT || 18851) + 1), ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', () => {});
    const k = setTimeout(() => { child.kill(); ok({ code: 'timeout', text }); }, 150000);
    child.on('exit', (n) => { clearTimeout(k); ok({ code: n, text }); });
  });
}

module.exports = async (c) => {
  await sleep(1500);
  try {
    if (PHASE === 'owner1') await owner1(c);
    else if (PHASE === 'owner2') await owner2(c);
    else {
      await stranger(c);
      // ---- 2. the owner's upgrade, in two more hidden Cues on one old profile
      const dir = `${c.app.getPath('userData')}-owner`;
      if (fs.existsSync(dir)) check('owner: a fresh folder for the old profile', false, dir);
      else {
        ownerFixture(dir);
        for (const phase of ['owner1', 'owner2']) {
          const out = path.join(OUT, phase);
          const r = await runChild(phase, dir, out, { CUE_PICTURE: path.join(OUT, 'owner1', 'owner-picture.json') });
          for (const line of r.text.split('\n')) if (line.startsWith(`[cue-first-run:${phase}]`) && !/DONE/.test(line)) console.log(line);
          const sub = (() => { try { return JSON.parse(fs.readFileSync(path.join(out, 'first-run.json'), 'utf8')); } catch { return null; } })();
          check(`${phase}: the old profile ran to the end`, !!sub && sub.length > 0, { code: r.code });
          for (const x of sub || []) results.push({ ...x, name: `${phase}: ${x.name}` });
        }
      }
    }
  } catch (e) {
    check('the suite ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  }
  fs.writeFileSync(path.join(OUT, 'first-run.json'), JSON.stringify(results, null, 2));
  const fails = results.filter((x) => !x.ok);
  console.log(`[${TAG}] DONE ${results.length - fails.length}/${results.length} passed`);
  if (fails.length) for (const x of fails) console.log(`[${TAG}] FAILED: ${x.name}`);
  if (!process.env.CUE_KEEP) setTimeout(() => c.app.exit(0), 300);
};
