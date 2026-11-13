// Sharing sign-ins between two folders, ONLY when the person has said so for that pair
// (settings().sharedPairs). A site signed in inside one is copied into the other and back, so a
// site with one account never has to be signed into twice. Sites where people keep TWO accounts are
// the exception and stay apart on purpose - Gmail, Instagram, YouTube, WhatsApp and the AI sites
// (Claude, ChatGPT, Grok...) in each folder are that folder's own. Nothing is shared by default: every folder is private until two of them
// are paired. The AI agent and Vanish logins never take part.
// AI sites belong here too (13-Nov-2026): people sign in to them with the folder's own Google
// account, so Claude, ChatGPT or Grok in Personal and in School are two different accounts. Sharing
// them made a sign-in in one folder replace the other's, and School's own Claude pages then said
// "Sign in to view this page" for ever.
const TWO_ACCOUNTS = /(^|\.)(google\.[a-z.]+|gmail\.com|youtube\.com|instagram\.com|threads\.(net|com)|facebook\.com|whatsapp\.com|claude\.(ai|com)|anthropic\.com|claudeusercontent\.com|chatgpt\.com|openai\.com|sora\.com|grok\.com|x\.ai|perplexity\.ai|poe\.com|mistral\.ai|deepseek\.com|meta\.ai|character\.ai|copilot\.microsoft\.com|huggingface\.co|midjourney\.com)$/i;

const hostOf = (c) => c.domain.replace(/^\./, '');
const keyOf = (c) => [c.domain, c.path, c.name, c.value].join('|');
const gone = (c) => ['gone', c.domain, c.path, c.name].join('|');
const urlOf = (c) => `${c.secure ? 'https' : 'http'}://${hostOf(c)}${c.path || '/'}`;
const hasTwoAccounts = (host) => TWO_ACCOUNTS.test(host);

// Copies that every pair has just made, per session. A cookie that ARRIVED in a folder by sharing
// is never passed on again, by this pair or any other: with A-B and B-C shared, a sign-in made in A
// reaches B and stops there. C only shares with B what B signed into itself.
const recent = new WeakMap();
const HOLD_MS = 10000;
function mark(ses, k) {
  if (!recent.has(ses)) recent.set(ses, new Map());
  recent.get(ses).set(k, Date.now());
}
function arrived(ses, k) {
  const m = recent.get(ses);
  if (!m) return false;
  const now = Date.now();
  for (const [x, at] of m) if (now - at > HOLD_MS) m.delete(x);
  return m.has(k);
}

function copyOf(c) {
  const out = { url: urlOf(c), name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
  if (!c.hostOnly && !c.name.startsWith('__Host-')) out.domain = c.domain; // __Host- cookies must not carry a domain
  if (c.expirationDate) out.expirationDate = c.expirationDate;
  return out;
}

function shareLogins(a, b) {
  async function put(to, c) {
    mark(to, keyOf(c));
    try { await to.cookies.set(copyOf(c)); } catch { /* one cookie never stops the rest */ }
  }

  const listeners = [];
  function follow(from, to) {
    const fn = (_e, c, cause, removed) => {
      if (hasTwoAccounts(hostOf(c))) return;
      if (removed) {
        if (cause === 'overwrite' || cause === 'evicted') return;
        if (arrived(from, gone(c))) return;
        mark(to, gone(c));
        to.cookies.remove(urlOf(c), c.name).catch(() => {});
      } else if (!arrived(from, keyOf(c))) put(to, c);
    };
    from.cookies.on('changed', fn);
    listeners.push([from, fn]);
  }
  follow(a, b); follow(b, a);

  // Fills in what each side is missing. It never replaces a sign-in that side already has.
  async function syncNow() {
    const [inA, inB] = await Promise.all([a.cookies.get({}), b.cookies.get({})]);
    const id = (c) => [c.domain, c.path, c.name].join('|');
    const haveA = new Set(inA.map(id)); const haveB = new Set(inB.map(id));
    for (const c of inA) if (!haveB.has(id(c)) && !hasTwoAccounts(hostOf(c)) && !arrived(a, keyOf(c))) await put(b, c);
    for (const c of inB) if (!haveA.has(id(c)) && !hasTwoAccounts(hostOf(c)) && !arrived(b, keyOf(c))) await put(a, c);
  }

  // Unpairing stops the copying there and then. What was already copied stays where it is: it is
  // a sign-in that folder now holds, and taking it away would sign someone out unasked.
  function stop() {
    for (const [ses, fn] of listeners) { try { ses.cookies.removeListener('changed', fn); } catch {} }
    listeners.length = 0;
  }

  return { syncNow, stop };
}

module.exports = { shareLogins, hasTwoAccounts };
