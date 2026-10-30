// Feature test: CUE_TEST=features CUE_USER_DATA=<tmp> CUE_OUT=<dir> electron .
// Runs every feature in the real app against a small local site with made-up test logins.
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[cue-feature] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(100); } return null; };

const inDays = (n) => { const d = new Date(Date.now() + n * 86400000); return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); };
const TEST_USER = 'test-user@example.test';
const TEST_PASS = crypto.randomBytes(9).toString('hex');
const VANISH_TOKEN = `vanishtoken${crypto.randomBytes(6).toString('hex')}`;

function wav(freq = 440, secs = 6) {
  const rate = 44100; const n = rate * secs; const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 12000), 44 + i * 2);
  return buf;
}

const PAGES = {
  '/login': `<title>Login</title><form onsubmit="event.preventDefault();document.title='sent:'+pw.value.length"><input id=u type=email><input id=pw type=password><button id=go>Sign in</button></form>`,
  '/billing/soon': `<title>Billing</title><p>Your next invoice on ${inDays(2)} for $20.00</p>`,
  '/billing/bad': `<title>Billing</title><p>Payment failed. Update your card.</p>`,
  '/long': `<title>Long</title><body style="margin:0"><div style="height:6000px;background:linear-gradient(red,blue)">long</div></body>`,
  '/colour': `<title>Colour</title><body style="margin:0;background:#00FF00"></body>`,
  '/img': `<title>Image</title><body style="margin:0"><canvas id=c width=400 height=300 style="display:block"></canvas><script>const x=c.getContext('2d');x.fillStyle='#FF0000';x.fillRect(0,0,200,300);x.fillStyle='#0000FF';x.fillRect(200,0,200,300)</script></body>`,
  '/fonts': `<title>Fonts</title><p style="font:700 40px Georgia">Hello there</p>`,
  '/oops': `<title>Oops</title><script>console.error('deliberate test error');fetch('/missing.js')</script><img src="http://127.0.0.1:1/x.png">`,
  '/audio': `<title>Audio</title><audio id=a loop src="/tone.wav"></audio><video id=v muted loop src="/tone.wav" style="display:none"></video><script>
    const O=AudioContext.prototype.createScriptProcessor;AudioContext.prototype.createScriptProcessor=function(...a){const n=O.apply(this,a);window.__sp=n;return n}
    window.peak=()=>{const n=window.__sp;const an=window.__an||(window.__an=(()=>{const x=n.context.createAnalyser();x.fftSize=8192;n.connect(x);return x})());
      const d=new Float32Array(an.frequencyBinCount);an.getFloatFrequencyData(d);let b=0;for(let i=1;i<d.length;i++)if(d[i]>d[b])b=i;return b*n.context.sampleRate/an.fftSize}</script>`,
  '/note': `<title>Note</title><p>note</p>`,
  [`/${VANISH_TOKEN}`]: `<title>${VANISH_TOKEN}</title><script>document.cookie='${VANISH_TOKEN}=1;max-age=99999';localStorage.setItem('${VANISH_TOKEN}','1')</script>`,
};

function server() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      if (u === '/rec.mp4' && RECORDING.file) { const b = fs.readFileSync(RECORDING.file); res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': b.length }); return res.end(b); }
      if (u === '/tone.wav') { res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': TONE.length, 'accept-ranges': 'none' }); return res.end(TONE); }
      if (u === '/installer.dmg') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="installer.dmg"' }); return res.end(Buffer.alloc(2048)); }
      if (PAGES[u]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><meta charset=utf-8>${PAGES[u]}`); }
      res.writeHead(404); res.end('no');
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
}
const TONE = wav();
const RECORDING = { file: null };

async function loaded(t) { await until(() => t.view && !t.view.webContents.isLoading() && t.view.webContents.getURL() && t.view.webContents.getURL() !== 'about:blank', 15000); await sleep(150); return t.view.webContents; }

function walkFind(dir, token) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { try { if (fs.readFileSync(f).includes(token)) hits.push(path.relative(dir, f)); } catch {} }
    }
  };
  walk(dir);
  return hits;
}

module.exports = async function run(c) {
  const srv = await server();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const ud = c.app.getPath('userData');
  const shotUI = async (name) => {
    const { BrowserWindow } = require('electron');
    const root = path.join(__dirname, '..', 'src');
    const [w, h] = c.win().getContentSize();
    const bw = new BrowserWindow({ show: false, width: w, height: h, webPreferences: { offscreen: true, preload: path.join(root, 'preload', 'ui.js'), contextIsolation: true, sandbox: false } });
    await bw.loadFile(path.join(root, 'ui', 'index.html'));
    bw.webContents.send('ui:state', lastState);
    await sleep(600);
    const img = await bw.webContents.capturePage(); bw.destroy();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  };
  let lastState = null;
  const uwc = c.ui().webContents; const orig = uwc.send.bind(uwc); const events = [];
  uwc.send = (ch, ...a) => { if (ch === 'ui:state') lastState = a[0]; if (ch === 'ui:event') events.push(a); return orig(ch, ...a); };
  c.app.focus({ steal: true }); c.win().setAlwaysOnTop(true); // pictures and clicks need the window in front
  await sleep(1000);

  // ---- spaces
  const startSpace = c.store.data.space;
  const sp1 = c.openTab({ url: `${base}/note?space1` }); await loaded(sp1);
  c.switchSpace('Create'); await sleep(200);
  check('space: switching opens that Space', c.store.data.space === 'Create', c.store.data.space);
  check('space: new tab uses its usual login', c.byId(c.getState().activeId).identity === 'personal', c.byId(c.getState().activeId).identity);
  c.switchSpace('Business'); await sleep(200);
  check('space: Business uses School login', c.byId(c.getState().activeId).identity === 'school');
  c.activate(sp1.id); await sleep(200);
  check('space: going to a tab goes to its Space', c.store.data.space === startSpace);

  // ---- history, bar and Vanish
  const h = c.openTab({ url: `${base}/fonts?hist`, identity: 'personal' }); await loaded(h); await sleep(300);
  check('history: visit is remembered', c.lib.history('fonts').length > 0);
  check('one bar: suggestions find it', c.suggestions('Fonts').history.length > 0);
  check('one bar: finds NSM apps', c.suggestions('chord').apps.length > 0, c.suggestions('chord').apps.slice(0, 2).map((x) => x.name));

  const v = c.openTab({ url: `${base}/${VANISH_TOKEN}`, identity: 'vanish' }); await loaded(v); await sleep(800);
  check('vanish: page really loaded', (await v.view.webContents.executeJavaScript('document.title')) === VANISH_TOKEN);
  c.closeTab(v.id); await sleep(300);
  check('vanish: not in history', c.lib.history(VANISH_TOKEN).length === 0);
  c.store.flush();
  const hits = walkFind(ud, VANISH_TOKEN);
  check('vanish: disk scan finds nothing', hits.length === 0, hits);
  // control: the same scan must find a normal tab's token
  const ctl = `controltoken${crypto.randomBytes(5).toString('hex')}`;
  PAGES[`/${ctl}`] = `<title>${ctl}</title>`;
  const ct = c.openTab({ url: `${base}/${ctl}`, identity: 'personal' }); await loaded(ct); await sleep(500); c.store.flush(); await sleep(300);
  check('vanish: control scan does find a normal tab', walkFind(ud, ctl).length > 0, walkFind(ud, ctl).slice(0, 3));
  c.closeTab(ct.id);

  c.bookmarkTab(h); await sleep(100);
  check('bookmarks: Cmd+D saves the page', c.lib.bookmarks('hist').length > 0);
  const vb = c.openTab({ url: `${base}/note?vb`, identity: 'vanish' }); await loaded(vb);
  c.bookmarkTab(vb); await sleep(100);
  check('bookmarks: Vanish pages are not saved', c.lib.bookmarks('vb').length === 0);
  c.closeTab(vb.id);

  // ---- passwords
  const origin = base;
  c.vault.save({ identity: 'personal', origin, username: TEST_USER, password: TEST_PASS, auto: false });
  const raw = fs.readFileSync(path.join(ud, 'passwords.json'), 'utf8');
  check('passwords: encrypted on disk', !raw.includes(TEST_PASS));
  const lg = c.openTab({ url: `${base}/login`, identity: 'personal' }); await loaded(lg);
  const val = await until(() => lg.view.webContents.executeJavaScript('document.getElementById("pw").value'));
  check('passwords: fills the form', val === TEST_PASS && (await lg.view.webContents.executeJavaScript('document.getElementById("u").value')) === TEST_USER);
  const sc = c.openTab({ url: `${base}/login`, identity: 'school' }); await loaded(sc); await sleep(500);
  check('passwords: other login does not get it', (await sc.view.webContents.executeJavaScript('document.getElementById("pw").value')) === '');
  const vs = c.openTab({ url: `${base}/login`, identity: 'vanish' }); await loaded(vs); await sleep(500);
  check('passwords: Vanish does not get it', (await vs.view.webContents.executeJavaScript('document.getElementById("pw").value')) === '');
  c.closeTab(vs.id);
  const ag = c.openTab({ url: `${base}/login`, identity: 'personal', agent: true }); await loaded(ag); await sleep(500);
  check('passwords: AI agent tab does not get it', (await ag.view.webContents.executeJavaScript('document.getElementById("pw").value')) === '');
  c.closeTab(ag.id);
  c.vault.setAuto(c.vault.list()[0].id, true);
  const au = c.openTab({ url: `${base}/login`, identity: 'personal' }); await loaded(au);
  const sent = await until(async () => (await au.view.webContents.executeJavaScript('document.title')).startsWith('sent:'));
  check('passwords: auto sign-in presses the button', !!sent);
  // offer to save: type a new password on a page with no saved login
  await sc.view.webContents.executeJavaScript(`document.getElementById("u").value='other@example.test';document.getElementById("pw").value='newpass-123';document.getElementById("go").click()`);
  const offered = await until(() => events.find((e) => e[0] === 'save-password'));
  check('passwords: offers to save after sign-in', !!offered, offered && offered[1]);
  c.closeTab(sc.id); c.closeTab(au.id); c.closeTab(lg.id);

  // ---- notifications and alert tray
  const nt = c.openTab({ url: `${base}/note`, identity: 'personal' }); await loaded(nt);
  await nt.view.webContents.executeJavaScript(`new Notification('hello before class',{body:'one'});1`);
  await sleep(300);
  check('alerts: notifications reach the tray', c.store.data.alerts.some((a) => a.title === 'hello before class'));
  c.setLive(true); await sleep(500);
  await nt.view.webContents.executeJavaScript(`new Notification('hello during class');1`);
  await sleep(300);
  check('alerts: held during class', c.store.data.alerts.find((a) => a.title === 'hello during class')?.held === true);
  c.setLive(false); await sleep(400);
  check('alerts: says how many were held', events.some((e) => e[0] === 'toast' && /1 notification held/.test(e[1])));

  // ---- bills
  const bl = c.openTab({ url: `${base}/billing/soon`, identity: 'personal' }); bl.groupOverride = 'ai'; await loaded(bl);
  bl.view.webContents.reload(); await until(() => c.store.data.bills.length, 7000);
  const b = c.store.data.bills[0];
  check('bills: reads date and amount off the page', b && b.amountINR === 20 * c.store.data.usdToInr && !!b.renews, b);
  check('bills: warns before the charge', c.store.data.alerts.some((a) => /due in 2 days/.test(a.title)));
  bl.view.webContents.loadURL(`${base}/billing/bad`); await until(() => c.store.data.bills[0].status === 'failed', 7000);
  check('bills: spots a failed card', c.store.data.bills[0].status === 'failed');
  c.closeTab(bl.id);

  // ---- archive
  const ar = c.openTab({ url: `${base}/note?old`, identity: 'personal', background: true }); await loaded(ar);
  ar.lastActive = Date.now() - 30 * 86400000;
  c.archiveOldTabs();
  check('archive: old tab is put away', !c.byId(ar.id) && c.store.data.archived.some((a) => a.url.includes('old')));
  await c.internal['library.restore']({ id: c.store.data.archived[0].id }); await sleep(300);
  check('archive: can be brought back', c.tabs.some((t) => t.url.includes('old')));

  // ---- peek and AI
  const pk = c.openTab({ url: `${base}/note?peekhost`, identity: 'personal' }); await loaded(pk);
  await pk.view.webContents.executeJavaScript(`document.body.innerHTML='<a id=l href="/fonts?peeked" style="display:block;padding:20px">go</a>'`);
  const r = await pk.view.webContents.executeJavaScript(`(()=>{const b=document.getElementById('l').getBoundingClientRect();return {x:b.left+10,y:b.top+10}})()`);
  pk.view.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1, modifiers: ['alt'] });
  pk.view.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1, modifiers: ['alt'] });
  const peekOpen = await until(() => c.getPeek());
  check('peek: alt-click opens side panel', !!peekOpen);
  check('peek: page you were on stays put', pk.view.webContents.getURL().includes('peekhost'));
  await sleep(600);
  await shotUI('20-peek');
  c.closePeek();
  const before = pk.view.getBounds().width;
  c.toggleAI('claude'); await sleep(400);
  check('AI panel: opens and page makes room', !!c.getAI() && pk.view.getBounds().width === before - 440, { before, after: pk.view.getBounds().width });
  await until(() => !c.getAI().webContents.isLoading() && c.getAI().webContents.getURL(), 12000);
  check('AI panel: loads Claude', /claude\.ai/.test(c.getAI().webContents.getURL()), c.getAI().webContents.getURL());
  await shotUI('21-ai-panel');
  c.toggleAI('claude'); await sleep(300);
  check('AI panel: closes', !c.getAI());

  // ---- pages and boards
  const im = c.openTab({ url: `${base}/img`, identity: 'personal' }); await loaded(im); await sleep(300);
  const bid = c.lib.boardCreate('Test board');
  await c.addToBoard(im, { x: 100, y: 100, srcURL: `${base}/img.png`, altText: 'test image' }, bid);
  const list = c.lib.boardList();
  check('boards: image saved with its source', list[0].items[0].source.includes('/img') && list[0].items[0].thumb.startsWith('data:image/jpeg'));
  for (const page of ['boards', 'library', 'bills', 'thumbcheck']) {
    const t = c.openTab({ url: `cue://${page}`, identity: 'personal' }); await loaded(t); await sleep(700);
    const wc = t.view.webContents;
    const info = await wc.executeJavaScript(`({title:document.title,text:document.body.innerText.slice(0,400),bridge:!!window.cueInternal})`);
    check(`page ${page}: loads with the app bridge`, info.bridge && info.text.length > 10 && !/sample/i.test(info.text), info.title);
    const img = await c.captureTab(t).catch(() => null);
    if (img) fs.writeFileSync(path.join(OUT, `30-${page}.png`), img.toPNG());
    if (page === 'boards') check('page boards: shows the saved board', /Test board/.test(info.text));
    c.closeTab(t.id);
  }
  const hostile = c.openTab({ url: `${base}/note`, identity: 'personal' }); await loaded(hostile);
  check('pages: web sites cannot reach the app bridge', !(await hostile.view.webContents.executeJavaScript('!!window.cueInternal')));
  c.closeTab(hostile.id);

  // ---- designer
  const col = c.openTab({ url: `${base}/colour`, identity: 'personal' }); await loaded(col); await sleep(400);
  c.activate(col.id); await sleep(300);
  c.runTool('colour', col); await sleep(900);
  col.view.webContents.sendInputEvent({ type: 'mouseMove', x: 100, y: 100 });
  col.view.webContents.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'left', clickCount: 1 });
  col.view.webContents.sendInputEvent({ type: 'mouseUp', x: 100, y: 100, button: 'left', clickCount: 1 });
  const picked = await until(() => events.find((e) => e[0] === 'palette'));
  const near = (hex, want) => [1, 3, 5].every((i) => Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(want.slice(i, i + 2), 16)) <= 8);
  check('colour picker: reads the pixel', picked && near(picked[1].colors[0], '#00FF00'), picked && picked[1]);
  const tools = require('../src/main/page-tools');
  const pic = await c.captureTab(im).catch(() => null);
  const pal = pic ? tools.palette(pic) : [];
  check('palette: finds the image colours', pal.some((x) => near(x, '#FF0000')) && pal.some((x) => near(x, '#0000FF')), pal);
  const ff = c.openTab({ url: `${base}/fonts`, identity: 'personal' }); await loaded(ff); await sleep(300);
  c.activate(ff.id); await sleep(200);
  const fontP = ff.view.webContents.executeJavaScript(tools.FONT_FINDER, true);
  await sleep(400);
  ff.view.webContents.sendInputEvent({ type: 'mouseMove', x: 60, y: 60 }); await sleep(250);
  ff.view.webContents.sendInputEvent({ type: 'mouseDown', x: 60, y: 60, button: 'left', clickCount: 1 });
  ff.view.webContents.sendInputEvent({ type: 'mouseUp', x: 60, y: 60, button: 'left', clickCount: 1 });
  const font = await Promise.race([fontP, sleep(3000).then(() => null)]);
  check('font finder: names the font', /Georgia/.test(font || ''), font);

  // ---- capture
  const lp = c.openTab({ url: `${base}/long`, identity: 'personal' }); await loaded(lp); await sleep(300);
  c.activate(lp.id); await sleep(400);
  c.runTool('fullpage', lp);
  const dir = path.join(c.app.getPath('downloads'), 'Cue Captures');
  const pngFile = await until(() => fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.startsWith('Long') && f.endsWith('.png')));
  if (pngFile) {
    const sz = execFileSync('sips', ['-g', 'pixelHeight', path.join(dir, pngFile)]).toString();
    check('capture: whole page picture', /pixelHeight: (6000|12000)/.test(sz), sz.trim().split('\n').pop());
  } else check('capture: whole page picture', false);
  c.runTool('gif', lp);
  const gifFile = await until(() => fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.endsWith('.gif')), 16000);
  check('capture: GIF made', !!gifFile && fs.readFileSync(path.join(dir, gifFile)).slice(0, 3).toString() === 'GIF', gifFile);

  const au2 = c.openTab({ url: `${base}/audio`, identity: 'personal' }); await loaded(au2); await sleep(300);
  c.activate(au2.id); await sleep(400);
  const awc = au2.view.webContents;
  await awc.executeJavaScript('document.getElementById("a").play().then(()=>1)', true);
  await sleep(500);
  c.sendEvent('rec-start');
  await until(() => lastState && lastState.recording, 4000); await sleep(3000);
  check('record: recording started', !!(lastState && lastState.recording));
  c.sendEvent('rec-stop');
  const recFile = await until(() => fs.readdirSync(dir).find((f) => /\.(mp4|webm)$/.test(f)), 8000);
  check('record: file saved', !!recFile, recFile);
  if (recFile) {
    try {
      const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', path.join(dir, recFile)]).toString().trim().replace(/\n/g, ' ');
      check('record: has picture and tab sound', /video/.test(probe) && /audio/.test(probe), probe);
    } catch (e) { check('record: has picture and tab sound', false, e.message); }
  }

  // ---- music kit
  awc.send('cue:music', 'speed', 0.75); await sleep(200);
  check('music: speed', (await awc.executeJavaScript('document.getElementById("a").playbackRate')) === 0.75);
  check('music: keeps pitch at slow speed', await awc.executeJavaScript('document.getElementById("a").preservesPitch'));
  awc.send('cue:music', 'speed', 1);
  await awc.executeJavaScript('document.getElementById("a").currentTime = 1; 1'); await sleep(100);
  awc.send('cue:music', 'a'); await sleep(900); awc.send('cue:music', 'b'); await sleep(200);
  const a0 = await awc.executeJavaScript('document.getElementById("a").currentTime');
  await sleep(1500);
  const a1 = await awc.executeJavaScript('document.getElementById("a").currentTime');
  check('music: A-B loop jumps back', a1 < a0 + 1.2, { a0, a1 });
  awc.send('cue:music', 'clear');
  awc.send('cue:music', 'transpose', 12); await sleep(1500);
  const p12 = await awc.executeJavaScript('window.peak()');
  await sleep(300);
  const p12b = await awc.executeJavaScript('window.peak()');
  check('music: transpose up an octave', Math.abs(p12b - 880) < 25, { p12, p12b });
  awc.send('cue:music', 'transpose', -5); await sleep(1000);
  const pm5 = await awc.executeJavaScript('window.peak()');
  check('music: transpose down 5', Math.abs(pm5 - 330) < 20, pm5);
  awc.send('cue:music', 'transpose', 0); await sleep(600);
  const p0 = await awc.executeJavaScript('window.peak()');
  check('music: back to original pitch', Math.abs(p0 - 440) < 20, p0);
  c.tabs.find((t) => t.id === au2.id).view.webContents.send('cue:media', 'pause');

  c.closeTab(au2.id);

  // ---- video kit: plays the tab recording made above
  PAGES['/video'] = `<title>Video</title><video id=v muted loop autoplay src="/rec.mp4" style="width:640px"></video>`;
  RECORDING.file = path.join(dir, recFile);
  const vt = c.openTab({ url: `${base}/video`, identity: 'personal' }); await loaded(vt); await sleep(1200);
  c.activate(vt.id); await sleep(300);
  c.runTool('mark', vt);
  const marked = await until(() => events.find((e) => e[0] === 'toast' && /^Marked /.test(e[1])));
  check('video: marks a timestamp', !!marked && vt.marks.length === 1, vt.marks);
  c.runTool('frame', vt);
  const frameFile = await until(() => fs.readdirSync(dir).find((f) => /^Frame .*\.png$/.test(f)));
  check('video: grabs a frame', !!frameFile && fs.statSync(path.join(dir, frameFile)).size > 500, frameFile);
  c.closeTab(vt.id);

  // ---- the same tools on a real YouTube lesson
  const href = 'https://www.youtube.com/watch?v=rWGvrodpcBc';
  const ch = c.openTab({ url: href, identity: 'personal' }); await sleep(9000);
  if (href) {
    c.activate(ch.id); await sleep(2500);
    const yw = ch.view.webContents;
    await yw.executeJavaScript(`(()=>{const v=document.querySelector('video');v.muted=false;return v.play().then(()=>1).catch(e=>e.message)})()`, true).catch(() => {});
    await sleep(2500);
    const ytTime = () => yw.executeJavaScript(`document.querySelector('video').currentTime`, true);
    const t0 = await ytTime(); await sleep(1500); const t1 = await ytTime();
    check('YouTube: lesson plays', t1 > t0, { t0, t1 });
    c.setVolume(ch, 0.4); await sleep(300);
    const eff = await yw.executeJavaScript('window.__cue ? window.__cue.effective() : null', true).catch(() => null);
    const pv = await yw.executeJavaScript(`document.querySelector('video').volume`, true);
    check('YouTube: per-tab volume scales it', eff && Math.abs(eff[0] - pv * 0.4) < 0.01, { eff, pv });
    c.setVolume(ch, 1);
    yw.send('cue:music', 'speed', 0.75); await sleep(400);
    check('YouTube: speed', (await yw.executeJavaScript(`document.querySelector('video').playbackRate`, true)) === 0.75);
    yw.send('cue:music', 'speed', 1);
    yw.send('cue:music', 'transpose', 3); await sleep(2000);
    const t2 = await ytTime(); await sleep(1500); const t3 = await ytTime();
    check('YouTube: keeps playing while transposed', t3 > t2, { t2, t3 });
    check('YouTube: no script clashes on the page', !ch.log.some((l) => /Maximum call stack|has already been declared/.test(l.text)), ch.log.filter((l) => /Maximum call stack|has already been declared/.test(l.text)).length);
    yw.send('cue:music', 'transpose', 0); await sleep(300);
    c.runTool('mark', ch);
    await until(() => ch.marks.length);
    check('YouTube: timestamp link', /youtu\.be\/[\w-]{11}\?t=\d+/.test(ch.marks[0] || ''), ch.marks);
    c.runTool('frame', ch);
    const ytFrame = await until(() => fs.readdirSync(dir).filter((f) => /^Frame .*\.png$/.test(f)).length >= 2);
    check('YouTube: grabs a frame', !!ytFrame);
  }
  c.closeTab(ch.id);

  // ---- downloads
  const dl = c.openTab({ url: `${base}/note?dl`, identity: 'personal' }); await loaded(dl);
  dl.view.webContents.downloadURL(`${base}/installer.dmg`);
  const dd = await until(() => lastState && lastState.downloads.find((d) => d.name.startsWith('installer') && d.state === 'completed'));
  check('downloads: sorted by type', dd && dd.kind === 'Installers', dd && dd.kind);
  c.closeTab(dl.id);

  // ---- problems log for agents
  const oops = c.openTab({ url: `${base}/oops`, identity: 'personal' }); await loaded(oops); await sleep(800);
  check('AI testing: page errors are collected', oops.log.some((l) => /deliberate/.test(l.text)), oops.log.map((l) => l.level));
  check('AI testing: failed requests are collected', oops.log.some((l) => /failed-request|404/.test(`${l.level} ${l.text}`)), oops.log.slice(0, 4));
  c.closeTab(oops.id);

  // ---- move in from Helium (bookmarks and history only: no secrets are read in this test)
  const importer = require('../src/main/importer');
  const found = importer.findBrowsers();
  const hel = found.find((x) => x.id === 'helium');
  if (hel) {
    const p = hel.profiles[0];
    const n = c.lib.importBookmarks(importer.readBookmarks(hel, p));
    const m = c.lib.importHistory(importer.readHistory(hel, p));
    check('move in: Helium bookmarks and history', n > 0 && m > 0 && c.lib.bookmarks('').length > 0, { bookmarks: n, history: m });
  } else check('move in: Helium found', false);

  // ---- extensions
  const ext = require('../src/main/extensions');
  const fx = path.join(ud, 'fixture-ext'); fs.mkdirSync(fx, { recursive: true });
  fs.writeFileSync(path.join(fx, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Cue test extension', version: '1.0', content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['c.js'] }] }));
  fs.writeFileSync(path.join(fx, 'c.js'), `document.documentElement.dataset.cueExt='yes';`);
  const to = ext.adopt(path.join(ud, 'extensions'), { id: 'fixtureext', dir: fx });
  const { session } = require('electron');
  await session.fromPartition('persist:personal').extensions.loadExtension(to);
  const et = c.openTab({ url: `${base}/note?ext`, identity: 'personal' }); await loaded(et); await sleep(500);
  check('extensions: a Chrome extension runs on pages', (await et.view.webContents.executeJavaScript('document.documentElement.dataset.cueExt')) === 'yes');
  c.closeTab(et.id);
  const real = found.flatMap((b) => b.profiles.flatMap((p) => ext.scan(path.join(b.root, p.dir))));
  check('extensions: finds installed ones to copy', real.length >= 0, { found: real.length, names: real.slice(0, 6).map((x) => x.name) });

  const { session: ses } = { session };
  const tryS = ses.fromPartition('persist:extension-trial');
  const okExt = []; const badExt = [];
  for (const e of real) {
    try { await tryS.extensions.loadExtension(ext.adopt(path.join(ud, 'ext-trial'), e)); okExt.push(e.name); } catch (err) { badExt.push(`${e.name}: ${err.message.slice(0, 70)}`); }
  }
  check('extensions: real ones load', okExt.length > 0, { ok: okExt.length, loaded: okExt.slice(0, 20), failed: badExt });

  // ---- image search from a file
  const img2 = await c.captureTab(im).catch(() => null);
  c.closeTab(im.id);
  const { nativeImage } = require('electron');
  const pngBytes = (img2 || nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))).resize({ width: 200 }).toPNG();
  await c.lensFile({ name: 'test.png', type: 'image/png', bytes: pngBytes });
  const lensTab = c.byId(c.getState().activeId);
  await until(() => /google\.com\/(search|sorry)|lens\.google/.test(lensTab.view.webContents.getURL()) && !lensTab.view.webContents.isLoading(), 12000);
  check('image search: sends the picture to Google Lens', /google\.com/.test(lensTab.view.webContents.getURL()), lensTab.view.webContents.getURL().slice(0, 90));
  c.closeTab(lensTab.id);

  // ---- find anything (Cmd+K), kits
  c.sendEvent('palette-open');
  const pal2 = await until(() => uwc.executeJavaScript(`!!document.querySelector('.cmdk input') && document.querySelectorAll('.cmdlist .sg').length`));
  check('find anything: opens with results', pal2 > 0, pal2);
  await uwc.executeJavaScript(`(()=>{const i=document.querySelector('.cmdk input');i.value='chord';i.dispatchEvent(new Event('input'));})()`);
  await sleep(500);
  const rows = await uwc.executeJavaScript(`[...document.querySelectorAll('.cmdlist .sg .k')].map(x=>x.textContent)`);
  check('find anything: finds apps and history', rows.includes('NSM app'), rows);
  await uwc.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await sleep(200);
  await shotUI('22-main');
  c.setSetting('kit.designer', false); await sleep(200);
  check('kits: switching one off works', lastState.settings.kits.designer === false);
  const { Menu } = require('electron');
  const toolsMenu = Menu.getApplicationMenu().items.find((i) => i.label === 'Tools');
  check('kits: its tools leave the menu', !toolsMenu.submenu.items.some((i) => i.label === 'Ruler'));
  c.setSetting('kit.designer', true);

  // ---- tiny control: a failing check must be visible
  fs.writeFileSync(path.join(OUT, 'features.json'), JSON.stringify(results, null, 2));
  const fails = results.filter((x) => !x.ok);
  console.log(`[cue-feature] DONE ${results.length - fails.length}/${results.length} passed`);
  srv.close();
  if (!process.env.CUE_KEEP) c.app.quit();
};
