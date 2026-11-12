// People test: CUE_QUIET=1 CUE_TEST=people CUE_USER_DATA=<new dir> CUE_OUT=<new dir> npx electron .
//
// Proves the "any number of people" claims in the real app: every folder is private - its own
// partition, cookies, local storage, IndexedDB, history, saved passwords and tabs - and the
// sidebar is told about the open folder only. Sharing sign-ins happens only between folders the
// person paired. A passcode hides a folder completely until the right code is typed. Removing a
// folder takes its data with it and leaves the others alone. An install from before folders comes
// back exactly as it was. WhatsApp's `who` finds any folder by name and refuses to guess.
//
// Every check that proves something by FINDING NOTHING has a control beside it that finds the
// thing where it should be, so an empty answer cannot pass by accident.
//
// The existing-install half runs in a second, hidden Cue started by this one, on a made-up old
// cue.json (CUE_PEOPLE=legacy). Optional: CUE_MCP=1 (with CUE_AGENT_PORT set to a free port) also
// runs test/mcp-check.js against this Cue at the end, never against the installed one.
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
fs.mkdirSync(OUT, { recursive: true });
const PHASE = process.env.CUE_PEOPLE || 'fresh';
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`[cue-people${PHASE === 'legacy' ? ':legacy' : ''}] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(100); } return null; };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message || e); } };
const rejects = async (p) => { try { await p; return ''; } catch (e) { return String(e.message || e); } };

const PAGE = (title) => `<!doctype html><meta charset=utf-8><title>${title}</title><p>${title}</p>
  <form onsubmit="event.preventDefault()"><input id=u type=email><input id=pw type=password><button id=go>Sign in</button></form>`;

function server() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE(decodeURIComponent(u.replace(/^\/p\//, '').replace(/^\//, '')) || 'home'));
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function loaded(t) {
  await until(() => t.view && !t.view.webContents.isLoading(), 15000);
  await sleep(250);
}
const js = (t, code) => t.view.webContents.executeJavaScript(code, true);

// ================================================================== a brand-new install
async function fresh(c) {
  const srv = await server();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const ud = c.app.getPath('userData');
  const say = []; const orig = c.sendEvent;
  void orig; void say;

  // ---- a fresh install is one plain, private folder
  const f0 = c.userFolders();
  check('fresh: one folder, id personal, called Personal', f0.length === 1 && f0[0].id === 'personal' && f0[0].name === 'Personal', f0);
  check('fresh: it shares nothing and lets no agent in', (c.store.data.settings.sharedPairs || []).length === 0 && f0[0].agents === false, { pairs: c.store.data.settings.sharedPairs, agents: f0[0].agents });

  // ---- five people
  const names = ['Asha', 'Ben', 'Chitra', 'Dev', 'Esha'];
  const made = names.map((name) => c.addFolder({ name }));
  const F = made.map((r) => r.folder);
  check('five folders are made', made.every((r) => r.ok) && c.userFolders().length === 6, made.map((r) => r.error || r.folder.id));
  check('each new id is f + 8 base-36 letters', F.every((f) => /^f[0-9a-z]{8}$/.test(f.id)), F.map((f) => f.id));
  const parts = F.map((f) => c.sessionFor(f.id).storagePath);
  check('each has its own partition on disk', new Set(parts).size === 5 && parts.every((p, i) => p && p.endsWith(path.join('Partitions', F[i].id))), parts.map((p) => p && path.basename(p)));
  check('each is a different session', new Set(F.map((f) => c.sessionFor(f.id))).size === 5);
  check('a name that is taken is refused', !!c.addFolder({ name: 'asha' }).error);
  check('an unknown folder has no session (no fallback to another)', /no folder/i.test(throws(() => c.sessionFor('fnotthere1'))));
  // A rename keeps the id, so the partition, tabs and sign-ins stay put.
  const idBefore = F[4].id;
  c.renameFolder({ id: F[4].id, name: 'Esha K' });
  check('rename keeps the id', c.userFolders().find((f) => f.id === idBefore).name === 'Esha K');

  // ---- folder 3 (Chitra) gets a cookie, local storage, IndexedDB, history, a password and a tab
  const C3 = F[2];
  const others = F.filter((f) => f !== C3);
  const MARK = `zzchitra${crypto.randomBytes(4).toString('hex')}`;
  const MAIL = `${MARK}@example.test`;
  c.command('folder.email', { id: C3.id, email: MAIL });
  c.setFolder(C3.id); await sleep(300);
  const t3 = c.openTab({ url: `${base}/p/${MARK}`, identity: C3.id });
  await loaded(t3);
  await c.sessionFor(C3.id).cookies.set({ url: base, name: 'probe', value: MARK });
  await js(t3, `localStorage.setItem('probe', ${JSON.stringify(MARK)})`);
  await js(t3, `new Promise((ok) => { const r = indexedDB.open(${JSON.stringify(MARK)}, 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put('x', 'k'); tx.oncomplete = () => ok(true); }; })`);
  c.vault.save({ identity: C3.id, origin: base, username: MAIL, password: 'pw-' + MARK, auto: false });
  await sleep(500);

  const cookieIn = async (f) => ((await c.sessionFor(f).cookies.get({ url: base, name: 'probe' }))[0] || {}).value || '';
  const probeTab = async (f) => { const t = c.openTab({ url: `${base}/p/probe-${f}`, identity: f, background: true }); await loaded(t); return t; };
  const lsIn = (t) => js(t, `localStorage.getItem('probe')`);
  const idbIn = (t) => js(t, `indexedDB.databases().then((l) => l.map((d) => d.name))`);

  // Controls: it is all there in Chitra's folder.
  check('control: the cookie is in Chitra\'s folder', (await cookieIn(C3.id)) === MARK);
  check('control: local storage is in Chitra\'s folder', (await lsIn(t3)) === MARK);
  check('control: IndexedDB is in Chitra\'s folder', (await idbIn(t3)).includes(MARK));
  check('control: the visit is in Chitra\'s history', c.lib.in(C3.id).history(MARK).length > 0 && c.suggestions(MARK, C3.id).history.length > 0);
  check('control: the password is in Chitra\'s list', c.vault.list(C3.id).some((x) => x.username === MAIL));
  c.sendState();
  check('control: the sidebar sees the tab while Chitra\'s folder is open', JSON.stringify(c.lastState()).includes(MARK));

  for (const o of others) {
    const t = await probeTab(o.id);
    const ls = await lsIn(t); const idb = await idbIn(t);
    check(`${o.name}: no cookie, local storage or IndexedDB from Chitra`, !(await cookieIn(o.id)) && ls === null && !idb.includes(MARK), { cookie: await cookieIn(o.id), ls, idb });
    check(`${o.name}: no history row or suggestion from Chitra`, c.lib.in(o.id).history(MARK).length === 0 && c.suggestions(MARK, o.id).history.length === 0);
    check(`${o.name}: no saved password from Chitra`, !c.vault.list(o.id).some((x) => x.username === MAIL));
    c.setFolder(o.id); await sleep(150); c.sendState();
    const st = c.lastState(); const raw = JSON.stringify(st);
    check(`${o.name} open: the sidebar is told nothing of Chitra's tab, page or account`,
      !raw.includes(MARK) && !st.tabs.some((x) => x.id === t3.id) && st.folder === o.id, { tabs: st.tabs.map((x) => `${x.identity}:${x.id}`) });
    check(`${o.name} open: Chitra is a name and counts only`, st.identities[C3.id] && st.identities[C3.id].name === 'Chitra' && !('about' in st.identities[C3.id]) && typeof st.folderInfo[C3.id].tabs === 'number' && !st.labels[C3.id], { face: st.identities[C3.id], info: st.folderInfo[C3.id] });
    const pw = await c.invoke('passwords');
    check(`${o.name} open: Settings lists none of Chitra's passwords`, !pw.some((x) => x.username === MAIL));
    c.closeTab(t.id);
  }
  // Settings' list as Chitra: the control for the line above.
  c.setFolder(C3.id); await sleep(150);
  check('control: Settings lists Chitra\'s password in her own folder', (await c.invoke('passwords')).some((x) => x.username === MAIL));
  // Closed tabs and downloads are per folder too.
  const closeMe = c.openTab({ url: `${base}/p/closed-${MARK}`, identity: C3.id }); await loaded(closeMe);
  c.closeTab(closeMe.id);
  c.setFolder(F[0].id); await sleep(150);
  const notHers = c.reopenClosed(); // Asha's own probe tab, closed above, is the one that may come back
  check('Reopen Closed Tab in another folder does not bring back Chitra\'s', !notHers || (notHers.identity === F[0].id && !notHers.url.includes(MARK)), notHers && notHers.url);
  if (notHers) c.closeTab(notHers.id);
  c.setFolder(C3.id); await sleep(150);
  const back = c.reopenClosed();
  check('control: in her own folder it comes back', back && back.url.includes(`closed-${MARK}`), back && back.url);
  if (back) c.closeTab(back.id);
  // Agents see nothing of a folder not opened to them.
  check('agents: a folder not opened to them is not listed', !c.agentApi.identities().some((x) => x.id === C3.id) && !c.agentApi.list().some((x) => x.id === t3.id));
  c.command('folder.agents', { id: C3.id, on: true });
  check('control: once opened to agents, it is listed', c.agentApi.identities().some((x) => x.id === C3.id) && c.agentApi.list().some((x) => x.id === t3.id));
  c.command('folder.agents', { id: C3.id, on: false });
  check('agents: opening a page in it is refused', /not open to AI agents/.test(throws(() => c.agentApi.open({ url: `${base}/p/x`, identity: 'Chitra' }))));

  // ---- sharing sign-ins: only for a pair that is listed
  const [A, B] = [F[0], F[1]]; const E = F[4];
  const site = 'one-account.test';
  const put = (f, v) => c.sessionFor(f).cookies.set({ url: `https://${site}/`, name: 'share_probe', value: v });
  const got = async (f) => ((await c.sessionFor(f).cookies.get({ url: `https://${site}/`, name: 'share_probe' }))[0] || {}).value || '';
  await put(A.id, 'before'); await sleep(600);
  check('sharing: nothing is shared before a pair is listed', !(await got(B.id)) && !(await got(E.id)));
  c.setShared({ a: A.id, b: B.id, on: true }); await sleep(800);
  check('sharing: pairing fills in what was already there', (await got(B.id)) === 'before', await got(B.id));
  await put(A.id, 'after'); await sleep(600);
  check('sharing: a new sign-in reaches the paired folder', (await got(B.id)) === 'after', await got(B.id));
  check('sharing: and nobody else', !(await got(E.id)) && !(await got(C3.id)));
  await c.sessionFor(A.id).cookies.set({ url: 'https://mail.google.com/', name: 'share_probe', value: 'mine' }); await sleep(500);
  check('sharing: Gmail stays separate even when paired', !((await c.sessionFor(B.id).cookies.get({ url: 'https://mail.google.com/', name: 'share_probe' }))[0]));
  // Passwords cross-fill only for the pair, and only after the box is touched.
  c.vault.save({ identity: A.id, origin: base, username: 'asha@example.test', password: 'pw-asha-123', auto: false });
  const clickPw = async (t) => {
    const { x, y } = await js(t, `(()=>{const b=document.getElementById('pw').getBoundingClientRect();return {x:Math.round(b.x+5),y:Math.round(b.y+5)}})()`);
    t.view.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    t.view.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const pwIn = async (f) => {
    c.setFolder(f); await sleep(150);
    const t = c.openTab({ url: `${base}/p/login-${f}`, identity: f }); await loaded(t); await sleep(800);
    await clickPw(t);
    let v = await until(() => js(t, 'document.getElementById("pw").value'), 3000);
    if (!v) { await clickPw(t); v = await until(() => js(t, 'document.getElementById("pw").value'), 3000); } // a slow first page
    c.closeTab(t.id);
    return v || '';
  };
  check('control: Asha\'s own password fills in her folder', (await pwIn(A.id)) === 'pw-asha-123');
  check('passwords: the paired folder gets it', (await pwIn(B.id)) === 'pw-asha-123');
  check('passwords: an unpaired folder does not', (await pwIn(E.id)) === '');
  c.setShared({ a: A.id, b: B.id, on: false }); await sleep(300);
  await put(A.id, 'unpaired'); await sleep(600);
  check('sharing: unpairing stops it', (await got(B.id)) === 'after', await got(B.id));
  check('passwords: unpairing stops the cross-fill too', (await pwIn(B.id)) === '');

  // ---- the lock
  const D = F[3];
  const DMARK = `zzdev${crypto.randomBytes(4).toString('hex')}`;
  c.setFolder(D.id); await sleep(150);
  const td = c.openTab({ url: `${base}/p/${DMARK}`, identity: D.id }); await loaded(td);
  check('lock: a short passcode is refused', !!c.setPasscode({ id: D.id, code: 'abc' }).error);
  check('lock: a passcode is set', c.setPasscode({ id: D.id, code: 'dev-pass-1' }).ok && !c.isLocked(D.id));
  const onDisk = JSON.stringify(c.store.data.folders.find((f) => f.id === D.id).lock);
  check('lock: only a salt and a hash are kept, never the code', /"salt"/.test(onDisk) && /"hash"/.test(onDisk) && !onDisk.includes('dev-pass-1'));
  c.command('folder.agents', { id: D.id, on: true });
  check('control: before locking, agents can see Dev\'s folder', c.agentApi.identities().some((x) => x.id === D.id));
  c.command('folder.lock-now', { id: D.id }); await sleep(300);
  check('lock: Dev is locked', c.isLocked(D.id));
  check('lock: its tab has no page in memory', !c.byId(td.id).view);
  check('lock: the sidebar moved to an unlocked folder', c.openFolder() !== D.id && !c.isLocked(c.openFolder()), c.openFolder());
  c.sendState();
  const ls = c.lastState(); const lraw = JSON.stringify(ls);
  check('lock: nothing about it is in the sidebar state but its face', !lraw.includes(DMARK) && !ls.tabs.some((x) => x.identity === D.id)
    && ls.folderInfo[D.id].locked === true && Object.keys(ls.folderInfo[D.id]).length === 1 && ls.identities[D.id].locked === true, ls.folderInfo[D.id]);
  check('lock: no tab can be opened in it', /locked/i.test(throws(() => c.openTab({ url: `${base}/p/x`, identity: D.id }))));
  check('lock: Cmd+K and the address bar find nothing in it', c.suggestions(DMARK, D.id).history.length === 0);
  check('control: the history is still there underneath', c.lib.in(D.id).history(DMARK).length > 0);
  check('lock: agents cannot name it, list it or open in it', !c.agentApi.identities().some((x) => x.id === D.id) && !c.agentApi.list().some((x) => x.identity === D.id)
    && /locked/.test(throws(() => c.agentApi.open({ url: `${base}/p/x`, identity: 'Dev' }))));
  check('lock: agents cannot reach its WhatsApp', /locked/.test(await rejects(c.agentApi.whatsapp({ who: 'Dev', action: 'chats' }))));
  check('lock: agents cannot read its tab', !c.agentApi.canRead(c.byId(td.id)));
  c.setFolder(D.id); await sleep(500);
  check('lock: opening it asks for the passcode instead', c.openFolder() !== D.id);
  const sheet = await until(() => c.ui().webContents.executeJavaScript(`(() => { const m = document.getElementById('modal'); return !m.hidden && !!m.querySelector('input[type=password]') && /locked/.test(m.textContent); })()`), 3000);
  check('lock: the sidebar shows a masked passcode box', !!sheet);
  await c.ui().webContents.executeJavaScript(`document.querySelector('#modal .btn:last-child') && document.querySelector('#modal .sheet .foot .btn').click()`).catch(() => {});
  check('lock: a wrong passcode is refused', !!c.tryUnlock(D.id, 'not-it').error && c.isLocked(D.id));
  check('lock: the right one opens it', c.tryUnlock(D.id, 'dev-pass-1').ok && !c.isLocked(D.id));
  c.setFolder(D.id); await sleep(200);
  check('lock: then it opens', c.openFolder() === D.id);
  c.activate(td.id); await sleep(400);
  check('lock: its tab comes back with its page', c.byId(td.id) && c.byId(td.id).view && c.byId(td.id).url.includes(DMARK));
  check('lock: changing the passcode needs the current one', !!c.setPasscode({ id: D.id, current: 'wrong', code: 'dev-pass-2' }).error && c.setPasscode({ id: D.id, current: 'dev-pass-1', code: 'dev-pass-2' }).ok);
  // Idle: with 0 minutes nothing locks; with 1 minute, two idle minutes lock it.
  c.setSetting('lockMinutes', 0);
  c.lockSweep({ now: Date.now() + 10 * 60000, idle: 9999 });
  check('control: lock minutes 0 never locks by itself', !c.isLocked(D.id));
  c.setSetting('lockMinutes', 1);
  c.lockSweep({ now: Date.now() + 2 * 60000, idle: 9999 });
  check('lock: it locks itself after the idle minutes', c.isLocked(D.id));
  check('lock: removing a passcode needs the current one', !!c.setPasscode({ id: D.id, current: 'dev-pass-1', code: '' }).error);
  // Five wrong tries, then a minute's wait - even for the right code.
  for (let i = 0; i < 4; i++) c.tryUnlock(D.id, `wrong-${i}`);
  const fifth = c.tryUnlock(D.id, 'wrong-5');
  const sixth = c.tryUnlock(D.id, 'dev-pass-2');
  check('lock: five wrong tries mean a one-minute wait, even for the right code', fifth.wait === 60 && !!sixth.error && sixth.wait > 0 && c.isLocked(D.id), { fifth, sixth });
  c.setSetting('lockMinutes', 15);

  // ---- removing a folder
  const Bx = F[1];
  const BMARK = `zzben${crypto.randomBytes(4).toString('hex')}`;
  c.setFolder(Bx.id); await sleep(150);
  const tb = c.openTab({ url: `${base}/p/${BMARK}`, identity: Bx.id }); await loaded(tb);
  c.vault.save({ identity: Bx.id, origin: base, username: 'ben@example.test', password: 'pw-ben', auto: false });
  c.lib.in(Bx.id).boardCreate('Ben board');
  await c.sessionFor(Bx.id).cookies.flushStore();
  const bdir = path.join(ud, 'Partitions', Bx.id);
  check('control: Ben\'s partition, history, board and password exist', fs.existsSync(bdir) && c.lib.countIn(Bx.id) > 0 && c.vault.list(Bx.id).length > 0, { dir: fs.existsSync(bdir), rows: c.lib.countIn(Bx.id) });
  check('remove: an unconfirmed remove does nothing', !!(await c.removeFolder({ id: Bx.id })).error && c.userFolders().some((f) => f.id === Bx.id));
  const rr = await c.removeFolder({ id: Bx.id, confirmed: true });
  check('remove: it is gone from the list', rr.ok && !c.userFolders().some((f) => f.id === Bx.id), rr);
  check('remove: its partition went to the Trash, not left on disk', rr.trashed && !fs.existsSync(bdir), { trashed: rr.trashed, there: fs.existsSync(bdir) });
  check('remove: its tabs closed', !c.tabs.some((t) => t.identity === Bx.id) && !c.byId(tb.id));
  check('remove: its history, boards and passwords are gone', c.lib.countIn(Bx.id) === 0 && c.vault.list(Bx.id).length === 0);
  check('remove: nothing can open in it again', /no folder/i.test(throws(() => c.sessionFor(Bx.id))));
  check('remove: the others are untouched', (await cookieIn(C3.id)) === MARK && c.lib.in(C3.id).history(MARK).length > 0 && c.vault.list(C3.id).length > 0 && c.byId(t3.id), { cookie: await cookieIn(C3.id) });
  c.persist(); c.store.flush();
  check('remove: nothing of it is left in the saved state', !JSON.stringify(c.store.data).includes(Bx.id));

  // ---- WhatsApp: `who` finds every folder by its name, and refuses to guess
  const { resolveWho } = require('../src/main/whatsapp');
  const five = [{ id: 'personal', name: 'Personal' }, ...['Asha', 'Chitra', 'Dev', 'Esha K'].map((n, i) => ({ id: `f0000000${i}`, name: n }))];
  check('who: each of five folders by name, any case', five.every((f) => resolveWho(f.name.toUpperCase(), five) === f.id && resolveWho(` ${f.name.toLowerCase()} `, five) === f.id));
  check('who: and by id', five.every((f) => resolveWho(f.id, five) === f.id));
  const unknown = throws(() => resolveWho('Zara', five));
  check('who: an unknown name is refused, listing the real ones', /no folder called/i.test(unknown) && /Asha/.test(unknown) && /Esha K/.test(unknown), unknown);
  check('who: half a name is not a name', !!throws(() => resolveWho('Esh', five)));
  const twin = [...five, { id: 'asha', name: 'Asha Rao' }];
  check('who: two folders that could be meant is an error, not a guess', /more than one/i.test(throws(() => resolveWho('asha', twin))));
  check('who: nothing said is refused', !!throws(() => resolveWho('', five)));
  const legacy = [{ id: 'personal', name: 'Personal' }, { id: 'school', name: 'School' }];
  check('who: "jason" and "nathaniel" still mean the owner\'s two folders', resolveWho('jason', legacy) === 'personal' && resolveWho('Nathaniel', legacy) === 'school');
  check('who: but not once School is renamed', !!throws(() => resolveWho('nathaniel', [legacy[0], { id: 'school', name: 'Office' }])));
  check('who: and not on an install without them', !!throws(() => resolveWho('jason', five)));
  check('who: the agent door says the same', /no folder called/i.test(await rejects(c.agentApi.whatsapp({ who: 'Zara', action: 'chats' }))));
  check('who: a folder kept from agents is refused by name', /not open to AI agents/.test(await rejects(c.agentApi.whatsapp({ who: 'Chitra', action: 'chats' }))));

  // ---- the last folder stays
  for (const f of c.userFolders().filter((x) => x.id !== 'personal')) {
    if (c.isLocked(f.id)) { c.tryUnlock(f.id, 'dev-pass-2'); }
    if (c.isLocked(f.id)) { c.setPasscode({ id: f.id, current: 'dev-pass-2', code: '' }); }
    await c.removeFolder({ id: f.id, confirmed: true });
  }
  const leftOne = c.userFolders();
  const last = await c.removeFolder({ id: 'personal', confirmed: true });
  check('remove: the last folder cannot be removed', leftOne.length === 1 && !!last.error && c.userFolders().length === 1, { left: leftOne.map((f) => f.id), last });
  c.sendState();
  check('after all that the sidebar still has a folder open', c.lastState().folder === 'personal' && !c.lastState().folderLocked);

  srv.close();
  return base;
}

// ================================================================== an install from before folders
// Written by the fresh phase into a new folder, then opened by a second, hidden Cue.
function legacyFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const EVERYDAY = ['https://mail.google.com/', 'https://www.facebook.com/', 'https://www.instagram.com/', 'https://web.whatsapp.com/'];
  const tab = (uid, identity, url, extra = {}) => ({ uid, url, title: uid, name: null, favicon: null, identity, pinned: false, groupOverride: null, volume: 1, muted: false, private: false, obsScene: '', order: 1, zoom: 0, aiAllowed: false, space: 'Teach', lastActive: Date.now(), agent: false, ...extra });
  const cue = {
    tabs: [
      tab('lp1', 'personal', 'about:blank#legacy-personal-1'),
      tab('lp2', 'personal', 'about:blank#legacy-personal-2', { name: 'Kept name' }),
      tab('ls1', 'school', 'about:blank#legacy-school-1'),
      tab('ls2', 'school', 'about:blank#legacy-school-2', { pinned: true }),
      tab('lg1', 'ghost', 'about:blank#legacy-ghost'), // a folder that is not there
    ],
    activeIndex: 2, folder: 'school', space: 'Teach', financeNamed: true, tidyDefaults: true, quietDefaults: true, stripDefaults: true, groupsRepaired: true,
    everydayPinned: { personal: EVERYDAY, school: EVERYDAY },
    whose: { personal: { google: { who: 'old-personal@example.test', label: 'Google', at: 1 } } },
    settings: { identityLabels: { personal: 'old-personal@example.test', school: 'old-school@example.test', agent: '' }, spaceLogins: { Teach: 'school', Create: 'personal' }, openOn: 'last', archiveDays: 0 },
  };
  fs.writeFileSync(path.join(dir, 'cue.json'), JSON.stringify(cue, null, 2));
  // A library from before folders: one shared history and one set of bookmarks.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'cue-library.db'));
  db.exec(`CREATE TABLE history (url TEXT PRIMARY KEY, title TEXT, visits INTEGER DEFAULT 1, last INTEGER, host TEXT);
    CREATE TABLE sites (host TEXT PRIMARY KEY, title TEXT, visits INTEGER DEFAULT 1, last INTEGER);
    CREATE TABLE bookmarks (url TEXT PRIMARY KEY, title TEXT, folder TEXT);
    CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT, created INTEGER);
    CREATE TABLE board_items (id TEXT PRIMARY KEY, board TEXT, img TEXT, source TEXT, title TEXT, thumb TEXT, added INTEGER);
    CREATE INDEX history_host ON history(host, last DESC);`);
  db.prepare('INSERT INTO history VALUES (?, ?, ?, ?, ?)').run('https://legacy.example.test/page', 'Legacy page', 3, Date.now(), 'legacy.example.test');
  db.prepare('INSERT INTO sites VALUES (?, ?, ?, ?)').run('legacy.example.test', 'Legacy', 3, Date.now());
  db.prepare('INSERT INTO bookmarks VALUES (?, ?, ?)').run('https://legacy.example.test/bm', 'Legacy bookmark', 'Bar');
  db.prepare('INSERT INTO boards VALUES (?, ?, ?)').run('b1', 'Legacy board', Date.now());
  db.close();
}

async function legacy(c) {
  const f = c.userFolders();
  check('upgrade: the owner\'s two folders, in order', f.length === 2 && f[0].id === 'personal' && f[1].id === 'school', f.map((x) => x.id));
  check('upgrade: names, colours and pictures unchanged',
    f[0].name === 'Personal' && f[0].color === '#2A64CC' && f[0].picture === 'folder-personal.png'
    && f[1].name === 'School' && f[1].color === '#C2410C' && f[1].picture === 'folder-school.png', f);
  check('upgrade: descriptions unchanged', f[0].about === 'Your own account' && f[1].about === 'The school account');
  check('upgrade: each keeps its Google address', f[0].email === 'old-personal@example.test' && f[1].email === 'old-school@example.test');
  check('upgrade: agents may still use both', f.every((x) => x.agents === true));
  check('upgrade: Personal and School still share sign-ins', JSON.stringify(c.store.data.settings.sharedPairs) === JSON.stringify([['personal', 'school']]));
  const ids = c.tabs.map((t) => `${t.identity}:${t.url.split('#')[1] || ''}`);
  check('upgrade: every tab is back in its own folder', ['personal:legacy-personal-1', 'personal:legacy-personal-2', 'school:legacy-school-1', 'school:legacy-school-2'].every((x) => ids.includes(x)), ids);
  check('upgrade: names and pins kept', c.tabs.find((t) => t.uid === 'lp2').name === 'Kept name' && c.tabs.find((t) => t.uid === 'ls2').pinned === true);
  check('upgrade: a tab of a folder that is not there is dropped, not moved', !c.tabs.some((t) => t.uid === 'lg1' || /ghost/.test(t.url)), ids);
  check('upgrade: the folder that was open is open', c.openFolder() === 'school');
  check('upgrade: the partitions are the same ones', c.sessionFor('personal').storagePath.endsWith(path.join('Partitions', 'personal')) && c.sessionFor('school').storagePath.endsWith(path.join('Partitions', 'school')));
  const site = 'shared-legacy.test';
  await c.sessionFor('personal').cookies.set({ url: `https://${site}/`, name: 'legacy_probe', value: 'p' }); await sleep(700);
  check('upgrade: a sign-in in Personal still reaches School', ((await c.sessionFor('school').cookies.get({ url: `https://${site}/`, name: 'legacy_probe' }))[0] || {}).value === 'p');
  check('upgrade: the old history is filed under Personal', c.lib.in('personal').history('legacy').length === 1 && c.lib.in('school').history('legacy').length === 0);
  check('upgrade: old bookmarks and boards too', c.lib.in('personal').bookmarks('legacy').length === 1 && c.lib.in('personal').boardList().length === 1);
  c.sendState();
  const st = c.lastState();
  check('upgrade: the sidebar shows both, School open with its picture', st.folders.includes('personal') && st.folders.includes('school') && st.identities.school.picture === 'folder-school.png' && st.folder === 'school');
  const { resolveWho } = require('../src/main/whatsapp');
  const list = f.map((x) => ({ id: x.id, name: x.name }));
  check('upgrade: "jason" and "nathaniel" still work for WhatsApp', resolveWho('jason', list) === 'personal' && resolveWho('nathaniel', list) === 'school');
  check('upgrade: and agents see both folders', ['personal', 'school'].every((id) => c.agentApi.identities().some((x) => x.id === id)));
}

module.exports = async (c) => {
  await sleep(1200);
  try {
    if (PHASE === 'legacy') await legacy(c);
    else {
      await fresh(c);
      // The second Cue: an install from before folders.
      const dir = path.join(path.dirname(c.app.getPath('userData')), `${path.basename(c.app.getPath('userData'))}-legacy`);
      if (fs.existsSync(dir)) check('legacy: a fresh folder for the old install', false, dir);
      else {
        legacyFixture(dir);
        const out = path.join(OUT, 'legacy');
        const child = spawn(process.execPath, [path.join(__dirname, '..')], {
          env: { ...process.env, CUE_TEST: 'people', CUE_PEOPLE: 'legacy', CUE_USER_DATA: dir, CUE_OUT: out, CUE_MCP: '', CUE_AGENT_PORT: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let text = '';
        child.stdout.on('data', (d) => { text += d; });
        child.stderr.on('data', () => {});
        const code = await new Promise((ok) => { const k = setTimeout(() => { child.kill(); ok('timeout'); }, 120000); child.on('exit', (n) => { clearTimeout(k); ok(n); }); });
        for (const line of text.split('\n')) if (line.startsWith('[cue-people:legacy]') && !/DONE/.test(line)) console.log(line);
        const sub = (() => { try { return JSON.parse(fs.readFileSync(path.join(out, 'people.json'), 'utf8')); } catch { return null; } })();
        check('legacy: the old install ran to the end', !!sub && sub.length > 0, { code });
        for (const r of sub || []) results.push({ ...r, name: `legacy: ${r.name}` });
      }
      // The MCP bridge, against THIS Cue only.
      if (process.env.CUE_MCP && process.env.CUE_AGENT_PORT) {
        c.command('folder.agents', { id: 'personal', on: true });
        c.setFolder('personal');
        c.openTab({ url: 'about:blank#mcp-user-tab', identity: 'personal' });
        c.command('ai-door', { on: true });
        await sleep(500);
        const child = spawn('node', [path.join(__dirname, 'mcp-check.js')], { env: { ...process.env, CUE_TOKEN_FILE: path.join(c.app.getPath('userData'), 'agent-port.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
        let text = ''; child.stdout.on('data', (d) => { text += d; }); child.stderr.on('data', (d) => { text += d; });
        const code = await new Promise((ok) => { const k = setTimeout(() => { child.kill(); ok('timeout'); }, 90000); child.on('exit', (n) => { clearTimeout(k); ok(n); }); });
        fs.writeFileSync(path.join(OUT, 'mcp-check.txt'), text);
        console.log(text.split('\n').map((l) => `[mcp-check] ${l}`).join('\n'));
        check('mcp-check ran green against this Cue', code === 0 && !/FAILED/.test(text), { code });
      }
    }
  } catch (e) {
    check('the suite ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  }
  fs.writeFileSync(path.join(OUT, 'people.json'), JSON.stringify(results, null, 2));
  const fails = results.filter((x) => !x.ok);
  console.log(`[cue-people${PHASE === 'legacy' ? ':legacy' : ''}] DONE ${results.length - fails.length}/${results.length} passed`);
  if (!process.env.CUE_KEEP) setTimeout(() => c.app.exit(0), 300);
};
