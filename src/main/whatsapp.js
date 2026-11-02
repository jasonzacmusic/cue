// WhatsApp, done properly for the people who work here — Jason, Claude, Codex, any agent.
//
// WHY THIS EXISTS. Driving WhatsApp through a general browser tool costs a screenshot or a
// snapshot of three hundred elements for every step, and WhatsApp's own markup is a wall of
// generated class names. So every job below is ONE piece of JavaScript in the tab that is
// already open and already linked, and it answers in short lines of plain text rather than a
// page of JSON. Listing the chats costs about as much as this comment.
//
// WHICH TAB. Jason keeps WhatsApp pinned in Personal and in School. These tools use those very
// tabs, in the background, without taking his window. The two accounts never mix: every call
// names one, and the name is checked against the tab's login before anything is sent.
// The real address, always, outside the test rig: the two variables exist so test/whatsapp.js
// can point the same code at a stand-in page that copies WhatsApp's markup.
const WA = () => process.env.CUE_WA_URL || 'https://web.whatsapp.com/';
const WA_HOST = () => process.env.CUE_WA_HOST || 'web.whatsapp.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "jason" is the personal phone, "nathaniel" is the school's. Spell it any of these ways.
const WHO = {
  jason: 'personal', personal: 'personal', me: 'personal', mine: 'personal',
  nathaniel: 'school', school: 'school', nsm: 'school', work: 'school', business: 'school',
};
function whoOf(name) {
  const key = String(name || '').trim().toLowerCase();
  const id = WHO[key];
  if (!id) throw new Error('Say whose WhatsApp: "jason" (his own number) or "nathaniel" (the school\'s).');
  return id;
}
const label = (identity) => (identity === 'personal' ? 'Jason' : 'Nathaniel');

// The same normalising the page scripts do, for the comparisons that happen out here: WhatsApp's
// header text drops emoji, so "Manoj 💼 Crio Recruitment" and "Manoj  Crio Recruitment" are one
// chat spelled two ways.
const plainName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const sameChat = (a, b) => {
  const x = plainName(a), y = plainName(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
};

// ---------------------------------------------------------------- page scripts
// All of these run inside the WhatsApp tab. They return plain data, never HTML.

// WhatsApp draws nothing until it is linked to a phone; the chat list is the proof.
const LINKED = `(() => {
  if (document.querySelector('#pane-side')) return 'ready';
  const t = (document.body ? document.body.innerText : '') || '';
  if (/scan the qr code|link with phone number|steps to log in/i.test(t)) return 'unlinked';
  if (/loading|starting|syncing/i.test(t)) return 'loading';
  return 'unknown';
})()`;

const FIRE = `const fire = (el) => {
  // detail:1 says "one real click", and the hover pair comes first because a chat row only arms
  // its handler once the pointer is over it: on 2-Nov-2026 a plain .click(), and a focus followed
  // by Enter, both left the chat closed, while this sequence opened it.
  const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 1 };
  for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const E = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new E(type, o));
  }
};`;

// One row of the chat list. The name carries a title attribute, which survives WhatsApp's
// redesigns; everything else is read off the row's own text, bottom to top.
// WhatsApp renamed the chat rows from role=listitem to role=row (seen 2-Nov-2026). Both are
// listed so the code keeps working whichever markup the page ships that week.
const ROW_READER = `const readRow = (row) => {
  const titled = [...row.querySelectorAll('span[title]')];
  const name = (titled[0] && (titled[0].getAttribute('title') || titled[0].innerText) || '').trim();
  const lines = (row.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  const unreadEl = row.querySelector('[aria-label*="unread" i]');
  const badge = unreadEl ? (unreadEl.innerText || unreadEl.getAttribute('aria-label') || '').match(/\\d+/) : null;
  const when = lines[1] || '';
  const last = (titled[1] && (titled[1].getAttribute('title') || titled[1].innerText) || lines.slice(2).join(' ') || '').trim();
  return { name, when, last: last.slice(0, 120), unread: badge ? Number(badge[0]) : (unreadEl ? 1 : 0) };
};
const visibleRows = () => [...document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]')]
  .filter((r) => r.offsetParent !== null);`;

// Every chat, not just the ones drawn right now. WhatsApp only renders the rows in view, so the
// pane is scrolled to the bottom and back, collecting names as they appear. This is what the
// search action uses, because WhatsApp's own search cannot be driven from a script (see SEARCH).
const WALK_ROWS = (cap) => `(async () => {
  ${ROW_READER}
  const pane = document.querySelector('#pane-side');
  if (!pane) return [];
  const seen = new Map();
  const grab = () => { for (const row of visibleRows()) { const r = readRow(row); if (r.name && !seen.has(r.name)) seen.set(r.name, r); } };
  const was = pane.scrollTop;
  pane.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 250));
  grab();
  let before = -1;
  for (let i = 0; i < 60 && seen.size !== before && seen.size < ${Number(cap) || 400}; i++) {
    before = seen.size;
    pane.scrollTop = pane.scrollTop + Math.max(300, pane.clientHeight - 100);
    await new Promise((r) => setTimeout(r, 350));
    grab();
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 5) { await new Promise((r) => setTimeout(r, 450)); grab(); break; }
  }
  pane.scrollTop = was;
  return [...seen.values()];
})()`;

const ROWS = `(() => {
  ${ROW_READER}
  const rows = visibleRows();
  return rows.slice(0, 60).map(readRow).filter((r) => r.name);
})()`;

// The open conversation. data-pre-plain-text is WhatsApp's own "[time, date] Name:" stamp, which
// is the cheapest honest source for who said what and when - and, since WhatsApp dropped the
// .message-in / .message-out classes (checked live 2-Nov-2026: zero matches, while
// [data-pre-plain-text] matched every message), it is now the anchor for finding messages at all.
//
// Direction takes three tries, because no single mark is on every message he sent (all measured
// live 2-Nov-2026 against a 27-message conversation):
//   - aria-label "You:" is on most of his rows, but not all of them;
//   - a delivery state - "Read", "Delivered", "Sent", "Pending" - appears on his and only his,
//     and covers the ones with no "You:" at all;
//   - tail-out, and the msg-check ticks, catch what is left.
// One message of the 27 had only the delivery state, so reading "You:" alone called it hers.
//
// A reply that QUOTES him carries his words inside her row, which is how the same sentence can
// appear twice and the second copy be attributed to the wrong person. The quoted block announces
// itself with aria-label "Quoted message", so it is lifted out before the text is read.
const READ = (limit) => `(() => {
  ${CHAT_NAME_FN}
  const chat = CHAT_NAME();
  const stamps = [...document.querySelectorAll('#main [data-pre-plain-text]')].slice(-${Number(limit) || 20});
  const out = stamps.map((stamp) => {
    const n = stamp.closest('[role="row"]') || stamp.parentElement || stamp;
    const meta = stamp.getAttribute('data-pre-plain-text') || '';
    const m = meta.match(/^\\[([^,\\]]+)[^\\]]*\\]\\s*(.*?):\\s*$/);
    const icons = [...n.querySelectorAll('[data-icon]')].map((e) => e.getAttribute('data-icon') || '');
    const labels = [...n.querySelectorAll('[aria-label]')].map((e) => (e.getAttribute('aria-label') || '').trim());
    const mine = labels.some((l) => /^you:/i.test(l))
      || labels.some((l) => /^(read|delivered|sent|pending)$/i.test(l))
      || icons.some((i) => i === 'tail-out' || /^msg-(check|dblcheck|time)/.test(i));
    // Drop any quoted message first, so his words quoted back at him are not read as hers.
    const quoted = [...n.querySelectorAll('[aria-label="Quoted message"]')];
    const skip = (el) => quoted.some((q) => q.contains(el));
    const bodies = [...n.querySelectorAll('.selectable-text')].filter((el) => !skip(el));
    const body = bodies[bodies.length - 1] || null;
    let text = (body ? body.innerText : n.innerText || '').trim();
    if (!text) {
      const kind = icons.find((i) => i && !/^tail-/.test(i) && !/^msg-/.test(i));
      text = kind ? '(' + kind.replace(/-/g, ' ') + ')' : '(no text)';
    }
    return { out: mine, when: m ? m[1] : '', who: m ? m[2] : '', text: text.replace(/\\s+/g, ' ').slice(0, 400) };
  });
  return { chat, messages: out };
})()`;

// Put words into a contenteditable the way a person would. WhatsApp's editor only believes
// execCommand; assigning textContent leaves the Send button grey and the message unsent.
const PUT = (text) => `(() => {
  const box = document.querySelector('#main footer div[contenteditable="true"]');
  if (!box) return 'no-box';
  box.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, ${JSON.stringify(text)});
  return (box.innerText || '').trim().length ? 'ok' : 'empty';
})()`;

// Press Send. WhatsApp shows the button as soon as there are words in the box; where there is
// no button, Enter in the box is what sends, so that is the fallback.
const SEND_IT = `(() => {
  ${FIRE}
  const btn = document.querySelector('#main footer [data-icon="send"], #main footer [aria-label="Send"], #main footer button[aria-label*="Send" i]');
  if (btn) { fire(btn.closest('button') || btn); return 'button'; }
  const box = document.querySelector('#main footer div[contenteditable="true"]');
  if (!box) return 'no-box';
  box.focus();
  for (const type of ['keydown', 'keypress', 'keyup']) {
    box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
  }
  return 'enter';
})()`;

// WHATSAPP'S OWN SEARCH CANNOT BE DRIVEN FROM A SCRIPT. The box is easy to find - it is a real
// <input aria-label="Search or start a new chat"> now, not the old contenteditable div - and the
// text goes in: box.value reads back what was typed and the box has focus. WhatsApp still never
// filters. Measured on the live page 2-Nov-2026: fourteen different terms each left the list at
// all 26 rows, unfiltered and identical. Three ways of typing were tried and all three failed -
// the native value setter followed by an 'input' event, a per-character run of keydown,
// beforeinput, input and keyup with InputEvent and inputType, and execCommand('insertText') on
// the focused input.
//
// This mattered more than a missing selector, because a search that quietly returns everything
// cannot be caught by a control search: the control passes too, and the answer looks right. So
// nothing here asks WhatsApp to search any more. Cue walks its own chat list and filters it
// itself - see WALK_ROWS - and the box is left alone.

// Click the row for a chat. Matching is exact first, then "starts with", then "contains", so
// "Jatin" never lands on "Jatin's Parents" while an exact match exists.
//
// The click is dispatched in the page, not sent as a mouse event at x,y: these tabs sit in the
// background with no geometry on screen, and a pointer aimed at a tab nobody can see hits
// nothing. A full pointer-and-mouse sequence is what React listens for.
const CLICK_ROW = (name) => `(async () => {
  ${FIRE}
  ${SAME_NAME_FN}
  ${CHAT_NAME_FN}
  const want = ${JSON.stringify(String(name).trim().toLowerCase())};
  const rows = [...document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]')]
    .filter((r) => r.offsetParent !== null);
  const named = rows.map((row) => {
    const t = row.querySelector('span[title]');
    return { row, name: ((t && (t.getAttribute('title') || t.innerText)) || '').trim() };
  }).filter((r) => r.name);
  const low = (s) => s.toLowerCase();
  const hit = named.find((r) => low(r.name) === want)
    || named.find((r) => low(r.name).startsWith(want))
    || named.find((r) => low(r.name).includes(want));
  if (!hit) return { found: false, offered: named.slice(0, 8).map((r) => r.name) };
  // The row's gridcell ignores a click; the div that carries the name takes it (measured on the
  // live page 2-Nov-2026). The gridcell, then the row itself, stay behind it as fallbacks.
  const titled = hit.row.querySelector('span[title]');
  const el = (titled && titled.closest('div')) || hit.row.querySelector('[role="gridcell"]') || hit.row;
  el.scrollIntoView({ block: 'center' });
  fire(el);
  // Then CONFIRM, because a click on the chat list is not a promise. On 2-Nov-2026 a click aimed
  // at a Satish row opened a large broadcast list instead: the list had re-rendered under it. The
  // header is the only honest answer to "which chat am I in", so it is read back, and a mismatch
  // is reported rather than passed off as success - reading, or worse writing, in the wrong chat.
  const opened = await (async () => {
    for (let i = 0; i < 24; i++) {
      const n = CHAT_NAME();
      if (n && sameName(n, hit.name)) return n;
      await new Promise((r) => setTimeout(r, 250));
    }
    return CHAT_NAME();
  })();
  if (!sameName(opened, hit.name)) return { found: true, name: hit.name, opened, mismatch: true };
  return { found: true, name: hit.name, opened };
})()`;

// Which conversation is open. WhatsApp took the title attribute off the conversation header
// (checked live 2-Nov-2026: zero span[title] in #main header, while the name was plainly the
// header's first line of text). On a group the old selector was worse than useless - it answered
// with the entire member list, hundreds of numbers long. The first line of the header is what a
// person reads as the name, so that is what this reads, with the old selector kept behind it.
// Comparing two spellings of the same chat. innerText drops emoji, so the row's
// "Manoj (briefcase) Crio Recruitment" reaches the header as "Manoj  Crio Recruitment" with a gap
// where the emoji was - which is why comparing a prefix of one against the other failed on every
// chat with an emoji in its name (checked live 2-Nov-2026). Keep letters, digits and single
// spaces, drop everything else, and the two spellings meet.
const SAME_NAME_FN = `const plain = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\\s+/g, ' ').trim();
const sameName = (a, b) => {
  const x = plain(a), y = plain(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
};`;

const CHAT_NAME_FN = `const CHAT_NAME = () => {
  const h = document.querySelector('#main header');
  if (!h) return '';
  const titled = h.querySelector('span[title]');
  const t = titled ? (titled.getAttribute('title') || '').trim() : '';
  // A member list, not a name: commas and a pile of numbers.
  if (t && !(t.split(',').length > 3)) return t;
  return ((h.innerText || '').split('\\n')[0] || '').trim();
};`;

const OPEN_CHAT_NAME = `(() => {
  ${CHAT_NAME_FN}
  return CHAT_NAME();
})()`;

// ---------------------------------------------------------------- the engine
function makeWhatsApp({ tabs, openTab, ensureView, hostOf, activate, programId }) {
  // Never the tab a class is looking at, and never a private one.
  const onAir = () => (typeof programId === 'function' ? programId() : programId);
  const tabFor = (identity) => tabs.find((t) => t.identity === identity && hostOf(t.url) === WA_HOST()
    && !t.private && t.id !== onAir());

  async function wcFor(identity) {
    let t = tabFor(identity);
    if (!t) t = openTab({ url: WA(), identity, background: true, agent: true });
    ensureView(t);
    const wc = t.view.webContents;
    if (hostOf(wc.getURL()) !== WA_HOST()) await wc.loadURL(WA()).catch(() => {});
    const end = Date.now() + 20000;
    while (wc.isLoading() && Date.now() < end) await sleep(100);
    return { tab: t, wc };
  }

  const js = (wc, script) => wc.executeJavaScript(script, true);

  async function ready(identity) {
    const { tab, wc } = await wcFor(identity);
    let state = await js(wc, LINKED);
    if (state === 'loading' || state === 'unknown') {
      const end = Date.now() + 15000;
      while (Date.now() < end && state !== 'ready' && state !== 'unlinked') { await sleep(500); state = await js(wc, LINKED); }
    }
    if (state !== 'ready') {
      throw new Error(`${label(identity)}'s WhatsApp is not linked in Cue yet. Jason opens the pinned WhatsApp tab in ${identity === 'personal' ? 'Personal' : 'School'} once and scans the code with that phone; after that it stays linked and nobody has to touch it again.`);
    }
    return { tab, wc };
  }

  async function openChat(wc, name, identity) {
    const want = String(name || '').trim();
    if (!want) throw new Error('Name the chat to open.');
    const already = await js(wc, OPEN_CHAT_NAME);
    if (sameChat(already, want)) return already;

    let hit = await js(wc, CLICK_ROW(want));
    if (!hit.found) {
      // Not among the rows WhatsApp has drawn. Walking the list scrolls the rest into existence,
      // which is the only way left to reach a chat far down it now that search is a dead end.
      await js(wc, WALK_ROWS(400));
      hit = await js(wc, CLICK_ROW(want));
    }
    if (!hit.found) {
      // Say what IS there, by name, so the mistake is obvious: a typo, or the wrong account.
      const all = await js(wc, WALK_ROWS(400));
      const near = all.map((r) => r.name).filter((n) => sameChat(n, want)).slice(0, 5);
      const some = (near.length ? near : all.slice(0, 5).map((r) => r.name));
      throw new Error(`No chat called “${want}” on ${label(identity)}'s WhatsApp, among ${all.length} chat${all.length === 1 ? '' : 's'}.${some.length ? ` Nearest: ${some.join(', ')}.` : ''}`);
    }
    // The click already waited for the header and reported what actually opened. Trust that, and
    // insist on the whole name: matching the first twelve characters would accept "Satish Rao" for
    // "Satish Kumar", and reading, or writing, in the wrong chat is the one failure that matters.
    if (hit.mismatch) {
      throw new Error(`Cue clicked “${hit.name}” but WhatsApp opened “${hit.opened || 'nothing'}” instead. Nothing was read or sent.`);
    }
    return hit.opened || hit.name;
  }

  // ---- the five things anyone actually wants
  const actions = {
    async chats({ identity, unreadOnly, limit }) {
      const { wc } = await ready(identity);
      let rows = await js(wc, WALK_ROWS(400));
      if (!rows.length) rows = await js(wc, ROWS);
      if (unreadOnly) rows = rows.filter((r) => r.unread > 0);
      rows = rows.slice(0, Math.min(Number(limit) || 15, 60));
      if (!rows.length) return { text: unreadOnly ? `${label(identity)}: nothing unread.` : `${label(identity)}: no chats on screen yet.` };
      const lines = rows.map((r) => `${r.unread ? `(${r.unread}) ` : ''}${r.name}${r.when ? ` · ${r.when}` : ''}${r.last ? ` · ${r.last}` : ''}`);
      return { text: `${label(identity)} · ${rows.length} chat${rows.length === 1 ? '' : 's'}\n${lines.join('\n')}` };
    },

    async read({ identity, chat, limit }) {
      const { wc } = await ready(identity);
      const name = await openChat(wc, chat, identity);
      const { messages } = await js(wc, READ(limit));
      if (!messages.length) return { text: `${label(identity)} · ${name}: no messages yet.` };
      const lines = messages.map((m) => `${m.when ? m.when + ' ' : ''}${m.out ? 'You' : (m.who || name)}: ${m.text}`);
      return { text: `${label(identity)} · ${name}\n${lines.join('\n')}` };
    },

    async send({ identity, chat, message }) {
      const body = String(message || '').trim();
      if (!body) throw new Error('There is nothing to send.');
      const { wc } = await ready(identity);
      const name = await openChat(wc, chat, identity);
      const put = await js(wc, PUT(body));
      if (put !== 'ok') throw new Error('Cue could not put the words in WhatsApp\'s box, so nothing was sent.');
      await sleep(120);
      const how = await js(wc, SEND_IT);
      if (how === 'no-box') throw new Error('WhatsApp\'s message box disappeared before Cue could send.');
      // Never report a send we have not seen land in the conversation.
      const want = body.replace(/\s+/g, ' ').slice(0, 60);
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        await sleep(300);
        const { messages } = await js(wc, READ(4));
        const mine = messages.filter((m) => m.out).pop();
        if (mine && mine.text.replace(/\s+/g, ' ').startsWith(want.slice(0, Math.min(want.length, 40)))) {
          return { text: `Sent on ${label(identity)}'s WhatsApp to ${name}: ${want}${body.length > 60 ? '…' : ''}` };
        }
      }
      throw new Error(`Cue typed the message to ${name} but could not see it sent. Look at the WhatsApp tab in ${identity === 'personal' ? 'Personal' : 'School'} before sending it again.`);
    },

    // Cue's own search over Cue's own list. It looks at every chat's NAME and the one line of
    // last message the list shows - not the whole conversation, which only WhatsApp's own search
    // could reach and which cannot be driven from a script. That limit is said out loud in the
    // answer, because a search that quietly looks at less than you think is the whole reason this
    // was rewritten.
    async search({ identity, query }) {
      const { wc } = await ready(identity);
      const q = String(query || '').trim();
      if (!q) throw new Error('Say what to look for.');
      const all = await js(wc, WALK_ROWS(400));
      if (!all.length) return { text: `${label(identity)}: no chats to look through yet.` };
      const needle = plainName(q);
      const hits = all.filter((r) => plainName(r.name).includes(needle) || plainName(r.last).includes(needle));
      const scope = `Looked at ${all.length} chat${all.length === 1 ? '' : 's'} by name and last message only, not inside the conversations.`;
      if (!hits.length) return { text: `${label(identity)}: nothing matches “${q}”. ${scope}` };
      const lines = hits.slice(0, 15).map((r) => `${r.unread ? `(${r.unread}) ` : ''}${r.name}${r.last ? ` · ${r.last}` : ''}`);
      return { text: `${label(identity)} · ${hits.length} match${hits.length === 1 ? '' : 'es'} for “${q}”\n${lines.join('\n')}\n${scope}` };
    },

    // Only for the one-time link, and when something looks wrong: this is the single action
    // that is allowed to put the tab in front of him.
    async status({ identity, show }) {
      const { tab, wc } = await wcFor(identity);
      const state = await js(wc, LINKED);
      if (show && activate) activate(tab.id);
      const said = state === 'ready' ? 'linked and ready'
        : state === 'unlinked' ? 'not linked — scan the code in that tab once with the phone'
        : 'still loading';
      return { text: `${label(identity)}'s WhatsApp: ${said}.`, state, tabId: tab.id };
    },
  };

  // One door for every agent. The account is named in words, never assumed.
  return async function whatsapp(a = {}) {
    const action = String(a.action || 'chats').toLowerCase();
    if (!actions[action]) throw new Error(`WhatsApp can do: ${Object.keys(actions).join(', ')}.`);
    const identity = whoOf(a.who || a.account || a.identity);
    return actions[action]({ ...a, identity });
  };
}

module.exports = { makeWhatsApp, WHO, WA_HOST };
