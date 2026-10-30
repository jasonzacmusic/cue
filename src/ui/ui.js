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
let lastSpace = null;
const inSpace = (t) => t.space === S.space;

function render() {
  if (!S) return;
  document.body.dataset.live = S.live ? '1' : '';
  if (S.space !== lastSpace) {
    if (lastSpace !== null) { newIdentity = S.settings.spaceLogins[S.space] || newIdentity; }
    lastSpace = S.space;
  }
  renderSpaces();
  renderIdPick();
  renderPins();
  renderGroups();
  renderBar();
  renderContent();
  renderLive();
  renderDownloads();
  renderExtras();
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
    // The dots were unlabelled colours, so nobody could tell what they did.
    b.append(el('i', '', ''), el('span', 'idname', esc(v.name)));
    b.title = `New tabs open as ${v.name}${S.labels[id] ? ` (${S.labels[id]})` : ''}`;
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', id === newIdentity);
    if (id === newIdentity) b.classList.add('on');
    b.onclick = () => { newIdentity = id; try { localStorage.setItem('cue.newIdentity', id); } catch {} renderIdPick(); };
    box.append(b);
  }
  const v = S.identities[newIdentity];
  const who = S.labels[newIdentity];
  $('#idwho').textContent = newIdentity === 'vanish'
    ? 'New tabs keep nothing on this computer.'
    : `New tabs open as ${v ? v.name : newIdentity}${who ? ` · ${who}` : ''}`;
}

function renderSpaces() {
  const box = $('#spaces'); box.innerHTML = '';
  S.spaces.forEach((n, i) => {
    const count = S.tabs.filter((t) => t.space === n).length;
    const b = el('button', n === S.space ? 'on' : '', esc(n));
    b.title = `${n} (⌃${i + 1}) · ${count} tab${count === 1 ? '' : 's'}`;
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', n === S.space);
    b.onclick = () => send('space', { name: n });
    box.append(b);
  });
}

function renderExtras() {
  const k = S.settings.kits;
  const bb = $('#billbadge'); const n = S.billCount + S.alertCount;
  bb.hidden = !n; bb.textContent = n > 99 ? '99+' : n;
  bb.classList.toggle('bad', S.billCount > 0);
  $('#openbills').hidden = !k.business;
  $('#openboards').hidden = !k.designer;
  $('#musicbtn').hidden = !k.music && !k.video;
  document.querySelector('.live').hidden = !k.teacher;
  document.querySelectorAll('[data-m],.st-label').forEach((x) => { x.hidden = !k.music; });
  ['m-speed', 'm-semi'].forEach((i) => { $(`#${i}`).hidden = !k.music; });
  document.querySelectorAll('[data-t]').forEach((x) => { x.hidden = !k.video; });
  $('#strip').hidden = !S.strip;
  $('#musicbtn').classList.toggle('on', !!S.strip);
  $('#aihead').hidden = !S.ai;
  $('#aibtn').classList.toggle('on', !!S.ai);
  document.querySelectorAll('[data-ai]').forEach((b) => b.classList.toggle('on', !!S.ai && b.dataset.ai === S.ai.which));
  $('#peekbar').hidden = !S.peek;
  if (S.peek) $('#peektitle').textContent = S.peek.title;
  $('#recbtn').hidden = !S.recording;
}

function renderPins() {
  const box = $('#pins'); box.innerHTML = '';
  for (const t of S.tabs.filter((x) => x.pinned && inSpace(x))) {
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
    const list = S.tabs.filter((t) => !t.pinned && t.group === g.id && inSpace(t));
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
  if (t.badge) ctl.append(el('span', 'badge', t.badge > 99 ? '99+' : String(t.badge)));
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

  const up = el('button', 'movet', '↑'); up.title = 'Move this tab up (⌥⌘↑)';
  up.setAttribute('aria-label', `Move ${t.title || 'tab'} up`);
  up.onclick = (e) => { e.stopPropagation(); send('move-tab', { id: t.id, dir: -1 }); };
  const dn = el('button', 'movet', '↓'); dn.title = 'Move this tab down (⌥⌘↓)';
  dn.setAttribute('aria-label', `Move ${t.title || 'tab'} down`);
  dn.onclick = (e) => { e.stopPropagation(); send('move-tab', { id: t.id, dir: 1 }); };
  ctl.append(up, dn);

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
  const kinds = [...new Set(S.downloads.map((d) => d.kind))];
  for (const kind of kinds) {
    if (kinds.length > 1) box.append(el('div', 'dl-kind', esc(kind)));
    for (const d of S.downloads.filter((x) => x.kind === kind)) {
      const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
      const st = d.state === 'completed' ? 'Done' : d.state === 'cancelled' ? 'Cancelled' : d.state === 'interrupted' ? 'Failed' : `${pct}%`;
      const r = el('div', 'dl', `<span class="nm">${esc(d.name)}</span><span class="st">${st}</span>`);
      r.title = 'Show in Finder';
      r.onclick = () => send('download-open', { id: d.id });
      if (d.kind === 'Installers' && d.state === 'completed') {
        const run = el('button', 'dl-run', 'Open'); run.title = 'Open the installer. It moves to the Trash a day later.';
        run.onclick = (e) => { e.stopPropagation(); send('download-run', { id: d.id }); };
        r.append(run);
      }
      box.append(r);
    }
  }
}

// ---------------------------------------------------------------- omnibox + suggestions
const ENGINE_NAMES = { google: 'Google', images: 'Images', youtube: 'YouTube', pinterest: 'Pinterest', github: 'GitHub', claude: 'Claude', chatgpt: 'ChatGPT' };
let sugItems = []; let sugSel = 0;

const openUrl = (url) => () => send('navigate', { text: url, newTab: true });
function libraryHits(r) {
  return [
    ...r.bookmarks.map((x) => ({ k: 'Bookmark', v: x.title || x.url, run: openUrl(x.url) })),
    ...r.history.map((x) => ({ k: 'History', v: x.title || x.url, run: openUrl(x.url) })),
    ...r.boards.map((x) => ({ k: 'Board', v: x.title || x.url, run: openUrl(x.url) })),
    ...r.apps.map((x) => ({ k: 'NSM app', v: x.name, run: openUrl(x.url) })),
    ...r.repos.map((x) => ({ k: 'GitHub', v: x.name, run: openUrl(x.url) })),
  ];
}

async function showSuggest() {
  const q = $('#omnibox').value.trim();
  const box = $('#suggest');
  if (!q) { hideSuggest(); return; }
  const ql = q.toLowerCase();
  const tabHits = S.tabs.filter((t) => (t.title + ' ' + t.url).toLowerCase().includes(ql) && t.id !== S.activeId).slice(0, 5)
    .map((t) => ({ k: 'Switch to', v: t.title, run: () => send('activate', { id: t.id }) }));
  const engines = Object.keys(ENGINE_NAMES).map((e) => ({ k: ENGINE_NAMES[e], v: q, run: () => send('navigate', { text: q, engine: e }) }));
  const lib = libraryHits(await window.cue.invoke('suggest', { q }));
  if ($('#omnibox').value.trim() !== q) return;
  sugItems = [{ k: 'Go', v: q, run: () => send('navigate', { text: q }) }, ...tabHits, ...lib.slice(0, 8), ...engines.slice(1)];
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

// Drop an image on the bar to find where it came from.
omni.addEventListener('dragover', (e) => e.preventDefault());
omni.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) { await window.cue.invoke('lens-file', { name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }); return; }
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (/^https?:/.test(url)) send('navigate', { text: `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(url)}`, newTab: true });
});

// ---------------------------------------------------------------- Cmd+K
const COMMANDS = [
  ['Go live', () => send('live', { on: !S.live })], ['New Vanish tab', () => send('new-tab', { identity: 'vanish' })],
  ['Side by side', () => send('split', { mode: 'cols2' })], ['Grid of four', () => send('split', { mode: 'grid4' })], ['One tab', () => send('split', { mode: 'single' })],
  ['Move in from another browser', () => openImport()], ['Settings', () => openSettings()], ['Boards', () => send('tool', { name: 'boards' })],
  ['Bookmarks, history and archived tabs', () => send('tool', { name: 'library' })], ['Bills and alerts', () => send('tool', { name: 'bills' })],
  ['Thumbnail check', () => send('tool', { name: 'thumbcheck' })], ['AI side panel', () => send('ai')], ['Ask AI about this page', () => send('ai-ask')],
  ['Music bar', () => send('strip')], ['Pick a colour', () => send('tool', { name: 'colour' })], ['Find a font', () => send('tool', { name: 'font' })], ['Ruler', () => send('tool', { name: 'ruler' })],
  ['Save whole page as a picture', () => send('tool', { name: 'fullpage' })], ['Record this tab', () => send('tool', { name: 'record' })], ['Make a GIF', () => send('tool', { name: 'gif' })],
  ['Vercel deploys', () => send('navigate', { text: 'https://vercel.com/dashboard', newTab: true })], ['Learning portal', () => send('navigate', { text: 'https://learning-portal.nathanielschool.com', newTab: true })],
  ...['Teach', 'Create', 'Business', 'Build'].map((n) => [`Space: ${n}`, () => send('space', { name: n })]),
];

function openPalette() {
  openModal((sh) => {
    sh.classList.add('cmdk');
    const box = el('input'); box.type = 'text'; box.placeholder = 'Find a tab, page, bookmark, app or command'; box.setAttribute('aria-label', 'Find anything');
    const list = el('div', 'cmdlist');
    let items = []; let sel = 0;
    const paint = () => {
      list.innerHTML = '';
      items.forEach((it, i) => {
        const r = el('div', 'sg' + (i === sel ? ' sel' : ''), `<span class="k">${esc(it.k)}</span><span class="v">${esc(it.v)}</span>`);
        r.onclick = () => { closeModal(); it.run(); };
        list.append(r);
      });
    };
    const update = async () => {
      const q = box.value.trim(); const ql = q.toLowerCase();
      const tabs = S.tabs.filter((t) => (t.title + ' ' + t.url).toLowerCase().includes(ql)).slice(0, q ? 6 : 8)
        .map((t) => ({ k: t.space === S.space ? 'Tab' : t.space, v: t.title, run: () => send('activate', { id: t.id }) }));
      const cmds = COMMANDS.filter(([n]) => n.toLowerCase().includes(ql)).slice(0, q ? 5 : 3).map(([n, run]) => ({ k: 'Do', v: n, run }));
      const lib = q ? libraryHits(await window.cue.invoke('suggest', { q })) : [];
      if (box.value.trim() !== q) return;
      const web = q ? [{ k: 'Search', v: q, run: () => send('navigate', { text: q, newTab: true }) }, { k: 'GitHub', v: q, run: () => send('navigate', { text: q, engine: 'github', newTab: true }) }] : [];
      items = [...tabs, ...cmds, ...lib, ...web].slice(0, 14); sel = 0; paint();
    };
    box.oninput = update;
    box.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; paint(); }
      else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); const it = items[sel]; closeModal(); it.run(); }
    };
    sh.append(box, list);
    update();
    setTimeout(() => box.focus(), 30);
  });
}

// ---------------------------------------------------------------- move in
async function openImport() {
  const found = await window.cue.invoke('import-find');
  openModal((sh) => {
    sh.append(el('h2', '', 'Move in to Cue'));
    if (!found.length) sh.append(el('div', 'note', 'No other browser was found on this computer.'));
    sh.append(el('div', 'note', 'Copies your things into Cue. The other browser is not changed. Your computer may ask to unlock its keychain once for passwords and sign-ins.'));
    found.sort((a, b) => (b.id === 'helium') - (a.id === 'helium'));
    for (const b of found) {
      for (const p of b.profiles) {
        const card = el('div', 'impcard');
        const c = p.counts || {};
        card.append(el('b', '', esc(`${b.name}${b.profiles.length > 1 ? ` · ${p.name}` : ''}`)));
        if (p.email) card.append(el('span', 'note', esc(p.email)));
        const what = { bookmarks: true, history: true, tabs: true, passwords: b.id !== 'safari', cookies: b.id !== 'safari' };
        const opts = el('div', 'impopts');
        [['bookmarks', `Bookmarks${c.bookmarks != null ? ` (${c.bookmarks})` : ''}`], ['history', `History${c.history != null ? ` (${c.history})` : ''}`], ['tabs', 'Open tabs'], ['passwords', 'Passwords'], ['cookies', 'Sign-ins']].forEach(([k, label]) => {
          if (b.id === 'safari' && k !== 'bookmarks') { what[k] = false; return; }
          const l = el('label'); const i = el('input'); i.type = 'checkbox'; i.checked = what[k]; i.onchange = () => { what[k] = i.checked; };
          l.append(i, document.createTextNode(` ${label}`)); opts.append(l);
        });
        card.append(opts);
        const row = el('div', 'row'); const who = el('select');
        ['personal', 'school'].forEach((k) => { const o = el('option', '', `Into ${S.identities[k].name}`); o.value = k; o.selected = k === p.identity; who.append(o); });
        const go = el('button', 'btn', 'Move in'); const out = el('span', 'note');
        go.onclick = async () => {
          go.disabled = true; out.textContent = 'Moving in…';
          const r = await window.cue.invoke('import-run', { browser: b.id, profile: p.dir, identity: who.value, what });
          go.disabled = false;
          out.textContent = r.error || [r.bookmarks != null && `${r.bookmarks} bookmarks`, r.history != null && `${r.history} history`, r.tabs != null && `${r.tabs} tabs`, r.passwords != null && `${r.passwords} passwords`, r.cookies != null && `${r.cookies} sign-ins`, r.note].filter(Boolean).join(' · ');
        };
        row.append(who, out, go); card.append(row); sh.append(card);
      }
    }
    const foot = el('div', 'foot'); const done = el('button', 'btn', 'Done'); done.onclick = closeModal; foot.append(done); sh.append(foot);
  });
}

// ---------------------------------------------------------------- colours
function showPalette(colors) {
  openModal((sh) => {
    sh.append(el('h2', '', colors.length > 1 ? 'Palette' : 'Colour'));
    const row = el('div', 'swatches');
    colors.forEach((c) => {
      const b = el('button', 'swatch', `<i style="background:${esc(c)}"></i><span>${esc(c)}</span>`);
      b.title = 'Copy'; b.onclick = () => { navigator.clipboard.writeText(c); toast(`Copied ${c}`); };
      row.append(b);
    });
    sh.append(row, el('div', 'note', colors.length > 1 ? 'Click a colour to copy it.' : 'Copied. Click to copy again.'));
    const foot = el('div', 'foot'); const done = el('button', 'btn', 'Done'); done.onclick = closeModal; foot.append(done); sh.append(foot);
  });
}

// ---------------------------------------------------------------- tab recording
let rec = null;
async function startRecording() {
  if (rec) { toast('Already recording.'); return; }
  const info = await window.cue.invoke('rec-start');
  if (!info) { toast('Open a tab first.'); return; }
  // The session exists from this moment, so a stop pressed while the capture is
  // still being granted finds something to cancel instead of silently doing
  // nothing and leaving the capture stream running.
  const session = { info, stream: null, recorder: null, chunks: [], stopped: false, startedAt: 0 };
  rec = session;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: true });
    session.stream = stream;
    if (session.stopped) { teardown(session); return; }
    const type = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((x) => MediaRecorder.isTypeSupported(x));
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12000000, audioBitsPerSecond: 256000 });
    session.recorder = recorder;
    recorder.ondataavailable = (e) => { if (e.data.size) session.chunks.push(e.data); };
    recorder.onerror = (e) => { teardown(session); toast(`Recording stopped: ${e.error ? e.error.name : 'error'}`); };
    recorder.onstop = async () => {
      const tracks = stream.getTracks();
      tracks.forEach((x) => x.stop());
      if (rec === session) rec = null;
      try {
        const blob = new Blob(session.chunks, { type });
        // An mp4 whose only chunk is the header is not a video. Saving it is
        // worse than saying nothing was captured, because the file looks real.
        if (blob.size < 4096) { await window.cue.invoke('rec-cancel'); toast('Nothing was captured — the recording was too short.'); return; }
        const buffer = new Uint8Array(await blob.arrayBuffer());
        await window.cue.invoke('rec-save', { title: session.info.title, buffer, ext: type.startsWith('video/mp4') ? 'mp4' : 'webm' });
      } catch (e) {
        try { await window.cue.invoke('rec-cancel'); } catch {}
        toast(`Could not save the recording: ${e && e.message ? e.message : e}`);
      }
    };
    recorder.start(1000);
    session.startedAt = Date.now();
    toast('Recording this tab with its sound.');
  } catch (e) {
    teardown(session);
    toast(`Recording could not start: ${e && e.message ? e.message : e}`);
  }
}

function teardown(session) {
  session.stopped = true;
  if (session.stream) session.stream.getTracks().forEach((x) => x.stop());
  if (rec === session) rec = null;
  window.cue.invoke('rec-cancel');
}

async function stopRecording() {
  const session = rec;
  if (!session) return;
  session.stopped = true;
  // Capture was asked for but has not been granted yet: there is no recorder to
  // stop, so tear the session down rather than leaving the stream live.
  if (!session.recorder) { teardown(session); toast('Recording cancelled.'); return; }
  if (session.recorder.state === 'inactive') return;
  // MediaRecorder writes an mp4 header first and the frames later. Stopping
  // within that window produced a header-only or audio-only file, so flush
  // what has been encoded and give a very short take time to hold a frame.
  const held = Date.now() - session.startedAt;
  if (held < 1200) await new Promise((r) => setTimeout(r, 1200 - held));
  try { session.recorder.requestData(); } catch {}
  await new Promise((r) => setTimeout(r, 120));
  session.recorder.stop();
}

// ---------------------------------------------------------------- music bar
const M = { speed: 100, semi: 0, loop: false };
function music(op, value) { send('music', { op, value }); }
document.querySelectorAll('[data-m]').forEach((b) => {
  b.onclick = () => {
    const m = b.dataset.m;
    if (m === 'speed-' || m === 'speed+') { M.speed = Math.max(25, Math.min(200, M.speed + (m === 'speed+' ? 5 : -5))); $('#m-speed').textContent = `${M.speed}%`; music('speed', M.speed / 100); }
    else if (m === 'semi-' || m === 'semi+') { M.semi = Math.max(-12, Math.min(12, M.semi + (m === 'semi+' ? 1 : -1))); $('#m-semi').textContent = M.semi > 0 ? `+${M.semi}` : String(M.semi); music('transpose', M.semi); }
    else if (m === 'loop') music('loop', !M.loop);
    else music(m);
  };
});
document.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => send('tool', { name: b.dataset.t }); });
$('#musicbtn').onclick = () => send('strip');
$('#aibtn').onclick = () => send('ai');
$('#aiclose').onclick = () => send('ai');
$('#aiask').onclick = () => send('ai-ask');
document.querySelectorAll('[data-ai]').forEach((b) => { b.onclick = () => send('ai', { which: b.dataset.ai }); });
$('#peekclose').onclick = () => send('peek-close');
$('#peekkeep').onclick = () => send('peek-keep');
$('#recbtn').onclick = stopRecording;
$('#findany').onclick = openPalette;
$('#openboards').onclick = () => send('tool', { name: 'boards' });
$('#openlibrary').onclick = () => send('tool', { name: 'library' });
$('#openbills').onclick = () => send('tool', { name: 'bills' });

// ---------------------------------------------------------------- save password
function credBar(d) {
  const box = $('#credbar'); box.innerHTML = ''; box.hidden = false;
  box.append(el('div', '', `Save password for <b>${esc(hostOf(d.origin))}</b>?`));
  if (d.username) box.append(el('div', 'note', esc(d.username)));
  const row = el('div', 'credrow');
  const close = () => { box.hidden = true; };
  const yes = el('button', 'btn', 'Save'); yes.onclick = () => { send('cred-save', {}); close(); };
  const auto = el('button', 'btn', 'Save, auto sign-in'); auto.title = 'Cue signs you in on this site by itself'; auto.onclick = () => { send('cred-save', { auto: true }); close(); };
  const no = el('button', 'btn', 'Never'); no.onclick = () => { send('cred-never'); close(); };
  const later = el('button', 'icon', '×'); later.setAttribute('aria-label', 'Not now'); later.onclick = () => { send('cred-dismiss'); close(); };
  row.append(yes, auto, no, later); box.append(row);
}

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
    const mv = el('div', 'row'); const mvb = el('button', 'btn', 'Move in from another browser'); mvb.onclick = () => { closeModal(); openImport(); };
    const dfb = el('button', 'btn', 'Make Cue my browser'); dfb.onclick = () => send('make-default'); mv.append(mvb, dfb); sh.append(mv);
    sh.append(el('h3', '', 'Spaces'));
    sh.append(el('div', 'note', 'Each Space keeps its own tabs and split layout. New tabs in a Space open with its usual login.'));
    S.spaces.forEach((n) => {
      const pick = el('select'); ['personal', 'school'].forEach((k) => { const o = el('option', '', S.identities[k].name); o.value = k; o.selected = s.spaceLogins[n] === k; pick.append(o); });
      pick.onchange = () => send('setting', { key: `spaceLogin.${n}`, value: pick.value });
      sh.append(settingRow(`${n} usual login`, pick));
    });
    sh.append(el('h3', '', 'Kits'));
    sh.append(el('div', 'note', 'Switch off what you don\'t use and it stays out of your way.'));
    Object.entries(S.kits).forEach(([k, v]) => sh.append(settingRow(`${v.name}: ${v.what}`, check(`kit.${k}`, s.kits[k]))));
    sh.append(el('h3', '', 'Passwords'));
    const pwBox = el('div', 'pwlist'); sh.append(pwBox);
    window.cue.invoke('passwords').then((list) => {
      if (!list.length) pwBox.append(el('div', 'note', 'No saved passwords yet. Cue offers to save one when you sign in to a site.'));
      list.forEach((x) => {
        const r = el('div', 'row'); const a2 = check('', x.auto); a2.title = 'Sign in by itself on this site'; a2.onchange = () => send('pw-auto', { pw: x.id, on: a2.checked });
        const rm = el('button', 'btn', 'Remove'); rm.onclick = () => { send('pw-remove', { pw: x.id }); r.remove(); };
        const auto = el('label', 'note', ' auto'); auto.prepend(a2);
        r.append(el('span', '', esc(`${hostOf(x.origin)} · ${x.username || 'no username'} · ${S.identities[x.identity].name}`)), auto, rm); pwBox.append(r);
      });
    });
    sh.append(el('h3', '', 'Chrome extensions'));
    const exBox = el('div', 'pwlist'); sh.append(exBox);
    sh.append(el('div', 'note', 'Copied from your other browsers, so they keep working here. Simple extensions work best; ones that need Chrome\'s full toolbar may not.'));
    window.cue.invoke('ext-find').then(({ available, installed }) => {
      installed.forEach((x) => { const r = el('div', 'row'); const b = el('button', 'btn', 'Remove'); b.onclick = () => { window.cue.invoke('ext-remove', { id: x.id }); r.remove(); }; r.append(el('span', '', esc(`${x.name} · on`)), b); exBox.append(r); });
      available.slice(0, 30).forEach((x) => { const r = el('div', 'row'); const b = el('button', 'btn', 'Add'); const st = el('span', 'note', esc(x.from)); b.onclick = async () => { const res = await window.cue.invoke('ext-add', x); st.textContent = res.ok ? 'Added' : 'This one does not work in Cue yet'; b.disabled = true; }; r.append(el('span', '', esc(x.name)), st, b); exBox.append(r); });
      if (!installed.length && !available.length) exBox.append(el('div', 'note', 'None found.'));
    });
    sh.append(el('h3', '', 'Tabs and sound'));
    sh.append(settingRow('Group tabs automatically (Google, AI & Subscriptions…)', check('autoGroup', s.autoGroup)));
    sh.append(settingRow('One tab plays at a time', check('onePlayer', s.onePlayer), 'When a tab starts playing, the others pause. The on-air tab is never paused.'));
    sh.append(settingRow('Original sound for music', check('originalSound', s.originalSound), 'Switches off echo cancel, noise cut and auto-volume on your microphone in web calls. Reload the call page after changing.'));
    sh.append(settingRow('Scroll split tabs together', check('syncScroll', s.syncScroll)));
    sh.append(settingRow('Sleep unused tabs after (minutes)', text('sleepMinutes', s.sleepMinutes, '30', 'number')));
    sh.append(settingRow('Archive unused tabs after (days, 0 = never)', text('archiveDays', s.archiveDays, '7', 'number'), 'Pinned tabs never archive. Find archived tabs in Library.'));
    sh.append(settingRow('Cache limit per login (MB)', text('cacheCapMB', s.cacheCapMB, '1024', 'number'), 'Applies next time Cue opens. Sign-ins are not affected.'));
    sh.append(settingRow('Warn before downloading when free space falls under (GB)', text('lowDiskGB', s.lowDiskGB, '5', 'number')));
    sh.append(settingRow('Move opened installers to the Trash after a day', check('tidyInstallers', s.tidyInstallers)));
    sh.append(settingRow('GitHub name for Find anything', text('githubUser', s.githubUser, 'jasonzacmusic')));
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
  else if (name === 'palette-open') openPalette();
  else if (name === 'palette') showPalette(data.colors);
  else if (name === 'import') openImport();
  else if (name === 'save-password') credBar(data);
  else if (name === 'rec-start') startRecording();
  else if (name === 'rec-stop') stopRecording();
  else if (name === 'music-state' && data) {
    if (data.none) { toast('No video or audio on this page yet.'); return; }
    M.loop = !!data.loop; M.speed = Math.round(data.speed * 100); $('#m-speed').textContent = `${M.speed}%`;
    $('#m-loop').textContent = data.loop ? 'On' : (data.a != null ? 'Set' : 'Off');
    $('#m-loop').classList.toggle('on', !!data.loop);
  }
});
window.addEventListener('resize', () => { if (!$('#suggest').hidden) showSuggest(); });
