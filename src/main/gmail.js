// Gmail, in one call, for the agents. Same idea as whatsapp.js: one piece of JavaScript in a tab
// that is already signed in, and an answer in a few plain lines instead of a page of markup.
//
// WHY THIS EXISTS. On 11-Nov-2026 a search in a background Gmail tab came back with ONE readable
// row: the page held all fifty rows, but a tab nobody is looking at has no size, so innerText of
// every row but the first was empty. Gmail's own text is still in the page (textContent), and that
// is what is read here - every row, and every message of a thread - while the tab is woken up for
// the length of the call (see wake() in main.js) so Gmail draws what it needs to.
//
// WHICH TAB. Never Jason's own inbox: searching there would move the page he is reading. Each folder
// gets ONE agent Gmail tab of its own, in the background, signed in as that folder's account.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// No /u/0/ in the address: Cue adds the folder's own account (?authuser=), so Personal's search
// never lands in the school's mailbox (googleForFolder in main.js).
const BASE = () => process.env.CUE_GMAIL_URL || 'https://mail.google.com/mail/';

// Rows of the list Gmail is showing now. Gmail keeps the lists it showed before in the page,
// hidden with display:none, so only rows with no hidden ancestor count.
const ROWS = (limit) => `(() => {
  const shown = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) { if (n.style && n.style.display === 'none') return false; if (n.hidden) return false; } return true; };
  const rows = [...document.querySelectorAll('tr.zA')].filter(shown).slice(0, ${Number(limit) || 50});
  const text = (el) => (el ? (el.textContent || '') : '').replace(/\\s+/g, ' ').trim();
  const out = rows.map((row) => {
    const people = [...row.querySelectorAll('[email]')].map((e) => (e.getAttribute('name') || e.textContent || '').trim() + (e.getAttribute('email') ? ' <' + e.getAttribute('email') + '>' : ''));
    const when = row.querySelector('td.xW span[title], .xW span[title]');
    // The id printed is the newest message's, not the thread's: Gmail opens #all/<message> every
    // time, but would not open #all/<thread> for a thread he had just sent himself (11-Nov-2026).
    const tid = row.querySelector('[data-legacy-last-non-draft-message-id], [data-legacy-last-message-id], [data-legacy-thread-id]');
    return {
      id: tid ? (tid.getAttribute('data-legacy-last-non-draft-message-id') || tid.getAttribute('data-legacy-last-message-id') || tid.getAttribute('data-legacy-thread-id')) : '',
      unread: row.classList.contains('zE'),
      from: [...new Set(people)].slice(0, 3).join(', '),
      subject: text(row.querySelector('.bog')),
      snippet: text(row.querySelector('.y2')).replace(/^[-–\\s]+/, '').slice(0, 160),
      when: when ? (when.getAttribute('title') || text(when)) : '',
    };
  });
  const none = /no messages matched your search|no conversations|your search did not match/i.test(document.body.textContent || '');
  const counter = [...document.querySelectorAll('.Dj, [aria-label*="Show more messages" i]')].filter(shown).map(text).find(Boolean) || '';
  return { rows: out, none, counter };
})()`;

// One thread, every message in it. Collapsed messages are expanded first ("Expand all"), because
// a collapsed message in Gmail holds a snippet, not the message.
const THREAD = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shown = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) { if (n.style && n.style.display === 'none') return false; } return true; };
  const fire = (el) => { for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, detail: 1 })); };
  const all = [...document.querySelectorAll('[aria-label="Expand all"], [data-tooltip="Expand all"]')].filter(shown)[0];
  if (all) { fire(all); await sleep(1200); }
  const text = (el) => (el ? (el.innerText && el.innerText.trim() ? el.innerText : el.textContent || '') : '').replace(/\\u200c/g, '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
  const subject = [...document.querySelectorAll('h2.hP')].filter(shown).map((h) => (h.textContent || '').trim())[0] || '';
  const msgs = [...document.querySelectorAll('[data-message-id]')].filter(shown).filter((m) => m.querySelector('.gD, .a3s, .iA'));
  const out = msgs.map((m) => {
    const from = m.querySelector('.gD');
    const when = m.querySelector('.g3');
    const to = [...m.querySelectorAll('.g2')].map((e) => (e.getAttribute('name') || e.textContent || '').trim()).filter(Boolean);
    const body = m.querySelector('.a3s');
    const snippet = m.querySelector('.iA');
    return {
      from: from ? ((from.getAttribute('name') || from.textContent || '').trim() + (from.getAttribute('email') ? ' <' + from.getAttribute('email') + '>' : '')) : '',
      to: to.slice(0, 6).join(', '),
      when: when ? (when.getAttribute('title') || (when.textContent || '').trim()) : '',
      body: body ? text(body) : (snippet ? '(collapsed) ' + text(snippet) : ''),
    };
  });
  return { subject, messages: out };
})()`;

function makeGmail({ agentTab, wake, label }) {
  const js = (wc, script) => wc.executeJavaScript(script, true);
  const who = (identity) => {
    const id = String(identity || '').toLowerCase();
    if (id === 'personal' || id === 'jason' || id === 'me') return 'personal';
    if (id === 'school' || id === 'nathaniel' || id === 'nsm') return 'school';
    throw new Error('Say whose Gmail: "personal" (Jason\'s own) or "school" (the school\'s).');
  };

  // Go to an address inside Gmail and wait for it to be the page shown. A change of the part after
  // # is Gmail's own navigation, so it is quick and keeps the inbox loaded.
  async function go(identity, hash) {
    const t = agentTab(identity, BASE() + '#inbox');
    const wc = t.view.webContents;
    const end = Date.now() + 30000;
    while (wc.isLoading() && Date.now() < end) await sleep(150);
    await wake(t);
    if (/accounts\.google\.com/.test(wc.getURL())) {
      throw new Error(`The ${label(identity)} folder is not signed in to Gmail in Cue. Jason signs in once in that folder; nothing was searched.`);
    }
    // Same page, new place: Gmail answers a change after the # without reloading.
    await js(wc, `if (location.hash !== ${JSON.stringify(hash)}) location.hash = ${JSON.stringify(hash)}; true`).catch(() => {});
    return { t, wc };
  }
  // Gmail puts the mailbox's address in the page title, which proves which account answered.
  const mailbox = (wc) => ((wc.getTitle() || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [''])[0];

  const actions = {
    async search({ identity, query, limit }) {
      const q = String(query || '').trim();
      if (!q) throw new Error('Say what to search for, in Gmail\'s own words if you like (from:, subject:, newer_than:7d).');
      const max = Math.min(Number(limit) || 25, 50);
      const { wc } = await go(identity, `#search/${encodeURIComponent(q).replace(/%20/g, '+')}`);
      // Wait for THIS search's rows: the title Gmail gives a search page, and rows (or "no messages").
      let got = { rows: [], none: false };
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        await sleep(400);
        const onSearch = /search results/i.test(wc.getTitle()) || /#search\//.test(wc.getURL());
        got = await js(wc, ROWS(max)).catch(() => got);
        if (onSearch && (got.rows.length || got.none)) { await sleep(500); got = await js(wc, ROWS(max)); break; }
      }
      if (!got.rows.length) return { text: `${label(identity)} Gmail: nothing found for “${q}”.` };
      const lines = got.rows.map((r) => `${r.unread ? '• ' : ''}${r.when} · ${r.from} · ${r.subject}${r.snippet ? ' — ' + r.snippet : ''} [${r.id}]`);
      return { text: `${label(identity)} Gmail${mailbox(wc) ? ' (' + mailbox(wc) + ')' : ''} · ${got.rows.length} for “${q}”${got.counter ? ` (Gmail says ${got.counter})` : ''}\n${lines.join('\n')}\nRead one with action:"read" and its [id]. Reading marks it read, as opening it would.` };
    },

    async read({ identity, id }) {
      const thread = String(id || '').trim();
      if (!/^[0-9a-f]{8,}$/i.test(thread)) throw new Error('Pass the [id] that search printed for the email.');
      // #all/ first; if Gmail does not answer it, #inbox/ and then #sent/, which it sometimes takes instead.
      let got = { messages: [] }, wc;
      for (const [place, wait] of [['all', 9000], ['inbox', 6000], ['sent', 6000]]) {
        ({ wc } = await go(identity, `#${place}/${thread}`));
        const end = Date.now() + wait;
        while (Date.now() < end) {
          await sleep(500);
          got = await js(wc, THREAD).catch(() => got);
          if (got.messages.length && got.messages.some((m) => m.body)) break;
        }
        if (got.messages.length) break;
      }
      if (!got.messages.length) throw new Error(`Gmail did not open that email (${thread}) in the ${label(identity)} folder. Nothing was read.`);
      const parts = got.messages.map((m) => `— ${m.when} · ${m.from}${m.to ? ' → ' + m.to : ''}\n${m.body.slice(0, 6000)}`);
      return { text: `${label(identity)} Gmail${mailbox(wc) ? ' (' + mailbox(wc) + ')' : ''} · ${got.subject || '(no subject)'} · ${got.messages.length} message${got.messages.length === 1 ? '' : 's'}\n${parts.join('\n\n')}` };
    },
  };

  // One job at a time per folder: each folder has one agent Gmail tab, showing one page.
  const queues = new Map();
  return async function gmail(a = {}) {
    const action = String(a.action || 'search').toLowerCase();
    if (!actions[action]) throw new Error(`Gmail can do: ${Object.keys(actions).join(', ')}.`);
    const identity = who(a.identity || a.who || a.account);
    const prev = queues.get(identity) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => actions[action]({ ...a, identity }));
    queues.set(identity, next.catch(() => {}));
    return next;
  };
}

module.exports = { makeGmail };
