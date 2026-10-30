'use strict';
// Boards: every string from the app is written with textContent, never innerHTML.
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

  // ---- sample data, only used when the page is opened outside Cue ----
  function art(w, h, a, b, label) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + a + '"/><stop offset="1" stop-color="' + b + '"/></linearGradient></defs>' +
      '<rect width="100%" height="100%" fill="url(#g)"/><circle cx="' + (w * 0.7) + '" cy="' + (h * 0.3) + '" r="' + (w * 0.14) + '" fill="rgba(255,255,255,.28)"/>' +
      '<text x="' + (w * 0.08) + '" y="' + (h * 0.92) + '" font-family="sans-serif" font-size="' + (w * 0.09) + '" font-weight="700" fill="rgba(255,255,255,.85)">' + label + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  const sampleBoards = SAMPLE ? [
    { id: 'b1', name: 'Poster ideas', items: [
      { id: 'i1', thumb: art(300, 400, '#C0392B', '#6C1D17', 'Bold red'), source: 'https://www.pinterest.com/pin/12345', title: 'Bold red concert poster with big serif type', addedAt: 1 },
      { id: 'i2', thumb: art(300, 220, '#1F6F8B', '#0B2A36', 'Teal'), source: 'https://dribbble.com/shots/998877', title: 'Teal gradient flyer', addedAt: 2 },
      { id: 'i3', thumb: art(300, 300, '#E0A526', '#8A5A06', 'Gold'), source: 'https://www.behance.net/gallery/55555', title: 'Gold lettering study for a recital programme and a very long title that has to wrap neatly', addedAt: 3 },
      { id: 'i4', thumb: art(300, 480, '#5F40CF', '#241D46', 'Violet'), source: 'https://unsplash.com/photos/abc', title: 'Violet stage lights', addedAt: 4 },
      { id: 'i5', thumb: art(300, 260, '#2E7D4F', '#0E3320', 'Green'), source: '', title: 'Saved from a page with no address', addedAt: 5 },
      { id: 'i6', thumb: art(300, 340, '#D35400', '#6A2A00', 'Orange'), source: 'https://www.instagram.com/p/xyz', title: 'Warm studio wall', addedAt: 6 },
    ] },
    { id: 'b2', name: 'Thumbnail looks', items: [
      { id: 'i7', thumb: art(320, 180, '#2A64CC', '#10285A', 'Face + text'), source: 'https://www.youtube.com/watch?v=abc', title: 'Close-up face with three words', addedAt: 7 },
      { id: 'i8', thumb: art(320, 180, '#B8336A', '#4B1230', 'Contrast'), source: 'https://www.youtube.com/watch?v=def', title: 'High contrast piano keys', addedAt: 8 },
    ] },
    { id: 'b3', name: 'Studio lighting', items: [] },
  ] : [];
  let nextId = 100;
  async function sample(cmd, a) {
    if (cmd === 'boards.list') return JSON.parse(JSON.stringify(sampleBoards));
    if (cmd === 'boards.create') { const b = { id: 'b' + (nextId++), name: a.name, items: [] }; sampleBoards.push(b); return b; }
    if (cmd === 'boards.rename') { const b = sampleBoards.find((x) => x.id === a.id); if (b) b.name = a.name; return true; }
    if (cmd === 'boards.delete') { const i = sampleBoards.findIndex((x) => x.id === a.id); if (i >= 0) sampleBoards.splice(i, 1); return true; }
    if (cmd === 'boards.removeItem') { const b = sampleBoards.find((x) => x.id === a.boardId); if (b) b.items = b.items.filter((x) => x.id !== a.itemId); return true; }
    if (cmd === 'open') { toast('Would open ' + a.url); return true; }
    return null;
  }
  const call = (cmd, args) => (window.cueInternal ? window.cueInternal.invoke(cmd, args || {}) : sample(cmd, args || {}));

  // ---- state ----
  let boards = [];
  let selected = null;
  let renaming = false;
  let confirmDelete = false;

  function siteName(url) {
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return ''; return u.hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }
  const current = () => boards.find((b) => b.id === selected) || null;

  async function load(preferId) {
    try { boards = (await call('boards.list')) || []; } catch (e) { boards = []; toast('Could not load your boards.'); }
    if (preferId && boards.some((b) => b.id === preferId)) selected = preferId;
    else if (!boards.some((b) => b.id === selected)) selected = boards.length ? boards[0].id : null;
    render();
  }

  function renderList() {
    const ul = $('blist'); ul.textContent = '';
    for (const b of boards) {
      const li = el('li'); const btn = el('button'); btn.type = 'button';
      btn.setAttribute('aria-current', b.id === selected ? 'true' : 'false');
      const st = el('span', 'stack');
      const first = (b.items || [])[0];
      if (first && first.thumb) { const im = el('img'); im.alt = ''; im.src = first.thumb; st.appendChild(im); } else st.textContent = '▢';
      btn.append(st, el('span', 'nm', b.name), el('span', 'ct', String((b.items || []).length)));
      btn.addEventListener('click', () => { selected = b.id; renaming = false; confirmDelete = false; render(); });
      li.appendChild(btn); ul.appendChild(li);
    }
  }

  function renderCard(board, it) {
    const card = el('article', 'card');
    const pic = el('button', 'pic'); pic.type = 'button';
    const site = siteName(it.source);
    pic.title = site ? 'Open the page this came from' : 'No source address saved';
    const im = el('img'); im.alt = it.title || 'Saved picture'; im.loading = 'lazy'; im.src = it.thumb || it.img || '';
    pic.appendChild(im);
    if (site) pic.addEventListener('click', () => open(it.source)); else pic.style.cursor = 'default';
    const meta = el('div', 'meta');
    if (it.title) meta.appendChild(el('div', 'ttl', it.title));
    const row = el('div', 'row');
    if (site) {
      const a = el('a', 'src', site); a.href = it.source; a.title = it.source;
      a.addEventListener('click', (e) => { e.preventDefault(); open(it.source); });
      row.appendChild(a);
    } else row.appendChild(el('span', 'nosrc', 'Source unknown'));
    const rm = el('button', 'btn small quiet', 'Remove'); rm.type = 'button'; rm.title = 'Take this picture off the board';
    rm.setAttribute('aria-label', 'Remove ' + (it.title || 'this picture') + ' from the board');
    rm.addEventListener('click', async () => {
      try { await call('boards.removeItem', { boardId: board.id, itemId: it.id }); toast('Removed from ' + board.name); } catch (e) { toast('Could not remove it.'); }
      load();
    });
    row.appendChild(rm); meta.appendChild(row);
    card.append(pic, meta);
    return card;
  }

  function renderMain() {
    const m = $('main'); m.textContent = '';
    const b = current();
    if (!boards.length) {
      const e = el('div', 'empty');
      e.append(el('b', null, 'No boards yet'), el('p', null, 'Make your first board with the New board button. Then right-click any picture on any website in Cue and choose Add to board.'));
      m.appendChild(e); return;
    }
    if (!b) return;
    const head = el('div', 'main-head');
    if (renaming) {
      const f = el('form'); f.style.display = 'flex'; f.style.gap = '6px';
      const inp = el('input'); inp.type = 'text'; inp.value = b.name; inp.maxLength = 80; inp.setAttribute('aria-label', 'Board name');
      const ok = el('button', 'btn primary small', 'Save'); ok.type = 'submit';
      const no = el('button', 'btn small', 'Cancel'); no.type = 'button';
      no.addEventListener('click', () => { renaming = false; render(); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { renaming = false; render(); } });
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); const name = inp.value.trim(); if (!name) return;
        try { await call('boards.rename', { id: b.id, name }); } catch (err) { toast('Could not rename the board.'); }
        renaming = false; load();
      });
      f.append(inp, ok, no); head.appendChild(f);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    } else {
      head.append(el('h2', 'title', b.name), el('span', 'count', (b.items || []).length === 1 ? '1 picture' : (b.items || []).length + ' pictures'));
    }
    head.appendChild(el('span', 'sp'));
    if (!renaming) {
      const rn = el('button', 'btn small', 'Rename'); rn.type = 'button';
      rn.addEventListener('click', () => { renaming = true; confirmDelete = false; render(); });
      const del = el('button', 'btn small danger', confirmDelete ? 'Yes, delete this board' : 'Delete board'); del.type = 'button';
      if (confirmDelete) del.classList.add('sure');
      del.addEventListener('click', async () => {
        if (!confirmDelete) { confirmDelete = true; render(); setTimeout(() => { if (confirmDelete) { confirmDelete = false; render(); } }, 5000); return; }
        confirmDelete = false;
        try { await call('boards.delete', { id: b.id }); toast('Deleted ' + b.name); } catch (e) { toast('Could not delete the board.'); }
        selected = null; load();
      });
      head.append(rn, del);
    }
    m.appendChild(head);
    const items = b.items || [];
    if (!items.length) {
      const e = el('div', 'empty');
      e.append(el('b', null, 'This board is empty'), el('p', null, 'Right-click any picture on a website in Cue and choose Add to board. It will appear here with the site it came from.'));
      m.appendChild(e); return;
    }
    const grid = el('div', 'grid');
    for (const it of items.slice().reverse()) grid.appendChild(renderCard(b, it));
    m.appendChild(grid);
  }

  function render() { renderList(); renderMain(); }

  async function open(url) { try { await call('open', { url }); } catch (e) { toast('Could not open that page.'); } }

  $('newBtn').addEventListener('click', () => {
    const f = $('newForm'); f.hidden = !f.hidden;
    if (!f.hidden) $('newName').focus();
  });
  $('newForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('newName').value.trim(); if (!name) return;
    const before = new Set(boards.map((b) => b.id));
    let made = null;
    try { made = await call('boards.create', { name }); } catch (err) { toast('Could not make the board.'); return; }
    $('newName').value = ''; $('newForm').hidden = true;
    renaming = false; confirmDelete = false;
    let id = made && typeof made === 'object' ? made.id : (typeof made === 'string' ? made : null);
    if (!id) { try { const fresh = (await call('boards.list')) || []; const f = fresh.find((b) => !before.has(b.id)); id = f && f.id; } catch (er) { /* ignore */ } }
    load(id);
  });
  $('newName').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('newForm').hidden = true; } });

  if (SAMPLE) $('sampleNote').hidden = false;
  load();
})();
