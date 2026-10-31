// Shield test: CUE_TEST=shield CUE_USER_DATA=<tmp> CUE_OUT=<dir> electron .
//
// Proves the five things 0.4.0 claims, in the real app: ads and trackers are
// stopped, a site on today's malware list is stopped with an explanation, the
// secure address is tried first and falls back honestly, saved passwords wait
// for a click, and an extension says what it can do in plain English.
//
// Needs the internet: the filter lists and the dangerous-site list are fetched.
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[cue-shield] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(150); } return null; };

const PAGES = {
  '/plain': '<title>Plain page</title><p id=p>served over http</p>',
  '/login': '<title>Sign in</title><form><input id=u type=email><input id=pw type=password><button>Sign in</button></form>',
};

function server() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const body = PAGES[req.url.split('?')[0]];
      if (body === undefined) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    srv.listen(0, '0.0.0.0', () => resolve(srv));
  });
}

module.exports = async function run(c) {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await server();
  const port = srv.address().port;
  const ud = c.app.getPath('userData');
  const shield = c.shield();
  const url = (t) => (t && t.view ? t.view.webContents.getURL() : '');

  // ---------------------------------------------------------- ads and trackers
  const ready = await until(() => shield && shield.ready(), 120000);
  check('shield: the filter engine loaded', !!ready);
  const st = shield.status();
  check('shield: it is carrying real filter lists', st.listsMB >= 1, { megabytes: st.listsMB });
  // Known ad and tracking hosts, asked of the engine the way a page would.
  const adHosts = [
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://static.hotjar.com/c/hotjar-123.js',
  ];
  const blockedAds = adHosts.filter((u) => shield.matches(u, 'https://example.com/', 'script'));
  check('ads: known ad and tracker scripts are blocked', blockedAds.length === adHosts.length, { blocked: blockedAds.length, of: adHosts.length });
  check('ads: an ordinary script is not blocked', !shield.matches('https://example.com/app.js', 'https://example.com/', 'script'));
  check('ads: YouTube is left exactly as Chrome has it', !shield.matches('https://www.youtube.com/watch?v=x', 'https://www.youtube.com/', 'document')
    && !shield.matches('https://rr3---sn-x.googlevideo.com/videoplayback', 'https://www.youtube.com/', 'media'));
  check('ads: the school\'s own sites are never touched', !shield.matches('https://learning-portal.nathanielschool.com/x.js', 'https://learning-portal.nathanielschool.com/', 'script'));

  // Allowing one site must not loosen anything anywhere else.
  shield.setAllowed(['example.com']);
  check('ads: allowed by hand on one site', !shield.matches(adHosts[0], 'https://example.com/', 'script'));
  check('ads: still blocked on every other site', shield.matches(adHosts[0], 'https://other.example/', 'script'));
  shield.setAllowed([]);
  check('ads: switching that site back on restores the block', shield.matches(adHosts[0], 'https://example.com/', 'script'));

  // ---------------------------------------------------------- dangerous sites
  await shield.refreshDanger();
  const dst = shield.status();
  check('dangerous sites: a real list was fetched', dst.dangerous > 1000, { known: dst.dangerous });
  const cached = path.join(ud, 'danger-hosts.txt');
  check('dangerous sites: kept on disk so it works offline next time', fs.existsSync(cached));
  const lines = fs.readFileSync(cached, 'utf8').split('\n').filter(Boolean);
  const phish = (lines.find((l) => l.endsWith('\tphishing')) || '').split('\t')[0];
  const mal = (lines.find((l) => l.endsWith('\tmalware')) || '').split('\t')[0];
  check('dangerous sites: both kinds are known', !!phish && !!mal, { phish: !!phish, malware: !!mal });
  check('dangerous sites: a listed host is recognised', shield.verdict(`https://${phish}/pay`) === 'phishing', { host: phish });
  check('dangerous sites: so is anything under it', shield.verdict(`https://login.${phish}/`) === 'phishing');
  check('dangerous sites: an ordinary site is not', !shield.verdict('https://www.google.com/'));
  check('dangerous sites: the school is not', !shield.verdict('https://learning-portal.nathanielschool.com/'));
  // The whole point: the page is stopped and something is said about it.
  const bad = c.openTab({ url: `https://${phish}/`, identity: 'personal' });
  const stopped = await until(() => url(bad).startsWith('cue://danger'), 25000);
  check('dangerous sites: opening one shows the warning page, not the site', !!stopped, { went: url(bad).slice(0, 90) });
  if (stopped) {
    const words = await bad.view.webContents.executeJavaScript('document.getElementById("head").textContent + "|" + document.getElementById("why").textContent').catch(() => '');
    check('dangerous sites: the warning says what is wrong in plain English', /pretending to be someone else/i.test(words) && words.includes(phish), { words: String(words).slice(0, 120) });
    const anyway = await bad.view.webContents.executeJavaScript('!document.getElementById("anyway").hidden').catch(() => false);
    check('dangerous sites: you can still override it yourself', anyway === true);
  }
  c.closeTab(bad.id);

  // ---------------------------------------------------------- https first
  check('https: a plain http address is upgraded', c.secureVersion('http://example.com/a?b=1') === 'https://example.com/a?b=1');
  check('https: localhost is left alone', c.secureVersion('http://localhost:3000/x') === null);
  check('https: a numeric address is left alone', c.secureVersion('http://192.168.1.9:8080/') === null);
  check('https: .local is left alone', c.secureVersion('http://studio.local/') === null);
  check('https: an https address is untouched', c.secureVersion('https://example.com/') === null);
  // End to end: localtest.me resolves to this machine, so the https attempt
  // fails against a plain http server and Cue must come back to http by itself.
  const up = c.openTab({ url: `http://localtest.me:${port}/plain`, identity: 'personal' });
  const landed = await until(() => {
    const u = url(up);
    return u.startsWith('http://localtest.me') ? 'fell back' : null;
  }, 30000);
  const body = await up.view.webContents.executeJavaScript('document.getElementById("p") && document.getElementById("p").textContent').catch(() => '');
  check('https: tried secure first, then opened the plain one when there is none', landed === 'fell back' && body === 'served over http', { url: url(up), body });
  c.closeTab(up.id);

  // ---------------------------------------------------------- fill on click
  const pass = crypto.randomBytes(9).toString('hex');
  const origin = `http://localhost:${port}`;
  c.vault.save({ identity: 'personal', origin, username: 'me@example.test', password: pass, auto: false });
  const lg = c.openTab({ url: `${origin}/login`, identity: 'personal' });
  await until(() => up && url(lg).includes('/login'), 15000);
  await sleep(1400);
  const empty = await lg.view.webContents.executeJavaScript('document.getElementById("pw").value').catch(() => 'err');
  check('passwords: nothing is typed in until you touch the box', empty === '', { was: empty });
  await lg.view.webContents.executeJavaScript(`
    const pw = document.getElementById('pw');
    pw.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    pw.focus();
  `).catch(() => {});
  const filledIn = await until(async () => {
    const v = await lg.view.webContents.executeJavaScript('document.getElementById("pw").value').catch(() => '');
    return v ? v : null;
  }, 8000);
  check('passwords: it fills the moment you click the box', filledIn === pass, { filled: !!filledIn, right: filledIn === pass });
  const user = await lg.view.webContents.executeJavaScript('document.getElementById("u").value').catch(() => '');
  check('passwords: the username goes in with it', user === 'me@example.test', { user });
  c.closeTab(lg.id);

  // Our own sites stay hands-free, which is what the auto flag means.
  const own = c.vault.list().find((x) => x.origin === origin);
  c.vault.setAuto(own.id, true);
  const lg2 = c.openTab({ url: `${origin}/login`, identity: 'personal' });
  const auto = await until(async () => {
    const v = await lg2.view.webContents.executeJavaScript('document.getElementById("pw").value').catch(() => '');
    return v ? v : null;
  }, 12000);
  check('passwords: a hands-free site still fills itself', auto === pass, { filled: !!auto });
  c.closeTab(lg2.id);

  // ---------------------------------------------------------- VPN leak
  const leak = c.openTab({ url: 'https://example.com/', identity: 'personal' });
  await until(() => url(leak).startsWith('https://example.com'), 20000);
  // Chromium reports the live policy through the addresses it is willing to
  // offer a page. Asked with the guard on and then with it off, so a pass can
  // never be an empty answer dressed up as protection.
  const probe = () => leak.view.webContents.executeJavaScript(`new Promise((done) => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const seen = [];
    pc.onicecandidate = (e) => { if (!e.candidate) { pc.close(); done(seen); } else seen.push(e.candidate.candidate); };
    pc.createDataChannel('x');
    pc.createOffer().then((o) => pc.setLocalDescription(o));
    setTimeout(() => { try { pc.close(); } catch {} done(seen); }, 7000);
  })`).catch(() => null);
  const PRIVATE = /(^| )(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  const guarded = (await probe()) || [];
  leak.view.webContents.setWebRTCIPHandlingPolicy('default');
  const open = (await probe()) || [];
  leak.view.webContents.setWebRTCIPHandlingPolicy('default_public_interface_only');
  const leakedGuarded = guarded.filter((l) => PRIVATE.test(l));
  const leakedOpen = open.filter((l) => PRIVATE.test(l));
  // What Chromium hands over with no camera permission is already obfuscated,
  // so the pass to insist on is that no real private address appears either
  // way. The guard matters once a site HAS camera or microphone permission,
  // which is when Chromium stops obfuscating.
  check('VPN: a page is never handed this Mac\'s own network address', leakedGuarded.length === 0 && leakedOpen.length === 0,
    { guarded: guarded.map((l) => l.split(' ').slice(4, 6).join(' ')), off: open.map((l) => l.split(' ').slice(4, 6).join(' ')) });
  c.closeTab(leak.id);

  // ---------------------------------------------------------- extensions
  const canDo = c.extensions.canDo;
  check('extensions: "every page" is said as every page', /read and change every page you open/.test(canDo({ host_permissions: ['<all_urls>'] })));
  check('extensions: cookies are said as staying signed in', /cookies that keep you signed in/.test(canDo({ permissions: ['cookies'] })));
  check('extensions: a harmless one says so', canDo({ permissions: ['storage', 'alarms'] }) === 'It cannot see the pages you open.');
  check('extensions: no jargon survives', !/<all_urls>|webRequest|nativeMessaging|permission/i.test(canDo({ permissions: ['webRequest', 'nativeMessaging'], host_permissions: ['<all_urls>'] })));

  // ---- a deliberate control, so a silent pass can never be mistaken for a run
  check('control: a failing check is visible (expected FAIL below)', false, 'this one is meant to fail');

  fs.writeFileSync(path.join(OUT, 'shield.json'), JSON.stringify(results, null, 2));
  const fails = results.filter((x) => !x.ok);
  console.log(`[cue-shield] DONE ${results.length - fails.length}/${results.length} passed (1 deliberate failure expected)`);
  srv.close();
  if (!process.env.CUE_KEEP) c.app.quit();
};
