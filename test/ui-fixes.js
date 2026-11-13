// Fixes from 13-Nov-2026: CUE_QUIET=1 CUE_TEST=ui-fixes CUE_USER_DATA=<new dir> CUE_OUT=<new dir> CUE_AGENT_PORT=<free port> npx electron .
// - the link buttons (start page and address bar) open their site when nothing is typed, and still search typed words
// - the folder passcode is a switch in Settings: off by default, on asks for one, off asks for the current one
// - Boards never sleeps, and coming back to it does not rebuild its pictures
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`[cue-ui-fixes] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(100); } return null; };

// Where a tab TRIES to go, caught before the network is used.
function watchGo(wc) {
  const seen = [];
  const fn = (e) => { if (e.isMainFrame) { seen.push(e.url); if (/^https?:/.test(e.url)) e.preventDefault(); } };
  wc.on('will-frame-navigate', fn);
  wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !seen.includes(e.url)) seen.push(e.url); });
  return seen;
}

module.exports = async (c) => {
  try {
    await c.app.whenReady();
    await sleep(1500);
    const ui = (code) => c.ui().webContents.executeJavaScript(code, true);
    const shot = async (name, wc) => { try { fs.writeFileSync(path.join(OUT, `${name}.png`), (await wc.capturePage()).toPNG()); } catch {} };

    // ---- the start page's buttons
    const st = c.openTab({ identity: 'personal' });
    await until(() => st.view && !st.view.webContents.isLoading() && /start\.html/.test(st.view.webContents.getURL()), 10000); await sleep(300);
    let seen = watchGo(st.view.webContents);
    await st.view.webContents.executeJavaScript("[...document.querySelectorAll('#engines button')].find(b => b.textContent === 'YouTube').click()", true);
    await until(() => seen.length, 3000);
    check('start page: YouTube with nothing typed opens YouTube', seen.some((u) => /^https:\/\/www\.youtube\.com\/$/.test(u)), seen);
    seen.length = 0;
    await st.view.webContents.executeJavaScript("document.getElementById('q').value = 'ii V I'; [...document.querySelectorAll('#engines button')].find(b => b.textContent === 'YouTube').click()", true);
    await until(() => seen.length, 3000);
    check('control: with words typed it still searches them', seen.some((u) => /youtube\.com\/results\?search_query=ii%20V%20I/.test(u)), seen);
    seen.length = 0;
    await st.view.webContents.executeJavaScript("document.getElementById('q').value = ''; [...document.querySelectorAll('#engines button')].find(b => b.textContent === 'Ask Claude').click()", true);
    await until(() => seen.length, 3000);
    check('start page: Ask Claude with nothing typed opens Claude', seen.some((u) => /^https:\/\/claude\.ai\/new$/.test(u)), seen);

    // ---- the address bar's buttons
    const tab = c.openTab({ identity: 'personal' });
    c.activate(tab.id);
    await until(() => tab.view && !tab.view.webContents.isLoading(), 10000); await sleep(500);
    seen = watchGo(tab.view.webContents);
    // the box focused shows the page's own address, all selected: that is not something typed
    await ui("(() => { const o = document.getElementById('omnibox'); o.focus(); o.value = 'https://web.whatsapp.com/#!'; o.select(); document.querySelector('#engines button[data-engine=\"pinterest\"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1; })()");
    await until(() => seen.length, 4000);
    check('address bar: Pinterest over the page\'s own address opens Pinterest', seen.some((u) => /^https:\/\/www\.pinterest\.com\/?$/.test(u)), seen);
    seen.length = 0;
    await ui("(() => { const o = document.getElementById('omnibox'); o.focus(); o.value = 'chord charts'; o.setSelectionRange(12, 12); document.querySelector('#engines button[data-engine=\"pinterest\"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1; })()");
    await until(() => seen.length, 4000);
    check('control: words typed in the address bar are searched on Pinterest', seen.some((u) => /pinterest\.com\/search\/pins\/\?q=chord/.test(u)), seen);

    // ---- the folder passcode switch
    await ui("openSettings('folders'); 1");
    await sleep(800);
    const sw = await ui("(() => [...document.querySelectorAll('.fcard')].map(card => { const l = [...card.querySelectorAll('label')].find(x => /Ask for a passcode/.test(x.textContent)); const i = l && document.getElementById(l.htmlFor); return i ? i.checked : null; }))()");
    check('Settings: every folder has a passcode switch', sw.length > 0 && sw.every((x) => x !== null), sw);
    check('...and it is off by default', sw.every((x) => x === false), sw);
    await ui(`(() => { const card = document.querySelector('.fcard'); const l = [...card.querySelectorAll('label')].find(x => /Ask for a passcode/.test(x.textContent)); const i = document.getElementById(l.htmlFor); i.checked = true; i.dispatchEvent(new Event('change')); return 1; })()`);
    await sleep(300);
    const box = await ui("(() => { const card = document.querySelector('.fcard'); const p = card.querySelector('.lockbox input[type=password]'); return p ? p.placeholder : ''; })()");
    check('turning it on asks for a new passcode', /New passcode/.test(box), box);
    await shot('settings-passcode-on', c.ui().webContents);
    await ui("(() => { const card = document.querySelector('.fcard'); const p = card.querySelector('.lockbox input[type=password]'); p.value = 'pass-1234'; [...card.querySelectorAll('.lockbox button')].find(b => b.textContent === 'Turn on').click(); return 1; })()");
    const first = await until(() => c.store.data.folders.find((f) => f.lock) || null, 4000);
    check('...and typing one turns the passcode on', !!first, first && first.id);
    await sleep(500);
    const on = await ui("(() => { const card = [...document.querySelectorAll('.fcard')][0]; const l = [...card.querySelectorAll('label')].find(x => /Ask for a passcode/.test(x.textContent)); return document.getElementById(l.htmlFor).checked; })()");
    check('the switch shows on after that', on === true, on);
    await ui(`(() => { const card = document.querySelector('.fcard'); const l = [...card.querySelectorAll('label')].find(x => /Ask for a passcode/.test(x.textContent)); const i = document.getElementById(l.htmlFor); i.checked = false; i.dispatchEvent(new Event('change')); return 1; })()`);
    await sleep(300);
    await ui("(() => { const card = document.querySelector('.fcard'); const p = card.querySelector('.lockbox input[type=password]'); p.value = 'wrong-one'; [...card.querySelectorAll('.lockbox button')].find(b => b.textContent === 'Turn off').click(); return 1; })()");
    await sleep(600);
    check('turning it off with the wrong passcode leaves it on', !!(first && c.store.data.folders.find((f) => f.id === first.id).lock));
    await ui("(() => { const card = document.querySelector('.fcard'); const p = card.querySelector('.lockbox input[type=password]'); p.value = 'pass-1234'; [...card.querySelectorAll('.lockbox button')].find(b => b.textContent === 'Turn off').click(); return 1; })()");
    await until(() => first && !c.store.data.folders.find((f) => f.id === first.id).lock, 4000);
    check('...and with the right one turns it off', !!(first && !c.store.data.folders.find((f) => f.id === first.id).lock));
    await ui("closeModal && closeModal(); 1").catch(() => {});

    // ---- Boards
    c.store.data.settings.sleepMinutes = 0;
    const b = c.openTab({ url: 'cue://boards', identity: 'personal' });
    await until(() => b.view && !b.view.webContents.isLoading(), 10000); await sleep(600);
    const other = c.openTab({ url: 'about:blank', identity: 'personal' });
    c.activate(other.id); b.lastActive = 0; await sleep(300);
    // the sleep sweep runs on a timer; ask it the same question it asks
    check('Boards is never put to sleep', c.mustStayAwake ? c.mustStayAwake(b) : true, b.url);
    check('control: an ordinary tab may still sleep', c.mustStayAwake && !c.mustStayAwake(other), other.url);
    const marker = await b.view.webContents.executeJavaScript("document.getElementById('main').dataset.k = 'kept'; 1", true).catch(() => 0);
    c.activate(b.id); await sleep(800);
    const kept = await b.view.webContents.executeJavaScript("document.getElementById('main').dataset.k || ''", true).catch(() => '');
    check('coming back to Boards keeps the page it had (no reload)', marker && kept === 'kept', kept);
  } catch (e) {
    check('the suite ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  }
  fs.writeFileSync(path.join(OUT, 'ui-fixes.json'), JSON.stringify(results, null, 2));
  const fails = results.filter((x) => !x.ok);
  console.log(`[cue-ui-fixes] DONE ${results.length - fails.length}/${results.length} passed`);
  setTimeout(() => c.app.exit(0), 300);
};
