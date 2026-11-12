// The shield: ads, trackers, cookie notices, and sites known to be carrying a
// virus or pretending to be your bank.
//
// Two separate jobs live here, because they fail differently.
//
// 1. Ads and trackers. Cue uses the same filter lists Brave and uBlock use -
//    EasyList, EasyPrivacy and the annoyance lists - through Ghostery's engine.
//    The engine is built once and kept in the app's folder, so after one online
//    launch it works with no network at all. It is rebuilt when it is a week
//    old, never more often: this Mac pays for its internet by the gigabyte.
//
// 2. Dangerous sites. A plain list of hostnames known today to be handing out
//    malware or phishing for passwords. These change hourly, so the list is
//    refreshed every three days and asked for with an ETag, which means a
//    refresh that finds nothing new costs a few hundred bytes instead of a
//    megabyte. Blocked requests are only half the answer - a page that simply
//    fails to load teaches nobody anything - so main.js also stops the
//    navigation and shows a page that says what happened in words.
//
// If any of this cannot be fetched, Cue carries on with whatever it has. A
// browser that refuses to browse because a blocklist is unreachable is worse
// than one that browses with last week's list.
const fs = require('fs');
const path = require('path');

const WEEK = 7 * 24 * 60 * 60 * 1000;
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

// abuse.ch's URLhaus (live malware distribution) and the phishing feed built
// from OpenPhish, PhishTank and ipthreat. Both are plain host files, both are
// free, neither needs a key.
const DANGER_LISTS = [
  { kind: 'malware', url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts-online.txt' },
  { kind: 'phishing', url: 'https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt' },
];

// Sites that must behave exactly as they do in Chrome, whatever a filter list
// thinks. YouTube's player and Studio break under cosmetic filtering. A starting
// setup (presets.js) adds its own organisation's sites through setPresetHosts.
const NEVER_TOUCH = [
  '@@||youtube.com^$document', '@@||youtube-nocookie.com^$document', '@@||ytimg.com^', '@@||googlevideo.com^',
  // CNN's player asks for this settings file about 3,000 times a second if it is refused, which
  // costs far more than the file. The ads it would lead to are still blocked.
  '@@||cdn-media.brightline.tv/config/$xmlhttprequest,domain=cnn.com',
  // Meta's sites, on Meta's sites only. The privacy lists stop
  // instagram.com/ajax/bz, which is one of Instagram's OWN addresses and the one
  // that plants the mid and datr device cookies. Without those, signing in gets
  // as far as the code sent by text and then answers "there was a problem with
  // your request" forever. The $domain= on each rule is what keeps this honest:
  // Meta watching you from someone else's page is still blocked, which is the
  // tracking that matters.
  '@@||instagram.com^$domain=instagram.com|threads.net',
  '@@||facebook.com^$domain=facebook.com|instagram.com|threads.net',
  '@@||threads.net^$domain=threads.net|instagram.com',
  '@@||whatsapp.com^$domain=whatsapp.com',
  '@@||cdninstagram.com^', '@@||fbcdn.net^',
  // Google's sign-in, on Google's own pages only - the same honesty as Meta above. Measured on
  // 12-Nov-2026 with the lists Cue ships: on accounts.google.com and mail.google.com the privacy
  // lists stopped play.google.com/log and www.google.com/log (Google's own sign-in and Gmail
  // reporting), and the "$ping,3p" rule stopped csp.withgoogle.com, where Google's sign-in page
  // reports its own security policy. Those three are the ones that were actually blocked. The rest
  // are a safety net for the hosts the sign-in form, its security check (reCAPTCHA) and the
  // account picker cannot work without, so a list update cannot quietly break signing in. With
  // $domain=, the same addresses on somebody else's page stay blocked.
  '@@||play.google.com/log^$domain=google.com', '@@||www.google.com/log^$domain=google.com',
  '@@||csp.withgoogle.com^$domain=google.com',
  '@@||accounts.google.com^$domain=google.com|youtube.com|gmail.com',
  '@@||accounts.youtube.com^$domain=google.com|youtube.com',
  '@@||gstatic.com^$domain=google.com|youtube.com', '@@||googleusercontent.com^$domain=google.com|youtube.com',
  '@@||www.google.com/recaptcha/$domain=google.com', '@@||ogs.google.com^$domain=google.com',
  // WhatsApp's own files and media live on whatsapp.net. Nothing there was blocked when measured;
  // this keeps it that way, on WhatsApp only.
  '@@||whatsapp.net^$domain=whatsapp.com',
  // The streaming services, each on its own pages only. A film site talks to
  // its own addresses constantly while you watch - which player, which picture
  // quality, where you got to. The privacy lists treat some of those as
  // tracking and refuse them, and the players do not cope: Netflix answers
  // "Something's not quite right" and keeps asking until it runs out of room,
  // because its own logs.netflix.com was refused. Same honesty as Meta above:
  // the $domain= means Netflix or Amazon watching you from somebody else's
  // page is still blocked, which is the watching that matters.
  '@@||netflix.com^$domain=netflix.com',
  '@@||nflxso.net^$domain=netflix.com', '@@||nflxext.com^$domain=netflix.com', '@@||nflxvideo.net^$domain=netflix.com',
  '@@||primevideo.com^$domain=primevideo.com', '@@||aiv-cdn.net^$domain=primevideo.com',
  '@@||aiv-delivery.net^$domain=primevideo.com', '@@||media-amazon.com^$domain=primevideo.com',
  // Prime Video checks the browser through these before it will play anything,
  // and refuses with "an old or unsupported version of this browser" when they
  // are missing. Amazon's shopping pages are a different site and keep every
  // one of their trackers blocked.
  '@@||a2z.com^$domain=primevideo.com', '@@||amazon.com^$domain=primevideo.com',
  '@@||ssl-images-amazon.com^$domain=primevideo.com',
  '@@||hotstar.com^$domain=hotstar.com|jiohotstar.com', '@@||jiohotstar.com^$domain=jiohotstar.com|hotstar.com',
  '@@||hotstarext.com^$domain=hotstar.com|jiohotstar.com',
  '@@||sonyliv.com^$domain=sonyliv.com', '@@||slivcdn.com^$domain=sonyliv.com',
  '@@||zee5.com^$domain=zee5.com', '@@||z5cdn.com^$domain=zee5.com',
  '@@||jiocinema.com^$domain=jiocinema.com',
  '@@||apple.com^$domain=tv.apple.com', '@@||mzstatic.com^$domain=tv.apple.com',
  '@@||spotify.com^$domain=spotify.com', '@@||scdn.co^$domain=spotify.com', '@@||spotifycdn.com^$domain=spotify.com',
];
// Cosmetic filtering hides page furniture by guessing from class names, and a
// video player's own controls get caught in that guess. Google's sign-in page is off too: the lists
// hide a handful of generic Google class names there (measured 12-Nov-2026), and a sign-in form is
// the last place a guess should land.
const COSMETIC_OFF = /^https:\/\/(accounts\.google\.[a-z.]+\/|([\w-]+\.)*(youtube\.com|youtube-nocookie\.com|netflix\.com|primevideo\.com|hotstar\.com|jiohotstar\.com|sonyliv\.com|zee5\.com|jiocinema\.com|apple\.com|spotify\.com)\/)/;

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// "0.0.0.0 bad.example" -> "bad.example", comments and blank lines dropped.
function parseHosts(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line || line[0] === '#') continue;
    const host = line.trim().split(/\s+/).pop();
    if (host && host.includes('.') && !host.startsWith('#')) out.push(host.toLowerCase());
  }
  return out;
}

function createShield({ dir, fetchImpl, log }) {
  const fetcher = fetchImpl || fetch;
  const enginePath = path.join(dir, 'blocker.bin');
  const stampPath = path.join(dir, 'shield.json');
  const dangerPath = path.join(dir, 'danger-hosts.txt');

  let blocker = null;
  let sessions = new Set();
  // host -> 'malware' | 'phishing'
  let danger = new Map();
  let allowed = new Set();      // sites where you have chosen to let the ads through
  let presetHosts = [];         // the starting setup's own sites, left alone entirely
  const counts = new Map();     // webContentsId -> how many requests were stopped
  let onChange = () => {};

  const stamp = () => { try { return JSON.parse(fs.readFileSync(stampPath, 'utf8')); } catch { return {}; } };
  const putStamp = (patch) => {
    try { fs.writeFileSync(stampPath, JSON.stringify({ ...stamp(), ...patch }, null, 2)); } catch {}
  };
  const note = (e) => { if (log) log(e); };
  const presetHost = (url) => { const h = hostOf(url); return !!h && presetHosts.some((x) => h === x || h.endsWith(`.${x}`)); };

  // ------------------------------------------------------------ ads and trackers
  async function buildEngine() {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const age = Date.now() - (stamp().engineAt || 0);
    // A stale engine is thrown away before building, so the build has to fetch
    // fresh lists. Done at launch rather than live: swapping the engine under a
    // loaded page is how you get a half-blocked page.
    if (age > WEEK) { try { fs.rmSync(enginePath, { force: true }); } catch {} }
    const made = !fs.existsSync(enginePath);
    const b = await ElectronBlocker.fromPrebuiltFull(fetcher, {
      path: enginePath, read: fs.promises.readFile, write: fs.promises.writeFile,
    });
    if (made || age > WEEK) putStamp({ engineAt: Date.now() });
    return b;
  }

  // "@@*$domain=site" is the one form that lets everything through on one site
  // and nowhere else, subdomains included. A "$document" exception only excuses
  // the page itself, which is not what "allow ads here" means.
  // The exceptions already in the engine, so that taking a site off the allow
  // list really takes it off. updateFromDiff only ever adds unless you hand it
  // back what to remove.
  let added = [];
  function applyExceptions() {
    if (!blocker) return;
    const mine = [...allowed].map((h) => `@@*$domain=${h}`);
    const ours = presetHosts.flatMap((h) => [`@@||${h}^$document`, `@@||${h}^`]);
    const next = [...NEVER_TOUCH, ...ours, ...mine];
    const removed = added.filter((f) => !next.includes(f));
    try { blocker.updateFromDiff({ added: next, removed }); added = next; } catch (e) { note({ tool: 'shield', error: e.message }); }
  }

  // The engine holds one shared message handler, so it is cleared before each
  // login's session is added.
  function enable(ses) {
    sessions.add(ses);
    if (!blocker || blocker.isBlockingEnabled(ses)) return;
    const { ipcMain } = require('electron');
    ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters');
    ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled');
    try { blocker.enableBlockingInSession(ses); } catch (e) { note({ tool: 'shield', error: e.message }); }
  }

  function disable(ses) {
    if (!blocker || !blocker.isBlockingEnabled(ses)) return;
    try { blocker.disableBlockingInSession(ses); } catch (e) { note({ tool: 'shield', error: e.message }); }
  }

  // ------------------------------------------------------------ dangerous sites
  function loadDangerCache() {
    try {
      const lines = fs.readFileSync(dangerPath, 'utf8').split('\n');
      const map = new Map();
      for (const line of lines) {
        const [host, kind] = line.split('\t');
        if (host) map.set(host, kind === 'malware' ? 'malware' : 'phishing');
      }
      if (map.size) danger = map;
    } catch {}
  }

  async function fetchDanger() {
    const tags = stamp().dangerTags || {};
    const nextTags = { ...tags };
    const fresh = new Map();   // kind -> hosts that just arrived
    let changed = false;
    let reached = 0;
    for (const list of DANGER_LISTS) {
      try {
        const headers = tags[list.kind] ? { 'If-None-Match': tags[list.kind] } : {};
        const res = await fetcher(list.url, { headers });
        reached += 1;
        if (res.status === 304) continue;          // nothing new; a few hundred bytes spent
        if (!res.ok) continue;
        const hosts = parseHosts(await res.text());
        if (!hosts.length) continue;
        fresh.set(list.kind, hosts);
        nextTags[list.kind] = res.headers.get('etag') || '';
        changed = true;
      } catch (e) { note({ tool: 'shield', error: `${list.kind}: ${e.message}` }); }
    }
    if (!changed) {
      if (reached) putStamp({ dangerAt: Date.now() });  // asked, nothing new - do not ask again tomorrow
      return;
    }
    // Each list replaces only its own hosts. A list that answered 304, or that
    // could not be reached at all, keeps the hosts already on disk.
    const got = new Map();
    for (const [host, kind] of danger) if (!fresh.has(kind)) got.set(host, kind);
    for (const [kind, hosts] of fresh) for (const h of hosts) got.set(h, kind);
    danger = got;
    putStamp({ dangerAt: Date.now(), dangerTags: nextTags });
    try {
      fs.writeFileSync(dangerPath, [...danger].map(([h, k]) => `${h}\t${k}`).join('\n'));
    } catch (e) { note({ tool: 'shield', error: e.message }); }
    feedDangerToEngine();
  }

  // The warning page stops you walking in the front door. These filters stop a
  // page you trust from quietly pulling a file off one of those hosts.
  function feedDangerToEngine() {
    if (!blocker || !danger.size) return;
    try {
      blocker.updateFromDiff({ added: [...danger.keys()].map((h) => `||${h}^$all`) });
    } catch (e) { note({ tool: 'shield', error: `feed: ${e.message}` }); }
  }

  // bad.example matches bad.example and pay.bad.example, nothing else.
  function verdict(url) {
    if (!danger.size) return null;
    let host = hostOf(url);
    if (!host) return null;
    while (host.includes('.')) {
      const hit = danger.get(host);
      if (hit) return hit;
      host = host.slice(host.indexOf('.') + 1);
    }
    return null;
  }

  // ------------------------------------------------------------ start
  async function start({ sessions: list = [], allowSites = [], onCount, presetSites = [] } = {}) {
    allowed = new Set(allowSites.map((h) => String(h).replace(/^www\./, '').toLowerCase()));
    presetHosts = presetSites.map((h) => String(h).toLowerCase());
    if (onCount) onChange = onCount;
    loadDangerCache();
    try {
      blocker = await buildEngine();
      applyExceptions();
      // Hiding boxes on a page is the part most likely to break a site, so it
      // is skipped on YouTube and the school's sites, and on anywhere you have
      // chosen to let the ads through.
      const inject = blocker.onInjectCosmeticFilters;
      blocker.onInjectCosmeticFilters = async (e, url, msg) => (
        COSMETIC_OFF.test(url) || allowed.has(hostOf(url)) || presetHost(url) ? undefined : inject(e, url, msg)
      );
      blocker.on('request-blocked', (request) => {
        const id = request.tabId;
        if (!id) return;
        counts.set(id, (counts.get(id) || 0) + 1);
        onChange(id, counts.get(id));
      });
      for (const ses of list) enable(ses);
      feedDangerToEngine();
    } catch (e) { note({ tool: 'shield', error: e.message }); }
    const dangerAge = Date.now() - (stamp().dangerAt || 0);
    if (dangerAge > THREE_DAYS) fetchDanger().catch((e) => note({ tool: 'shield', error: e.message }));
  }

  return {
    start,
    enable,
    disable,
    verdict,
    ready: () => !!blocker,
    blockedOn: (id) => counts.get(id) || 0,
    forget: (id) => counts.delete(id),
    reset: (id) => { counts.set(id, 0); onChange(id, 0); },
    isAllowed: (url) => allowed.has(hostOf(url)),
    // Would this request be stopped? Used by the tests, and the honest answer
    // to "is the blocking actually on".
    matches(url, sourceUrl, type = 'script') {
      if (!blocker) return false;
      const { Request } = require('@ghostery/adblocker-electron');
      return blocker.match(Request.fromRawDetails({ url, sourceUrl, type })).match;
    },
    setAllowed(list) { allowed = new Set(list.map((h) => String(h).replace(/^www\./, '').toLowerCase())); applyExceptions(); },
    // The starting setup's own sites. Empty with no preset.
    setPresetHosts(list) { presetHosts = (list || []).map((h) => String(h).toLowerCase()); applyExceptions(); },
    status: () => ({
      on: !!blocker,
      // A prebuilt engine does not keep the names of the lists it was built
      // from, so the honest measure of what is loaded is how big it is.
      listsMB: (() => { try { return Math.round(fs.statSync(enginePath).size / 104857.6) / 10; } catch { return 0; } })(),
      dangerous: danger.size,
      listsAt: stamp().engineAt || 0,
      dangerAt: stamp().dangerAt || 0,
      allowed: [...allowed],
    }),
    refreshDanger: () => fetchDanger(),
    // "Check for new threats now" used to fetch only the list of dangerous
    // sites; the ad and tracker rules were left until their weekly rebuild, so
    // the button did half of what it said. This throws the old rules away and
    // fetches them again. The engine under a page that is already open is not
    // swapped mid-sentence - the new rules are in from the next time Cue opens.
    refreshAds: async () => {
      try { fs.rmSync(enginePath, { force: true }); } catch {}
      try { putStamp({ engineAt: 0 }); await buildEngine(); return true; }
      catch (e) { note({ tool: 'shield', error: `ad lists: ${e.message}` }); return false; }
    },
    hostOf,
  };
}

module.exports = { createShield, parseHosts };
