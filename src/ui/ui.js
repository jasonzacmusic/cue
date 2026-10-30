// Cue sidebar + toolbar. Renders the state the main process sends and turns clicks into commands.
const $ = (s) => document.querySelector(s);
const send = (cmd, args) => window.cue.send(cmd, args);
let S = null;
let newIdentity = localStorage.getItem('cue.newIdentity') || 'personal';
let editingOmni = false;
let openVolId = null;

const SPK = {
  on: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/><path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.3 3.9a5.8 5.8 0 0 1 0 8.2"/></svg>',
  off: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/><path d="M10.5 6l4 4M14.5 6l-4 4"/></svg>',
};

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function ringColor(t) { return t.identity === 'vanish' ? 'var(--muted)' : (S.identities[t.identity] || {}).color; }

function favEl(t) {
  const f = el('span', 'fav');
  const showRing = t.identity !== S.settings.defaultIdentity || t.agent;
  if (showRing) { f.classList.add('ringed'); f.style.setProperty('--ring', t.agent ? 'var(--agent)' : ringColor(t)); }
  if (t.favicon) { const i = new Image(); i.src = t.favicon; i.onerror = () => { f.textContent = (t.title || '?')[0].toUpperCase(); }; f.append(i); }
  else f.textContent = (t.title || hostOf(t.url) || '?').slice(0, 1).toUpperCase();
  return f;
}

// ---------------------------------------------------------------- render
function render() {
  if (!S) return;
  document.body.dataset.live = S.live ? '1' : '';
  renderIdPick();
  renderPins();
  renderGroups();
  renderBar();
  renderContent();
  renderLive();
  renderDownloads();
  const a = S.agent;
  const portBusy = a.last && a.last.tool === 'port';
  $('#agentline').innerHTML = portBusy ? 'AI agents: another Cue has the door'
    : a.last ? `<b>${esc(a.last.agent)}</b> · ${esc(a.last.tool)}${a.last.ok ? '' : ' (stopped)'}`
    : (a.on ? 'AI agents ready' : 'AI agents off');
}

function renderIdPick() {
  const box = $('#idpick'); box.innerHTML = '';
  for (const [id, v] of Object.entries(S.identities)) {
    const b = el('button', id === 'vanish' ? 'vanish' : '');
    b.style.setProperty('--c', v.color);
    b.title = `New tabs open as ${v.name}${S.labels[id] ? ` (${S.labels[id]})` : ''}`;
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', id === newIdentity);
    if (id === newIdentity) b.classList.add('on');
    b.onclick = () => { newIdentity = id; try { localStorage.setItem('cue.newIdentity', id); } catch {} renderIdPick(); };
    box.append(b);
  }
}

function renderPins() {
  const box = $('#pins'); box.innerHTML = '';
  for (const t of S.tabs.filter((x) => x.pinned)) {
    const p = el('div', 'pin'); p.title = t.title;
    if (t.id === S.activeId) p.classList.add('active');
    if (t.id === S.programId) p.classList.add('onair');
    if (t.favicon) { const i = new Image(); i.src = t.favicon; p.append(i); } else p.textContent = (t.title || '?')[0];
    if (t.identity !== S.settings.defaultIdentity) { const d = el('span', 'dot'); d.style.setProperty('--ring', ringColor(t)); p.append(d); }
    p.onclick = () => send('activate', { id: t.id });
    p.oncontextmenu = (e) => { e.preventDefault(); send('tab-menu', { id: t.id }); };
    box.append(p);
  }
}

function renderGroups() {
  const box = $('#groups');
  const scroll = box.scrollTop;
  box.innerHTML = '';
  const splitIds = S.split.mode !== 'single' ? S.split.ids : [];
  for (const g of S.groups) {
    const list = S.tabs.filter((t) => !t.pinned && t.group === g.id);
    if (!list.length) continue;
    const wrap = el('section', 'group' + (S.collapsed[g.id] ? ' closed' : ''));
    const head = el('div', 'ghead', `<span class="caret">▾</span>${esc(g.name)}<span class="n">${list.length}</span>`);
    const anyAudio = list.some((t) => t.audible || t.playing);
    if (anyAudio) {
      const gm = el('button', 'gm', '■'); gm.title = 'Mute every tab in this group';
      gm.onclick = (e) => { e.stopPropagation(); list.forEach((t) => { if (!t.muted) send('mute', { id: t.id }); }); };
      head.insertBefore(gm, head.querySelector('.n'));
    }
    head.onclick = () => send('collapse', { group: g.id });
    head.ondragover = (e) => { e.preventDefault(); head.classList.add('drop'); };
    head.ondragleave = () => head.classList.remove('drop');
    head.ondrop = (e) => { e.preventDefault(); head.classList.remove('drop'); const id = Number(e.dataTransfer.getData('text/cue-tab')); if (id) send('reorder', { id, group: g.id }); };
    wrap.append(head);
    const ul = el('div', 'tablist');
    for (const t of list) ul.append(tabRow(t, splitIds));
    wrap.append(ul);
    box.append(wrap);
  }
  box.scrollTop = scroll;
}

function tabRow(t, splitIds) {
  const row = el('div', 'tab');
  row.dataset.id = t.id;
  if (t.id === S.activeId) row.classList.add('active');
  if (splitIds.includes(t.id)) row.classList.add('insplit');
  if (t.sleeping) row.classList.add('sleeping');
  if (S.live && t.id === S.programId) row.classList.add('onair');
  else if (S.live && t.id === S.activeId) row.classList.add('cued');
  row.append(favEl(t));
  const title = el('span', 'title', esc(t.loading ? `${t.title}` : t.title));
  title.title = `${t.title}\n${t.url}`;
  row.append(title);

  const ctl = el('span', 'ctl');
  if (S.live && t.id === S.programId) ctl.append(el('span', 'tally on', 'ON AIR'));
  else if (S.live && t.id === S.activeId) ctl.append(el('span', 'tally cue', 'CUED'));
  else if (t.private) ctl.append(el('span', 'tally priv', 'PRIVATE'));
  else if (t.agent) ctl.append(el('span', 'tally ai', 'AI'));

  if (t.playing || t.audible) {
    const m = el('button', 'media', t.playing ? '❚❚' : '▶');
    m.title = t.playing ? 'Pause (⌃P)' : 'Play (⌃P)';
    m.onclick = (e) => { e.stopPropagation(); send('media', { id: t.id, cmd: 'toggle' }); };
    ctl.append(m);
  }
  const hasSound = t.audible || t.muted || t.playing || t.volume < 1;
  const spk = el('button', 'spk' + (t.muted ? ' muted' : t.audible ? ' live' : ''), t.muted ? SPK.off : SPK.on);
  spk.title = t.muted ? 'Unmute' : `Mute · volume ${Math.round(t.volume * 100)}%`;
  spk.setAttribute('aria-label', spk.title);
  if (!hasSound) { spk.style.visibility = 'hidden'; row.addEventListener('mouseenter', () => { spk.style.visibility = 'visible'; }); row.addEventListener('mouseleave', () => { if (openVolId !== t.id) spk.style.visibility = 'hidden'; }); }
  spk.onclick = (e) => { e.stopPropagation(); send('mute', { id: t.id }); };
  spk.onwheel = (e) => { e.preventDefault(); send('volume', { id: t.id, value: Math.round((t.volume + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100 }); };

  const pop = el('div', 'volpop');
  const r = el('input'); r.type = 'range'; r.min = 0; r.max = 100; r.value = Math.round(t.volume * 100);
  r.setAttribute('aria-label', `Volume for ${t.title}`);
  const pct = el('span', 'pct', `${r.value}%`);
  r.oninput = () => { pct.textContent = `${r.value}%`; send('volume', { id: t.id, value: r.value / 100 }); };
  r.onclick = (e) => e.stopPropagation();
  pop.append(r, pct);
  pop.onclick = (e) => e.stopPropagation();
  let closeTimer;
  const openVol = () => { clearTimeout(closeTimer); openVolId = t.id; row.classList.add('vol-open'); };
  const closeVol = () => { closeTimer = setTimeout(() => { if (openVolId === t.id) openVolId = null; row.classList.remove('vol-open'); }, 350); };
  spk.addEventListener('mouseenter', openVol);
  spk.addEventListener('mouseleave', closeVol);
  pop.addEventListener('mouseenter', openVol);
  pop.addEventListener('mouseleave', closeVol);
  if (openVolId === t.id) row.classList.add('vol-open');
  row.append(pop);
  ctl.append(spk);

  const x = el('button', 'close', '×'); x.title = 'Close tab (⌘W)';
  x.onclick = (e) => { e.stopPropagation(); send('close', { id: t.id }); };
  ctl.append(x);
  row.append(ctl);

  row.onclick = (e) => { if (e.metaKey || e.ctrlKey) send('split-add', { id: t.id }); else send('activate', { id: t.id }); };
  row.onauxclick = (e) => { if (e.button === 1) send('close', { id: t.id }); };
  row.oncontextmenu = (e) => { e.preventDefault(); send('tab-menu', { id: t.id }); };
  row.draggable = true;
  row.ondragstart = (e) => { e.dataTransfer.setData('text/cue-tab', String(t.id)); row.classList.add('dragging'); };
  row.ondragend = () => row.classList.remove('dragging');
  row.ondragover = (e) => { e.preventDefault(); row.classList.add('dropbefore'); };
  row.ondragleave = () => row.classList.remove('dropbefore');
  row.ondrop = (e) => { e.preventDefault(); row.classList.remove('dropbefore'); const id = Number(e.dataTransfer.getData('text/cue-tab')); if (id && id !== t.id) send('reorder', { id, beforeId: t.id }); };
  return row;
}

function renderBar() {
  const a = S.tabs.find((t) => t.id === S.activeId);
  $('#back').disabled = !(a && a.canBack);
  $('#fwd').disabled = !(a && a.canFwd);
  if (!editingOmni) $('#omnibox').value = a ? a.url : '';
  const oid = $('#omni-id');
  oid.className = 'omni-id' + (a && a.identity === 'vanish' ? ' vanish' : '');
  oid.style.setProperty('--ring', a ? (a.agent ? 'var(--agent)' : ringColor(a)) : '');
  oid.title = a ? `${S.identities[a.identity].name}${S.labels[a.identity] ? ` · ${S.labels[a.identity]}` : ''}` : '';
  document.querySelectorAll('[data-split]').forEach((b) => b.classList.toggle('on', b.dataset.split === S.split.mode));
  $('#syncscroll').classList.toggle('on', !!S.settings.syncScroll);
  $('#livetoggle').checked = S.live;
  $('#take').hidden = !S.live;
}

function renderContent() {
  const fr = $('#frames'); fr.innerHTML = '';
  const side = 264; const bar = 52;
  if (S.panes.length > 1) {
    for (const p of S.panes) {
      const f = el('div', 'frame' + (p.id === S.activeId ? ' active' : ''));
      Object.assign(f.style, { left: `${p.rect.x - side}px`, top: `${p.rect.y - bar}px`, width: `${p.rect.width}px`, height: `${p.rect.height}px` });
      fr.append(f);
    }
  }
  const ph = $('#placeholder');
  const a = S.tabs.find((t) => t.id === S.activeId);
  if (S.live && a && a.id === S.programId) { ph.hidden = false; ph.innerHTML = '<div><b>On air</b>This tab is showing in the Cue Stage window.<br>Click another tab to cue it, then press TAKE.</div>'; }
  else if (a && a.host === 'popout') { ph.hidden = false; ph.innerHTML = '<div><b style="color:var(--ink)">Popped out</b>This tab is in its own window, ready for Zoom or OBS.<br>Close that window to bring it back.</div>'; }
  else ph.hidden = true;
}

function renderLive() {
  const box = $('#livebox');
  box.hidden = !S.live;
  const p = S.tabs.find((t) => t.id === S.programId);
  $('#lb-title').textContent = p ? p.title : 'Standby: press TAKE';
  if (!p) $('#lb-thumb').removeAttribute('src');
}

function renderDownloads() {
  const box = $('#downloads');
  box.hidden = !S.downloads.length;
  if (!S.downloads.length) return;
  box.innerHTML = '';
  const head = el('div', 'dl-head', 'Downloads <button>Clear</button>');
  head.querySelector('button').onclick = () => send('downloads-clear');
  box.append(head);
  for (const d of S.downloads) {
    const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
    const st = d.state === 'completed' ? 'Done' : d.state === 'cancelled' ? 'Cancelled' : d.state === 'interrupted' ? 'Failed' : `${pct}%`;
    const r = el('div', 'dl', `<span class="nm">${esc(d.name)}</span><span class="st">${st}</span>`);
    r.title = 'Show in Finder';
    r.onclick = () => send('download-open', { id: d.id });
    box.append(r);
  }
}

// ---------------------------------------------------------------- omnibox + suggestions
const ENGINE_NAMES = { google: 'Google', images: 'Images', youtube: 'YouTube', pinterest: 'Pinterest', github: 'GitHub', claude: 'Claude', chatgpt: 'ChatGPT' };
let sugItems = []; let sugSel = 0;

function showSuggest() {
  const q = $('#omnibox').value.trim();
  const box = $('#suggest');
  if (!q) { hideSuggest(); return; }
  const ql = q.toLowerCase();
  const tabHits = S.tabs.filter((t) => (t.title + ' ' + t.url).toLowerCase().includes(ql) && t.id !== S.activeId).slice(0, 5)
    .map((t) => ({ k: 'Switch to', v: t.title, run: () => send('activate', { id: t.id }) }));
  const engines = Object.keys(ENGINE_NAMES).map((e) => ({ k: ENGINE_NAMES[e], v: q, run: () => send('navigate', { text: q, engine: e }) }));
  sugItems = [{ k: 'Go', v: q, run: () => send('navigate', { text: q }) }, ...tabHits, ...engines.slice(1)];
  sugSel = 0;
  box.innerHTML = '';
  sugItems.forEach((it, i) => {
    const r = el('div', 'sg' + (i === sugSel ? ' sel' : ''), `<span class="k">${esc(it.k)}</span><span class="v">${esc(it.v)}</span>`);
    r.onmousedown = (e) => { e.preventDefault(); it.run(); endEdit(); };
    box.append(r);
  });
  const r = $('.omni').getBoundingClientRect();
  Object.assign(box.style, { left: `${r.left}px`, top: `${r.bottom + 6}px`, width: `${r.width}px` });
  if (box.hidden) { box.hidden = false; overlay(true); }
}
function hideSuggest() { const box = $('#suggest'); if (!box.hidden) { box.hidden = true; overlay(false); } }
function moveSel(d) {
  if ($('#suggest').hidden) return;
  sugSel = (sugSel + d + sugItems.length) % sugItems.length;
  [...$('#suggest').children].forEach((c, i) => c.classList.toggle('sel', i === sugSel));
}
function endEdit() { editingOmni = false; hideSuggest(); $('#engines').hidden = true; $('#omnibox').blur(); render(); }

let overlayCount = 0;
function overlay(on) {
  overlayCount = Math.max(0, overlayCount + (on ? 1 : -1));
  document.body.classList.toggle('overlay', overlayCount > 0);
  send('overlay', { on: overlayCount > 0 });
}

const omni = $('#omnibox');
omni.addEventListener('focus', () => { editingOmni = true; omni.select(); $('#engines').hidden = false; });
omni.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== omni) { editingOmni = false; hideSuggest(); $('#engines').hidden = true; render(); } }, 120); });
omni.addEventListener('input', showSuggest);
omni.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  else if (e.key === 'Escape') { endEdit(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const q = omni.value.trim();
    if (!$('#suggest').hidden && sugItems[sugSel]) sugItems[sugSel].run();
    else if (q) send('navigate', { text: q, newTab: e.metaKey, identity: e.metaKey ? newIdentity : undefined });
    endEdit();
  }
});
document.querySelectorAll('#engines button').forEach((b) => {
  b.onmousedown = (e) => { e.preventDefault(); const q = omni.value.trim(); if (q) { send('navigate', { text: q, engine: b.dataset.engine }); endEdit(); } };
});

// ---------------------------------------------------------------- find
const find = $('#findinput');
function openFind() { $('#findbar').hidden = false; find.focus(); find.select(); }
function closeFind() { $('#findbar').hidden = true; $('#findcount').textContent = ''; send('find', { stop: true }); }
find.addEventListener('input', () => send('find', { text: find.value }));
find.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') send('find', { text: find.value, next: true, forward: !e.shiftKey });
  if (e.key === 'Escape') closeFind();
});

// ---------------------------------------------------------------- buttons
$('#newtab').onclick = () => send('new-tab', { identity: newIdentity });
$('#back').onclick = () => send('back');
$('#fwd').onclick = () => send('forward');
$('#reload').onclick = () => send('reload');
document.querySelectorAll('[data-split]').forEach((b) => { b.onclick = () => send('split', { mode: b.dataset.split }); });
$('#syncscroll').onclick = () => send('setting', { key: 'syncScroll', value: !S.settings.syncScroll });
$('#livetoggle').onchange = (e) => send('live', { on: e.target.checked });
$('#take').onclick = () => send('take');
$('#lb-take').onclick = () => send('take');
$('#lb-end').onclick = () => send('live', { on: false });
$('#opensettings').onclick = () => openSettings();

let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800); }

// ---------------------------------------------------------------- modals
function openModal(build) {
  const m = $('#modal'); m.innerHTML = '';
  const sheet = el('div', 'sheet'); build(sheet);
  m.append(sheet); m.hidden = false; overlay(true);
  m.onclick = (e) => { if (e.target === m) closeModal(); };
}
function closeModal() { const m = $('#modal'); if (m.hidden) return; m.hidden = true; m.innerHTML = ''; overlay(false); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) { if (sharePending) { send('share-choose', {}); sharePending = false; } closeModal(); } });

function settingRow(label, input, note) {
  const r = el('div', 'row'); const l = el('label', '', esc(label)); r.append(l, input);
  if (note) { const wrap = el('div'); wrap.append(r, el('div', 'note', esc(note))); return wrap; }
  return r;
}
function check(key, val) { const i = el('input'); i.type = 'checkbox'; i.checked = !!val; i.onchange = () => send('setting', { key, value: i.checked }); return i; }
function text(key, val, ph, type = 'text') { const i = el('input'); i.type = type; i.value = val || ''; i.placeholder = ph || ''; i.onchange = () => send('setting', { key, value: type === 'number' ? Number(i.value) : i.value }); return i; }

function openSettings() {
  const s = S.settings;
  openModal((sh) => {
    sh.append(el('h2', '', 'Cue settings'));
    sh.append(el('h3', '', 'Logins'));
    sh.append(el('div', 'note', 'Each login keeps its own Google, Instagram and other sign-ins, so two Gmails stay signed in side by side. Name the account each one holds; AI agents read these names and use the right login without asking you.'));
    sh.append(settingRow('Personal account', text('label.personal', S.labels.personal, 'jasonzac@gmail.com')));
    sh.append(settingRow('School account', text('label.school', S.labels.school, 'music@nathanielschool.com')));
    const def = el('select'); ['personal', 'school', 'agent'].forEach((k) => { const o = el('option', '', S.identities[k].name); o.value = k; if (k === s.defaultIdentity) o.selected = true; def.append(o); });
    def.onchange = () => send('setting', { key: 'defaultIdentity', value: def.value });
    sh.append(settingRow('Usual login (no colour ring)', def));
    sh.append(el('h3', '', 'Tabs and sound'));
    sh.append(settingRow('Group tabs automatically (Google, AI & Subscriptions…)', check('autoGroup', s.autoGroup)));
    sh.append(settingRow('One tab plays at a time', check('onePlayer', s.onePlayer), 'When a tab starts playing, the others pause. The on-air tab is never paused.'));
    sh.append(settingRow('Original sound for music', check('originalSound', s.originalSound), 'Switches off echo cancel, noise cut and auto-volume on your microphone in web calls. Reload the call page after changing.'));
    sh.append(settingRow('Scroll split tabs together', check('syncScroll', s.syncScroll)));
    sh.append(settingRow('Sleep unused tabs after (minutes)', text('sleepMinutes', s.sleepMinutes, '30', 'number')));
    sh.append(el('h3', '', 'Live class'));
    sh.append(settingRow('Safe-share (blur emails, phone numbers, money, keys on air)', check('safeShare', s.safeShare)));
    const size = el('select'); [['1920x1080', '1920 × 1080'], ['1280x720', '1280 × 720']].forEach(([v, n]) => { const o = el('option', '', n); o.value = v; if (v === `${s.stageWidth}x${s.stageHeight}`) o.selected = true; size.append(o); });
    size.onchange = () => { const [w, h] = size.value.split('x').map(Number); send('setting', { key: 'stageWidth', value: w }); send('setting', { key: 'stageHeight', value: h }); };
    sh.append(settingRow('Stage window size', size, 'Zoom: Share Screen → pick “Cue Stage — On Air”. OBS: Window Capture → the same window.'));
    sh.append(settingRow('OBS address', text('obs.host', s.obs.host, '127.0.0.1')));
    sh.append(settingRow('OBS port', text('obs.port', s.obs.port, '4455', 'number')));
    sh.append(settingRow('OBS password', text('obs.password', '', s.obs.password ? 'Saved' : 'From OBS → Tools → WebSocket', 'password')));
    const ob = el('div', 'row'); const status = el('span', 'pill' + (S.obs === 'connected' ? ' ok' : ''), S.obs === 'connected' ? 'Connected' : S.obs === 'connecting' ? 'Connecting…' : 'Not connected');
    const cb = el('button', 'btn', 'Connect to OBS'); cb.onclick = () => send('obs-connect');
    const ac = check('obs.autoConnect', s.obs.autoConnect); const acl = el('label', 'note', ' connect on launch'); acl.prepend(ac);
    ob.append(status, acl, cb); sh.append(ob);
    const a = S.tabs.find((t) => t.id === S.activeId);
    if (a) {
      const sc = el('div', 'row'); const inp = el('input'); inp.type = 'text'; inp.value = a.obsScene || ''; inp.placeholder = 'Scene name, e.g. 🎹 Class Apps';
      inp.onchange = () => send('set-scene', { id: a.id, scene: inp.value });
      sc.append(el('label', '', `OBS scene for “${esc(a.title.slice(0, 40))}”`), inp); sh.append(sc);
      window.cue.invoke('obs-scenes').then((list) => { if (list && list.length) { const dl = el('datalist'); dl.id = 'scenes'; list.forEach((n) => { const o = el('option'); o.value = n; dl.append(o); }); sh.append(dl); inp.setAttribute('list', 'scenes'); } });
    }
    sh.append(el('h3', '', 'AI agents'));
    sh.append(el('div', 'note', `Claude Code, Codex and other AI tools connect through Cue's AI port (127.0.0.1:${S.agent.port}). They work in their own tabs with a purple ring, can use your Personal or School logins, and can never touch private tabs, Vanish tabs or the tab on air.`));
    sh.append(settingRow('AI port on (takes effect next launch)', check('agentPort', s.agentPort)));
    const cp = el('button', 'btn', 'Copy AI setup'); cp.onclick = () => send('agent-copy');
    const r = el('div', 'row'); r.append(el('span', 'note', S.agent.last ? `Last: ${esc(S.agent.last.agent)} used ${esc(S.agent.last.tool)}` : 'No agent has connected yet.'), cp); sh.append(r);
    const foot = el('div', 'foot'); const done = el('button', 'btn', 'Done'); done.onclick = closeModal; foot.append(done); sh.append(foot);
  });
}

let sharePending = false;
function sharePicker(d) {
  sharePending = true;
  closeModal();
  openModal((sh) => {
    sh.append(el('h2', '', 'Share from Cue'));
    sh.append(el('div', 'note', 'A page wants to share your screen. Pick a Cue tab to share just that tab with its sound, or a whole window or screen.'));
    const c = el('div', 'choices');
    for (const t of d.tabs) { const b = el('button', 'choice', `${esc(t.title)}<small>${esc(t.url)}</small>`); b.onclick = () => { sharePending = false; send('share-choose', { tabId: t.id }); closeModal(); }; c.append(b); }
    for (const s of d.sources) { const b = el('button', 'choice', `${esc(s.name)}<small>${s.id.startsWith('screen') ? 'Whole screen' : 'Window'}</small>`); b.onclick = () => { sharePending = false; send('share-choose', { sourceId: s.id }); closeModal(); }; c.append(b); }
    sh.append(c);
    const foot = el('div', 'foot'); const cancel = el('button', 'btn', 'Cancel'); cancel.onclick = () => { sharePending = false; send('share-choose', {}); closeModal(); }; foot.append(cancel); sh.append(foot);
  });
}

// ---------------------------------------------------------------- wiring
window.cue.onState((s) => { S = s; render(); });
window.cue.onEvent((name, data) => {
  if (name === 'toast') toast(data);
  else if (name === 'focus-omnibox') { omni.focus(); omni.select(); }
  else if (name === 'focus-find') openFind();
  else if (name === 'find-result') $('#findcount').textContent = data.total ? `${data.active}/${data.total}` : 'No matches';
  else if (name === 'program-thumb') $('#lb-thumb').src = data;
  else if (name === 'share-picker') sharePicker(data);
});
window.addEventListener('resize', () => { if (!$('#suggest').hidden) showSuggest(); });
