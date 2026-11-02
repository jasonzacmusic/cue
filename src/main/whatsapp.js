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
  const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const E = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new E(type, o));
  }
};`;

// One row of the chat list. The name carries a title attribute, which survives WhatsApp's
// redesigns; everything else is read off the row's own text, bottom to top.
// WhatsApp renamed the chat rows from role=listitem to role=row (seen 2-Nov-2026). Both are
// listed so the code keeps working whichever markup the page ships that week.
const ROWS = `(() => {
  const rows = [...document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]')].filter((r) => r.offsetParent !== null);
  return rows.slice(0, 60).map((row) => {
    const titled = [...row.querySelectorAll('span[title]')];
    const name = (titled[0] && (titled[0].getAttribute('title') || titled[0].innerText) || '').trim();
    const lines = (row.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    const unreadEl = row.querySelector('[aria-label*="unread" i]');
    const badge = unreadEl ? (unreadEl.innerText || unreadEl.getAttribute('aria-label') || '').match(/\\d+/) : null;
    const when = lines[1] || '';
    const last = (titled[1] && (titled[1].getAttribute('title') || titled[1].innerText) || lines.slice(2).join(' ') || '').trim();
    return { name, when, last: last.slice(0, 120), unread: badge ? Number(badge[0]) : (unreadEl ? 1 : 0) };
  }).filter((r) => r.name);
})()`;

// The open conversation. data-pre-plain-text is WhatsApp's own "[time, date] Name:" stamp, which
// is the cheapest honest source for who said what and when.
const READ = (limit) => `(() => {
  const head = document.querySelector('#main header span[title]');
  const chat = head ? (head.getAttribute('title') || head.innerText || '').trim() : '';
  const nodes = [...document.querySelectorAll('#main .message-in, #main .message-out')].slice(-${Number(limit) || 20});
  const out = nodes.map((n) => {
    const stamp = n.querySelector('[data-pre-plain-text]');
    const meta = stamp ? stamp.getAttribute('data-pre-plain-text') : '';
    const m = meta.match(/^\\[([^,\\]]+)[^\\]]*\\]\\s*(.*?):\\s*$/);
    const body = n.querySelector('.selectable-text');
    let text = (body ? body.innerText : n.innerText || '').trim();
    if (!text) {
      const kind = n.querySelector('[data-icon]');
      text = kind ? '(' + kind.getAttribute('data-icon').replace(/-/g, ' ') + ')' : '(no text)';
    }
    return { out: n.classList.contains('message-out'), when: m ? m[1] : '', who: m ? m[2] : '', text: text.replace(/\\s+/g, ' ').slice(0, 400) };
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

const SEARCH = (q) => `(() => {
  const box = document.querySelector('#side div[contenteditable="true"]');
  if (!box) return 'no-box';
  box.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, ${JSON.stringify(q)});
  return 'ok';
})()`;

const CLEAR_SEARCH = `(() => {
  const box = document.querySelector('#side div[contenteditable="true"]');
  if (box) { box.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); box.blur(); }
  return 'ok';
})()`;

// Click the row for a chat. Matching is exact first, then "starts with", then "contains", so
// "Jatin" never lands on "Jatin's Parents" while an exact match exists.
//
// The click is dispatched in the page, not sent as a mouse event at x,y: these tabs sit in the
// background with no geometry on screen, and a pointer aimed at a tab nobody can see hits
// nothing. A full pointer-and-mouse sequence is what React listens for.
const CLICK_ROW = (name) => `(() => {
  ${FIRE}
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
  const el = hit.row.querySelector('[role="gridcell"]') || hit.row;
  el.scrollIntoView({ block: 'center' });
  fire(el);
  return { found: true, name: hit.name };
})()`;

const OPEN_CHAT_NAME = `(() => {
  const h = document.querySelector('#main header span[title]');
  return h ? (h.getAttribute('title') || h.innerText || '').trim() : '';
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
    if (already && already.toLowerCase() === want.toLowerCase()) return already;

    let hit = await js(wc, CLICK_ROW(want));
    if (!hit.found) {
      // Not on screen: ask WhatsApp's own search, which also finds chats far down the list.
      if ((await js(wc, SEARCH(want))) !== 'ok') throw new Error('WhatsApp\'s search box is not there. The page may still be loading.');
      const end = Date.now() + 6000;
      while (Date.now() < end) { await sleep(300); hit = await js(wc, CLICK_ROW(want)); if (hit.found) break; }
    }
    if (!hit.found) {
      // Say what IS there. After a search that found nothing the list is empty, so put it back
      // before looking, or the message would helpfully offer no names at all.
      await js(wc, CLEAR_SEARCH);
      await sleep(500);
      const near = (await js(wc, ROWS)).slice(0, 5).map((r) => r.name);
      throw new Error(`No chat called “${want}” on ${label(identity)}'s WhatsApp.${near.length ? ` Nearest: ${near.join(', ')}.` : ''}`);
    }
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const open = await js(wc, OPEN_CHAT_NAME);
      if (open && open.toLowerCase().includes(hit.name.toLowerCase().slice(0, 12))) { await js(wc, CLEAR_SEARCH); return open; }
      await sleep(250);
    }
    await js(wc, CLEAR_SEARCH);
    throw new Error(`Cue clicked “${hit.name}” but WhatsApp did not open it.`);
  }

  // ---- the five things anyone actually wants
  const actions = {
    async chats({ identity, unreadOnly, limit }) {
      const { wc } = await ready(identity);
      let rows = await js(wc, ROWS);
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

    async search({ identity, query }) {
      const { wc } = await ready(identity);
      const q = String(query || '').trim();
      if (!q) throw new Error('Say what to look for.');
      if ((await js(wc, SEARCH(q))) !== 'ok') throw new Error('WhatsApp\'s search box is not there yet.');
      await sleep(900);
      const rows = await js(wc, ROWS);
      await js(wc, CLEAR_SEARCH);
      if (!rows.length) return { text: `${label(identity)}: nothing matches “${q}”.` };
      return { text: `${label(identity)} · matches for “${q}”\n${rows.slice(0, 10).map((r) => r.name).join('\n')}` };
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
