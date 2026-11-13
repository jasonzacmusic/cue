// Vanish settings and shortcuts: CUE_QUIET=1 CUE_TEST=vanish-settings CUE_USER_DATA=<new dir> CUE_OUT=<new dir> npx electron .
// With CUE_SEEDED=1 the user-data folder was given a cue.json holding onePlayer:true before launch,
// so the one-time migration is proved on a real start, not just by calling it.
//
// Proves: normal-browser defaults (nothing pauses anything), the main window's one-at-a-time rule
// and Vanish's own never reach each other, the 0.7 migration runs once, the main window's keys do
// nothing while Vanish is in front (and still work in the main window), every Vanish key does its
// job, forgetting wipes cookies, and Cue's own pages are refused in Vanish. Local pages only.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Menu } = require('electron');
const vanishKeys = require('../src/main/vanish-keys');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[cue-vanish] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(100); } return null; };
const MOD = process.platform === 'darwin' ? 'meta' : 'control';

function wav(freq = 440, secs = 6) {
  const rate = 44100; const n = rate * secs; const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 12000), 44 + i * 2);
  return buf;
}
const TONE = wav();
const PAGES = {
  '/play': `<title>Play</title><p>note note note</p><audio id=a loop src="/tone.wav"></audio><script>a.play().catch(()=>{})</script>`,
  '/note': `<title>Note</title><p>note one, note two, note three</p>`,
  '/cookie': `<title>Cookie</title><script>document.cookie='vanishcrumb=1;max-age=99999'</script>`,
};
function server() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      if (u === '/tone.wav') { res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': TONE.length, 'accept-ranges': 'none' }); return res.end(TONE); }
      if (PAGES[u]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><meta charset=utf-8>${PAGES[u]}`); }
      res.writeHead(404); res.end('no');
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function loaded(t) { await until(() => t.view && !t.view.webContents.isLoading() && t.view.webContents.getURL() && t.view.webContents.getURL() !== 'about:blank', 15000); await sleep(150); return t.view.webContents; }
const playing = (t) => t.view.webContents.executeJavaScript(`!!document.getElementById('a') && !document.getElementById('a').paused`).catch(() => false);
const allPlaying = async (list) => Promise.all(list.map(playing));
const key = (wc, keyCode, mods = []) => { wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods }); };

function findItem(menu, test) {
  for (const it of menu.items) {
    if (test(it)) return it;
    if (it.submenu) { const x = findItem(it.submenu, test); if (x) return x; }
  }
  return null;
}

module.exports = async function run(c) {
  // The main window's keys checked here include the Live menu and his Spaces: the owner's world.
  if (!process.env.CUE_SEEDED) require('./world').asOwner(c);
  const srv = await server();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const s = () => c.store.data.settings;
  let lastState = null; const events = [];
  const uwc = c.ui().webContents; const orig = uwc.send.bind(uwc);
  uwc.send = (ch, ...a) => { if (ch === 'ui:state') lastState = a[0]; if (ch === 'ui:event') events.push(a); return orig(ch, ...a); };
  await sleep(1200);

  // ---- defaults and the one-time migration
  if (process.env.CUE_SEEDED) {
    check('migration: an existing profile with one-at-a-time on starts with it off', s().onePlayer === false && c.store.data.migrated['onePlayer-off-0.7'] === true, { onePlayer: s().onePlayer, migrated: c.store.data.migrated });
  } else {
    check('defaults: one video at a time is off for a fresh install', s().onePlayer === false, s().onePlayer);
  }
  check('defaults: a link from a playing video goes to the new tab and pauses nothing', s().videoSwitch === 'both', s().videoSwitch);
  check('defaults: Vanish settings', s().vanishOnePlayer === false && s().vanishNewTab === 'go' && s().vanishNewTabPlace === 'next' && s().vanishPauseOnBlur === false && s().vanishHideFromCapture === true && s().vanishFullScreen === false);
  {
    const keep = s().onePlayer; const had = c.store.data.migrated;
    c.store.data.migrated = {}; s().onePlayer = true;
    c.runMigrations();
    const flipped = s().onePlayer === false;
    c.setSetting('onePlayer', true);
    c.runMigrations();
    check('migration: flips onePlayer off once', flipped);
    check('migration: and not again after he turns it back on', s().onePlayer === true && c.store.data.migrated['onePlayer-off-0.7'] === true);
    c.store.data.migrated = had; c.setSetting('onePlayer', keep);
  }

  // ---- main window: three videos all play by default
  c.setSetting('onePlayer', false);
  const m = [];
  for (let i = 1; i <= 3; i++) { const t = c.openTab({ url: `${base}/play?m${i}`, identity: 'personal' }); await loaded(t); await sleep(1500); m.push(t); }
  let p = await allPlaying(m);
  check('main: with the defaults, three videos all keep playing', p.every(Boolean), p);

  // A link from a playing video, defaults: go to it, both play.
  await m[2].view.webContents.executeJavaScript(`window.open('${base}/play?mlink'); 1`, true).catch(() => {}); await sleep(2500);
  const mlink = c.tabs.find((t) => t.url.includes('?mlink'));
  check('main: a link from a playing video comes to the front and both play', !!mlink && c.getState().activeId === mlink.id && (await playing(m[2])) && (await playing(mlink)), { found: !!mlink });
  if (mlink) c.closeTab(mlink.id);
  for (const t of m) c.closeTab(t.id);
  await sleep(300);

  // ---- main window: with one-at-a-time on, only the newest plays
  c.setSetting('onePlayer', true);
  const m2 = [];
  for (let i = 1; i <= 3; i++) { const t = c.openTab({ url: `${base}/play?n${i}`, identity: 'personal' }); await loaded(t); await sleep(1800); m2.push(t); }
  p = await allPlaying(m2);
  check('main: with one at a time on, only the newest plays', !p[0] && !p[1] && p[2], p);

  // ---- Vanish: three videos all play by default, and the main window's rule never reaches in
  const v = [];
  for (let i = 1; i <= 3; i++) { const t = c.openTab({ url: `${base}/play?v${i}`, identity: 'vanish' }); await loaded(t); await sleep(1800); v.push(t); }
  p = await allPlaying(v);
  check('vanish: three videos all play by default', p.every(Boolean), p);
  check('vanish: the main window\'s one-at-a-time rule leaves Vanish alone, and Vanish leaves the main window playing', p.every(Boolean) && (await playing(m2[2])), { main: await playing(m2[2]) });

  // ---- Vanish's own one-at-a-time
  c.setSetting('vanishOnePlayer', true);
  const v4 = c.openTab({ url: `${base}/play?v4`, identity: 'vanish' }); await loaded(v4); await sleep(2000);
  p = await allPlaying([...v, v4]);
  check('vanish: with its own setting on, only the newest Vanish video plays', !p[0] && !p[1] && !p[2] && p[3], p);
  check('vanish: and the main window\'s video is untouched', await playing(m2[2]));
  const n4 = c.openTab({ url: `${base}/play?n4`, identity: 'personal' }); await loaded(n4); await sleep(2000);
  check('main: a new main-window video pauses the main window\'s old one', !(await playing(m2[2])) && (await playing(n4)));
  check('main: and leaves the Vanish video playing', await playing(v4));
  c.setSetting('onePlayer', false);
  const n5 = c.openTab({ url: `${base}/play?n5`, identity: 'personal' }); await loaded(n5); await sleep(1500);
  check('vanish: its one-at-a-time never pauses the main window (main rule off)', (await playing(n4)) && (await playing(n5)) && (await playing(v4)));
  c.setSetting('vanishOnePlayer', false);
  for (const t of [...m2, n4, n5]) c.closeTab(t.id);
  for (const t of [...c.vanish.tabs].slice(0, -1)) c.vanish.closeTab(t.id);
  await sleep(400);

  // ---- Vanish: where a link's new tab goes
  const vs = c.vanish.tabs[0];
  c.vanish.activate(vs.id); await sleep(300);
  c.setSetting('vanishNewTab', 'stay');
  await vs.view.webContents.executeJavaScript(`window.open('${base}/play?vstay'); 1`, true).catch(() => {}); await sleep(2500);
  const vstay = c.vanish.tabs.find((t) => t.url.includes('?vstay'));
  check('vanish: "stay where I am" keeps you on the video and the new tab waits quietly', !!vstay && c.vanish.activeId() === vs.id && (await playing(vs)) && !(await playing(vstay)), { found: !!vstay });
  if (vstay) c.vanish.closeTab(vstay.id);
  c.setSetting('vanishNewTab', 'go'); c.setSetting('vanishNewTabPlace', 'end');
  const vx = c.vanish.add(`${base}/note?vx`); await loaded(vx); // [vs, vx]: "next" would land between them
  c.vanish.move(vs.id, 0); c.vanish.activate(vs.id); await sleep(300);
  await vs.view.webContents.executeJavaScript(`window.open('${base}/note?vend'); 1`, true).catch(() => {}); await sleep(1500);
  const vend = c.vanish.tabs.find((t) => t.url.includes('?vend'));
  check('vanish: "at the end" puts the new tab last, and "go to it" brings it to the front', !!vend && c.vanish.tabs.indexOf(vend) === c.vanish.tabs.length - 1 && c.vanish.activeId() === vend.id && c.vanish.tabs.indexOf(vs) === 0);
  c.setSetting('vanishNewTabPlace', 'next');
  for (const t of c.vanish.tabs.filter((x) => x !== vs)) c.vanish.closeTab(t.id);
  await sleep(300);

  // ---- the main window's keys do nothing while Vanish is in front, and still work in the main window
  const menu = Menu.getApplicationMenu();
  const item = (label) => findItem(menu, (it) => it.label === label);
  const press = (label) => { const it = item(label); if (it) it.click(); return !!it; };
  const mA = c.openTab({ url: `${base}/note?ma`, identity: 'personal' }); await loaded(mA);
  const mB = c.openTab({ url: `${base}/note?mb`, identity: 'personal' }); await loaded(mB);
  await sleep(200);
  const otherSpace = ((lastState && lastState.spaces) || ['Teach', 'Create']).find((x) => x !== c.store.data.space) || 'Create';
  let devtools = 0;
  mB.view.webContents.toggleDevTools = () => { devtools++; };
  const snap = () => ({ active: c.getState().activeId, live: c.getState().live, program: c.getState().programId, space: c.store.data.space, marks: c.lib.bookmarks('').length, cue: (lastState && lastState.cue || []).length, devtools });
  const realFocused = c.vanish.focused;
  c.vanish.focused = () => true; // the window cannot really take focus in a hidden test
  const vwc = vs.view.webContents;
  const before = snap();
  // From the keyboard, into the Vanish page...
  for (const [k, mods] of [['Enter', [MOD]], ['1', [MOD, 'shift']], ['Right', [MOD, 'shift']], ['Left', [MOD, 'shift']], ['C', [MOD, 'shift']], ['D', [MOD]], ['I', [MOD, 'alt']], ['L', [MOD, 'shift']], ['2', process.platform === 'darwin' ? ['control'] : ['alt']]]) key(vwc, k, mods);
  await sleep(400);
  // ...and the menu items those keys belong to, as the accelerator would call them.
  const labels = ['Cue This Tab', 'Bookmark This Page', 'Developer Tools', 'TAKE: Put Cued Tab On Air', 'Go Live / End Live', 'Next Cued Tab On Air', 'Previous Cued Tab On Air', 'On Air: Cue 1', 'On Air: Cue 2', `Space: ${otherSpace}`, 'Next Tab', 'Previous Tab', 'Tab 1'];
  const found = labels.filter(press);
  await sleep(600);
  const during = snap();
  check('main keys: every one of them is in the menu', found.length === labels.length, labels.filter((l) => !found.includes(l)));
  check('main keys: none of them acts while Vanish is in front', JSON.stringify(during) === JSON.stringify(before), { before, during });
  check('main keys: Vanish was not touched by them either', c.vanish.tabs.length === 1 && !!c.vanish.window());
  c.vanish.focused = realFocused;
  // The control: the same items in the main window.
  c.activate(mB.id); await sleep(200);
  press('Cue This Tab'); await sleep(300);
  const cued = (lastState && lastState.cue || []).length;
  press('Bookmark This Page'); press('Developer Tools'); await sleep(300);
  const after1 = snap();
  press('Next Tab'); await sleep(300);
  const movedTab = c.getState().activeId !== mB.id;
  press(`Space: ${otherSpace}`); await sleep(400);
  const movedSpace = c.store.data.space === otherSpace;
  press('TAKE: Put Cued Tab On Air'); await sleep(1200);
  const tookAir = c.getState().live && c.getState().programId === mB.id;
  check('main keys: they still work in the main window (cue, bookmark, developer tools, next tab, space, take)', cued === 1 && after1.marks === before.marks + 1 && after1.devtools === 1 && movedTab && movedSpace && tookAir, { cued, marks: after1.marks - before.marks, devtools: after1.devtools, movedTab, movedSpace, tookAir });
  c.setLive(false); await sleep(800);
  for (const t of [mA, mB]) if (c.byId(t.id)) c.closeTab(t.id);
  await sleep(300);

  // ---- every Vanish key does its job (sent into a Vanish page, as a key press would arrive)
  const vk = c.vanish;
  const active = () => vk.tabs.find((t) => t.id === vk.activeId());
  const vkey = (k, mods = []) => key(active().view.webContents, k, mods);
  const n0 = vk.tabs.length;
  vkey('T', [MOD]); await sleep(500);
  check('vanish key: Cmd+T opens a new tab', vk.tabs.length === n0 + 1);
  vkey('N', [MOD, 'shift']); await sleep(500);
  check('vanish key: Cmd+Shift+N opens a new Vanish tab too', vk.tabs.length === n0 + 2);
  vkey('W', [MOD]); await sleep(400);
  check('vanish key: Cmd+W closes the tab', vk.tabs.length === n0 + 1 && !!vk.window());
  const ids = () => vk.tabs.map((t) => t.id);
  vk.activate(ids()[0]); await sleep(200);
  vkey('Tab', ['control']); await sleep(200);
  const n1 = vk.activeId() === ids()[1];
  vkey('Tab', ['control', 'shift']); await sleep(200);
  const p1 = vk.activeId() === ids()[0];
  vkey(']', [MOD, 'shift']); await sleep(200);
  const n2 = vk.activeId() === ids()[1];
  vkey('[', [MOD, 'shift']); await sleep(200);
  const p2 = vk.activeId() === ids()[0];
  check('vanish key: Ctrl+Tab / Ctrl+Shift+Tab and Cmd+Shift+] / [ go to the next and previous tab', n1 && p1 && n2 && p2, { n1, p1, n2, p2 });
  const v3 = vk.add(`${base}/note?three`); await loaded(v3);
  vk.activate(ids()[0]); await sleep(200);
  vkey('2', [MOD]); await sleep(200);
  const two = vk.activeId() === ids()[1];
  vkey('9', [MOD]); await sleep(200);
  check('vanish key: Cmd+2 goes to the second tab and Cmd+9 to the last', two && vk.activeId() === ids()[ids().length - 1]);
  vkey('Left', [MOD, 'alt']); await sleep(200);
  check('vanish key: Cmd+Alt+Left still moves the tab (unchanged)', ids().indexOf(vk.activeId()) === ids().length - 2);
  // play / pause and mute on a page with a video
  vk.activate(vs.id); await sleep(300);
  const wasPlaying = await playing(vs);
  vkey('K', [MOD, 'shift']); await sleep(500);
  const paused = !(await playing(vs));
  vkey('K', [MOD, 'shift']); await sleep(800);
  check('vanish key: Cmd+Shift+K pauses and plays', wasPlaying && paused && (await playing(vs)), { wasPlaying, paused });
  vkey('A', [MOD, 'shift']); await sleep(400);
  const muted = vs.view.webContents.isAudioMuted();
  const mark = await vk.ui().webContents.executeJavaScript(`!!document.querySelector('.tab.on .hush')`);
  vkey('A', [MOD, 'shift']); await sleep(300);
  check('vanish key: Cmd+Shift+A mutes (the tab shows it) and unmutes', muted && mark && !vs.view.webContents.isAudioMuted(), { muted, mark });
  // find
  vkey('F', [MOD]); await sleep(400);
  const uiw = vk.ui().webContents;
  const open = await uiw.executeJavaScript(`document.body.classList.contains('finding') && document.activeElement.id === 'findText'`);
  await uiw.executeJavaScript(`(() => { const f = document.getElementById('findText'); f.value = 'note'; f.dispatchEvent(new Event('input')); })()`);
  const count = await until(() => uiw.executeJavaScript(`document.getElementById('findCount').textContent`).then((x) => /of 3$/.test(x) && x), 4000);
  await uiw.executeJavaScript(`document.getElementById('findText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); await sleep(300);
  const shut = await uiw.executeJavaScript(`!document.body.classList.contains('finding')`);
  check('vanish key: Cmd+F opens find, it counts the matches, Escape closes it', open && !!count && shut, { open, count, shut });
  // full screen
  const vw = vk.window();
  vkey('F', [MOD, 'alt']); await sleep(500);
  const fullOn = vk.isWinFull() && vw.isSimpleFullScreen();
  const keepsBar = active().view.getBounds().y > 0;
  vkey('Escape'); await sleep(500);
  check('vanish key: Cmd+Alt+F fills the screen (tabs still showing), Escape leaves', fullOn && keepsBar && !vk.isWinFull() && !vw.isSimpleFullScreen(), { fullOn, keepsBar });
  vkey('F', [MOD, 'alt']); await sleep(300); vkey('F', [MOD, 'alt']); await sleep(300);
  check('vanish key: Cmd+Alt+F again leaves full screen', !vw.isSimpleFullScreen());
  // capture and pause-on-blur settings
  c.setSetting('vanishHideFromCapture', false); await sleep(100);
  const shown = !vw.isContentProtected();
  c.setSetting('vanishHideFromCapture', true); await sleep(100);
  check('vanish setting: hide from screen sharing turns off and on in an open window', shown && vw.isContentProtected());
  vw.emit('blur'); await sleep(600);
  const keptOnBlur = await playing(vs);
  c.setSetting('vanishPauseOnBlur', true);
  vw.emit('blur'); await sleep(800);
  check('vanish setting: pause when I switch away (off: keeps playing; on: pauses)', keptOnBlur && !(await playing(vs)), { keptOnBlur });
  c.setSetting('vanishPauseOnBlur', false);

  // ---- screen sharing, location and Cue's own pages stay out of Vanish, and notices stay in it
  const note = () => uiw.executeJavaScript(`(() => { const n = document.getElementById('note'); return n.hidden ? '' : n.textContent; })()`);
  const pickerBefore = events.filter((e) => e[0] === 'share-picker').length;
  const shareErr = await vs.view.webContents.executeJavaScript(`Promise.race([navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'shared', (e) => e.name), new Promise((r) => setTimeout(() => r('no answer in 8s'), 8000))])`, true).catch((e) => String(e));
  const shareNote = await until(note, 3000);
  check('vanish: a page asking to share the screen is refused, said in the Vanish window', shareErr !== 'shared' && /does not share your screen/.test(shareNote || '') && events.filter((e) => e[0] === 'share-picker').length === pickerBefore, { shareErr, shareNote });
  const toastsBefore = events.filter((e) => e[0] === 'toast').length;
  await vs.view.webContents.executeJavaScript(`new Promise((r) => navigator.geolocation.getCurrentPosition(() => r(1), () => r(0), { timeout: 3000 }))`, true).catch(() => 0);
  const locNote = await until(() => note().then((x) => /where you are/.test(x) && x), 4000);
  check('vanish: a blocked location request is said in Vanish, not in the main window', !!locNote && !events.slice(toastsBefore).some((e) => e[0] === 'toast' && /where you are/.test(String(e[1]))), { locNote });
  const vurl = vs.view.webContents.getURL();
  vk.command('navigate', { text: 'cue://library' }); await sleep(800);
  const typed = vs.view.webContents.getURL();
  const typedNote = await note();
  await vs.view.webContents.executeJavaScript(`location.href = 'cue://bills'; 1`, true).catch(() => {}); await sleep(800);
  const linked = vs.view.webContents.getURL();
  const ves = c.sessionFor('vanish');
  const lib403 = await ves.fetch('cue://library').then((r) => r.status).catch((e) => String(e));
  const danger200 = await ves.fetch('cue://danger').then((r) => r.status).catch((e) => String(e));
  check('vanish: typing a cue:// address is refused, with a line saying so', typed === vurl && /own pages/.test(typedNote), { typed, typedNote });
  check('vanish: a page sending you to cue:// is refused', linked === vurl, linked);
  check('vanish: Cue\'s pages are not served in Vanish (control: the danger warning still is)', lib403 === 403 && danger200 === 200, { lib403, danger200 });
  // "Open it anyway" from a Vanish tab is remembered in Vanish only, and forgotten with it.
  // it is only honoured from the warning page itself, so the tab is on the warning first (Cue loads it, as it does for real)
  await vs.view.webContents.loadURL('cue://danger?site=' + encodeURIComponent('https://risky.example.test/')).catch(() => {}); await sleep(300);
  await c.internal['shield.proceed']({ site: 'https://risky.example.test/' }, null, vs.view.webContents); await sleep(300);
  const remembered = c.vanishMemory().dangerOk.includes('risky.example.test');

  // ---- forget everything: Cmd+Shift+W closes Vanish and empties its jar
  const ck = vk.add(`${base}/cookie`); await loaded(ck); await sleep(300);
  const jar = async () => (await ves.cookies.get({ name: 'vanishcrumb' })).length;
  const had = await jar();
  key(ck.view.webContents, 'W', [MOD, 'shift']);
  await until(() => !vk.window(), 5000);
  await until(() => !vk.wiping(), 8000);
  const left = await jar();
  check('vanish key: Cmd+Shift+W closes Vanish and forgets everything (cookie there before, gone after)', had === 1 && !vk.window() && vk.tabs.length === 0 && left === 0, { had, left });
  check('vanish: its "open it anyway" memory goes with it', remembered && c.vanishMemory().dangerOk.length === 0, { remembered, after: c.vanishMemory() });

  // ---- "Open Vanish in full screen"
  c.setSetting('vanishFullScreen', true);
  const vf = c.openTab({ url: `${base}/note?vf`, identity: 'vanish' }); await loaded(vf); await sleep(400);
  check('vanish setting: opens in full screen', vk.window().isSimpleFullScreen() && vk.isWinFull());
  c.setSetting('vanishFullScreen', false);
  vk.closeTab(vf.id); await until(() => !vk.window(), 4000); await until(() => !vk.wiping(), 8000);

  // ---- one table: the menu, Settings and the start page all say what the key handler does
  const now = Menu.getApplicationMenu(); // the menu is rebuilt when the folder or Space changes
  const sub = findItem(now, (it) => it.label === 'Vanish' && !!it.submenu);
  const shownKeys = vanishKeys.shown();
  const menuLabels = sub && sub.submenu ? sub.submenu.items.map((i) => i.label) : [];
  check('menu: Window > Vanish lists every shortcut from the table', shownKeys.filter((k) => k.id !== 'leave').every((k) => menuLabels.includes(`${k.label}   ${k.keys}`)), menuLabels);
  const winMenu = findItem(now, (it) => it.label === 'Window' && !!it.submenu);
  check('menu: the Vanish list sits in the Window menu', !!winMenu && winMenu.submenu.items.includes(sub));
  await uwc.executeJavaScript(`openSettings('vanish')`, true); await sleep(500);
  const listed = await uwc.executeJavaScript(`[...document.querySelectorAll('.vkeys > *')].map((e) => e.textContent)`);
  const rows = await uwc.executeJavaScript(`[...document.querySelectorAll('.spane label')].map((e) => e.textContent)`);
  await uwc.executeJavaScript(`closeModal()`, true);
  const pairs = []; for (let i = 0; i < listed.length; i += 2) pairs.push(`${listed[i]}|${listed[i + 1]}`);
  check('settings: the Vanish room lists the same shortcuts', shownKeys.every((k) => pairs.includes(`${k.keys}|${k.label}`)) && pairs.length === shownKeys.length, pairs);
  check('settings: the Vanish room has its six settings', ['Only one video plays at a time in Vanish', 'When a link opens a new Vanish tab', 'New Vanish tabs open', 'Pause Vanish when I switch to another window', 'Hide Vanish from screen sharing and recordings', 'Open Vanish in full screen'].every((l) => rows.includes(l)), rows);
  await uwc.executeJavaScript(`openSettings('tabs')`, true); await sleep(400);
  const mainRows = await uwc.executeJavaScript(`[...document.querySelectorAll('.spane label')].map((e) => e.textContent)`);
  const mainNote = await uwc.executeJavaScript(`[...document.querySelectorAll('.spane .note')].map((e) => e.textContent).find((x) => /other browsers behave/.test(x)) || ''`);
  await uwc.executeJavaScript(`closeModal()`, true);
  check('settings: the main setting reads "Only one video plays at a time" and says it is this window only', mainRows.includes('Only one video plays at a time') && /main window only/.test(mainNote), mainNote);
  const start = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'vanish-start.html'), 'utf8');
  const hint = (attr) => (start.match(new RegExp(`data-${attr}="([^"]+)"`)) || [])[1] || '';
  const hintKeys = (txt) => txt.split(' · ').map((x) => x.split(' ')[0]);
  const macKeys = vanishKeys.shown(true).map((k) => k.keys); const pcKeys = vanishKeys.shown(false).map((k) => k.keys);
  check('start page: its four shortcuts are the table\'s, on a Mac and elsewhere', hintKeys(hint('mac')).length === 4 && hintKeys(hint('mac')).every((k) => macKeys.includes(k)) && hintKeys(hint('pc')).every((k) => pcKeys.includes(k)), [hintKeys(hint('mac')), hintKeys(hint('pc'))]);
  check('table: every key is spoken for once (no two jobs share a key)', [true, false].every((mac) => { const all = vanishKeys.VANISH_KEYS.flatMap((r) => vanishKeys.allKeys(r, mac)); return new Set(all).size === all.length; }));
  {
    const kd = (o) => ({ type: 'keyDown', ...o }); const id = (o, mac) => (vanishKeys.match(kd(o), mac) || {}).id;
    check('vanish key: full screen also answers F11 off a Mac and Ctrl+Cmd+F on a Mac, and only there',
      id({ key: 'F11', code: 'F11' }, false) === 'full' && id({ key: 'f', code: 'KeyF', meta: true, control: true }, true) === 'full'
      && !id({ key: 'F11', code: 'F11' }, true) && id({ key: 'f', code: 'KeyF', meta: true }, true) === 'find' && id({ key: 'f', code: 'KeyF', control: true }, false) === 'find');
    check('vanish key: the shown full-screen key is still the first one', vanishKeys.shown(true).find((k) => k.id === 'full').keys === '⌥⌘F' && vanishKeys.shown(false).find((k) => k.id === 'full').keys === 'Ctrl+Alt+F');
  }

  // ---- control: a failing check must be visible
  fs.writeFileSync(path.join(OUT, 'vanish-settings.json'), JSON.stringify(results, null, 2));
  const fails = results.filter((x) => !x.ok);
  console.log(`[cue-vanish] DONE ${results.length - fails.length}/${results.length} passed`);
  srv.close();
  if (!process.env.CUE_KEEP) c.app.quit();
};
