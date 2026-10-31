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
// thinks. YouTube's player and Studio break under cosmetic filtering, and the
// school's own sites carry no advertising to block in the first place.
const NEVER_TOUCH = [
  '@@||youtube.com^$document', '@@||youtube-nocookie.com^$document', '@@||ytimg.com^', '@@||googlevideo.com^',
  '@@||nathanielschool.com^$document', '@@||nathanielschool.com^',
  // CNN's player asks for this settings file about 3,000 times a second if it is refused, which
  // costs far more than the file. The ads it would lead to are still blocked.
  '@@||cdn-media.brightline.tv/config/$xmlhttprequest,domain=cnn.com',
];
const COSMETIC_OFF = /^https:\/\/([\w-]+\.)*(youtube\.com|youtube-nocookie\.com|nathanielschool\.com)\//;

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
  const counts = new Map();     // webContentsId -> how many requests were stopped
  let onChange = () => {};

  const stamp = () => { try { return JSON.parse(fs.readFileSync(stampPath, 'utf8')); } catch { return {}; } };
  const putStamp = (patch) => {
    try { fs.writeFileSync(stampPath, JSON.stringify({ ...stamp(), ...patch }, null, 2)); } catch {}
  };
  const note = (e) => { if (log) log(e); };

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
    const next = [...NEVER_TOUCH, ...mine];
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
  async function start({ sessions: list = [], allowSites = [], onCount } = {}) {
    allowed = new Set(allowSites.map((h) => String(h).replace(/^www\./, '').toLowerCase()));
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
        COSMETIC_OFF.test(url) || allowed.has(hostOf(url)) ? undefined : inject(e, url, msg)
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
    hostOf,
  };
}

module.exports = { createShield, parseHosts };
