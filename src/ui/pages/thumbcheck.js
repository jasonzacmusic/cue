'use strict';
// Thumbnail check: runs entirely in the page. The picture never leaves this computer.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const state = { src: '', w: 0, h: 0, bytes: 0, name: '' };

  // Plain grey stand-in shown until a picture is chosen.
  const PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8d96a0"/><stop offset="1" stop-color="#5a646f"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><text x="640" y="380" text-anchor="middle" font-family="sans-serif" font-size="64" font-weight="700" fill="rgba(255,255,255,.85)">Your thumbnail</text></svg>');

  const FILLER = ['11:08', '8:42', '23:15', '4:51', '15:30', '6:07'];
  const AV = ['#3b6fb3', '#7a5ab3', '#2f8f6b', '#b3702f', '#b33a6a'];

  function words() {
    const t = $('title').value.trim() || 'Your video title goes here';
    const c = $('chan').value.trim() || 'Your channel';
    return { t, c, i: (c[0] || '?').toUpperCase() };
  }
  function thumb(dur) {
    const d = el('div', 'th'); const im = el('img'); im.alt = 'Your thumbnail'; im.src = state.src || PLACEHOLDER; d.appendChild(im);
    d.appendChild(el('span', 'dur', dur || '12:34')); return d;
  }
  function phThumb(i) { const d = el('div', 'th'); d.appendChild(el('span', 'dur', FILLER[i % FILLER.length])); return d; }
  function avatar(you, i) { const a = el('div', 'av' + (you ? ' you' : ''), you ? words().i : ''); if (!you) a.style.opacity = '.9'; return a; }
  function lines(cls) { const w = el('div', 'tx'); w.append(el('div', 'ln a'), el('div', 'ln b')); return w; }
  function panel(dark, extra) {
    const p = el('div', 'yt' + (dark ? ' dark' : '') + (extra ? ' ' + extra : ''));
    p.appendChild(el('span', 'mode', dark ? 'Dark mode' : 'Light mode')); return p;
  }
  function topbar() {
    const t = el('div', 'topbar'); t.append(el('i', 'dot'), el('i', 'pill'), el('i', 'dot'));
    const c = el('div', 'chips'); for (let i = 0; i < 6; i++) c.appendChild(el('i'));
    const f = document.createDocumentFragment(); f.append(t, c); return f;
  }

  function ourCard() {
    const { t, c } = words();
    const k = el('div', 'card'); k.appendChild(thumb());
    const row = el('div', 'row'); const tx = el('div', 'tx');
    tx.append(el('div', 'ttl', t), el('div', 'sub', c), el('div', 'sub', '12K views · 2 days ago'));
    row.append(avatar(true), tx); k.appendChild(row); return k;
  }
  function fillerCard(i) {
    const k = el('div', 'card'); k.appendChild(phThumb(i));
    const row = el('div', 'row'); const a = el('div', 'av'); row.append(a, lines()); k.appendChild(row); return k;
  }

  function buildHome(dark) {
    const p = panel(dark); p.appendChild(topbar());
    const g = el('div', 'home');
    g.append(fillerCard(0), ourCard(), fillerCard(1), fillerCard(2), fillerCard(3), fillerCard(4));
    p.appendChild(g); return p;
  }
  function searchRow(i) {
    const r = el('div', 'srow'); r.appendChild(phThumb(i));
    const tx = el('div', 'tx'); tx.append(el('div', 'ln a'), el('div', 'ln b'), el('div', 'ln s'), el('div', 'ln'));
    r.appendChild(tx); return r;
  }
  function buildSearch(dark) {
    const p = panel(dark);
    const t = el('div', 'topbar'); t.append(el('i', 'dot'), el('i', 'pill'), el('i', 'dot')); p.appendChild(t);
    p.appendChild(searchRow(0));
    const { t: title, c } = words();
    const r = el('div', 'srow'); r.appendChild(thumb());
    const tx = el('div', 'tx'); const ch = el('div', 'ch'); ch.append(avatar(true), el('span', 'sub', c));
    tx.append(el('div', 'ttl', title), el('div', 'sub', '12K views · 2 days ago'), ch, el('div', 'ln'), el('div', 'ln s'));
    r.appendChild(tx); p.appendChild(r);
    p.appendChild(searchRow(1)); p.appendChild(searchRow(2));
    return p;
  }
  function pcard(ours, i) {
    const k = el('div', 'pcard'); k.appendChild(ours ? thumb() : phThumb(i));
    const row = el('div', 'row'); const tx = el('div', 'tx');
    if (ours) { const { t, c } = words(); tx.append(el('div', 'ttl', t), el('div', 'sub', c + ' · 12K views · 2 days ago')); row.append(avatar(true), tx); }
    else { tx.append(el('div', 'ln a'), el('div', 'ln b')); row.append(el('div', 'av'), tx); }
    k.appendChild(row); return k;
  }
  function buildPhone(dark) {
    const p = panel(dark, 'phonebox'); const wrap = el('div', 'phones'); const ph = el('div', 'phone');
    const st = el('div', 'status'); st.append(el('i'), el('i')); ph.appendChild(st);
    ph.append(pcard(false, 0), pcard(true), pcard(false, 1));
    wrap.appendChild(ph); p.appendChild(wrap); return p;
  }
  function sideItem(ours, i) {
    const it = el('div', 'it'); it.appendChild(ours ? thumb() : phThumb(i));
    const tx = el('div', ours ? 'tx' : 'ph-t');
    if (ours) { const { t, c } = words(); tx.append(el('div', 'ttl', t), el('div', 'sub', c), el('div', 'sub', '12K views · 2 days ago')); }
    else tx.append(el('div', 'ln'), el('div', 'ln b'));
    it.appendChild(tx); return it;
  }
  function buildWatch(dark) {
    const p = panel(dark); const w = el('div', 'watch');
    const left = el('div', 'left'); left.append(el('div', 'player'), el('div', 'ln'), el('div', 'ln m'), el('div', 'ln s'));
    const side = el('div', 'side'); side.append(sideItem(false, 0), sideItem(true), sideItem(false, 1), sideItem(false, 2), sideItem(false, 3));
    w.append(left, side); p.appendChild(w); return p;
  }
  function buildTiny() {
    const box = $('s-tiny'); box.textContent = '';
    [['lt', false, 'On a light page'], ['dk', false, 'On a dark page'], ['lt', true, 'Black and white']].forEach(([cls, gray, cap]) => {
      const f = el('figure'); const b = el('div', 'box ' + cls); const t = el('div', 'th' + (gray ? ' gray' : ''));
      const im = el('img'); im.alt = 'Your thumbnail at 168 pixels wide'; im.src = state.src || PLACEHOLDER; t.append(im, el('span', 'dur', '12:34'));
      b.appendChild(t); f.append(b, el('figcaption', null, cap)); box.appendChild(f);
    });
  }

  function fill(id, build) {
    const host = $(id); host.textContent = '';
    host.append(build(false), build(true));
  }

  function renderPreviews() {
    fill('s-home', buildHome); fill('s-search', buildSearch); fill('s-phone', buildPhone); fill('s-watch', buildWatch); buildTiny();
    const n = $('title').value.length; $('count').textContent = n + ' of 100 letters. YouTube shows about 60 before cutting off.';
  }

  function note(cls, strong, text) {
    const n = el('div', 'note ' + cls); n.append(el('b', null, strong), el('span', null, text)); return n;
  }
  function renderChecks() {
    const c = $('checks'); c.textContent = '';
    if (!state.src) { c.appendChild(note('idle', 'Waiting', 'Choose a picture and I will check its size and shape.')); return; }
    const { w, h, bytes } = state; let bad = 0;
    const ratio = w / h;
    if (Math.abs(ratio - 16 / 9) > 0.02) { bad++; c.appendChild(note('bad', 'Not 16:9.', 'This one is ' + w + ' × ' + h + '. YouTube will crop it or add black bars at the sides. Aim for 1920 × 1080.')); }
    if (w < 1280) { bad++; c.appendChild(note('bad', 'Too small.', 'It is ' + w + ' pixels wide and YouTube wants at least 1280. It will look soft on big screens.')); }
    if (bytes > 2 * 1024 * 1024) { bad++; c.appendChild(note('', 'Too heavy.', 'This file is ' + (bytes / 1048576).toFixed(1) + ' MB and YouTube only takes thumbnails up to 2 MB. Save it again as a smaller JPG.')); }
    if (!bad) c.appendChild(note('good', 'Good size.', w + ' × ' + h + ', 16:9' + (bytes ? ', ' + Math.max(1, Math.round(bytes / 1024)) + ' KB' : '') + '.'));
  }

  let oldUrl = '';
  function setFile(file) {
    if (!file || !/^image\//.test(file.type)) { $('fn').textContent = 'That is not a picture file.'; return; }
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      oldUrl = url;
      Object.assign(state, { src: url, w: probe.naturalWidth, h: probe.naturalHeight, bytes: file.size, name: file.name || 'Pasted picture' });
      $('pv').textContent = ''; const im = el('img'); im.alt = ''; im.src = url; $('pv').appendChild(im);
      $('fn').textContent = state.name + ' · ' + state.w + ' × ' + state.h;
      renderChecks(); renderPreviews();
    };
    probe.onerror = () => { URL.revokeObjectURL(url); $('fn').textContent = 'I could not read that picture. Try a JPG or PNG.'; };
    probe.src = url;
  }

  $('pick').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => { setFile(e.target.files[0]); e.target.value = ''; });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement || !e.relatedTarget) drop.classList.remove('over'); }));
  document.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) setFile(f); });
  document.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) if (it.kind === 'file' && /^image\//.test(it.type)) { setFile(it.getAsFile()); break; }
  });
  let raf = 0;
  const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderPreviews); };
  $('title').addEventListener('input', later); $('chan').addEventListener('input', later);

  renderChecks(); renderPreviews();
})();
