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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`[cue-whatsapp] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };

const CHATS = {
  personal: [
    { name: 'Jatin', when: '14:03', last: 'Sending the files tonight', unread: 2 },
    { name: 'Mom', when: '12:40', last: 'Did you eat', unread: 0 },
    { name: 'Jatin Sharma', when: '09:15', last: 'Different person', unread: 0 },
  ],
  school: [
    { name: 'Piano Batch 7', when: '18:00', last: 'See you Saturday', unread: 5 },
    { name: 'Geeth', when: '17:12', last: 'Sent the invoice', unread: 0 },
  ],
};

function page(which) {
  // WhatsApp shipped role=row in place of role=listitem (2-Nov-2026). The two accounts serve
  // one shape each, so a selector that only knows one of them fails this suite.
  const role = which === 'school' ? 'row' : 'listitem';
  const rows = CHATS[which].map((c) => `
    <div role="${role}"><div role="gridcell" style="height:56px">
      <span title="${c.name}">${c.name}</span>
      <div>${c.when}</div>
      <span title="${c.last}">${c.last}</span>
      ${c.unread ? `<span aria-label="${c.unread} unread messages">${c.unread}</span>` : ''}
    </div></div>`).join('');
  return `<!doctype html><title>WhatsApp</title>
  <style>body{margin:0;font:13px system-ui}#pane-side{width:300px;float:left}#main{margin-left:310px}
  [role=gridcell]{border-bottom:1px solid #222;padding:6px}</style>
  <div id="side"><div contenteditable="true" id="search"></div><div id="pane-side">${rows}</div></div>
  <div id="main" hidden>
    <header><span title=""></span></header>
    <div id="thread"></div>
    <footer><div contenteditable="true" id="compose"></div></footer>
  </div>
  <script>
    const data = ${JSON.stringify(CHATS[which])};
    const thread = {};
    data.forEach((c) => { thread[c.name] = [{ out: false, who: c.name, when: '14:03', text: c.last }]; });
    function draw(name) {
      const main = document.getElementById('main');
      main.hidden = false;
      main.querySelector('header span').setAttribute('title', name);
      document.getElementById('thread').innerHTML = (thread[name] || []).map((m) =>
        '<div class="' + (m.out ? 'message-out' : 'message-in') + '">' +
        '<div data-pre-plain-text="[' + m.when + ', 2/11/2026] ' + (m.out ? 'You' : m.who) + ': "></div>' +
        '<span class="selectable-text">' + m.text + '</span></div>').join('');
    }
    document.getElementById('pane-side').addEventListener('click', (e) => {
      const row = e.target.closest('[role=listitem], [role=row]');
      if (row) draw(row.querySelector('span[title]').getAttribute('title'));
    });
    // The compose box behaves like WhatsApp's: Enter sends what is in it, and only then does
    // the message appear in the conversation.
    document.getElementById('compose').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      const box = e.currentTarget;
      const text = (box.innerText || '').trim();
      if (!text) return;
      const name = document.querySelector('#main header span[title]').getAttribute('title');
      (thread[name] = thread[name] || []).push({ out: true, who: 'You', when: '14:05', text });
      box.innerText = '';
      draw(name);
    });
    // Searching narrows the list, as WhatsApp's does.
    document.getElementById('search').addEventListener('input', (e) => {
      const q = (e.currentTarget.innerText || '').trim().toLowerCase();
      for (const row of document.querySelectorAll('#pane-side [role=listitem], #pane-side [role=row]')) {
        const n = row.querySelector('span[title]').getAttribute('title').toLowerCase();
        row.style.display = !q || n.includes(q) ? '' : 'none';
      }
    });
  </script>`;
}

module.exports = async ({ app, agentApi, tabs, openTab }) => {
  let server;
  try {
    // One stand-in server, two pages: /personal is Jason's phone, /school is the school's,
    // /blank is an account nobody has scanned yet.
    server = http.createServer((req, res) => {
      const which = req.url.startsWith('/school') ? 'school' : req.url.startsWith('/blank') ? null : 'personal';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(which ? page(which) : '<!doctype html><title>WhatsApp</title><h1>Scan the QR code with your phone’s camera</h1><p>Link with phone number instead.</p>');
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
    check('it refuses to act without being told whose account', /jason|nathaniel/i.test(refused), refused.slice(0, 60));

    // ---- the two accounts stay apart
    const his = await wa({ who: 'jason', action: 'chats' });
    check('Jason’s chats are Jason’s', his.text.includes('Jatin') && !his.text.includes('Piano Batch 7'), his.text.split('\n')[1]);
    const theirs = await wa({ who: 'nathaniel', action: 'chats' });
    check('the school’s chats are the school’s', theirs.text.includes('Piano Batch 7') && !theirs.text.includes('Mom'), theirs.text.split('\n')[1]);
    check('each answer says which phone it came from', /^Jason ·/.test(his.text) && /^Nathaniel ·/.test(theirs.text));

    // ---- the answer is small
    check('a chat list costs a few lines, not a page', his.text.length < 400, his.text.length);

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
    check('it says who it sent as and to whom', /Sent on Jason's WhatsApp to Mom/.test(sent.text), sent.text);
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
    check('and in nothing else of his', !mayAct('https://mail.google.com/', 'personal') && !mayAct(waUrl, 'vanish'));

    // ---- opening a site he already has open must not build a twin beside it
    const before = tabs.length;
    const again = agentApi.open({ url: `${base}/personal`, identity: 'personal' });
    check('opening his WhatsApp again goes to the tab he already has',
      again.id === jasonTab.id && tabs.length === before, `${again.id} vs ${jasonTab.id}, ${tabs.length} tabs`);

    // but it must never drag his tab off the page he left it on
    const elsewhere = agentApi.open({ url: `${base}/blank`, identity: 'personal' });
    check('a different page gets its own tab, his stays put',
      elsewhere.id !== jasonTab.id && jasonTab.url === `${base}/personal`, jasonTab.url);

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
