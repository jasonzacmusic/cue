// The Vanish window's toolbar.
const $ = (s) => document.querySelector(s);
const send = (cmd, a) => window.vanish.send(cmd, a);
const url = $('#url');
const CLOSE = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m2 2 6 6M8 2 2 8"/></svg>';
let lastTabs = '';
let dragging = null;

function tabEl(t) {
  const el = document.createElement('div');
  el.className = 'tab' + (t.active ? ' on' : '') + (t.loading ? ' loading' : '');
  el.title = t.title; el.setAttribute('role', 'tab'); el.setAttribute('aria-selected', t.active);
  // The last resort is not an empty ring any more: it is the site's own first
  // letter, so a tab always says which site it is even when the site keeps no
  // logo at any of the usual addresses.
  const icon = () => {
    const d = document.createElement('span');
    d.className = 'dot';
    const c = (t.title || '').trim()[0];
    if (c && !t.loading) { d.textContent = c.toUpperCase(); d.className = 'dot letter'; }
    return d;
  };
  const tries = (t.icons || []).slice();
  if (tries.length) {
    const i = new Image(); i.alt = '';
    i.onerror = () => { tries.shift(); if (tries.length) i.src = tries[0]; else i.replaceWith(icon()); };
    i.src = tries[0];
    el.append(i);
  } else el.append(icon());
  const name = document.createElement('span');
  name.className = 'name'; name.textContent = t.title;
  const x = document.createElement('button');
  x.className = 'x'; x.innerHTML = CLOSE; x.setAttribute('aria-label', `Close ${t.title}`);
  x.onmousedown = (e) => e.stopPropagation();
  x.onclick = () => send('close', { id: t.id });
  el.onmousedown = (e) => { if (e.button === 0) send('activate', { id: t.id }); };
  el.onauxclick = (e) => { if (e.button === 1) send('close', { id: t.id }); };
  // Drag to reorder. The strip rebuilds itself whenever state arrives, so the
  // drag is held in a variable up here rather than on the element being moved.
  el.draggable = true;
  el.ondragstart = (e) => { dragging = t.id; e.dataTransfer.effectAllowed = 'move'; };
  el.ondragend = () => { dragging = null; };
  el.ondragover = (e) => {
    if (dragging === null || dragging === t.id) return;
    e.preventDefault();
    const strip = [...$('#tabs').children];
    const to = strip.indexOf(el);
    if (to >= 0) send('move', { id: dragging, to });
  };
  if (t.muted) {
    const m = document.createElement('span');
    m.className = 'hush'; m.title = 'Muted';
    m.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path d="m11 6 4 4m0-4-4 4"/></svg>';
    el.append(name, m, x);
  } else el.append(name, x);
  return el;
}

if (!navigator.platform.startsWith('Mac')) document.body.classList.add('flat');
$('#back').onclick = () => send('back');
$('#fwd').onclick = () => send('forward');
$('#reload').onclick = () => send('reload');
$('#new').onclick = () => send('new');
url.onkeydown = (e) => { if (e.key === 'Enter' && url.value.trim()) send('navigate', { text: url.value }); };
url.onfocus = () => url.select();
window.vanish.onFocus(() => { url.focus(); url.select(); });
window.vanish.onState((s) => {
  if (document.activeElement !== url) url.value = s.url;
  $('#back').disabled = !s.canBack; $('#fwd').disabled = !s.canFwd;
  const shown = JSON.stringify(s.tabs);
  if (shown === lastTabs) return; // rebuilding mid-click would lose the click
  lastTabs = shown;
  $('#tabs').replaceChildren(...s.tabs.map(tabEl));
  $('#tabs').style.flexBasis = `${s.tabs.length * 222}px`; // tabs measure themselves, so the strip is told its full width
});

// Find on the page: Cmd+F (Ctrl+F) opens it, Enter goes to the next match, Shift+Enter back,
// Escape or the X closes it.
const findText = $('#findText');
const closeFind = () => { document.body.classList.remove('finding'); findText.value = ''; $('#findCount').textContent = ''; send('find-close'); };
window.vanish.onFindOpen(() => { document.body.classList.add('finding'); findText.focus(); findText.select(); });
findText.oninput = () => send('find', { text: findText.value });
findText.onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); send('find', { text: findText.value, back: e.shiftKey }); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
};
$('#findClose').onclick = closeFind;
window.vanish.onFindResult((r) => {
  if (r.closed) { document.body.classList.remove('finding'); findText.value = ''; $('#findCount').textContent = ''; return; }
  $('#findCount').textContent = findText.value ? (r.total ? `${r.active} of ${r.total}` : 'None') : '';
});

// A plain line for things Vanish has to tell you, shown here rather than in Cue's main window.
let noteTimer = null;
window.vanish.onNote((text) => {
  const n = $('#note');
  n.textContent = text; n.title = text; n.hidden = false;
  clearTimeout(noteTimer); noteTimer = setTimeout(() => { n.hidden = true; }, 6000);
});
