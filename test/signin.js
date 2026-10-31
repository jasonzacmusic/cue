// Sign-in test: CUE_TEST=signin CUE_USER_DATA=<tmp> CUE_OUT=<dir> electron .
//
// Proves what 0.5.3 claims about Google: when Google refuses to sign you in inside Cue - the
// "this browser or app may not be secure" dead end - Cue takes over the page, says what happened
// in plain English, and offers to carry the sign-in over from Chrome.
//
// Needs the internet: it walks Google's real sign-in as far as the refusal, with a made-up address
// and no password.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[cue-signin] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };
const until = async (fn, ms = 40000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(200); } return null; };

const NOBODY = 'cue.browser.check@gmail.com'; // a made-up address: no account, no password, no risk

module.exports = async ({ app, openTab, byId, internal }) => {
  try {
    const t = openTab({ url: 'https://accounts.google.com/ServiceLogin?service=mail', identity: 'personal' });
    const wc = t.view.webContents;
    await until(() => wc.getURL().includes('signin'));
    await sleep(3000);

    const box = await until(() => wc.executeJavaScript(`(()=>{const i=document.querySelector('#identifierId, input[type=email]');if(!i)return null;const b=i.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`));
    if (!box) {
          }
    check('Google still offers its sign-in form', !!box);
    if (!box) { done(app); return; }

    wc.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(300);
    for (const ch of NOBODY) { wc.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(90); }
    await sleep(600);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

    const landed = await until(() => (wc.getURL().startsWith('cue://signin-blocked') ? wc.getURL() : null), 45000);
    check('Google’s dead end is replaced by Cue’s own page', !!landed, wc.getURL());

    if (landed) {
      const text = await until(() => wc.executeJavaScript('document.body.innerText'));
      check('it says what happened, in plain English', /would not sign you in/i.test(text) && !/secure browser/i.test(text), String(text).slice(0, 90));
      const btn = await wc.executeJavaScript(`(()=>{const b=document.getElementById('bring');return b&&!b.hidden?b.textContent:null})()`);
      check('it offers to bring the sign-in over from Chrome', /Chrome/.test(btn || ''), btn);
      check('the tab is still the one you opened', byId(t.id) === t);
    }

    // The page only ever comes up for Google's refusal, not for an ordinary Google page.
    const ok = openTab({ url: 'https://www.google.com/', identity: 'personal' });
    await until(() => ok.view.webContents.getURL().startsWith('https://www.google.com'));
    await sleep(2500);
    check('an ordinary Google page is left alone', !ok.view.webContents.getURL().startsWith('cue://'), ok.view.webContents.getURL());

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
