// Pre-launch audit test: CUE_QUIET=1 CUE_TEST=audit CUE_USER_DATA=<new dir> CUE_OUT=<new dir> CUE_AGENT_PORT=<free port> npx electron .
//
// Proves the fixes from the November 2026 pre-launch audit in the real app:
// - a web page cannot send itself (or Peek) to one of Cue's own pages; Cue still can (control)
// - Cue's own pages carry a strict Content-Security-Policy
// - a page that cannot be reached shows cue://offline, and the tab keeps the site's address
// - a link sent to Cue while its folder is locked waits, opens after the passcode, and never throws
// - a folder's sign-in windows close when the folder is locked
// - the sidebar's orders and the cue:// page orders refuse the wrong sender
// - threads.com is treated like threads.net; cue.json and the library are private files
// Every check that passes by finding nothing has a control beside it.
const fs = require('fs');
const http = require('http');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`[cue-audit] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(100); } return null; };
const rejects = async (p) => { try { await p; return ''; } catch (e) { return String(e.message || e); } };

function server() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset=utf-8><title>page ${req.url}</title><p>page</p>`);
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
}
const urlOf = (t) => (t && t.view && !t.view.webContents.isDestroyed() ? t.view.webContents.getURL() : '');
const settled = async (t) => { await until(() => t.view && !t.view.webContents.isLoading(), 15000); await sleep(300); };

module.exports = async (c) => {
  const { BrowserWindow, ipcMain } = require('electron');
  try {
    await c.app.whenReady();
    await sleep(1500);
    const srv = await server();
    const base = `http://127.0.0.1:${srv.address().port}`;

    // ---- a web page may not open Cue's own pages
    const web = c.openTab({ url: `${base}/web`, identity: 'personal' });
    await settled(web);
    await web.view.webContents.executeJavaScript("location.href = 'cue://library'", true).catch(() => {});
    await sleep(1500);
    check('a web page cannot send its tab to cue://library', urlOf(web).startsWith(base), urlOf(web));
    const own = c.openTab({ url: 'cue://library', identity: 'personal' });
    await settled(own);
    check('control: Cue itself still opens cue://library', urlOf(own).startsWith('cue://library'), urlOf(own));

    // ---- strict CSP on Cue's own pages
    const r = await c.sessionFor('personal').fetch('cue://library').catch((e) => ({ headers: new Map(), e }));
    const csp = (r.headers && r.headers.get && r.headers.get('content-security-policy')) || '';
    check('cue:// pages carry a Content-Security-Policy', /script-src 'self'/.test(csp) && /default-src 'none'/.test(csp), csp);
    const css = await c.sessionFor('personal').fetch('cue://library/pages.css').catch(() => null);
    check('control: the page\'s stylesheet is still served', !!css && css.status === 200, css && css.status);

    // ---- Peek obeys the same rule
    c.openPeek(`${base}/peek`, web);
    const peek = await until(() => c.getPeek());
    if (peek) {
      const pw = peek.view.webContents;
      await until(() => !pw.isLoading(), 10000); await sleep(300);
      await pw.executeJavaScript("location.href = 'cue://library'", true).catch(() => {});
      await sleep(1200);
      check('Peek cannot be sent to cue://library', pw.getURL().startsWith(base), pw.getURL());
      const before = BrowserWindow.getAllWindows().length;
      await pw.executeJavaScript("window.open('https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=y', 'signin', 'popup,width=400,height=500')", true).catch(() => {});
      await until(() => BrowserWindow.getAllWindows().length > before, 5000);
      check('a "Sign in with Google" in Peek opens a sign-in window, not a tab', BrowserWindow.getAllWindows().length > before, { before, after: BrowserWindow.getAllWindows().length });
      for (const w of BrowserWindow.getAllWindows().slice(before)) { try { w.destroy(); } catch {} }
      c.closePeek();
    } else check('Peek opened', false);

    // ---- a page that never arrives
    const dead = c.openTab({ url: 'http://127.0.0.1:1/nothing-here', identity: 'personal' });
    await until(() => urlOf(dead).startsWith('cue://offline'), 15000);
    check('an unreachable page shows cue://offline', urlOf(dead).startsWith('cue://offline'), urlOf(dead));
    check('the tab keeps the site\'s own address', dead.url === 'http://127.0.0.1:1/nothing-here', dead.url);
    const words = await dead.view.webContents.executeJavaScript('document.body ? document.body.innerText : ""', true).catch(() => '');
    check('the offline page says something', String(words).trim().length > 10, String(words).slice(0, 80));

    // ---- links while the folder is locked
    const made = c.addFolder({ name: 'Lockie' });
    const L = made.folder;
    check('a folder to lock is made', !!(L && made.ok), made.error);
    c.setPasscode({ id: L.id, code: 'lock-pass-1' });
    c.setFolder(L.id);
    const popupHost = c.openTab({ url: `${base}/popup-host`, identity: L.id });
    await settled(popupHost);
    const winsBefore = BrowserWindow.getAllWindows().length;
    await popupHost.view.webContents.executeJavaScript("window.open('about:blank', 'p', 'popup,width=300,height=300')", true).catch(() => {});
    await until(() => BrowserWindow.getAllWindows().length > winsBefore, 5000);
    check('control: the folder\'s page opened a sign-in window', BrowserWindow.getAllWindows().length > winsBefore);
    c.lockFolder(L.id);
    await sleep(500);
    check('locking the folder closes its sign-in windows', BrowserWindow.getAllWindows().length === winsBefore, { winsBefore, now: BrowserWindow.getAllWindows().length });
    c.store.data.folder = L.id; // as at launch: the folder in front is the locked one
    let thrown = '';
    try { c.openFromApp(`${base}/waiting-link`); } catch (e) { thrown = String(e.message); }
    check('a link sent while the folder is locked does not throw', !thrown, thrown);
    check('...and opens nothing yet', !c.tabs.some((t) => t.url === `${base}/waiting-link`));
    const un = await c.invoke('folder-unlock', { id: L.id, code: 'lock-pass-1' });
    check('the right passcode unlocks it', un && un.ok, un);
    await until(() => c.tabs.some((t) => t.url === `${base}/waiting-link` && t.identity === L.id), 5000);
    check('...and the waiting link opens in that folder', c.tabs.some((t) => t.url === `${base}/waiting-link` && t.identity === L.id));
    check('a file: or odd link from another app is refused', c.openFromApp('javascript:alert(1)') === null);

    // ---- who may give orders
    const n0 = c.tabs.length;
    ipcMain.emit('ui:cmd', { sender: web.view.webContents }, 'new-tab', {});
    await sleep(400);
    check('a web page\'s contents cannot give the sidebar\'s orders', c.tabs.length === n0, { n0, now: c.tabs.length });
    ipcMain.emit('ui:cmd', {}, 'new-tab', {});
    await until(() => c.tabs.length > n0, 3000);
    check('control: the menu (no sender) still can', c.tabs.length > n0);
    const refused = await rejects(Promise.resolve().then(() => c.internal['signin.google']({ identity: 'school' }, null, web.view.webContents)));
    check('a page in no tab cannot start a sign-in in another folder', /Not allowed/.test(refused), refused);
    const proceed = c.internal['shield.proceed']({ site: 'https://example.com/' }, web, web.view.webContents);
    check('"open it anyway" only works from the warning page itself', proceed === false, proceed);

    // ---- Threads and private files
    const { hasTwoAccounts } = require('../src/main/shared-logins');
    check('threads.com is kept apart like threads.net', hasTwoAccounts('www.threads.com') && hasTwoAccounts('www.threads.net'));
    check('control: an ordinary site is shared', !hasTwoAccounts('example.com'));
    check('AI sites keep one account per folder', ['claude.ai', 'chatgpt.com', 'auth.openai.com', 'grok.com', 'www.perplexity.ai'].every(hasTwoAccounts), ['claude.ai', 'chatgpt.com', 'auth.openai.com', 'grok.com', 'www.perplexity.ai'].filter((h) => !hasTwoAccounts(h)));
    check('control: a look-alike name is not caught', !hasTwoAccounts('notclaude.ai') && !hasTwoAccounts('max.ai'));
    // the real thing: two paired sessions, a Claude sign-in made in one stays there
    {
      const { session } = require('electron');
      const { shareLogins } = require('../src/main/shared-logins');
      const A = session.fromPartition(`audit-share-a-${Date.now()}`); const B = session.fromPartition(`audit-share-b-${Date.now()}`);
      const pair = shareLogins(A, B);
      const far = Math.floor(Date.now() / 1000) + 3600;
      await A.cookies.set({ url: 'https://claude.ai/', name: 'sessionKey', value: 'personal-account', secure: true, httpOnly: true, expirationDate: far });
      await A.cookies.set({ url: 'https://example.com/', name: 'sid', value: 'shared', secure: true, expirationDate: far });
      await until(async () => (await B.cookies.get({ name: 'sid' })).length, 3000);
      await sleep(500);
      const inB = await B.cookies.get({ name: 'sessionKey' });
      check('control: an ordinary sign-in reaches the paired folder', (await B.cookies.get({ name: 'sid' })).length === 1);
      check('a Claude sign-in stays in its own folder', inB.length === 0, inB.map((c) => c.domain));
      await B.cookies.set({ url: 'https://claude.ai/', name: 'sessionKey', value: 'school-account', secure: true, httpOnly: true, expirationDate: far });
      await B.cookies.remove('https://claude.ai/', 'sessionKey'); await sleep(500);
      check('signing out of Claude in one folder leaves the other signed in', (await A.cookies.get({ name: 'sessionKey' })).map((c) => c.value).join() === 'personal-account');
      pair.stop();
    }
    c.store.flush();
    const ud = c.app.getPath('userData');
    const mode = (f) => { try { return (fs.statSync(path.join(ud, f)).mode & 0o777).toString(8); } catch (e) { return e.code; } };
    if (process.platform !== 'win32') {
      check('cue.json is readable by this login only', mode('cue.json') === '600', mode('cue.json'));
      check('the library is readable by this login only', mode('cue-library.db') === '600', mode('cue-library.db'));
    }
    srv.close();
  } catch (e) {
    check('the suite ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  }
  fs.writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify(results, null, 2));
  const fails = results.filter((x) => !x.ok);
  console.log(`[cue-audit] DONE ${results.length - fails.length}/${results.length} passed`);
  setTimeout(() => c.app.exit(0), 300);
};
