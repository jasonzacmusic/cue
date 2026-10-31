// One sign-in reaches every folder. A site signed in inside Personal is copied
// into School and back, so a site you only have one account for never has to be
// signed into twice. Sites where Jason keeps TWO accounts are the exception and
// stay apart on purpose — that separation is the whole point of the folders:
// Personal's Gmail, Instagram, YouTube and WhatsApp are his, School's are the
// school's, and both are signed in at the same time with nothing to toggle.
// The AI agent and Vanish logins never take part.
const TWO_ACCOUNTS = /(^|\.)(google\.[a-z.]+|gmail\.com|youtube\.com|instagram\.com|threads\.net|facebook\.com|whatsapp\.com)$/i;

const hostOf = (c) => c.domain.replace(/^\./, '');
const keyOf = (c) => [c.domain, c.path, c.name, c.value].join('|');
const urlOf = (c) => `${c.secure ? 'https' : 'http'}://${hostOf(c)}${c.path || '/'}`;
const hasTwoAccounts = (host) => TWO_ACCOUNTS.test(host);

function copyOf(c) {
  const out = { url: urlOf(c), name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
  if (!c.hostOnly && !c.name.startsWith('__Host-')) out.domain = c.domain; // __Host- cookies must not carry a domain
  if (c.expirationDate) out.expirationDate = c.expirationDate;
  return out;
}

function shareLogins(a, b) {
  const arriving = new Set(); // copies we just made, so they don't bounce straight back

  async function put(to, c) {
    const k = keyOf(c); arriving.add(k);
    try { await to.cookies.set(copyOf(c)); } catch { arriving.delete(k); }
  }

  function follow(from, to) {
    from.cookies.on('changed', (_e, c, cause, removed) => {
      if (hasTwoAccounts(hostOf(c))) return;
      if (removed) {
        if (cause === 'overwrite' || cause === 'evicted') return;
        to.cookies.remove(urlOf(c), c.name).catch(() => {});
      } else if (!arriving.delete(keyOf(c))) put(to, c);
    });
  }
  follow(a, b); follow(b, a);

  // Fills in what each side is missing. It never replaces a sign-in that side already has.
  async function syncNow() {
    const [inA, inB] = await Promise.all([a.cookies.get({}), b.cookies.get({})]);
    const id = (c) => [c.domain, c.path, c.name].join('|');
    const haveA = new Set(inA.map(id)); const haveB = new Set(inB.map(id));
    for (const c of inA) if (!haveB.has(id(c)) && !hasTwoAccounts(hostOf(c))) await put(b, c);
    for (const c of inB) if (!haveA.has(id(c)) && !hasTwoAccounts(hostOf(c))) await put(a, c);
  }

  return { syncNow };
}

module.exports = { shareLogins, hasTwoAccounts };
