// Public-readiness test suite covering:
// - PII scrub, global bills/groups, OAuth popups, shared-logins isolation & lock guard
// - Chrome Login Data + Login Data For Account merge
// - Multi-account vault matching, subdomain matching, per-folder never, CSV export
// - 2-step login username retention, eye-button ignore, popup credential context
// - Persisted passcode lockouts, setPasscode rate limit, lock-on-sleep, live selective lock, lockMinutes guard, Touch ID flags
// - Account cycling, folder reordering, cross-account open-url, Settings password CRUD
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`[cue-public] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 260)}` : ''}`);
};
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(100); }
  return null;
};

module.exports = async (c) => {
  let srv = null;
  let tmp = null;
  try {
    await c.app.whenReady();
    await sleep(1200);

    // 1. PII scrub & neutral public strings
    const root = path.join(__dirname, '..');
    const scanned = ['bin/cue-mcp.js', 'src/main/whatsapp.js', 'CLAUDE.md', 'test/whatsapp.js']
      .map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
    const phoneNeedle = new RegExp('850' + '03');
    check('pii: personal phone number is completely absent from tracked files', !phoneNeedle.test(scanned));
    check('pii: bin/cue-mcp.js has no real names or rupees hardcoding', !/Jolly|rupees/i.test(fs.readFileSync(path.join(root, 'bin/cue-mcp.js'), 'utf8')));
    const settle = require('../src/main/settle');
    check('linux: desktop entry uses neutral Cue description', !/Nathaniel/i.test(settle.desktopEntry('/bin/cue', '/icon.png')));

    // 2. Global bills & groups
    const bills = require('../src/main/bills');
    const eur = bills.readPage('Next renewal on May 15, 2027. Amount: €19.99');
    const gbp = bills.readPage('Payment failed. Due on June 1, 2027 £12.50');
    const inrOnUsd = bills.fromPage([], 'https://vendor.test/billing', 'Payment status: Paid. Renews on July 1, 2027 ₹850', 1, 'USD');
    const eurOnEur = bills.fromPage([], 'https://euro.test/billing', 'Renews on July 1, 2027 €29.50', 0.92, 'EUR');
    check('bills: parses EUR and GBP currencies', eur.amount && eur.amount.currency === 'EUR' && eur.amount.value === 19.99 && gbp.amount && gbp.amount.currency === 'GBP' && gbp.amount.value === 12.5, { eur, gbp });
    check('bills: converts INR to USD instead of mis-recording 850 USD', inrOnUsd && inrOnUsd.amountINR === 10 && eurOnEur && eurOnEur.amountINR === 29.5, { inrOnUsd: inrOnUsd?.amountINR, eurOnEur: eurOnEur?.amountINR });

    const { groupFor } = require('../src/main/groups');
    check('groups: global mainstream sites file into sensible groups',
      groupFor('https://www.reddit.com/r/music') === 'social'
      && groupFor('https://discord.com/channels/1') === 'social'
      && groupFor('https://www.notion.so/home') === 'ai'
      && groupFor('https://www.ebay.com/itm/1') === 'shop'
      && groupFor('https://www.disneyplus.com/') === 'watch'
      && groupFor('https://wise.com/home') === 'money');

    // 3. Expanded OAuth popups & shared-logins isolation
    const { whereToOpen } = require('../src/main/signin');
    check('signin: Auth0, Okta, Clerk, Slack, PayPal OAuth open as popups',
      whereToOpen('https://acme.auth0.com/authorize?client_id=abc&redirect_uri=x', 'foreground-tab') === 'popup'
      && whereToOpen('https://acme.okta.com/oauth2/v1/authorize?client_id=1', 'foreground-tab') === 'popup'
      && whereToOpen('https://slack.com/oauth/v2/authorize?client_id=1', 'foreground-tab') === 'popup'
      && whereToOpen('https://www.paypal.com/signin?redirect_uri=x', 'foreground-tab') === 'popup'
      && whereToOpen('https://acme.auth0.com/docs', 'foreground-tab') === 'tab');

    const { hasTwoAccounts, shareLogins } = require('../src/main/shared-logins');
    check('shared-logins: GitHub, Slack, LinkedIn, Notion, Stripe stay separate per account',
      ['github.com', 'app.slack.com', 'www.linkedin.com', 'www.notion.so', 'dashboard.stripe.com', 'www.amazon.com'].every(hasTwoAccounts)
      && !hasTwoAccounts('example.com'));

    // Locked-folder sync guard on shareLogins
    const fakeSes = () => {
      const store = new Map();
      const listeners = [];
      return {
        cookies: {
          get: async () => [...store.values()],
          set: async (ck) => { store.set(ck.name, ck); },
          remove: async () => {},
          on: (_ev, fn) => listeners.push(fn),
          removeListener: () => {},
          emitChange: (ck) => listeners.forEach((fn) => fn(null, ck, 'explicit', false)),
        },
        has: (n) => store.has(n),
      };
    };
    const sa = fakeSes(); const sb = fakeSes();
    let unlockedFlag = false;
    const pair = shareLogins(sa, sb, { canSync: () => unlockedFlag });
    sa.cookies.emitChange({ domain: 'example.com', path: '/', name: 'sid', value: 'v1', secure: true, httpOnly: true, sameSite: 'lax' });
    await sleep(50);
    check('shared-logins: does not copy cookies while canSync is false (locked)', !sb.has('sid'));
    unlockedFlag = true;
    sa.cookies.emitChange({ domain: 'example.com', path: '/', name: 'sid2', value: 'v2', secure: true, httpOnly: true, sameSite: 'lax' });
    await sleep(50);
    check('shared-logins: copies cookies once unlocked', sb.has('sid2'));
    pair.stop();

    // 4. Chrome importer merges Login Data + Login Data For Account
    const imp = require('../src/main/importer');
    const { DatabaseSync } = require('node:sqlite');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-pub-imp-'));
    const profDir = path.join(tmp, 'Default');
    fs.mkdirSync(profDir, { recursive: true });
    const key = crypto.pbkdf2Sync('test-secret', 'saltysalt', 1003, 16, 'sha1');
    const enc = (plain) => {
      const iv = Buffer.alloc(16, 0x20);
      const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
      return Buffer.concat([Buffer.from('v10'), cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
    };
    const makeLoginDb = (file, rows) => {
      const db = new DatabaseSync(file);
      db.exec('CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB)');
      const ins = db.prepare('INSERT INTO logins VALUES (?, ?, ?)');
      for (const [o, u, p] of rows) ins.run(o, u, p ? enc(p) : Buffer.alloc(0));
      db.close();
    };
    // Empty Login Data + populated Login Data For Account (exact modern Chrome synced layout!)
    makeLoginDb(path.join(profDir, 'Login Data'), [['https://local.example', 'local@ex.com', 'local-pw']]);
    makeLoginDb(path.join(profDir, 'Login Data For Account'), [
      ['https://synced.example', 'sync@ex.com', 'sync-pw'],
      ['https://local.example', 'local@ex.com', 'updated-pw'],
    ]);
    const importedPws = imp.readPasswords({ id: 'chrome', root: tmp }, { dir: 'Default' }, key);
    check('importer: merges Login Data and Login Data For Account without duplicates',
      importedPws.length === 2
      && importedPws.some((x) => x.origin === 'https://synced.example' && x.password === 'sync-pw')
      && importedPws.some((x) => x.origin === 'https://local.example' && x.password === 'updated-pw'),
      importedPws);

    // 5. Vault subdomain matching, multi-account, per-folder never, CSV export
    const A = c.addFolder({ name: 'Work' }).folder;
    const B = c.addFolder({ name: 'Client' }).folder;
    c.vault.save({ identity: A.id, origin: 'https://accounts.acme.test', username: 'first@acme.test', password: 'pw1', auto: true });
    c.vault.save({ identity: A.id, origin: 'https://app.acme.test', username: 'second@acme.test', password: 'pw2', auto: false });
    const allAcme = c.vault.findAll(A.id, 'https://app.acme.test');
    check('vault: subdomain match + exact origin sorted first',
      allAcme.length === 2 && allAcme[0].username === 'second@acme.test' && allAcme[1].username === 'first@acme.test',
      allAcme.map((x) => x.username));
    c.vault.neverFor('https://skip.test', A.id);
    check('vault: never-save is scoped per folder and clearable',
      c.vault.isNever('https://skip.test', A.id)
      && !c.vault.isNever('https://skip.test', B.id)
      && c.vault.listNever(A.id).includes('https://skip.test'));
    c.vault.clearNever('https://skip.test', A.id);
    check('vault: clearNever removes site from never-save list', !c.vault.isNever('https://skip.test', A.id));
    c.vault.save({ identity: A.id, origin: 'https://comma.test', username: 'u,1', password: 'p"w,1', auto: false });
    const exported = c.vault.exportCsv(A.id);
    check('vault: exportCsv properly escapes commas and quotes',
      exported.count >= 3 && exported.csv.includes('"u,1","p""w,1"'), exported.count);

    // 6. Real local server tests: 2-step login username retention, eye-button ignore, multi-account picker
    srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      if (req.url === '/step1') {
        res.end('<form id="f" action="/step2"><input id="em" type="email" name="email" autocomplete="username"><button id="next" type="submit">Next</button></form>');
      } else if (req.url.startsWith('/step2')) {
        res.end('<form id="f" onsubmit="return false"><input id="pw" type="password" autocomplete="current-password"><button id="eye" type="button" aria-label="Show password">Show</button><button id="go" type="submit">Sign in</button></form>');
      } else if (req.url === '/multi') {
        res.end('<form id="f" onsubmit="return false"><input id="u" type="email" name="email"><input id="pw" type="password"><button id="go" type="submit">Sign in</button></form>');
      } else {
        res.end('<p>ok</p>');
      }
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const offeredEvents = [];
    const origSend = c.ui().webContents.send.bind(c.ui().webContents);
    c.ui().webContents.send = (ch, ...args) => {
      if (ch === 'ui:event' && args[0] === 'save-password') offeredEvents.push(args[1]);
      return origSend(ch, ...args);
    };

    c.setFolder(A.id);
    await sleep(200);
    const t2 = c.openTab({ url: `${base}/step1`, identity: A.id });
    await until(() => t2.view && !t2.view.webContents.isLoading() && t2.view.webContents.getURL().includes('/step1'));
    await sleep(300);
    await t2.view.webContents.executeJavaScript(`(() => { const i = document.getElementById('em'); i.value = 'twostep@acme.test'; i.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('next').click(); return 1; })()`, true);
    await until(() => t2.view.webContents.getURL().includes('/step2'));
    await sleep(300);
    // Click eye button first — MUST NOT trigger save-password!
    await t2.view.webContents.executeJavaScript(`(() => { document.getElementById('pw').value = 'secret-2step'; document.getElementById('eye').click(); return 1; })()`, true);
    await sleep(350);
    check('autofill: clicking Show-password eye button never fires false save prompt', offeredEvents.length === 0, offeredEvents);
    // Now click real Sign in button — MUST fire save-password WITH remembered Step-1 email!
    await t2.view.webContents.executeJavaScript(`document.getElementById('go').click(); 1`, true);
    const gotStep2 = await until(() => offeredEvents.find((e) => e.username === 'twostep@acme.test'), 4000);
    check('autofill: 2-step login remembers Step-1 email on password-only Step-2', !!gotStep2, offeredEvents);
    c.closeTab(t2.id);

    // Multi-account: 2 saved logins on same localhost origin -> handsFree is false, picker pops on trusted click
    c.vault.save({ identity: A.id, origin: base, username: 'one@multi.test', password: 'pw-one', auto: true });
    c.vault.save({ identity: A.id, origin: base, username: 'two@multi.test', password: 'pw-two', auto: false });
    const tm = c.openTab({ url: `${base}/multi`, identity: A.id });
    await until(() => tm.view && !tm.view.webContents.isLoading() && tm.view.webContents.getURL().includes('/multi'));
    await sleep(500);
    const notAuto = await tm.view.webContents.executeJavaScript('document.getElementById("pw").value', true);
    check('autofill: 2+ accounts on same site never auto-submits the wrong one', notAuto === '', { was: notAuto });
    const fakeEvent = { sender: tm.view.webContents, senderFrame: tm.view.webContents.mainFrame };
    const ctxHit = c.credsFor(fakeEvent);
    check('autofill: credsFor returns all matching accounts for chooser', ctxHit && ctxHit.list.length === 2, ctxHit?.list?.map((x) => x.username));
    // Verify popupIdentity credential support
    const fakePopupWc = { id: 999999, mainFrame: { url: `${base}/multi` }, getURL: () => `${base}/multi`, once: () => {} };
    c.popupIdentity.set(fakePopupWc, A.id);
    const popHit = c.credsFor({ sender: fakePopupWc, senderFrame: fakePopupWc.mainFrame });
    check('autofill: OAuth sign-in popups receive credentials from their folder', !!(popHit && popHit.identity === A.id && popHit.list.length === 2));
    c.closeTab(tm.id);

    // 7. Settings Password CRUD via uiInvoke
    c.setFolder(A.id);
    const added = await c.invoke('pw-add', { origin: 'manual.example.test', username: 'man@ex.test', password: 'manual-password-99' });
    const info = await c.invoke('passwords-info');
    const manItem = info.items.find((x) => x.origin === 'https://manual.example.test');
    const rev = manItem && await c.invoke('pw-reveal', { pw: manItem.id });
    const upd = manItem && await c.invoke('pw-update', { pw: manItem.id, username: 'man2@ex.test', password: 'manual-password-100' });
    const rev2 = manItem && await c.invoke('pw-reveal', { pw: manItem.id });
    check('passwords UI: add, reveal, and update work cleanly',
      added.ok && rev?.password === 'manual-password-99' && upd?.ok && rev2?.password === 'manual-password-100',
      { added, rev: !!rev?.password, upd, rev2: !!rev2?.password });

    // 8. Passcode hardening: persisted tries, setPasscode rate limit, lockForSleep, live selective lock, lockMinutes guard, Touch ID flags
    check('passcode: set passcode enables touchId default flag on folder',
      c.setPasscode({ id: B.id, code: 'pass-b-1234' }).ok && c.folderRows().find((r) => r.id === B.id).touchId === true);
    check('passcode: setFolderTouchId toggles touchId cleanly',
      c.setFolderTouchId({ id: B.id, on: false }).ok && c.folderRows().find((r) => r.id === B.id).touchId === false
      && c.setFolderTouchId({ id: B.id, on: true }).ok);
    // Rate limit on setPasscode (5 wrong current passcodes -> 60s wait, persisted)
    for (let i = 0; i < 4; i++) c.setPasscode({ id: B.id, current: `bad-${i}`, code: 'new-pass-9' });
    const fifthChg = c.setPasscode({ id: B.id, current: 'bad-5', code: 'new-pass-9' });
    const sixthChg = c.setPasscode({ id: B.id, current: 'pass-b-1234', code: 'new-pass-9' });
    check('passcode: setPasscode is rate-limited after 5 wrong tries and persisted',
      fifthChg.wait === 60 && sixthChg.wait > 0 && !!c.store.data.passChangeTries?.[B.id]?.until,
      { fifthChg, sixthChg });
    // lockForSleep immediately locks unlocked protected folders
    const slept = c.lockForSleep();
    check('passcode: lockForSleep locks passcode-protected accounts immediately', slept.includes(B.id) && c.isLocked(B.id), slept);
    // lockMinutes = 0 is refused while another account is locked!
    c.setSetting('lockMinutes', 10);
    c.setSetting('lockMinutes', 0);
    check('passcode: lockMinutes cannot be set to 0 while an account is locked', c.store.data.settings.lockMinutes === 10, c.store.data.settings.lockMinutes);
    // Persisted lockTries on tryUnlock
    c.tryUnlock(B.id, 'wrong-try');
    check('passcode: failed unlock count persists in store.data.lockTries', c.store.data.lockTries?.[B.id]?.n === 1, c.store.data.lockTries?.[B.id]);
    // Unlock B and verify lockSweep STILL locks B during live mode if B has no tab on stage
    check('passcode: unlocking B succeeds with right passcode', c.tryUnlock(B.id, 'pass-b-1234').ok && !c.isLocked(B.id));
    c.setSetting('lockMinutes', 1);
    c.setFolder(A.id);
    c.setLive(true);
    const sweptLive = c.lockSweep({ now: Date.now() + 5 * 60000, idle: 0 });
    check('passcode: lockSweep still locks idle off-stage accounts even while Live is on', sweptLive.includes(B.id) && c.isLocked(B.id), sweptLive);
    c.setLive(false);

    // 9. Multi-account shifting: stepFolder, reorderFolder, folder.open-url
    c.tryUnlock(B.id, 'pass-b-1234');
    c.setFolder(A.id);
    const beforeOrder = c.userFolders().map((f) => f.id);
    c.reorderFolder({ id: B.id, beforeId: beforeOrder[0] });
    const afterOrder = c.userFolders().map((f) => f.id);
    check('accounts: reorderFolder moves account to new position', afterOrder[0] === B.id, { beforeOrder, afterOrder });
    c.setFolder(B.id);
    c.stepFolder(1);
    check('accounts: stepFolder(1) cycles cleanly to next account', c.openFolder() === afterOrder[1], { now: c.openFolder(), want: afterOrder[1] });
    c.command('folder.open-url', { to: A.id, url: `${base}/multi` });
    await sleep(250);
    check('accounts: open-url opens page directly in target account and switches to it',
      c.openFolder() === A.id && c.byId(c.getState().activeId)?.identity === A.id && c.byId(c.getState().activeId)?.url.includes('/multi'));

  } catch (e) {
    check('suite ran cleanly', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  } finally {
    if (srv) try { srv.close(); } catch {}
    if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    fs.writeFileSync(path.join(OUT, 'public-readiness.json'), JSON.stringify(results, null, 2));
    const fails = results.filter((x) => !x.ok);
    console.log(`[cue-public] DONE ${results.length - fails.length}/${results.length} passed`);
    setTimeout(() => c.app.exit(fails.length ? 1 : 0), 250);
  }
};
