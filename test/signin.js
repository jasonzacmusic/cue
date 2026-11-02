// Sign-in test: CUE_TEST=signin CUE_USER_DATA=<tmp> CUE_OUT=<dir> electron .
//
// Proves how signing in to Google works inside Cue: the folder's stale Google cookies are emptied
// first - that dead jar, not the browser, is what Google refuses - and Google's own form is then
// served to Cue normally.
//
// Needs the internet: it opens Google's real sign-in page. No password is ever typed.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[cue-signin] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };
const until = async (fn, ms = 40000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(200); } return null; };

const NOBODY = 'cue.browser.check@gmail.com'; // a made-up address: no account, no password, no risk

module.exports = async ({ app, tabs, openTab, byId, internal, sessionFor, setSetting }) => {
  try {
    // Google does NOT refuse Cue's engine. Probed 2-Nov-2026: a clean session reaches "Enter your
    // password" under a Chrome, Firefox or Safari identity alike. What it refuses is a folder still
    // holding the cancelled remains of the Chrome carry - ~128 dead cookies in each folder that
    // day - so signing in has to empty that jar first. These checks pin exactly that.
    setSetting('label.school', 'music@nathanielschool.com');
    const ses = sessionFor('school');
    await ses.cookies.set({ url: 'https://accounts.google.com/', name: 'CUE_STALE', value: 'dead', secure: true }).catch(() => {});
    await ses.cookies.set({ url: 'https://mail.google.com/', name: 'CUE_STALE2', value: 'dead', secure: true }).catch(() => {});
    const before = (await ses.cookies.get({})).filter((c) => /google/.test(c.domain || '')).length;
    check('a folder can be left holding stale Google cookies', before >= 2, before);

    const r = await internal['signin.google']({ identity: 'school' });
    const after = (await ses.cookies.get({})).filter((c) => /CUE_STALE/.test(c.name)).length;
    check('signing in empties that folder\u2019s Google jar', after === 0, { before, after, cleared: r && r.cleared });

    const gTab = await until(() => tabs.filter((x) => /accounts\.google\.com/.test(x.url || '')).pop());
    const gUrl = gTab ? gTab.url : '';
    check('a folder can open Google\u2019s own sign-in page', /accounts\.google\.com/.test(gUrl), gUrl);
    check('it arrives as the folder\u2019s own address', /Email=/.test(gUrl), gUrl);

    // And Google really does serve the form to Cue, rather than the dead end.
    const gwc = gTab && gTab.view && gTab.view.webContents;
    if (gwc) {
      await until(() => gwc.executeJavaScript('!!document.querySelector("input[name=identifier], input[type=email]")'), 30000);
      const refused = /signin\/rejected|deniedsigninrejected/i.test(gwc.getURL());
      const form = await gwc.executeJavaScript('!!document.querySelector("input[name=identifier], input[type=email]")').catch(() => false);
      check('Google serves Cue the real sign-in form, not the dead end', form && !refused, gwc.getURL().slice(0, 90));
    }

    // The page only ever comes up for Google's refusal, not for an ordinary Google page.
    const ok = openTab({ url: 'https://www.google.com/', identity: 'personal' });
    await until(() => ok.view.webContents.getURL().startsWith('https://www.google.com'));
    await sleep(2500);
    check('an ordinary Google page is left alone', !ok.view.webContents.getURL().startsWith('cue://'), ok.view.webContents.getURL());

    // The other two sites he lives in. Each identity is its own jar, so a personal WhatsApp in one
    // and the school's in the other are two separate links, not one fighting the other.
    const ig = openTab({ url: 'https://www.instagram.com/accounts/login/', identity: 'personal' });
    await until(() => ig.view.webContents.getURL().includes('instagram.com'));
    await sleep(4000);
    const igText = await until(() => ig.view.webContents.executeJavaScript('document.body.innerText')) || '';
    check('Instagram: Cue gets the real sign-in page', /log in|phone number, username|password/i.test(igText) && !/not supported|update your browser/i.test(igText), igText.slice(0, 80));

    const wa = openTab({ url: 'https://web.whatsapp.com/', identity: 'personal' });
    await until(() => wa.view.webContents.getURL().includes('whatsapp.com'));
    await sleep(9000);
    const waText = await until(() => wa.view.webContents.executeJavaScript('document.body.innerText')) || '';
    const waShape = await wa.view.webContents.executeJavaScript('JSON.stringify({canvas: !!document.querySelector("canvas"), imgs: document.querySelectorAll("img").length})').catch(() => '{}');
    // WhatsApp's own "Download WhatsApp for Mac" banner sits above the code and is not a refusal,
    // so the check looks for the words it uses when it will not run at all.
    check('WhatsApp: Cue is not turned away as an old browser', !/update (your )?browser|browser is not supported|unsupported browser|isn.t supported/i.test(waText), waText.slice(0, 120));
    check('WhatsApp: the link-a-phone code is drawn', /link|scan|qr|steps to log in/i.test(waText) || /"canvas":true/.test(waShape), waShape);

    const waSchool = openTab({ url: 'https://web.whatsapp.com/', identity: 'school' });
    await until(() => waSchool.view.webContents.getURL().includes('whatsapp.com'));
    await sleep(3000);
    const jars = await Promise.all(['personal', 'school'].map(async (id) => (await sessionFor(id).cookies.get({ domain: 'web.whatsapp.com' })).length));
    check('WhatsApp: personal and the school keep separate jars', sessionFor('personal') !== sessionFor('school'), jars);

    // Google's cookies must never be carried from Chrome again. Copying them revoked both folders'
    // sign-ins on 2-Nov-2026 and left them on accounts.google.com/CookieMismatch, and because his
    // Chrome holds both his Google accounts in one profile, the copy made the two folders identical.
    const carrySrc = String(require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8'));
    const carryBlock = (carrySrc.match(/async function carryAllFromChrome[\s\S]*?\n}/) || [''])[0];
    check('Google is not in the Chrome carry', carryBlock.length > 0 && !/googleFromChrome/.test(carryBlock), carryBlock.slice(0, 200));
    check('Meta is still carried', /metaFromChrome/.test(carryBlock), carryBlock.slice(0, 200));

    check('control: a failing check is visible (expected FAIL below)', false, 'this one is meant to fail');
  } catch (e) {
    check('the test itself ran', false, e.message);
  }
  done(app);
};

function done(app) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`[cue-signin] DONE ${pass}/${results.length} passed (1 deliberate failure expected)`);
  setTimeout(() => app.quit(), 500);
}
