// The Vanish window's toolbar.
const $ = (s) => document.querySelector(s);
const send = (cmd, a) => window.vanish.send(cmd, a);
const url = $('#url');

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
  const box = $('#tabs'); box.innerHTML = '';
  for (const t of s.tabs) {
    const b = document.createElement('button');
    b.className = 'tab' + (t.active ? ' on' : ''); b.title = t.title;
    if (t.favicon) { const i = new Image(); i.src = t.favicon; i.alt = ''; b.append(i); } else b.append(document.createElement('i'));
    b.onclick = () => send('activate', { id: t.id });
    b.onauxclick = (e) => { if (e.button === 1) send('close', { id: t.id }); };
    box.append(b);
  }
});
