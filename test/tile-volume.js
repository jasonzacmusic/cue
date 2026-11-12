// Volume on the pinned apps:
//   CUE_QUIET=1 CUE_AGENT_PORT=18861 CUE_TEST=tile-volume CUE_USER_DATA=<new dir> CUE_OUT=<new dir> electron .
//   then the same again with CUE_PHASE=2 and the SAME CUE_USER_DATA, to prove it survives a restart.
//
// Driven with real input events sent into the sidebar (wheel, mouse, keys), never with
// synthetic DOM events, and the page's real media volume is read back - the volume the
// element actually plays at, and what a WebAudio graph actually renders - not what the
// page is told. Pictures of the tile are saved to CUE_OUT so the level mark can be looked at.
const fs = require('fs');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
fs.mkdirSync(OUT, { recursive: true });
const PHASE = process.env.CUE_PHASE || '1';
const PORT = (Number(process.env.CUE_AGENT_PORT) || 18861) + 1;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[cue-tilevol] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };

// A page with a looping tone in a <video autoplay>, and a way to start a second one
// later, so "the moment it starts playing" is tested for an element made after load.
const PAGE = `<!doctype html><title>Tone</title><body>
<script>
function wav() {
  const n = 22050, b = new ArrayBuffer(44 + n * 2), d = new DataView(b);
  const s = (o, t) => { for (let i = 0; i < t.length; i++) d.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); d.setUint32(16, 16, true);
  d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, 22050, true); d.setUint32(28, 44100, true);
  d.setUint16(32, 2, true); d.setUint16(34, 16, true); s(36, 'data'); d.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.sin(i / 22050 * 2 * Math.PI * 440) * 8000, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
window.SRC = wav();
const v = document.createElement('video'); v.id = 'v'; v.loop = true; v.autoplay = true; v.src = SRC; document.body.append(v);
window.later = () => new Promise((ok) => { const w = document.createElement('video'); w.id = 'w'; w.loop = true; w.autoplay = true; w.src = SRC; w.addEventListener('playing', () => ok(true), { once: true }); document.body.append(w); });
</script>`;

// The volume an element really plays at, read with a getter from a fresh frame so
// Cue's own hook on this page's prototype is not the one answering.
const REAL = (sel) => `(() => { const e = document.querySelector('${sel}'); if (!e) return null; const f = document.createElement('iframe'); document.body.append(f);
  const g = Object.getOwnPropertyDescriptor(f.contentWindow.HTMLMediaElement.prototype, 'volume').get; const r = g.call(e); f.remove(); return { real: Math.round(r * 100) / 100, playing: !e.paused }; })()`;
// What a WebAudio graph renders through to the speakers: a constant 1.0 comes out at the tab's volume.
const WEBAUDIO = `(async () => { const c = new OfflineAudioContext(1, 256, 44100); const s = c.createConstantSource(); s.offset.value = 1; s.connect(c.destination); s.start();
  const b = await c.startRendering(); return Math.round(b.getChannelData(0)[128] * 100) / 100; })()`;

let server = null;
module.exports = async (c) => {
  try { await run(c); } catch (e) { check('the test ran to the end', false, e.stack); finish(c, server); }
};

async function run(c) {
  server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE); });
  await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
  const A = `http://127.0.0.1:${PORT}/tone-a`;
  const B = `http://localhost:${PORT}/tone-b`;
  await sleep(1200);
  const ui = () => c.ui().webContents;
  const js = (code) => ui().executeJavaScript(code, true);
  const page = (t, code) => t.view.webContents.executeJavaScript(code, true);
  const shot = async (name, rect) => {
    const w = c.win(); const was = w.getBounds();
    w.setBounds({ ...was, x: -9000, y: 0 }); w.setOpacity(1);
    await sleep(450);
    let img = null;
    try { img = await ui().capturePage(rect); } catch (e) { console.log(`[cue-tilevol] shot ${name} failed: ${e.message}`); }
    w.setOpacity(0); w.setBounds(was);
    if (img) fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    return !!img;
  };
  const rectOf = (sel) => js(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right }; })()`);
  const around = (r, pad = 10) => ({ x: Math.max(0, Math.floor(r.x - pad)), y: Math.max(0, Math.floor(r.y - pad)), width: Math.ceil(r.w + pad * 2), height: Math.ceil(r.h + pad * 2) });
  const mid = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
  const wheel = (p, deltaY, alt) => ui().sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY, wheelTicksY: deltaY / 100, canScroll: true, modifiers: alt ? ['alt'] : [] });
  const move = (p) => ui().sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
  const click = async (p, mods = []) => {
    ui().sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y, modifiers: mods });
    ui().sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: mods });
    ui().sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: mods });
    await sleep(250);
  };
  const key = async (keyCode) => { ui().sendInputEvent({ type: 'keyDown', keyCode }); ui().sendInputEvent({ type: 'char', keyCode }); ui().sendInputEvent({ type: 'keyUp', keyCode }); await sleep(250); };
  const push = (t) => c.setVolume(t, t.volume); // any setter pushes the state to the sidebar
  const vol = (t) => Math.round(c.byId(t.id).volume * 100);
  const loaded = async (t) => { for (let i = 0; i < 40; i++) { try { if (t.view && (await page(t, 'document.readyState')) === 'complete') return true; } catch {} await sleep(150); } return false; };
  const playing = async (t, sel = '#v') => { for (let i = 0; i < 40; i++) { try { const r = await page(t, REAL(sel)); if (r && r.playing) return r; } catch {} await sleep(150); } return null; };
  const want = path.join(c.app.getPath('userData'), 'tilevol-want.json');

  if (PHASE === '2') {
    await sleep(1500);
    const w = JSON.parse(fs.readFileSync(want, 'utf8'));
    const a = c.tabs.find((t) => t.url === A); const b = c.tabs.find((t) => t.url === B);
    check('restart: both pinned apps came back', a && b && a.pinned && b.pinned, c.tabs.map((t) => `${t.url} pinned=${t.pinned}`));
    check('restart: the volume is remembered', a && Math.round(a.volume * 100) === w.a, a && a.volume);
    check('restart: mute is remembered, and its own volume with it', b && b.muted === true && Math.round(b.volume * 100) === w.b, b && { muted: b.muted, volume: b.volume });
    if (a) {
      c.activate(a.id); await loaded(a);
      const r = await playing(a);
      check('restart: the page plays at the remembered volume the moment it starts', r && r.real === w.a / 100, r);
    }
    await sleep(400);
    const lv = await js(`(() => { const l = document.querySelector('.pin[data-id="${a && a.id}"] .lvl > i'); return l ? Math.round(l.getBoundingClientRect().width / l.parentNode.getBoundingClientRect().width * 100) : null; })()`);
    check('restart: the tile shows the remembered level', lv !== null && Math.abs(lv - w.a) <= 3, lv);
    const bm = await js(`!!document.querySelector('.pin[data-id="${b && b.id}"] .favsound.off svg')`);
    check('restart: the muted app still wears the crossed-out speaker', bm);
    const tr = await rectOf(`.pin[data-id="${a && a.id}"]`);
    if (tr) await shot('tilevol-after-restart', around({ ...tr, w: tr.w * 3 }, 12));
    finish(c, server);
    return;
  }

  // ---- set up: two pinned apps on two hosts, and an ordinary tab
  for (const t of [...c.tabs]) c.closeTab(t.id);
  await sleep(300);
  const folder = c.store.data.folder;
  const a = c.openTab({ url: A, identity: folder });
  const b = c.openTab({ url: B, identity: folder });
  const other = c.openTab({ url: "data:text/html,<title>Plain</title>plain", identity: folder });
  await sleep(500);
  c.command('pin', { id: a.id, on: true }); c.command('pin', { id: b.id, on: true });
  c.activate(a.id); await loaded(a);
  c.activate(other.id); await loaded(other);
  await sleep(600);
  const tileSel = `.pin[data-id="${a.id}"]`;
  let tile = await rectOf(tileSel);
  check('the pinned app is drawn as a tile', !!tile, tile || { pins: await js(`document.querySelector('#pins').outerHTML.slice(0, 400)`), tabs: c.tabs.map((t) => [t.id, t.url, t.pinned, t.identity]), folder });
  if (!tile) { finish(c, server); return; }
  const tileShot = () => around({ ...tile, w: tile.w }, 12);

  // ---- at 100% and silent, nothing extra
  check('level: none at 100% and silent', !(await js(`!!document.querySelector('${tileSel} .lvl')`)));
  await shot('tilevol-1-full-silent', tileShot());

  // ---- a plain scroll leaves the volume alone
  for (let i = 0; i < 3; i++) { wheel(mid(tile), -100, false); wheel(mid(tile), 100, false); }
  await sleep(400);
  check('wheel: a plain scroll does not change the volume', vol(a) === 100, vol(a));

  // ---- Option-scroll changes it in 5% steps
  wheel(mid(tile), -100, true); await sleep(350);
  let down = -100;
  if (vol(a) === 100) { down = 100; wheel(mid(tile), down, true); await sleep(350); }
  check('wheel: one Option-scroll step is 5%', vol(a) === 95, vol(a));
  wheel(mid(tile), down, true); wheel(mid(tile), down, true); await sleep(400);
  check('wheel: steps add up when scrolled quickly', vol(a) === 85, vol(a));
  wheel(mid(tile), -down, true); await sleep(400);
  check('wheel: the other way is louder', vol(a) === 90, vol(a));
  for (let i = 0; i < 10; i++) wheel(mid(tile), Math.sign(down) * 10, true);
  await sleep(400);
  check('wheel: small trackpad moves add up to whole steps', vol(a) === 80, vol(a));
  for (let i = 0; i < 6; i++) { wheel(mid(tile), -down, true); await sleep(60); }
  await sleep(400);
  check('wheel: it stops at 100%', vol(a) === 100, vol(a));
  wheel(mid(tile), down, true); wheel(mid(tile), down, true); await sleep(400);

  // ---- the page really plays at that volume
  c.activate(a.id); await sleep(300);
  let r = await playing(a);
  check('page: the video really plays at the tab volume', r && r.real === 0.9, r);
  check('page: WebAudio really renders at the tab volume', (await page(a, WEBAUDIO)) === 0.9);
  c.activate(other.id); await sleep(400);
  tile = await rectOf(tileSel);

  // ---- the level shows, as a shape
  const lvl = await js(`(() => { const l = document.querySelector('${tileSel} .lvl > i'); return l ? Math.round(l.getBoundingClientRect().width / l.parentNode.getBoundingClientRect().width * 100) : null; })()`);
  check('level: shown below 100%, as long as the volume', lvl !== null && Math.abs(lvl - 90) <= 3, lvl);
  const lvlColour = await js(`(() => { const l = document.querySelector('${tileSel} .lvl > i'); return l && getComputedStyle(l).backgroundColor; })()`);
  const onair = await js(`getComputedStyle(document.documentElement).getPropertyValue('--onair').trim()`);
  check('level: not drawn in the on-air red', lvlColour && !/211, 35, 43|255, 75, 81/.test(lvlColour), { lvlColour, onair });
  await shot('tilevol-2-at-90', tileShot());
  c.byId(a.id).audible = true; c.setVolume(c.byId(a.id), 1); await sleep(400);
  check('level: shown while sounding at 100%', await js(`!!document.querySelector('${tileSel}.issounding .lvl')`));
  await shot('tilevol-3-sounding-100', tileShot());
  c.byId(a.id).audible = false; push(c.byId(a.id)); await sleep(400);
  check('level: gone again at 100% and silent', !(await js(`!!document.querySelector('${tileSel} .lvl')`)));
  c.setMuted(c.byId(a.id), true); await sleep(400);
  const mk = await js(`({ badge: !!document.querySelector('${tileSel} .favsound.off svg'), lvl: !!document.querySelector('${tileSel} .lvl'), dim: !!document.querySelector('${tileSel}.ismuted') })`);
  check('muted: the crossed-out speaker shows on the tile, and no level', mk.badge && !mk.lvl && mk.dim, mk);
  await shot('tilevol-4-muted', tileShot());

  // ---- clicking the badge unmutes, without opening the app
  const before = c.getState().activeId;
  const badge = await rectOf(`${tileSel} .pinmute`);
  await click(mid(badge));
  check('badge: a click on the crossed-out speaker unmutes', c.byId(a.id).muted === false);
  check('badge: and does not open the app', c.getState().activeId === before, { active: c.getState().activeId, was: before });

  // ---- Option-click mutes without opening it
  move({ x: 5, y: 5 }); await sleep(200);
  await click(mid(tile), ['alt']);
  check('option-click: mutes the app', c.byId(a.id).muted === true);
  check('option-click: and does not open it', c.getState().activeId === before);
  await click(mid(tile), ['alt']);
  check('option-click: again unmutes it', c.byId(a.id).muted === false);

  // ---- resting on a playing app brings up the control
  move({ x: 5, y: 5 }); await sleep(300);
  c.byId(a.id).audible = true; c.setVolume(c.byId(a.id), 0.6); await sleep(350);
  tile = await rectOf(tileSel);
  move(mid(tile)); await sleep(200); move({ x: mid(tile).x + 1, y: mid(tile).y }); await sleep(700);
  let pop = await rectOf('.tvol:not([hidden])');
  check('hover: resting on a playing app opens its volume', !!pop, pop);
  if (pop) {
    check('hover: the control sits under the tile, not over it', pop.y >= tile.b, { tileBottom: tile.b, popTop: pop.y });
    const side = await rectOf('#side');
    check('hover: and inside the sidebar', pop.x >= side.x && pop.r <= side.r, { pop, side });
    const fill = await js(`({ pct: document.querySelector('.tvol .tv-pct').textContent, range: document.querySelector('.tvol .tv-range').value, hasSpk: !!document.querySelector('.tvol .tv-spk svg'), reset: document.querySelector('.tvol .tv-reset').textContent })`);
    check('hover: speaker, slider, the number and 100%', fill.pct === '60%' && fill.range === '60' && fill.hasSpk && fill.reset === '100%', fill);
    await shot('tilevol-5-popover', around({ x: Math.min(tile.x, pop.x), y: tile.y, w: Math.max(tile.r, pop.r) - Math.min(tile.x, pop.x), h: pop.b - tile.y }, 10));
    // the slider sets it - a real click a quarter of the way along
    const rg = await rectOf('.tvol .tv-range');
    await click({ x: Math.round(rg.x + rg.w * 0.25), y: Math.round(rg.y + rg.h / 2) });
    await sleep(250);
    check('popover: the slider sets the volume', Math.abs(vol(a) - 25) <= 6, vol(a));
    c.activate(a.id); await sleep(250);
    r = await playing(a);
    check('popover: and the page follows', r && Math.abs(r.real * 100 - vol(a)) <= 1, { real: r && r.real, tab: vol(a) });
    c.activate(other.id); await sleep(350);
    pop = await rectOf('.tvol:not([hidden])');
    check('popover: it stays open while the pointer is in it', !!pop);
    // keyboard: arrows are 5% steps, M mutes
    const v0 = vol(a);
    await key('Up');
    check('keys: the up arrow is 5% louder', vol(a) === Math.round((v0 + 5) / 5) * 5, { from: v0, to: vol(a) });
    await key('Down'); await key('Down');
    check('keys: the down arrow is 5% quieter', vol(a) === Math.round((v0 + 5) / 5) * 5 - 10, vol(a));
    await key('M');
    check('keys: M mutes', c.byId(a.id).muted === true);
    const sp = await rectOf('.tvol .tv-spk');
    await click(mid(sp));
    check('popover: the speaker unmutes', c.byId(a.id).muted === false);
    await click(mid(sp));
    check('popover: and mutes', c.byId(a.id).muted === true);
    const rs = await rectOf('.tvol .tv-reset');
    await click(mid(rs));
    check('popover: 100% puts it back to full, and on', vol(a) === 100 && c.byId(a.id).muted === false, { v: vol(a), muted: c.byId(a.id).muted });
    await key('Escape');
    check('keys: Esc closes it', !(await rectOf('.tvol:not([hidden])')));
  }
  // ---- it closes when the pointer leaves both
  move(mid(tile)); await sleep(200); move({ x: mid(tile).x + 1, y: mid(tile).y }); await sleep(700);
  check('hover: opens again', !!(await rectOf('.tvol:not([hidden])')));
  const groups = await rectOf('#groups');
  move({ x: Math.round(groups.x + groups.w / 2), y: Math.round(groups.b - 20) }); await sleep(600);
  check('hover: leaving the tile and the control closes it', !(await rectOf('.tvol:not([hidden])')));

  // ---- a click on the tile still opens the app, popover or not
  move(mid(tile)); await sleep(200); move({ x: mid(tile).x + 1, y: mid(tile).y }); await sleep(700);
  check('click: with the control showing', !!(await rectOf('.tvol:not([hidden])')));
  await click(mid(tile));
  check('click: on the tile still opens the app', c.getState().activeId === a.id, { active: c.getState().activeId, want: a.id });
  c.byId(a.id).audible = false; push(c.byId(a.id));
  move({ x: 5, y: 5 }); await sleep(500);

  // ---- right-click > Volume… opens it with the keyboard in it
  c.activate(other.id); await sleep(300);
  c.sendEvent('volume-pop', { id: a.id }); await sleep(400);
  const held = await js(`({ open: !document.querySelector('.tvol').hidden, focus: document.activeElement && document.activeElement.className })`);
  check('menu: Volume… opens the control for a silent app too, keyboard ready', held.open && held.focus === 'tv-range', held);
  await key('Down');
  check('menu: the keys work at once', vol(a) === 95, vol(a));
  await key('Escape');

  // ---- the same on an ordinary tab row
  const rowSel = `.tab[data-id="${other.id}"]`;
  const row = await rectOf(rowSel);
  check('row: the ordinary tab is in the list', !!row);
  if (row) {
    const p = { x: Math.round(row.x + 40), y: mid(row).y };
    wheel(p, 100, false); wheel(p, -100, false); await sleep(300);
    check('row: a plain scroll leaves it alone', vol(other) === 100, vol(other));
    wheel(p, down, true); await sleep(350);
    check('row: Option-scroll on the row changes it by 5%', vol(other) === 95, vol(other));
    c.sendEvent('volume-pop', { id: other.id }); await sleep(300);
    check('row: Volume… opens the row\'s own slider', await js(`!!document.querySelector('${rowSel}.vol-open')`));
  }

  // ---- after sleep, the volume is back the moment it plays
  c.setVolume(c.byId(a.id), 0.3); await sleep(200);
  c.destroyView(c.byId(a.id)); c.byId(a.id).sleeping = true; await sleep(600);
  check('sleep: the tab really went to sleep', !c.byId(a.id).view);
  c.activate(a.id); await sleep(300);
  await loaded(c.byId(a.id));
  r = await playing(c.byId(a.id));
  check('sleep: woken, it plays at its volume from the first moment', r && r.real === 0.3, r);
  await page(c.byId(a.id), 'later()');
  r = await page(c.byId(a.id), REAL('#w'));
  check('sleep: a video the page starts later plays at it too', r && r.real === 0.3, r);
  check('sleep: and WebAudio', (await page(c.byId(a.id), WEBAUDIO)) === 0.3);

  // ---- set up for the restart
  c.setVolume(c.byId(a.id), 0.35);
  c.setVolume(c.byId(b.id), 0.6); c.setMuted(c.byId(b.id), true);
  await sleep(300);
  c.persist(); c.store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(c.app.getPath('userData'), 'cue.json'), 'utf8'));
  const sa = (saved.tabs || []).find((t) => t.url === A); const sb = (saved.tabs || []).find((t) => t.url === B);
  check('saved: cue.json holds each app\'s volume and mute', sa && sa.volume === 0.35 && sb && sb.volume === 0.6 && sb.muted === true, { sa: sa && [sa.volume, sa.muted], sb: sb && [sb.volume, sb.muted] });
  fs.writeFileSync(want, JSON.stringify({ a: 35, b: 60 }));
  finish(c, server);
}

function finish(c, server) {
  fs.writeFileSync(path.join(OUT, `tile-volume-${PHASE}.json`), JSON.stringify(results, null, 2));
  const fails = results.filter((x) => !x.ok);
  console.log(`[cue-tilevol] DONE phase ${PHASE}: ${results.length - fails.length}/${results.length} passed`);
  try { server.close(); } catch {}
  if (!process.env.CUE_KEEP) c.app.quit();
}
