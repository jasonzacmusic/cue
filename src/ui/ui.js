// Cue sidebar + toolbar. Renders the state the main process sends and turns clicks into commands.
const $ = (s) => document.querySelector(s);
const send = (cmd, args) => window.cue.send(cmd, args);
let S = null;
let editingOmni = false;
let openVolId = null;

// A small screen with a smaller screen in its corner: the mini player.
const MINI = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="1.3" y="3" width="13.4" height="10" rx="1.7"/><rect x="8" y="7.6" width="5.3" height="4" rx="1" fill="currentColor" stroke="none"/></svg>';
const SPK = {
  on: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/><path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.3 3.9a5.8 5.8 0 0 1 0 8.2"/></svg>',
  off: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/><path d="M10.5 6l4 4M14.5 6l-4 4"/></svg>',
};

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function ringColor(t) { return t.identity === 'vanish' ? 'var(--muted)' : (S.identities[t.identity] || {}).color; }
// The people's folders that are open to pick from right now (not the AI agent lane, not locked ones).
const personFolders = () => (S.folders || []).filter((k) => k !== 'agent' && S.identities[k] && !S.identities[k].locked);

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
  // Cue's main side knows the site by name - an NSM app by its own name from the app list, a
  // service by what he calls it - and strips the unread count the badge already shows. Fall back
  // to trimming the page title only for a site it has never heard of.
  if (t.siteName) return t.siteName;
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
  // Last, a logo Cue ships, for the sites whose own icon never arrives: several NSM apps answer
  // 404 for /favicon.ico and used to show a bare letter. It comes after every attempt at the
  // site's own logo, so a site that has one still draws its own.
  if (t.siteLogo) tries.push(`../../assets/logos/${t.siteLogo}`);
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
// A tab is marked only when it is signed in somewhere other than the folder you
// have open — otherwise every row in the folder carried the same mark.
function offLogin(t) {
  return t.agent || t.identity !== S.folder;
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
  // Muted has to be readable at a glance and without relying on colour, because
  // red already means on air. A crossed-out speaker says it outright, and it is
  // the same mark wherever the tab appears.
  if (t.muted) f.append(el('b', 'favsound off', SPK.off));
  else if (t.audible) f.append(el('b', 'favsound'));
  return f;
}

// ---------------------------------------------------------------- render
let lastSpace = null;
const inSpace = (t) => t.space === S.space;
// The two axes, kept apart on purpose: WHOSE account (the folder) and WHICH
// job (the Space). A tab shows in the sidebar when it is in both.
const inFolder = (t) => t.identity === S.folder;
// With the AI row switched on, the two axes step aside: you are looking at
// what the agents have, wherever it lives.
const here = (t) => (aiFilter ? !!t.aiHanded : inSpace(t) && inFolder(t));

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
  // The sidebar's colour is the Space's own tint (Settings > Spaces), never read off its name.
  document.body.dataset.tint = ((S.spaceList || []).find((x) => x.name === S.space) || {}).tint || 'rose';
  applySide();
  lastSpace = S.space;
  if (!editingName) { renderSpaces(); renderFolders(); renderAI(); renderPins(); renderGroups(); renderElsewhere(); }
  renderUpdate();
  renderBar();
  renderContent();
  renderGutters();
  renderLive();
  renderDownloads();
  renderExtras();
  const a = S.agent;
  const portBusy = a.last && a.last.tool === 'port';
  $('#agentline').innerHTML = !a.listening && !a.on ? ''
    : portBusy ? 'AI agents: another Cue has the door'
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

// A drag is a button held down, from the press to the release, and nothing else.
// It used to listen on the handle itself, and the handle is thrown away and drawn
// again on every state push - which a resize itself causes. The press was captured
// on an element that no longer existed by the time the mouse moved, so the release
// never arrived and the divider went on following the mouse with nothing held down.
// The window outlives every redraw, so the whole gesture is tracked there, pinned
// to the one finger or button that started it.
let dragging = 0;
function grip(handle, axis, onMove, onEnd) {
  handle.onpointerdown = (e) => {
    if (e.button !== 0 || dragging) return;   // left button only, one drag at a time
    e.preventDefault(); handle.classList.add('drag-on');
    const id = e.pointerId; dragging = id;
    const move = (m) => { if (m.pointerId === id) onMove(axis === 'x' ? m.clientX : m.clientY); };
    const up = (m) => {
      if (m && m.pointerId !== id) return;
      dragging = 0; handle.classList.remove('drag-on');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (onEnd) onEnd();
      render();                                // redraw whatever was held back
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
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
  // Never pull the divider out from under a drag in progress.
  if (dragging) return;
  const box = $('#gutters'); box.innerHTML = '';
  for (const g of S.gutters) {
    const d = el('div', `gutter ${g.axis}`);
    Object.assign(d.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.width}px`, height: `${g.height}px` });
    d.setAttribute('role', 'separator'); d.title = 'Drag to resize';
    grip(d, g.axis, (pos) => send('split-size', { i: g.i, axis: g.axis, pos }));
    d.ondblclick = () => send('split-even');
    box.append(d);
  }
  $('#aigrip').hidden = !S.ai;
}

// The three logins, drawn as folders with a picture on them.
//
// This replaces the old "+ P S A" row of initials. A letter is a thing you have
// to decode; a face, the school's N and a plain spark are things you recognise
// without reading. And each folder says in words whose it is, so there is never
// a moment of "which one is S again".
//
// Clicking a folder opens it: the sidebar below shows that folder's tabs, the
// next new tab is born in it, and it is signed in to its own Gmail, Instagram,
// YouTube and WhatsApp — all three at once, nothing to toggle.
// A folder's face: its picture, or the first letter of its name on its own colour.
function folderFace(v) {
  const face = el('span', 'fface');
  const letter = () => face.prepend(el('i', 'fltr', esc((v.name || '?')[0].toUpperCase())));
  if (v.picture) {
    const img = el('img', 'fpic'); img.src = `../../assets/logos/${v.picture}`; img.alt = '';
    img.onerror = () => { img.remove(); letter(); };
    face.append(img);
  } else letter();
  return face;
}
const LOCK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';

function renderFolders() {
  const box = $('#folders'); box.innerHTML = '';
  for (const id of (S.pickFolders || S.folders)) {
    const v = S.identities[id]; if (!v) continue;
    const mine = id === S.folder;
    const info = (S.folderInfo || {})[id] || {};
    // Another folder is a name, a colour and counts. A locked one is not even counted.
    const all = info.tabs || 0;
    const b = el('button', `folder${mine ? ' on' : ''}${v.locked ? ' locked' : ''}`);
    b.style.setProperty('--c', v.color);
    b.dataset.who = id;
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', mine);

    const face = folderFace(v);
    const txt = el('span', 'ftext');
    const top = el('span', 'frow');
    top.append(el('b', '', esc(v.name)));
    if (v.locked) top.append(el('span', 'flock', LOCK));
    else if (all) top.append(el('span', 'fct', String(all)));
    txt.append(top);
    // Whose it is, in words, under the name - for the folder that is open. No one should have
    // to remember that "School" means music@nathanielschool.com. Another person's folder never
    // shows the account it holds.
    const acct = mine ? (S.labels[id] || v.about || '') : '';
    if (acct) txt.append(el('span', 'facct', esc(acct)));
    // The accounts this folder is holding, one mark each, read off the pages
    // themselves. They stay on the folder after the tab is closed, so you can
    // see at a glance which Instagram is signed in here without opening it.
    const who = (S.whose || {})[id] || {};
    const live = Object.entries(who).filter(([, x]) => x && x.who);
    if (live.length) {
      const row = el('span', 'fwho');
      for (const [key, x] of live) {
        // The handle itself, not just a mark: knowing it is Instagram is no use,
        // knowing it is @jasonzac is the whole point. An address loses its
        // domain, which is already on the line above.
        const short = /^[^@]+@/.test(x.who) ? x.who.replace(/@.*$/, '') : x.who;
        const chip = el('i', `fchip ${key}`);
        chip.append(el('u', 'fdot'), document.createTextNode(short));
        chip.title = `${x.label} \u00b7 ${x.who}`;
        row.append(chip);
      }
      txt.append(row);
    }
    face.append(txt);
    b.append(face);

    const held = live.map(([, x]) => `${x.label}: ${x.who}`).join(' · ');
    const unread = info.unread ? ` · ${info.unread} unread` : '';
    tip(b, `${v.name}${acct ? ` · ${acct}` : ''}`,
      v.locked ? 'Locked. Click to type its passcode.'
        : `${held ? `${held}\n` : ''}${mine ? `Open. ${all} tab${all === 1 ? '' : 's'} in here, and new tabs are born in it.`
          : `${all} tab${all === 1 ? '' : 's'} in here${unread}. Click to open this folder — new tabs go in it and it stays signed in as its own account.`}${id !== 'agent' ? '\nRight-click to lock it now.' : ''}`);
    b.onclick = () => send('folder', { name: id });
    if (id !== 'agent') b.oncontextmenu = (e) => { e.preventDefault(); send('folder-menu', { id }); };
    box.append(b);
  }
  const foot = el('div', 'fbottom');
  // A new person gets a folder of their own: their own sign-ins, WhatsApp, Google, tabs,
  // history and passwords. Click, type a name, press Enter.
  const add = el('button', 'addperson', `${ICONS.plus}<span class="ap">Add a person</span>`);
  tip(add, 'Add a person', 'A private folder of their own: own sign-ins, WhatsApp, Google, tabs, history and passwords');
  add.onclick = () => {
    if (add.querySelector('input')) return;
    inlineEdit({
      hide: add.querySelector('.ap'), value: '', cls: 'rename newperson', max: 40,
      place: (inp) => { inp.placeholder = 'Their name'; add.append(inp); },
      save: (name) => { if (name) send('folder.add', { name }); },
    });
  };
  foot.append(add);
  // Vanish is not a folder: it keeps nothing, so it holds no tabs and stays
  // signed in to nothing. It is a window you open, so it stays a button - a
  // dashed circle, where adding a person is a plain labelled button beside it.
  const van = el('button', 'vanish');
  van.style.setProperty('--c', (S.identities.vanish || {}).color || 'var(--muted)');
  tip(van, 'Vanish window', 'A window that saves nothing — no history, no cookies, no files');
  van.setAttribute('aria-label', 'Open a Vanish window');
  van.onclick = () => send('new-tab', { identity: 'vanish' });
  foot.append(van);
  box.append(foot);
}

// Tabs in this Space that are sitting in one of the other folders. The folder
// filters the list, so this line is what stops a tab ever looking lost: it
// names where the rest are and takes you there in one click.
function renderElsewhere() {
  const box = $('#elsewhere'); box.innerHTML = '';
  // Counts only: the main side sends a number for each other folder, never its tabs.
  const others = (S.pickFolders || S.folders)
    .filter((id) => id !== S.folder)
    .map((id) => ({ id, n: ((S.folderInfo || {})[id] || {}).here || 0 }))
    .filter((x) => x.n);
  box.hidden = !others.length;
  if (!others.length) return;
  box.append(el('i', '', 'Also in this Space:'));
  for (const o of others) {
    const b = el('button', '', `${esc(S.identities[o.id].name)} ${o.n}`);
    b.style.setProperty('--c', S.identities[o.id].color);
    tip(b, `${o.n} tab${o.n === 1 ? '' : 's'} in ${S.identities[o.id].name}`, 'Click to open that folder');
    b.onclick = () => send('folder', { name: o.id });
    box.append(b);
  }
}

function renderSpaces() {
  // Two levels, not one wrapped row: the Space you are in is the heading, the
  // others are a quiet row underneath you can tab across.
  const box = $('#spaces'); box.innerHTML = '';
  // One Space is no choice at all, so the row stays out of the way until there is a second.
  box.hidden = S.spaces.length <= 1;
  if (box.hidden) return;
  const rest = el('div', 'spacerow', '');
  rest.setAttribute('role', 'tablist');
  S.spaces.forEach((n, i) => {
    const count = S.tabs.filter((t) => t.space === n && !t.away).length;
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
  // happens until you click it. A failure is said once per version, in the
  // updater's own plain words (never a raw error), and can be put away.
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
    say.textContent = u.error || 'Cue could not check for a new version just now. It will try again later.';
    const again = el('button', 'ghost', 'Try again'); again.onclick = () => send('update-check');
    const ok = el('button', 'ghost', 'OK'); ok.onclick = () => send('update-dismiss');
    act.append(again, ok);
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
  // Say whose login the panel is using, so he is never guessing which account Claude Code or Codex
  // came up as.
  $('#aiwho').textContent = S.ai && S.ai.folder ? `as ${(S.identities[S.ai.folder] || {}).name || S.ai.folder}` : '';
  $('#peekbar').hidden = !S.peek;
  if (S.peek) $('#peektitle').textContent = S.peek.title;
  $('#recbtn').hidden = !S.recording;
}

// The tabs the strip at the top is drawing right now. They are shown once, up
// there, and never again down in the groups: WhatsApp used to appear twice at
// the same time - as an icon at the top AND as a row under Social - because the
// strip shows an app whichever folder pinned it, while the row below belonged
// to the folder you were in. One app, one place.
let stripIds = new Set();

function renderPins() {
  const box = $('#pins'); box.innerHTML = '';
  stripIds = new Set();
  // Dropping a tab on the strip pins it. Everywhere else in the sidebar you can
  // drag a row where you want it, and this row used to be the one place you
  // could not.
  box.ondragover = (e) => { e.preventDefault(); box.classList.add('drop'); };
  box.ondragleave = () => box.classList.remove('drop');
  box.ondrop = (e) => {
    e.preventDefault(); box.classList.remove('drop');
    const id = Number(e.dataTransfer.getData('text/cue-tab'));
    if (id) send('pin', { id, on: true });
  };
  // An app pinned in any folder shows in every folder. Pinning WhatsApp once
  // used to make it vanish the moment he switched to the school, which is the
  // opposite of what a pin is for: the strip is the apps he uses, and the
  // folder decides whose account opens.
  //
  // Pinning is by SITE, not by tab. School's WhatsApp was pinned and his own
  // was not, so he had a WhatsApp icon at the top and a second WhatsApp row
  // under Social at the same time - two of one thing. Once a site is in the
  // strip it is in the strip for every folder, and the tab drawn is this
  // folder's own, pinned or not. Clicking it is instant: the folder already
  // has that tab open, so it simply comes forward.
  const pinnedHosts = new Set(S.tabs.filter((y) => y.pinned).map((y) => hostOf(y.url)).filter(Boolean));
  const byHost = new Map();
  const better = (x, seen) => !seen || (here(x) && !here(seen)) || (here(x) === here(seen) && x.lastActive > seen.lastActive);
  for (const x of S.tabs) {
    const host = hostOf(x.url);
    const key = x.pinned && !host ? `tab:${x.id}` : host;
    if (!key || (!x.pinned && !pinnedHosts.has(key))) continue;
    if (better(x, byHost.get(key))) byHost.set(key, x);
  }
  for (const t of byHost.values()) {
    const p = el('div', 'pin');
    p.draggable = true;
    p.ondragstart = (e) => { e.dataTransfer.setData('text/cue-tab', String(t.id)); p.classList.add('dragging'); };
    p.ondragend = () => p.classList.remove('dragging');
    p.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); p.classList.add('dropon'); };
    p.ondragleave = () => p.classList.remove('dropon');
    p.ondrop = (e) => {
      e.preventDefault(); e.stopPropagation(); p.classList.remove('dropon');
      const id = Number(e.dataTransfer.getData('text/cue-tab'));
      if (id && id !== t.id) send('reorder', { id, beforeId: t.id });
    };
    p.dataset.id = t.id;
    const v = volOf(t);
    const where = here(t) ? (hostOf(t.url) || '') : `Opens as ${(S.identities[S.folder] || {}).name || 'this folder'}`;
    tip(p, `${shortName(t)}${t.muted ? ' \u00b7 muted' : v < 1 ? ` \u00b7 ${pctOf(v)}%` : ''}`,
      `${where ? `${where} \u00b7 ` : ''}${OPT}-scroll to change volume \u00b7 ${OPT}-click to mute`);
    if (t.id === S.activeId) p.classList.add('active');
    if (t.id === S.programId) p.classList.add('onair');
    const letter = () => p.prepend(el('i', 'ltr', esc((shortName(t)[0] || '?').toUpperCase())));
    const page = /^cue:\/\/(\w+)/.exec(t.url || '');
    const srcs = iconSources(t);
    if (page && ICONS[page[1]]) p.innerHTML = ICONS[page[1]];
    else if (srcs.length) p.append(iconImg(srcs, letter));
    else letter();
    if (offLogin(t)) { const d = el('span', 'dot'); d.style.setProperty('--ring', t.agent ? 'var(--agent)' : ringColor(t)); p.append(d); }
    // The strip is where he looks first, so a muted app says so here too - and
    // the badge is a real button, because the whole point of seeing it is being
    // able to silence WhatsApp without first hunting for its row.
    // Muted, it is the same crossed-out speaker the tab rows carry (.favsound.off),
    // so one look - and one test - finds a muted app wherever it is drawn.
    const pm = el('button', 'pinmute' + (t.muted ? ' off favsound' : ''), t.muted ? SPK.off : SPK.on);
    tip(pm, t.muted ? `Unmute ${shortName(t)}` : `Mute ${shortName(t)}`, t.muted ? 'Click to hear it again' : 'Click the speaker');
    pm.onclick = (e) => { e.preventDefault(); e.stopPropagation(); send('mute', { id: t.id }); };
    pm.onmousedown = (e) => e.stopPropagation();
    p.append(pm);
    // The level: a thin bar along the bottom edge, as long as the volume is loud.
    // Drawn while the app is making sound or is set below 100%; a quiet app at
    // full volume carries nothing extra. A shape, not a colour - red means on air.
    if (!t.muted && (t.audible || v < 1)) {
      const lv = el('i', 'lvl', '<i></i>');
      lv.style.setProperty('--lvl', String(v));
      p.append(lv);
    }
    if (t.muted) p.classList.add('ismuted');
    else if (t.audible) p.classList.add('issounding');
    if (!here(t)) p.classList.add('elsewhere');
    // Option-click silences or wakes the app without opening it.
    p.onclick = (e) => {
      if (e.altKey) { e.preventDefault(); send('mute', { id: t.id }); return; }
      if (here(t)) send('activate', { id: t.id }); else send('app-open', { url: t.url });
    };
    p.oncontextmenu = (e) => { e.preventDefault(); send('tab-menu', { id: t.id }); };
    p.addEventListener('wheel', altWheel(t), { passive: false });
    // Resting on an app that is playing brings up its volume, close to the tile
    // but never over it, so the click you were aiming still lands on the app.
    p.addEventListener('mouseenter', () => {
      clearTimeout(VP.openT);
      if (VP.id === t.id) return;
      if (t.audible || t.playing) VP.openT = setTimeout(() => openVolPop(t.id, 'hover'), 450);
    });
    p.addEventListener('mouseleave', () => clearTimeout(VP.openT));
    p.addEventListener('mousedown', () => clearTimeout(VP.openT));
    stripIds.add(t.id);
    box.append(p);
  }
  // The strip is rebuilt on every state push; the open volume control is not, so
  // it follows the new tile and shows the new level.
  if (VP.id != null) refreshVolPop();
}

// ---------------------------------------------------------------- volume on the pinned apps
// The key is called Option on a Mac and Alt everywhere else, and the words say so.
const OPT = window.cue.platform === 'darwin' ? 'Option' : 'Alt';
const pctOf = (v) => Math.round((v ?? 1) * 100);
// What he has just asked for, ahead of the state push that confirms it, so five
// quick scroll steps are five steps and not the same step five times.
const volAsked = new Map();
function volOf(t) {
  const a = volAsked.get(t.id);
  return a && Date.now() - a.at < 1500 ? a.v : (t.volume ?? 1);
}
function setVol(t, v) {
  v = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
  volAsked.set(t.id, { v, at: Date.now() });
  send('volume', { id: t.id, value: v });
  const lv = document.querySelector(`.pin[data-id="${t.id}"] .lvl`);
  if (lv) lv.style.setProperty('--lvl', String(v));
  if (VP.id === t.id) fillVolPop(t, v);
}
// One step is 5%, landing on the 5% marks, so 37% goes to 40% or 35%.
function stepVol(t, dir) { setVol(t, Math.round((pctOf(volOf(t)) + dir * 5) / 5) * 5 / 100); }

// Option + scroll over a tile (or a tab row) changes that tab's volume. A plain
// scroll is left alone so the sidebar still scrolls. A trackpad sends dozens of
// tiny deltas and a mouse wheel a few big ones, so small ones are added up first.
const wheelAcc = new Map();
const altWheel = (t) => (e) => { if (e.altKey) wheelStep(t, e); };
function wheelStep(t, e) {
  e.preventDefault(); e.stopPropagation();
  const dy = (e.deltaMode === 1 ? 40 : 1) * (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX);
  const w = wheelAcc.get(t.id) || { acc: 0, at: 0 };
  if (Date.now() - w.at > 400) w.acc = 0;
  w.at = Date.now();
  let dir = 0;
  if (Math.abs(dy) >= 50) { dir = Math.sign(dy); w.acc = 0; } else { w.acc += dy; if (Math.abs(w.acc) >= 50) { dir = Math.sign(w.acc); w.acc = 0; } }
  wheelAcc.set(t.id, w);
  if (dir) stepVol(t, -dir); // scrolling up is louder
}

// The volume control for one pinned app: speaker (mute), slider, the number,
// and a way back to 100%. One of them, made once, anchored under the tile.
const VP = { id: null, mode: null, openT: 0, closeT: 0, dragging: false, entered: false };
const vpEl = el('div', 'tvol');
vpEl.hidden = true;
vpEl.setAttribute('role', 'dialog');
vpEl.innerHTML = `<div class="tv-row"><button class="tv-spk" type="button"></button><input class="tv-range" type="range" min="0" max="100" step="1"><span class="tv-pct"></span><button class="tv-reset" type="button">100%</button></div>
  <div class="tv-hint">${OPT}-scroll the app · M mutes · Esc</div>`;
document.body.append(vpEl);
const vpSpk = vpEl.querySelector('.tv-spk'); const vpRange = vpEl.querySelector('.tv-range');
const vpPct = vpEl.querySelector('.tv-pct'); const vpReset = vpEl.querySelector('.tv-reset');
const vpTab = () => S && S.tabs.find((x) => x.id === VP.id);
const vpTile = () => (VP.id == null ? null : document.querySelector(`.pin[data-id="${VP.id}"]`));

function fillVolPop(t, v = volOf(t)) {
  const n = pctOf(v);
  vpSpk.innerHTML = t.muted ? SPK.off : SPK.on;
  vpSpk.classList.toggle('off', !!t.muted);
  vpSpk.setAttribute('aria-label', t.muted ? `Unmute ${shortName(t)}` : `Mute ${shortName(t)}`);
  if (!VP.dragging) vpRange.value = n;
  vpRange.setAttribute('aria-label', `Volume for ${shortName(t)}`);
  vpRange.style.setProperty('--fill', `${n}%`);
  vpPct.textContent = t.muted ? 'Muted' : `${n}%`;
  vpReset.disabled = n === 100 && !t.muted;
  vpReset.setAttribute('aria-label', 'Back to 100%');
  vpEl.setAttribute('aria-label', `Volume for ${shortName(t)}`);
}
function placeVolPop() {
  const tile = vpTile();
  if (!tile) { closeVolPop(); return; }
  const r = tile.getBoundingClientRect();
  const side = $('#side').getBoundingClientRect();
  const w = vpEl.offsetWidth;
  const x = Math.max(side.left + 6, Math.min(side.right - w - 6, r.left + r.width / 2 - w / 2));
  vpEl.style.left = `${Math.round(x)}px`;
  vpEl.style.top = `${Math.round(r.bottom + 6)}px`;
  document.querySelectorAll('.pin.volopen').forEach((p) => { if (p !== tile) p.classList.remove('volopen'); });
  tile.classList.add('volopen');
}
function openVolPop(id, mode) {
  const t = S && S.tabs.find((x) => x.id === id);
  if (!t) return;
  clearTimeout(VP.closeT); VP.closeT = 0;
  VP.id = id; VP.mode = mode; VP.entered = mode === 'hover';
  hideTip();
  fillVolPop(t);
  vpEl.hidden = false;
  placeVolPop();
  // Opened on purpose (the menu), it takes the keyboard; opened by resting the
  // pointer, it leaves the keyboard with the page he is typing in.
  VP.at = Date.now();
  if (mode === 'held') vpRange.focus();
}
function closeVolPop() {
  clearTimeout(VP.closeT); clearTimeout(VP.openT); VP.closeT = 0;
  VP.id = null; VP.mode = null; VP.dragging = false;
  vpEl.hidden = true;
  document.querySelectorAll('.pin.volopen').forEach((p) => p.classList.remove('volopen'));
}
function refreshVolPop() {
  const t = vpTab();
  if (!t) { closeVolPop(); return; }
  fillVolPop(t); placeVolPop();
}
vpSpk.onclick = () => { const t = vpTab(); if (t) send('mute', { id: t.id }); };
// Back to 100% also unmutes: main's setVolume switches the sound back on for any level above 0.
vpReset.onclick = () => { const t = vpTab(); if (t) setVol(t, 1); };
vpRange.addEventListener('pointerdown', () => { VP.dragging = true; });
addEventListener('pointerup', () => { VP.dragging = false; });
vpRange.oninput = () => { const t = vpTab(); if (t) setVol(t, Number(vpRange.value) / 100); };
// On the document, not the control: pressing 100% disables that button and the
// keyboard falls back to the page body, and Esc must still close it.
document.addEventListener('keydown', (e) => {
  const t = vpTab();
  if (!t) return;
  const f = document.activeElement;
  if (!(vpEl.contains(f) || !f || f === document.body)) return;
  const k = e.key;
  if (k === 'Escape') { e.preventDefault(); closeVolPop(); return; }
  if (k === 'ArrowUp' || k === 'ArrowRight') { e.preventDefault(); stepVol(t, 1); return; }
  if (k === 'ArrowDown' || k === 'ArrowLeft') { e.preventDefault(); stepVol(t, -1); return; }
  if (k === 'm' || k === 'M') { e.preventDefault(); send('mute', { id: t.id }); }
});
vpEl.addEventListener('wheel', (e) => { const t = vpTab(); if (t) wheelStep(t, e); }, { passive: false });
// It closes when the pointer has left both the tile and the control. Measured
// against where they are drawn rather than with enter/leave events, because the
// tile under the pointer is replaced on every state push.
const inRect = (r, x, y, pad) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
function overVol(x, y) {
  const tile = vpTile();
  const a = tile && inRect(tile.getBoundingClientRect(), x, y, 4);
  const b = inRect(vpEl.getBoundingClientRect(), x, y, 6);
  if (b) VP.entered = true;
  return a || b;
}
const closeSoon = () => { if (VP.id != null && !VP.closeT) VP.closeT = setTimeout(closeVolPop, 300); };
document.addEventListener('mousemove', (e) => {
  if (VP.id == null || VP.dragging) return;
  if (overVol(e.clientX, e.clientY)) { clearTimeout(VP.closeT); VP.closeT = 0; return; }
  // Opened from the menu, the pointer may start anywhere; it closes once it has
  // been in the control and left, or on Esc, or on a click somewhere else.
  if (VP.mode === 'held' && !VP.entered) return;
  closeSoon();
});
document.addEventListener('mouseout', (e) => { if (!e.relatedTarget && VP.mode === 'hover') closeSoon(); });
document.addEventListener('mousedown', (e) => {
  if (VP.id == null) return;
  if (vpEl.contains(e.target) || (vpTile() && vpTile().contains(e.target))) return;
  closeVolPop();
}, true);
// A click on a page moves the keyboard away from the sidebar: that closes it too
// (but not the focus shuffle of the menu that has just opened it).
addEventListener('blur', () => { if (VP.id != null && Date.now() - (VP.at || 0) > 400) closeVolPop(); });
addEventListener('resize', () => { if (VP.id != null) placeVolPop(); });

function renderGroups() {
  const box = $('#groups');
  const scroll = box.scrollTop;
  box.innerHTML = '';
  const splitIds = S.split.mode !== 'single' ? S.split.ids : [];
  for (const g of S.groups) {
    const list = S.tabs.filter((t) => !t.pinned && !t.temp && !stripIds.has(t.id) && t.group === g.id && here(t));
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
    // Dragging a pinned tab down onto a group takes it off the strip again.
    head.ondrop = (e) => { e.preventDefault(); head.classList.remove('drop'); const id = Number(e.dataTransfer.getData('text/cue-tab')); if (!id) return; const d = S.tabs.find((x) => x.id === id); if (d && d.pinned) send('pin', { id, on: false }); if (d && d.temp) send('tab-temp', { id, on: false }); send('reorder', { id, group: g.id }); };
    wrap.append(head);
    const ul = el('div', 'tablist');
    for (const t of list) ul.append(tabRow(t, splitIds));
    wrap.append(ul);
    box.append(wrap);
  }
  box.append(tempSection(splitIds));
  box.scrollTop = scroll;
}

// The second tier: tabs that are just for now. Same folder and sign-ins as the tabs above, but
// cleared when Cue closes (or after the hours set in Settings > Keeping tabs) and never archived.
// Drag a tab here to make it just for now; drag it up into the groups, pin it, or right-click >
// Keep this tab to keep it.
function tempSection(splitIds) {
  const list = S.tabs.filter((t) => t.temp && !t.pinned && !stripIds.has(t.id) && here(t));
  const sec = el('section', 'tempsec' + (list.length ? '' : ' empty'));
  sec.setAttribute('aria-label', 'Just for now');
  const head = el('div', 'thead');
  const title = el('span', 'tt', 'Just for now');
  head.append(title);
  if (list.length) head.append(el('span', 'n', String(list.length)));
  const add = el('button', 'tadd', ICONS.plus || '+'); add.type = 'button';
  tip(add, 'New tab just for now', `${/Mac/i.test(navigator.platform || '') ? '⌥⌘T' : 'Ctrl+Alt+T'} · cleared when its time is up, never archived`);
  add.onclick = (e) => { e.stopPropagation(); send('new-tab', { temp: true }); };
  head.append(add);
  if (list.length) {
    const clr = el('button', 'tclear', 'Clear'); clr.type = 'button';
    tip(clr, `Close these ${list.length} tab${list.length === 1 ? '' : 's'} now`, 'They are not archived and Reopen Closed Tab will not bring them back');
    clr.onclick = (e) => { e.stopPropagation(); send('temp-clear'); };
    head.append(clr);
  }
  sec.append(head);
  const hours = S.settings.tempClear;
  const when = hours === 'quit' || hours == null ? 'cleared when Cue closes' : `cleared after ${hours} hour${Number(hours) === 1 ? '' : 's'}`;
  const sub = el('div', 'tsub', esc(when));
  tip(sub, 'Just for now', 'Change when in Settings > Keeping tabs');
  sec.append(sub);
  const ul = el('div', 'tablist');
  for (const t of list) ul.append(tabRow(t, splitIds));
  sec.append(ul);
  sec.ondragover = (e) => { e.preventDefault(); sec.classList.add('drop'); };
  sec.ondragleave = (e) => { if (!sec.contains(e.relatedTarget)) sec.classList.remove('drop'); };
  sec.ondrop = (e) => {
    e.preventDefault(); sec.classList.remove('drop');
    const id = Number(e.dataTransfer.getData('text/cue-tab'));
    const d = S.tabs.find((x) => x.id === id);
    if (d && !d.temp) send('tab-temp', { id, on: true });
  };
  return sec;
}

function tabRow(t, splitIds) {
  const row = el('div', 'tab');
  row.dataset.id = t.id;
  if (t.id === S.activeId) row.classList.add('active');
  if (splitIds.includes(t.id)) row.classList.add('insplit');
  if (t.sleeping) row.classList.add('sleeping');
  if (t.mini) row.classList.add('inmini');
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
  else if (t.private) ctl.append(tip(el('span', 'tally priv', 'OFF AIR'), 'Off air', 'This tab is never shown to the class. Right-click to change.'));

  // Handing a tab to Claude Code or Codex used to mean finding a checkbox three levels into a
  // right-click menu, so nobody did it. It is a button on the row now: lit means agents may work
  // in this tab, faint means only he can. A tab an agent opened itself is always lit and cannot be
  // switched off from here - closing it is how you take it back.
  if (!t.private && t.identity !== 'vanish' && !String(t.url || '').startsWith('cue://')) {
    const fixed = t.agent || t.aiSite;
    // The mark used to sit on every row all day and say only "this tab is
    // ALLOWED to be used by an agent", which is not news. Lit now means an agent
    // is working in this tab at this moment. Otherwise it waits out of sight and
    // appears when you point at the row, so the sidebar is tab names and nothing
    // else until you reach for something.
    const ai = el('button', 'aitog' + (t.aiBusy ? ' busy' : t.aiOk ? ' on' : ' idle'), 'AI');
    tip(ai, t.aiBusy ? 'An agent is working in this tab right now'
      : t.agent ? 'An agent opened this tab, so it can work here'
      : t.aiSite ? `${t.aiSite} is handed to agents for every folder \u00b7 change that in Settings`
      : t.aiOk ? 'Claude Code and Codex may work in this tab \u00b7 click to take it back'
               : 'Only you can use this tab \u00b7 click to hand it to Claude Code and Codex');
    if (fixed) ai.disabled = true;
    else ai.onclick = (e) => { e.stopPropagation(); send('ai-tab', { id: t.id }); };
    ctl.append(ai);
  }

  if (t.playing || t.audible) {
    const m = el('button', 'media', t.playing ? '❚❚' : '▶');
    tip(m, t.playing ? 'Pause' : 'Play', '⌃P');
    m.onclick = (e) => { e.stopPropagation(); send('media', { id: t.id, cmd: 'toggle' }); };
    ctl.append(m);
  }
  // Anything that plays can go into the small floating window, and anything
  // already in it comes back the same way.
  if (t.playing || t.audible || t.mini) {
    const mn = el('button', 'mini' + (t.mini ? ' on' : ''), MINI);
    tip(mn, t.mini ? 'Bring it back into Cue' : 'Mini player \u00b7 keeps playing while you work', '⌃⌘M');
    mn.onclick = (e) => { e.stopPropagation(); send('mini', { id: t.id }); };
    ctl.append(mn);
  }
  const hasSound = t.audible || t.muted || t.playing || t.volume < 1;
  const spk = el('button', 'spk' + (t.muted ? ' muted' : t.audible ? ' live' : ''), t.muted ? SPK.off : SPK.on);
  tip(spk, t.muted ? 'Unmute this tab' : `Volume ${pctOf(volOf(t))}%`, `Click to mute · scroll here, or ${OPT}-scroll anywhere on the row, to change · hold still for the slider`);
  // Silent tabs keep the speaker too, just faded: you can set a tab quiet
  // before it ever makes a sound, and the control is always in the same place.
  if (!hasSound) spk.classList.add('idle');
  spk.onclick = (e) => { e.stopPropagation(); if (e.altKey) { toggleVol(); return; } send('mute', { id: t.id }); };
  spk.onwheel = (e) => wheelStep(t, e);
  // Option-scroll anywhere on the row does the same; a plain scroll still scrolls the list.
  row.addEventListener('wheel', altWheel(t), { passive: false });

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
  // Resting on the speaker opens the slider. The old version opened it the
  // instant the pointer crossed the row, which swallowed the click you were
  // aiming at; waiting for the pointer to stop keeps both.
  let openTimer;
  spk.addEventListener('mouseenter', () => { openTimer = setTimeout(() => { if (openVolId !== t.id) toggleVol(); }, 500); });
  spk.addEventListener('mouseleave', () => clearTimeout(openTimer));
  spk.addEventListener('mousedown', () => clearTimeout(openTimer));
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
  row.ondrop = (e) => {
    e.preventDefault(); e.stopPropagation(); row.classList.remove('dropbefore');
    const id = Number(e.dataTransfer.getData('text/cue-tab')); if (!id || id === t.id) return;
    // Dropping between the two tiers moves the tab into that tier.
    const d = S.tabs.find((x) => x.id === id);
    if (d && !!d.temp !== !!t.temp) send('tab-temp', { id, on: !!t.temp });
    send('reorder', { id, beforeId: t.id });
  };
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
  // Always there, always ready. Off air it is a landing strip: drop a tab on it
  // and that tab goes up, which is the whole gesture — no switch to find first.
  box.hidden = S.settings.kits.teacher === false && !S.live; // the Teacher kit off takes the on-air box with it
  box.classList.toggle('off', !S.live);
  const p = S.tabs.find((t) => t.id === S.programId);
  const cued = (S.cue || []).map((id) => S.tabs.find((t) => t.id === id)).filter(Boolean);
  $('#lb-title').textContent = S.live ? (p ? p.title : 'Nothing up yet') : 'Off air';
  $('#lb-end').hidden = !S.live;
  // The picture is what the class is seeing. With nothing up there is nothing
  // to show, and an empty black panel the height of the sidebar says nothing.
  $('#lb-thumb').hidden = !p;
  if (!p) $('#lb-thumb').removeAttribute('src');

  // The cue: the tabs he has lined up, in his order. Drag one in, press TAKE.
  const list = $('#lb-cue'); list.innerHTML = '';
  cued.forEach((t, i) => {
    const row = el('div', 'cu' + (t.id === S.programId ? ' onair' : '') + (t.id === S.cueNext ? ' next' : ''));
    row.append(el('b', 'cun', String(i + 1)));
    row.append(el('span', 'cut', esc(shortName(t) || t.title)));
    const x = el('button', 'cux', '×');
    tip(x, 'Take it out of the cue', 'The tab stays open.');
    x.onclick = (e) => { e.stopPropagation(); send('cue-remove', { id: t.id }); };
    row.append(x);
    tip(row, t.id === S.programId ? 'On air now' : `Cue ${i + 1} · ⇧⌘${i + 1}`,
      t.id === S.programId ? '' : 'Click to put it on air. It is kept awake, so the switch is instant.');
    row.onclick = () => send('take', { id: t.id });
    row.draggable = true;
    row.ondragstart = (e) => e.dataTransfer.setData('text/cue-tab', String(t.id));
    list.append(row);
  });
  if (!cued.length) list.append(el('div', 'cuempty', 'Drag the tabs for this class in here, then press TAKE.'));
  $('#lb-take').hidden = false;
  $('#lb-take').disabled = !cued.length && !S.live;

  // How many of the cued tabs share the stage. One is the ordinary stage;
  // two or three put the app beside the notation for the class.
  const lay = $('#lb-lay'); lay.innerHTML = '';
  const on = (S.stageIds || []).length || 1;
  [1, 2, 3].forEach((n) => {
    const b = el('button', on === n && S.live ? 'on' : '', String(n));
    tip(b, n === 1 ? 'One tab on air' : `${n} cued tabs side by side`,
      n === 1 ? '' : `Cue ${Array.from({ length: n }, (_, i) => i + 1).join(', ')} go up together.`);
    b.disabled = cued.length < n;
    b.onclick = () => send('stage-split', { n });
    lay.append(b);
  });
}

// Dropping a tab on the On-air box puts that tab up, turning Live on if it is
// off. The same box, live or not, so the gesture never changes.
(() => {
  const box = $('#livebox');
  box.ondragover = (e) => { e.preventDefault(); box.classList.add('drop'); };
  box.ondragleave = () => box.classList.remove('drop');
  box.ondrop = (e) => {
    e.preventDefault(); box.classList.remove('drop');
    const id = Number(e.dataTransfer.getData('text/cue-tab'));
    // Dropping CUES it. It does not go on air behind his back — TAKE is still
    // the moment the class sees something, and it stays his to press.
    if (id) send('cue-add', { id });
  };
})();

// The AI row. Not a folder and not an account: a filter over the tabs agents
// may work in, wherever they live, with one switch that stops them all.
let aiFilter = false;
function renderAI() {
  const box = $('#airow');
  const n = S.aiCount || 0;
  box.innerHTML = '';
  const b = el('button', 'aifilter' + (aiFilter ? ' on' : ''), '');
  b.append(el('span', 'nm', 'AI agents'));
  b.append(el('span', 'ct', String(n)));
  tip(b, aiFilter ? 'Showing the tabs agents work in' : `${n} tab${n === 1 ? '' : 's'} handed to Claude Code and Codex`,
    'Click to see just those tabs, wherever they live. They are your tabs — agents work in them beside you.');
  b.onclick = () => { aiFilter = !aiFilter; render(); };
  const p = el('button', 'aipause' + (S.aiPaused ? ' on' : ''), S.aiPaused ? 'Resume AI' : 'Pause AI');
  tip(p, S.aiPaused ? 'Agents are on hold' : 'Stop every agent where it stands',
    S.aiPaused ? 'Nothing was taken away. Resume and they carry on in the same tabs.'
      : 'They stop at once and the tabs stay yours. Nothing has to be set up again when you resume.');
  p.onclick = () => send('setting', { key: 'aiPaused', value: !S.aiPaused });
  box.append(b, p);
  // Nothing about agents shows until AI tools are switched on in Settings (the port is listening).
  box.hidden = !S.agent.listening || (!n && !S.aiPaused);
}

function renderDownloads() {
  const box = $('#downloads');
  const show = S.settings.showDownloads !== false && S.downloads.length;
  box.hidden = !show;
  if (!show) return;
  box.innerHTML = '';
  const busy = S.downloads.filter((d) => d.state === 'progressing');
  const head = el('div', 'dl-head');
  head.append(el('span', 'dl-title', busy.length ? `Downloading ${busy.length}` : 'Downloads'));
  const clear = el('button', 'dl-clear', 'Clear');
  tip(clear, 'Clear this list', 'The files stay in your Downloads folder');
  clear.onclick = () => send('downloads-clear');
  head.append(clear);
  box.append(head);

  for (const d of S.downloads) {
    const pct = d.total ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
    const done = d.state === 'completed';
    const bad = d.state === 'interrupted' || d.state === 'cancelled';
    const r = el('div', `dl${done ? ' done' : ''}${bad ? ' bad' : ''}`);

    const chip = el('span', 'dl-chip', esc(kindShort(d)));
    chip.style.setProperty('--k', KIND_COLOUR[d.kind] || 'var(--muted)');
    r.append(chip);

    const mid = el('span', 'dl-mid');
    mid.append(el('span', 'nm', esc(d.name)));
    mid.append(el('span', 'dl-sub', esc(
      bad ? (d.state === 'cancelled' ? 'Cancelled' : 'Did not finish')
        : done ? `${size(d.total || d.received)} · ${d.kind}`
          : d.total ? `${size(d.received)} of ${size(d.total)}` : size(d.received),
    )));
    if (!done && !bad) {
      const bar = el('span', 'dl-bar');
      const fill = el('span', 'dl-fill');
      // A download whose total nobody knows still has to look alive, so the bar
      // sweeps instead of lying about a percentage.
      if (d.total) fill.style.width = `${pct}%`; else bar.classList.add('unknown');
      bar.append(fill); mid.append(bar);
    }
    r.append(mid);

    const acts = el('span', 'dl-acts');
    if (done) {
      const open = el('button', 'dl-btn', d.kind === 'Installers' ? 'Install' : 'Open');
      tip(open, d.kind === 'Installers' ? 'Open the installer' : 'Open this file',
        d.kind === 'Installers' ? 'It moves to the Trash a day later' : '');
      open.onclick = (e) => { e.stopPropagation(); send('download-run', { id: d.id }); };
      acts.append(open);
      const show2 = el('button', 'dl-btn quiet', '􀈕');
      show2.textContent = 'Finder';
      tip(show2, 'Show it in Finder');
      show2.onclick = (e) => { e.stopPropagation(); send('download-open', { id: d.id }); };
      acts.append(show2);
    } else if (!bad) acts.append(el('span', 'dl-pct', d.total ? `${pct}%` : ''));
    r.append(acts);
    r.onclick = () => send('download-open', { id: d.id });
    box.append(r);
  }
}

const KIND_COLOUR = {
  Installers: '#5F40CF', Video: '#C2410C', Audio: '#1F6F8B', Images: '#2E7D4F',
  Documents: '#2A64CC', Archives: '#8A6A1F',
};
// Three or four letters is enough to tell a .dmg from a .wav at a glance, and it
// never needs a picture that might not load.
function kindShort(d) {
  const ext = (/\.([a-z0-9]+)$/i.exec(d.name || '') || [, ''])[1].toUpperCase();
  return ext.slice(0, 4) || 'FILE';
}
function size(n) {
  if (!n) return '';
  const mb = n / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// ---------------------------------------------------------------- omnibox + suggestions
const ENGINE_NAMES = { google: 'Google', images: 'Images', youtube: 'YouTube', pinterest: 'Pinterest', github: 'GitHub', claude: 'Claude', chatgpt: 'ChatGPT' };
let sugItems = []; let sugSel = 0;

const openUrl = (url) => () => send('navigate', { text: url, newTab: true });
function libraryHits(r) {
  return [
    ...r.bookmarks.map((x) => ({ k: 'Bookmark', v: x.title || x.url, url: x.url, run: openUrl(x.url) })),
    ...r.history.map((x) => ({ k: 'History', v: x.title || x.url, url: x.url, run: openUrl(x.url) })),
    ...r.boards.map((x) => ({ k: 'Board', v: x.title || x.url, run: openUrl(x.url) })),
    ...r.apps.map((x) => ({ k: (S.preset && S.preset.appLabel) || 'App', v: x.name, icon: new URL('/favicon.ico', x.url).href, run: openUrl(x.url) })),
    ...r.repos.map((x) => ({ k: 'GitHub', v: x.name, icon: 'https://github.com/favicon.ico', run: openUrl(x.url) })),
  ];
}

async function showSuggest() {
  const q = $('#omnibox').value.trim();
  const box = $('#suggest');
  if (!q) { hideSuggest(); return; }
  const ql = q.toLowerCase();
  const tabHits = S.tabs.filter((t) => !t.away && (t.title + ' ' + t.url).toLowerCase().includes(ql) && t.id !== S.activeId).slice(0, 5)
    .map((t) => ({ k: 'Switch to', v: t.title, run: () => send('activate', { id: t.id }) }));
  const engines = Object.keys(ENGINE_NAMES).map((e) => ({ k: ENGINE_NAMES[e], v: q, run: () => send('navigate', { text: q, engine: e }) }));
  const lib = libraryHits(await window.cue.invoke('suggest', { q }));
  if ($('#omnibox').value.trim() !== q) return;
  // One box for addresses and searches. A site he has been to whose address starts with what he
  // typed ("name" -> name.com) comes first, so Enter opens it; otherwise Enter goes to the address
  // or searches Google, as before.
  const site = !/\s/.test(q) && lib.find((x) => x.url && hostOf(x.url).startsWith(ql.replace(/^https?:\/\//, '').replace(/^www\./, '')));
  const go = site
    ? { k: 'Open', v: hostOf(site.url), run: () => send('navigate', { text: 'https://' + hostOf(site.url) }) }
    : { k: /\s/.test(q) || !/\./.test(q) ? 'Search' : 'Go', v: q, run: () => send('navigate', { text: q }) };
  sugItems = [go, ...(site ? [{ k: 'Search', v: q, run: () => send('navigate', { text: q, engine: 'google' }) }] : []), ...tabHits, ...lib.slice(0, 8), ...engines.slice(1)];
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
    else if (q) send('navigate', { text: q, newTab: e.metaKey });
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
// What Cmd+K can do. A kit that is off takes its commands with it, the Spaces are the ones you
// have, and a starting setup adds its own (S.preset.commands); with no setup there are none.
function commands() {
  const k = (S && S.settings && S.settings.kits) || {};
  const on = (kit) => k[kit] !== false;
  return [
    ...(on('teacher') ? [['Go live', () => send('live', { on: !S.live })]] : []), ['New Vanish tab', () => send('new-tab', { identity: 'vanish' })],
    ['New tab just for now', () => send('new-tab', { temp: true })],
    ['Side by side', () => send('split', { mode: 'cols2' })], ['Grid of four', () => send('split', { mode: 'grid4' })], ['One tab', () => send('split', { mode: 'single' })],
    ['Move in from another browser', () => openImport()], ['Settings', () => openSettings()], ...(on('designer') ? [['Boards', () => send('tool', { name: 'boards' })]] : []),
    ['Bookmarks, history and archived tabs', () => send('tool', { name: 'library' })], ...(on('business') ? [['Bills and alerts', () => send('tool', { name: 'bills' })]] : []),
    ...(on('creator') ? [['Thumbnail check', () => send('tool', { name: 'thumbcheck' })]] : []), ['AI side panel', () => send('ai')], ['Ask AI about this page', () => send('ai-ask')],
    ...(on('music') ? [['Music bar', () => send('strip')]] : []),
    ...(on('designer') ? [['Pick a colour', () => send('tool', { name: 'colour' })], ['Find a font', () => send('tool', { name: 'font' })], ['Ruler', () => send('tool', { name: 'ruler' })]] : []),
    ...(on('video') ? [['Save whole page as a picture', () => send('tool', { name: 'fullpage' })], ['Record this tab', () => send('tool', { name: 'record' })], ['Make a GIF', () => send('tool', { name: 'gif' })]] : []),
    ...((S && S.preset && S.preset.commands) || []).filter((c) => /^https:\/\//.test(c.url || '')).map((c) => [c.name, () => send('navigate', { text: c.url, newTab: true })]),
    ...((S && S.spaces) || []).map((n) => [`Space: ${n}`, () => send('space', { name: n })]),
  ];
}

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
      const tabs = S.tabs.filter((t) => !t.away && (t.title + ' ' + t.url).toLowerCase().includes(ql)).slice(0, q ? 6 : 8)
        .map((t) => ({ k: t.space === S.space ? 'Tab' : t.space, v: t.title, run: () => send('activate', { id: t.id }) }));
      const cmds = commands().filter(([n]) => n.toLowerCase().includes(ql)).slice(0, q ? 5 : 3).map(([n, run]) => ({ k: 'Do', v: n, run }));
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
        personFolders().forEach((k) => { const o = el('option', '', `Into ${S.identities[k].name}`); o.value = k; o.selected = k === p.identity; who.append(o); });
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
$('#newtab').onclick = () => send('new-tab');
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
  // A panel you cannot see how to shut is a trap. There is a cross in the
  // corner, Escape closes it, and so does clicking the page behind.
  const x = el('button', 'sheetx', '\u00d7');
  tip(x, 'Close', 'Escape also closes this');
  x.onclick = () => closeModal();
  sheet.prepend(x);
  m.append(sheet); m.hidden = false; overlay(true);
  m.onclick = (e) => { if (e.target === m) closeModal(); };
}
function closeModal() { const m = $('#modal'); if (m.hidden) return; m.hidden = true; m.innerHTML = ''; overlay(false); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) { if (sharePending) { send('share-choose', {}); sharePending = false; } closeModal(); } });

// ---------------------------------------------------------------- settings
// Settings is a list of rooms on the left and one room at a time on the right, sized to fit a
// laptop screen: the room list stays put and only the room scrolls. Every room opens with one
// short line; anything longer waits behind a small "?" that opens in place. The search box above
// the rooms finds a setting by its words in every room at once.
let indexing = false; // true while Settings reads every room for the search box: nothing is asked of the main side
const ask = (cmd, a) => (indexing ? new Promise(() => {}) : window.cue.invoke(cmd, a));
const MAC_KEYS = /Mac/i.test(navigator.platform || '');
let fieldN = 0;
const fieldId = () => `sf${++fieldN}`;

// A small "?" and the words it opens, under the row it belongs to.
function helpPair(text) {
  const b = el('button', 'qhelp', '?'); b.type = 'button';
  b.setAttribute('aria-label', 'More about this'); b.setAttribute('aria-expanded', 'false');
  const n = el('div', 'note help', esc(text)); n.hidden = true;
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); n.hidden = !n.hidden; b.classList.toggle('on', !n.hidden); b.setAttribute('aria-expanded', String(!n.hidden)); };
  return [b, n];
}
// The one sentence a room opens with, and its "?".
function intro(p, line, more) {
  const box = el('div', 'intro');
  box.append(el('span', '', esc(line)));
  p.append(box);
  if (more) { const [b, n] = helpPair(more); box.append(b); p.append(n); }
}
const heading = (p, text) => p.append(el('h3', '', esc(text)));
// One setting: its name on the left (and a "?" when there is more to say), the control on the right.
function settingRow(label, input, help, hint) {
  const r = el('div', 'srow unit');
  const left = el('div', 'slab');
  const l = el('label', '', esc(label));
  const field = !input ? null : /^(INPUT|SELECT|TEXTAREA)$/.test(input.tagName) ? input : input.querySelector('input, select, textarea');
  if (field) { field.id = field.id || fieldId(); l.htmlFor = field.id; }
  left.append(l);
  let note = null;
  if (help) { const [b, n] = helpPair(help); left.append(b); note = n; }
  if (hint) left.append(el('div', 'hint', esc(hint)));
  const ctl = el('div', 'sctl');
  if (input) ctl.append(input);
  r.append(left, ctl);
  if (note) r.append(note);
  return r;
}
// An on/off setting is a switch, and switches sit two to a line.
function toggle(key, val, label, help, onChange) {
  const r = el('div', 'tg unit');
  const i = el('input', 'switch'); i.type = 'checkbox'; i.checked = !!val; i.id = fieldId(); i.setAttribute('role', 'switch');
  i.onchange = onChange ? () => onChange(i.checked, i) : () => send('setting', { key, value: i.checked });
  const l = el('label', '', esc(label)); l.htmlFor = i.id;
  r.append(l);
  let note = null;
  if (help) { const [b, n] = helpPair(help); r.append(b); note = n; } else r.append(el('span'));
  r.append(i);
  if (note) r.append(note);
  return r;
}
function toggles(p, ...items) { const g = el('div', 'tgrid'); g.append(...items.filter(Boolean)); p.append(g); return g; }
// The technical knobs, out of the way until asked for.
function advanced(p, build) {
  const d = el('details', 'adv'); d.append(el('summary', '', 'Advanced'));
  const box = el('div', 'advbox'); build(box); d.append(box); p.append(d);
  return d;
}
// A line under an action that says what happened, so Settings never has to close to tell you.
function said(node) {
  const s = el('span', 'said'); s.setAttribute('role', 'status');
  node.append(s);
  return (msg, bad) => { s.textContent = msg || ''; s.classList.toggle('bad', !!bad); };
}
// A button that asks once, in place, before it does something that cannot be undone.
function confirmButton(label, question, run) {
  const b = el('button', 'btn danger', esc(label)); b.type = 'button';
  let sure = false; let timer = null;
  b.onclick = async () => {
    if (!sure) { sure = true; b.textContent = question; b.classList.add('sure'); timer = setTimeout(() => { sure = false; b.textContent = label; b.classList.remove('sure'); }, 5000); return; }
    clearTimeout(timer); b.disabled = true;
    await run();
  };
  return b;
}
function check(key, val) { const i = el('input'); i.type = 'checkbox'; i.checked = !!val; i.onchange = () => send('setting', { key, value: i.checked }); return i; }
function choice(key, val, opts) {
  const c = el('select');
  const numeric = opts.every(([v]) => typeof v === 'number');
  if (!opts.some(([v]) => String(v) === String(val)) && val !== undefined && val !== null && val !== '') opts = [...opts, [val, String(val)]];
  opts.forEach(([v, n]) => { const o = el('option', '', esc(n)); o.value = String(v); o.selected = String(v) === String(val); c.append(o); });
  c.onchange = () => send('setting', { key, value: numeric ? Number(c.value) : c.value });
  return c;
}
function text(key, val, ph, type = 'text', cls = '') {
  const i = el('input', cls); i.type = type; i.value = val ?? ''; i.placeholder = ph || '';
  i.onchange = () => send('setting', { key, value: type === 'number' ? Number(i.value) : i.value });
  return i;
}
// A number with its unit after it: [ 15 ] minutes.
function amount(input, unit) { const w = el('span', 'amount'); w.append(input, el('span', 'unitword', esc(unit))); return w; }
const folderName = (id) => ((S.identities || {})[id] || {}).name || id;

let settingsRoom = 'tabs';
function settingsRooms() {
  const s = S.settings;
  const key = (n) => (MAC_KEYS ? `Command-${n}` : `Ctrl-${n}`);
  return [
    { id: 'tabs', name: 'Tabs and sound', line: 'How new tabs open, and which ones may make a sound.',
      more: 'WhatsApp, Gmail, Instagram and Facebook live in the strip at the top of the sidebar, one of each per folder. YouTube keeps a tab each for watching, Studio and your posts. Any other site opens as many tabs as you like.',
      build: (p) => {
        heading(p, 'Sound');
        p.append(settingRow('Apps that open silent', text('muteSites', (s.muteSites || []).join(', '), 'web.whatsapp.com', 'text', 'wide'),
          'WhatsApp is here to start with. You can still unmute any tab by hand; this only decides how it starts. Separate sites with a comma.'));
        p.append(settingRow('When a new tab opens while a video plays', choice('videoSwitch', s.videoSwitch || 'both', [['both', 'Go to it; both keep playing'], ['switch', 'Pause it and play the new one'], ['stay', 'Stay here; the new tab waits quietly']])));
        toggles(p,
          toggle('onePlayer', s.onePlayer, 'Only one video plays at a time', 'Off is how other browsers behave. Turn it on and starting a video pauses the others. This is the main window only; Vanish has its own setting.'),
          toggle('originalSound', s.originalSound, 'Original sound for music', 'Turns off echo cancelling, noise cutting and automatic volume on your microphone in web calls. Reload the call page after changing it.'));
        heading(p, 'Tabs');
        p.append(settingRow('New tabs open', choice('newTabPlace', s.newTabPlace || 'next', [['next', 'Next to the current tab'], ['start', 'At the beginning'], ['end', 'At the end']])));
        p.append(settingRow('Let unused tabs sleep after', amount(text('sleepMinutes', s.sleepMinutes, '15', 'number'), 'minutes'),
          'A sleeping tab gives its memory back and wakes when you click it. Anything playing, recording or half-typed stays awake.'));
        toggles(p,
          toggle('autoGroup', s.autoGroup, 'Group tabs automatically', 'Sorts the sidebar into Google, Shopping, Watch & listen and so on. Right-click a tab to move it to another group.'),
          toggle('syncScroll', s.syncScroll, 'Scroll split tabs together'),
          toggle('syncPlay', s.syncPlay, 'Play and pause split tabs together'));
        const dup = el('span', 'btnline');
        const tb = el('button', 'btn', 'Merge duplicate tabs'); tb.type = 'button';
        const tell = said(dup);
        tb.onclick = async () => { tb.disabled = true; const r = await ask('tidy-dupes'); tell(r && r.said); tb.disabled = false; };
        dup.prepend(tb);
        p.append(settingRow('Copies of the same page', dup, 'Closes extra copies of one page in the same folder. It also runs by itself each time Cue opens. A pinned tab is never the one closed.'));
      } },

    { id: 'keep', name: 'Keeping tabs', line: 'Kept tabs stay until you close them; Just for now tabs do not.',
      more: `Pinned apps and ordinary tabs are kept: they come back every time Cue opens, until you close them. Tabs in the "Just for now" section of the sidebar use the folder's usual sign-ins, but are cleared when Cue closes (or after the time below) and never come back. Open one with ${MAC_KEYS ? '⌥⌘T' : 'Ctrl+Alt+T'}, the + on that section, or right-click a tab and choose Just for now. Pinning a tab, or choosing Keep this tab, keeps it.`,
      build: (p) => {
        heading(p, 'When Cue opens');
        p.append(settingRow('Go to', choice('openOn', s.openOn || 'home', [['home', 'The app I start in'], ['last', 'The tab I was last on']])));
        p.append(settingRow('The app I start in', text('homeApp', s.homeApp, 'https://web.whatsapp.com/', 'text', 'wide'),
          'The same app in whichever folder you open. If it is not open there yet, Cue lands on the last tab you used in that folder.'));
        heading(p, 'Kept tabs');
        p.append(settingRow('Put away tabs I haven’t used for', choice('archiveDays', Number(s.archiveDays) || 0, [[0, 'Never'], [2, '2 days'], [7, '7 days'], [30, '30 days']]),
          'Put-away tabs wait in Library > Archived, one click from coming back. Pinned, named, playing and on-air tabs are never put away, and neither is the tab in front of you.'));
        heading(p, 'Just for now');
        p.append(settingRow('Clear Just for now tabs', choice('tempClear', s.tempClear ?? 'quit', [['quit', 'When Cue closes'], ['1', 'After 1 hour'], ['4', 'After 4 hours'], ['12', 'After 12 hours'], ['24', 'After 24 hours']]),
          'When Cue closes: they are never saved, so not even a crash brings them back. After some hours: they come back after a restart until their time is up. Either way they are thrown away, not archived.'));
        toggles(p, toggle('linksJustForNow', s.linksJustForNow, 'Links from other apps start in Just for now', 'A link you click in Mail, a chat app or a document opens in the Just for now section instead of among your kept tabs.'));
      } },

    // Vanish has its own rules; nothing here changes the main window, and nothing there reaches in.
    { id: 'vanish', name: 'Vanish', line: 'A private window that forgets everything when you close it.',
      build: (p) => {
        p.append(settingRow('When a link opens a new Vanish tab', choice('vanishNewTab', s.vanishNewTab || 'go', [['go', 'Go to it'], ['stay', 'Stay where I am']])));
        p.append(settingRow('New Vanish tabs open', choice('vanishNewTabPlace', s.vanishNewTabPlace || 'next', [['next', 'Next to this tab'], ['end', 'At the end']])));
        toggles(p,
          toggle('vanishOnePlayer', s.vanishOnePlayer, 'Only one video plays at a time in Vanish', 'Off: everything in Vanish plays at once, as in other browsers.'),
          toggle('vanishPauseOnBlur', s.vanishPauseOnBlur, 'Pause Vanish when I switch to another window'),
          toggle('vanishHideFromCapture', s.vanishHideFromCapture !== false, 'Hide Vanish from screen sharing and recordings', 'Some capture tools on recent macOS ignore this.'),
          toggle('vanishFullScreen', s.vanishFullScreen, 'Open Vanish in full screen'));
        heading(p, 'Vanish shortcuts');
        const list = el('div', 'vkeys unit');
        for (const k of S.vanishKeys || []) list.append(el('b', '', esc(k.keys)), el('span', '', esc(k.label)));
        p.append(list);
        p.append(el('div', 'hint', 'The same list is in the Window menu, under Vanish.'));
      } },

    { id: 'notes', name: 'Notifications', line: 'Choose which sites may pop a notification up.',
      more: 'Messages still arrive, the count still shows in the sidebar, and every one is kept in Bills & alerts. Nothing pops up at all while you are on air; whatever came in is waiting when you finish.',
      build: (p) => {
        p.append(settingRow('Sites that never pop a notification up', text('quietSites', (s.quietSites || []).join(', '), 'web.whatsapp.com', 'text', 'wide'),
          'WhatsApp is here to start with. Separate sites with a comma.'));
      } },

    { id: 'keys', name: 'The number keys', line: `${key(1)} to ${key(9)} open these sites in the folder you have open.`,
      more: `Each folder keeps its own nine, so ${key(1)} can be your WhatsApp in your folder and someone else's in theirs. If the site is already open, the key jumps to that tab instead of opening another. Leave the address empty and the key opens a new tab.`,
      build: (p) => {
        const people = personFolders();
        const pick = el('select');
        people.forEach((id) => { const o = el('option', '', esc(folderName(id))); o.value = id; o.selected = id === S.folder; pick.append(o); });
        const rows = el('div', 'kgrid');
        const draw = () => {
          rows.innerHTML = '';
          const head = el('div', 'krow khead'); head.append(el('span', '', 'Key'), el('span', '', 'Name'), el('span', '', 'Web address')); rows.append(head);
          const box = S.settings.quickKeys;
          const mine = (Array.isArray(box) ? box : (box && box[S.folder])) || [];
          for (let i = 0; i < 9; i++) {
            const q = mine[i] || {};
            const r = el('div', 'krow unit');
            r.dataset.words = `${q.name || ''} ${q.url || ''}`;
            const nm = text(`quick.${S.folder}.${i + 1}.name`, q.name, 'What to call it');
            const url = text(`quick.${S.folder}.${i + 1}.url`, q.url, 'Web address, or empty for a new tab');
            nm.setAttribute('aria-label', `${key(i + 1)} name`); url.setAttribute('aria-label', `${key(i + 1)} web address`);
            r.append(el('b', 'kkey', esc(key(i + 1))), nm, url);
            rows.append(r);
          }
        };
        // Only the open folder's nine are ever sent here, so picking another folder opens it.
        pick.onchange = async () => {
          const want = pick.value; send('folder', { name: want });
          for (let i = 0; i < 30 && S.folder !== want; i++) await new Promise((r) => setTimeout(r, 50));
          pick.value = S.folder; draw();
        };
        p.append(settingRow('Keys for', pick, people.length > 1 ? 'Each person’s nine are their own. Choosing another folder here opens that folder.' : ''));
        p.append(rows);
        draw();
      } },

    { id: 'folders', name: 'Folders and accounts', line: 'Each person’s folder is a separate browser with its own sign-ins.',
      more: 'Each folder has its own Google, Instagram, YouTube and WhatsApp sign-ins, tabs, history, bookmarks and saved passwords, and nothing in one shows in another. Click a folder at the top of the sidebar to open it; new tabs are born in the folder that is open. Add people with "Add a person" under the folders.',
      build: (p) => {
        const box = el('div', 'folderroom'); p.append(box);
        const draw = async () => {
          const got = await ask('folders');
          const { rows, lockMinutes } = got || { rows: [], lockMinutes: 15 };
          box.innerHTML = '';
          const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
          const act = async (cmd, a, tell) => { const r = await ask(cmd, a); if (r && r.error && tell) tell(r.error, true); return r; };
          for (const f of rows) {
            const card = el('div', 'fcard unit');
            card.style.setProperty('--c', f.color);
            const head = el('div', 'fchead');
            const col = el('input'); col.type = 'color'; col.value = f.color; col.setAttribute('aria-label', `Colour for ${f.name}`);
            const nm = el('input', 'fname'); nm.type = 'text'; nm.value = f.name; nm.maxLength = 40; nm.setAttribute('aria-label', 'Folder name');
            const sayBox = el('div', 'fcline');
            const told = said(sayBox);
            if (f.locked) { nm.disabled = true; col.disabled = true; }
            nm.onchange = async () => { const v = nm.value.trim(); if (v && v !== f.name) { const r = await act('folder.rename', { id: f.id, name: v }, told); if (r && r.ok) draw(); } };
            col.onchange = async () => { await act('folder.color', { id: f.id, color: col.value }, told); draw(); };
            head.append(col, nm, el('span', 'pill' + (f.open ? ' ok' : ''), esc(f.open ? 'Open now' : f.locked ? 'Locked' : 'Closed')));
            const rm = confirmButton('Remove', 'Remove it and everything in it?', async () => {
              const r = await act('folder.remove', { id: f.id }, told);
              if (r && r.ok) { draw(); return; }
              rm.disabled = false;
            });
            if (rows.length <= 1) { rm.disabled = true; tip(rm, 'The last folder stays'); }
            else tip(rm, `Remove ${f.name}`, 'Closes its tabs and removes its sign-ins, history, bookmarks, Boards and passwords from Cue. Its site data goes to the Trash.');
            head.append(rm);
            card.append(head, sayBox);
            if (f.locked) {
              card.append(el('div', 'hint', 'Locked. Click it in the sidebar and type its passcode to change anything here.'));
              box.append(card);
              continue;
            }
            const email = el('input'); email.type = 'email'; email.value = f.email || ''; email.placeholder = 'you@example.com';
            email.onchange = () => act('folder.email', { id: f.id, email: email.value.trim() }, told);
            const grid = el('div', 'fcgrid');
            grid.append(settingRow('Google address', email, 'Shown on the folder while it is open. Google opens as this address in this folder, and AI agents use it to pick the right account. Optional.'));
            grid.append(toggle('', f.agents, 'AI agents may use this folder', 'Off: Claude Code, Codex and every other agent cannot see this folder, its tabs, its WhatsApp or its Gmail at all.',
              (on) => act('folder.agents', { id: f.id, on }, told)));
            card.append(grid);

            // ---- the passcode
            const lockRow = el('span', 'btnline');
            const cur = el('input'); cur.type = 'password'; cur.placeholder = 'Current passcode'; cur.autocomplete = 'off'; cur.className = 'short';
            const nw = el('input'); nw.type = 'password'; nw.placeholder = f.hasLock ? 'New passcode' : '4 or more'; nw.autocomplete = 'new-password'; nw.className = 'short';
            const setB = el('button', 'btn', f.hasLock ? 'Change' : 'Set passcode'); setB.type = 'button';
            setB.onclick = async () => { const r = await act('folder-passcode', { id: f.id, current: cur.value, code: nw.value }, told); if (r && r.ok) { await draw(); } };
            if (f.hasLock) lockRow.append(cur);
            lockRow.append(nw, setB);
            if (f.hasLock) {
              const off = el('button', 'btn', 'Remove passcode'); off.type = 'button';
              off.onclick = async () => { const r = await act('folder-passcode', { id: f.id, current: cur.value, code: '' }, told); if (r && r.ok) await draw(); };
              const now = el('button', 'btn', 'Lock now'); now.type = 'button';
              now.onclick = async () => { await act('folder.lock-now', { id: f.id }, told); draw(); };
              lockRow.append(off, now);
            }
            card.append(settingRow(f.hasLock ? 'Passcode (set)' : 'Passcode', lockRow, 'Stops someone clicking into a folder that is not theirs. It is not a safe: people who share one computer login could still dig through the computer’s own files.'));

            // ---- sharing sign-ins: only shown for a pair that is on, or when asked for
            for (const other of f.shared || []) {
              const o = byId[other];
              if (!o || f.id > other) continue; // each pair once
              card.append(toggle('', true, `Shares sign-ins with ${o.name}`, 'A site signed in here is signed in there too, and the other way round. Gmail, YouTube, Instagram, Facebook and WhatsApp always stay separate.',
                async (on) => { await act('folder.share', { a: f.id, b: other, on }, told); draw(); }));
            }
            for (const other of f.shared || []) {
              const o = byId[other];
              if (!o || f.id < other) continue;
              card.append(el('div', 'hint', `Shares sign-ins with ${esc(o.name)} (switch it off on ${esc(o.name)}'s card).`));
            }
            const choices = rows.filter((r) => r.id !== f.id && !r.locked && !(f.shared || []).includes(r.id));
            if (choices.length) {
              const pick = el('select');
              pick.append(Object.assign(el('option', '', 'Nobody'), { value: '' }));
              choices.forEach((r) => { const o = el('option', '', esc(r.name)); o.value = r.id; pick.append(o); });
              pick.onchange = async () => { if (pick.value) { await act('folder.share', { a: f.id, b: pick.value, on: true }, told); draw(); } };
              card.append(settingRow('Share sign-ins with', pick, 'Off unless you choose it. Only pair two folders that belong to the same person.'));
            }

            // ---- Google and Meta sign-ins for this folder
            const signs = el('span', 'btnline');
            const g = el('button', 'btn', 'Google'); g.type = 'button';
            g.onclick = () => { send('signin.google', { identity: f.id }); told(`Google’s sign-in page is open in a new tab in ${f.name}. Close Settings to use it.`); };
            const m = el('button', 'btn', 'Instagram and Facebook from Chrome'); m.type = 'button';
            m.onclick = () => {
              m.disabled = true; told('Bringing them over from Chrome…');
              send('signin.carry-all', { identity: f.id });
              setTimeout(() => { m.disabled = false; told('Done. Open Instagram or Facebook in this folder to check.'); }, 6000);
            };
            signs.append(g); if (S.canCarryFromChrome) signs.append(m); // only on a Mac that has Chrome
            card.append(settingRow('Sign in', signs, 'Google: signs this folder in on Google’s own page, after emptying its old Google cookies. Instagram and Facebook do not always accept a sign-in typed into a browser they do not know yet, so if Chrome on this computer is signed in, this copies those two across into this folder only. Google is never copied: it ties a sign-in to the one browser it was made in.'));
            box.append(card);
          }
          box.append(settingRow('Lock folders again after', amount(text('lockMinutes', lockMinutes, '15', 'number'), 'idle minutes'),
            'A folder with a passcode asks for it every time Cue opens, after this many idle minutes (0: only then), and when you right-click it and choose Lock now. Separate computer logins, one per person, are stronger.'));
        };
        draw();
        const def = el('select'); [...personFolders(), ...(S.folders.includes('agent') ? ['agent'] : [])].forEach((k) => { const o = el('option', '', esc(folderName(k))); o.value = k; if (k === s.defaultIdentity) o.selected = true; def.append(o); });
        def.onchange = () => send('setting', { key: 'defaultIdentity', value: def.value });
        p.append(settingRow('A new, empty Space opens in', def));
        const mv = el('span', 'btnline');
        const mvb = el('button', 'btn', 'Move in from another browser'); mvb.type = 'button'; mvb.onclick = () => { closeModal(); openImport(); };
        const dfb = el('button', 'btn', 'Make Cue my browser'); dfb.type = 'button';
        const dtell = said(mv);
        dfb.onclick = () => { send('make-default'); dtell('Asked. Your computer may show a box to confirm.'); };
        mv.prepend(mvb, dfb);
        p.append(settingRow('Other browsers', mv));
      } },

    { id: 'spaces', name: 'Spaces', line: 'A Space is the kind of work; a folder is whose account.',
      more: 'Each Space keeps its own tabs, its own layout and the folder it usually opens in. Going to an empty Space opens that folder; a Space with tabs opens the folder of the tab you land on. Up to nine. You can also double-click a Space in the sidebar to rename it.',
      build: (p) => {
        const box = el('div', 'spacelist'); p.append(box);
        const line = el('div', 'spsaid'); const tell = said(line);
        const run = async (cmd, a) => {
          const r = await ask(cmd, a);
          if (r && r.error) tell(r.error, true); else tell((r && r.said) || '');
          // The sidebar is told first; draw from what it was told.
          await new Promise((res) => setTimeout(res, 90));
          draw();
          return r;
        };
        const draw = () => {
          box.innerHTML = '';
          const list = S.spaceList || S.spaces.map((name) => ({ name, tint: 'rose' }));
          list.forEach((sp, i) => {
            const r = el('div', 'sprow unit'); r.dataset.space = sp.name;
            const up = el('button', 'mini2', '↑'); up.type = 'button'; up.disabled = i === 0; tip(up, `Move ${sp.name} up`);
            up.onclick = () => run('space.move', { name: sp.name, dir: -1 });
            const dn = el('button', 'mini2', '↓'); dn.type = 'button'; dn.disabled = i === list.length - 1; tip(dn, `Move ${sp.name} down`);
            dn.onclick = () => run('space.move', { name: sp.name, dir: 1 });
            const sw = el('span', 'swatches'); sw.setAttribute('role', 'radiogroup'); sw.setAttribute('aria-label', `Colour for ${sp.name}`);
            for (const tint of S.spaceTints || []) {
              const b = el('button', 'sw' + (tint === sp.tint ? ' on' : '')); b.type = 'button'; b.dataset.tint = tint;
              b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(tint === sp.tint));
              tip(b, `${tint[0].toUpperCase()}${tint.slice(1)}`);
              b.onclick = () => run('space.tint', { name: sp.name, tint });
              sw.append(b);
            }
            const nm = el('input', 'spname'); nm.type = 'text'; nm.value = sp.name; nm.maxLength = 18; nm.setAttribute('aria-label', `Name of ${sp.name}`);
            nm.onkeydown = (e) => { if (e.key === 'Enter') nm.blur(); if (e.key === 'Escape') { nm.value = sp.name; nm.blur(); } };
            nm.onchange = () => { const v = nm.value.trim(); if (v && v !== sp.name) run('space.rename', { from: sp.name, name: v }); else nm.value = sp.name; };
            const pick = el('select'); pick.setAttribute('aria-label', `Folder ${sp.name} opens in`);
            personFolders().forEach((k) => { const o = el('option', '', esc(folderName(k))); o.value = k; o.selected = s.spaceLogins[sp.name] === k; pick.append(o); });
            pick.onchange = () => send('setting', { key: `spaceLogin.${sp.name}`, value: pick.value });
            const opens = el('span', 'spopens'); opens.append(el('span', 'unitword', 'opens in'), pick);
            r.append(up, dn, sw, nm, opens);
            if (list.length > 1) {
              const home = (list[0].name === sp.name ? list[1] : list[0]).name;
              r.append(confirmButton('Remove', `Remove? Tabs go to ${home}`, () => run('space.remove', { name: sp.name })));
            }
            box.append(r);
          });
          if (list.length < 9) {
            const add = el('div', 'sprow spadd unit');
            const nm = el('input', 'spname'); nm.type = 'text'; nm.placeholder = 'Name a new Space'; nm.maxLength = 18; nm.setAttribute('aria-label', 'Name a new Space');
            const go = el('button', 'btn', 'Add this Space'); go.type = 'button';
            const doIt = () => { const v = nm.value.trim(); if (v) run('space.add', { name: v }); };
            go.onclick = doIt;
            nm.onkeydown = (e) => { if (e.key === 'Enter') doIt(); };
            add.append(nm, go);
            box.append(add);
          }
          box.append(line);
        };
        draw();
      } },

    { id: 'look', name: 'What you see', line: 'Hide the parts you never use; nothing is deleted.',
      more: 'Switching a part off takes its buttons out of the toolbar and the sidebar, and switching it back on brings everything straight back. A tab’s own buttons (the speaker, the AI mark, move up and down, close) only appear while the pointer is on its row, except a tab making a sound and a tab an agent is working in.',
      build: (p) => {
        toggles(p, ...Object.entries(S.kits).map(([k, v]) => toggle(`kit.${k}`, s.kits[k], v.name, v.what)));
        toggles(p,
          toggle('showDownloads', s.showDownloads !== false, 'Downloads tray in the sidebar', 'Off hides the list at the bottom of the sidebar. Files still download to your Downloads folder.'),
          toggle('sideHidden', s.sideHidden, 'Sidebar hidden until you reach for it', 'The whole sidebar slides away (⌘\\). Move the pointer to the left edge and it comes back.'));
      } },

    { id: 'shield', name: 'Shield', line: 'Ads, trackers and dangerous sites are stopped before they load.',
      build: (p) => {
        toggles(p,
          toggle('blockAds', s.blockAds !== false, 'Block ads and trackers', 'The same filter lists Brave and uBlock use. Ads, tracking scripts and cookie banners never load, so pages are lighter as well as quieter.'),
          toggle('warnDangerous', s.warnDangerous !== false, 'Warn me about dangerous sites', 'A page reported for spreading viruses, or for copying a real sign-in page to collect your password, is stopped with an explanation instead.'),
          toggle('httpsFirst', s.httpsFirst !== false, 'Try the secure address first', 'Cue asks for https:// even when a link says http://, and tells you when a site has no secure address.'),
          toggle('hideRealIP', s.hideRealIP !== false, 'Keep my real address hidden on a VPN', 'Video calling normally hands a page every network address this computer has, which is how a site can read your home address while a VPN is on. Cue offers the public one only. Takes effect on the next page load.'));
        const shieldLine = el('span', 'hint', 'Checking…');
        const refresh = el('button', 'btn', 'Check for new threats now'); refresh.type = 'button';
        const ago = (at) => {
          if (!at) return 'never';
          const d = Math.round((Date.now() - at) / 86400000);
          return d <= 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`;
        };
        const showShield = () => ask('shield.status').then((st) => {
          if (!st) return;
          if (!st.on) { shieldLine.textContent = 'The shield is off. Nothing is being blocked.'; return; }
          const allowed = st.allowed.length ? ` Ads allowed by hand on ${st.allowed.join(', ')}.` : '';
          shieldLine.textContent = `${st.listsMB} MB of rules, refreshed ${ago(st.listsAt)}. ${st.dangerous.toLocaleString()} dangerous sites known, refreshed ${ago(st.dangerAt)}.${allowed}`;
        });
        refresh.onclick = async () => {
          refresh.disabled = true; refresh.textContent = 'Fetching the new lists…';
          const r = await ask('shield.refresh');
          refresh.textContent = r && r.ok === false ? 'Could not reach the lists' : 'Up to date';
          setTimeout(() => { refresh.disabled = false; refresh.textContent = 'Check for new threats now'; }, 4000);
          showShield();
        };
        const r = settingRow('The lists', refresh, 'Cue fetches them by itself every few days; this is for when you want it now.');
        r.querySelector('.slab').append(shieldLine);
        p.append(r);
        showShield();
      } },

    { id: 'pw', name: 'Passwords', line: 'Cue offers to save a password when you sign in, then fills it in.',
      more: 'With “auto” ticked, Cue signs you in to that site by itself. Nothing leaves this computer, and nothing is ever filled into a page you did not open yourself. Only the open folder’s passwords are listed.',
      build: (p) => {
        const team = el('span', 'btnline'); const teamBtn = el('button', 'btn', 'Load'); teamBtn.type = 'button';
        const tTell = said(team);
        teamBtn.onclick = async () => { teamBtn.disabled = true; tTell('Loading…'); const r = await ask('team-vault');
          if (r && r.error) tTell(r.error, true);
          else if (r && r.signedIn === false) tTell('Sign in to your team site in the tab that opened, then press Load again.', true);
          else tTell('Loaded.'); teamBtn.disabled = false; };
        team.prepend(teamBtn);
        const pwBox = el('div', 'pwlist'); p.append(pwBox);
        ask('team-offered').then((yes) => { if (yes) pwBox.before(settingRow('Your team’s shared logins', team, 'Loads the shared logins from your team’s site, once. Cards and bank logins stay out.')); });
        ask('passwords').then((list) => {
          if (!list) return;
          if (!list.length) { pwBox.append(el('div', 'hint', 'No saved passwords yet.')); return; }
          const same = new Map();
          list.forEach((x) => { const k = `${x.origin}|${x.username}`; same.set(k, [...(same.get(k) || []), x]); });
          const rows = [...same.values()].sort((q, r2) => hostOf(q[0].origin).localeCompare(hostOf(r2[0].origin)));
          pwBox.append(el('h3', '', `Saved sign-ins (${rows.length})`));
          rows.forEach((g) => {
            const x = g[0]; const r = el('div', 'srow unit');
            const a2 = el('input', 'switch'); a2.type = 'checkbox'; a2.checked = g.every((i) => i.auto); a2.setAttribute('role', 'switch');
            a2.setAttribute('aria-label', `Sign in to ${hostOf(x.origin)} by itself`);
            a2.onchange = () => g.forEach((i) => send('pw-auto', { pw: i.id, on: a2.checked }));
            const rm = el('button', 'btn', 'Remove'); rm.type = 'button'; rm.onclick = () => { g.forEach((i) => send('pw-remove', { pw: i.id })); r.remove(); };
            const left = el('div', 'slab'); left.append(el('span', '', esc(`${hostOf(x.origin)} · ${x.username || 'no username'}`)));
            const ctl = el('div', 'sctl'); ctl.append(el('span', 'unitword', 'auto'), a2, rm);
            r.append(left, ctl); pwBox.append(r);
          });
        });
      } },

    { id: 'ext', name: 'Chrome extensions', line: 'Add the extensions you already use in your other browsers.',
      more: 'An extension can read the pages you are signed in to, so each one says what it can do before you add it. They are copied from your other browsers, so they keep their settings. Removing one puts it in the Trash.',
      build: (p) => {
        const exBox = el('div', 'pwlist'); p.append(exBox);
        const extRow = (x, right) => {
          const r = el('div', 'rowtall unit');
          const left = el('div', 'rowtext');
          left.append(el('div', '', esc(x.version ? `${x.name} · ${x.version}` : x.name)));
          if (x.can) left.append(el('div', 'note', esc(x.can)));
          r.append(left, right);
          return r;
        };
        ask('ext-find').then((got) => {
          if (!got) return;
          const { available, installed } = got;
          if (installed.length) exBox.append(el('h3', '', `In Cue now (${installed.length})`));
          installed.forEach((x) => {
            let r = null;
            const b = confirmButton('Remove', 'Remove it?', async () => { await ask('ext-remove', { id: x.id }); r.replaceChildren(el('span', 'note', esc(`${x.name} removed. It is in the Trash.`))); });
            r = extRow({ ...x, name: x.on === false ? `${x.name} · off` : x.name }, b);
            exBox.append(r);
          });
          if (available.length) exBox.append(el('h3', '', `Found in your other browsers (${available.length})`));
          available.forEach((x) => {
            const b = el('button', 'btn', 'Add'); b.type = 'button'; const wrap = el('div', 'rowbtns');
            const st = el('span', 'note', esc(x.from));
            b.onclick = async () => { const res = await ask('ext-add', x); st.textContent = res && res.ok ? 'Added' : 'This one does not work in Cue yet'; b.disabled = true; };
            wrap.append(st, b);
            exBox.append(extRow(x, wrap));
          });
          if (!installed.length && !available.length) exBox.append(el('div', 'hint', 'None found.'));
        });
      } },

    { id: 'live', name: 'Live class', line: 'What the class sees, and how Cue talks to OBS.',
      more: 'Zoom: Share Screen, then pick “Cue Stage — On Air”. OBS: add a Window Capture of the same window.',
      build: (p) => {
        toggles(p, toggle('safeShare', s.safeShare, 'Blur private details on air', 'While a tab is on air, email addresses, phone numbers, amounts of money and keys on the page are blurred.'));
        const size = el('select'); [['1920x1080', '1920 × 1080'], ['1280x720', '1280 × 720']].forEach(([v, n]) => { const o = el('option', '', n); o.value = v; if (v === `${s.stageWidth}x${s.stageHeight}`) o.selected = true; size.append(o); });
        size.onchange = () => { const [w, h] = size.value.split('x').map(Number); send('setting', { key: 'stageWidth', value: w }); send('setting', { key: 'stageHeight', value: h }); };
        p.append(settingRow('Size of the on-air window', size));
        const ob = el('span', 'btnline');
        const status = el('span', 'pill' + (S.obs === 'connected' ? ' ok' : ''), S.obs === 'connected' ? 'Connected' : S.obs === 'connecting' ? 'Connecting…' : 'Not connected');
        const cb = el('button', 'btn', 'Connect'); cb.type = 'button'; cb.onclick = () => { send('obs-connect'); status.textContent = 'Connecting…'; };
        ob.append(status, cb);
        p.append(settingRow('OBS', ob));
        toggles(p, toggle('obs.autoConnect', s.obs.autoConnect !== false, 'Connect to OBS when Cue opens'));
        const a = S.tabs.find((t) => t.id === S.activeId);
        if (a) {
          const inp = el('input', 'wide'); inp.type = 'text'; inp.value = a.obsScene || ''; inp.placeholder = 'Scene name';
          inp.onchange = () => send('set-scene', { id: a.id, scene: inp.value });
          p.append(settingRow(`OBS scene for this tab`, inp, `Switches OBS to this scene when “${String(a.title || '').slice(0, 40)}” goes on air.`));
          ask('obs-scenes').then((list) => { if (list && list.length) { const dl = el('datalist'); dl.id = 'scenes'; list.forEach((n) => { const o = el('option'); o.value = n; dl.append(o); }); p.append(dl); inp.setAttribute('list', 'scenes'); } });
        }
        advanced(p, (box) => {
          box.append(settingRow('Computer OBS runs on', text('obs.host', s.obs.host, '127.0.0.1'), 'Leave as it is when OBS runs on this computer.'));
          box.append(settingRow('OBS connection number (port)', text('obs.port', s.obs.port, '4455', 'number')));
          box.append(settingRow('OBS password', text('obs.password', '', s.obs.password ? 'Saved' : 'From OBS > Tools > WebSocket', 'password')));
        });
      } },

    { id: 'ai', name: 'AI agents', line: 'Let Claude Code, Codex and other AI tools work in Cue.',
      more: 'They work in their own tabs with a purple ring and in the folders you allow. They can never touch off-air tabs, Vanish tabs or the tab on air, and Cue says on screen when one reaches into a tab you did not hand it. To hand over a tab, point at its row in the sidebar and click the AI mark; click it again to take it back. A lit mark means an agent is working in there right now.',
      build: (p) => {
        toggles(p,
          toggle('', !!S.agent.on, 'Let AI agents drive Cue', 'Stays as you leave it, so an agent can answer messages or check a page while you are busy. While it is off nothing can drive Cue but you, and an AI tool that tries is told why.', (on) => send('ai-door', { on })),
          ...(S.agent.sites || []).map((site) => toggle(`agentSites.${site.id}`, (s.agentSites || {})[site.id] !== false, `Let agents use ${site.name}`, site.what)));
        const cp = el('span', 'btnline'); const cpb = el('button', 'btn', 'Copy AI setup'); cpb.type = 'button';
        const tell = said(cp);
        cpb.onclick = () => { send('agent-copy'); tell('Copied. Paste it into your AI tool.'); };
        cp.prepend(cpb);
        p.append(settingRow('Connect an AI tool', cp, '', S.agent.last ? `Last: ${S.agent.last.agent} used ${S.agent.last.tool}` : 'No agent has connected yet.'));
        advanced(p, (box) => {
          box.append(settingRow('Address agents connect to', el('code', 'addr', esc(`127.0.0.1:${S.agent.port}`)), 'Only programs on this computer can reach it.'));
        });
      } },

    { id: 'disk', name: 'Storage and updates', line: 'Cue updates itself when you close it, and tidies its own space.',
      build: (p) => {
        toggles(p,
          toggle('autoUpdate', s.autoUpdate !== false, 'Update Cue by itself', 'A new version is fetched quietly and put in place when you close Cue, or when the computer has been left alone for 20 minutes, and Cue opens again on the same tabs. Never while something is on air, recording, playing or downloading.'),
          toggle('tidyInstallers', s.tidyInstallers, 'Move opened installers to the Trash after a day'));
        if (S.update && S.update.blocked === 'readonly') p.append(el('div', 'hint', 'Cue cannot update itself here because its folder is read-only. Get the new version from its download page.'));
        const used = el('span', 'btnline'); const usedText = el('span', 'hint', 'Measuring…'); const clearBtn = el('button', 'btn', 'Clear cache'); clearBtn.type = 'button';
        clearBtn.onclick = () => { send('clear-cache'); usedText.textContent = 'Cleared. Sign-ins are kept.'; };
        used.append(clearBtn);
        const ur = settingRow('Space Cue uses', used, 'Sites keep copies of pictures and scripts so they load faster. Clearing them is safe: sign-ins are kept.');
        ur.querySelector('.slab').append(usedText);
        p.append(ur);
        ask('storage').then((r) => { if (r) usedText.textContent = `Saved site files ${r.cacheMB} MB. Cue in total ${r.totalMB} MB. Trimmed by itself above ${r.limitMB} MB.`; });
        p.append(settingRow('Warn before downloading when free space falls under', amount(text('lowDiskGB', s.lowDiskGB, '5', 'number'), 'GB')));
        p.append(settingRow('GitHub name for Find anything', text('githubUser', s.githubUser, 'your-github-name'), 'Your GitHub projects then show up in Find anything.'));
        advanced(p, (box) => {
          box.append(settingRow('How much disk space each person’s sites may use', amount(text('cacheCapMB', s.cacheCapMB, '256', 'number'), 'MB'), 'Takes effect the next time Cue opens. Sign-ins are not affected.'));
        });
      } },
  ];
}

// Every word a unit of a room can be found by: its text, its "?" and any words it carries.
// A unit is found by the words on it (each searched word must start a word there), or by its
// "?" text when that holds the whole phrase - so "one video" does not find every help text that
// happens to say "one" somewhere and "video" somewhere else.
const unitWords = (u) => {
  const help = [...u.querySelectorAll('.help')].map((n) => n.textContent).join(' ');
  const all = `${u.textContent} ${u.dataset.words || ''} ${[...u.querySelectorAll('input[placeholder]')].map((i) => i.placeholder).join(' ')}`;
  return { main: (help ? all.split(help).join(' ') : all).toLowerCase(), help: help.toLowerCase() };
};
const wordStart = (text, w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);
const matches = (words, q) => {
  if (typeof words === 'string') words = { main: words, help: '' };
  return q.every((w) => wordStart(words.main, w)) || (q.length > 0 && words.help.includes(q.join(' ')));
};

function openSettings(startAt) {
  const rooms = settingsRooms();
  rooms.push({ id: 'setup', name: 'Starting setup', line: 'Plain, or one organisation’s own apps and Spaces on top.', build: startingSetupRoom });
  // A kit that is off takes its room with it.
  { const k = (S.settings && S.settings.kits) || {}; for (const [room, kit] of [['live', 'teacher']]) { const i = rooms.findIndex((r) => r.id === room); if (i >= 0 && k[kit] === false) rooms.splice(i, 1); } }
  // What each room can be found by, read once per opening without asking the main side anything.
  let index = null;
  const buildIndex = () => {
    indexing = true;
    try {
      index = rooms.map((room) => {
        const box = el('div');
        try { room.build(box); } catch {}
        return { id: room.id, head: `${room.name} ${room.line} ${room.more || ''}`.toLowerCase(), units: [...box.querySelectorAll('.unit')].map(unitWords) };
      });
    } finally { indexing = false; }
  };

  openModal((sh) => {
    sh.classList.add('settings');
    sh.append(el('h2', '', 'Settings'));
    const body = el('div', 'sbody');
    const side = el('div', 'sside');
    const search = el('input', 'ssearch'); search.type = 'search'; search.placeholder = 'Search settings'; search.setAttribute('aria-label', 'Search settings');
    const nav = el('div', 'snav'); nav.setAttribute('role', 'tablist');
    side.append(search, nav);
    const pane = el('div', 'spane'); pane.setAttribute('role', 'tabpanel');
    body.append(side, pane);
    sh.append(body);
    const drawRoom = (room, into) => {
      try { room.build(into); }
      catch (e) {
        into.innerHTML = '';
        into.append(el('div', 'note', `This part of Settings could not be drawn: ${esc(e && e.message ? e.message : e)}. Everything else still works and nothing is lost; please report it.`));
      }
    };
    const show = (id) => {
      const room = rooms.find((x) => x.id === id) || rooms[0];
      settingsRoom = room.id;
      pane.innerHTML = ''; pane.classList.remove('results');
      [...nav.children].forEach((b) => { b.classList.toggle('on', b.dataset.id === room.id); b.classList.remove('miss'); b.setAttribute('aria-selected', String(b.dataset.id === room.id)); });
      intro(pane, room.line, room.more);
      drawRoom(room, pane);
      pane.scrollTop = 0;
    };
    // Searching shows every room that has the words, each with only the settings that match,
    // working as they do in their own room. Clicking a room's name goes to the whole room.
    const find = () => {
      const q = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!q.length) { show(settingsRoom); return; }
      if (!index) buildIndex();
      pane.innerHTML = ''; pane.classList.add('results');
      let any = false;
      for (const room of rooms) {
        const ix = index.find((x) => x.id === room.id);
        const whole = matches(ix.head, q);
        const some = ix.units.some((w) => matches(w, q));
        const b = nav.querySelector(`[data-id="${room.id}"]`);
        b.classList.toggle('miss', !whole && !some); b.classList.remove('on');
        if (!whole && !some) continue;
        any = true;
        const sec = el('section', 'sresult'); sec.dataset.room = room.id;
        const go = el('button', 'sroom', `${esc(room.name)} <span>›</span>`); go.type = 'button';
        go.onclick = () => { search.value = ''; show(room.id); };
        sec.append(go);
        const inner = el('div', 'sinner'); drawRoom(room, inner);
        if (!whole) {
          for (const u of inner.querySelectorAll('.unit')) u.hidden = !matches(unitWords(u), q);
          for (const h of inner.querySelectorAll('h3, .hint:not(.unit .hint)')) h.hidden = true;
          for (const g of inner.querySelectorAll('.tgrid')) g.hidden = ![...g.children].some((c) => !c.hidden);
        }
        for (const d of inner.querySelectorAll('details.adv')) if ([...d.querySelectorAll('.unit')].some((u) => !u.hidden)) d.open = true; else if (!whole) d.hidden = true;
        sec.append(inner);
        pane.append(sec);
      }
      if (!any) pane.append(el('div', 'hint', `Nothing in Settings matches “${esc(search.value.trim())}”.`));
      pane.scrollTop = 0;
    };
    search.oninput = find;
    search.onkeydown = (e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; find(); } };
    rooms.forEach((room) => {
      const b = el('button', '', esc(room.name)); b.dataset.id = room.id; b.type = 'button'; b.setAttribute('role', 'tab');
      b.onclick = () => { if (search.value) search.value = ''; show(room.id); };
      nav.append(b);
    });
    show(startAt || settingsRoom);
    const foot = el('div', 'foot'); const done = el('button', 'btn', 'Done'); done.type = 'button'; done.onclick = closeModal; foot.append(done); sh.append(foot);
  });
}
// Settings > Starting setup. Self-contained: it shows which setup is on and switches it, and never
// touches sign-ins, tabs or folders.
function startingSetupRoom(p) {
  const on = S.preset;
  p.append(el('div', 'note', 'Cue starts plain: one Space, empty number keys, nothing pinned. A starting setup adds one organisation’s own things on top. Your sign-ins, tabs and folders are never touched by switching one on or off.'));
  p.append(settingRow('Now', el('span', 'note', esc(on ? on.name : 'Plain'))));
  const list = el('div', ''); p.append(list);
  // Asked for here rather than carried in every state push, so a plain install's sidebar is never
  // told any organisation's name.
  window.cue.invoke('presets').then((all) => {
    for (const x of (all || [])) {
      const row = el('div', 'row');
      const mine = on && on.id === x.id;
      const b = el('button', 'btn', mine ? 'Go back to plain' : `Apply ${esc(x.name)} setup`);
      b.dataset.preset = x.id;
      b.onclick = async () => {
        b.disabled = true;
        const r = await window.cue.invoke(mine ? 'preset.remove' : 'preset.apply', { id: x.id });
        if (r && r.error) toast(r.error); else toast(mine ? 'Cue is plain again.' : `${x.name} setup is on.`);
        setTimeout(() => { closeModal(); openSettings('setup'); }, 200);
      };
      row.append(el('span', 'note', esc(mine
        ? (on.undo ? 'Takes away its apps, tiles, trusted sites and group, and puts back what switching it on changed. Anything you changed since stays.' : 'Takes away its apps, tiles, trusted sites and group. Your Spaces, number keys and pins stay as they are.')
        : `${x.about} Adds its Spaces next to yours, fills number keys you have not set, turns every kit on.`)), b);
      list.append(row);
    }
  });
}

// The first-run sheet: what to call you, which sites to pin, which starting setup. Skippable; it
// only ever appears once, on a brand-new install.
function welcomeSheet(d) {
  closeModal();
  openModal((sh) => {
    sh.classList.add('welcome');
    sh.append(el('h2', '', 'Welcome to Cue'));
    let colour = d.color;
    const nameRow = el('div', 'row');
    const face = el('span', 'fface');
    const paint = () => { face.innerHTML = ''; face.append(el('i', 'fltr', esc(((nm.value || d.name || '?').trim()[0] || '?').toUpperCase()))); face.style.setProperty('--c', colour); };
    const nm = el('input'); nm.type = 'text'; nm.maxLength = 40; nm.placeholder = 'Your name'; nm.setAttribute('aria-label', 'What should we call you?');
    nm.oninput = paint;
    nameRow.append(face, nm);
    sh.append(el('h3', '', 'What should we call you?'), nameRow);
    const sw = el('div', 'wswatches');
    for (const c of d.colors) {
      const b = el('button', 'wswatch' + (c === colour ? ' on' : '')); b.style.background = c; b.setAttribute('aria-label', `Colour ${c}`);
      b.onclick = () => { colour = c; for (const x of sw.children) x.classList.toggle('on', x === b); paint(); };
      sw.append(b);
    }
    sh.append(sw);
    sh.append(el('h3', '', 'Pin your everyday sites'));
    const picks = el('div', 'welcomesites');
    const boxes = new Map();
    for (const site of d.sites) {
      const l = el('label', 'note'); const c = el('input'); c.type = 'checkbox'; c.value = site.url;
      l.append(c, document.createTextNode(` ${site.name}`)); picks.append(l); boxes.set(site.url, c);
    }
    sh.append(picks, el('div', 'note', 'They sit at the top of the sidebar. Unpin any of them later with a right-click.'));
    sh.append(el('h3', '', 'Starting setup'));
    const setups = el('div', 'choices');
    let preset = '';
    let school = null;
    const pick = (id) => {
      preset = id;
      for (const b of setups.querySelectorAll('button')) b.classList.toggle('on', b.dataset.id === id);
      const x = d.setups.find((y) => y.id === id);
      if (x) for (const u of x.pinned || []) if (boxes.has(u)) boxes.get(u).checked = true;
      if (school) school.parentElement.hidden = !(x && x.school);
    };
    const plain = el('button', 'choice on', 'Plain<small>One Space, nothing pinned you did not pick. You can add more later.</small>'); plain.dataset.id = '';
    plain.onclick = () => pick('');
    setups.append(plain);
    for (const x of d.setups || []) {
      const b = el('button', 'choice', `${esc(x.name)}<small>${esc(x.about)}</small>`); b.dataset.id = x.id;
      b.onclick = () => pick(x.id);
      setups.append(b);
      if (x.school && !school) {
        const l = el('label', 'note'); school = el('input'); school.type = 'checkbox'; school.checked = true;
        l.append(school, document.createTextNode(' Also add a School folder for the school’s own accounts')); l.hidden = true;
      }
    }
    sh.append(setups);
    if (school) sh.append(school.parentElement);
    sh.append(el('div', 'note', 'Add more people later with the + under your name. Each person’s sign-ins stay separate.'));
    const foot = el('div', 'foot');
    const skip = el('button', 'btn', 'Skip');
    skip.onclick = async () => { await window.cue.invoke('welcome.skip'); closeModal(); };
    const go = el('button', 'btn', 'Start');
    go.onclick = async () => {
      go.disabled = true;
      const r = await window.cue.invoke('welcome.finish', { name: nm.value.trim(), color: colour, sites: [...boxes].filter(([, c]) => c.checked).map(([u]) => u), preset, school: !!(school && school.checked) });
      if (r && r.error) { toast(r.error); go.disabled = false; return; }
      closeModal();
    };
    foot.append(skip, go);
    sh.append(foot);
    paint();
    setTimeout(() => nm.focus(), 30);
  });
}

// The passcode sheet. Masked, a plain line when the code is wrong, and after five wrong tries it
// says how long to wait and will not take another until then.
function unlockSheet(d) {
  closeModal();
  openModal((sh) => {
    sh.classList.add('unlock');
    const top = el('div', 'row');
    top.append(folderFace({ name: d.name, picture: d.picture }));
    top.append(el('h2', '', `${esc(d.name)} is locked`));
    top.style.setProperty('--c', d.color);
    sh.append(top);
    sh.append(el('div', 'note', 'Type this folder’s passcode to open it.'));
    const inp = el('input'); inp.type = 'password'; inp.autocomplete = 'off'; inp.placeholder = 'Passcode'; inp.setAttribute('aria-label', `Passcode for ${d.name}`);
    const say = el('div', 'note unlockerr'); say.setAttribute('role', 'alert');
    const go = el('button', 'btn', 'Unlock');
    let timer = null;
    const waitFor = (s) => {
      clearInterval(timer);
      let left = s;
      inp.disabled = true; go.disabled = true;
      const tick = () => {
        if (left <= 0) { clearInterval(timer); inp.disabled = false; go.disabled = false; say.textContent = ''; inp.focus(); return; }
        say.textContent = `Too many wrong tries. Try again in ${left} second${left === 1 ? '' : 's'}.`;
        left -= 1;
      };
      tick(); timer = setInterval(tick, 1000);
    };
    const tryIt = async () => {
      if (!inp.value) return;
      const r = await window.cue.invoke('folder-unlock', { id: d.id, code: inp.value });
      inp.value = '';
      if (r && r.ok) { clearInterval(timer); closeModal(); return; }
      if (r && r.wait) waitFor(r.wait); else { say.textContent = (r && r.error) || 'That passcode is not right.'; inp.focus(); }
    };
    go.onclick = tryIt;
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); tryIt(); } };
    const row = el('div', 'row'); row.append(inp, go);
    sh.append(row, say);
    const foot = el('div', 'foot'); const cancel = el('button', 'btn', 'Cancel'); cancel.onclick = () => { clearInterval(timer); closeModal(); }; foot.append(cancel); sh.append(foot);
    if (d.wait) waitFor(d.wait); else setTimeout(() => inp.focus(), 30);
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
  // The bar was still showing the address of the tab he just left, because
  // focusing it stops render() touching the text. Put the new tab's address in
  // first - empty, for a new tab - then focus, so he types into a clear box.
  else if (name === 'focus-omnibox') {
    const a = S.tabs.find((t) => t.id === S.activeId);
    omni.value = a ? a.url : '';
    omni.focus(); omni.select();
  }
  // Takes the keyboard back off the page that just loaded, without touching
  // what he has already typed.
  else if (name === 'refocus-omnibox') { if (document.activeElement !== omni) omni.focus(); }
  else if (name === 'focus-find') openFind();
  // Right-click > Volume…: the pinned app's control, or the slider on the tab's own row.
  else if (name === 'volume-pop' && data) {
    if (document.querySelector(`.pin[data-id="${data.id}"]`)) openVolPop(data.id, 'held');
    else {
      openVolId = data.id; render();
      const r = document.querySelector(`.tab[data-id="${data.id}"] .volpop input`);
      if (r) r.focus();
    }
  }
  else if (name === 'find-result') $('#findcount').textContent = data.total ? `${data.active}/${data.total}` : 'No matches';
  else if (name === 'program-thumb') $('#lb-thumb').src = data;
  else if (name === 'share-picker') sharePicker(data);
  else if (name === 'palette-open') openPalette();
  else if (name === 'palette') showPalette(data.colors);
  else if (name === 'import') openImport();
  else if (name === 'save-password') credBar(data);
  else if (name === 'rec-start') startRecording();
  else if (name === 'rec-stop') stopRecording();
  else if (name === 'open-settings') openSettings(typeof data === 'string' ? data : undefined);
  else if (name === 'unlock') unlockSheet(data);
  else if (name === 'welcome') welcomeSheet(data);
  else if (name === 'music-state' && data) {
    if (data.none) { toast('No video or audio on this page yet.'); return; }
    M.loop = !!data.loop; M.speed = Math.round(data.speed * 100); $('#m-speed').textContent = `${M.speed}%`;
    $('#m-loop').textContent = data.loop ? 'On' : (data.a != null ? 'Set' : 'Off');
    $('#m-loop').classList.toggle('on', !!data.loop);
  }
});
window.addEventListener('resize', () => { if (!$('#suggest').hidden) showSuggest(); });
