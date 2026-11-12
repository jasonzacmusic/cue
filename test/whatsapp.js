// WhatsApp test: CUE_TEST=whatsapp CUE_USER_DATA=<tmp> electron .
//
// WhatsApp Web cannot be logged into by a test, so this drives the real code against a stand-in
// page that copies the markup the code actually reaches for: #pane-side with chat rows,
// span[title] names, unread badges, #main with data-pre-plain-text stamps, the two contenteditable
// boxes. If WhatsApp ever changes those, this test keeps passing and the live thing breaks — so
// the checks that matter here are the ones about behaviour: the right account, the right chat,
// nothing reported as sent until it is seen in the conversation, and a plain refusal when the
// account is not linked.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`[cue-whatsapp] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };

// Personal holds sixty chats, so most of them are NOT drawn at first, as on the real page (WhatsApp
// only draws the rows in view). The ones that went wrong on 11-Nov-2026 sit far down the list:
// Parth and Priyanshu share a first letter and a suffix, and the unsaved number carries the
// invisible direction marks WhatsApp puts round a phone number.
const LTR = (s) => `\u202a${s}\u202c`;
const filler = Array.from({ length: 50 }, (_, i) => ({ name: `Student ${String(i + 1).padStart(2, '0')}`, when: '08:00', last: `Practice note ${i + 1}`, unread: 0 }));
const CHATS = {
  personal: [
    { name: 'Jatin', when: '14:03', last: 'Sending the files tonight', unread: 2 },
    { name: 'Mom', when: '12:40', last: 'Did you eat', unread: 0 },
    { name: 'Jatin Sharma', when: '09:15', last: 'Different person', unread: 0, twice: true, more: 'Second line' }, // twice: the name drawn again before the time, as an emoji name is; more: a preview over two lines
    ...filler.slice(0, 30),
    { name: 'Parth Ahire 🔍 Recruit NSM', when: 'Yesterday', last: 'Okay', unread: 0 },
    ...filler.slice(30),
    { name: 'Priyanshu Yadav 🔍 Recruit NSM', when: '15/10/2026', last: 'starting from Jan 1st', unread: 0 },
    { name: LTR('+91 85003 50600'), when: '7:16 pm', last: 'Voice call', unread: 0, call: true },
    { name: 'Trap', when: '01:00', last: 'This row opens the wrong chat', unread: 0, opens: 'Trapeze Artist' },
  ],
  school: [
    { name: 'Piano Batch 7', when: '18:00', last: 'See you Saturday', unread: 5 },
    { name: 'Geeth', when: '17:12', last: 'Sent the invoice', unread: 0 },
    // Send works here, but nothing ever shows up in the chat: the honest-failure case for files.
    { name: 'Black Hole', when: '01:00', last: 'Nothing arrives here', unread: 0 },
  ],
};

function page(which, { nosearch = false } = {}) {
  // WhatsApp shipped role=row in place of role=listitem (2-Nov-2026). The two accounts serve
  // one shape each, so a selector that only knows one of them fails this suite.
  const role = which === 'school' ? 'row' : 'listitem';
  return `<!doctype html><title>WhatsApp</title>
  <style>body{margin:0;font:13px system-ui}#side{width:300px;float:left}#main{margin-left:310px}
  #pane-side{height:400px;overflow-y:auto;position:relative}.r{position:absolute;left:0;right:0;height:56px;border-bottom:1px solid #222}</style>
  <div id="side"><input type="text" aria-label="Search or start a new chat" placeholder="Search or start a new chat"><div id="pane-side"><div id="spacer"></div></div></div>
  <div id="main" hidden>
    <header><div class="avatar"></div><div><span data-testid="conversation-info-header-chat-title" dir="auto"></span></div></header>
    <div id="thread"></div>
    <footer>${which === 'school'
    ? '<div role="button" title="Attach" id="att"><span data-icon="clip"></span></div>'
    : '<button aria-label="Attach" id="att"><span data-icon="plus-rounded"></span></button>'}<div contenteditable="true" id="compose"></div></footer>
  </div>
  <div id="menu"></div>
  <script>
    const ROLE = ${JSON.stringify(role)};
    const NOSEARCH = ${JSON.stringify(nosearch)};
    const data = ${JSON.stringify(CHATS[which])};
    const thread = {};
    data.forEach((c) => {
      thread[c.opens || c.name] = thread[c.opens || c.name] || [];
      thread[c.name] = c.call ? [{ call: '11 minutes' }] : [{ out: false, who: c.name, when: '14:03', text: c.last }];
    });
    thread['Trapeze Artist'] = [{ out: false, who: 'Trapeze Artist', when: '02:00', text: 'You are in the wrong chat' }];
    let current = '';
    // The real header, 11-Nov-2026: the avatar's letter is its FIRST line, and the name is a
    // span[dir=auto] whose emoji are pictures.
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const withPictures = (name) => esc(name).replace(/\\p{Extended_Pictographic}/gu, (e) => '<img alt="' + e + '">');
    function draw(name) {
      current = name;
      const main = document.getElementById('main');
      main.hidden = false;
      main.querySelector('.avatar').textContent = name.replace(/[^A-Za-z+]/g, '').charAt(0) || '?';
      main.querySelector('[data-testid]').innerHTML = withPictures(name);
      document.getElementById('thread').innerHTML = (thread[name] || []).map((m) => m.call
        ? '<div role="row"><span>Voice call</span><br><span>' + m.call + '</span><br><span>7:16 pm</span></div>'
        // A file bubble, as WhatsApp draws one: no data-pre-plain-text, the name (with its title)
        // on a document, only a picture on a photo, and the ticks of an outgoing message.
        : m.file ? '<div role="row"><div class="message-out"><span data-icon="tail-out"></span>' +
          (m.kind === 'media' ? '<img alt="" src="data:image/png;base64,iVBORw0KGgo=">' : '<div><span title="' + esc(m.file) + '">' + esc(m.file) + '</span><span>PDF • 1 page</span></div>') +
          (m.caption ? '<span class="selectable-text">' + esc(m.caption) + '</span>' : '') + '<span aria-label="Read"><span data-icon="msg-dblcheck"></span></span></div></div>'
        : '<div role="row">' +
          '<div data-pre-plain-text="[' + m.when + ', 2/11/2026] ' + (m.out ? 'You' : m.who) + ': "></div>' +
          '<span data-icon="' + (m.out ? 'tail-out' : 'tail-in') + '"></span>' +
          (m.out ? '<span aria-label="Read"></span>' : '') +
          '<span class="selectable-text">' + esc(m.text) + '</span></div>').join('');
    }
    // Only the rows in view are drawn, like WhatsApp: a row scrolled away is GONE from the page.
    const pane = document.getElementById('pane-side');
    const box = document.querySelector('#side input');
    let list = data.map((c) => ({ kind: 'chat', c }));
    function render() {
      const h = 56, top = pane.scrollTop, height = pane.clientHeight || 400;
      document.getElementById('spacer').style.height = (list.length * h) + 'px';
      [...pane.querySelectorAll('.r')].forEach((r) => r.remove());
      const from = Math.max(0, Math.floor(top / h) - 1), to = Math.min(list.length, Math.ceil((top + height) / h) + 1);
      for (let i = from; i < to; i++) {
        const it = list[i];
        const row = document.createElement('div');
        row.className = 'r'; row.setAttribute('role', ROLE); row.style.top = (i * h) + 'px';
        if (it.kind === 'head') row.innerHTML = '<div>' + it.text + '</div>';
        else {
          const c = it.c;
          const prev = c.more ? c.last + '\\n' + c.more : c.last;
          row.innerHTML = '<div role="gridcell"><div><span title="' + esc(c.name) + '">' + esc(c.name) + '</span></div>' + (c.twice ? '<div>' + esc(c.name) + '</div>' : '') + '<div>' + c.when + '</div>' +
            '<span title="' + esc(prev) + '">' + esc(c.last) + (c.more ? '<br>' + esc(c.more) : '') + '</span>' + (c.unread ? '<span aria-label="' + c.unread + ' unread messages">' + c.unread + '</span>' : '') + '</div>';
          row.dataset.name = c.name;
        }
        pane.appendChild(row);
      }
    }
    pane.addEventListener('scroll', render);
    render();
    pane.addEventListener('click', (e) => {
      const row = e.target.closest('[role=listitem], [role=row]');
      if (!row || !row.dataset.name) return;
      const c = data.find((x) => x.name === row.dataset.name);
      draw((c && c.opens) || row.dataset.name);
    });
    // The compose box behaves like WhatsApp's: Enter sends what is in it, and only then does
    // the message appear in the conversation.
    document.getElementById('compose').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      const text = (e.currentTarget.innerText || '').trim();
      if (!text) return;
      (thread[current] = thread[current] || []).push({ out: true, who: 'You', when: '14:05', text });
      e.currentTarget.innerText = '';
      draw(current);
    });
    // Search narrows the list into WhatsApp's own sections. ?nosearch is the 2-Nov-2026 page,
    // where the box took the words and never filtered.
    box.addEventListener('input', () => {
      if (NOSEARCH) return;
      const q = box.value.trim().toLowerCase();
      const digits = q.replace(/\\D/g, '');
      const hit = (c) => c.name.toLowerCase().includes(q) || (digits.length >= 6 && c.name.replace(/\\D/g, '').includes(digits));
      if (!q) list = data.map((c) => ({ kind: 'chat', c }));
      else {
        const found = data.filter(hit);
        list = found.length ? [{ kind: 'head', text: 'Chats' }, ...found.map((c) => ({ kind: 'chat', c }))] : [{ kind: 'head', text: 'No chats, contacts or messages found' }];
      }
      pane.scrollTop = 0;
      render();
    });
    // The attach menu, in two shapes: on Personal its Document and Photos & videos items each hold
    // a hidden file box; on School the box is only made when the item is clicked (the chooser).
    const menu = document.getElementById('menu');
    window.__sent = [];
    function preview(files, kind) {
      menu.innerHTML = '';
      const p = document.createElement('div'); p.id = 'preview'; p.dataset.testid = 'media-editor';
      p.innerHTML = '<div class="names">' + files.map((f) => '<span>' + esc(f.name) + '</span>').join('') + '</div>' +
        '<div contenteditable="true" aria-label="Add a caption"></div><div role="button" aria-label="Send"><span data-icon="send"></span></div>';
      document.body.appendChild(p);
      p.querySelector('[aria-label="Send"]').addEventListener('click', () => {
        const cap = (p.querySelector('[contenteditable]').innerText || '').trim();
        window.__sent.push({ kind, chat: current, names: files.map((f) => f.name), sizes: files.map((f) => f.size), caption: cap });
        p.remove();
        if (current === 'Black Hole') return;
        files.forEach((f, k) => (thread[current] = thread[current] || []).push({ out: true, file: f.name, kind, caption: k === files.length - 1 ? cap : '' }));
        draw(current);
      });
    }
    document.getElementById('att').addEventListener('click', () => {
      if (menu.innerHTML) { menu.innerHTML = ''; return; }
      const item = (label, icon, accept, kind) => ROLE === 'listitem'
        ? '<li role="button"><span data-icon="' + icon + '"></span><span>' + label + '</span>' + (accept ? '<input type="file" accept="' + accept + '" multiple style="display:none" data-kind="' + kind + '">' : '') + '</li>'
        : '<li role="button" data-kind="' + kind + '" data-accept="' + accept + '"><span data-icon="' + icon + '"></span><span>' + label + '</span></li>';
      menu.innerHTML = '<ul>' + item('Document', 'document-filled-refreshed', '*', 'document') + item('Photos &amp; videos', 'media-filled-refreshed', 'image/*,video/mp4,video/3gpp,video/quicktime', 'media') + item('Camera', 'camera', '', 'camera') + '</ul>';
      menu.querySelectorAll('input[type=file]').forEach((i) => i.addEventListener('change', () => preview([...i.files], i.dataset.kind)));
      if (ROLE === 'row') menu.querySelectorAll('li[data-accept]').forEach((li) => { if (li.dataset.accept) li.addEventListener('click', () => {
        const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.accept = li.dataset.accept;
        i.addEventListener('change', () => preview([...i.files], li.dataset.kind)); i.click();
      }); });
    });
    window.__seen = () => ({ vis: document.visibilityState, w: innerWidth });
  </script>`;
}

// Gmail's compose window, stand-in: "Attach files" makes its file box only when clicked (the
// chooser), each chip shows a progress bar while it "uploads", Send does nothing while one is
// still uploading (so sending too early fails the test), and a real send reaches the server.
const COMPOSE_JS = `
  function wire(root, subject, to) {
    const chips = root.querySelector('.chips'), saved = root.querySelector('.oG'), files = [];
    root.querySelector('[command="Files"]').addEventListener('click', () => {
      const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.name = 'Filedata';
      i.addEventListener('change', () => {
        for (const f of i.files) {
          files.push({ name: f.name, size: f.size });
          const c = document.createElement('div'); c.className = 'dL';
          c.innerHTML = '<div class="vI"></div><div class="vJ">(' + Math.ceil(f.size / 1024) + 'K)</div><div role="progressbar"></div>';
          c.querySelector('.vI').textContent = f.name; chips.appendChild(c);
          setTimeout(() => { c.querySelector('[role=progressbar]').remove(); saved.textContent = 'Draft saved'; }, 900);
        }
      });
      i.click();
    });
    root.querySelector('[aria-label^="Send"]').addEventListener('click', async () => {
      if (root.querySelector('[role=progressbar]')) return;
      await fetch('/gmail/send', { method: 'POST', body: JSON.stringify({ to: to(), subject: subject(), body: root.querySelector('[aria-label="Message Body"]').innerText, files }) });
      root.remove();
      const t = document.createElement('div'); t.setAttribute('role', 'alert'); t.textContent = 'Message sent'; document.body.appendChild(t);
    });
    root.addEventListener('input', () => setTimeout(() => { saved.textContent = 'Draft saved'; }, 400));
    setTimeout(() => { if (subject() || to()) saved.textContent = 'Draft saved'; }, 600);
  }`;
function composePage() {
  return `<!doctype html><title>Compose Mail - school@example.com - Gmail</title>
  <div role="dialog" id="cm"><input aria-label="To recipients" name="to"><input name="subjectbox">
    <div aria-label="Message Body" role="textbox" contenteditable="true"></div><div class="chips"></div>
    <div role="button" command="Files" aria-label="Attach files" data-tooltip="Attach files"></div>
    <div role="button" aria-label="Send ‪(⌘Enter)‬" data-tooltip="Send ‪(⌘Enter)‬">Send</div><span class="oG"></span></div>
  <script>${COMPOSE_JS}</script>
  <script>
    const q = new URLSearchParams(location.search), cm = document.getElementById('cm');
    cm.querySelector('[name=to]').value = q.get('to') || ''; cm.querySelector('[name=subjectbox]').value = q.get('su') || '';
    cm.querySelector('[aria-label="Message Body"]').innerText = q.get('body') || '';
    wire(cm, () => cm.querySelector('[name=subjectbox]').value, () => cm.querySelector('[name=to]').value);
  </script>`;
}

// A stand-in Gmail: fifty rows in the search shown now, and an older list still in the page but
// hidden, as Gmail keeps it. A thread of three messages, the middle one collapsed until
// "Expand all" is pressed.
function gmailPage() {
  const rows = (n, tag) => Array.from({ length: n }, (_, i) => `<tr class="zA ${i % 3 ? 'yO' : 'zE'}"><td><span email="s${i}@example.com" name="Sender ${i}">Sender ${i}</span></td>
    <td><span class="bog">${tag} subject ${i}</span><span class="y2"> - ${tag} snippet ${i}</span></td><td class="xW"><span title="Wed, Nov 11, 2026, ${i}:00 AM">${i}:00</span></td>
    <td><span data-legacy-thread-id="1a1af231${1000 + i}" data-legacy-last-non-draft-message-id="1a1b7777${1000 + i}"></span></td></tr>`).join('');
  return `<!doctype html><title>Inbox - school@example.com - Mail</title>
  <div id="old" style="display: none"><table>${rows(10, 'Old')}</table></div>
  <div id="list"></div>
  <div id="thread" style="display: none"><h2 class="hP">Paid maker internship</h2>
    <button aria-label="Expand all">Expand all</button>
    <div data-message-id="m1"><span class="gD" email="placements@example.edu" name="Placements">Placements</span><span class="g3" title="Fri, Nov 6, 2026, 10:04 AM">Nov 6</span><div class="a3s">First message body</div></div>
    <div data-message-id="m2" id="collapsed"><span class="gD" email="me@example.com" name="me">me</span><span class="g3" title="Sat, Nov 7, 2026">Nov 7</span><span class="iA">snippet only</span></div>
    <div data-message-id="m3"><span class="gD" email="placements@example.edu" name="Placements">Placements</span><span class="g3" title="Wed, Nov 11, 2026, 12:47 PM">12:47</span><div class="a3s">Please find attached the list of interested students</div></div>
    <span class="ams bkH" role="link">Reply</span>
  </div>
  <script>${COMPOSE_JS}</script>
  <script>
    const list = document.getElementById('list'), thread = document.getElementById('thread');
    const ROWS = ${JSON.stringify(rows(50, 'Found'))};
    const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // Reply: a reply box in the thread, with its own Attach files and Send.
    document.querySelector('.ams.bkH').addEventListener('click', () => {
      const r = document.createElement('div'); r.className = 'M9';
      r.innerHTML = '<div aria-label="Message Body" role="textbox" contenteditable="true"></div><div class="chips"></div><div role="button" command="Files" aria-label="Attach files" data-tooltip="Attach files"></div><div role="button" aria-label="Send ‪(⌘Enter)‬" data-tooltip="Send ‪(⌘Enter)‬">Send</div><span class="oG"></span>';
      thread.appendChild(r);
      wire(r, () => 'Re: Paid maker internship', () => 'placements@example.edu');
    });
    function route() {
      const h = location.hash;
      // The Sent folder, as the server saw it: what the stand-in really sent.
      if (h.startsWith('#search/') && /in(%3A|:)sent/i.test(h)) {
        document.title = 'Search results - school@example.com - Mail'; thread.style.display = 'none'; list.style.display = '';
        fetch('/gmail/sent.json').then((r) => r.json()).then((sent) => { list.innerHTML = '<table>' + sent.map((m, i) => '<tr class="zA yO"><td><span email="school@example.com" name="me">me</span></td><td><span class="bog">' + escH(m.subject) + '</span><span class="y2"> - ' + escH(m.body) + '</span></td><td class="xW"><span title="now">now</span></td><td><span data-legacy-thread-id="5e570000' + i + '" data-legacy-last-non-draft-message-id="5e571111' + i + '"></span></td></tr>').join('') + '</table>'; });
      } else if (h.startsWith('#search/')) { document.title = 'Search results - school@example.com - Mail'; thread.style.display = 'none'; list.style.display = ''; list.innerHTML = '<table>' + ROWS + '</table>'; }
      // Real Gmail would not open #all/<thread> for a thread just sent (11-Nov-2026); #inbox/ did.
      else if (h === '#all/1a1af2311000') { document.title = 'Search results - school@example.com - Mail'; }
      else if (h.startsWith('#all/') || h.startsWith('#inbox/')) { document.title = 'Paid maker internship - school@example.com - Mail'; list.style.display = 'none'; thread.style.display = ''; }
      else { document.title = 'Inbox - school@example.com - Mail'; list.innerHTML = ''; }
    }
    addEventListener('hashchange', route); route();
    document.querySelector('[aria-label="Expand all"]').addEventListener('click', () => {
      const c = document.getElementById('collapsed');
      if (!c.querySelector('.a3s')) c.insertAdjacentHTML('beforeend', '<div class="a3s">The collapsed message, now open</div>');
    });
  </script>`;
}

module.exports = async ({ app, agentApi, tabs, openTab, getState, userFolders, addFolder, command, setSetting }) => {
  let server;
  const gmailSent = [];
  try {
    // The owner's two folders, as an existing install has them: "jason" and "nathaniel" are their
    // names for agents, and both are open to agents. A fresh profile starts with one folder.
    if (!userFolders().some((f) => f.id === 'school')) addFolder({ id: 'school', name: 'School' });
    for (const id of ['personal', 'school']) command('folder.agents', { id, on: true });
    // Since 0.7 a fresh install hands nothing to agents; the owner's install hands over both.
    setSetting('agentSites.whatsapp', true); setSetting('agentSites.gmail', true);
    // One stand-in server, two pages: /personal is Jason's phone, /school is the school's,
    // /blank is an account nobody has scanned yet.
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/gmail/send') {
        let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { gmailSent.push(JSON.parse(b)); res.end('{}'); });
        return;
      }
      if (req.url === '/gmail/sent.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(gmailSent)); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url.startsWith('/gmail') && /[?&]view=cm\b/.test(req.url)) return res.end(composePage());
      if (req.url.startsWith('/gmail')) return res.end(gmailPage());
      const which = req.url.startsWith('/school') ? 'school' : req.url.startsWith('/blank') ? null : 'personal';
      res.end(which ? page(which, { nosearch: /nosearch/.test(req.url) }) : '<!doctype html><title>WhatsApp</title><h1>Scan the QR code with your phone’s camera</h1><p>Link with phone number instead.</p>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.CUE_WA_HOST = '127.0.0.1';
    process.env.CUE_WA_URL = `${base}/personal`;

    const jasonTab = openTab({ url: `${base}/personal`, identity: 'personal', background: true });
    openTab({ url: `${base}/school`, identity: 'school', background: true });
    await sleep(1500);

    const wa = (a) => agentApi.whatsapp(a);

    // ---- it will not guess whose phone to use
    let refused = '';
    try { await wa({ action: 'chats' }); } catch (e) { refused = e.message; }
    check('it refuses to act without being told whose account', /folder name/i.test(refused) && /Personal/.test(refused) && /School/.test(refused), refused.slice(0, 90));

    // ---- the two accounts stay apart
    const his = await wa({ who: 'jason', action: 'chats' });
    check('Jason’s chats are Jason’s', his.text.includes('Jatin') && !his.text.includes('Piano Batch 7'), his.text.split('\n')[1]);
    const theirs = await wa({ who: 'nathaniel', action: 'chats' });
    check('the school’s chats are the school’s', theirs.text.includes('Piano Batch 7') && !theirs.text.includes('Mom'), theirs.text.split('\n')[1]);
    // Every answer says the folder's own name, whichever word the agent used for it.
    check('each answer says which folder it came from', /^Personal ·/.test(his.text) && /^School ·/.test(theirs.text), [his.text.split('\n')[0], theirs.text.split('\n')[0]]);
    const byName = await wa({ who: 'School', action: 'chats' });
    check('a folder can be named by its own name too', /^School ·/.test(byName.text) && byName.text.includes('Piano Batch 7'));

    // ---- the answer is small
    check('a chat list costs a few lines, not a page', his.text.split('\n').every((l) => l.length < 90) && his.text.length < 1500, his.text.length);

    // ---- unread only
    const unread = await wa({ who: 'jason', action: 'chats', unreadOnly: true });
    check('unread only shows what is waiting', unread.text.includes('(2) Jatin') && !unread.text.includes('Mom'), unread.text);

    // ---- reading a conversation
    const read = await wa({ who: 'jason', action: 'read', chat: 'Jatin' });
    check('it reads the conversation asked for', /Jatin: Sending the files tonight/.test(read.text), read.text.slice(0, 80));

    // ---- exact names win over longer ones
    const exact = await wa({ who: 'jason', action: 'read', chat: 'Jatin' });
    check('an exact name is not confused with a longer one', !/Different person/.test(exact.text));

    // ---- sending, and only claiming it when it lands
    const sent = await wa({ who: 'jason', action: 'send', chat: 'Mom', message: 'Reached home, all good.' });
    check('it says who it sent as and to whom', /Sent on the WhatsApp in Personal's folder to Mom/.test(sent.text), sent.text);
    const after = await wa({ who: 'jason', action: 'read', chat: 'Mom' });
    check('the message is really in the conversation', /You: Reached home, all good\./.test(after.text), after.text.slice(-60));
    const school = await wa({ who: 'nathaniel', action: 'read', chat: 'Geeth' });
    check('it did not land on the other phone', !/Reached home/.test(school.text));

    // ---- a chat that is not there is said plainly, with near misses
    let missing = '';
    try { await wa({ who: 'jason', action: 'send', chat: 'Nobody At All', message: 'x' }); } catch (e) { missing = e.message; }
    check('an unknown chat is refused in plain words', /No chat called/.test(missing) && /Nearest/.test(missing), missing.slice(0, 80));

    // ---- finding a chat
    const found = await wa({ who: 'jason', action: 'search', query: 'jat' });
    check('search finds the chats it should', /Jatin/.test(found.text), found.text);

    // ---- 11-Nov-2026: the chats that went wrong on the real phone
    const boxOf = (t) => t.view.webContents.executeJavaScript('document.querySelector("#side input").value', true);
    const pri = await wa({ who: 'jason', action: 'read', chat: 'Priyanshu Yadav' });
    check('a chat far down the list opens (not drawn until scrolled to)', /^Personal · Priyanshu Yadav/.test(pri.text), pri.text.split('\n')[0]);
    check('Priyanshu never opens Parth, though the header starts with "P"', !/Parth/.test(pri.text) && /starting from Jan 1st/.test(pri.text), pri.text);
    const num = await wa({ who: 'jason', action: 'read', chat: '8500350600' });
    check('an unsaved number opens by its digits, through the invisible marks', /85003 50600/.test(num.text.split('\n')[0]), num.text.split('\n')[0]);
    check('a chat whose only history is a call says so', /Voice call/.test(num.text), num.text);
    check('the search box is empty after every call', (await boxOf(jasonTab)) === '');

    // A search somebody left behind narrows every list; Cue clears it first.
    await jasonTab.view.webContents.executeJavaScript(`(() => { const b = document.querySelector('#side input'); b.value = 'jatin'; b.dispatchEvent(new Event('input', { bubbles: true })); })()`, true);
    const full = await wa({ who: 'jason', action: 'chats', limit: 60 });
    check('a search left in the box does not hide the rest of the list', /· 57 chats/.test(full.text.split('\n')[0]), full.text.split('\n')[0]);
    const js = full.text.split('\n').find((l) => l.startsWith('Jatin Sharma')) || '';
    check('a chat list line has the time, not the name again', /^Jatin Sharma · 09:15 · /.test(js), js);
    check('a preview over two lines comes back on one line', /Different person Second line/.test(js) && full.text.split('\n').length === 58, { js, lines: full.text.split('\n').length });

    let wrong = '';
    try { await wa({ who: 'jason', action: 'read', chat: 'Trap' }); } catch (e) { wrong = e.message; }
    check('a click that opens the wrong chat fails loudly, and nothing is read', /opened “Trapeze Artist”/.test(wrong) && /Nothing was read/.test(wrong), wrong);
    let two = '';
    try { await wa({ who: 'jason', action: 'read', chat: 'Recruit NSM' }); } catch (e) { two = e.message; }
    check('half a name that fits two chats is a question, not a guess', /More than one chat/.test(two) && /Parth/.test(two) && /Priyanshu/.test(two), two);

    // Several jobs at once on one phone wait their turn; the two phones work side by side, and
    // neither is brought in front of him.
    const frontBefore = getState().activeId;
    const [a1, a2, a3, b1] = await Promise.all([
      wa({ who: 'jason', action: 'read', chat: 'Mom' }),
      wa({ who: 'jason', action: 'read', chat: 'Jatin Sharma' }),
      wa({ who: 'jason', action: 'read', chat: 'Priyanshu Yadav 🔍 Recruit NSM' }),
      wa({ who: 'nathaniel', action: 'read', chat: 'Geeth' }),
    ]);
    check('reads at the same time on one account each get their own chat',
      /^Personal · Mom/.test(a1.text) && /Did you eat/.test(a1.text) && /Different person/.test(a2.text) && /Jan 1st/.test(a3.text), [a1.text, a2.text, a3.text].map((t) => t.split('\n')[0]));
    check('the other account works at the same time', /^School · Geeth/.test(b1.text) && /invoice/.test(b1.text), b1.text);
    check('working in WhatsApp never brings a tab in front of him', getState().activeId === frontBefore, `${frontBefore} -> ${getState().activeId}`);
    const seen = await jasonTab.view.webContents.executeJavaScript('window.__seen()', true);
    check('the background WhatsApp tab is awake while an agent works in it', seen.vis === 'visible' && seen.w > 0, seen);

    // The search box ignored, as on 2-Nov-2026: walking the list still opens a far-down chat.
    jasonTab.view.webContents.loadURL(`${base}/personal?nosearch`);
    await sleep(1200);
    const walked = await wa({ who: 'jason', action: 'read', chat: 'Priyanshu Yadav' });
    check('with search dead, a far-down chat still opens by walking', /^Personal · Priyanshu Yadav/.test(walked.text) && /Jan 1st/.test(walked.text), walked.text.split('\n')[0]);
    jasonTab.view.webContents.loadURL(`${base}/personal`);
    await sleep(1200);

    // ---- files: documents and media, in both markups, and "sent" only when the bubbles are seen
    const fdir = path.join(process.env.CUE_OUT || os.tmpdir(), 'wa-files'); fs.mkdirSync(fdir, { recursive: true });
    const inv = path.join(fdir, 'Jolly invoice.pdf'); const rec = path.join(fdir, 'Jolly receipt.pdf'); const pic = path.join(fdir, 'chord chart.png');
    fs.writeFileSync(inv, '%PDF-1.4\n% invoice\n%%EOF\n'); fs.writeFileSync(rec, '%PDF-1.4\n% receipt\n%%EOF\n');
    fs.writeFileSync(pic, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const schoolWa = tabs.find((t) => t.identity === 'school' && String(t.url).includes('/school'));
    const sentIn = (t) => t.view.webContents.executeJavaScript('window.__sent', true);
    const pdfs = await wa({ who: 'jason', action: 'send', chat: 'Mom', files: [inv, rec], caption: 'Invoice and receipt' });
    check('files: two PDFs go to the chat asked for, as documents, with the caption', /^Sent on the WhatsApp in Personal's folder to Mom: 2 files, with the caption “Invoice and receipt”\./.test(pdfs.text) && (pdfs.text.match(/as a document/g) || []).length === 2, pdfs.text);
    const s1 = (await sentIn(jasonTab)).slice(-1)[0] || {};
    check('files: WhatsApp\'s Document box got both, and the caption (boxes in the menu)', s1.kind === 'document' && s1.chat === 'Mom' && s1.names.join('|') === 'Jolly invoice.pdf|Jolly receipt.pdf' && s1.caption === 'Invoice and receipt', s1);
    const bubbles = await jasonTab.view.webContents.executeJavaScript('[...document.querySelectorAll("#main [role=row] span[title]")].map((e) => e.title)', true);
    check('files: the document bubbles are in the conversation', bubbles.includes('Jolly invoice.pdf') && bubbles.includes('Jolly receipt.pdf'), bubbles);
    const photo = await wa({ who: 'jason', action: 'send', chat: 'Jatin', files: [pic] });
    const s2 = (await sentIn(jasonTab)).slice(-1)[0] || {};
    check('files: a picture goes as a photo, through Photos & videos', /to Jatin: 1 file\./.test(photo.text) && /as a photo/.test(photo.text) && s2.kind === 'media' && s2.chat === 'Jatin', [photo.text, s2]);
    const mixed = await wa({ who: 'nathaniel', action: 'send', chat: 'Geeth', files: [inv, pic], message: 'Both attached' });
    const s3 = (await sentIn(schoolWa)).slice(-2);
    check('files: the other markup (box made on click) takes a document and a photo in one call', /^Sent on the WhatsApp in School's folder to Geeth: 2 files, with the caption “Both attached”/.test(mixed.text), mixed.text);
    check('files: one round per kind, the words as the caption once', s3.length === 2 && s3[0].kind === 'document' && s3[0].names[0] === 'Jolly invoice.pdf' && s3[0].caption === 'Both attached' && s3[1].kind === 'media' && s3[1].caption === '', s3);
    const asDoc = await wa({ who: 'nathaniel', action: 'send', chat: 'Geeth', files: [pic], as: 'document' });
    const s4 = (await sentIn(schoolWa)).slice(-1)[0] || {};
    check('files: as:"document" sends a picture as a file', /as a document/.test(asDoc.text) && s4.kind === 'document', [asDoc.text, s4]);
    let lost = '';
    try { await wa({ who: 'nathaniel', action: 'send', chat: 'Black Hole', files: [inv] }); } catch (e) { lost = e.message; }
    const s5 = (await sentIn(schoolWa)).slice(-1)[0] || {};
    check('files: when the bubble never shows, it says so and never "sent"', /pressed Send to Black Hole but could not see the file arrive/.test(lost) && !/^Sent/.test(lost) && s5.chat === 'Black Hole', lost);
    let bad = '';
    const sentBefore = (await sentIn(jasonTab)).length;
    try { await wa({ who: 'jason', action: 'send', chat: 'Mom', files: ['/etc/hosts'] }); } catch (e) { bad = e.message; }
    check('files: a path Cue may not use is refused before WhatsApp is touched', /only attaches files from your home folder/.test(bad) && (await sentIn(jasonTab)).length === sentBefore, bad);
    let pdfMedia = '';
    try { await wa({ who: 'jason', action: 'send', chat: 'Mom', files: [inv], as: 'media' }); } catch (e) { pdfMedia = e.message; }
    check('files: a PDF asked to go as media is refused in words', /can only go as a document/.test(pdfMedia), pdfMedia);
    check('files: still never in front of him', getState().activeId === frontBefore, `${frontBefore} -> ${getState().activeId}`);

    // ---- Gmail: every row, and whole emails, in the agent's own tab
    process.env.CUE_GMAIL_URL = `${base}/gmail`;
    const hisMail = openTab({ url: `${base}/gmail#inbox`, identity: 'school', background: true });
    await sleep(800);
    const hisUrl = hisMail.view.webContents.getURL();
    const gs = await agentApi.gmail({ identity: 'school', action: 'search', query: 'internship' });
    const glines = gs.text.split('\n').filter((l) => /\[[0-9a-f]+\]$/.test(l));
    check('Gmail search returns every row, not just the first', glines.length === 25 && /Found subject 24/.test(gs.text), `${glines.length} rows`);
    const g50 = await agentApi.gmail({ identity: 'school', action: 'search', query: 'internship', limit: 50 });
    check('and up to fifty when asked, none from the hidden old list', g50.text.split('\n').filter((l) => /\]$/.test(l)).length === 50 && !/Old subject/.test(g50.text));
    check('the answer names the mailbox it came from', /school@example\.com/.test(gs.text.split('\n')[0]), gs.text.split('\n')[0]);
    check('his own Gmail tab is not moved by an agent search', hisMail.view.webContents.getURL() === hisUrl, hisMail.view.webContents.getURL());
    const id = (glines[0].match(/\[([0-9a-f]+)\]$/) || [])[1];
    const gr = await agentApi.gmail({ identity: 'school', action: 'read', id });
    check('search prints the newest message\'s id, which Gmail always opens', id === '1a1b77771000', id);
    const quirk = await agentApi.gmail({ identity: 'school', action: 'read', id: '1a1af2311000' });
    check('a thread Gmail will not open from #all/ is opened another way', /interested students/.test(quirk.text), quirk.text.slice(0, 120));
    check('reading an email gives every message in full, the collapsed one opened', /First message body/.test(gr.text) && /collapsed message, now open/.test(gr.text) && /interested students/.test(gr.text), gr.text.slice(0, 160));
    const agentMail = tabs.find((t) => t.agent && t.identity === 'school' && String(t.url).includes('/gmail'));
    const mailSeen = agentMail && await agentMail.view.webContents.executeJavaScript('({ vis: document.visibilityState, w: innerWidth })', true);
    check('the agent Gmail tab is awake while it works', mailSeen && mailSeen.vis === 'visible' && mailSeen.w > 0, mailSeen);
    const asleep = await hisMail.view.webContents.executeJavaScript('document.visibilityState', true);
    check('control: a background tab no agent touched stays asleep', asleep === 'hidden', asleep);

    // ---- Gmail: writing, with attachments. A draft unless send:true; sent only from Gmail's word.
    const gd = await agentApi.gmail({ identity: 'school', action: 'compose', to: 'jolly@example.com', subject: 'Your invoice', body: 'Hi Jolly,\nBoth attached.', files: [inv, rec] });
    check('Gmail compose leaves a draft with both files attached, and says so', /^Draft saved in School Gmail \(school@example\.com\): to jolly@example\.com, “Your invoice”, with 2 attachments: Jolly invoice\.pdf/.test(gd.text) && /Nothing was sent/.test(gd.text), gd.text);
    check('Gmail: a draft sends nothing', gmailSent.length === 0, gmailSent.length);
    const gsend = await agentApi.gmail({ identity: 'school', action: 'compose', to: 'jolly@example.com', subject: 'Your receipt', body: 'Receipt attached.', files: [rec, pic], send: true });
    const g0 = gmailSent[0] || {};
    check('Gmail send:true waits for the uploads, sends, and confirms from "Message sent" and Sent', /^Sent from School Gmail/.test(gsend.text) && /Message sent/.test(gsend.text) && /in Sent \[[0-9a-f]+\]/.test(gsend.text), gsend.text);
    check('Gmail: the server got that email with both files', g0.to === 'jolly@example.com' && g0.subject === 'Your receipt' && (g0.files || []).map((f) => f.name).join('|') === 'Jolly receipt.pdf|chord chart.png', g0);
    const greply = await agentApi.gmail({ identity: 'school', action: 'reply', id, body: 'Thanks, our list is attached.', files: [pic], send: true });
    const g1 = gmailSent[1] || {};
    check('Gmail reply sends in the thread, with the file', /^Sent from School Gmail.*a reply in “Paid maker internship”/.test(greply.text) && g1.subject === 'Re: Paid maker internship' && (g1.files || [])[0] && g1.files[0].name === 'chord chart.png' && /our list is attached/.test(g1.body), [greply.text, g1]);
    const gdraft = await agentApi.gmail({ identity: 'school', action: 'reply', id, body: 'A reply to think about.' });
    check('Gmail: a reply without send:true stays a draft', /^Draft saved/.test(gdraft.text) && gmailSent.length === 2, gdraft.text);
    let gwrong = '';
    try { await agentApi.gmail({ identity: 'school', action: 'search', query: 'x', files: [inv] }); } catch (e) { gwrong = e.message; }
    check('Gmail: files with search are refused in words', /Files go with action "compose" or "reply"/.test(gwrong), gwrong);
    let gpath = '';
    try { await agentApi.gmail({ identity: 'school', action: 'compose', to: 'a@b.co', subject: 'x', files: [path.join(os.homedir(), '.ssh', 'id_rsa')] }); } catch (e) { gpath = e.message; }
    check('Gmail: a guarded path is refused before Gmail is touched', /private keys/.test(gpath) && gmailSent.length === 2, gpath);
    check('Gmail: his own Gmail tab is still where he left it', hisMail.view.webContents.getURL() === hisUrl, hisMail.view.webContents.getURL());

    // ---- an account nobody has scanned
    process.env.CUE_WA_URL = `${base}/blank`;
    const blankTab = openTab({ url: `${base}/blank`, identity: 'agent', background: true });
    await sleep(800);
    // the agent login has no WhatsApp tab of its own in this rig, so point the school's at the
    // unlinked page to prove what the code says when the phone was never scanned.
    const schoolTab = tabs.find((t) => t.identity === 'school' && String(t.url).includes('/school'));
    schoolTab.view.webContents.loadURL(`${base}/blank`);
    await sleep(1200);
    let unlinked = '';
    try { await wa({ who: 'nathaniel', action: 'chats' }); } catch (e) { unlinked = e.message; }
    check('an unlinked account says so, and says what to do', /not linked/.test(unlinked) && /scan/i.test(unlinked), unlinked.slice(0, 90));
    const status = await wa({ who: 'nathaniel', action: 'status' });
    check('status reports it too', /not linked/.test(status.text), status.text);
    if (blankTab) { /* left open; the rig throws the window away at the end */ }

    // ---- the one site he handed over, and nothing else
    const mayAct = (url, identity) => agentApi.canAct({ id: 999, url, identity, private: false });
    // The address comes from the same place the app reads it, so this still checks the real
    // rule rather than a copy of it that the stand-in host would quietly falsify.
    const waUrl = `${base}/personal`;
    check('agents may work in his linked WhatsApp tab', mayAct(waUrl, 'personal') && mayAct(waUrl, 'school'));
    // Gmail is handed over too, by the same Settings switch (0.6.x), so the "nothing else" is a shop.
    check('and in nothing else of his', !mayAct('https://www.amazon.in/gp/cart/view.html', 'personal') && !mayAct(waUrl, 'vanish'));

    // ---- opening a site he already has open must not build a twin beside it
    const before = tabs.length;
    const again = agentApi.open({ url: `${base}/personal`, identity: 'personal' });
    check('opening his WhatsApp again goes to the tab he already has',
      again.id === jasonTab.id && tabs.length === before, `${again.id} vs ${jasonTab.id}, ${tabs.length} tabs`);

    // but it must never drag his tab off the page he left it on
    const elsewhere = agentApi.open({ url: `${base}/blank`, identity: 'personal' });
    check('a different page gets its own tab, his stays put',
      elsewhere.id !== jasonTab.id && jasonTab.url === `${base}/personal`, jasonTab.url);

    // ---- a folder whose only WhatsApp tab is private: refused, and no second WhatsApp is opened
    process.env.CUE_WA_URL = `${base}/personal`;
    // Every Personal tab on the stand-in host counts as a WhatsApp tab here, so all of them go private.
    const standIns = tabs.filter((t) => t.identity === 'personal' && String(t.url).startsWith(base));
    standIns.forEach((t) => { t.private = true; });
    const count = tabs.length;
    let priv = '';
    try { await wa({ who: 'jason', action: 'chats' }); } catch (e) { priv = e.message; }
    check('a private WhatsApp tab is refused in words, not worked round', /private/.test(priv) && /second WhatsApp/.test(priv), priv);
    check('and no second WhatsApp tab was opened beside it', tabs.length === count, `${count} -> ${tabs.length}`);
    standIns.forEach((t) => { t.private = false; });
    const again2 = await wa({ who: 'jason', action: 'chats' });
    check('control: the same tab works again once it is not private', /^Personal ·/.test(again2.text));
    // ---- a folder the person has not opened to agents is not reachable at all
    command('folder.agents', { id: 'school', on: false });
    let closed = '';
    try { await wa({ who: 'nathaniel', action: 'chats' }); } catch (e) { closed = e.message; }
    check('a folder not open to agents is refused, by name', /School's folder is not open to AI agents/.test(closed), closed);
    command('folder.agents', { id: 'school', on: true });

    // ---- the deliberate failure, so a silent pass is never mistaken for a run
    check('control: a failing check is visible (expected FAIL below)', false, 'this one is meant to fail');
  } catch (e) {
    check('the suite ran to the end', false, e.message);
  } finally {
    const pass = results.filter((r) => r.ok).length;
    console.log(`[cue-whatsapp] DONE ${pass}/${results.length} passed (1 deliberate failure expected)`);
    if (server) server.close();
    setTimeout(() => app.exit(0), 300);
  }
};
