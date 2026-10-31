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

const ICON = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  plus: ICON('<path d="M8 3v10M3 8h10"/>'),
  find: ICON('<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>'),
  boards: ICON('<rect x="2.5" y="2.5" width="4.5" height="6" rx="1"/><rect x="9" y="2.5" width="4.5" height="3.5" rx="1"/><rect x="9" y="8" width="4.5" height="5.5" rx="1"/><rect x="2.5" y="10.5" width="4.5" height="3" rx="1"/>'),
  library: ICON('<path d="M3 2.5v11M6 2.5v11M9.2 2.8l3.6 10.4"/>'),
  bills: ICON('<path d="M4 6.5a4 4 0 0 1 8 0c0 3.6 1.3 4.6 1.3 4.6H2.7S4 10.100 4 6.500zM6.700 13.300h2.600"/>'),
  settings: ICON('<path d="M3 4.500h6M12 4.500h1M3 11.500h1M7 11.500h6"/><circle cx="10.500" cy="4.500" r="1.500"/><circle cx="5.500" cy="11.500" r="1.500"/>'),
  hide: ICON('<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10"/>'),
};
$('#newtab').innerHTML = ICONS.plus;
$('#sidehide').innerHTML = ICONS.hide;
$('#findany').innerHTML = ICONS.find;
$('#openboards').innerHTML = ICONS.boards;
$('#openlibrary').innerHTML = ICONS.library;
$('#openbills').insertAdjacentHTML('afterbegin', ICONS.bills);
$('#opensettings').innerHTML = ICONS.settings;

// ---------------------------------------------------------------- tooltips
// One quiet label of Cue's own, instead of the system's slow yellow box: it knows
// the dark theme, it never covers what you are pointing at, and it can carry a
// second line telling you what the thing does.
const tipBox = el('div', 'tip'); tipBox.hidden = true; document.body.append(tipBox);
let tipTimer = null;
function tip(node, text, sub) {
  node.removeAttribute('title');
  node.dataset.tip = text || '';
  if (sub) node.dataset.tipsub = sub; else delete node.dataset.tipsub;
  // The label is the tooltip, so it has to follow it. Leaving the first one in
  // place made the shield announce "nothing to block" over a page where it had
  // just stopped fifteen things.
  if (text) node.setAttribute('aria-label', text);
  return node;
}
function showTip(node) {
  if (!node.isConnected || !node.dataset.tip) return;
  tipBox.innerHTML = `<b>${esc(node.dataset.tip)}</b>${node.dataset.tipsub ? `<span>${esc(node.dataset.tipsub)}</span>` : ''}`;
  tipBox.hidden = false;
  const r = node.getBoundingClientRect(); const b = tipBox.getBoundingClientRect();
  const x = Math.max(6, Math.min(innerWidth - b.width - 6, r.left + r.width / 2 - b.width / 2));
  const below = r.bottom + 8;
  tipBox.style.left = `${Math.round(x)}px`;
  tipBox.style.top = `${Math.round(below + b.height > innerHeight - 6 ? r.top - b.height - 8 : below)}px`;
}
const hideTip = () => { clearTimeout(tipTimer); tipBox.hidden = true; };
document.addEventListener('mouseover', (e) => {
  const node = e.target.closest && e.target.closest('[data-tip]');
  clearTimeout(tipTimer);
  if (!node) { tipBox.hidden = true; return; }
  tipTimer = setTimeout(() => showTip(node), 380);
});
document.addEventListener('mouseout', hideTip);
document.addEventListener('mousedown', hideTip, true);
addEventListener('blur', hideTip);

// ---------------------------------------------------------------- tab names
// A page title is written for a search engine — "Chord Trees - Interactive Chord
// Visualization | Learn Music Theory" — and in a narrow column all you ever see is
// the part that says nothing. Cue keeps the piece that names the thing. Rename a
// tab yourself (double-click it) and your name always wins.
const TITLE_SPLIT = /\s+[|–—·•]\s+|\s+-\s+/;
function shortName(t) {
  if (t.name) return t.name;
  const full = (t.title || '').trim();
  if (!full) return hostOf(t.url) || 'New tab';
  let head = full.split(TITLE_SPLIT)[0].trim();
  const colon = head.match(/^([^:]{2,28}):\s+\S/); // "Pitara: piano, tuner, metronome…"
  if (colon) head = colon[1].trim();
  if (head.length < 3) head = full; // a bare "Home" or "(3)" tells you nothing
  return head.length > 46 ? `${head.slice(0, 45).trimEnd()}…` : head;
}

// Where to look for a site's logo: the one the page gave us, then the usual
// address, then Google's icon service.
function iconSources(t) {
  const tries = [t.favicon];
  if (/^https?:/.test(t.url || '') && t.identity !== 'vanish') {
    try {
      const u = new URL(t.url);
      const usual = `${u.origin}/favicon.ico`;
      const service = `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
      tries.push(...(/\.google\.com$/.test(u.hostname) ? [service, usual] : [usual, service]));
    } catch {}
  }
  return tries.filter(Boolean);
}
// An image that quietly tries the next source, and falls back to a letter.
function iconImg(srcs, onGiveUp) {
  const i = new Image(); i.alt = '';
  const list = srcs.slice();
  i.onerror = () => { list.shift(); if (list.length) i.src = list[0]; else { i.remove(); onGiveUp(); } };
  i.src = list[0];
  return i;
}
// A tab is marked only when it is signed in somewhere other than the login this
// Space uses — otherwise every row in the Space carried the same mark.
function offLogin(t) {
  const here = (S.settings.spaceLogins && S.settings.spaceLogins[t.space]) || S.settings.defaultIdentity;
  return t.agent || t.identity !== here;
}

function favEl(t) {
  const f = el('span', 'fav');
  const showRing = offLogin(t);
  // A site's own logo, drawn as the site drew it. The login it belongs to is a
  // small dot in the corner, not a ring around the icon: a ring on every row
  // turned the whole sidebar orange and hid the logos it was meant to mark.
  const letter = () => { const l = el('i', 'ltr'); l.textContent = (shortName(t) || hostOf(t.url) || '?').slice(0, 1).toUpperCase(); f.prepend(l); };
  // A tab that has not woken up yet has no icon from its page, so Cue's own pages draw theirs
  // and a site is tried at the usual address, then through Google's icon service.
  const page = /^cue:\/\/(\w+)/.exec(t.url || '');
  const srcs = iconSources(t);
  if (page && ICONS[page[1]]) f.innerHTML = ICONS[page[1]];
  else if (srcs.length) f.append(iconImg(srcs, letter));
  else letter();
  if (showRing) { const d = el('i', 'idot'); d.style.background = t.agent ? 'var(--agent)' : ringColor(t); f.append(d); }
  if (t.audible || t.muted) f.append(el('b', 'favsound' + (t.muted ? ' off' : '')));
  return f;
}

// ---------------------------------------------------------------- render
let lastSpace = null;
const inSpace = (t) => t.space === S.space;

// Typing a name into the sidebar is the one thing in this window that must not
// be interrupted. The sidebar is rebuilt from scratch on every state push - a
// page loading, a tab waking, an ad being blocked - and that was quietly
// throwing away whatever had been typed. While a name is being edited, the
// parts that would destroy the box are left alone.
let editingName = 0;
function inlineEdit({ hide, value, place, save, cls = 'rename', max = 60 }) {
  hideTip();
  const inp = el('input', cls);
  inp.value = value; inp.maxLength = max;
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true; editingName = Math.max(0, editingName - 1);
    inp.remove(); hide.hidden = false;
    if (keep) save(inp.value.trim());
    render();
  };
  inp.onclick = (ev) => ev.stopPropagation();
  inp.ondblclick = (ev) => ev.stopPropagation();
  inp.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') finish(false);
  };
  inp.onblur = () => finish(true);
  editingName += 1;
  hide.hidden = true;
  place(inp);
  inp.focus(); inp.select();
}

function render() {
  if (!S) return;
  document.body.dataset.live = S.live ? '1' : '';
  document.body.dataset.space = S.space;
  applySide();
  if (S.space !== lastSpace) {
    if (lastSpace !== null) { newIdentity = S.settings.spaceLogins[S.space] || newIdentity; }
    lastSpace = S.space;
  }
  if (!editingName) { renderSpaces(); renderIdPick(); renderPins(); renderGroups(); }
  renderUpdate();
  renderBar();
  renderContent();
  renderGutters();
  renderLive();
  renderDownloads();
  renderExtras();
  const a = S.agent;
  const portBusy = a.last && a.last.tool === 'port';
  $('#agentline').innerHTML = portBusy ? 'AI agents: another Cue has the door'
    : a.last ? `<b>${esc(a.last.agent)}</b> · ${esc(a.last.tool)}${a.last.ok ? '' : ' (stopped)'}`
    : (a.on ? 'AI agents ready' : 'AI agents off');
}

// The sidebar has three shapes: full, an icon rail, and hidden until the mouse reaches the left edge.
const RAIL_AT = 132;
function applySide(width = S.sideWidth) {
  const hidden = !!S.settings.sideHidden; const root = document.documentElement.style;
  root.setProperty('--side-w', `${width}px`);
  root.setProperty('--bar-left', hidden ? '0px' : `${width}px`);
  root.setProperty('--content-left', hidden ? '8px' : `${width}px`);
  root.setProperty('--ai-w', `${S.aiWidth}px`);
  document.body.classList.toggle('rail', width < RAIL_AT);
  document.body.classList.toggle('sidehidden', hidden);
  document.body.classList.toggle('peeking', !!S.sideReveal);
  $('#sidehide').title = hidden ? 'Keep the sidebar open (⌘\\)' : 'Hide the sidebar (⌘\\)';
}

function grip(handle, axis, onMove, onEnd) {
  handle.onpointerdown = (e) => {
    e.preventDefault(); handle.setPointerCapture(e.pointerId); handle.classList.add('drag-on');
    const move = (m) => onMove(axis === 'x' ? m.clientX : m.clientY);
    const up = () => { handle.classList.remove('drag-on'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); if (onEnd) onEnd(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  };
}
const snapSide = (x) => (x < 96 ? 64 : Math.min(420, Math.round(x)));
grip($('#sidegrip'), 'x', (x) => { const w = snapSide(x); applySide(w); send('side-width', { w }); });
$('#sidegrip').ondblclick = () => send('side-width', { w: S.sideWidth < RAIL_AT ? 248 : 64 });
grip($('#aigrip'), 'x', (x) => send('ai-width', { w: Math.max(320, Math.min(720, Math.round(innerWidth - x))) }));
$('#sidehide').onclick = () => send('side-hide');
let hideTimer = null;
$('#edge').onmouseenter = () => { clearTimeout(hideTimer); send('side-reveal', { on: true }); };
$('#side').onmouseenter = () => clearTimeout(hideTimer);
$('#side').onmouseleave = () => { hideTimer = setTimeout(() => send('side-reveal', { on: false }), 280); };

function renderGutters() {
  const box = $('#gutters'); box.innerHTML = '';
  for (const g of S.gutters) {
    const d = el('div', `gutter ${g.axis}`);
    Object.assign(d.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.width}px`, height: `${g.height}px` });
    d.setAttribute('role', 'separator'); d.title = 'Drag to resize';
    grip(d, g.axis, (pos) => send('split-size', { i: g.i, axis: g.axis, pos }));
    box.append(d);
  }
  $('#aigrip').hidden = !S.ai;
}

function renderIdPick() {
  const box = $('#idpick'); box.innerHTML = '';
  for (const [id, v] of Object.entries(S.identities)) {
    const b = el('button', id === 'vanish' ? 'vanish' : '', id === 'vanish' ? '' : esc(v.name[0]));
    b.style.setProperty('--c', v.color);
    const what = { personal: 'Your own account', school: 'The school account', agent: 'The account AI agents use' }[id] || '';
    tip(b, id === 'vanish' ? 'Vanish window' : `${v.name}${S.labels[id] ? ` · ${S.labels[id]}` : ''}`,
      id === 'vanish' ? 'A window that saves nothing — no history, no cookies, no files' : `${what}. New tabs open here, with its own sign-ins.`);
    b.setAttribute('aria-label', id === 'vanish' ? 'Open a Vanish window' : `New tabs open as ${v.name}`);
    if (id !== 'vanish') { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', id === newIdentity); }
    if (id === newIdentity) b.classList.add('on');
    b.dataset.who = id;
    b.onclick = () => {
      if (id === 'vanish') { send('new-tab', { identity: 'vanish' }); return; }
      newIdentity = id; try { localStorage.setItem('cue.newIdentity', id); } catch {} renderIdPick();
    };
    box.append(b);
  }
  // A row of initials means nothing on its own, and naming the one that is
  // picked is not much better: it reads like a label for the whole row. Saying
  // what the row decides is the only version anybody understands at a glance.
  const who = S.identities[newIdentity];
  const cap = el('span', 'idwho');
  cap.append(el('i', '', 'New tabs:'));
  cap.append(el('b', '', esc(who ? who.name : '')));
  if (S.labels[newIdentity]) cap.append(el('span', '', esc(S.labels[newIdentity])));
  tip(cap, `New tabs open as ${who ? who.name : ''}`, 'Each account keeps its own sign-ins — one Google signed in to each, side by side.');
  box.append(cap);
}

function renderSpaces() {
  // Two levels, not one wrapped row: the Space you are in is the heading, the
  // others are a quiet row underneath you can tab across.
  const box = $('#spaces'); box.innerHTML = '';
  const rest = el('div', 'spacerow', '');
  rest.setAttribute('role', 'tablist');
  S.spaces.forEach((n, i) => {
    const count = S.tabs.filter((t) => t.space === n).length;
    const here = n === S.space;
    const b = el('button', here ? 'on' : '', '');
    b.append(el('span', 'nm', esc(n)));
    if (count) b.append(el('span', 'ct', String(count)));
    tip(b, `${n} · ${count} tab${count === 1 ? '' : 's'}`, `⌃${i + 1} · double-click to rename`);
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', here);
    b.onclick = () => send('space', { name: n });
    // Call them what you actually do. Double-click, type, Enter.
    b.ondblclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const nm = b.querySelector('.nm');
      inlineEdit({
        hide: nm, value: n, cls: 'spacename', max: 18,
        place: (inp) => b.prepend(inp),
        save: (to) => { if (to && to !== n) send('space-rename', { from: n, name: to }); },
      });
    };
    (here ? box : rest).append(b);
  });
  box.append(rest);
}

function renderUpdate() {
  // With updating left to itself there is nothing to show: the new version is
  // fetched in the background and goes in when you close Cue. Only a failure
  // is worth a line. Switch it off and the old bar comes back, where nothing
  // happens until you click it.
  const u = S.update; const bar = $('#updatebar');
  if (!u || u.state === 'idle' || u.state === 'checking') { bar.hidden = true; return; }
  if (S.settings.autoUpdate !== false && u.state !== 'error') { bar.hidden = true; return; }
  bar.hidden = false; bar.innerHTML = '';
  const say = el('span', 'u-say', '');
  const act = el('div', 'u-act', '');
  if (u.state === 'available') {
    say.textContent = `Cue ${u.latest} is ready.`;
    const get = el('button', '', 'Update'); get.onclick = () => send('update-get');
    const what = el('button', 'ghost', "What's new"); what.onclick = () => send('update-notes');
    act.append(get, what);
  } else if (u.state === 'downloading') {
    say.textContent = `Getting Cue ${u.latest}… ${u.percent}%`;
  } else if (u.state === 'ready') {
    say.textContent = `Cue ${u.latest} is ready to install.`;
    const go = el('button', '', 'Install and reopen'); go.onclick = () => send('update-install');
    act.append(go);
  } else if (u.state === 'error') {
    say.textContent = u.error || 'The update could not be checked.';
    const again = el('button', 'ghost', 'Try again'); again.onclick = () => send('update-check');
    act.append(again);
  }
  bar.append(say, act);
  if (u.state === 'ready' && u.error) bar.append(el('span', 'u-wait', u.error));
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
    const p = el('div', 'pin');
    tip(p, shortName(t), hostOf(t.url) || '');
    if (t.id === S.activeId) p.classList.add('active');
    if (t.id === S.programId) p.classList.add('onair');
    const letter = () => p.prepend(el('i', 'ltr', esc((shortName(t)[0] || '?').toUpperCase())));
    const page = /^cue:\/\/(\w+)/.exec(t.url || '');
    const srcs = iconSources(t);
    if (page && ICONS[page[1]]) p.innerHTML = ICONS[page[1]];
    else if (srcs.length) p.append(iconImg(srcs, letter));
    else letter();
    if (offLogin(t)) { const d = el('span', 'dot'); d.style.setProperty('--ring', t.agent ? 'var(--agent)' : ringColor(t)); p.append(d); }
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
  const title = el('span', 'title', esc(shortName(t)));
  tip(title, t.title || shortName(t), t.name ? 'Your name for this tab · double-click to change it' : 'Double-click to rename');
  title.ondblclick = (e) => {
    e.stopPropagation();
    inlineEdit({
      hide: title, value: t.name || shortName(t),
      place: (inp) => title.after(inp),
      save: (name) => send('rename', { id: t.id, name }),
    });
  };
  row.append(title);

  const ctl = el('span', 'ctl');
  if (t.badge) ctl.append(el('span', 'badge', t.badge > 99 ? '99+' : String(t.badge)));
  if (S.live && t.id === S.programId) ctl.append(el('span', 'tally on', 'ON AIR'));
  else if (S.live && t.id === S.activeId) ctl.append(el('span', 'tally cue', 'CUED'));
  else if (t.private) ctl.append(el('span', 'tally priv', 'PRIVATE'));
  else if (t.agent) ctl.append(el('span', 'tally ai', 'AI'));

  if (t.playing || t.audible) {
    const m = el('button', 'media', t.playing ? '❚❚' : '▶');
    tip(m, t.playing ? 'Pause' : 'Play', '⌃P');
    m.onclick = (e) => { e.stopPropagation(); send('media', { id: t.id, cmd: 'toggle' }); };
    ctl.append(m);
  }
  const hasSound = t.audible || t.muted || t.playing || t.volume < 1;
  const spk = el('button', 'spk' + (t.muted ? ' muted' : t.audible ? ' live' : ''), t.muted ? SPK.off : SPK.on);
  tip(spk, t.muted ? 'Unmute this tab' : `Volume ${Math.round(t.volume * 100)}%`, 'Click to mute · scroll to change · ⌥click for the slider');
  if (!hasSound) { spk.style.visibility = 'hidden'; row.addEventListener('mouseenter', () => { spk.style.visibility = 'visible'; }); row.addEventListener('mouseleave', () => { if (openVolId !== t.id) spk.style.visibility = 'hidden'; }); }
  spk.onclick = (e) => { e.stopPropagation(); if (e.altKey) { toggleVol(); return; } send('mute', { id: t.id }); };
  spk.onwheel = (e) => { e.preventDefault(); send('volume', { id: t.id, value: Math.round((t.volume + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100 }); };

  const pop = el('div', 'volpop');
  const r = el('input'); r.type = 'range'; r.min = 0; r.max = 100; r.value = Math.round(t.volume * 100);
  r.setAttribute('aria-label', `Volume for ${t.title}`);
  const pct = el('span', 'pct', `${r.value}%`);
  r.oninput = () => { pct.textContent = `${r.value}%`; send('volume', { id: t.id, value: r.value / 100 }); };
  r.onclick = (e) => e.stopPropagation();
  pop.append(r, pct);
  pop.onclick = (e) => e.stopPropagation();
  // The slider used to slide over the whole row the moment the pointer crossed the
  // speaker, which left you unable to click the tab you were aiming for. Now it
  // only ever opens because you asked, and it sits at the end of the row.
  let closeTimer;
  const closeVol = () => { clearTimeout(closeTimer); if (openVolId === t.id) openVolId = null; row.classList.remove('vol-open'); };
  const toggleVol = () => {
    if (openVolId === t.id) { closeVol(); return; }
    openVolId = t.id; row.classList.add('vol-open');
    document.querySelectorAll('.tab.vol-open').forEach((o) => { if (o !== row) o.classList.remove('vol-open'); });
    r.focus();
  };
  pop.addEventListener('mouseleave', () => { closeTimer = setTimeout(closeVol, 600); });
  pop.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  if (openVolId === t.id) row.classList.add('vol-open');
  row.append(pop);
  ctl.append(spk);

  const up = el('button', 'movet', '↑'); tip(up, 'Move up', '⌥⌘↑');
  up.setAttribute('aria-label', `Move ${shortName(t)} up`);
  up.onclick = (e) => { e.stopPropagation(); send('move-tab', { id: t.id, dir: -1 }); };
  const dn = el('button', 'movet', '↓'); tip(dn, 'Move down', '⌥⌘↓');
  dn.setAttribute('aria-label', `Move ${shortName(t)} down`);
  dn.onclick = (e) => { e.stopPropagation(); send('move-tab', { id: t.id, dir: 1 }); };
  ctl.append(up, dn);

  const x = el('button', 'close', '×'); tip(x, 'Close tab', '⌘W');
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
  $('#syncplay').classList.toggle('on', !!S.settings.syncPlay);
  $('#livetoggle').checked = S.live;
  $('#take').hidden = !S.live;
  renderShield(a);
}

// The shield in the address bar. It is the only place you ever find out that
// any of the blocking is happening, so it carries the real number for the page
// in front of you and goes grey, not invisible, when nothing was blocked.
function renderShield(a) {
  const btn = $('#shield');
  const on = S.settings.blockAds !== false;
  const show = !!(a && a.url && /^https?:/.test(a.url));
  btn.hidden = !show;
  if (!show) { closeShieldPop(); return; }
  const n = a.blocked || 0;
  btn.classList.toggle('quiet', !n);
  btn.classList.toggle('off', !on || a.adsOk);
  $('#shieldn').textContent = on && !a.adsOk && n ? String(n) : '';
  const site = hostOf(a.url);
  tip(btn, !on ? 'The shield is off' : a.adsOk ? `Ads are allowed on ${site}` : n ? `${n} ad${n === 1 ? '' : 's'} and tracker${n === 1 ? '' : 's'} blocked here` : 'Nothing to block on this page',
    'Click for this site');
}

function closeShieldPop() {
  const pop = $('#shieldpop');
  if (pop.hidden) return;
  pop.hidden = true;
  overlay(false);   // the page is a view of its own, stacked over this one
}

function openShieldPop() {
  const pop = $('#shieldpop');
  if (!pop.hidden) { closeShieldPop(); return; }
  const a = S.tabs.find((t) => t.id === S.activeId);
  if (!a || !a.url) return;
  const site = hostOf(a.url);
  const on = S.settings.blockAds !== false;
  pop.replaceChildren();
  pop.append(el('div', 'sp-n', on && !a.adsOk ? String(a.blocked || 0) : '—'));
  pop.append(el('div', 'sp-what', on && !a.adsOk ? `ads and trackers blocked on this page` : a.adsOk ? `ads are allowed on ${site}` : 'the shield is off'));
  const row = el('label', 'sp-row');
  const box = el('input'); box.type = 'checkbox'; box.checked = !a.adsOk;
  box.onchange = () => { send('ads-here', { block: box.checked, id: a.id }); closeShieldPop(); };
  row.append(box, el('span', '', `Block ads on ${site}`));
  pop.append(row);
  pop.append(el('div', 'note', 'Switch this off if the site breaks. Every other site stays protected.'));
  const more = el('button', 'btn small', 'Shield settings');
  more.onclick = () => { closeShieldPop(); openSettings(); };
  pop.append(more);
  pop.hidden = false;
  overlay(true);
}

function renderContent() {
  const fr = $('#frames'); fr.innerHTML = '';
  const side = S.settings.sideHidden ? 8 : S.sideWidth; const bar = 52;
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
    ...r.apps.map((x) => ({ k: 'NSM app', v: x.name, icon: new URL('/favicon.ico', x.url).href, run: openUrl(x.url) })),
    ...r.repos.map((x) => ({ k: 'GitHub', v: x.name, icon: 'https://github.com/favicon.ico', run: openUrl(x.url) })),
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
        const r = el('div', 'sg' + (i === sel ? ' sel' : ''), `<span class="k">${esc(it.k)}</span><span class="v">${it.icon ? `<img src="${esc(it.icon)}" alt="" onerror="this.remove()">` : ''}${esc(it.v)}</span>`);
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
    const rank = (b) => { const i = ['chrome', 'safari'].indexOf(b.id); return i < 0 ? 9 : i; };
    found.sort((a, b) => rank(a) - rank(b));
    for (const b of found) {
      for (const p of b.profiles) {
        const card = el('div', 'impcard');
        const c = p.counts || {};
        card.append(el('b', '', esc(`${b.name}${b.profiles.length > 1 ? ` · ${p.name}` : ''}`)));
        if (b.id === 'safari' && !c.bookmarks) {
          const allow = el('button', 'btn', 'Let Cue read Safari');
          allow.onclick = () => window.cue.invoke('open-disk-access');
          card.append(el('div', 'note', 'Your Mac keeps Safari private. Switch Cue on under Full Disk Access, reopen Cue, then come back here.'), allow);
        }
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
  // This call sat outside the try below, so anything it threw killed recording
  // silently: no file, no message, nothing to tell you it had not started.
  let info = null;
  try { info = await window.cue.invoke('rec-start'); }
  catch (e) { toast(`Recording could not start: ${e && e.message ? e.message : e}`); return; }
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
$('#shield').onclick = (e) => { e.stopPropagation(); hideTip(); openShieldPop(); };
document.addEventListener('click', (e) => {
  const pop = $('#shieldpop');
  if (!pop.hidden && !pop.contains(e.target) && e.target.closest('#shield') === null) closeShieldPop();
});
document.querySelectorAll('[data-split]').forEach((b) => { b.onclick = () => send('split', { mode: b.dataset.split }); });
$('#syncscroll').onclick = () => send('setting', { key: 'syncScroll', value: !S.settings.syncScroll });
$('#syncplay').onclick = () => send('setting', { key: 'syncPlay', value: !S.settings.syncPlay });
$('#livetoggle').onchange = (e) => send('live', { on: e.target.checked });
$('#take').onclick = () => send('take');
$('#lb-take').onclick = () => send('take');
$('#lb-end').onclick = () => send('live', { on: false });
$('#opensettings').onclick = () => openSettings();

let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); if (S && S.settings.sideHidden) { send('side-reveal', { on: true }); clearTimeout(hideTimer); hideTimer = setTimeout(() => send('side-reveal', { on: false }), 3000); } clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800); }

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
    sh.append(el('h3', '', 'Shield'));
    sh.append(settingRow('Block ads and trackers', check('blockAds', s.blockAds !== false), 'The same filter lists Brave and uBlock use. Ads, tracking scripts and cookie banners never load, so pages are lighter as well as quieter.'));
    sh.append(settingRow('Warn me about dangerous sites', check('warnDangerous', s.warnDangerous !== false), 'A page reported for handing out viruses, or for copying a real sign-in page to collect your password, is stopped with an explanation instead of opening.'));
    sh.append(settingRow('Try the secure address first', check('httpsFirst', s.httpsFirst !== false), 'Cue asks for https:// even when a link says http://, and tells you when a site has no secure address.'));
    sh.append(settingRow('Keep my real address hidden on a VPN', check('hideRealIP', s.hideRealIP !== false), 'Video calling normally hands a page every network address this Mac has, which is how a site reads your home address while NordVPN is on. Cue offers the public one only. Takes effect on the next page load.'));
    const shieldLine = el('div', 'note', 'Checking…'); sh.append(shieldLine);
    const shieldRow = el('div', 'row'); const refresh = el('button', 'btn small', 'Check for new threats now');
    refresh.onclick = async () => { refresh.disabled = true; refresh.textContent = 'Checking…'; await window.cue.invoke('shield.refresh'); refresh.textContent = 'Up to date'; showShield(); };
    shieldRow.append(el('span', 'note', ''), refresh); sh.append(shieldRow);
    const ago = (at) => {
      if (!at) return 'never';
      const d = Math.round((Date.now() - at) / 86400000);
      return d <= 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`;
    };
    const showShield = () => window.cue.invoke('shield.status').then((st) => {
      if (!st.on) { shieldLine.textContent = 'The shield is off. Nothing is being blocked.'; return; }
      const allowed = st.allowed.length ? ` Ads are allowed by hand on ${st.allowed.join(', ')}.` : '';
      shieldLine.textContent = `${st.listsMB} MB of ad and tracker rules, refreshed ${ago(st.listsAt)}. ${st.dangerous.toLocaleString()} dangerous sites known, refreshed ${ago(st.dangerAt)}.${allowed}`;
    });
    showShield();
    sh.append(el('h3', '', 'Updates'));
    sh.append(settingRow('Update Cue by itself', check('autoUpdate', s.autoUpdate !== false), 'A new version is fetched quietly in the background and put in place when you close Cue, so the next time you open it, it is the new one. Nothing is ever installed while Cue is open, so a class or a recording can never be interrupted.'));
    sh.append(el('h3', '', 'Spaces'));
    sh.append(el('div', 'note', 'Double-click a Space in the sidebar to call it whatever you like. Its tabs, its layout and the login it opens with all come across with the name.'));
    sh.append(el('h3', '', 'Logins'));
    sh.append(el('div', 'note', 'Personal, School and AI agent are three separate browsers sharing one window. Each keeps its own Google, Instagram and other sign-ins, so two Gmails stay signed in side by side and never see each other. The P / S / A row above the tabs chooses which one a NEW tab opens in; a tab keeps the one it was born with, and you can move it with a right-click. Name the account each one holds; AI agents read these names and use the right login without asking you.'));
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
    const team = el('div', 'row'); const teamBtn = el('button', 'btn', 'Load');
    teamBtn.onclick = () => { closeModal(); window.cue.invoke('team-vault'); };
    team.append(el('span', 'note', 'Load the portal and admin logins from team.nathanielschool.com, once. Cards and banks stay out.'), teamBtn);
    const pwBox = el('div', 'pwlist'); sh.append(pwBox);
    window.cue.invoke('team-offered').then((yes) => { if (yes) pwBox.before(team); });
    window.cue.invoke('passwords').then((list) => {
      if (!list.length) pwBox.append(el('div', 'note', 'No saved passwords yet. Cue offers to save one when you sign in to a site.'));
      const same = new Map(); // one row per login, even when it is kept for both Personal and School
      list.forEach((x) => { const k = `${x.origin}|${x.username}`; same.set(k, [...(same.get(k) || []), x]); });
      const ours = (g) => /(^|\.)nathanielschool\.com$/.test(hostOf(g[0].origin));
      const rows = [...same.values()].sort((p, q) => hostOf(p[0].origin).localeCompare(hostOf(q[0].origin)));
      [['Nathaniel School', rows.filter(ours)], ['Other sites', rows.filter((g) => !ours(g))]].forEach(([title, group]) => {
        if (group.length) pwBox.append(el('div', 'note', `${title} (${group.length})`));
        group.forEach((g) => {
          const x = g[0]; const r = el('div', 'row'); const a2 = check('', g.every((i) => i.auto)); a2.title = 'Sign in by itself on this site';
          a2.onchange = () => g.forEach((i) => send('pw-auto', { pw: i.id, on: a2.checked }));
          const rm = el('button', 'btn', 'Remove'); rm.onclick = () => { g.forEach((i) => send('pw-remove', { pw: i.id })); r.remove(); };
          const auto = el('label', 'note', ' auto'); auto.prepend(a2);
          const who = g.length > 1 ? 'Personal and School' : S.identities[x.identity].name;
          r.append(el('span', '', esc(`${hostOf(x.origin)} · ${x.username || 'no username'} · ${who}`)), auto, rm); pwBox.append(r);
        });
      });
    });
    sh.append(el('h3', '', 'Chrome extensions'));
    const exBox = el('div', 'pwlist'); sh.append(exBox);
    sh.append(el('div', 'note', 'An extension can read the pages you are signed in to, so each one says what it can do before you add it. Copied from your other browsers, so they keep working here. Removing one puts it in the Trash.'));
    // Each extension gets its sentence under its name, because "manifest
    // permissions: cookies, webRequest, <all_urls>" is not a warning anybody
    // can act on.
    const extRow = (x, right) => {
      const r = el('div', 'rowtall');
      const left = el('div', 'rowtext');
      left.append(el('div', '', esc(x.version ? `${x.name} · ${x.version}` : x.name)));
      if (x.can) left.append(el('div', 'note', esc(x.can)));
      r.append(left, right);
      return r;
    };
    window.cue.invoke('ext-find').then(({ available, installed }) => {
      if (installed.length) exBox.append(el('div', 'note', `In Cue now (${installed.length})`));
      installed.forEach((x) => {
        const b = el('button', 'btn danger', 'Remove');
        let sure = false;
        b.onclick = () => {
          if (!sure) { sure = true; b.textContent = 'Remove it?'; b.classList.add('sure'); setTimeout(() => { if (sure) { sure = false; b.textContent = 'Remove'; b.classList.remove('sure'); } }, 4000); return; }
          window.cue.invoke('ext-remove', { id: x.id });
          r.replaceChildren(el('span', 'note', esc(`${x.name} removed. It is in the Trash.`)));
        };
        const r = extRow({ ...x, name: x.on === false ? `${x.name} · off` : x.name }, b);
        exBox.append(r);
      });
      if (available.length) exBox.append(el('div', 'note', `Found in your other browsers (${available.length})`));
      available.slice(0, 30).forEach((x) => {
        const b = el('button', 'btn', 'Add'); const wrap = el('div', 'rowbtns');
        const st = el('span', 'note', esc(x.from));
        b.onclick = async () => { const res = await window.cue.invoke('ext-add', x); st.textContent = res.ok ? 'Added' : 'This one does not work in Cue yet'; b.disabled = true; };
        wrap.append(st, b);
        exBox.append(extRow(x, wrap));
      });
      if (!installed.length && !available.length) exBox.append(el('div', 'note', 'None found.'));
    });
    sh.append(el('h3', '', 'Tabs and sound'));
    sh.append(settingRow('Group tabs automatically (Google, AI & Subscriptions…)', check('autoGroup', s.autoGroup)));
    sh.append(settingRow('One tab plays at a time', check('onePlayer', s.onePlayer), 'When a tab starts playing, the others pause. The on-air tab is never paused.'));
    sh.append(settingRow('Original sound for music', check('originalSound', s.originalSound), 'Switches off echo cancel, noise cut and auto-volume on your microphone in web calls. Reload the call page after changing.'));
    sh.append(settingRow('Scroll split tabs together', check('syncScroll', s.syncScroll)));
    sh.append(settingRow('Play and pause split tabs together', check('syncPlay', s.syncPlay)));
    sh.append(settingRow('Sleep unused tabs after (minutes)', text('sleepMinutes', s.sleepMinutes, '30', 'number')));
    sh.append(settingRow('Archive unused tabs after (days, 0 = never)', text('archiveDays', s.archiveDays, '7', 'number'), 'Pinned tabs never archive. Find archived tabs in Library.'));
    sh.append(settingRow('Cache limit per login (MB)', text('cacheCapMB', s.cacheCapMB, '256', 'number'), 'Applies next time Cue opens. Sign-ins are not affected.'));
    const used = el('div', 'row'); const usedText = el('span', 'note', 'Measuring…'); const clearBtn = el('button', 'btn', 'Clear cache');
    clearBtn.onclick = () => send('clear-cache');
    used.append(usedText, clearBtn); sh.append(used);
    window.cue.invoke('storage').then((r) => { usedText.textContent = `Cache ${r.cacheMB} MB. Cue in total ${r.totalMB} MB. Trimmed automatically above ${r.limitMB} MB.`; });
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
  // The count climbs while the page loads, so it is nudged straight onto the
  // button rather than waiting for the next full state push.
  else if (name === 'blocked') {
    const t = S.tabs.find((x) => x.id === data.id);
    if (t) { t.blocked = data.n; if (data.id === S.activeId) renderShield(t); }
  }
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
