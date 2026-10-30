// The Vanish window's toolbar.
const $ = (s) => document.querySelector(s);
const send = (cmd, a) => window.vanish.send(cmd, a);
const url = $('#url');
const CLOSE = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m2 2 6 6M8 2 2 8"/></svg>';
let lastTabs = '';

function tabEl(t) {
  const el = document.createElement('div');
  el.className = 'tab' + (t.active ? ' on' : '') + (t.loading ? ' loading' : '');
  el.title = t.title; el.setAttribute('role', 'tab'); el.setAttribute('aria-selected', t.active);
  const icon = () => { const d = document.createElement('span'); d.className = 'dot'; return d; };
  if (t.favicon && !t.loading) {
    const i = new Image(); i.src = t.favicon; i.alt = '';
    i.onerror = () => i.replaceWith(icon());
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
  el.append(name, x);
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
});
