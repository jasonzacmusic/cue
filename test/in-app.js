// In-app test run: CUE_TEST=1 CUE_USER_DATA=<tmp> CUE_OUT=<dir> electron .
// Opens our real apps, exercises volume, split views and the on-air stage, and saves window pictures.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
fs.mkdirSync(OUT, { recursive: true });
const report = [];
const log = (k, v) => { report.push({ k, v }); console.log(`[cue-test] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`); };

let C = null;
async function shoot(win, name) {
  // Composite the window from its views' own pictures (no screen-recording permission needed).
  try {
    const { BrowserWindow } = require('electron');
    const [w, h] = win.getContentSize();
    const layers = [];
    for (const v of win.contentView.children) {
      if (!v.getVisible || !v.getVisible()) continue;
      const b = v.getBounds();
      let img = null;
      for (let i = 0; i < 6 && !img; i++) { try { img = await v.webContents.capturePage(); if (img.isEmpty()) img = null; } catch { await sleep(300); } }
      if (!img && v === C.ui()) img = await uiPicture(b);
      if (!img) { log('view-not-captured', { name, url: v.webContents.getURL().slice(0, 60) }); continue; }
      layers.push({ x: b.x, y: b.y, w: b.width, h: b.height, src: img.toDataURL() });
    }
    const bw = new BrowserWindow({ show: false, width: w, height: h, webPreferences: { offscreen: true } });
    await bw.loadURL('data:text/html,<canvas id=c></canvas>');
    const data = await bw.webContents.executeJavaScript(`(async () => {
      const L = ${JSON.stringify(layers)}; const c = document.getElementById('c'); c.width = ${w}; c.height = ${h};
      const x = c.getContext('2d'); x.fillStyle = '#888'; x.fillRect(0, 0, ${w}, ${h});
      for (const l of L) { const i = new Image(); i.src = l.src; await i.decode(); x.drawImage(i, l.x, l.y, l.w, l.h); }
      return c.toDataURL('image/png');
    })()`);
    bw.destroy();
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    log('picture', file);
  } catch (e) { log('picture-failed', `${name}: ${e.message}`); }
}

// Cue's own sidebar view can't be captured while the window is in the background, so draw a twin
// offscreen with the same page, the same preload and the last state the app sent it.
let lastState = null;
async function uiPicture(b) {
  const { BrowserWindow } = require('electron');
  const root = path.join(__dirname, '..', 'src');
  const bw = new BrowserWindow({ show: false, width: b.width, height: b.height, webPreferences: { offscreen: true, preload: path.join(root, 'preload', 'ui.js'), contextIsolation: true, sandbox: false } });
  bw.setBackgroundColor('#00000000');
  await bw.loadFile(path.join(root, 'ui', 'index.html'));
  bw.webContents.send('ui:state', lastState);
  await sleep(700);
  const img = await bw.webContents.capturePage();
  bw.destroy();
  return img.isEmpty() ? null : img;
}

async function waitLoaded(t, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (t.view && !t.view.webContents.isLoading() && t.view.webContents.getURL()) return true; await sleep(150); }
  return false;
}

module.exports = async function run(c) {
  const t0 = Date.now();
  C = c;
  const uwc = c.ui().webContents; const origSend = uwc.send.bind(uwc);
  uwc.send = (ch, ...a) => { if (ch === 'ui:state') lastState = a[0]; return origSend(ch, ...a); };
  c.app.focus({ steal: true }); c.win().setAlwaysOnTop(true);
  await sleep(800);
  log('window', { visible: c.win().isVisible(), bounds: c.win().getBounds(), focused: c.win().isFocused(), ui: c.ui().getBounds() });
  const first = c.tabs[0];
  await waitLoaded(first);
  log('first-page-ms', Date.now() - t0);

  const sites = [
    'https://chord-trees.nathanielschool.com',
    'https://binary-arithmetic.nathanielschool.com',
    'https://learning-portal.nathanielschool.com',
    'https://apps.nathanielschool.com',
    'https://www.youtube.com/@nathanielmusicschool',
    'https://www.google.com/search?q=G+major+scale+piano',
    'https://accounts.google.com/',
    'https://www.pinterest.com/search/pins/?q=piano%20chord%20chart',
    'https://claude.ai/',
    'https://vercel.com/pricing',
  ];
  const opened = [];
  for (const url of sites) opened.push(c.openTab({ url, background: true }));
  for (const t of opened) {
    const ok = await waitLoaded(t);
    const wc = t.view.webContents;
    const title = wc.getTitle();
    let blocked = false;
    try { blocked = await wc.executeJavaScript('document.body ? /browser or app may not be secure|unsupported browser|upgrade your browser/i.test(document.body.innerText) : false'); } catch {}
    log('site', { url: t.url, loaded: ok, title, group: c.byId(t.id) && require('../src/main/groups').groupFor(wc.getURL()), blockedNotice: blocked });
  }

  // audio + volume: a page that plays a quiet tone through an <audio> element and Web Audio
  const tone = 'data:text/html,' + encodeURIComponent(`<title>Tone test</title><audio id=a loop src="data:audio/wav;base64,${wav()}"></audio><button id=b onclick="document.getElementById('a').play()">play</button><script>document.getElementById('a').volume=0.8</script>`);
  const tt = c.openTab({ url: tone });
  await waitLoaded(tt);
  const wc = tt.view.webContents;
  await wc.executeJavaScript('document.getElementById("a").play().then(()=>true).catch(e=>e.message)', true).then((r) => log('tone-play', r));
  await sleep(1200);
  log('tone-audible', c.byId(tt.id).audible);
  c.setVolume(c.byId(tt.id), 0.25);
  await sleep(300);
  const eff = await wc.executeJavaScript('window.__cue ? window.__cue.effective() : "no hook"', true).catch((e) => e.message);
  const pageSees = await wc.executeJavaScript('document.getElementById("a").volume', true);
  log('volume-after-25pct', { underlying: eff, pageSees });
  c.setMuted(c.byId(tt.id), true);
  log('muted', tt.view.webContents.isAudioMuted());
  c.setMuted(c.byId(tt.id), false);
  wc.send('cue:media', 'pause');
  await sleep(500);
  log('paused', await wc.executeJavaScript('document.getElementById("a").paused', true));

  // sidebar + single view
  c.activate(opened[0].id);
  await sleep(1500);
  await shoot(c.win(), '01-single');

  // split views
  for (const mode of ['cols2', 'rows2', 'cols3', 'grid4']) {
    c.setSplit(mode);
    await sleep(1800);
    log('split', { mode, panes: c.getState().panes.length });
    await shoot(c.win(), `02-${mode}`);
  }
  c.setSplit('single');

  // live: cue chord trees, take it, then cue rhythm arithmetic
  c.setLive(true);
  await sleep(800);
  c.activate(opened[0].id);
  c.take();
  await sleep(1500);
  const st = c.stage();
  log('stage', { exists: !!st, title: st && st.getTitle(), size: st && st.getContentSize(), program: c.getState().programId === opened[0].id });
  c.activate(opened[1].id);
  await sleep(1500);
  await shoot(c.win(), '03-live-main');
  if (st) await shoot(st, '04-stage');
  c.take();
  await sleep(1200);
  log('after-second-take', { program: c.getState().programId === opened[1].id, cued: c.getState().activeId === opened[0].id });

  // memory
  const metrics = c.app.getAppMetrics();
  const mb = Math.round(metrics.reduce((s, m) => s + (m.memory ? m.memory.workingSetSize : 0), 0) / 1024);
  log('memory-mb-total', { mb, processes: metrics.length, tabs: c.tabs.length });

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  if (!process.env.CUE_KEEP) c.app.quit();
};

function wav() {
  const rate = 8000; const n = rate; const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 392 * i / rate) * 1500), 44 + i * 2);
  return buf.toString('base64');
}
