// Settings that fit, Spaces for anyone, and the two tiers of tabs.
//
//   CUE_QUIET=1 CUE_AGENT_PORT=18841 CUE_TEST=settings-tabs CUE_PHASE=1 CUE_USER_DATA=<new dir> CUE_OUT=<new dir> npx electron .
//   CUE_QUIET=1 CUE_AGENT_PORT=18841 CUE_TEST=settings-tabs CUE_PHASE=2 CUE_USER_DATA=<same dir> CUE_OUT=<same out> npx electron .
//   node test/settings-tabs.js seed <another new dir>      # an existing 0.6 profile, then:
//   CUE_QUIET=1 CUE_AGENT_PORT=18841 CUE_TEST=settings-tabs CUE_PHASE=seeded CUE_USER_DATA=<that dir> CUE_OUT=<dir> npx electron .
//
// Phase 1 (a fresh profile): the Settings dialog's size and its one scroller, how much of each
// room fits at 1040x760 (with a picture of every room in CUE_OUT), the number keys' geometry, the
// search box, actions that answer inside Settings, Spaces renamed/recoloured/reordered/removed
// through the Settings page itself, Cmd+K listing the real Spaces, ordinary tabs surviving 30 idle
// days, "Just for now" tabs (per folder, Keep, pin, drag, Clear, the clock, closed-tab stack, never
// in cue.json), a split left open. Phase 2 (after a restart): what had to come back did, and what
// had to go did. Phase "seeded": a profile saved by 0.6 (Spaces as a list of names, archiveDays 7)
// is moved over once, with every Space keeping the colour it had. Local pages only.
const fs = require('fs');
const path = require('path');

const PHASE = process.env.CUE_PHASE || '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[cue-settings] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(80); } return null; };
const page = (n) => `data:text/html,<title>${encodeURIComponent(n)}</title><p>${encodeURIComponent(n)}</p>`;
// Rooms that may scroll: lists as long as the person's own passwords and extensions.
const MAY_SCROLL = new Set(['pw', 'ext']);
// What the old Settings measured at the same window size (pane scrollHeight / clientHeight), read
// on the base commit before this work. "keep" did not exist; its rows were in "tabs".
const BEFORE = { tabs: [909, 558], vanish: [686, 558], notes: [426, 426], keys: [471, 471], folders: [800, 558], spaces: [426, 426], look: [426, 426], shield: [426, 426], pw: [426, 426], ext: [935, 558], live: [426, 426], ai: [426, 426], disk: [426, 426] };

// node test/settings-tabs.js seed <dir>: write a cue.json the way 0.6 saved it.
if (require.main === module) {
  const [, , what, dir] = process.argv;
  if (what !== 'seed' || !dir) { console.log('usage: node test/settings-tabs.js seed <new user-data dir>'); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const tab = (uid, extra = {}) => ({ uid, url: page(uid), title: uid, name: null, favicon: null, identity: 'personal', pinned: false, groupOverride: null, volume: 1, muted: false, private: false, obsScene: '', order: now, zoom: 0, aiAllowed: false, space: 'Teach', lastActive: now - 20 * 86400000, agent: false, ...extra });
  fs.writeFileSync(path.join(dir, 'cue.json'), JSON.stringify({
    spaces: ['Teach', 'Create', 'Finance', 'Build', 'Church'], space: 'Create', folder: 'personal',
    tabs: [tab('old-teach'), tab('old-create', { space: 'Create', lastActive: now }), tab('old-church', { space: 'Church' })],
    settings: { archiveDays: 7, openOn: 'last', spaceLogins: { Teach: 'school', Create: 'personal' } },
    migrated: { 'onePlayer-off-0.7': true }, financeNamed: true, tidyDefaults: true, quietDefaults: true, stripDefaults: true, groupsRepaired: true,
  }, null, 2));
  console.log(`seeded ${dir}`);
  process.exit(0);
}

module.exports = async function run(c) {
  fs.mkdirSync(OUT, { recursive: true });
  // Four Spaces and the Teacher kit on a first phase, so Spaces and Live class have something to show.
  if (PHASE === '1') { c.store.data.spaces = ['Teach', 'Create', 'Finance', 'Build']; c.store.data.space = 'Teach'; for (const t of c.tabs) t.space = 'Teach'; c.setSetting('kit.teacher', true); c.sendState(); await sleep(300); }
  const ui = () => c.ui().webContents;
  const js = (code) => ui().executeJavaScript(code, true);
  const S = () => c.lastState();
  const s = () => c.store.data.settings;
  const file = path.join(c.app.getPath('userData'), 'cue.json');
  const saved = () => { c.persist(); c.store.flush(); return JSON.parse(fs.readFileSync(file, 'utf8')); };
  const wantFile = path.join(c.app.getPath('userData'), 'want-settings.json');
  // Tests run at zero opacity, which cannot be photographed: park the window off every screen,
  // turn it up for the picture, and put it back.
  const shot = async (name) => {
    const w = c.win(); const was = w.getBounds();
    w.setBounds({ ...was, x: -9000, y: 0 }); w.setOpacity(1);
    await sleep(450);
    let img = null;
    try { img = await ui().capturePage(); } catch (e) { console.log(`[cue-settings] shot ${name} failed: ${e.message}`); }
    w.setOpacity(0); w.setBounds({ ...was, x: -9000, y: 0 });
    if (img) fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    return !!img;
  };
  const size = async (w, h) => { c.win().setContentSize(w, h); await sleep(500); };
  await sleep(1500);
  await size(1280, 900); // the dialog is min(1040px, 94vw) x min(760px, 88vh): 1040 x 760 here
  const finish = () => {
    fs.writeFileSync(path.join(OUT, `settings-tabs-${PHASE}.json`), JSON.stringify(results, null, 2));
    const fails = results.filter((x) => !x.ok);
    console.log(`[cue-settings] DONE phase ${PHASE}: ${results.length - fails.length}/${results.length} passed`);
  };

  if (PHASE === 'seeded') {
    const list = c.spaceList();
    check('seeded: the saved list of names became { name, tint } once, in the same order', JSON.stringify(c.store.data.spaces) === JSON.stringify(list) && list.map((x) => x.name).join() === 'Teach,Create,Finance,Build,Church', c.store.data.spaces);
    check('seeded: every Space keeps the colour it already wore (Teach and Finance rose, Create indigo, Build green); a new name takes the next swatch', list.map((x) => x.tint).join() === 'rose,indigo,rose,green,blue', list);
    check('seeded: a saved "put away after 7 days" becomes "never", once', s().archiveDays === 0 && c.store.data.migrated['archive-off-0.7'] === true, { archiveDays: s().archiveDays, migrated: c.store.data.migrated });
    check('seeded: a tab idle for 20 days is still there (nothing put away at start-up)', !!c.tabs.find((t) => t.uid === 'old-teach') && !!c.tabs.find((t) => t.uid === 'old-church'));
    await sleep(500);
    c.switchSpace('Create'); await sleep(400);
    check('seeded: the sidebar wears the colour Create always had (indigo)', await js(`document.body.dataset.tint`) === 'indigo');
    const tone = () => js(`getComputedStyle(document.body).getPropertyValue('--tone').trim()`);
    c.switchSpace('Church'); await sleep(400);
    const church = { tint: await js(`document.body.dataset.tint`), tone: await tone() };
    c.switchSpace('Teach'); await sleep(400);
    const teach = await tone();
    check('seeded: a Space with a name nobody planned for has a colour of its own', church.tint === 'blue' && church.tone !== teach, { church, teach });
    finish(); c.app.quit(); return;
  }

  if (PHASE === '2') {
    const want = JSON.parse(fs.readFileSync(wantFile, 'utf8'));
    check('restart: Spaces came back renamed, recoloured, reordered and without the removed one', JSON.stringify(c.spaceList()) === JSON.stringify(want.spaces), { now: c.spaceList(), want: want.spaces });
    check('restart: the tab of the removed Space is in the first Space', (c.tabs.find((t) => t.uid === want.movedUid) || {}).space === want.spaces[0].name);
    check('restart: ordinary tabs are all back (kept until closed)', want.kept.every((u) => c.tabs.some((t) => t.uid === u)), { missing: want.kept.filter((u) => !c.tabs.some((t) => t.uid === u)) });
    check('restart: "Just for now" tabs are gone, in both folders', want.temp.every((u) => !c.tabs.some((t) => t.uid === u)), { left: c.tabs.filter((t) => t.temp).map((t) => t.uid) });
    check('restart: and Reopen Closed Tab has nothing of theirs to bring back', !c.closedStack.some((x) => x.temp) && !c.reopenClosed('personal'));
    const sp = c.getState().split;
    const ids = (sp.ids || []).map((id) => (c.byId(id) || {}).uid).sort().join();
    check('restart: the split you were in came back, though the app Cue opens on is not in it', sp.mode === 'cols2' && ids === want.split.slice().sort().join(), { mode: sp.mode, ids, want: want.split });
    check('restart: the one-time "put away: never" change did not run again (7 stayed 7)', s().archiveDays === 7, s().archiveDays);
    check('restart: the sidebar wears the stored tint of the Space it opened in', await js(`document.body.dataset.tint`) === (c.spaceList().find((x) => x.name === c.store.data.space) || {}).tint);
    c.setSetting('archiveDays', 0);
    finish(); c.app.quit(); return;
  }

  // ======================================================== phase 1
  // ---- defaults and the one-time change
  check('defaults: ordinary tabs are never put away, and "Just for now" clears when Cue closes', s().archiveDays === 0 && s().tempClear === 'quit' && s().linksJustForNow === false, { archiveDays: s().archiveDays, tempClear: s().tempClear });
  {
    const had = { ...c.store.data.migrated };
    delete c.store.data.migrated['archive-off-0.7']; s().archiveDays = 2;
    c.runMigrations(); const flipped = s().archiveDays === 0;
    c.setSetting('archiveDays', 7); c.runMigrations();
    check('migration: "archive-off-0.7" sets put-away to never once, and not again after it is changed', flipped && s().archiveDays === 7 && c.store.data.migrated['archive-off-0.7'] === true);
    c.store.data.migrated = { ...had, 'archive-off-0.7': true }; c.setSetting('archiveDays', 0);
  }
  check('shortcut: File > New Tab Just for Now is Cmd/Ctrl+Alt+T and nothing else in the menu uses it', (() => {
    const { Menu } = require('electron'); const all = [];
    const walk = (m) => m.items.forEach((it) => { if (it.accelerator) all.push([it.label, it.accelerator]); if (it.submenu) walk(it.submenu); });
    walk(Menu.getApplicationMenu());
    const mine = all.filter(([, a]) => a === 'CmdOrCtrl+Alt+T');
    return mine.length === 1 && mine[0][0] === 'New Tab Just for Now';
  })());

  // A second person, for the per-folder checks.
  const other = c.addFolder({ name: 'Robin', color: '#2E8B57' });
  const robin = other.folder.id;
  c.setFolder('personal'); await sleep(300);

  // ---- Settings: the dialog, its one scroller, every room
  await js(`openSettings('tabs')`); await sleep(500);
  const box = await js(`(() => { const sh = document.querySelector('.sheet.settings'); const r = sh.getBoundingClientRect(); const m = document.getElementById('modal');
    const scrollers = [...sh.querySelectorAll('*'), sh, m].filter((e) => e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).map((e) => e.className);
    return { w: Math.round(r.width), h: Math.round(r.height), sheetOverflow: getComputedStyle(sh).overflowY, navScroll: [document.querySelector('.snav').scrollHeight, document.querySelector('.snav').clientHeight], scrollers }; })()`);
  check('settings: the dialog is 1040 x 760 in a 1280 x 900 window', Math.abs(box.w - 1040) <= 1 && Math.abs(box.h - 760) <= 1, box);
  check('settings: the dialog itself never scrolls and the room list stays put', box.sheetOverflow === 'hidden' && box.navScroll[0] <= box.navScroll[1], box);
  const rooms = await js(`settingsRooms().map((r) => r.id)`);
  const fit = {};
  const words = {};
  for (const id of rooms) {
    await js(`closeModal(); openSettings('${id}')`); await sleep(id === 'folders' || id === 'ext' || id === 'pw' ? 1300 : 650);
    const m = await js(`(() => { const p = document.querySelector('.spane'); const sh = document.querySelector('.sheet.settings');
      const scrollers = [...sh.querySelectorAll('*')].filter((e) => e !== p && e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).map((e) => e.className);
      const over = [...p.querySelectorAll('*')].filter((e) => e.offsetParent && e.getBoundingClientRect().right > p.getBoundingClientRect().right + 1).map((e) => e.tagName + '.' + e.className).slice(0, 4);
      const pr = p.getBoundingClientRect(); const used = Math.round(Math.max(0, ...[...p.children].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().bottom)) - pr.top + p.scrollTop);
      return { used, sh: p.scrollHeight, ch: p.clientHeight, sw: p.scrollWidth, cw: p.clientWidth, scrollers, over, line: document.querySelector('.intro span').textContent }; })()`);
    fit[id] = m;
    words[id] = m.line.split(/\s+/).filter(Boolean).length;
    await shot(`room-${id}`);
  }
  for (const id of rooms) {
    const m = fit[id];
    if (!MAY_SCROLL.has(id)) check(`settings: "${id}" fits on one screen at 1040 x 760 (scrollHeight <= clientHeight)`, m.sh <= m.ch, { scrollHeight: m.sh, clientHeight: m.ch, before: BEFORE[id] || 'new room' });
    check(`settings: "${id}" has one scroller, nothing wider than the room`, !m.scrollers.length && m.sw <= m.cw && !m.over.length, { scrollers: m.scrollers, sw: m.sw, cw: m.cw, over: m.over });
  }
  check('settings: every room opens with one sentence of at most 14 words', Object.values(words).every((n) => n <= 14), words);
  const table = rooms.map((id) => `${id}: before ${BEFORE[id] ? BEFORE[id].join('/') : '-'}  after ${fit[id].sh}/${fit[id].ch} (content ${fit[id].used}px)`);
  console.log(`[cue-settings] fit (pane scrollHeight/clientHeight)\n  ${table.join('\n  ')}`);
  fs.writeFileSync(path.join(OUT, 'fit.json'), JSON.stringify({ before: BEFORE, after: Object.fromEntries(rooms.map((id) => [id, [fit[id].sh, fit[id].ch, fit[id].used]])) }, null, 2));

  // ---- the number keys: a real grid
  await js(`closeModal(); openSettings('keys')`); await sleep(500);
  const keys = await js(`(() => { const sh = document.querySelector('.sheet.settings').getBoundingClientRect(); const p = document.querySelector('.spane').getBoundingClientRect();
    return [...document.querySelectorAll('.krow.unit')].map((r) => { const k = r.querySelector('.kkey'); const ins = r.querySelectorAll('input'); const kr = k.getBoundingClientRect(); const a = ins[1].getBoundingClientRect(); const n = ins[0].getBoundingClientRect();
      return { key: k.textContent, keyLines: Math.round(kr.height / parseFloat(getComputedStyle(k).lineHeight || 16)), keyH: Math.round(kr.height), addrW: Math.round(a.width), rowTop: Math.round(n.top), sameLine: Math.abs(n.top - a.top) < 2 && Math.abs(kr.top + kr.height / 2 - (a.top + a.height / 2)) < 6,
        inside: a.right <= p.right + 0.5 && a.right <= sh.right && kr.left >= p.left - 0.5 }; }); })()`);
  check('number keys: nine rows, one per key', keys.length === 9, keys.length);
  check('number keys: the key name is on one line', keys.every((k) => k.keyH <= 22), keys.map((k) => k.keyH));
  check('number keys: name and address sit on the same row as their key', keys.every((k) => k.sameLine));
  check('number keys: the address box is at least 300px wide', keys.every((k) => k.addrW >= 300), keys.map((k) => k.addrW));
  check('number keys: nothing runs past the dialog', keys.every((k) => k.inside));
  const picker = await js(`[...document.querySelectorAll('.spane select')][0] ? [...document.querySelectorAll('.spane select')][0].options.length : 0`);
  check('number keys: the folder picker lists the real folders (two here)', picker === 2, picker);

  // ---- search
  await js(`closeModal(); openSettings('tabs')`); await sleep(300);
  const search = async (q) => { await js(`(() => { const i = document.querySelector('.ssearch'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`); await sleep(350);
    return js(`({ rooms: [...document.querySelectorAll('.sresult')].map((x) => x.dataset.room), nav: [...document.querySelectorAll('.snav button:not(.miss)')].map((b) => b.dataset.id),
      shown: [...document.querySelectorAll('.sresult .unit')].filter((u) => !u.hidden && u.offsetParent).map((u) => (u.querySelector('label') || u).textContent.trim().slice(0, 60)),
      empty: (document.querySelector('.spane > .hint') || {}).textContent || '' })`); };
  let r = await search('one video');
  check('search: "one video" finds the setting in Tabs and sound and in Vanish, and nothing else', r.rooms.join() === 'tabs,vanish' && r.nav.join() === 'tabs,vanish' && r.shown.includes('Only one video plays at a time') && r.shown.includes('Only one video plays at a time in Vanish') && r.shown.length <= 3, r);
  r = await search('obs port');
  const portShown = await js(`(() => { const u = [...document.querySelectorAll('.sresult .unit')].find((x) => /port/.test(x.textContent)); return !!u && !!u.offsetParent && !!u.closest('details').open; })()`);
  check('search: "obs port" finds the OBS connection number under Advanced and opens it', r.rooms.join() === 'live' && portShown, r);
  r = await search('just for now');
  check('search: "just for now" finds the Keeping tabs room', r.rooms.includes('keep'), r);
  r = await search('zzqx');
  check('search: words that are nowhere say so (control)', !r.rooms.length && /Nothing in Settings matches/.test(r.empty), r);
  await search('');
  check('search: emptying the box goes back to the room', await js(`!!document.querySelector('.snav button.on') && !document.querySelector('.sresult')`));

  // ---- actions answer inside Settings
  await js(`closeModal(); openSettings('tabs')`); await sleep(300);
  await js(`[...document.querySelectorAll('.spane .btn')].find((b) => /Merge duplicate/.test(b.textContent)).click()`); await sleep(500);
  const merged = await js(`({ open: !document.getElementById('modal').hidden, said: [...document.querySelectorAll('.spane .said')].map((x) => x.textContent).join(' ') })`);
  check('settings: "Merge duplicate tabs" answers on its row and Settings stays open', merged.open && /duplicate|tidy|one of each/i.test(merged.said), merged);
  const helpWorks = await js(`(() => { const b = document.querySelector('.spane .qhelp'); const n = b.closest('.srow, .tg, .intro').parentElement.querySelector('.note.help'); const before = n.hidden; b.click(); const after = n.hidden; b.click(); return before && !after && n.hidden; })()`);
  check('settings: a "?" opens its words in place and closes them again', helpWorks);

  // ---- Spaces, through the Settings page itself
  const build = c.openTab({ url: page('in Build'), identity: 'personal' }); build.space = 'Build';
  await sleep(200);
  await js(`closeModal(); openSettings('spaces')`); await sleep(400);
  const spaceUi = (code) => js(`(async () => { ${code} })()`);
  await spaceUi(`const i = document.querySelector('.sprow[data-space="Create"] input.spname'); i.value = 'Studio'; i.dispatchEvent(new Event('change'));`); await sleep(400);
  await spaceUi(`document.querySelector('.sprow[data-space="Studio"] .sw[data-tint="plum"]').click();`); await sleep(400);
  await spaceUi(`document.querySelector('.sprow[data-space="Teach"] .mini2:nth-child(2)').click();`); await sleep(400); // Teach down one
  const rm = () => spaceUi(`[...document.querySelectorAll('.sprow[data-space="Build"] .btn.danger')][0].click();`);
  await rm(); await sleep(200);
  const asked = await js(`(() => { const b = document.querySelector('.sprow[data-space="Build"] .btn.danger'); return b ? b.textContent : ''; })()`);
  check('spaces: removing asks first, in place (no dialog box)', /Remove\? Tabs go to/.test(asked) && c.spaceList().some((x) => x.name === 'Build'), asked);
  await rm(); await sleep(500);
  const after = c.spaceList();
  const spSaid = await js(`(document.querySelector('.spsaid .said') || {}).textContent || ''`);
  check('spaces: rename, colour and order are saved as { name, tint }', after.map((x) => `${x.name}:${x.tint}`).join() === 'Studio:plum,Teach:rose,Finance:rose', after);
  check('spaces: the removed Space\'s tab moved to the first Space, said on the page, Settings still open', build.space === 'Studio' && /moved to Studio/.test(spSaid) && !(await js(`document.getElementById('modal').hidden`)), { space: build.space, spSaid });
  const nameCount = await js(`document.querySelectorAll('.sprow[data-space]').length`);
  check('spaces: the page redraws from the real list', nameCount === 3, nameCount);
  await spaceUi(`const i = document.querySelector('.spadd input'); i.value = 'Admin'; document.querySelector('.spadd .btn').click();`); await sleep(500);
  check('spaces: adding one gives it a swatch nobody else is wearing', (() => { const a = c.spaceList().find((x) => x.name === 'Admin'); return a && !after.some((x) => x.tint === a.tint); })(), c.spaceList());
  c.switchSpace('Studio'); await sleep(400);
  const tint = await js(`({ tint: document.body.dataset.tint, tone: getComputedStyle(document.body).getPropertyValue('--tone').trim() })`);
  check('spaces: the sidebar colour comes from the stored tint, not the name (Studio wears plum)', tint.tint === 'plum' && /7A2C7E|E2A5E8/i.test(tint.tone), tint);
  await js(`closeModal()`); await sleep(100);
  await js(`openPalette()`); await sleep(200);
  await js(`(() => { const i = document.querySelector('.cmdk input'); i.value = 'Space:'; i.dispatchEvent(new Event('input')); })()`); await sleep(400);
  const pal = await js(`[...document.querySelectorAll('.cmdlist .sg .v')].map((x) => x.textContent).filter((x) => /^Space: /.test(x))`);
  check('find anything: lists the real Spaces, and no "Business"', pal.join() === c.spaceList().map((x) => `Space: ${x.name}`).join(), pal);
  await js(`closeModal()`);
  c.switchSpace(c.spaceList()[0].name); await sleep(300);

  // ---- tier 1: kept tabs survive 30 idle days
  const k1 = c.openTab({ url: page('kept one'), identity: 'personal' });
  const k2 = c.openTab({ url: page('kept two'), identity: 'personal' });
  const k3 = c.openTab({ url: page('kept in Robin'), identity: robin, background: true });
  await sleep(300);
  for (const t of [k1, k2, k3]) t.lastActive = Date.now() - 31 * 86400000;
  c.activate(build.id); await sleep(100);
  for (const t of [k1, k2, k3]) t.lastActive = Date.now() - 31 * 86400000;
  c.archiveOldTabs();
  check('kept: with "put away" at never, tabs idle for 31 days are all still open', [k1, k2, k3].every((t) => c.byId(t.id)));
  {
    for (const t of [k1, k2, k3]) t.lastActive = Date.now(); // only the control tab is old now
    const old = c.openTab({ url: page('control old'), identity: 'personal', background: true }); await sleep(100);
    old.lastActive = Date.now() - 31 * 86400000;
    c.setSetting('archiveDays', 30); c.archiveOldTabs(); c.setSetting('archiveDays', 0);
    check('kept: control - set to 30 days, the same kind of tab is put away into Library > Archived', !c.byId(old.id) && c.store.data.archived.some((a) => a.title === 'control old' || /control/.test(a.url)));
  }

  // ---- tier 2: "Just for now"
  const sec = () => js(`({ n: document.querySelectorAll('.tempsec .tab').length, ids: [...document.querySelectorAll('.tempsec .tab')].map((x) => Number(x.dataset.id)), sub: (document.querySelector('.tempsec .tsub') || {}).textContent || '',
    groupIds: [...document.querySelectorAll('.group .tab')].map((x) => Number(x.dataset.id)) })`);
  const t1 = c.openTab({ url: page('temp mine'), identity: 'personal', temp: true });
  const t2 = c.openTab({ url: page('temp robin'), identity: robin, temp: true, background: true });
  await sleep(400);
  let v = await sec();
  check('temp: a "Just for now" tab sits in its own section, not with the kept tabs', t1.temp && v.ids.includes(t1.id) && !v.groupIds.includes(t1.id) && /cleared when Cue closes/.test(v.sub), v);
  check('temp: each folder has its own section (Robin\'s tab is not in mine)', !v.ids.includes(t2.id) && !(S().tabs || []).some((x) => x.id === t2.id));
  c.setFolder(robin); await sleep(400);
  v = await sec();
  check('temp: and Robin\'s section has Robin\'s tab only', v.ids.includes(t2.id) && !v.ids.includes(t1.id), v);
  c.setFolder('personal'); await sleep(300);
  check('temp: it uses the folder\'s own sign-ins (same session as a kept tab; this is not Vanish)', !!t1.view && t1.view.webContents.session === c.sessionFor('personal') && t1.view.webContents.session !== c.sessionFor('vanish'));
  let disk = saved();
  check('temp: never written to cue.json, so neither a quit nor a crash can bring it back', !disk.tabs.some((x) => x.uid === t1.uid || x.uid === t2.uid) && disk.tabs.some((x) => x.uid === k1.uid), disk.tabs.map((x) => x.uid).length);
  const child = c.openTab({ url: page('opened from temp'), identity: 'personal', after: t1 });
  check('temp: a link opened from a "Just for now" tab is just for now too', !!child.temp);
  const plain = c.openTab({ url: page('plain new'), identity: 'personal', after: k1 });
  check('temp: control - a tab opened from a kept tab is kept', !plain.temp);

  // Keep, from the right-click menu
  const items = c.tabMenuItems(child);
  const keepIt = items.find((x) => x.label === 'Keep this tab');
  check('temp: right-click offers "Keep this tab" on a just-for-now tab, and "Just for now" on a kept one', !!keepIt && c.tabMenuItems(plain).some((x) => x.label === 'Just for now'));
  if (keepIt) keepIt.click();
  await sleep(200);
  check('temp: "Keep this tab" makes it an ordinary tab, saved like one', !child.temp && saved().tabs.some((x) => x.uid === child.uid));
  // Pinning keeps it too
  const pinMe = c.openTab({ url: page('pin me'), identity: 'personal', temp: true }); await sleep(100);
  c.command('pin', { id: pinMe.id, on: true }); await sleep(100);
  check('temp: pinning a just-for-now tab keeps it', pinMe.pinned && !pinMe.temp);
  c.command('pin', { id: pinMe.id, on: false });
  // Dragging between the sections
  await sleep(300);
  const drag = (fromId, target) => js(`(() => { const dt = new DataTransfer(); dt.setData('text/cue-tab', '${fromId}'); const el = ${target}; if (!el) return false; el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
  await drag(plain.id, `document.querySelector('.tempsec')`); await sleep(400);
  const toTemp = !!plain.temp;
  await drag(plain.id, `document.querySelector('.group .ghead')`); await sleep(400);
  check('temp: dragging a tab onto the section makes it just for now, and onto a group keeps it', toTemp && !plain.temp, { toTemp, now: plain.temp });
  // A strip app is never put in "Just for now", and is not auto-pinned when opened there.
  const ses = c.sessionFor('personal');
  await ses.setProxy({ proxyRules: 'http://127.0.0.1:9' }); // nothing leaves the machine
  const wa = c.openTab({ url: 'https://web.whatsapp.com/', identity: 'personal', temp: true, background: true }); await sleep(300);
  check('temp: a strip app opened just for now is not auto-pinned', wa.temp && !wa.pinned, { temp: wa.temp, pinned: wa.pinned });
  c.closeTab(wa.id);
  await ses.setProxy({ mode: 'direct' });

  // Closed-tab stack: a closed temp tab can come back until the section is cleared, never after.
  const t3 = c.openTab({ url: page('temp closed'), identity: 'personal', temp: true }); await sleep(150);
  c.closeTab(t3.id);
  check('temp: closing one by hand puts it on the closed-tab stack like any tab', c.closedStack.some((x) => x.uid === t3.uid));
  const t4 = c.openTab({ url: page('temp four'), identity: 'personal', temp: true }); await sleep(300);
  await js(`document.querySelector('.tempsec .tclear').click()`); await sleep(500);
  check('temp: Clear closes the section\'s tabs, without archiving them', !c.byId(t4.id) && !c.byId(t1.id) && !c.store.data.archived.some((a) => /temp/.test(a.url)));
  check('temp: and after a clear, Reopen Closed Tab brings none of them back', !c.closedStack.some((x) => x.temp && x.identity === 'personal') && !(c.reopenClosed('personal') || {}).temp);
  check('temp: Clear in my folder left Robin\'s alone', !!c.byId(t2.id));

  // The clock: with "after 1 hour", the one-minute sweep clears what is past the hour.
  c.setSetting('tempClear', 1);
  const old1 = c.openTab({ url: page('temp old'), identity: 'personal', temp: true }); const new1 = c.openTab({ url: page('temp new'), identity: 'personal', temp: true });
  c.activate(k1.id); await sleep(300);
  old1.tempAt = Date.now() - 2 * 3600000;
  check('temp: with hours, they are saved (so a restart keeps them until their time)', saved().tabs.some((x) => x.uid === new1.uid && x.temp));
  v = await sec();
  check('temp: the section says when they go', /after 1 hour/.test(v.sub), v.sub);
  const n1 = c.sweepTemp(Date.now());
  check('temp: the sweep clears one past the hour and keeps a new one', n1 === 1 && !c.byId(old1.id) && !!c.byId(new1.id), n1);
  const n2 = c.sweepTemp(Date.now() + 2 * 3600000);
  check('temp: moving the clock on two hours, the new one goes too, not archived, not reopenable', !c.byId(new1.id) && !c.closedStack.some((x) => x.uid === new1.uid) && !c.store.data.archived.some((a) => /temp%20new|temp new/.test(a.url)), n2);
  c.setSetting('tempClear', 'quit');
  check('temp: back to "when Cue closes", nothing temporary is left in cue.json', !saved().tabs.some((x) => x.temp));

  // Links from other apps, when switched on.
  c.setSetting('linksJustForNow', true);
  const link = c.openFromApp(page('from another app')); await sleep(100);
  c.setSetting('linksJustForNow', false);
  const link2 = c.openFromApp(page('from another app, off')); await sleep(100);
  check('temp: "links from other apps start in Just for now" works, and is off by default', link.temp && !link2.temp);
  c.closeTab(link.id); c.closeTab(link2.id);

  // ---- leave things for the restart: two temp tabs, a split, the app Cue opens on outside it
  const q1 = c.openTab({ url: page('temp for restart'), identity: 'personal', temp: true });
  const q2 = c.openTab({ url: page('temp for restart robin'), identity: robin, temp: true, background: true });
  await sleep(200);
  c.setSetting('openOn', 'home'); c.setSetting('homeApp', 'http://localhost:9/');
  const home = c.openTab({ url: 'http://localhost:9/', identity: 'personal' });
  c.activate(k1.id); await sleep(100);
  c.command('split-add', { id: k2.id }); await sleep(300);
  const sp = c.getState().split;
  check('setup: a split of two kept tabs, without the app Cue opens on', sp.mode === 'cols2' && sp.ids.length === 2 && !sp.ids.includes(home.id), sp);
  c.setSetting('archiveDays', 7); // phase 2 proves the one-time change does not run again
  disk = saved();
  check('crash: what is on disk right now holds no "Just for now" tab (so a crash cannot restore one)', !disk.tabs.some((x) => x.temp || x.uid === q1.uid || x.uid === q2.uid));
  fs.writeFileSync(wantFile, JSON.stringify({
    spaces: c.spaceList(), movedUid: build.uid,
    kept: [k1, k2, k3, child, plain, home].map((t) => t.uid), temp: [q1, q2].map((t) => t.uid),
    split: sp.ids.map((id) => c.byId(id).uid),
  }));

  // ---- a small window: the room list becomes a row of chips
  await size(780, 640); // Cue's window is never narrower than 760
  await js(`closeModal(); openSettings('keys')`); await sleep(500);
  const small = await js(`(() => { const sh = document.querySelector('.sheet.settings').getBoundingClientRect(); const nav = document.querySelector('.snav');
    return { w: Math.round(sh.width), dir: getComputedStyle(nav).flexDirection, fits: sh.right <= innerWidth && sh.bottom <= innerHeight, wide: document.querySelector('.spane').scrollWidth <= document.querySelector('.spane').clientWidth }; })()`);
  check('small window: the dialog fits, the rooms become a row, nothing is wider than the room', small.fits && small.dir === 'row' && small.wide, small);
  await shot('small-window-keys');
  await js(`closeModal()`);
  await size(1280, 900);
  await js(`render()`); await sleep(200);
  await shot('sidebar');
  finish();
  c.app.quit();
};
