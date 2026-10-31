'use strict';
// Library: bookmarks, history and archived tabs. Every string from the app is written with textContent.
(() => {
  const SAMPLE = !window.cueInternal;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  let toastTimer = 0;
  function toast(msg) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = el('div', 'toast', msg); t.setAttribute('role', 'status'); document.body.appendChild(t);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3200);
  }

  // ---- sample data ----
  const now = Date.now(); const H = 3600000; const D = 86400000;
  const sample = SAMPLE ? {
    bookmarks: [
      { title: 'Learning Portal', url: 'https://learning-portal.nathanielschool.com/', folder: 'School' },
      { title: 'NSM Apps', url: 'https://apps.nathanielschool.com/', folder: 'School' },
      { title: 'YouTube Studio', url: 'https://studio.youtube.com/', folder: 'Channel' },
      { title: 'Circle of Fifths, explained', url: 'https://www.musictheory.net/lessons/25', folder: 'Teaching ideas' },
      { title: 'Salamander Grand Piano', url: 'https://sfzinstruments.github.io/pianos/salamander/', folder: 'Teaching ideas' },
      { title: 'Silverline Electronics', url: 'https://silverlineelectronics.in/', folder: '' },
    ],
    history: [
      { url: 'https://studio.youtube.com/channel/UC123/videos', title: 'Channel content - YouTube Studio', lastVisit: now - 12 * 60000, visits: 41 },
      { url: 'https://www.google.com/search?q=sus4+chords', title: 'sus4 chords - Google Search', lastVisit: now - 2 * H, visits: 3 },
      { url: 'https://learning-portal.nathanielschool.com/admin', title: 'Admin - Learning Portal', lastVisit: now - 5 * H, visits: 122 },
      { url: 'https://www.pinterest.com/search/pins/?q=poster', title: 'poster - Pinterest', lastVisit: now - 1 * D - 3 * H, visits: 2 },
      { url: 'https://github.com/jasonzacmusic/cue', title: 'jasonzacmusic/cue: a browser for musicians', lastVisit: now - 1 * D - 6 * H, visits: 9 },
      { url: 'https://example.com/a-really-long-address/that-keeps-going/and-going/and-going/until-it-has-to-be-cut-off-by-the-row?with=query&and=more', title: 'A page with a very long title that should be cut off tidily at the end of the row instead of wrapping', lastVisit: now - 9 * D, visits: 1 },
    ],
    sites: [
      { host: 'learning-portal.nathanielschool.com', title: 'Learning Portal', visits: 310, lastVisit: now - 20 * 60000, pages: 24, group: 'Nathaniel School' },
      { host: 'studio.youtube.com', title: 'YouTube Studio', visits: 88, lastVisit: now - 2 * H, pages: 6, group: 'Google' },
      { host: 'espncricinfo.com', title: 'ESPNcricinfo', visits: 12, lastVisit: now - 1 * D, pages: 4, group: 'Tabs' },
      { host: 'claude.ai', title: 'Claude', visits: 140, lastVisit: now - 4 * H, pages: 9, group: 'AI & Subscriptions' },
    ],
    archived: [
      { id: 'x1', url: 'https://www.instagram.com/nathanielschool/', title: 'Nathaniel School of Music (@nathanielschool)', archivedAt: now - 3 * H },
      { id: 'x2', url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox - Gmail', archivedAt: now - 2 * D },
    ],
  } : null;
  async function fake(cmd, a) {
    if (cmd === 'library.bookmarks') return sample.bookmarks.slice();
    if (cmd === 'library.history') { const q = (a.q || '').toLowerCase(); return sample.history.filter((h) => !q || (h.title + ' ' + h.url).toLowerCase().includes(q)); }
    if (cmd === 'library.sites') { const q = (a.q || '').toLowerCase(); return sample.sites.filter((x) => !q || (x.title + ' ' + x.host).toLowerCase().includes(q)); }
    if (cmd === 'library.pages') return sample.history.filter((h) => host(h.url) === a.host);
    if (cmd === 'library.forget') { sample.sites = sample.sites.filter((x) => x.host !== a.host); return true; }
    if (cmd === 'library.archived') return sample.archived.slice();
    if (cmd === 'library.restore') { sample.archived = sample.archived.filter((x) => x.id !== a.id); return true; }
    if (cmd === 'library.history.clear') { sample.history = []; sample.sites = []; return true; }
    if (cmd === 'open') { toast('Would open ' + a.url); return true; }
    return null;
  }
  const call = (cmd, args) => (window.cueInternal ? window.cueInternal.invoke(cmd, args || {}) : fake(cmd, args || {}));

  // ---- state ----
  const data = { bookmarks: [], history: [], sites: [], archived: [] };
  const openSites = new Set(); // which sites you have opened up to see their pages
  const counts = {};
  let tab = 'bookmarks';
  let confirmClear = false;
  let histTimer = 0;

  const norm = (s) => String(s || '').toLowerCase();
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const shortUrl = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '');
  const letter = (b) => ((host(b.url) || b.title || '?')[0] || '?').toUpperCase();

  function clock(ms) { return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function dayLabel(ms) {
    const d = new Date(ms); const t = new Date(); const start = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((start - day) / D);
    if (diff <= 0) return 'Today'; if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
  }
  function relative(ms) {
    const diff = Math.round((new Date(new Date().setHours(0, 0, 0, 0)) - new Date(new Date(ms).setHours(0, 0, 0, 0))) / D);
    return diff <= 0 ? 'Today ' + clock(ms) : diff === 1 ? 'Yesterday ' + clock(ms) : new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  // Highlights the search words using text nodes and <mark>, never innerHTML.
  function hl(node, text, q) {
    const s = String(text || ''); const i = q ? norm(s).indexOf(q) : -1;
    if (i < 0) { node.textContent = s; return node; }
    node.textContent = '';
    node.append(document.createTextNode(s.slice(0, i)), Object.assign(document.createElement('mark'), { textContent: s.slice(i, i + q.length) }), document.createTextNode(s.slice(i + q.length)));
    return node;
  }
  async function open(url) { try { await call('open', { url }); } catch (e) { toast('Could not open that page.'); } }

  function row(item, q, metaNodes) {
    const li = el('li', 'row'); li.appendChild(el('div', 'ic', letter(item)));
    const tx = el('div', 'tx'); const a = el('a'); a.href = item.url; a.title = item.url;
    hl(a, item.title || shortUrl(item.url), q); a.addEventListener('click', (e) => { e.preventDefault(); open(item.url); });
    const u = el('span', 'u'); hl(u, shortUrl(item.url), q);
    tx.append(a, u); li.appendChild(tx);
    const meta = el('div', 'meta'); metaNodes.forEach((n) => meta.appendChild(n)); li.appendChild(meta);
    return li;
  }
  function group(title, rows) {
    const g = el('section', 'group'); if (title) g.appendChild(el('h2', null, title));
    const ul = el('ul', 'rows'); rows.forEach((r) => ul.appendChild(r)); g.appendChild(ul); return g;
  }
  function empty(title, body) { const e = el('div', 'empty'); e.append(el('b', null, title), el('p', null, body)); return e; }

  function renderBookmarks(q, out) {
    const list = data.bookmarks.filter((b) => !q || norm(b.title + ' ' + b.url + ' ' + b.folder).includes(q));
    if (!list.length) { out.appendChild(q ? empty('No bookmarks match', 'Try fewer letters.') : empty('No bookmarks yet', 'Press Cmd+D on any page to save it here.')); return list.length; }
    const folders = new Map();
    for (const b of list) { const f = b.folder || 'Not in a folder'; if (!folders.has(f)) folders.set(f, []); folders.get(f).push(b); }
    for (const [f, items] of folders) out.appendChild(group(f, items.map((b) => row(b, q, []))));
    return list.length;
  }
  // History is a list of places, not a list of pages. One line per website,
  // filed under the same headings the sidebar uses, and you open a site up to
  // see the pages Cue has kept from it — or forget that site completely.
  function siteEntry(s, q) {
    const li = el('li', 'row');
    li.appendChild(el('div', 'ic', (s.host[0] || '?').toUpperCase()));
    const tx = el('div', 'tx');
    const a = el('a'); a.href = 'https://' + s.host + '/';
    hl(a, s.title && s.title !== s.host ? s.title : s.host, q);
    a.addEventListener('click', (e) => { e.preventDefault(); open('https://' + s.host + '/'); });
    const u = el('span', 'u'); hl(u, s.host, q);
    tx.append(a, u); li.appendChild(tx);

    const meta = el('div', 'meta');
    meta.append(el('span', null, relative(s.lastVisit)), el('span', null, s.visits === 1 ? '1 visit' : s.visits + ' visits'));
    const openUp = el('button', 'btn small quiet', '');
    openUp.type = 'button';
    const pages = el('li', 'pagelist'); pages.hidden = !openSites.has(s.host);
    const label = () => {
      openUp.textContent = !s.pages ? 'No pages kept'
        : openSites.has(s.host) ? 'Hide pages' : (s.pages === 1 ? 'Show 1 page' : 'Show ' + s.pages + ' pages');
      openUp.disabled = !s.pages;
    };
    label();
    openUp.addEventListener('click', async () => {
      if (openSites.has(s.host)) { openSites.delete(s.host); pages.hidden = true; label(); return; }
      openSites.add(s.host); label();
      pages.textContent = ''; pages.hidden = false;
      let rows = [];
      try { rows = (await call('library.pages', { host: s.host })) || []; } catch (e) { rows = []; }
      if (!rows.length) { pages.appendChild(el('p', 'none', 'Nothing kept from this site yet.')); return; }
      const ul = el('ul', 'rows');
      rows.forEach((h) => ul.appendChild(row(h, q, [el('span', null, relative(h.lastVisit))])));
      pages.appendChild(ul);
    });
    const forget = el('button', 'btn small danger', 'Forget');
    forget.type = 'button';
    forget.setAttribute('aria-label', 'Forget everything from ' + s.host);
    let sure = false;
    forget.addEventListener('click', async () => {
      if (!sure) { sure = true; forget.textContent = 'Forget it all?'; forget.classList.add('sure'); setTimeout(() => { sure = false; forget.textContent = 'Forget'; forget.classList.remove('sure'); }, 4000); return; }
      try { await call('library.forget', { host: s.host }); toast('Forgot ' + s.host); } catch (e) { toast('Could not forget that site.'); }
      openSites.delete(s.host); await loadHistory(); counts.history = data.sites.length; render();
    });
    meta.append(openUp, forget);
    li.appendChild(meta);
    return [li, pages];
  }

  function renderHistory(q, out) {
    const list = data.sites.slice().sort((a, b) => b.lastVisit - a.lastVisit);
    if (!list.length) { out.appendChild(q ? empty('Nothing found', 'No website matches that.') : empty('No history', 'The websites you visit will show up here, one line each.')); return 0; }
    const cats = new Map();
    for (const s of list) { const k = s.group || 'Everything else'; if (!cats.has(k)) cats.set(k, []); cats.get(k).push(s); }
    const ordered = [...cats.entries()].sort((a, b) => (a[1][0].rank ?? 98) - (b[1][0].rank ?? 98));
    for (const [k, items] of ordered) {
      const rows = [];
      items.forEach((s) => rows.push(...siteEntry(s, q)));
      out.appendChild(group(k, rows));
    }
    return list.length;
  }
  function renderArchived(q, out) {
    const list = data.archived.filter((x) => !q || norm(x.title + ' ' + x.url).includes(q)).sort((a, b) => b.archivedAt - a.archivedAt);
    if (!list.length) { out.appendChild(q ? empty('Nothing found', 'No archived tab matches that.') : empty('Nothing archived', 'Tabs you put away show up here, and you can bring any of them back.')); return 0; }
    const rows = list.map((x) => {
      const rb = el('button', 'btn small', 'Bring back'); rb.type = 'button';
      rb.setAttribute('aria-label', 'Bring back ' + (x.title || x.url));
      rb.addEventListener('click', async () => {
        try { await call('library.restore', { id: x.id }); toast('Brought back ' + (x.title || shortUrl(x.url))); } catch (e) { toast('Could not bring it back.'); }
        await loadArchived(); render();
      });
      return row(x, q, [el('span', null, 'Put away ' + relative(x.archivedAt)), rb]);
    });
    out.appendChild(group('', rows));
    return list.length;
  }

  function render() {
    const q = norm($('q').value.trim());
    const out = $('out'); out.textContent = '';
    let n = 0;
    if (tab === 'bookmarks') n = renderBookmarks(q, out);
    else if (tab === 'history') n = renderHistory(q, out);
    else n = renderArchived(q, out);
    counts[tab] = q ? counts[tab] : n;
    document.querySelectorAll('.tabs button').forEach((b) => {
      const on = b.dataset.tab === tab; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
      const c = $('n-' + b.dataset.tab); c.textContent = counts[b.dataset.tab] != null ? String(counts[b.dataset.tab]) : '';
    });
    $('out').setAttribute('aria-labelledby', 't-' + tab);
    $('status').textContent = q ? (n === 1 ? '1 match' : n + ' matches') : '';
    const ch = $('clearHist'); ch.hidden = tab !== 'history' || !data.sites.length;
    ch.textContent = confirmClear ? 'Yes, clear it all' : 'Clear history'; ch.classList.toggle('sure', confirmClear);
  }

  async function loadBookmarks() { try { data.bookmarks = (await call('library.bookmarks')) || []; } catch (e) { data.bookmarks = []; } counts.bookmarks = data.bookmarks.length; }
  async function loadArchived() { try { data.archived = (await call('library.archived')) || []; } catch (e) { data.archived = []; } counts.archived = data.archived.length; }
  async function loadHistory() {
    const q = $('q').value.trim();
    try { data.sites = (await call('library.sites', { q })) || []; } catch (e) { data.sites = []; }
    if (!q) counts.history = data.sites.length;
  }

  function setTab(t) {
    tab = t; confirmClear = false; $('q').value = ''; history.replaceState(null, '', '#' + t);
    (t === 'history' ? loadHistory() : Promise.resolve()).then(render);
  }
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => setTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      const order = ['bookmarks', 'history', 'archived']; let i = order.indexOf(tab);
      if (e.key === 'ArrowRight') i = (i + 1) % 3; else if (e.key === 'ArrowLeft') i = (i + 2) % 3; else return;
      e.preventDefault(); setTab(order[i]); $('t-' + order[i]).focus();
    });
  });
  $('q').addEventListener('input', () => {
    if (tab === 'history') { clearTimeout(histTimer); histTimer = setTimeout(async () => { await loadHistory(); render(); }, 180); } else render();
  });
  $('clearHist').addEventListener('click', async () => {
    if (!confirmClear) { confirmClear = true; render(); setTimeout(() => { if (confirmClear) { confirmClear = false; render(); } }, 5000); return; }
    confirmClear = false;
    try { await call('library.history.clear'); toast('History cleared'); } catch (e) { toast('Could not clear history.'); }
    $('q').value = ''; openSites.clear(); await loadHistory(); counts.history = data.sites.length; render();
  });

  (async () => {
    if (SAMPLE) $('sampleNote').hidden = false;
    const want = location.hash.slice(1); if (['bookmarks', 'history', 'archived'].includes(want)) tab = want;
    const saved = $('q').value; $('q').value = '';
    await Promise.all([loadBookmarks(), loadArchived()]);
    // Count history without a search term so the tab number is right from the start.
    await loadHistory();
    $('q').value = saved;
    render();
  })();
})();
