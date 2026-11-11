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

// The same comparison the page scripts make (NAME_FN below), for the checks that happen out here.
// Two spellings of one chat meet once everything but letters and digits is gone: the list keeps
// emoji as text, the header shows them as pictures, and unsaved numbers carry WhatsApp's invisible
// direction marks (U+202A ... U+202C) around "+91 85003 50600".
//
// EXACT, NEVER A PREFIX. On 11-Nov-2026 the header of Parth's chat read "P" (the avatar's letter)
// as its first line, and "Priyanshu Yadav" starts with "P", so a read for Priyanshu returned
// Parth's messages without a word of warning. A name is the same name only when all of it matches,
// or, for a phone number, when the digits match (with or without the country code).
const flatName = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
const digitsOf = (s) => String(s || '').replace(/\D+/g, '');
// A phone number is what is left when the name is only digits, spaces, dashes, brackets and a plus.
const isPhone = (s) => /^[\s\u200e\u200f\u202a-\u202e+()\-.\d]+$/.test(String(s || '')) && digitsOf(s).length >= 8;
const samePhone = (a, b) => {
  const x = digitsOf(a), y = digitsOf(b);
  if (x.length < 8 || y.length < 8) return false;
  return x === y || (x.length > y.length ? x.endsWith(y) : y.endsWith(x)) && Math.min(x.length, y.length) >= 10;
};
const sameChat = (a, b) => {
  if (isPhone(a) && isPhone(b)) return samePhone(a, b);
  const x = flatName(a), y = flatName(b);
  return !!x && x === y;
};
// Kept for search, where "jat" finding "Jatin" is the point.
const plainName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

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
  // The time is the line that looks like one. Taking the second line used to print the name twice
  // on a chat whose name holds emoji, because the emoji split the name across two lines.
  const WHEN = /^(\\d{1,2}[:.]\\d{2}\\s*([ap]\\.?m\\.?)?|yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})$/i;
  const when = lines.slice(1, 5).find((l) => WHEN.test(l)) || '';
  const last = (titled[1] && (titled[1].getAttribute('title') || titled[1].innerText) || lines.slice(2).join(' ') || '').replace(/\\s+/g, ' ').trim();
  return { name, when, last: last.slice(0, 120), unread: badge ? Number(badge[0]) : (unreadEl ? 1 : 0) };
};
const visibleRows = () => [...document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]')]
  .filter((r) => r.offsetParent !== null);
// Say "it scrolled" out loud. A tab that is off screen gets no scroll events of its own, because
// Chromium sends them with the next frame and a hidden tab draws no frames - so WhatsApp never drew
// the rows further down, and a walk of the school's list saw 5 chats (11-Nov-2026).
const nudge = () => { const p = document.querySelector('#pane-side'); if (p) p.dispatchEvent(new Event('scroll')); };`;

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
  pane.scrollTop = 0; nudge();
  await new Promise((r) => setTimeout(r, 250));
  grab();
  // A tab that has only just woken draws its rows late, so one step with nothing new is not the
  // end of the list: three in a row is (the school's first call after a restart saw 15 of 40).
  let stale = 0;
  for (let i = 0; i < 80 && stale < 3 && seen.size < ${Number(cap) || 400}; i++) {
    const before = seen.size;
    pane.scrollTop = pane.scrollTop + Math.max(300, pane.clientHeight - 100); nudge();
    await new Promise((r) => setTimeout(r, 350 + stale * 300));
    grab();
    stale = seen.size === before ? stale + 1 : 0;
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 5) { await new Promise((r) => setTimeout(r, 450)); grab(); break; }
  }
  pane.scrollTop = was; nudge();
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
  // Every row of the conversation, in order: messages carry the stamp, and the rest - a voice call,
  // a missed call, a deleted message - are rows without one. A chat whose only history is an
  // 11-minute call used to read back as "no messages yet" (11-Nov-2026, +91 85003 50600).
  const stamps = [...document.querySelectorAll('#main [data-pre-plain-text]')];
  const events = [...document.querySelectorAll('#main [role="row"]')].filter((r) => !r.querySelector('[data-pre-plain-text]')
    && (r.innerText || '').trim() && !/end-to-end encrypted/i.test(r.innerText || ''));
  const units = [...stamps, ...events].sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1)).slice(-${Number(limit) || 20});
  const out = units.map((unit) => {
    const stamp = unit.matches('[data-pre-plain-text]') ? unit : null;
    if (!stamp) {
      const said = (unit.innerText || '').split('\\n').map((l) => l.trim()).filter(Boolean).join(' · ');
      return { out: false, event: true, when: '', who: '', text: '(' + said.slice(0, 200) + ')', full: '' };
    }
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
    // full: every letter and digit in the row, nothing else. Used only to prove a send landed,
    // because the shown text can start with a link preview's title or be cut short.
    const full = (n.innerText || '').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '');
    return { out: mine, when: m ? m[1] : '', who: m ? m[2] : '', text: text.replace(/\\s+/g, ' ').slice(0, 400), full };
  });
  return { chat, messages: out };
})()`;

// Put words into WhatsApp's box with every line break kept. execCommand('insertText') with the
// whole message drops the newlines (measured 3-Nov-2026: "...2e4276b0" and "Please" arrived glued
// together), so the words go in as a paste, which WhatsApp's editor turns into real lines exactly
// as it does when a person pastes. If the paste does not take, it types line by line with a line
// break between. The box is waited for, because right after a chat opens it is not there yet,
// and that race was the "could not put the words" failure.
const PUT = (text) => `(async () => {
  const want = ${JSON.stringify(text)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let box = null;
  for (let i = 0; i < 30 && !box; i++) {
    box = document.querySelector('#main footer div[contenteditable="true"]');
    if (!box) await sleep(100);
  }
  if (!box) return 'no-box';
  // Words already waiting in the box are somebody's draft - often his own dictation. Never wipe them.
  if ((box.innerText || '').trim()) return 'draft';
  const lines = want.split('\\n');
  const plain = (s) => s.toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '');
  // Emptying the box: WhatsApp's editor ignores execCommand('delete') once text was pasted, but
  // honours a delete announced as beforeinput over a selection of the whole box (live 4-Nov-2026).
  const clear = async () => {
    box.focus();
    const sel = getSelection();
    for (let i = 0; i < 2 && (box.innerText || '').trim(); i++) {
      sel.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(box); sel.addRange(r);
      if (i) document.execCommand('delete', false, null);
      else box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
      await sleep(80);
    }
  };
  const good = () => {
    const got = box.innerText || '';
    if (plain(got) !== plain(want)) return false;
    return got.split('\\n').filter((l) => l.trim()).length >= lines.filter((l) => l.trim()).length;
  };
  await clear();
  const dt = new DataTransfer();
  dt.setData('text/plain', want);
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await sleep(150);
  if (good()) return 'ok';
  await clear();
  lines.forEach((line, k) => {
    // Never a synthetic Enter here: in WhatsApp's box an Enter that loses its Shift sends.
    if (k) document.execCommand('insertLineBreak', false, null);
    if (line) document.execCommand('insertText', false, line);
  });
  await sleep(150);
  if (good()) return 'ok';
  await clear();
  return 'mangled';
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

// WHATSAPP'S OWN SEARCH. On 2-Nov-2026 the box took text and never filtered, whatever way it was
// typed into, so Cue stopped using it. On 11-Nov-2026 it filters again: the native value setter
// followed by an 'input' event narrows the list to "Chats", "Contacts", "Messages" and "Groups in
// common" sections, which reaches every chat, not just the ones drawn on screen, and finds unsaved
// numbers too. A search that quietly returns everything would still be the worst failure here, so
// it is only trusted when WhatsApp answers with its section headings (or says nothing was found);
// otherwise Cue falls back to walking its own list, as before.
//
// Whatever is typed is ALWAYS taken out again afterwards (CLEAR_SEARCH, in a finally). On
// 11-Nov-2026 the box was found still holding "crio" from an earlier job, so every later list saw
// 24 chats instead of 400.
const SEARCH_BOX = `document.querySelector('#side input[type="text"]') || document.querySelector('input[aria-label*="Search" i][type="text"]')
  || document.querySelector('#side div[contenteditable="true"]')`;

const TYPE_SEARCH_FN = `const typeSearch = (box, text) => {
  // Focus first. On a tab in the background WhatsApp ignores the typing otherwise and puts the old
  // words back (11-Nov-2026: the school's box kept "8971821459" through every clear). Focus inside a
  // page is the page's own business - it does not take Cue's window or his keyboard.
  box.focus();
  if (box.tagName === 'INPUT') {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(box, text);
  } else {
    box.focus();
    document.execCommand('selectAll', false, null);
    if (text) document.execCommand('insertText', false, text); else document.execCommand('delete', false, null);
  }
  box.dispatchEvent(new Event('input', { bubbles: true }));
};
const boxValue = (box) => (box.tagName === 'INPUT' ? box.value : box.innerText || '').trim();`;

const CLEAR_SEARCH = `(async () => {
  const box = ${SEARCH_BOX};
  if (!box) return 'no-box';
  ${TYPE_SEARCH_FN}
  if (!boxValue(box)) return 'empty';
  typeSearch(box, '');
  for (let i = 0; i < 20 && boxValue(box); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 150));
  if (document.activeElement === box) box.blur();
  return boxValue(box) ? 'stuck' : 'cleared';
})()`;

// Search WhatsApp and read back what it found, section by section. Section headings are rows with
// no span[title] ("Chats", "Contacts", "Messages", "Groups in common").
const SEARCH_ROWS = (query) => `(async () => {
  ${ROW_READER}
  ${TYPE_SEARCH_FN}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const box = ${SEARCH_BOX};
  if (!box) return { searched: false };
  typeSearch(box, ${JSON.stringify(String(query))});
  const SECTIONS = /^(chats|contacts|messages|groups in common|chat|contact|message|unread)$/i;
  const NONE = /no (chats|results|contacts)|no chats, contacts or messages found|not found/i;
  const read = () => {
    const out = []; let section = '';
    const rows = [...document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]')];
    for (const row of rows) {
      if (!row.querySelector('span[title]')) { const t = (row.innerText || '').trim(); if (t && t.length < 40) section = t; continue; }
      const r = readRow(row); if (r.name) out.push({ ...r, section });
    }
    const sectioned = rows.some((row) => !row.querySelector('span[title]') && SECTIONS.test((row.innerText || '').trim()));
    const nothing = NONE.test((document.querySelector('#pane-side') || document.querySelector('#side') || {}).innerText || '');
    return { out, sectioned, nothing };
  };
  let got = { out: [], sectioned: false, nothing: false }, last = '';
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    got = read();
    const sig = got.out.map((r) => r.name + r.section).join('|');
    // Settled: WhatsApp has answered in its own words, and nothing changed for one more look.
    if ((got.sectioned || got.nothing) && sig === last && i > 2) break;
    last = sig;
  }
  if (document.activeElement === box) box.blur();
  return { searched: true, trusted: got.sectioned || got.nothing, rows: got.out };
})()`;

// Click a row by its exact title among the rows drawn right now, and confirm in the header.
// The click is dispatched in the page, not sent as a mouse event at x,y: these tabs sit in the
// background with no geometry on screen, and a pointer aimed at a tab nobody can see hits nothing.
const CLICK_AND_CONFIRM = `const clickAndConfirm = async (row, title) => {
  // The row's gridcell ignores a click; the div that carries the name takes it (measured on the
  // live page 2-Nov-2026). The gridcell, then the row itself, stay behind it as fallbacks.
  const titled = row.querySelector('span[title]');
  const el = (titled && titled.closest('div')) || row.querySelector('[role="gridcell"]') || row;
  el.scrollIntoView({ block: 'center' });
  fire(el);
  // Then CONFIRM, because a click on the chat list is not a promise. On 2-Nov-2026 a click aimed
  // at a Satish row opened a large broadcast list instead: the list had re-rendered under it. The
  // header is the only honest answer to "which chat am I in", so it is read back and compared in
  // FULL, and a mismatch is reported rather than passed off as success.
  for (let i = 0; i < 24; i++) {
    const n = CHAT_NAME();
    if (n && sameName(n, title)) return { found: true, name: title, opened: n };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { found: true, name: title, opened: CHAT_NAME(), mismatch: true };
};`;

// Open a chat through WhatsApp's search. Chats first, then Contacts (a saved contact with no
// conversation yet). Message hits are never clicked: they open a chat at an old message.
const OPEN_VIA_SEARCH = (name) => `(async () => {
  ${FIRE}
  ${SAME_NAME_FN}
  ${CHAT_NAME_FN}
  ${CLICK_AND_CONFIRM}
  const want = ${JSON.stringify(String(name).trim())};
  const found = await ${SEARCH_ROWS(name)};
  if (!found.searched) return { searched: false };
  if (!found.trusted) return { searched: true, trusted: false };
  const usable = found.rows.filter((r) => !/^(messages|message|groups in common)$/i.test(r.section));
  const chats = usable.filter((r) => /^chats?$/i.test(r.section) || !r.section);
  const inChats = pick(want, chats.map((r) => r.name));
  const choice = inChats.name ? inChats : pick(want, usable.map((r) => r.name));
  if (!choice.name) return { searched: true, trusted: true, found: false, choices: choice.choices || [], offered: usable.slice(0, 6).map((r) => r.name) };
  const rows = [...document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]')];
  const row = rows.find((r) => { const t = r.querySelector('span[title]'); return t && (t.getAttribute('title') || t.innerText || '').trim() === choice.name; });
  if (!row) return { searched: true, trusted: true, found: false, choices: [], offered: [choice.name] };
  return { searched: true, trusted: true, ...(await clickAndConfirm(row, choice.name)) };
})()`;

// The fallback when search cannot be trusted. WhatsApp only draws the rows in view, so the list is
// walked from the top and the chat is clicked THE MOMENT it is drawn. The old code walked the whole
// list to find the name, put the scroll back, and then clicked - by then the row was gone again,
// which is why "Aishwarya" was found "among 404 chats" and still could not be opened (11-Nov-2026).
const WALK_AND_OPEN = (name) => `(async () => {
  ${FIRE}
  ${ROW_READER}
  ${SAME_NAME_FN}
  ${CHAT_NAME_FN}
  ${CLICK_AND_CONFIRM}
  const want = ${JSON.stringify(String(name).trim())};
  const pane = document.querySelector('#pane-side');
  if (!pane) return { found: false, total: 0, choices: [], offered: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const titleOf = (row) => { const t = row.querySelector('span[title]'); return ((t && (t.getAttribute('title') || t.innerText)) || '').trim(); };
  const walk = async (test) => {
    const seen = new Set();
    pane.scrollTop = 0; nudge(); await sleep(250);
    for (let i = 0; i < 80; i++) {
      for (const row of visibleRows()) { const n = titleOf(row); if (!n) continue; seen.add(n); if (test(n)) return { row, name: n, seen }; }
      if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 5) break;
      pane.scrollTop = pane.scrollTop + Math.max(300, pane.clientHeight - 100); nudge();
      await sleep(350);
    }
    for (const row of visibleRows()) { const n = titleOf(row); if (n) { seen.add(n); if (test(n)) return { row, name: n, seen }; } }
    return { row: null, seen };
  };
  // First pass: an exact name, clicked where it stands.
  let hit = await walk((n) => sameName(n, want));
  if (!hit.row) {
    // No exact name anywhere. One unambiguous near name is allowed; then a second pass to reach it.
    const choice = pick(want, [...hit.seen]);
    if (!choice.name) return { found: false, total: hit.seen.size, choices: choice.choices || [], offered: [...hit.seen].slice(0, 5) };
    hit = await walk((n) => n === choice.name);
    if (!hit.row) return { found: false, total: hit.seen.size, choices: [], offered: [choice.name] };
  }
  return clickAndConfirm(hit.row, hit.name);
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
const SAME_NAME_FN = `const flat = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\\p{L}\\p{N}]+/gu, '');
const digits = (s) => String(s || '').replace(/\\D+/g, '');
const isPhone = (s) => /^[\\s\\u200e\\u200f\\u202a-\\u202e+()\\-.\\d]+$/.test(String(s || '')) && digits(s).length >= 8;
const samePhone = (a, b) => {
  const x = digits(a), y = digits(b);
  if (x.length < 8 || y.length < 8) return false;
  return x === y || (x.length > y.length ? x.endsWith(y) : y.endsWith(x)) && Math.min(x.length, y.length) >= 10;
};
const sameName = (a, b) => {
  if (isPhone(a) && isPhone(b)) return samePhone(a, b);
  const x = flat(a), y = flat(b);
  return !!x && x === y;
};
// Best match for what was asked, among names in the order WhatsApp lists them. Exact (or the same
// phone number) wins outright. Failing that, a name that starts with what was asked, then one that
// contains it - but only when there is exactly ONE such name. Two candidates is a question for the
// caller, never a guess: "Jatin" must not quietly open "Jatin Sharma" when "Jatin K" exists too.
const pick = (want, names) => {
  const exact = names.filter((n) => sameName(n, want));
  if (exact.length) return { name: exact[0] };
  const w = flat(want);
  if (!w || isPhone(want)) return { name: null, choices: [] };
  for (const test of [(n) => flat(n).startsWith(w), (n) => flat(n).includes(w)]) {
    const got = [...new Set(names.filter(test))];
    if (got.length === 1) return { name: got[0] };
    if (got.length > 1) return { name: null, choices: got.slice(0, 6) };
  }
  return { name: null, choices: [] };
};`;

// Which conversation is open, read the way a person reads it. WhatsApp marks the name itself with
// data-testid="conversation-info-header-chat-title" (seen live 11-Nov-2026), a span[dir=auto] whose
// emoji are <img alt="🔍"> pictures - so the alt text is read back in, or "Parth Ahire 🔍 Recruit
// NSM" would come out as "Parth Ahire  Recruit NSM". The header's FIRST LINE is no longer the name:
// on a chat with no photo it is the avatar's single letter, "P", which is what let a read for
// Priyanshu land in Parth's chat. Lines of one character are skipped for that reason.
const CHAT_NAME_FN = `const textOf = (el) => {
  let out = '';
  const walk = (n) => {
    if (n.nodeType === 3) out += n.nodeValue;
    else if (n.nodeType === 1) { if (n.tagName === 'IMG') out += n.getAttribute('alt') || ''; else n.childNodes.forEach(walk); }
  };
  walk(el);
  return out.replace(/\\s+/g, ' ').trim();
};
const CHAT_NAME = () => {
  const h = document.querySelector('#main header');
  if (!h) return '';
  const marked = h.querySelector('[data-testid="conversation-info-header-chat-title"]') || h.querySelector('span[dir="auto"]');
  const named = marked ? textOf(marked) : '';
  if (named) return named;
  const lines = (h.innerText || '').split('\\n').map((l) => l.trim()).filter((l) => l.length > 1);
  if (lines[0]) return lines[0];
  // On a small group span[title] holds the member list ("Jason, Tom, You"), so it is the last resort.
  const titled = h.querySelector('span[title]');
  const t = titled ? (titled.getAttribute('title') || '').trim() : '';
  return t.split(',').length > 3 ? '' : t;
};`;

const OPEN_CHAT_NAME = `(() => {
  ${CHAT_NAME_FN}
  return CHAT_NAME();
})()`;

// ---------------------------------------------------------------- the engine
function makeWhatsApp({ tabs, openTab, ensureView, hostOf, activate, programId, frontId, wake }) {
  // Never the tab a class is looking at, and never a private one.
  const onAir = () => (typeof programId === 'function' ? programId() : programId);
  // The tab he is looking at right now, if any. Cue never reloads that one under him.
  const inFront = (t) => typeof frontId === 'function' && frontId() === t.id;
  const tabFor = (identity) => tabs.find((t) => t.identity === identity && hostOf(t.url) === WA_HOST()
    && !t.private && t.id !== onAir());

  // Everything here works in the tab's page and nothing else: no activate(), no focus(), no window
  // raised. That is what lets Claude work in the school's WhatsApp while Jason types in his own
  // (or the other way round): each account is its own tab with its own page, and the only action
  // allowed to bring a tab forward is status with show:true, for the one-time scan.
  async function wcFor(identity) {
    let t = tabFor(identity);
    if (!t) t = openTab({ url: WA(), identity, background: true, agent: true });
    ensureView(t);
    // Awake for the length of the job, so WhatsApp draws its list and search results as it would
    // on screen (see wake() in main.js). Off screen all the same.
    const wc = t.view.webContents;
    if (hostOf(wc.getURL()) !== WA_HOST()) await wc.loadURL(WA()).catch(() => {});
    const end = Date.now() + 20000;
    while (wc.isLoading() && Date.now() < end) await sleep(100);
    if (typeof wake === 'function') await wake(t);
    return { tab: t, wc };
  }

  const js = (wc, script) => wc.executeJavaScript(script, true);
  let sendPressed = false;

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

  const refuseChoices = (want, identity, choices) => {
    throw new Error(`More than one chat on ${label(identity)}'s WhatsApp could be “${want}”: ${choices.join(', ')}. Say the full name. Nothing was opened.`);
  };

  // A number with no chat yet: WhatsApp's own /send?phone= address opens it. That reloads the tab,
  // so it is never done to the tab he is looking at.
  async function openByNumber(tab, wc, want, identity) {
    if (inFront(tab)) throw new Error(`There is no chat with ${want} on ${label(identity)}'s WhatsApp yet, and opening one means reloading the WhatsApp tab Jason has in front of him. Nothing was opened.`);
    const url = new URL(`send?phone=${digitsOf(want)}`, WA()).toString();
    await wc.loadURL(url).catch(() => {});
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      await sleep(500);
      const state = await js(wc, LINKED).catch(() => 'loading');
      if (state !== 'ready') continue;
      if (typeof wake === 'function') await wake(tab);
      const n = await js(wc, OPEN_CHAT_NAME).catch(() => '');
      if (n && sameChat(n, want)) return n;
      const bad = await js(wc, `/invalid|isn.t on whatsapp|not on whatsapp/i.test(document.body.innerText)`).catch(() => false);
      if (bad) throw new Error(`${want} is not on WhatsApp, says WhatsApp. Nothing was opened.`);
    }
    const n = await js(wc, OPEN_CHAT_NAME).catch(() => '');
    throw new Error(`Cue asked WhatsApp to open ${want}, but the chat that opened is “${n || 'nothing'}”. Nothing was read or sent.`);
  }

  // Open a chat and PROVE it is the one asked for. Returns the name exactly as the header shows it.
  async function openChat(tab, wc, name, identity) {
    const want = String(name || '').trim();
    if (!want) throw new Error('Name the chat to open.');
    const already = await js(wc, OPEN_CHAT_NAME);
    if (already && sameChat(already, want)) return already;

    let hit = null;
    // 1. WhatsApp's own search, which reaches every chat and every saved contact.
    const viaSearch = await js(wc, OPEN_VIA_SEARCH(want));
    await js(wc, CLEAR_SEARCH).catch(() => {});
    if (viaSearch.searched && viaSearch.trusted) {
      if (viaSearch.found) hit = viaSearch;
      else if (viaSearch.choices && viaSearch.choices.length > 1) refuseChoices(want, identity, viaSearch.choices);
    }
    // 2. Search could not be trusted, or found nothing: walk the list and click as it is drawn.
    let walked = null;
    if (!hit) {
      walked = await js(wc, WALK_AND_OPEN(want));
      if (walked.found) hit = walked;
      else if (walked.choices && walked.choices.length > 1) refuseChoices(want, identity, walked.choices);
    }
    // 3. A phone number with no chat at all.
    if (!hit && isPhone(want)) return openByNumber(tab, wc, want, identity);
    if (!hit) {
      // Say what IS there, by name, so the mistake is obvious: a typo, or the wrong account.
      const near = [...new Set([...(viaSearch.offered || []), ...((walked && walked.offered) || [])])].slice(0, 5);
      const total = walked ? walked.total : 0;
      throw new Error(`No chat called “${want}” on ${label(identity)}'s WhatsApp${total ? `, among ${total} chat${total === 1 ? '' : 's'}` : ''}.${near.length ? ` Nearest: ${near.join(', ')}.` : ''}`);
    }
    if (hit.mismatch) {
      throw new Error(`Cue clicked “${hit.name}” but WhatsApp opened “${hit.opened || 'nothing'}” instead. Nothing was read or sent.`);
    }
    // The click confirmed the header against the row it clicked. Check once more against what was
    // ASKED, in full, because a near name ("Priyanshu Yadav" for "Priyanshu Yadav 🔍 Recruit NSM")
    // was allowed only when it was the one candidate.
    const now = await js(wc, OPEN_CHAT_NAME);
    if (!sameChat(now, hit.name)) throw new Error(`WhatsApp's open chat changed to “${now || 'nothing'}” while Cue was opening “${hit.name}”. Nothing was read or sent.`);
    return now;
  }

  // Before reading or writing anything, the open chat must still be the one that was opened. A
  // wrong-chat read fails loudly; it is never returned as if it were the right one.
  async function stillIn(wc, name, identity) {
    const now = await js(wc, OPEN_CHAT_NAME);
    if (!sameChat(now, name)) throw new Error(`The chat open on ${label(identity)}'s WhatsApp is “${now || 'nothing'}”, not “${name}”. Nothing was read or sent.`);
  }

  // ---- the five things anyone actually wants
  const actions = {
    async chats({ wc, identity, unreadOnly, limit }) {
      const want = Math.min(Number(limit) || 15, 60);
      // Unread chats can sit anywhere, so that question walks the whole list; a plain list stops
      // walking once it has enough.
      let rows = await js(wc, WALK_ROWS(unreadOnly ? 400 : want + 5));
      if (!rows.length) rows = await js(wc, ROWS);
      if (unreadOnly) rows = rows.filter((r) => r.unread > 0);
      rows = rows.slice(0, want);
      if (!rows.length) return { text: unreadOnly ? `${label(identity)}: nothing unread.` : `${label(identity)}: no chats on screen yet.` };
      const lines = rows.map((r) => `${r.unread ? `(${r.unread}) ` : ''}${r.name}${r.when ? ` · ${r.when}` : ''}${r.last ? ` · ${r.last}` : ''}`);
      return { text: `${label(identity)} · ${rows.length} chat${rows.length === 1 ? '' : 's'}\n${lines.join('\n')}` };
    },

    async read({ tab, wc, identity, chat, limit }) {
      const name = await openChat(tab, wc, chat, identity);
      const { chat: shown, messages } = await js(wc, READ(limit));
      // The messages came from whatever the header said while they were read. Compare it in full.
      if (!sameChat(shown, name)) throw new Error(`Cue opened “${name}” but the messages it read belong to “${shown || 'no chat'}”. Nothing is reported from either.`);
      if (!messages.length) return { text: `${label(identity)} · ${name}: no messages yet.` };
      const lines = messages.map((m) => (m.event ? m.text : `${m.when ? m.when + ' ' : ''}${m.out ? 'You' : (m.who || name)}: ${m.text}`));
      return { text: `${label(identity)} · ${name}\n${lines.join('\n')}` };
    },

    async send({ tab, wc, identity, chat, message }) {
      const body = String(message || '').replace(/\r\n?/g, '\n').trim();
      if (!body) throw new Error('There is nothing to send.');
      const name = await openChat(tab, wc, chat, identity);
      // Proof that it landed: the last outgoing messages, letters and digits only, must contain
      // the start or the end of what was sent - and more of them than before we pressed Send, so
      // the same words sent yesterday cannot pass for today's.
      const flat = body.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      const head = flat.slice(0, 30);
      const tail = flat.slice(-30);
      const landed = async () => {
        const { messages } = await js(wc, READ(30));
        return messages.filter((m) => m.out && m.full && (m.full.includes(head) || m.full.includes(tail))).length;
      };
      const before = await landed();
      await stillIn(wc, name, identity);
      let put = await js(wc, PUT(body));
      if (put === 'no-box' || put === 'mangled') { await sleep(400); put = await js(wc, PUT(body)); }
      if (put === 'draft') throw new Error(`There are unsent words already in the box for ${name}. Cue left them alone and sent nothing.`);
      if (put === 'no-box') throw new Error('WhatsApp\'s message box never appeared, so nothing was sent.');
      if (put !== 'ok') throw new Error('WhatsApp would not take the message with its line breaks intact, so nothing was sent.');
      await sleep(120);
      // The last look before the one step that cannot be undone.
      await stillIn(wc, name, identity);
      sendPressed = true;
      const how = await js(wc, SEND_IT);
      if (how === 'no-box') throw new Error('WhatsApp\'s message box disappeared before Cue could send.');
      const short = body.replace(/\s+/g, ' ').slice(0, 60);
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        await sleep(400);
        if ((await landed()) > before) {
          return { text: `Sent on ${label(identity)}'s WhatsApp to ${name}: ${short}${body.length > 60 ? '…' : ''}` };
        }
      }
      throw new Error(`Cue pressed Send to ${name} but could not see the message arrive. Read that chat before sending it again.`);
    },

    // WhatsApp's own search when it can be trusted: chat names, contacts, and words INSIDE the
    // conversations. When it cannot, Cue's own look over the list, and the answer says it looked at
    // names and last lines only, because a search that quietly looks at less than you think is the
    // whole reason this was rewritten.
    async search({ wc, identity, query }) {
      const q = String(query || '').trim();
      if (!q) throw new Error('Say what to look for.');
      const found = await js(wc, SEARCH_ROWS(q));
      await js(wc, CLEAR_SEARCH).catch(() => {});
      if (found.searched && found.trusted) {
        if (!found.rows.length) return { text: `${label(identity)}: WhatsApp found nothing for “${q}”.` };
        const groups = new Map();
        for (const r of found.rows) { const k = r.section || 'Chats'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
        const parts = [...groups].map(([k, rs]) => `${k}:\n${rs.slice(0, 12).map((r) => `${r.unread ? `(${r.unread}) ` : ''}${r.name}${r.when ? ` · ${r.when}` : ''}${r.last ? ` · ${r.last}` : ''}`).join('\n')}`);
        return { text: `${label(identity)} · WhatsApp search for “${q}”\n${parts.join('\n')}` };
      }
      const all = await js(wc, WALK_ROWS(400));
      if (!all.length) return { text: `${label(identity)}: no chats to look through yet.` };
      const needle = plainName(q);
      const digits = digitsOf(q);
      const hits = all.filter((r) => plainName(r.name).includes(needle) || plainName(r.last).includes(needle)
        || (digits.length >= 6 && digitsOf(r.name).includes(digits)));
      const scope = `Looked at ${all.length} chat${all.length === 1 ? '' : 's'} by name and last message only, not inside the conversations.`;
      if (!hits.length) return { text: `${label(identity)}: nothing matches “${q}”. ${scope}` };
      const lines = hits.slice(0, 15).map((r) => `${r.unread ? `(${r.unread}) ` : ''}${r.name}${r.last ? ` · ${r.last}` : ''}`);
      return { text: `${label(identity)} · ${hits.length} match${hits.length === 1 ? '' : 'es'} for “${q}”\n${lines.join('\n')}\n${scope}` };
    },

    // Only for the one-time link, and when something looks wrong: this is the single action
    // that is allowed to put the tab in front of him.
    async status({ tab, wc, identity, show }) {
      const state = await js(wc, LINKED);
      if (show && activate) activate(tab.id);
      const said = state === 'ready' ? 'linked and ready'
        : state === 'unlinked' ? 'not linked — scan the code in that tab once with the phone'
        : 'still loading';
      return { text: `${label(identity)}'s WhatsApp: ${said}.`, state, tabId: tab.id };
    },
  };

  async function run(action, a, identity) {
    // status has to answer for an account that is not linked, so it skips the ready() check.
    const { tab, wc } = action === 'status' ? await wcFor(identity) : await ready(identity);
    // A search left in the box (his, or an earlier job's) hides most of the list from every action.
    if (action !== 'status' && !inFront(tab)) await js(wc, CLEAR_SEARCH).catch(() => {});
    try {
      return await actions[action]({ ...a, identity, tab, wc });
    } finally {
      if (action !== 'status') await js(wc, CLEAR_SEARCH).catch(() => {});
    }
  }

  // ONE JOB AT A TIME PER ACCOUNT. Each account is a single tab with a single open chat, so two
  // reads at once on the same phone used to open each other's chats and return the wrong messages
  // (11-Nov-2026). Calls for the same account now wait their turn; the two accounts never wait
  // for each other, because they are two separate tabs.
  const queues = new Map();
  const inLine = (identity, job) => {
    const prev = queues.get(identity) || Promise.resolve();
    const next = prev.catch(() => {}).then(job);
    queues.set(identity, next.catch(() => {}));
    return next;
  };

  // One door for every agent. The account is named in words, never assumed.
  return async function whatsapp(a = {}) {
    const action = String(a.action || 'chats').toLowerCase();
    if (!actions[action]) throw new Error(`WhatsApp can do: ${Object.keys(actions).join(', ')}.`);
    const identity = whoOf(a.who || a.account || a.identity);
    return inLine(identity, async () => {
      // A page that died under us ("Object has been destroyed") gets one fresh try - except a send
      // that already pressed Send, which is never repeated, so nobody gets the same message twice.
      sendPressed = false;
      try {
        return await run(action, a, identity);
      } catch (e) {
        if (!/destroyed/i.test(String(e && e.message)) || sendPressed) throw e;
        await sleep(800);
        return run(action, a, identity);
      }
    });
  };
}

module.exports = { makeWhatsApp, WHO, WA_HOST, sameChat };
