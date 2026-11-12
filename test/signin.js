// Sign-in test: CUE_TEST=signin CUE_USER_DATA=<tmp> CUE_OUT=<dir> electron .
//
// Proves that EVERY folder, whatever its id, says one coherent Chrome identity everywhere a site
// can look, and that Google's and WhatsApp's own pages serve Cue normally:
//   1. Offline, against a local https page: the Sec-CH-UA header the server received agrees with
//      navigator.userAgentData in the page, a same-origin iframe, a cross-origin iframe, a worker,
//      a service worker and a sign-in pop-up - in three brand-new partitions with made-up ids.
//   2. A pop-up completes an OAuth-style round trip (postMessage to the opener, then close).
//   3. The Google-refusal gate retries once per folder per 10 minutes, never in a loop.
//   4. Live: Google's sign-in form is served and the address step is answered on the account
//      ("Enter your password", or "Couldn't find this account" for a made-up address) in three new
//      partitions (no password is ever typed, nothing is created), and the header Google received
//      agrees with the page. At most two attempts per partition; a captcha or rate limit is
//      recorded as such, never retried in a loop.
//   5. Live: web.whatsapp.com in three partitions each shows its own link screen, storage apart.
// Set CUE_OFFLINE=1 to run parts 1-3 only.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { BrowserWindow, session } = require('electron');
const identity = require('../src/main/identity');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[cue-signin] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };
const note = (name, detail) => { results.push({ name, ok: true, note: true, detail }); console.log(`[cue-signin] NOTE ${name} :: ${JSON.stringify(detail)}`); };
const until = async (fn, ms = 40000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); } return null; };
const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'tab.js');
const NOBODY = 'cue.browser.check@gmail.com'; // a made-up address: no password is ever typed for it
const brandsOf = (l) => (Array.isArray(l) ? l.map((b) => `${b.brand}/${b.version}`).join(', ') : String(l));
// '"Chromium";v="152", "Not?A_Brand";v="24"' -> 'Chromium/152, Not?A_Brand/24'
const headerBrands = (h) => String(h || '').split(/,\s*/).filter(Boolean).map((x) => { const m = /^"([^"]*)";v="([^"]*)"$/.exec(x.trim()); return m ? `${m[1]}/${m[2]}` : x; }).join(', ');

// ---------------------------------------------------------------- the local page
const REPORT = `async function report() {
  const n = navigator; const d = n.userAgentData; let high = null;
  try { high = d ? await d.getHighEntropyValues(['platformVersion','architecture','bitness','model','uaFullVersion','fullVersionList','wow64']) : null; } catch (e) { high = String(e); }
  let names = [];
  try { if (typeof window !== 'undefined') names = Object.getOwnPropertyNames(window).filter((k) => /^_*cue|electron/i.test(k)); } catch {}
  return { ua: n.userAgent, appVersion: n.appVersion, vendor: n.vendor, platform: n.platform, languages: n.languages, brands: d ? d.brands : null, mobile: d && d.mobile, plat: d && d.platform, high, json: d && d.toJSON ? JSON.stringify(d.toJSON()) : null, process: typeof process !== 'undefined', names, own: Object.getOwnPropertyNames(n).length };
}`;
const PAGES = {
  '/': `<!doctype html><title>identity</title><body><script>${REPORT}
window.out = {};
(async () => {
  out.top = await report();
  addEventListener('message', (e) => { if (e.data && e.data.k) out[e.data.k + (e.origin.includes('localhost') ? '-x' : '-s')] = e.data.v; });
  for (const src of ['/frame', 'https://localhost:' + location.port + '/frame']) { const f = document.createElement('iframe'); f.src = src; document.body.appendChild(f); }
  const w = new Worker('/worker.js'); w.onmessage = (e) => { out.worker = e.data; }; w.postMessage('go');
  try { const sw = new SharedWorker('/worker.js'); sw.port.onmessage = (e) => { out.shared = e.data; }; sw.port.start(); sw.port.postMessage('go'); } catch (e) { out.shared = String(e); }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    navigator.serviceWorker.onmessage = (e) => { out.sw = e.data; };
    const ready = await navigator.serviceWorker.ready;
    ready.active.postMessage('go');
  } catch (e) { out.sw = String(e); }
})();
window.openPopup = () => { out.popupState = 'opening'; const p = window.open('/popup', 'signin', 'width=480,height=600'); out.popupState = p ? 'opened' : 'blocked'; };
</script>`,
  '/frame': `<!doctype html><script>${REPORT} report().then((v) => parent.postMessage({ k: 'frame', v }, '*'));</script>`,
  '/worker.js': `${REPORT}
onmessage = async () => postMessage(await report());
onconnect = (e) => { const p = e.ports[0]; p.onmessage = async () => p.postMessage(await report()); };`,
  '/sw.js': `${REPORT}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', async (e) => e.source.postMessage(await report()));`,
  // The sign-in window: reports who it is to the page that opened it, the way an OAuth window
  // hands back its code, and then closes itself.
  '/popup': `<!doctype html><title>Sign in</title><script>${REPORT}
report().then((v) => { window.opener.postMessage({ k: 'popup', v, code: 'cue-ok' }, '*'); setTimeout(() => window.close(), 300); });</script>`,
};

function fixture() {
  const heads = [];
  const srv = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'fixtures', 'localhost-key.pem')), cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'localhost-cert.pem')) }, (req, res) => {
    const p = req.url.split('?')[0];
    heads.push({ path: p, host: req.headers.host, run: (req.headers.cookie || '').replace(/^.*run=([\w-]+).*$/, '$1'), ua: req.headers['user-agent'], chua: req.headers['sec-ch-ua'], platform: req.headers['sec-ch-ua-platform'], mobile: req.headers['sec-ch-ua-mobile'], lang: req.headers['accept-language'], referer: req.headers.referer || '' });
    const body = PAGES[p];
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, heads, port: srv.address().port })));
}
const trustFixture = (ses) => ses.setCertificateVerifyProc((req, cb) => cb(/^(127\.0\.0\.1|localhost)$/.test(req.hostname) ? 0 : -3));

const surfaces = (out) => Object.fromEntries(['top', 'frame-s', 'frame-x', 'worker', 'shared', 'sw', 'popup-s'].map((k) => [k, out[k]]));
function compare(label, out, header, id) {
  const want = brandsOf(id.brands);
  const row = { header: headerBrands(header.chua) };
  for (const [k, v] of Object.entries(surfaces(out))) row[k] = v && typeof v === 'object' ? brandsOf(v.brands) : (v === undefined ? 'no answer' : String(v).slice(0, 60));
  note(`${label}: brands by surface`, row);
  check(`${label}: header says the brands Chromium builds for this version`, row.header === want, { header: row.header, want });
  for (const k of ['top', 'frame-s', 'frame-x', 'worker', 'sw']) check(`${label}: ${k} agrees with the header`, row[k] === row.header, { [k]: row[k], header: row.header });
  // Shared workers sit outside any page and outside every hook Electron 44 has. Recorded, not hidden.
  note(`${label}: shared worker (no hook in Electron 44)`, row.shared);
  const top = out.top || {};
  check(`${label}: no Electron or Cue in the user agent or appVersion`, !/electron|cue/i.test(`${top.ua} ${top.appVersion}`), top.ua);
  check(`${label}: user agent agrees with the header`, top.ua === header.ua, { page: top.ua, header: header.ua });
  check(`${label}: no window.process, no cue/electron names on window`, top.process === false && (top.names || []).length === 0, { process: top.process, names: top.names });
  check(`${label}: navigator itself carries no own properties (nothing redefined on it)`, top.own === 0, top.own);
  check(`${label}: vendor and platform are Chrome's`, top.vendor === 'Google Inc.' && top.platform === id.navigatorPlatform && top.plat === id.platform, { vendor: top.vendor, platform: top.platform, uaPlatform: top.plat });
  const high = top.high || {};
  check(`${label}: high-entropy values match the one identity`, brandsOf(high.fullVersionList) === brandsOf(id.fullVersionList) && high.platformVersion === id.platformVersion && high.architecture === id.architecture && high.bitness === id.bitness,
    { fullVersionList: brandsOf(high.fullVersionList), platformVersion: high.platformVersion, want: id.platformVersion, arch: high.architecture, bitness: high.bitness });
  check(`${label}: toJSON agrees`, top.json === JSON.stringify({ brands: id.brands, mobile: false, platform: id.platform }), top.json);
  const langs = (top.languages || []).join(',');
  const headerLangs = String(header.lang || '').split(',').map((x) => x.split(';')[0].trim()).join(',');
  check(`${label}: Accept-Language agrees with navigator.languages`, langs === headerLangs, { page: langs, header: header.lang });
  const workerLangs = out.worker && out.worker.languages ? out.worker.languages.join(',') : '';
  check(`${label}: a worker's languages agree too`, workerLangs === langs, { worker: workerLangs, page: langs });
}

async function pageIn(ses, url) {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { session: ses, preload: PRELOAD, contextIsolation: true, sandbox: true } });
  win.webContents.loadURL(url).catch(() => {});
  return win;
}

module.exports = async ({ app, tabs, openTab, closeTab, internal, sessionFor, setSetting, signinGate, chromeCarry, addFolder, userFolders }) => {
  // A second folder, as on a two-folder install: a fresh Cue starts with one.
  if (!userFolders().some((x) => x.id === 'school')) addFolder({ id: 'school', name: 'School', color: '#C2410C' });
  fs.mkdirSync(OUT, { recursive: true });
  const id = identity.identity();
  note('the identity Cue says', { userAgent: id.userAgent, brands: brandsOf(id.brands), fullVersionList: brandsOf(id.fullVersionList), platform: id.platform, platformVersion: id.platformVersion, arch: id.architecture, languages: id.languages });
  const { srv, heads, port } = await fixture();
  const base = `https://127.0.0.1:${port}/`;
  try {
    // ------------------------------------------------ 1. three new partitions, every surface
    for (let i = 0; i < 3; i++) {
      const pid = `persist:t${crypto.randomBytes(4).toString('hex')}`;
      const ses = session.fromPartition(pid);
      trustFixture(ses);
      const from = heads.length;
      const win = await pageIn(ses, base);
      const wc = win.webContents;
      const out = await until(async () => { const o = await wc.executeJavaScript('window.out', true); return o && o.top && o['frame-s'] && o['frame-x'] && o.worker && o.sw && o.shared ? o : null; }, 25000)
        || await wc.executeJavaScript('window.out', true).catch(() => ({}));
      const top = heads.slice(from).find((h) => h.path === '/') || {};
      compare(`partition ${pid}`, out || {}, top, id);
      const reqs = heads.slice(from);
      check(`partition ${pid}: every request carried the same Sec-CH-UA`, reqs.length >= 4 && reqs.every((h) => h.chua === top.chua), reqs.map((h) => `${h.path}@${h.host.split(':')[0]}: ${headerBrands(h.chua)}`));
      check(`partition ${pid}: every request carried the same User-Agent`, reqs.every((h) => h.ua === top.ua), [...new Set(reqs.map((h) => h.ua))]);
      win.destroy();
    }

    // ------------------------------------------------ 2. a sign-in pop-up from a real Cue tab
    trustFixture(sessionFor('personal'));
    const from = heads.length;
    const t = openTab({ url: base, identity: 'personal' });
    const twc = await until(() => t.view && t.view.webContents);
    await until(() => twc.executeJavaScript('!!(window.out && window.out.top)', true), 20000);
    // A real click, because a pop-up window is only a pop-up when a person asked for it.
    await twc.executeJavaScript(`(() => { const b = document.createElement('button'); b.id = 'go'; b.textContent = 'Sign in'; b.style.cssText = 'position:fixed;left:10px;top:10px;width:120px;height:40px'; b.onclick = () => window.openPopup(); document.body.appendChild(b); })()`, true);
    let popupWC = null;
    const onNew = (_e, w) => { if (w.getType && w.getType() === 'window') popupWC = w; };
    app.on('web-contents-created', onNew);
    await sleep(300);
    twc.sendInputEvent({ type: 'mouseDown', x: 40, y: 25, button: 'left', clickCount: 1 });
    twc.sendInputEvent({ type: 'mouseUp', x: 40, y: 25, button: 'left', clickCount: 1 });
    let out = await until(async () => { const o = await twc.executeJavaScript('window.out', true); return o && o['popup-s'] ? o : null; }, 15000);
    if (!out) { await twc.executeJavaScript('window.openPopup()', true).catch(() => {}); out = await until(async () => { const o = await twc.executeJavaScript('window.out', true); return o && o['popup-s'] ? o : null; }, 10000); }
    app.removeListener('web-contents-created', onNew);
    out = out || await twc.executeJavaScript('window.out', true).catch(() => ({})) || {};
    const pop = out['popup-s'];
    const popHead = heads.slice(from).find((h) => h.path === '/popup') || {};
    check('pop-up: opened as a window and reported back to its opener', !!pop, out.popupState);
    check('pop-up: its page brands agree with the header it sent', pop && brandsOf(pop.brands) === headerBrands(popHead.chua) && headerBrands(popHead.chua) === brandsOf(id.brands), { page: pop && brandsOf(pop.brands), header: headerBrands(popHead.chua) });
    check('pop-up: its user agent is the same Chrome', pop && pop.ua === id.userAgent && popHead.ua === id.userAgent, { page: pop && pop.ua, header: popHead.ua });
    check('pop-up: stays in the opener’s folder', popupWC && popupWC.session === sessionFor('personal'), popupWC ? 'same session' : 'no window seen');
    await sleep(1200);
    check('pop-up: closed itself after handing back (window.close works)', !popupWC || popupWC.isDestroyed(), popupWC ? popupWC.isDestroyed() : null);
    closeTab(t.id);

    // ------------------------------------------------ 3. the refusal gate cannot spin
    if (signinGate) {
      const g = signinGate();
      const folder = `f${crypto.randomBytes(3).toString('hex')}`;
      const t0 = 1e12;
      check('refusal gate: the first refusal in a folder retries automatically', g.mayRetry(folder, t0) === true);
      check('refusal gate: a second refusal within 10 minutes does not', g.mayRetry(folder, t0 + 60000) === false);
      check('refusal gate: another folder is not held back by this one', g.mayRetry(`${folder}x`, t0 + 60000) === true);
      check('refusal gate: after 10 minutes one more retry is allowed', g.mayRetry(folder, t0 + 10 * 60000 + 1) === true);
    } else check('refusal gate: handle reachable', false, 'signinGate missing from the harness');

    // Clearing a folder's Google state before signing in, and the address hint only when known.
    setSetting('label.school', 'music@nathanielschool.com');
    const ses = sessionFor('school');
    await ses.cookies.set({ url: 'https://accounts.google.com/', name: 'CUE_STALE', value: 'dead', secure: true }).catch(() => {});
    await ses.cookies.set({ url: 'https://mail.google.com/', name: 'CUE_STALE2', value: 'dead', secure: true }).catch(() => {});
    await sessionFor('personal').cookies.set({ url: 'https://accounts.google.com/', name: 'CUE_KEEP', value: 'other-folder', secure: true }).catch(() => {});
    if (!process.env.CUE_OFFLINE) {
      const r = await internal['signin.google']({ identity: 'school' });
      const after = (await ses.cookies.get({})).filter((c) => /CUE_STALE/.test(c.name)).length;
      const kept = (await sessionFor('personal').cookies.get({ name: 'CUE_KEEP' })).length;
      check('signing in empties ONLY that folder’s Google jar', after === 0 && kept === 1, { after, keptInOtherFolder: kept, cleared: r && r.cleared });
      const gTab = await until(() => tabs.filter((x) => /accounts\.google\.com/.test(x.url || '')).pop());
      check('it arrives as the folder’s own address', gTab && /Email=/.test(gTab.url), gTab && gTab.url);
      if (gTab) closeTab(gTab.id);
    }

    // Carrying from Chrome is Meta only, and never silent.
    const carrySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    const carryBlock = (carrySrc.match(/async function carryAllFromChrome[\s\S]*?\n}/) || [''])[0];
    check('Google is not in the Chrome carry', carryBlock.length > 0 && !/googleFromChrome/.test(carryBlock), carryBlock.slice(0, 160));
    check('Meta is still carried', /metaFromChrome/.test(carryBlock), carryBlock.slice(0, 160));
    if (chromeCarry) {
      // Fake Chrome data, never his: two people signed in to Instagram, one profile only visiting.
      const fake = {
        findBrowsers: () => [{ id: 'chrome', profiles: [
          { dir: 'Default', name: 'Asha', email: 'asha@example.com' },
          { dir: 'Profile 1', name: 'Ravi', email: '' },
          { dir: 'Profile 2', name: 'Guest', email: '' }] }],
        getKey: async () => Buffer.alloc(16),
        readCookies: (_b, p) => (p.dir === 'Profile 2'
          ? [{ domain: '.instagram.com', name: 'csrftoken', value: 'x' }]
          : [{ domain: '.instagram.com', name: 'sessionid', value: p.dir }, { domain: '.instagram.com', name: 'ds_user_id', value: '1' }]),
      };
      const { chromeProfilesFor, canCarryFromChrome } = chromeCarry();
      const r = await chromeProfilesFor(/(^|\.)instagram\.com$/i, { importer: fake });
      check('carry: every Chrome profile holding a sign-in is listed for the person to choose', r.profiles && r.profiles.map((p) => p.label).join(' | ') === 'Asha (asha@example.com) | Ravi', r.profiles && r.profiles.map((p) => p.label));
      const none = await chromeProfilesFor(/(^|\.)instagram\.com$/i, { importer: { ...fake, findBrowsers: () => [] } });
      check('carry: no Chrome says so in neutral words', /this computer/.test(none.error || '') && !/Mac/.test(none.error || ''), none.error);
      check('carry: offered only on macOS with Chrome installed', typeof canCarryFromChrome() === 'boolean' && (process.platform === 'darwin' || canCarryFromChrome() === false), canCarryFromChrome());
    }

    if (process.env.CUE_OFFLINE) return;

    // ------------------------------------------------ 4. live Google, three new partitions
    let taps = [];
    identity.tap((url, h) => { if (/^https:\/\/accounts\.google\.com\//.test(url)) taps.push({ url: url.slice(0, 80), chua: h['sec-ch-ua'] || h['Sec-CH-UA'], ua: h['User-Agent'] || h['user-agent'] }); });
    for (let i = 0; i < 3; i++) {
      const pid = `persist:g${crypto.randomBytes(4).toString('hex')}`;
      const label = `Google in ${pid}`;
      let seen = null;
      for (let attempt = 1; attempt <= 2 && !seen; attempt++) {
        taps = [];
        const win = await pageIn(session.fromPartition(pid), 'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F');
        const wc = win.webContents;
        const box = await until(() => wc.executeJavaScript('!!document.querySelector("input[name=identifier], input[type=email]")', true), 30000);
        if (!box) { note(`${label}: attempt ${attempt} no email box`, { url: wc.getURL().slice(0, 120), text: (await wc.executeJavaScript('document.body.innerText', true).catch(() => '')).slice(0, 160) }); win.destroy(); continue; }
        // Typed as keys, like a person, then Next. Only the made-up address; never a password.
        await wc.executeJavaScript('document.querySelector("input[name=identifier], input[type=email]").focus()', true);
        await wc.insertText(NOBODY).catch(() => {});
        await sleep(400);
        const typed = await wc.executeJavaScript('document.querySelector("input[name=identifier], input[type=email]").value', true).catch(() => '');
        note(`${label}: attempt ${attempt} typed`, typed);
        // Next, the way a person presses it (the button), with Enter as the fallback.
        const pressed = await wc.executeJavaScript('(() => { const b = document.querySelector("#identifierNext button, #identifierNext"); if (b) { b.click(); return true; } return false; })()', true).catch(() => false);
        if (!pressed) { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); }
        const end = await until(async () => {
          const u = wc.getURL();
          const txt = await wc.executeJavaScript('document.body.innerText', true).catch(() => '');
          const pw = await wc.executeJavaScript('!!document.querySelector("input[type=password]") && getComputedStyle(document.querySelector("input[type=password]")).visibility !== "hidden"', true).catch(() => false);
          if (pw && /\/challenge\/pwd|Enter your password|password/i.test(`${u} ${txt}`)) return { step: 'password', url: u, text: txt };
          if (/rejected|may not be secure/i.test(`${u} ${txt}`)) return { step: 'refused', url: u, text: txt };
          if (/captcha|unusual traffic|Too many|try again later/i.test(txt)) return { step: 'limited', url: u, text: txt };
          if (/Couldn.t find (your Google Account|this account)/i.test(txt)) return { step: 'no-account', url: u, text: txt };
          return null;
        }, 30000);
        const inPage = await wc.executeJavaScript(`(async () => {
          const f = document.createElement('iframe'); f.src = 'about:blank'; document.body.appendChild(f);
          const frame = f.contentWindow.navigator.userAgentData.brands;
          let worker = 'not tried';
          try {
            const src = 'postMessage(navigator.userAgentData.brands.map((b) => b.brand + "/" + b.version).join(", "))';
            const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            worker = await new Promise((ok) => { w.onmessage = (e) => ok(e.data); w.onerror = (e) => ok('refused by the page: ' + (e.message || 'error')); setTimeout(() => ok('no answer'), 4000); });
          } catch (e) { worker = 'refused by the page: ' + e.message; }
          return { page: navigator.userAgentData.brands.map((b) => b.brand + '/' + b.version).join(', '), frame: frame.map((b) => b.brand + '/' + b.version).join(', '), worker, ua: navigator.userAgent };
        })()`, true).catch((e) => ({ error: e.message }));
        const head = taps.find((x) => /AccountChooser|signin|v3/.test(x.url)) || taps[0] || {};
        seen = end ? { ...end, inPage, head } : null;
        note(`${label}: attempt ${attempt}`, { step: end && end.step, url: end && end.url.slice(0, 110), words: end && end.text.replace(/\s+/g, ' ').slice(0, 140), header: headerBrands(head.chua), ...inPage });
        await wc.capturePage().then((img) => fs.writeFileSync(path.join(OUT, `google-${i}-${attempt}.png`), img.toPNG())).catch(() => {});
        win.destroy();
        if (seen && seen.step === 'limited') break; // honest: recorded, not hammered
      }
      // A made-up address has no account, so Google's honest answer after Next is "Couldn't find
      // this account" - which proves the form was served, the address step was accepted and judged
      // on the ACCOUNT, not the browser. "Enter your password" needs a real account, and none is
      // created or used here.
      check(`${label}: Google serves the form and judges the address, not the browser (no password typed)`, seen && (seen.step === 'password' || seen.step === 'no-account'), seen ? { step: seen.step, words: seen.text.replace(/\s+/g, ' ').slice(0, 120) } : 'no answer');
      if (seen && seen.inPage && !seen.inPage.error) {
        const h = headerBrands(seen.head.chua);
        check(`${label}: Sec-CH-UA Google received = page = iframe`, h === seen.inPage.page && h === seen.inPage.frame && h === brandsOf(id.brands), { header: h, page: seen.inPage.page, frame: seen.inPage.frame });
        check(`${label}: a worker agrees (or the page's own rules refused one)`, seen.inPage.worker === h || /^refused by the page/.test(seen.inPage.worker), seen.inPage.worker);
      }
    }
    identity.tap(null);

    // Google's refusal address, for real, in a folder tab: one automatic clear-and-retry, then the
    // help page - never a third go, never a loop.
    const rj = 'https://accounts.google.com/signin/rejected?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F';
    await sessionFor('school').cookies.set({ url: 'https://accounts.google.com/', name: 'CUE_DEAD', value: 'x', secure: true }).catch(() => {});
    const rt = openTab({ url: rj, identity: 'school' });
    const rwc = await until(() => rt.view && rt.view.webContents);
    const retried = await until(() => { const u = rwc.getURL(); return /accounts\.google\.com\/(AccountChooser|v3\/signin|ServiceLogin|signin\/v2)/.test(u) && !/rejected/.test(u) ? u : null; }, 30000);
    const dead = (await sessionFor('school').cookies.get({ name: 'CUE_DEAD' })).length;
    check('refusal: the first one clears that folder and retries by itself', !!retried && dead === 0, { url: (retried || rwc.getURL()).slice(0, 110), deadCookieLeft: dead });
    rwc.loadURL(rj).catch(() => {});
    const help = await until(() => (rwc.getURL().startsWith('cue://signin-blocked') ? rwc.getURL() : null), 30000);
    check('refusal: a second one within 10 minutes shows the help page instead', !!help, rwc.getURL().slice(0, 110));
    const words = help ? await rwc.executeJavaScript('document.body.innerText', true).catch(() => '') : '';
    check('help page: plain words, what to try, no blame, never "Google rejects Cue"', /date and time/i.test(words) && /try again/i.test(words) && /different Google account/i.test(words) && !/reject|not secure|Cue is|your fault/i.test(words), words.replace(/\s+/g, ' ').slice(0, 160));
    await sleep(3000);
    check('refusal: no third automatic attempt', rwc.getURL().startsWith('cue://signin-blocked'), rwc.getURL().slice(0, 80));
    closeTab(rt.id);

    // ------------------------------------------------ 5. WhatsApp in three partitions
    if (process.env.CUE_SKIP_WHATSAPP) return;
    const was = [];
    for (let i = 0; i < 3; i++) {
      const pid = `persist:w${crypto.randomBytes(4).toString('hex')}`;
      const ses = session.fromPartition(pid);
      const win = await pageIn(ses, 'https://web.whatsapp.com/');
      was.push({ pid, ses, win });
    }
    for (const w of was) {
      const wc = w.win.webContents;
      const shown = await until(async () => {
        const txt = await wc.executeJavaScript('document.body.innerText', true).catch(() => '');
        const qr = await wc.executeJavaScript('(() => { const c = document.querySelector("canvas"); const r = c && c.getBoundingClientRect(); const ref = document.querySelector("[data-ref]"); return { canvas: !!(r && r.width > 100), ref: ref ? ref.getAttribute("data-ref") : "" }; })()', true).catch(() => ({}));
        if (/update (your )?browser|browser is not supported|unsupported browser/i.test(txt)) return { refused: true, txt };
        if (qr.canvas || /log in|link|scan|steps to log in/i.test(txt) && qr.canvas) return { txt, qr };
        return null;
      }, 45000);
      await wc.executeJavaScript(`localStorage.setItem('cue-probe-mark', ${JSON.stringify(w.pid)})`, true).catch(() => {});
      w.shown = shown;
      await wc.capturePage().then((img) => fs.writeFileSync(path.join(OUT, `whatsapp-${w.pid.slice(8)}.png`), img.toPNG())).catch(() => {});
      check(`WhatsApp in ${w.pid}: shows its own link screen, not "update your browser"`, shown && !shown.refused && shown.qr && shown.qr.canvas, shown ? { words: shown.txt.replace(/\s+/g, ' ').slice(0, 120), canvas: shown.qr && shown.qr.canvas } : 'nothing drawn');
    }
    const marks = await Promise.all(was.map((w) => w.win.webContents.executeJavaScript(`localStorage.getItem('cue-probe-mark')`, true).catch(() => null)));
    const refs = was.map((w) => (w.shown && w.shown.qr && w.shown.qr.ref) || '');
    check('WhatsApp: the three partitions keep apart storage', marks.every((m, i) => m === was[i].pid) && new Set(was.map((w) => w.ses.getStoragePath())).size === 3, { marks, paths: was.map((w) => path.basename(w.ses.getStoragePath() || '')) });
    check('WhatsApp: three different link codes', refs.every(Boolean) && new Set(refs).size === 3, refs.map((r) => r.split('#')[1] ? `#${r.split('#')[1].slice(0, 10)}…` : r));
    was.forEach((w) => w.win.destroy());

    check('control: a failing check is visible (expected FAIL below)', false, 'this one is meant to fail');
  } catch (e) {
    check('the test itself ran', false, e.stack);
  } finally {
    srv.close();
    fs.writeFileSync(path.join(OUT, 'signin-results.json'), JSON.stringify(results, null, 1));
    done(app);
  }
};

function done(app) {
  const real = results.filter((r) => !r.note);
  const pass = real.filter((r) => r.ok).length;
  console.log(`[cue-signin] DONE ${pass}/${real.length} passed${process.env.CUE_OFFLINE ? '' : ' (1 deliberate failure expected)'}`);
  setTimeout(() => app.quit(), 500);
}
