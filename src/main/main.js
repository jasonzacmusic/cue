// Cue — the browser for people who make things.
// Main process: windows, tabs, identities, split views, the on-air stage and the AI port.
if (process.env.CUE_TEST && !process.env.CUE_REAL_SCREEN) require('../../test/hidden-windows');
const {
  app, BaseWindow, WebContentsView, session, ipcMain, Menu, shell, dialog, desktopCapturer, clipboard, protocol, net, webContents, screen, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { groupFor, groupList } = require('./groups');
const { OBS } = require('./obs');
const { startAgentPort } = require('./agent-port');
const { createUpdater, SAY: UPDATE_SAY } = require('./updater');
const { quietRefusal } = require('./update-core');
const { settle, settledMessage } = require('./settle');
const { Library } = require('./db');
const { Vault } = require('./vault');
const bills = require('./bills');
const tools = require('./page-tools');
const capture = require('./capture');
const importer = require('./importer');
const extensions = require('./extensions');
const { createVanish } = require('./vanish');
const vanishKeys = require('./vanish-keys');
const { PICTURE_IN_PICTURE, MINI_FILL, MINI_UNFILL, protectedSite } = require('./video');
const { whereToOpen, refuseOpen } = require('./signin');
const { shareLogins, hasTwoAccounts } = require('./shared-logins');
const { createShield } = require('./shield');
const chromeId = require('./identity');
const { makeWhatsApp, resolveWho, possessive, WA_HOST } = require('./whatsapp');
const { makeGmail } = require('./gmail');
const attachKit = require('./attach');
const presets = require('./presets');

app.setName('Cue');
if (process.env.CUE_USER_DATA) app.setPath('userData', process.env.CUE_USER_DATA);
app.commandLine.appendSwitch('disable-features', 'MediaRouter,Translate,OptimizationHints'); // Chrome services Cue never uses
if (process.env.CUE_QUIET) app.commandLine.appendSwitch('mute-audio'); // tests must not depend on, or play through, whatever headphones are connected
if (process.env.CUE_TEST) { app.commandLine.appendSwitch('use-mock-keychain'); app.setPath('downloads', path.join(app.getPath('userData'), 'downloads')); }
protocol.registerSchemesAsPrivileged([{ scheme: 'cue', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const CACHE_MB = 256; // per login; browsers that leave this open-ended quietly reach many gigabytes
const STORAGE_MB = 600; // everything a login may keep in caches before Cue trims it, sign-ins untouched
// The cache cap has to be set before Chromium starts, so read it straight from the settings file.
try {
  const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'cue.json'), 'utf8'));
  const cap = saved.settings.cacheCapMB && saved.settings.cacheCapMB !== 1024 ? saved.settings.cacheCapMB : CACHE_MB;
  app.commandLine.appendSwitch('disk-cache-size', String(cap * 1048576));
} catch { app.commandLine.appendSwitch('disk-cache-size', String(CACHE_MB * 1048576)); }
const ROOT = path.join(__dirname, '..');
const UI_HTML = path.join(ROOT, 'ui', 'index.html');
const STAGE_HTML = path.join(ROOT, 'ui', 'stage.html');
const START_URL = pathToFileURL(path.join(ROOT, 'ui', 'start.html')).href;
const TAB_PRELOAD = path.join(ROOT, 'preload', 'tab.js');
const UI_PRELOAD = path.join(ROOT, 'preload', 'ui.js');
const PAGES = path.join(ROOT, 'ui', 'pages');
const SIDE_MIN = 64; const SIDE_MAX = 420; const SIDE_EDGE = 8;
const TOOLBAR = 52;
const GAP = 8;
// A test run may take another port, so it never fights the installed Cue for 8813.
const AGENT_PORT = (process.env.CUE_TEST && Number(process.env.CUE_AGENT_PORT)) || 8813;
const AI_MIN = 320; const AI_MAX = 720; const AI_GRIP = 8;
const AI_HEAD = 38;
const STRIP = 44;
// A plain install has one Space, and you can add more and call them anything you like. A starting
// setup (presets.js) brings its own list. Renaming one has to carry every tab, login and layout
// filed under the old name with it, which is why it happens in one place.
const SPACES_DEFAULT = ['Home'];
const SPACES_MAX = 9;
const spacesDefault = () => presets.field('spaces', SPACES_DEFAULT);
// A Space is saved as { name, tint }. The tint is one of these swatches (ui.css draws each one,
// light and dark); the sidebar's colour comes from it, never from the name, so a Space called
// anything at all can wear any of them.
const SPACE_TINTS = ['rose', 'indigo', 'gold', 'green', 'blue', 'plum', 'teal', 'slate'];
// The colour each of these names already wore when the colour was looked up by name, so moving
// to stored tints changes nothing anyone can see. Any other name takes the next swatch in turn.
const NAME_TINT = { Teach: 'rose', Create: 'indigo', Business: 'gold', Build: 'green', Finance: 'rose' };
const tintFor = (name, i) => NAME_TINT[name] || SPACE_TINTS[i % SPACE_TINTS.length];
// Older profiles saved a plain list of names; read either shape, always hand back { name, tint }.
function spaceList() {
  const raw = store && Array.isArray(store.data.spaces) && store.data.spaces.length ? store.data.spaces : spacesDefault();
  const out = [];
  raw.forEach((x, i) => {
    const name = String((x && typeof x === 'object' ? x.name : x) || '').trim().slice(0, 18);
    if (!name || out.some((o) => o.name === name)) return;
    const tint = x && typeof x === 'object' && SPACE_TINTS.includes(x.tint) ? x.tint : tintFor(name, i);
    out.push({ name, tint });
  });
  return (out.length ? out : spacesDefault().map((name, i) => ({ name, tint: tintFor(name, i) }))).slice(0, SPACES_MAX);
}
const spaces = () => spaceList().map((x) => x.name);
const KITS = {
  teacher: { name: 'Teacher', what: 'On air, OBS and blurring private details on air' },
  music: { name: 'Music', what: 'Loop, transpose and speed for any video' },
  creator: { name: 'Creator', what: 'Thumbnail check, YouTube Studio and comments' },
  designer: { name: 'Designer', what: 'Colour picker, palettes, font finder, ruler, Boards' },
  video: { name: 'Video', what: 'Page capture, tab recording, GIFs, timestamps, frame grabs' },
  business: { name: 'Business', what: 'Bills radar and alert tray' },
};
// The panel is for the two tools he actually works with, not their consumer chats: Claude Code and
// Codex, the same pair he keeps in Chrome. It opens in whichever folder is open, so it arrives
// already signed in instead of asking him to log in again inside a panel.
const AI_HOME = { claudecode: 'https://claude.ai/code', codex: 'https://chatgpt.com/codex' };
const AI_NAMES = { claudecode: 'Claude Code', codex: 'Codex' };
// Links that belong to another app on the computer. These open straight away; anything else asks first.
const EXTERNAL = /^(mailto|tel|sms|facetime|zoommtg|zoomus|msteams|slack|spotify|whatsapp|webcal|obsproject):/i;
// The organisation's own password vault, only with its starting setup on (see teamImportOffered).
const teamSite = () => presets.field('teamSite', '');
const LABS_PAGE = 'https://labs.nathanielschool.com/products/cue';
const COUNT_HOSTS = /(^|\.)(mail\.google\.com|instagram\.com|youtube\.com|whatsapp\.com|facebook\.com|linkedin\.com)$/;

// The three logins are FOLDERS, and the folder is the thing you open.
//
// Why folders and not the old "+ P S A" row: that row was a setting you had to
// notice BEFORE you opened a tab, and a letter you had to decode. Nobody did.
// Every one of the 38 tabs in this browser ended up in School because the row
// was invisible in practice. A folder with a face on it is not a setting — it
// is a place, and you can see which one you are standing in.
//
// Folders REPLACE the identity row outright; they do not sit above it. Opening
// a folder does three things at once: it shows you the tabs that live in it, it
// is where the next new tab is born, and it is the cookie jar those tabs use.
// That is why each one stays signed in to its own Gmail, Instagram, YouTube and
// WhatsApp at the same time — one Electron session partition per folder.
//
// SPACES (Teach / Create / Business / Build) stay exactly what they were: a
// SEPARATE axis, the kind of work you are doing. A folder is WHOSE account;
// a Space is WHICH job. They are never merged. The tab list shows the tabs that
// are in both, and says out loud when tabs sit in another folder, so nothing
// can quietly disappear.
//
// Vanish is not a folder. It is a window that keeps nothing, so it has no tabs
// to hold and no account to stay signed in to. It keeps its own small button.
//
// ANY NUMBER OF PEOPLE. The folders are a list in the saved data (store.data.folders), one per
// person: { id, name, color, picture, email, lock, agents }. Each is PRIVATE - its own partition
// (persist:<id>), so its own cookies, WhatsApp link, Google, tabs, history and passwords - and
// nothing crosses between two folders unless the person pairs them (settings().sharedPairs).
// An id never changes, whatever the folder is renamed to. The AI agent lane and Vanish are built
// in, exactly as before, and are not in that list.
const BUILTIN = {
  agent: { name: 'AI agent', color: '#5F40CF', partition: 'persist:agent', picture: 'folder-ai.png', about: 'The account AI agents use' },
  vanish: { name: 'Vanish', color: '#8A939C', partition: 'vanish' }, // no "persist:" = memory only
};
// The owner's two folders, exactly as they looked before the list existed. An install that has
// run before gets these back when it first meets the list, so nothing about his window changes.
const LEGACY_FOLDERS = {
  personal: { name: 'Personal', color: '#2A64CC', picture: 'folder-personal.png', about: 'Your own account' },
  school: { name: 'School', color: '#C2410C', picture: 'folder-school.png', about: 'The school account' },
};
const NEUTRAL = '#5B6670';
const FOLDER_COLORS = ['#2A64CC', '#C2410C', '#2E7D4F', '#8A6A1F', '#1F6F8B', '#B4235A', '#6B5BD2', '#5B6670'];
const userFolders = () => (store && Array.isArray(store.data.folders) ? store.data.folders : []);
const folderById = (id) => userFolders().find((f) => f.id === id) || null;
// What IDENTITIES[k] used to be: a name, a colour, a partition, a picture. Null for a folder that
// does not exist (any more), which is how a removed folder can never be quietly stood in for.
function identityOf(k) {
  const f = folderById(k);
  if (f) return { name: f.name, color: f.color || NEUTRAL, partition: `persist:${f.id}`, picture: f.picture || '', about: f.about || '' };
  return Object.prototype.hasOwnProperty.call(BUILTIN, k) ? BUILTIN[k] : null;
}
// A person's folder, as opposed to the AI agent lane or Vanish.
const isPerson = (k) => !!folderById(k);
// Everything with tabs and a sidebar entry: every person's folder, then the AI agent lane.
const allFolders = () => [...userFolders().map((f) => f.id), 'agent'];
const isFolder = (k) => k === 'agent' || isPerson(k);
const folderName = (k) => (identityOf(k) || {}).name || String(k || '');
// The Google address a folder holds. Older Cue kept it in settings().identityLabels.
const emailOf = (k) => {
  const f = folderById(k);
  const e = (f && f.email) || ((store && settings().identityLabels) || {})[k] || '';
  return String(e).trim();
};

// ---- the lock
// A passcode per folder, never stored: a scrypt hash with its own random salt. A locked folder
// starts locked at every launch and locks again after settings().lockMinutes idle. While locked
// its tabs have no page in memory, nothing about it reaches the sidebar, and nothing - no new
// tab, no saved password, no quick key, no agent, no search - can reach into it.
const unlocked = new Set();
const lockTouched = {};
const lockTries = {};
const hasLock = (id) => { const f = folderById(id); return !!(f && f.lock && f.lock.hash && f.lock.salt); };
const isLocked = (id) => hasLock(id) && !unlocked.has(id);
const passHash = (code, salt) => crypto.scryptSync(String(code), Buffer.from(salt, 'hex'), 32).toString('hex');
function passOk(id, code) {
  const f = folderById(id);
  if (!f || !hasLock(id)) return true;
  const a = Buffer.from(passHash(code, f.lock.salt), 'hex'); const b = Buffer.from(f.lock.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Agents may work in a folder only when the person said so for that folder, and never while it
// is locked. The AI agent lane is theirs by definition.
const agentsMay = (id) => id === 'agent' || (isPerson(id) && folderById(id).agents === true && !isLocked(id));

// Sites that can be signed in as more than one person, and how to read the one
// that is live straight off the page. This is not a guess from a cookie: it is
// what the site itself is showing in its own corner, read after the page loads.
// Instagram is the reason this exists — it has its own account switcher inside
// one cookie jar, so the folder alone does not prove which account is live.
const WHOSE = [
  {
    key: 'instagram',
    host: /(^|\.)instagram\.com$/,
    label: 'Instagram',
    // The name or nothing. "Signed in" with no name is the kind of half-answer
    // that sends a post to the wrong account, so it is never said.
    read: `(() => {
      if (!/(?:^|; )ds_user_id=\\d+/.test(document.cookie)) return '';
      const a = document.querySelector('nav a[href^="/"][role="link"] img[alt]')
        || document.querySelector('img[alt$="profile picture"]');
      const n = a && /^(.+?)'s profile picture$/.exec(a.getAttribute('alt') || '');
      return n ? '@' + n[1] : '';
    })()`,
  },
  {
    key: 'google',
    host: /(^|\.)(google\.com|youtube\.com)$/,
    label: 'Google',
    // Only the address Google itself prints next to the account button. A
    // signed-out page that happens to carry a Google avatar must say nothing:
    // Gmail sends you to its advertising page when you are signed out, and
    // that page would otherwise read as "signed in".
    read: `(() => {
      const a = document.querySelector('a[aria-label*="Google Account"], a[aria-label*="Google-Konto"]');
      const m = a && /\\(([^()\\s]+@[^()\\s]+)\\)/.exec(a.getAttribute('aria-label') || '');
      return m ? m[1] : '';
    })()`,
  },
];

// What each folder is signed in as, as last read off a real page in it.
function whoseIn(folder) { return (store.data.whose && store.data.whose[folder]) || {}; }
function rememberWhose(folder, key, label, who) {
  if (!isFolder(folder)) return;
  store.data.whose = store.data.whose || {};
  const box = store.data.whose[folder] = store.data.whose[folder] || {};
  // Nothing read means the page could not tell us. Clear the old answer rather
  // than leave a stale name on the folder — a wrong name is worse than none.
  if (!who) { if (!box[key]) return; delete box[key]; pushState(); persist(); return; }
  if (box[key] && box[key].who === who) return;
  box[key] = { who, label, at: Date.now() };
  pushState(); persist();
}
// Read it off the page itself once it has settled. Costs one tiny script on the
// handful of sites that can be two people at once, and nothing anywhere else.
function sniffWhose(t) {
  if (!t || !t.view || !isFolder(t.identity)) return;
  let host = ''; try { host = new URL(t.url).hostname; } catch { return; }
  const site = WHOSE.find((w) => w.host.test(host));
  if (!site) return;
  const folder = t.identity;
  setTimeout(() => {
    if (!t.view || t.view.webContents.isDestroyed()) return;
    t.view.webContents.executeJavaScript(site.read, true)
      .then((who) => rememberWhose(folder, site.key, site.label, String(who || '').slice(0, 40)))
      .catch(() => {});
  }, 1500);
}

const ENGINES = {
  google: 'https://www.google.com/search?q=',
  images: 'https://www.google.com/search?udm=2&q=',
  youtube: 'https://www.youtube.com/results?search_query=',
  pinterest: 'https://www.pinterest.com/search/pins/?q=',
  github: 'https://github.com/search?type=repositories&q=',
  claude: 'https://claude.ai/new?q=',
  chatgpt: 'https://chatgpt.com/?q=',
};
const PREFIX = { yt: 'youtube', i: 'images', img: 'images', p: 'pinterest', pin: 'pinterest', gh: 'github', c: 'claude', ai: 'claude', gpt: 'chatgpt' };

const SPLITS = { single: 1, cols2: 2, rows2: 2, cols3: 3, grid4: 4 };

// ---------------------------------------------------------------- one Chrome identity, everywhere
// Google and Meta compare what the browser says in several places - the User-Agent line, the
// Sec-CH-UA headers, navigator.userAgent and navigator.userAgentData in the page, in its iframes
// and in its workers - and two answers that disagree are a "not Chrome" all by themselves. Every
// one of those is now fed from identity.js, and for EVERY session, whatever folder it belongs to:
// the hook is where Electron creates a session, not a list of the folders Cue knows about today.
// (The fallback is set before the app is ready, when the system's languages cannot be read yet, so
// it takes the user agent alone; the full identity is built on first use, after ready.)
app.userAgentFallback = chromeId.chromeIdentity({ languages: ['en-US'] }).userAgent;

// A small preload, written once per launch from identity.js so it can never drift from it. It runs
// in every top frame (where it only acts if the protocol override below did not land) and in every
// service worker (which the protocol cannot reach).
let identityPreload = '';
function identityPreloadFile() {
  if (identityPreload) return identityPreload;
  const file = path.join(app.getPath('userData'), 'identity-preload.js');
  const src = `// Written by Cue from src/main/identity.js at launch. Do not edit.\n`
    + `const { contextBridge } = require('electron');\n`
    + `try { contextBridge.executeInMainWorld({ func: ${chromeId.patchNavigator.toString()}, args: [${JSON.stringify(chromeId.pageData())}] }); } catch {}\n`;
  try { fs.writeFileSync(file, src); identityPreload = file; } catch (e) { console.error('identity preload', e.message); }
  return identityPreload;
}

const identityDone = new WeakSet();
function applyIdentity(ses) {
  if (!ses || identityDone.has(ses)) return;
  identityDone.add(ses);
  const id = chromeId.identity();
  // The Accept-Language list is the same list navigator.languages reports, so the two agree.
  ses.setUserAgent(id.userAgent, id.acceptLanguage);
  ses.webRequest.onBeforeSendHeaders((d, cb) => cb({ requestHeaders: chromeId.sayChrome(d.requestHeaders, d.url) }));
  const file = identityPreloadFile();
  if (file && ses.registerPreloadScript) {
    for (const type of ['frame', 'service-worker']) {
      try { ses.registerPreloadScript({ type, id: `cue-identity-${type}`, filePath: file }); } catch (e) { console.error('identity preload', type, e.message); }
    }
  }
}
app.on('session-created', (ses) => { if (app.isReady()) applyIdentity(ses); else app.whenReady().then(() => applyIdentity(ses)); });

// Chromium's own override, through its DevTools protocol, on every web page Cue makes - tabs,
// pop-ups, Peek, the AI panel, Vanish. It sets the user agent AND its client-hint metadata at the
// engine level, so the page, every same- and cross-origin iframe and every dedicated worker read
// one answer, and nothing on navigator is redefined for a page to catch. New iframes and workers
// are held for the instant it takes to dress them (waitForDebuggerOnStart), then let go - always,
// even if dressing failed, so a page can never be left hanging. Service and shared workers are not
// children of the page in the protocol (attaching to them from here fails); the service-worker
// preload above covers the first, and shared workers keep Chromium's own brand list.
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'service_worker', exclude: true }, { type: 'shared_worker', exclude: true }, {}] };
function wearIdentity(wc) {
  if (!wc || wc.isDestroyed() || wc.__identity) return;
  const dbg = wc.debugger;
  const send = (method, params, sid) => dbg.sendCommand(method, params, sid);
  const ov = chromeId.cdpOverride();
  const dress = async (sid, type) => {
    if (type === 'worker') await send('Network.setUserAgentOverride', ov, sid).catch(() => {});
    else await send('Emulation.setUserAgentOverride', ov, sid).catch(() => send('Network.setUserAgentOverride', ov, sid).catch(() => {}));
  };
  const attach = () => {
    try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch (e) { logProblem('identity', e); return false; }
    dress(undefined, 'page');
    send('Target.setAutoAttach', AUTO_ATTACH).catch(() => {});
    return true;
  };
  wc.__identity = true;
  dbg.on('message', async (_e, method, params) => {
    if (method !== 'Target.attachedToTarget') return;
    const sid = params.sessionId;
    const type = params.targetInfo && params.targetInfo.type;
    try {
      await dress(sid, type);
      if (type === 'iframe' || type === 'page') await send('Target.setAutoAttach', AUTO_ATTACH, sid).catch(() => {});
    } finally {
      send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
    }
  });
  // Something else detaching us (a crash, a tool that took over) must not leave a page undressed.
  let again = 0;
  dbg.on('detach', (_e, reason) => {
    if (wc.isDestroyed() || /target closed/i.test(String(reason)) || again++ > 3) return;
    setTimeout(() => { if (!wc.isDestroyed()) attach(); }, 200);
  });
  attach();
}
app.on('web-contents-created', (_e, wc) => {
  // The page's cross-origin iframes, remembered as they attach, so cue_attach can reach a file box in one.
  try { if (wc.getType() !== 'remote' && wc.getType() !== 'backgroundPage') attachKit.trackFrames(wc); } catch {}
  try { if (wc.getType() !== 'remote' && wc.getType() !== 'backgroundPage') wearIdentity(wc); } catch (e) { console.error('identity', e.message); }
});

// ---------------------------------------------------------------- state
let store;
let mainWin = null;
let uiView = null;
let stageWin = null;
let stageStandby = null;
let shield = null;
const obs = new OBS();
let drmReady = false;   // Widevine is loaded and shows can play
let drmLog = '';        // why it could not, if it could not
const tabs = [];
let activeId = null;
let programId = null;
let live = false;
let overlay = false;
let nextId = 1;
const closedStack = [];
const downloads = [];
const agentLog = [];
// The AI door. The key sits in a file in his account, so anything running as him
// could otherwise drive the browser: the door itself is the permission, and it is
// his switch, never a token's.
//
// It used to shut at every launch. It no longer does, because the work it carries
// now - an agent answering WhatsApp for him while he teaches - cannot wait for
// somebody to open a door first. So the switch is remembered: on means on until
// he turns it off, and Cue still says on screen when an agent reaches into a tab
// he did not hand it, still keeps every call in the log, and still refuses
// private tabs, Vanish tabs and the tab on air.
let doorOpen = false;
let lastKnock = 0;
const agentSeen = new Set();
const midiAsks = []; // test runs only: the sites Cue would have asked about MIDI
const sessionsReady = new Set();
const dangerOk = new Set();   // hosts you chose to open anyway, until Cue is closed
// Vanish keeps its own two per-site memories ("open it anyway" and "no secure address") and they
// go when the Vanish window closes, so nothing about where you went in there outlives it.
const vanishDangerOk = new Set();
const VANISH_NO_HTTPS = new Set();
const vanishLocationTold = new Set();
let pendingShare = null;
let lib = null;
let vault = null;
let pendingCred = null;
const autoTried = {};
let peek = null;
let aiView = null;
let stripOpen = false;
let recTabId = null;
let updater = null;
let sideReveal = false;
let vanish = null;
const locationTold = new Set();
let sharedLogins = null;
let heldCount = 0;
let repos = [];
let extDir = '';
const extsLoaded = new Set();

const settings = () => store.data.settings;
const copy = (text) => { if (!process.env.CUE_TEST) clipboard.writeText(text); };
const byId = (id) => tabs.find((t) => t.id === id);
const byWC = (wc) => tabs.find((t) => t.view && t.view.webContents === wc);
const isStart = (url) => !url || url === START_URL;
const sideWidth = () => Math.max(SIDE_MIN, Math.min(SIDE_MAX, settings().sideWidth || 248));
const sideSpace = () => (settings().sideHidden ? SIDE_EDGE : sideWidth());
const aiWidth = () => Math.max(AI_MIN, Math.min(AI_MAX, settings().aiWidth || 440));

// ---------------------------------------------------------------- sessions
// A folder that does not exist has no session. It used to fall back to Personal's, which is
// exactly how one person's page could open signed in as somebody else.
function sessionFor(identity) {
  const who = identityOf(identity);
  if (!who) throw new Error(`There is no folder called ${identity}.`);
  const ses = session.fromPartition(who.partition);
  if (sessionsReady.has(ses)) return ses;
  sessionsReady.add(ses);
  // A Vanish page's questions open over the Vanish window and its notices are said there; they
  // used to land on the main window, naming the Vanish site in front of anyone watching that.
  const isVanish = identity === 'vanish';
  const askOver = () => (isVanish && vanish && vanish.window()) || mainWin;
  const tell = (text) => { if (isVanish) { if (vanish) vanish.say(text); } else sendEvent('toast', text); };
  applyIdentity(ses); // already done where the session was created; this only makes sure
  enableBlocker(ses);
  if (identity === 'vanish') ses.setSpellCheckerEnabled(false);
  servePages(ses, isVanish);
  if (identity !== 'vanish') extensions.loadAll(ses, extDir).then((r) => r.forEach((x) => x.ok ? extsLoaded.add(x.id) : console.error('extension', x.name, x.error)));
  ses.webRequest.onErrorOccurred((d) => {
    if (d.error === 'net::ERR_BLOCKED_BY_CLIENT' || d.error === 'net::ERR_ABORTED' || !d.webContents) return;
    const t = byWC(d.webContents); if (t) logTab(t, 'failed-request', `${d.error} ${d.url}`);
  });

  // 'window-management' (the layout of every screen on this computer) is no longer handed to any
  // page that asks: it reads like a fingerprint, and Chrome asks first too. Allowed by hand only.
  // 'storage-access' is a box on a page asking to reach its own cookies while it
  // sits inside another site. Saying no to it breaks the invisible checks that
  // guard sign-in forms: Netflix's sign-in simply fails with "Something's not
  // quite right", and card payments and single sign-on go the same way. Chrome
  // allows it. Cue stops the actual tracking earlier, in the blocker, so what
  // still gets this far is a login box, a payment box or a guard like that.
  const QUIET_OK = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'speaker-selection', 'storage-access', 'top-level-storage-access']);
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    if (QUIET_OK.has(permission)) return true;
    if (permission === 'midi' || permission === 'midiSysex') return midiOk(identity, safeOrigin(origin));
    if (permission === 'notifications') return !live && identity !== 'vanish';
    return store.data.permissions[`${identity}|${safeOrigin(origin)}|${permission}`] === true;
  });

  ses.setPermissionRequestHandler(async (wc, permission, cb, details) => {
    const always = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'speaker-selection', 'storage-access', 'top-level-storage-access'];
    if (always.includes(permission)) return cb(true);
    if (permission === 'notifications') return cb(!live && identity !== 'vanish');
    if (permission === 'openExternal') {
      const link = details.externalURL || '';
      const from = byWC(wc);
      if (identity !== 'vanish' && (!from || from.agent)) return cb(false);
      if (EXTERNAL.test(link)) { if (from) logTab(from, 'external', link); return cb(!process.env.CUE_TEST); }
      const r = await dialog.showMessageBox(askOver(), { type: 'question', buttons: ['Open', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Open this link in another app?', detail: link.slice(0, 200) });
      return cb(r.response === 0);
    }
    // Location is never handed out by a prompt. Google asks on almost every
    // search and a dialog mid-class is worse than useless, so where you are
    // simply does not leave this machine. A site that genuinely needs it is
    // allowed by hand on the Privacy page, and that is the only way in.
    if (permission === 'geolocation') {
      const origin = safeOrigin(details.requestingUrl || wc.getURL());
      const allowed = store.data.permissions[`${identity}|${origin}|geolocation`] === true;
      if (!allowed) {
        const x = byWC(wc); if (x) logTab(x, 'blocked', 'location');
        const told = isVanish ? vanishLocationTold : locationTold;
        if (!told.has(origin)) { told.add(origin); tell(`${origin} asked where you are. Blocked.`); }
      }
      return cb(allowed);
    }
    // Web MIDI reaches the instruments themselves, and a system message can
    // change settings on a keyboard or a module. Chrome asks; Cue used to hand
    // it over without a word. Our own apps are the exception, because teaching
    // with them is the job. One answer covers plain MIDI and system messages.
    if (permission === 'midi' || permission === 'midiSysex') {
      const origin = safeOrigin(details.requestingUrl || wc.getURL());
      if (Vault.ownSite(origin)) return cb(true);
      const key = `${identity}|${origin}|midi`;
      const remembered = store.data.permissions[key];
      if (remembered !== undefined) return cb(remembered);
      if (process.env.CUE_TEST) { midiAsks.push(origin); return cb(false); } // a test never waits on a dialog; it is told Cue would have asked
      const r = await dialog.showMessageBox(askOver(), {
        type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1,
        message: `${origin} wants to send and receive MIDI with your instruments.`,
        detail: 'It can also change settings on them. Allow this only for a site you trust with your gear.',
        ...(identity === 'vanish' ? {} : { checkboxLabel: 'Remember for this site', checkboxChecked: true }),
      });
      const ok = r.response === 0;
      if (r.checkboxChecked && identity !== 'vanish') { store.data.permissions[key] = ok; store.save(); }
      const x = byWC(wc); if (x && !ok) logTab(x, 'blocked', 'MIDI');
      return cb(ok);
    }
    if (permission === 'media') {
      const origin = safeOrigin(details.requestingUrl || wc.getURL());
      const key = `${identity}|${origin}|${permission}`;
      const remembered = store.data.permissions[key];
      const keepAwake = (ok) => { const x = byWC(wc); if (x && ok && permission === 'media') x.holdAwake = true; return ok; };
      if (remembered !== undefined) return cb(keepAwake(remembered));
      const what = (details.mediaTypes || []).map((m) => (m === 'video' ? 'camera' : 'microphone')).join(' and ') || 'microphone';
      const r = await dialog.showMessageBox(askOver(), {
        type: 'question', buttons: ['Allow', 'Block'], defaultId: 0, cancelId: 1,
        message: `${origin} wants to use your ${what}.`, ...(identity === 'vanish' ? {} : { checkboxLabel: 'Remember for this site', checkboxChecked: true }),
      });
      const ok = r.response === 0;
      if (r.checkboxChecked && identity !== 'vanish') { store.data.permissions[key] = ok; store.save(); }
      return cb(keepAwake(ok));
    }
    cb(false);
  });

  ses.setDisplayMediaRequestHandler((request, callback) => {
    // Vanish never shares the screen. The share picker lives in the main window and lists the
    // main window's tabs, which is two windows' worth of things a Vanish page should not see.
    if (isVanish) {
      if (vanish) vanish.say('Vanish does not share your screen. Use Cue\u2019s main window for that call.');
      callback(null); // null is Electron's refusal; the page hears "not allowed"
      return;
    }
    if (pendingShare) pendingShare({});
    pendingShare = callback;
    try { const x = byWC(webContents.fromFrame(request.frame)); if (x) x.holdAwake = true; } catch {}
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .catch(() => [])
      .then((sources) => {
        setOverlay(true);
        sendEvent('share-picker', {
          tabs: tabs.filter((t) => t.view && !t.private && t.identity === identity).map((t) => ({ id: t.id, title: t.title, url: t.url })),
          sources: sources.map((s) => ({ id: s.id, name: s.name })),
        });
      });
  });

  ses.on('will-download', (_e, item, fromWc) => {
    const bad = shield && settings().warnDangerous !== false && shield.verdict(item.getURL());
    const forAgent = identity !== 'vanish' ? takeAgentDownload(item, fromWc) : null;
    if (bad) { item.cancel(); if (forAgent) forAgent.fail(`Cue stopped that download: ${shield.hostOf(item.getURL())} is reported for ${bad}.`); tell(`Cue stopped a download from ${shield.hostOf(item.getURL())}. That site is reported for ${bad}.`); return; }
    // An agent's download goes to Downloads/Cue Agents, with no save dialog (cue_download).
    const dir = forAgent ? agentDownloadDir() : app.getPath('downloads');
    let name = item.getFilename(); let file = path.join(dir, name); let n = 1;
    while (fs.existsSync(file) || downloads.some((x) => x.file === file && x.state === 'progressing')) { const ext = path.extname(name); file = path.join(dir, `${path.basename(name, ext)} (${n++})${ext}`); }
    // Vanish leaves no file behind unless you choose where it goes.
    if (identity === 'vanish') item.setSaveDialogOptions({ title: 'Vanish tab: save this file?', defaultPath: file });
    else item.setSavePath(file);
    if (identity === 'vanish') { // the save dialog is the only trace, and it is yours
      item.once('done', (_ev, state) => { if (state === 'completed') markDownloaded(item.getSavePath()); });
      return;
    }
    if (forAgent) forAgent.started(item, file);
    if (RUNS_ITSELF.test(name) && !process.env.CUE_TEST && !forAgent) {
      item.pause();
      dialog.showMessageBox(mainWin, { type: 'warning', buttons: ['Cancel', 'Keep'], defaultId: 0, cancelId: 0, message: `${name} runs as a program when you open it.`, detail: 'Keep it only if you know who it came from.' })
        .then((r) => { if (r.response === 1) item.resume(); else item.cancel(); });
    }
    // Filed under the folder it came from: the downloads list shows one folder's files only.
    const d = { id: Date.now() + Math.random(), name: path.basename(file), file, kind: fileKind(file), received: 0, total: item.getTotalBytes(), state: 'progressing', folder: identity };
    downloads.unshift(d); downloads.length = Math.min(downloads.length, 30);
    item.on('updated', (_ev, state) => { d.received = item.getReceivedBytes(); d.state = state; pushState(); });
    item.once('done', (_ev, state) => {
      d.state = state; d.received = item.getReceivedBytes();
      if (state === 'completed') d.total = d.received;
      if (item.getSavePath()) { d.file = item.getSavePath(); d.name = path.basename(d.file); }
      if (state === 'completed') markDownloaded(d.file, item.getURL());
      pushState();
    });
    pushState();
    warnLowDisk(item, dir);
  });
  return ses;
}

const KINDS = {
  Installers: ['.dmg', '.pkg', '.exe', '.msi', '.deb', '.rpm', '.appimage'],
  Video: ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'],
  Audio: ['.wav', '.mp3', '.flac', '.aiff', '.aif', '.m4a', '.ogg', '.mid', '.midi'],
  Images: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic', '.psd'],
  Documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.md', '.musicxml', '.mscz'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz'],
};
// Files that run as a program on a double-click, on this kind of computer.
const RUNS_ITSELF = {
  darwin: /\.(command|terminal|tool|workflow|action|jar|scpt|sh)$/i,
  win32: /\.(exe|msi|msp|bat|cmd|com|ps1|vbs|vbe|js|jse|wsf|scr|hta|reg|cpl|lnk|jar)$/i,
}[process.platform] || /\.(sh|run|appimage|desktop|jar)$/i;
// macOS only lets Gatekeeper check a file that is marked as downloaded. Chrome and
// Safari write that mark; without it an installer from the web would open with no
// check at all, so Cue writes it on every finished download.
function markDownloaded(file, from) {
  if (process.platform !== 'darwin' || !file) return;
  const stamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  const value = `0001;${stamp};Cue;${crypto.randomUUID()}`;
  execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, file], () => {});
  if (from) {
    // "Where from" in Finder's Get Info, the same as any other browser.
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>${String(from).replace(/[<&]/g, '')}</string></array></plist>`;
    execFile('/usr/bin/xattr', ['-w', 'com.apple.metadata:kMDItemWhereFroms', plist, file], () => {});
  }
}

function fileKind(file) {
  const ext = path.extname(file).toLowerCase();
  return Object.keys(KINDS).find((k) => KINDS[k].includes(ext)) || 'Other';
}

// A big download on a nearly full disk pauses and asks first.
function warnLowDisk(item, dir) {
  try {
    const st = fs.statfsSync(dir);
    const free = st.bavail * st.bsize; const size = item.getTotalBytes();
    const floor = (settings().lowDiskGB || 5) * 1073741824;
    if (free - size >= floor) return;
    item.pause();
    const gb = (n) => (n / 1073741824).toFixed(1);
    const r = dialog.showMessageBoxSync(mainWin, {
      type: 'warning', buttons: ['Download anyway', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Your disk is nearly full (${gb(free)} GB free).`,
      detail: size ? `${item.getFilename()} needs ${gb(size)} GB.` : `${item.getFilename()} has an unknown size.`,
    });
    if (r === 0) item.resume(); else item.cancel();
  } catch {}
}

// Installers you opened go to the Trash a day later, so old copies don't pile up.
function tidyInstallers() {
  if (!settings().tidyInstallers) return;
  const list = store.data.installersOpened || [];
  const day = Date.now() - 86400000;
  store.data.installersOpened = list.filter((i) => {
    if (i.at > day) return true;
    if (fs.existsSync(i.file)) shell.trashItem(i.file).catch(() => {});
    return false;
  });
  store.save();
}

// Serves Cue's own pages, such as cue://boards. Only files in the pages folder can be reached.
// Vanish gets only the dangerous-site warning, which Cue itself puts up there; Library, Bills and
// Boards hold his history and his money, and none of it is served into a Vanish tab.
const VANISH_PAGES = new Set(['danger.html', 'danger.js', 'offline.html', 'offline.js', 'pages.css']);
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";
function servePages(ses, vanishOnly) {
  if (ses.protocol.isProtocolHandled('cue')) return;
  ses.protocol.handle('cue', (req) => {
    // Cue's own pages are never a frame inside somebody else's page.
    const dest = req.headers.get('sec-fetch-dest') || '';
    if (['iframe', 'frame', 'object', 'embed'].includes(dest)) return new Response('Not allowed', { status: 403 });
    const u = new URL(req.url);
    const rel = u.pathname.replace(/^\/+/, '') || `${u.hostname}.html`;
    if (vanishOnly && !VANISH_PAGES.has(rel)) return new Response('Not in Vanish', { status: 403 });
    const file = path.normalize(path.join(PAGES, rel));
    if (!file.startsWith(PAGES + path.sep) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    // Each page runs only its own script file: nothing written into the page, no other site's code.
    return net.fetch(pathToFileURL(file).href).then((r) => {
      if (!/\.html$/i.test(file)) return r;
      const headers = new Headers(r.headers);
      headers.set('Content-Security-Policy', PAGE_CSP);
      return new Response(r.body, { status: r.status, headers });
    });
  });
}

function enableBlocker(ses) {
  if (shield && settings().blockAds !== false) shield.enable(ses);
}

function safeOrigin(url) { try { return new URL(url).origin; } catch { return url; } }

// Sites that are never allowed to pop a notification up over whatever he is
// doing. WhatsApp is here because it is the loudest thing on the machine: two
// accounts, class groups, leads, every one of them banging a box onto the screen
// mid-lesson. The messages still arrive and the sidebar still shows the count -
// only the pop-up stops. By site, so it covers both folders at once. He can
// change the list in Settings.
// Apps that open silent. WhatsApp is one by default: its ding is the loudest
// thing on the machine and he never wants it. YouTube and the film services are
// not, because sound is the point of them. A tab of one of these sites opens
// muted, and unmuting it by hand still works - this only decides how it starts.
function mutedSite(url) {
  const h = String(hostOf(url) || '').toLowerCase();
  if (!h) return false;
  return (settings().muteSites || []).some((x) => {
    const q = String(x || '').trim().toLowerCase().replace(/^www\./, '');
    return !!q && (h === q || h.endsWith(`.${q}`));
  });
}
function quietSite(url) {
  const h = String(hostOf(url) || '').toLowerCase();
  if (!h) return false;
  return (settings().quietSites || []).some((s) => {
    const q = String(s || '').trim().toLowerCase().replace(/^www\./, '');
    return !!q && (h === q || h.endsWith(`.${q}`));
  });
}
// Our own apps may talk to his instruments without asking. Everything else is
// off until he says yes for that one site, and one answer covers plain MIDI and
// the system messages that can change settings on the gear.
function midiOk(identity, origin) {
  if (Vault.ownSite(origin)) return true;
  return store.data.permissions[`${identity}|${origin}|midi`] === true;
}

// ---------------------------------------------------------------- folders
// The folder you have open. A new tab is born in it, and the sidebar shows the
// tabs that live in it. Kept in the store, like the Space, so it survives a
// restart and every way of opening a tab agrees on where the tab goes.
// The first person's folder that is not locked, or failing that the first folder at all.
const firstFolder = () => {
  const list = userFolders();
  return ((list.find((f) => !isLocked(f.id)) || list[0]) || { id: 'agent' }).id;
};
// A Space remembers the folder it usually opens in. A folder that has since been removed is never
// used: it falls back to the default folder, then to the first one there is.
const usualFolderFor = (space) => {
  const want = (settings().spaceLogins || {})[space];
  if (isPerson(want)) return want;
  const d = settings().defaultIdentity;
  return isFolder(d) ? d : firstFolder();
};
function openFolder() { return isFolder(store.data.folder) ? store.data.folder : usualFolderFor(store.data.space); }
// A tab asked for in another Space belongs to that Space's usual folder; one
// asked for here belongs in the folder that is open in front of you.
function folderForNewTab(space) {
  if (space && space !== store.data.space) return usualFolderFor(space);
  return openFolder();
}
// Called whenever a tab becomes the one you are looking at. The folder follows
// the tab, never the other way round, so the tab in front of you is always one
// of the tabs its folder is showing. Nothing can be active but out of sight.
function followFolder(t) {
  if (!t || !isFolder(t.identity) || store.data.folder === t.identity) return;
  store.data.folder = t.identity;
  buildMenu(); // the nine belong to the folder, so the accelerators move with it
}
// The pinned strip holds the same handful of apps in every folder, so clicking
// one means "this app, as whoever I am right now": his own WhatsApp in Personal,
// the school's in School. It goes to the tab this folder already has for that
// site, and only opens one when the folder has none.
function openApp(url) {
  const who = openFolder();
  if (isLocked(who)) { askUnlock(who); return; }
  const host = hostOf(url);
  const mine = (t) => t.identity === who && t.id !== programId && hostOf(t.url) === host;
  const inSpace = spaceOrder().filter(mine).sort((a, b) => b.lastActive - a.lastActive)[0];
  const anywhere = tabs.filter(mine).sort((a, b) => b.lastActive - a.lastActive)[0];
  const best = inSpace || anywhere;
  if (best) activate(best.id); else openTab({ url: googleForFolder(url, who), identity: who });
}

function setFolder(name) {
  if (!isFolder(name)) return;
  // A locked folder asks for its passcode first, in a small sheet in the sidebar. Nothing about
  // it is shown until the right one is typed.
  if (isLocked(name)) { askUnlock(name); return; }
  // Already open, with one of its own tabs in front: nothing to do. (Just unlocked, with nothing
  // in front yet, it still has to land somewhere.)
  if (store.data.folder === name && (byId(activeId) || {}).identity === name) return;
  // What he is looking at as he switches. Going from his WhatsApp to the
  // school's should land on the school's WhatsApp, not on whatever the school
  // happened to touch last: the folder changes, the job does not.
  const leaving = byId(activeId);
  const site = leaving && !leaving.url.startsWith('cue://') ? hostOf(leaving.url) : '';
  store.data.folder = name;
  buildMenu(); // this folder's own nine
  if (aiView) openAI(aiWhich()); // Claude Code and Codex follow him into the folder he just opened

  // Land on something that is actually in this folder, in this Space, so the
  // page in front of you matches the folder you just opened.
  const here = spaceOrder().filter((t) => t.identity === name && t.id !== programId);
  const recent = here.sort((a, b) => b.lastActive - a.lastActive);
  const first = (site && recent.find((t) => hostOf(t.url) === site)) || recent[0];
  lockTouched[name] = Date.now();
  // A folder with nothing open here gets a new tab of its own. Leaving the last folder's page on
  // screen would put one person's page under another person's folder.
  if (first) activate(first.id); else openTab({ identity: name });
}

// ---------------------------------------------------------------- people: add, lock, remove
// The small sheet in the sidebar that asks for a folder's passcode.
function askUnlock(id) {
  const f = folderById(id);
  if (!f) return;
  const t = lockTries[id];
  const wait = t && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 1000) : 0;
  sendEvent('unlock', { id, name: f.name, color: f.color || NEUTRAL, picture: f.picture || '', wait });
}

// Five wrong tries and the sheet waits a minute before it takes another.
const LOCK_TRIES = 5;
const LOCK_WAIT_MS = 60000;
function tryUnlock(id, code) {
  const f = folderById(id);
  if (!f) return { error: 'That folder is not there any more.' };
  if (!isLocked(id)) return { ok: true };
  const t = lockTries[id] = lockTries[id] || { n: 0, until: 0 };
  if (t.until > Date.now()) return { error: `Too many wrong tries. Wait ${Math.ceil((t.until - Date.now()) / 1000)} seconds, then try again.`, wait: Math.ceil((t.until - Date.now()) / 1000) };
  if (!passOk(id, code)) {
    t.n += 1;
    if (t.n >= LOCK_TRIES) { t.n = 0; t.until = Date.now() + LOCK_WAIT_MS; return { error: 'That passcode is not right. That was the fifth try, so wait a minute before the next one.', wait: LOCK_WAIT_MS / 1000 }; }
    return { error: `That passcode is not right. ${LOCK_TRIES - t.n} tr${LOCK_TRIES - t.n === 1 ? 'y' : 'ies'} left before a one-minute wait.` };
  }
  delete lockTries[id];
  unlocked.add(id);
  lockTouched[id] = Date.now();
  buildMenu();
  pushState();
  return { ok: true };
}

// Locks a folder now: every tab of it loses its page from memory (the tab itself stays, and comes
// back when the folder is unlocked), it leaves the screen, the stage and the cue, and the sidebar
// moves to a folder that is open - or shows the passcode sheet if there is none.
function lockFolder(id) {
  if (!hasLock(id)) return false;
  unlocked.delete(id);
  for (const t of tabs) {
    if (t.identity !== id) continue;
    if (stageIds.includes(t.id) || t.id === programId) {
      if (t.view) { try { t.view.webContents.send('cue:safe', false); } catch {} }
      if (t.host === 'stage' && t.view) { try { stageWin.contentView.removeChildView(t.view); } catch {} }
      stageIds = stageIds.filter((x) => x !== t.id);
      if (programId === t.id) { programId = stageIds[0] || null; if (!programId) showStandby(); }
    }
    if (t.popout) { const w = t.popout; t.popout = null; t.mini = false; try { w.destroy(); } catch {} }
    t.host = 'main';
    if (recTabId === t.id) { sendEvent('rec-stop'); recTabId = null; }
    destroyView(t);
    t.sleeping = true;
  }
  cueIds = cueIds.filter((x) => (byId(x) || {}).identity !== id);
  if (cueNextId && !cueIds.includes(cueNextId)) cueNextId = cueIds[0] || null;
  const sp = store.data.split;
  sp.ids = sp.ids.filter((x) => (byId(x) || {}).identity !== id);
  fitSplit(sp);
  if (peek && peek.identity === id) closePeek();
  if (aiView && aiIdentity === id) toggleAI();
  closePopupsOf(id);
  if (pendingCred && pendingCred.identity === id) pendingCred = null;
  if (openFolder() === id) {
    const other = userFolders().find((f) => f.id !== id && !isLocked(f.id));
    if (other) {
      store.data.folder = other.id;
      const next = spaceOrder().filter((t) => t.identity === other.id).sort((a, b) => b.lastActive - a.lastActive)[0];
      if (next) activate(next.id); else openTab({ identity: other.id });
    } else askUnlock(id);
  }
  if ((byId(activeId) || {}).identity === id) {
    const next = sidebarOrder().find((t) => t.identity === openFolder());
    activeId = next ? next.id : null;
  }
  buildMenu();
  layout(); pushState(); persist();
  return true;
}

// Idle re-lock. The folder in front of you counts as used while the computer is in use; a folder
// you have left counts from the moment you left it. Never mid-class: a lock that fired while he
// teaches would pull the tab off the stage in front of the students.
function lockSweep({ now = Date.now(), idle } = {}) {
  const mins = Number(settings().lockMinutes ?? 15);
  if (!mins || live) return [];
  let idleS = idle;
  if (idleS === undefined) { try { idleS = powerMonitor.getSystemIdleTime(); } catch { idleS = 0; } }
  const locked = [];
  for (const f of userFolders()) {
    if (!hasLock(f.id) || !unlocked.has(f.id)) continue;
    if (f.id === openFolder() && idleS < 60) lockTouched[f.id] = now;
    if (now - (lockTouched[f.id] || 0) >= mins * 60000) { lockFolder(f.id); locked.push(f.id); }
  }
  return locked;
}

// Sets, changes or removes a folder's passcode. Changing or removing one needs the current one.
function setPasscode({ id, current, code }) {
  const f = folderById(id);
  if (!f) return { error: 'That folder is not there any more.' };
  if (hasLock(id) && !passOk(id, current)) return { error: 'The current passcode is not right, so nothing was changed.' };
  const next = String(code || '');
  if (!next) {
    f.lock = null; unlocked.delete(id); delete lockTries[id];
    store.save(); pushState(); buildMenu();
    return { ok: true, locked: false };
  }
  if (next.length < 4) return { error: 'Use at least four characters.' };
  const salt = crypto.randomBytes(16).toString('hex');
  f.lock = { salt, hash: passHash(next, salt) };
  unlocked.add(id); lockTouched[id] = Date.now();
  store.save(); pushState(); buildMenu();
  return { ok: true, locked: true };
}

// A new person's folder. The id is made up here and never changes; the name is theirs to change.
function newFolderId() {
  for (;;) {
    const id = `f${crypto.randomBytes(8).toString('hex').split('').map((h) => (parseInt(h, 16) % 36).toString(36)).join('').slice(0, 8)}`;
    if (!identityOf(id) && id !== 'vanish') return id;
  }
}
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40);
function nameTaken(name, except) {
  const n = cleanName(name).toLowerCase();
  return userFolders().some((f) => f.id !== except && cleanName(f.name).toLowerCase() === n);
}
// `id` is only for the test rig and the upgrade above, which need the owner's own ids.
function addFolder({ name, color, id } = {}) {
  let nm = cleanName(name);
  if (!nm) { let i = userFolders().length + 1; do { nm = `Person ${i++}`; } while (nameTaken(nm)); }
  if (nameTaken(nm)) return { error: `There is already a folder called ${nm}. Give this one another name.` };
  if (['vanish', 'agent', 'ai agent'].includes(nm.toLowerCase())) return { error: `${nm} is a name Cue keeps for itself. Pick another.` };
  const fid = id && /^[a-z][a-z0-9]{1,30}$/.test(id) && !identityOf(id) && id !== 'vanish' ? id : newFolderId();
  const c = /^#[0-9a-f]{6}$/i.test(String(color || '')) ? color : FOLDER_COLORS[userFolders().length % FOLDER_COLORS.length];
  // New folders are private in every sense: no shared sign-ins, no agents, no passcode yet.
  const f = { id: fid, name: nm, color: c, picture: '', email: '', lock: null, agents: false };
  store.data.folders.push(f);
  store.save(); buildMenu(); pushState();
  return { ok: true, folder: f };
}
function renameFolder({ id, name }) {
  const f = folderById(id); const nm = cleanName(name);
  if (!f || !nm) return { error: 'Give the folder a name.' };
  if (nameTaken(nm, id)) return { error: `There is already a folder called ${nm}.` };
  if (['vanish', 'agent', 'ai agent'].includes(nm.toLowerCase())) return { error: `${nm} is a name Cue keeps for itself. Pick another.` };
  f.name = nm;
  store.save(); buildMenu(); pushState();
  return { ok: true };
}
function recolorFolder({ id, color }) {
  const f = folderById(id);
  if (!f || !/^#[0-9a-f]{6}$/i.test(String(color || ''))) return { error: 'That is not a colour Cue can use.' };
  f.color = color; store.save(); pushState();
  return { ok: true };
}
function setFolderEmail({ id, email }) {
  const f = folderById(id);
  if (!f) return { error: 'That folder is not there any more.' };
  f.email = String(email || '').trim().slice(0, 120);
  if (settings().identityLabels) settings().identityLabels[id] = f.email;
  store.save(); pushState();
  return { ok: true };
}
function setFolderAgents({ id, on }) {
  const f = folderById(id);
  if (!f) return { error: 'That folder is not there any more.' };
  f.agents = !!on; store.save(); pushState();
  return { ok: true };
}

// ---- sharing sign-ins between two folders, only where the person paired them
const sharing = new Map();
const pairKey = (a, b) => [a, b].sort().join('|');
const pairs = () => (Array.isArray(settings().sharedPairs) ? settings().sharedPairs : [])
  .filter((p) => Array.isArray(p) && p.length === 2 && p[0] !== p[1] && isPerson(p[0]) && isPerson(p[1]));
const pairShared = (a, b) => pairs().some(([x, y]) => (x === a && y === b) || (x === b && y === a));
const partnersOf = (id) => pairs().flatMap(([x, y]) => (x === id ? [y] : y === id ? [x] : []));
function wireSharing() {
  const want = new Map();
  for (const [a, b] of pairs()) want.set(pairKey(a, b), [a, b]);
  for (const [k, [a, b]] of want) if (!sharing.has(k)) sharing.set(k, shareLogins(sessionFor(a), sessionFor(b)));
  for (const [k, h] of sharing) if (!want.has(k)) { h.stop(); sharing.delete(k); }
}
// Fill in what the folders paired with this one are missing. Nothing at all for a folder that is
// paired with nobody - which is every folder, until the person says otherwise.
async function syncShared(id) {
  for (const [k, h] of sharing) if (!id || k.split('|').includes(id)) await h.syncNow().catch(() => {});
}
function setShared({ a, b, on }) {
  if (!isPerson(a) || !isPerson(b) || a === b) return { error: 'Pick two different folders.' };
  const list = pairs().filter(([x, y]) => pairKey(x, y) !== pairKey(a, b));
  if (on) list.push([a, b]);
  settings().sharedPairs = list;
  store.save(); wireSharing();
  if (on) syncShared(a).catch(() => {});
  pushState();
  return { ok: true };
}

// What the Settings room shows: every folder, with the details only an unlocked folder gives up.
function folderRows() {
  return userFolders().map((f) => {
    const locked = isLocked(f.id);
    const row = { id: f.id, name: f.name, color: f.color || NEUTRAL, picture: f.picture || '', locked, hasLock: hasLock(f.id), open: f.id === openFolder() };
    if (locked) return row;
    return { ...row, email: emailOf(f.id), agents: f.agents === true, shared: partnersOf(f.id) };
  });
}

// Removing a person's folder takes everything of theirs with it: tabs, sign-ins and site data,
// history, bookmarks, Boards, passwords, quick keys, saved alerts and bills. The partition itself
// goes to the Trash, never straight to deletion, so a folder removed by mistake can still be dug
// out. The last folder cannot be removed, and a locked one must be unlocked first.
async function removeFolder({ id, confirmed } = {}) {
  const f = folderById(id);
  if (!f) return { error: 'That folder is not there any more.' };
  if (userFolders().length <= 1) return { error: `${f.name} is the only folder, so it stays. Add another folder first if you want this one gone.` };
  if (isLocked(id)) return { error: `${f.name} is locked. Unlock it first, then remove it.` };
  if (!confirmed) {
    if (process.env.CUE_TEST) return { error: 'Not confirmed.' };
    const r = await dialog.showMessageBox(mainWin, {
      type: 'warning', buttons: [`Remove ${f.name}`, 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Remove ${f.name}'s folder?`,
      detail: `Its tabs close, and its sign-ins, history, bookmarks, Boards and saved passwords are removed from Cue. The folder's site data goes to the Trash. This cannot be undone from inside Cue.`,
    });
    if (r.response !== 0) return { error: 'Cancelled.' };
  }
  // Somewhere else to stand first, so nothing that follows reopens this folder.
  const other = userFolders().find((x) => x.id !== id && !isLocked(x.id)) || userFolders().find((x) => x.id !== id);
  if (openFolder() === id) store.data.folder = other.id;
  for (const t of [...tabs]) {
    if (t.identity !== id) continue;
    if (t.id === programId) { programId = null; showStandby(); }
    stageIds = stageIds.filter((x) => x !== t.id);
    if (t.popout) { const w = t.popout; t.popout = null; try { w.destroy(); } catch {} }
    if (recTabId === t.id) { sendEvent('rec-stop'); recTabId = null; }
    destroyView(t);
    tabs.splice(tabs.indexOf(t), 1);
  }
  const gone = (x) => !byId(x);
  cueIds = cueIds.filter((x) => !gone(x)); if (cueNextId && gone(cueNextId)) cueNextId = cueIds[0] || null;
  store.data.split.ids = store.data.split.ids.filter((x) => !gone(x)); fitSplit(store.data.split);
  for (const sp of Object.values(store.data.spaceSplit || {})) { sp.ids = (sp.ids || []).filter((x) => !gone(x)); fitSplit(sp); }
  if (peek && peek.identity === id) closePeek();
  if (aiView && aiIdentity === id) toggleAI();
  closePopupsOf(id);
  if (pendingCred && pendingCred.identity === id) pendingCred = null;
  // No more sharing with it.
  settings().sharedPairs = pairs().filter(([a, b]) => a !== id && b !== id);
  wireSharing();
  // Its session: cleared, then the folder on disk to the Trash.
  let trashed = false;
  try {
    const ses = sessionFor(id);
    await ses.clearStorageData().catch(() => {});
    await ses.clearCache().catch(() => {});
    await ses.clearAuthCache().catch(() => {});
    await ses.cookies.flushStore().catch(() => {});
  } catch {}
  const dir = path.join(app.getPath('userData'), 'Partitions', id);
  if (fs.existsSync(dir)) { try { await shell.trashItem(dir); trashed = true; } catch (e) { logProblem('folder-remove', e); } }
  // Everything Cue kept for it.
  vault.removeIdentity(id);
  lib.removeFolder(id);
  const d = store.data; const s = settings();
  if (d.whose) delete d.whose[id];
  for (const k of Object.keys(d.permissions || {})) if (k.startsWith(`${id}|`)) delete d.permissions[k];
  if (s.quickKeys && !Array.isArray(s.quickKeys)) delete s.quickKeys[id];
  for (const [sp, who] of Object.entries(s.spaceLogins || {})) if (who === id) delete s.spaceLogins[sp];
  if (s.defaultIdentity === id) s.defaultIdentity = other.id;
  if (s.identityLabels) delete s.identityLabels[id];
  if (d.everydayPinned) delete d.everydayPinned[id];
  d.archived = (d.archived || []).filter((a) => a.identity !== id);
  d.alerts = (d.alerts || []).filter((a) => a.folder !== id);
  d.bills = (d.bills || []).filter((b) => b.folder !== id);
  closedStack.splice(0, closedStack.length, ...closedStack.filter((c) => c.identity !== id));
  downloads.splice(0, downloads.length, ...downloads.filter((x) => x.folder !== id));
  delete lockTouched[id]; delete lockTries[id]; unlocked.delete(id);
  d.folders = userFolders().filter((x) => x.id !== id);
  if (!byId(activeId)) {
    const next = sidebarOrder().find((t) => t.identity === openFolder());
    if (next) activate(next.id);
    else if (isLocked(openFolder())) askUnlock(openFolder());
    else openTab({ identity: openFolder() });
  }
  buildMenu(); layout(); pushState(); persist(); store.flush();
  return { ok: true, trashed };
}

// ---------------------------------------------------------------- tabs
function makeTab(opts) {
  const t = {
    id: nextId++, uid: opts.uid || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, url: opts.url || START_URL, title: opts.title || 'New tab', favicon: opts.favicon || null,
    identity: identityOf(opts.identity) ? opts.identity : folderForNewTab(opts.space),
    // An app that lives in the strip is pinned the moment it is born, and a site
    // on the silent list opens silent. Both only decide how a tab STARTS.
    pinned: !!opts.pinned || (!opts.temp && alwaysPinned(opts.url)), groupOverride: opts.groupOverride || null, volume: opts.volume ?? 1,
    muted: opts.muted === undefined ? mutedSite(opts.url) : !!opts.muted, name: opts.name || null,
    private: !!opts.private, obsScene: opts.obsScene || '', agent: !!opts.agent, aiAllowed: !!opts.aiAllowed,
    order: opts.order ?? Date.now(), playing: false, audible: false, loading: false, space: spaces().includes(opts.space) ? opts.space : store.data.space,
    view: null, host: 'main', popout: null, mini: false, lastActive: opts.lastActive || Date.now(), canBack: false, canFwd: false, zoom: opts.zoom || 0,
    badge: 0, marks: [], log: [],
  };
  // "Just for now": the second tier of tabs. Same folder, same sign-ins - this is not Vanish -
  // but cleared when Cue closes (or after settings().tempClear hours) and never archived.
  // A pinned tab is always kept, so a tab cannot be both.
  if (opts.temp && !t.pinned && isFolder(t.identity)) { t.temp = true; t.tempAt = opts.tempAt || Date.now(); }
  return t;
}

function groupOf(t) {
  if (t.groupOverride) return t.groupOverride;
  if (!settings().autoGroup) return 'other';
  return groupFor(t.url);
}

function ensureView(t) {
  // A view whose page has gone (crashed, or closed from under us) still sits
  // on the tab as an object, and using it throws "Object has been destroyed".
  // Treat it as no view and build a fresh one, so WhatsApp and the rest come
  // back by themselves instead of failing.
  if (t.view && t.view.webContents.isDestroyed()) { t.view = null; t.sleeping = true; }
  if (t.view) return t.view;
  // A locked folder's tabs get no page at all until the passcode is typed.
  if (isLocked(t.identity)) throw new Error(`${folderName(t.identity)} is locked.`);
  const view = new WebContentsView({
    webPreferences: {
      session: sessionFor(t.identity), preload: TAB_PRELOAD, contextIsolation: true, sandbox: true,
      spellcheck: t.identity !== 'vanish', backgroundThrottling: true,
    },
  });
  view.setBackgroundColor('#FFFFFF');
  // Pinch on the trackpad to zoom the page, the way Safari and Chrome do.
  // Electron ships with it switched off, which is why only Cmd+/Cmd- worked.
  view.webContents.setVisualZoomLevelLimits(1, 5).catch(() => {});
  t.view = view; t.sleeping = false;
  wireTab(t);
  mainWin.contentView.addChildView(view);
  view.setVisible(false);
  view.setBounds(contentRect());
  if (overlay) mainWin.contentView.addChildView(uiView);
  view.webContents.loadURL(guardUrl(t.url)).catch(() => {});
  if (t.zoom) view.webContents.setZoomLevel(t.zoom);
  return view;
}

// A plain name with no scheme already becomes https in resolveInput. This is
// for the other way in: a link, or an address you typed with http:// in front
// of it. Cue tries the secure one first and says so if the site has none.
// Addresses on this machine and bare numbers are left alone - there is no
// certificate to be had for localhost:3000.
const NO_HTTPS = new Set();
function secureVersion(url, noHttps = NO_HTTPS) {
  if (!/^http:\/\//i.test(url)) return null;
  let u; try { u = new URL(url); } catch { return null; }
  const h = u.hostname;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(h) || /\.(local|test|localhost)$/i.test(h)) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || !h.includes('.')) return null;
  if (noHttps.has(h)) return null;
  u.protocol = 'https:';
  return u.href;
}
// Failures that mean "there is nothing listening on 443". A name that does not
// resolve, or a page that answers with an error, is not one of these: those
// fail the same way over http, so dropping the padlock would gain nothing.
const NO_SECURE_DOOR = new Set([-100, -101, -102, -107, -113, -118, -200, -201, -202, -207, -324]);

// ---------------------------------------------------------------- what a tab is called
// Page titles are written for search engines, not for a sidebar. His own history is full of
// "(20+) Facebook", "(1) WhatsApp Business", "Inbox (1) - music@nathanielschool.com - Nathaniel
// School of Music Mail" and "Pitara: piano, tuner, metronome, tanpura and music theory on one desk
// | Nathaniel School of Music". The unread count belongs in the badge Cue already draws, and the
// rest is noise. These are the sites his history actually shows him using.
const SITE_NAMES = [
  [/^web\.whatsapp\.com$/i, 'WhatsApp'],
  [/^mail\.google\.com$/i, 'Gmail'],
  [/^calendar\.google\.com$/i, 'Calendar'],
  [/^drive\.google\.com$/i, 'Drive'],
  [/^docs\.google\.com$/i, 'Docs'],
  [/^accounts\.google\.com$/i, 'Google sign-in'],
  [/^workspace\.google\.com$/i, 'Google Workspace'],
  [/^(www\.)?google\.[a-z.]+$/i, 'Google'],
  [/^studio\.youtube\.com$/i, 'YouTube Studio'],
  [/^(www|m)?\.?youtube\.com$/i, 'YouTube'],
  [/(^|\.)instagram\.com$/i, 'Instagram'],
  [/(^|\.)facebook\.com$/i, 'Facebook'],
  [/(^|\.)threads\.(net|com)$/i, 'Threads'],
  [/(^|\.)linkedin\.com$/i, 'LinkedIn'],
  [/(^|\.)pinterest\.[a-z.]+$/i, 'Pinterest'],
  [/(^|\.)github\.com$/i, 'GitHub'],
  [/(^|\.)claude\.ai$/i, 'Claude'],
  [/(^|\.)chatgpt\.com$/i, 'ChatGPT'],
  [/(^|\.)(espncricinfo|cricinfo)\.com$/i, 'ESPNcricinfo'],
  [/(^|\.)x\.ai$/i, 'xAI'],
  [/(^|\.)vercel\.com$/i, 'Vercel'],
  [/(^|\.)neon\.tech$/i, 'Neon'],
  [/(^|\.)render\.com$/i, 'Render'],
  [/(^|\.)cloudflare\.com$/i, 'Cloudflare'],
  [/^platform\.openai\.com$/i, 'OpenAI Platform'],
  [/(^|\.)name\.com$/i, 'name.com'],
];

// Sites whose own logo is missing or poor, so the tab does not fall back to a bare letter.
// A starting setup adds its own organisation's sites in front (presets.js), most specific first.
const SITE_LOGOS = [
  [/^mail\.google\.com$/i, 'gmail.png'],
  [/^studio\.youtube\.com$/i, 'youtube-studio.png'],
  [/(^|\.)youtube\.com$/i, 'youtube.png'],
  [/(^|\.)instagram\.com$/i, 'instagram.png'],
  [/(^|\.)pinterest\.[a-z.]+$/i, 'pinterest.png'],
  [/(^|\.)github\.com$/i, 'github.svg'],
  [/(^|\.)claude\.ai$/i, 'claude.png'],
  [/(^|\.)chatgpt\.com$/i, 'chatgpt.png'],
];

const pick = (table, host) => { for (const [re, v] of table) if (re.test(host)) return v; return null; };
// The tables in force: the starting setup's own rows first, then Cue's.
const siteNames = () => { const p = presets.active(); return p ? [...p.nameRules, ...SITE_NAMES] : SITE_NAMES; };
const siteLogos = () => { const p = presets.active(); return p ? [...p.logoRules, ...SITE_LOGOS] : SITE_LOGOS; };
// The organisation's own name for a host of its own, with its starting setup on.
const brandName = (host) => { const b = presets.field('brand', null); return b && presets.hostIn(host, b.hosts) ? b.name : null; };

// A preset's app is called by its own name, from the preset's app list, so a tab says the app's
// name rather than its whole sales sentence. No preset, no list.
const nsmAppName = (host) => {
  const hit = presets.apps().find((a) => { try { return new URL(a.url).hostname.toLowerCase() === host; } catch { return false; } });
  if (!hit) return null;
  return String(hit.name).split(/\s+[\u2014\u2013(]/)[0].trim(); // "Lipi \u2014 Notation Studio" -> "Lipi"
};

// Strips what a page title adds for search engines: the leading unread count the badge already
// shows, the site's own name tacked on after a separator, and the sales sentence after a colon
// ("Pitara: piano, tuner, metronome, tanpura and music theory on one desk" -> "Pitara").
const TITLE_TAIL = /\s+[|\u00b7\u2022\u2013\u2014]\s+|\s+-\s+/;
function tidyTitle(title) {
  let t = String(title || '').replace(/^\s*\(\d+\+?\)\s*/, '').trim();
  for (const tail of presets.field('titleTails', [])) {
    const esc = String(tail).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s*[|\\u00b7\\u2013\\u2014-]\\s*${esc}\\s*$`, 'i'), '').trim();
  }
  const head = t.split(TITLE_TAIL)[0].trim();
  if (head.length >= 3) t = head;
  const colon = t.match(/^([^:]{2,28}):\s+\S/);
  if (colon) t = colon[1].trim();
  return t;
}

// A sign-in, passkey or verify page says nothing about the site it belongs to: "Log In" or "Log
// into your name.com account to view and manage your domains" (Jason, 4-Nov-2026: call it the
// name of the website itself).
const SIGN_IN_TITLE = /\b(log ?in(to)?|sign ?in|sign ?up|log on|passkey|verify|verification|two-step|2-step|authenticat\w*|confirm it'?s (really )?you|choose an account|device sign-in)\b/i;

// The address a person would say: name.com, not www.name.com; neon.tech, not console.neon.tech;
// but bbc.co.uk stays whole.
function siteDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const two = parts.slice(-2);
  const short = /^(co|com|org|net|gov|ac|edu)$/.test(two[0]) && two[1].length === 2;
  return parts.slice(short ? -3 : -2).join('.');
}

// What to call a whole website, as History lists it: one line per site. What he calls it first,
// then the NSM app's own name, then the piece of the page title that names the brand ("Login -
// Brevo" is Brevo), and when the title only says "log in" or names no brand, the address itself.
function siteLabel(host, title) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h) return tidyTitle(title) || '';
  const known = pick(siteNames(), h) || nsmAppName(h);
  if (known) return known;
  const domain = siteDomain(h);
  const brand = domain.split('.')[0].replace(/[^a-z0-9]/g, '');
  const pieces = String(title || '').replace(/^\s*\(\d+\+?\)\s*/, '').split(TITLE_TAIL).map((x) => x.trim()).filter(Boolean);
  const named = pieces.find((x) => x.length <= 32 && !SIGN_IN_TITLE.test(x) && brand.length >= 3
    && x.toLowerCase().replace(/[^a-z0-9]/g, '').includes(brand));
  if (named) return named;
  // "Vercel Pricing: Hobby, Pro…", "Pay Cloudflare, Inc. Invoice…": the brand is one word in it.
  const word = brand.length >= 3 && String(title || '').match(new RegExp(`\\b(${brand})\\b`, 'i'));
  if (word && !SIGN_IN_TITLE.test(word[1])) return word[1];
  if (brandName(h)) return brandName(h);
  // A short title that is not a sign-in is usually the site's own name ("Jason's Money OS").
  const first = pieces[0] || '';
  if (first && first.length <= 24 && !SIGN_IN_TITLE.test(first)) return first;
  return domain;
}

// What the sidebar should call this tab. A name he typed himself always wins.
// Named tabName, not siteName: there is already a siteName(url) further down that answers a bare
// host for the "you are leaving a protected site" notice, and two functions of one name meant the
// later one won and every tab in the sidebar came out blank.
function tabName(t) {
  if (t.name) return t.name;
  const host = String(hostOf(t.url) || '').toLowerCase().replace(/^www\./, '');
  if (!host) return tidyTitle(t.title) || 'New tab';
  // What HE calls it comes before what the app list calls it: the app list says "Classroom LMS
  // (Learning Portal)", and he says Learning Portal. The app list is next, so an NSM app is named
  // by its own name rather than by the school.
  if (SIGN_IN_TITLE.test(String(t.title || ''))) return siteLabel(host, t.title);
  return pick(siteNames(), host) || nsmAppName(host) || tidyTitle(t.title) || brandName(host) || host;
}

// A logo Cue ships, used only when the site's own favicon does not arrive - several NSM apps
// answer 404 for /favicon.ico, and a bare letter is not a logo.
const siteLogo = (t) => {
  const host = String(hostOf(t.url) || '').toLowerCase();
  if (!host || t.identity === 'vanish') return null;
  return pick(siteLogos(), host);
};

// ---------------------------------------------------------------- the number keys
// Cmd+1 to Cmd+9. Each one goes to that site's tab in the folder that is open, and opens it only
// if it is not already there - so Cmd+1 is each folder's own WhatsApp, from the same key. A plain
// install starts with 1-8 empty (they do nothing until you give them a site) and 9 a brand new
// tab; a starting setup brings its own nine (presets.js). Every slot can be changed in Settings.
const PLAIN_KEYS = [...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ key: String(n), name: '', url: '' })), { key: '9', name: 'New tab', url: '' }];
const quickDefaults = () => { const q = presets.field('quickKeys', null); return Array.isArray(q) && q.length === 9 ? q : PLAIN_KEYS; };
// A slot with neither a name nor an address is empty: no menu entry, and the key does nothing.
// A name with no address opens a new tab, as slot 9 does.
const quickEmpty = (q) => !q.url && !q.name;

// The nine are PER FOLDER. Command-1 is his own WhatsApp in Personal and the
// school's in School, and that was already true of where a key landed - but the
// key itself was one list for the whole browser, so he could not put the leads
// board on Command-4 at school and keep his bank there at home. Each folder now
// keeps its own nine. A flat list from an older Cue is read as every folder's
// starting point, so nothing he has already set is lost.
const quickKeysFor = (folder) => {
  const saved = settings().quickKeys;
  const mine = Array.isArray(saved) ? saved : (saved && isFolder(folder) ? saved[folder] : null);
  const defaults = quickDefaults();
  if (!Array.isArray(mine) || mine.length !== 9) return defaults;
  return defaults.map((d, i) => {
    const x = mine[i] || {};
    return { key: d.key, name: String(x.name || d.name), url: typeof x.url === 'string' ? x.url : d.url };
  });
};
const quickKeys = (folder) => quickKeysFor(isFolder(folder) ? folder : openFolder());

// Where Google lands you when it refuses the browser: "Couldn't sign you in. This browser or app
// may not be secure."
const GOOGLE_REFUSED = /^https:\/\/accounts\.google\.[a-z.]+\/.*(signin\/rejected|deniedsigninrejected)/i;

// Not a refusal. Gmail answers this when the account slot in the address does not
// match what the cookie jar holds - the sign-in was fine, the address was not.
const GOOGLE_MISMATCH = /^https:\/\/accounts\.google\.[a-z.]+\/CookieMismatch/i;

// The sign-ins worth carrying over for a Google account, and nothing else.
const GOOGLE_LOGIN_HOST = /(^|\.)(google\.[a-z.]+|gmail\.com|youtube\.com|googleusercontent\.com)$/i;

// Clearing has to reach wider than carrying. A Chrome carry also drags in the ad and
// measurement crumbs - googleadservices, doubleclick and the rest - and those are not
// sign-ins, so the narrow list above walked straight past them. Personal was left holding
// eleven of them after every "Clear and sign in again", which is why that folder kept being
// refused while the untouched AI agent folder, holding the same three real cookies and none
// of the ad ones, reached the password step every time. Sign-in starts from an empty jar or
// it does not start.
const GOOGLE_WIPE_HOST = /(^|\.)(google\.[a-z.]+|gmail\.com|youtube\.com|googleusercontent\.com|googleadservices\.com|googlesyndication\.com|googletagmanager\.com|google-analytics\.com|doubleclick\.net|withgoogle\.com|googleapis\.com)$/i;

// Where a Google sign-in lives, and the pages that keep their own copy of it.
const GOOGLE_ORIGINS = ['https://accounts.google.com', 'https://mail.google.com', 'https://www.google.com',
  'https://drive.google.com', 'https://calendar.google.com', 'https://www.youtube.com'];

// The same, for Meta. Instagram, Facebook and Threads share one sign-in, so they
// come over together or not at all: carrying Instagram alone leaves Facebook
// holding a half-session, which is what Meta's own checks are looking for.
const META_LOGIN_HOST = /(^|\.)(instagram\.com|facebook\.com|threads\.(net|com)|cdninstagram\.com|fbcdn\.net)$/i;
const META_ORIGINS = ['https://www.instagram.com', 'https://instagram.com',
  'https://www.facebook.com', 'https://facebook.com', 'https://www.threads.net', 'https://www.threads.com'];

const cookieUrl = (c) => `${c.secure ? 'https' : 'http'}://${String(c.domain || '').replace(/^\./, '')}${c.path || '/'}`;

// Brings a sign-in over from Chrome on this Mac, where he is already signed in. Cookies only, for
// the sites asked for, into the one identity that asked.
//
// Whatever is already here for those sites is cleared first, and that is the whole trick: half of
// last week's session and half of Chrome's is exactly what makes Google answer "we've detected a
// problem with your cookie settings". A carried sign-in only works if it lands in an empty jar.
// Offered only where it can work: macOS (Chrome's cookie key is in the keychain; on Windows Chrome
// locks its cookies to itself, and Linux has no keychain prompt to say yes to) and only when
// Chrome is actually installed. The UI reads this flag and hides the button otherwise.
let carryCache = null;
function canCarryFromChrome() {
  if (carryCache !== null) return carryCache;
  try { carryCache = MAC && importer.findBrowsers().some((x) => x.id === 'chrome' && x.profiles.length); } catch { carryCache = false; }
  return carryCache;
}

// The cookies that mean "signed in" on each site, as opposed to a visit.
const SESSION_COOKIES = { 'instagram.com': ['sessionid'], 'facebook.com': ['c_user', 'xs'], 'threads.net': ['sessionid'], 'threads.com': ['sessionid'] };
const signedInBy = (cookies) => cookies.some((c) => {
  const site = Object.keys(SESSION_COOKIES).find((s) => String(c.domain || '').replace(/^\./, '').endsWith(s));
  return site ? SESSION_COOKIES[site].includes(c.name) : /^(sessionid|c_user|SID|__Secure-1PSID|session|auth)/i.test(c.name);
});
const cookieHost = (c) => String(c.domain || (() => { try { return new URL(c.url).hostname; } catch { return ''; } })()).replace(/^\./, '');

// Every Chrome profile on this computer that holds a sign-in for these sites, with the profile's
// own name and the account it is signed in to Chrome as, if Chrome says. Nobody's session is picked
// for them: a shared computer can have several people in Chrome.
async function chromeProfilesFor(hostRe, opts = {}) {
  const finder = opts.importer || importer;
  const b = finder.findBrowsers(opts.browserOpts).find((x) => x.id === 'chrome');
  if (!b || !b.profiles.length) return { error: 'Chrome is not on this computer, so there is no sign-in to bring over.' };
  const key = await finder.getKey(b, opts.keyOpts);
  if (!key) return { error: 'Cue could not unlock Chrome\u2019s sign-ins. Say yes when this computer asks for the key, then try again.' };
  const out = [];
  for (const p of b.profiles) {
    const cookies = finder.readCookies(b, p, key).filter((c) => hostRe.test(cookieHost(c)));
    if (!cookies.length || !signedInBy(cookies)) continue;
    const label = p.email ? `${p.name} (${p.email})` : p.name;
    out.push({ dir: p.dir, name: p.name, email: p.email || '', label, cookies });
  }
  return { profiles: out };
}

// Asks which profile, in words, every time - even when there is only one, because "the one Chrome
// profile on this computer" may still be somebody else's.
async function chooseChromeProfile(profiles, site, where) {
  if (!profiles.length) return null;
  if (process.env.CUE_TEST) return null; // tests never answer a dialog on his screen
  const buttons = [...profiles.map((p) => p.label).slice(0, 6), 'Cancel'];
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'question', buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1,
    message: `Which Chrome profile's ${site} sign-in should come into ${where}?`,
    detail: 'These are the Chrome profiles on this computer that are signed in to it. Pick your own. Chrome is left exactly as it is.',
  });
  return response < profiles.length ? profiles[response] : null;
}

async function carryFromChrome(identity, hostRe, origins = [], site = 'this site') {
  const ses = sessionFor(identity);
  const host = cookieHost;
  const found = await chromeProfilesFor(hostRe);
  if (found.error) return { error: found.error };
  if (!found.profiles.length) return { count: 0, cleared: 0, from: 'Chrome' };
  const where = folderName(identity);
  const best = await chooseChromeProfile(found.profiles, site, where);
  // If there is nothing to put back, or nobody chose, nothing here is touched: clearing a working
  // sign-in and then bringing nothing would leave the folder signed out.
  if (!best) return { count: 0, cleared: 0, from: 'Chrome', cancelled: true };
  best.from = best.label;
  const incoming = best.cookies;

  let cleared = 0;
  for (const c of await ses.cookies.get({})) {
    if (!hostRe.test(host(c))) continue;
    try { await ses.cookies.remove(cookieUrl(c), c.name); cleared++; } catch { /* one stubborn cookie never stops the rest */ }
  }
  for (const origin of origins) {
    await ses.clearStorageData({ origin, storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }).catch(() => {});
  }

  let count = 0;
  for (const c of incoming) {
    try { await ses.cookies.set(c); count++; } catch { /* same */ }
  }
  await ses.cookies.flushStore();
  await syncShared(identity); // only into a folder paired with this one, if any
  return { count, cleared, from: best.from };
}

const metaFromChrome = (identity) => carryFromChrome(identity, META_LOGIN_HOST, META_ORIGINS, 'Instagram and Facebook');

// Only Meta's sign-ins are carried. Google's are NOT, and must not be: Google ties a session to
// the one browser it was made in, so a copied jar is revoked within the hour and takes the
// original down with it - on 2-Nov-2026 that signed both folders out and left them on
// accounts.google.com/CookieMismatch while Chrome itself stayed fine. Worse, his Chrome keeps
// BOTH his Google accounts in a single profile, so the copy arrived holding both and the two
// folders stopped meaning anything. Google gets signed into inside Cue, once per folder.
async function carryAllFromChrome(identity) {
  const out = [];
  for (const [name, run] of [['Instagram and Facebook', metaFromChrome]]) {
    const r = await run(identity).catch((e) => ({ error: e.message }));
    out.push({ name, ...r });
  }
  return out;
}

// Google's own sign-in page, in the folder that asked, with the folder's address already filled in
// so he never lands on the wrong account's inbox.
// Empties a folder's Google jar. On 2-Nov-2026 both folders were left holding ~128 cookies from
// the revoked Chrome carry, and that dead jar - not the browser - is what Google answers
// "signin/rejected" and "CookieMismatch" to. Proved by probe: a FRESH Electron session reaches
// "Enter your password" under a Chrome, Firefox or Safari identity alike, so Google has no quarrel
// with Cue's engine. Signing in always starts from an empty jar.
async function clearGoogleState(identity) {
  if (isLocked(identity)) throw new Error(`${folderName(identity)} is locked. Type its passcode first.`);
  const ses = sessionFor(identity);
  const host = (c) => String(c.domain || '').replace(/^\./, '');
  let cleared = 0;
  for (const c of await ses.cookies.get({})) {
    if (!GOOGLE_WIPE_HOST.test(host(c))) continue;
    try { await ses.cookies.remove(cookieUrl(c), c.name); cleared++; } catch { /* one stubborn cookie never stops the rest */ }
  }
  for (const origin of GOOGLE_ORIGINS) {
    await ses.clearStorageData({ origin, storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }).catch(() => {});
  }
  await ses.cookies.flushStore();
  return cleared;
}

// Google's own sign-in page, in the folder that asked, with the folder's address already filled in
// so he never lands on the wrong account's inbox - and with that folder's stale Google state
// cleared first, or Google refuses before he can type anything.
async function googleSignIn(identity, { otherAccount = false } = {}) {
  const cleared = await clearGoogleState(identity).catch(() => 0);
  const tab = await openTab({ url: googleSignInUrl(identity, '', { otherAccount }), identity });
  return { tab, cleared };
}

async function signInAgain(t, sender, otherAccount) {
  const identity = t ? t.identity : (sender && popupIdentity.get(sender));
  if (!identity) return { error: 'Close this page and start the sign-in again from the site.' };
  if (isLocked(identity)) return { error: `${folderName(identity)} is locked. Type its passcode first.` };
  // A press of the button is the person asking, so it is not held to the ten-minute rule.
  signinGate.forget(identity);
  if (t) { const { cleared } = await googleSignIn(identity, { otherAccount }); return { signin: true, cleared }; }
  const cleared = await clearGoogleState(identity).catch(() => 0);
  sender.loadURL(googleSignInUrl(identity, '', { otherAccount })).catch(() => {});
  return { signin: true, cleared };
}

// Google's own sign-in address for a folder. The folder's address goes in as a hint only when one
// is on file and the person did not ask for a different account; without it Google simply asks.
function googleSignInUrl(identity, cont = '', { otherAccount = false } = {}) {
  const who = otherAccount ? '' : String(emailOf(identity) || '').trim();
  const u = new URL('https://accounts.google.com/AccountChooser');
  if (cont) {
    u.searchParams.set('continue', cont);
    if (/@/.test(who)) u.searchParams.set('Email', who);
    return u.toString();
  }
  // NOT /mail/u/0/. The /u/<n>/ index is a SLOT in whatever list of accounts the
  // jar happens to hold, not an account, so slot 0 is only his inbox when his is
  // the first one Google lists. Sign-in then succeeds and Gmail still answers
  // CookieMismatch, because the slot points at an account whose session is gone.
  // YouTube keeps working throughout, which is what makes this look like "Gmail
  // is broken": YouTube has no /u/<n>/ in its address, so it never picks a slot.
  // ?authuser=<the address> names the account outright and cannot drift.
  u.searchParams.set('continue', otherAccount ? 'https://mail.google.com/mail/' : googleForFolder('https://mail.google.com/mail/', identity));
  if (/@/.test(who)) u.searchParams.set('Email', who);
  return u.toString();
}

// His Chrome keeps BOTH Google accounts signed in to one profile, so whatever is
// carried over arrives holding both, and /mail/u/0/ is then simply whichever one
// Google answers with — School opened Personal's inbox and the folders stopped
// meaning anything. ?authuser=<address> is Google's own answer to that, and it
// works across Gmail, Calendar, Drive and YouTube alike. Note that the address
// does NOT go in the path: /mail/u/<address>/ answers 404.
const GOOGLE_PER_ACCOUNT = /^(mail|calendar|drive|docs|contacts|photos|keep|groups)\.google\.[a-z.]+$|^(www|studio|music)\.youtube\.[a-z.]+$/i;
function googleForFolder(url, identity) {
  const who = emailOf(identity);
  if (!who || !/@/.test(who)) return url;
  try {
    const u = new URL(url);
    if (!GOOGLE_PER_ACCOUNT.test(u.hostname)) return url;
    if (u.searchParams.has('authuser')) return url;        // he named one himself
    if (/^\/mail\/u\/\d+\//.test(u.pathname)) return url;  // so did this
    u.searchParams.set('authuser', who);
    return u.toString();
  } catch { return url; }
}


// For a site that will not let you sign in inside Cue - Google is the one that always refuses -
// this carries the sign-in you already have in Chrome across to the tab you are looking at.
async function carrySignIn(t) {
  if (!t || !t.view) return;
  if (t.identity === 'vanish') { sendEvent('toast', 'Vanish keeps nothing, so there is nowhere to put a sign-in.'); return; }
  if (!canCarryFromChrome()) { sendEvent('toast', 'There is no Chrome on this computer to bring a sign-in from.'); return; }
  const site = siteName(t.url);
  if (!site) { sendEvent('toast', 'Open the site first, then try this again.'); return; }
  // Never Google: a copied Google sign-in is cancelled by Google, together with the original.
  if (GOOGLE_WIPE_HOST.test(site)) { sendEvent('toast', 'Google is signed in to here, not brought over. Use Sign in to Google in Settings.'); return; }
  const where = folderName(t.identity);
  if (!process.env.CUE_TEST) {
    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'question', buttons: ['Bring it over', 'Cancel'], defaultId: 0, cancelId: 1,
      message: `Bring your ${site} sign-in over from Chrome?`,
      detail: `Cue clears what it has for ${site} in ${where} and puts Chrome's sign-in there instead. Chrome is left exactly as it is.\n\nA sign-in that moves from one app to another is the thing these checks are watching for. The site may take it quietly, or it may ask you to prove it is you.`,
    });
    if (response !== 0) return;
  }
  const re = new RegExp(`(^|\\.)${site.replace(/\./g, '\\.')}$`, 'i');
  const r = await carryFromChrome(t.identity, re, [`https://${site}`, `https://www.${site}`], site);
  if (r.error) { sendEvent('toast', r.error); return; }
  if (r.cancelled) return;
  if (!r.count) { sendEvent('toast', `Chrome had no ${site} sign-in to bring over.`); return; }
  sendEvent('toast', `Your ${site} sign-in came over from Chrome (${r.from}).`);
  t.view.webContents.reload();
}

// The name a site is signed in under: "instagram.com" for www.instagram.com, "google.co.uk" for
// accounts.google.co.uk. Good enough to decide which sign-ins travel together.
function siteName(url) {
  let h = '';
  try { h = new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  const parts = h.split('.');
  if (parts.length < 3) return h;
  const second = parts[parts.length - 2];
  return (['co', 'com', 'net', 'org', 'gov', 'ac'].includes(second) ? parts.slice(-3) : parts.slice(-2)).join('.');
}

// Every way a page can be asked for - typed, clicked, restored at launch, woken
// from sleep - goes through here, so a site on today's list is stopped whichever
// way you arrived at it.
function guardUrl(url, ok = dangerOk) {
  if (!shield || settings().warnDangerous === false || !/^https?:/i.test(String(url || ''))) return url;
  if (ok.has(shield.hostOf(url))) return url;
  const bad = shield.verdict(url);
  return bad ? `cue://danger?kind=${bad}&site=${encodeURIComponent(url)}` : url;
}

function offlineSite(u) {
  if (!/^cue:\/\/offline/i.test(String(u || ''))) return '';
  try { const site = new URL(u).searchParams.get('site') || ''; return /^https?:\/\//i.test(site) ? site : ''; } catch { return ''; }
}

// The same guards for every tab, Vanish included. Vanish passes no note, so nothing is written down.
function protectPage(wc, t, note) {
  const inVanish = t.identity === 'vanish';
  const noHttps = inVanish ? VANISH_NO_HTTPS : NO_HTTPS;
  // On a VPN, this is the one thing a browser does that gives your real address
  // away. Video calling asks the operating system for every network address
  // this Mac has and hands the lot to the page, which is how a site reads your
  // home IP while NordVPN is on. Cue offers the public one only. Calls still
  // work; what stops working is being found.
  try { wc.setWebRTCIPHandlingPolicy(settings().hideRealIP === false ? 'default' : 'default_public_interface_only'); } catch {}
  // ---- known-dangerous sites, and trying the secure address first
  const guard = (e, url, isMain) => {
    // A web page may not send itself (or a frame) to one of Cue's own pages or a file on this
    // computer. Cue still opens those itself; this only stops a page from doing it.
    if (isMain ? refuseOpen(url, wc.getURL()) : /^(cue|file):/i.test(String(url)) && !/^cue:/i.test(wc.getURL())) { e.preventDefault(); if (note) note(`page tried to open ${String(url).slice(0, 80)}`); return; }
    if (!isMain) return;
    const warn = guardUrl(url, inVanish ? vanishDangerOk : dangerOk);
    if (warn !== url) {
      e.preventDefault();
      wc.loadURL(warn).catch(() => {});
      if (note) note(`dangerous site ${url}`);
      return;
    }
    const safe = settings().httpsFirst !== false ? secureVersion(url, noHttps) : null;
    if (safe) {
      e.preventDefault();
      t.httpsFrom = url;
      wc.loadURL(safe).catch(() => {});
    }
  };
  wc.on('will-navigate', (e, url) => guard(e, url, true));
  wc.on('will-frame-navigate', (e) => guard(e, e.url, e.isMainFrame));
  wc.on('will-redirect', (e, url) => guard(e, url, true));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain) return;
    if (t.httpsFrom) {
      const back = t.httpsFrom; t.httpsFrom = null;
      if (NO_SECURE_DOOR.has(Number(code)) && /^https:/.test(url)) {
        try { noHttps.add(new URL(back).hostname); } catch {}
        if (note) sendEvent('toast', `${hostName(back)} has no secure address. Cue opened the plain one.`);
        wc.loadURL(back).catch(() => {});
        return;
      }
    }
    // Anything else that never arrived gets a page that says why, never a blank or stale tab.
    // -3 is a page being replaced by another, which is not a failure.
    if (Number(code) === -3 || !/^https?:/i.test(String(url || ''))) return;
    wc.loadURL(`cue://offline?code=${Number(code)}&why=${encodeURIComponent(desc || '')}&site=${encodeURIComponent(url)}`).catch(() => {});
  });
  wc.on('did-finish-load', () => { t.httpsFrom = null; });
}

// ---------------------------------------------------------------- Google's refusals, without a dead end
// Google can answer a sign-in with "signin/rejected" ("This browser or app may not be secure") or
// CookieMismatch. Probed again and again, the cause is the folder's own leftover Google state, not
// the browser - so the cure is to empty ONLY that folder's Google jar and try again. Cue does that
// once by itself, in any folder, with or without an address on file. If Google answers the same
// way again within ten minutes, Cue does not try a third time (that is how a loop starts) and shows
// cue://signin-blocked instead, which says in plain words what to try next.
const RETRY_EVERY = 10 * 60 * 1000;
function makeSigninGate(windowMs = RETRY_EVERY) {
  const last = new Map();
  return {
    mayRetry(folder, now = Date.now()) {
      const at = last.get(folder);
      if (at !== undefined && now - at < windowMs) return false;
      last.set(folder, now);
      return true;
    },
    forget(folder) { last.delete(folder); },
  };
}
const signinGate = makeSigninGate();
const GOOGLE_SIGNIN_HOST = /^https:\/\/accounts\.google\.[a-z.]+\//i;
const NOT_SECURE_WORDS = /this browser or app may not be secure/i;

// Where to send a retry: back to where the sign-in was going (an OAuth pop-up's own continuation
// included), as long as that is a plain https address.
function continueOf(u) {
  try { const c = new URL(u).searchParams.get('continue'); if (c && /^https:\/\//i.test(c)) return c; } catch {}
  return '';
}

const popupIdentity = new WeakMap(); // a pop-up's webContents -> the folder it belongs to

function watchGoogleRefusal(wc, getIdentity) {
  let mismatchFixed = false;
  let busy = false;
  const refused = async (kind, u) => {
    const identity = getIdentity();
    if (identity === 'vanish' || busy || wc.isDestroyed()) return;
    // CookieMismatch right after a GOOD sign-in is the /u/<n>/ slot pointing at an account this jar
    // does not hold. With the folder's address on file, naming it outright cures that without
    // touching a cookie. Once per page, so it cannot become a loop of its own.
    if (kind === 'mismatch' && !mismatchFixed) {
      const back = googleForFolder('https://mail.google.com/mail/', identity);
      if (back !== 'https://mail.google.com/mail/') { mismatchFixed = true; wc.loadURL(back).catch(() => {}); return; }
    }
    busy = true;
    try {
      if (signinGate.mayRetry(identity)) {
        const cleared = await clearGoogleState(identity).catch(() => 0);
        logAgent({ tool: 'signin', note: `google ${kind} in ${identity}: cleared ${cleared}, retrying once` });
        if (!wc.isDestroyed()) wc.loadURL(googleSignInUrl(identity, continueOf(u))).catch(() => {});
      } else {
        logAgent({ tool: 'signin', note: `google ${kind} again in ${identity}: showing the help page` });
        if (!wc.isDestroyed()) wc.loadURL(`cue://signin-blocked?why=${kind}`).catch(() => {});
      }
    } finally { busy = false; }
  };
  const look = (u) => {
    if (GOOGLE_REFUSED.test(u)) refused('refused', u);
    else if (GOOGLE_MISMATCH.test(u)) refused('mismatch', u);
  };
  wc.on('did-navigate', (_e, u) => look(u));
  // Google's sign-in is one page that rewrites itself, so a refusal can arrive without a page load.
  wc.on('did-navigate-in-page', (_e, u, isMain) => { if (isMain) look(u); });
  // ...and occasionally as words on a page whose address says nothing.
  wc.on('did-stop-loading', () => {
    const u = wc.getURL();
    if (!GOOGLE_SIGNIN_HOST.test(u) || GOOGLE_REFUSED.test(u) || GOOGLE_MISMATCH.test(u)) return;
    wc.executeJavaScript('document.body ? document.body.innerText.slice(0, 3000) : ""', true)
      .then((txt) => { if (NOT_SECURE_WORDS.test(txt)) refused('refused', u); }).catch(() => {});
  });
}

// A "Sign in with Google" (or Apple, Microsoft, Meta) window. It opens in the opener's folder, with
// the same page script as a tab, and is wired the same way for the things that matter in a sign-in:
// the dangerous-site guard, Google's refusals, and what its own links open. window.opener and
// window.close are Chromium's own and are left alone, so the round trip back to the page works.
function popupFor(identity, agent) {
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 520, height: 680, autoHideMenuBar: true, ...(process.env.CUE_TEST ? { show: false } : {}),
      webPreferences: { session: sessionFor(identity), preload: TAB_PRELOAD, contextIsolation: true, sandbox: true },
    },
  };
}
// Every sign-in window that is open, so locking or removing a folder can close its own.
const openPopups = new Set();
function closePopupsOf(id) {
  for (const p of [...openPopups]) if (p.getIdentity() === id) { openPopups.delete(p); try { p.win.destroy(); } catch {} }
}
function wirePopup(win, getIdentity, agent) {
  const wc = win && win.webContents;
  if (!wc || wc.isDestroyed()) return;
  const entry = { win, getIdentity };
  openPopups.add(entry);
  win.on('closed', () => openPopups.delete(entry));
  popupIdentity.set(wc, getIdentity());
  protectPage(wc, {}, null);
  watchGoogleRefusal(wc, getIdentity);
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (refuseOpen(url, wc.getURL())) return { action: 'deny' };
    if (whereToOpen(url, disposition, wc.getURL()) === 'popup') return popupFor(getIdentity(), agent);
    openTab({ url, identity: getIdentity(), agent });
    return { action: 'deny' };
  });
  wc.on('did-create-window', (w) => wirePopup(w, getIdentity, agent));
}

function wireTab(t) {
  const wc = t.view.webContents;
  wc.setAudioMuted(t.muted);
  protectPage(wc, t, (what) => logTab(t, 'blocked', what));
  wc.on('page-title-updated', (_e, title) => {
    t.title = title; if (t.popout) t.popout.setTitle(`${t.mini ? 'Cue mini' : 'Cue'} \u00b7 ${title}`);
    if (remembers(t)) lib.in(t.identity).title(wc.getURL(), title);
    t.badge = countIn(t, title);
    pushState(); persist();
  });
  wc.on('page-favicon-updated', (_e, favs) => { t.favicon = favs[0] || null; pushState(); persist(); });
  wc.on('did-navigate', () => { t.holdAwake = false; t.dirty = false; t.crashed = false; if (shield) shield.reset(wc.id); });
  watchGoogleRefusal(wc, () => t.identity);
  wc.on('did-navigate', (_e, u) => sayProtected(u));
  const nav = () => {
    // On the "couldn't reach" page the tab still belongs to the site, so it is the site that is
    // shown, saved, and opened again next time.
    t.url = offlineSite(wc.getURL()) || wc.getURL(); t.canBack = wc.navigationHistory.canGoBack(); t.canFwd = wc.navigationHistory.canGoForward();
    pushState(); persist();
  };
  // History is written when the page has settled, not the moment it is asked for,
  // so Cue knows whether it actually worked. A blocked page, a 404 or a "Just a
  // moment…" screen is not somewhere you went, and keeping it only filled the
  // list with links that lead nowhere.
  let lastCode = 200;
  const visit = () => {
    const url = wc.getURL();
    if (!remembers(t) || !/^https?:/.test(url)) return;
    if (lastCode >= 400 || BROKEN_PAGE.test((wc.getTitle() || '').trim())) return;
    lib.in(t.identity).visit(url, wc.getTitle()); // in this folder's history only
  };
  wc.on('did-navigate', (_e, _u, code) => { lastCode = Number(code) || 200; nav(); });
  wc.on('did-navigate-in-page', (_e, _u, main) => { nav(); if (main) visit(); });
  wc.on('did-start-loading', () => { t.loading = true; pushState(); });
  wc.on('did-stop-loading', () => { t.loading = false; nav(); visit(); readBillPage(t); });
  wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') logTab(t, e.level, `${e.message} (${e.sourceId}:${e.lineNumber})`); });
  wc.on('audio-state-changed', (e) => { t.audible = e.audible; pushState(); });
  wc.on('media-started-playing', () => {
    t.playing = true; t.videoAt = Date.now();
    if (t.calm) { t.held = true; wc.send('cue:media', 'pause'); pushState(); return; } // it waits, silent, until you go to it
    const from = t.from && Date.now() - t.openedAt < FRESH_TAB ? byId(t.from) : null;
    t.from = null;
    const handover = from && from.playing && from.id !== programId && !from.holdAwake;
    if (handover && t.id !== activeId) activate(t.id, 'auto');
    if (settings().onePlayer || handover) {
      // Resting the pointer on a film on Netflix starts a SILENT preview, and
      // that used to pause the music he was actually listening to in another
      // tab. Nothing is paused for a video with no sound: give it a moment to
      // find its voice, and only then clear the room.
      setTimeout(async () => {
        if (!t.view || t.view.webContents.isDestroyed() || !t.playing) return;
        let loud = false;
        try { loud = t.view.webContents.isCurrentlyAudible(); } catch {}
        // Chromium's own answer can lag, and is always "no" with sound switched off for the
        // whole app (CUE_QUIET). The page knows too: a film that is playing, not muted, and
        // has decoded sound is making sound. A Netflix hover preview is muted, so it still waits.
        if (!loud) loud = await t.view.webContents.executeJavaScript(SOUNDING, true).catch(() => false);
        if (!loud || !t.playing) return;
        for (const o of tabs) {
          const together = sharesSplit(t) && sharesSplit(o);
          if (o !== t && o.view && o.playing && o.id !== programId && !o.holdAwake && !together && (settings().onePlayer || o === from)) o.view.webContents.send('cue:media', 'pause');
        }
      }, 600);
    }
    pushState();
  });
  wc.on('media-paused', () => { t.playing = false; t.videoAt = Date.now(); pushState(); });
  wc.on('enter-html-full-screen', () => { t.fullscreen = true; const w = hostWindow(t); if (w) w.setFullScreen(true); layout(); settleAfterFullScreen(t, true); });
  wc.on('leave-html-full-screen', () => { t.fullscreen = false; const w = hostWindow(t); if (w) w.setFullScreen(false); layout(); settleAfterFullScreen(t); });
  wc.on('found-in-page', (_e, r) => sendEvent('find-result', { active: r.activeMatchOrdinal, total: r.matches }));
  wc.on('focus', () => {
    if (t.id !== activeId && store.data.split.ids.includes(t.id) && t.host === 'main') { activeId = t.id; t.lastActive = Date.now(); pushState(); }
  });
  wc.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    t.crashed = true; pushState();
    // Bring it straight back once; a page that keeps crashing waits for you to press reload.
    if (Date.now() - (t.crashAt || 0) < 60000) { sendEvent('toast', `${t.title} keeps crashing. Press reload to try again.`); return; }
    t.crashAt = Date.now();
    sendEvent('toast', `${t.title} crashed. Reloading it.`);
    setTimeout(() => { if (t.view && t.view.webContents === wc && !wc.isDestroyed()) wc.reload(); }, 500);
  });
  wc.on('context-menu', (_e, p) => contextMenu(t, p));
  wc.on('did-finish-load', () => {
    if (t.volume !== 1) wc.send('cue:volume', t.volume);
    if (isStart(wc.getURL())) dressStartPage(wc);
    teamSignedIn(t);
    sniffWhose(t); // keep the folder honest about which account is live in it
  });
  wc.on('did-navigate-in-page', () => teamSignedIn(t)); // the team site signs in without a page load
  wc.on('did-create-window', (win) => wirePopup(win, () => t.identity, t.agent));
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (recTabId === t.id || refuseOpen(url, wc.getURL())) return { action: 'deny' };
    const where = whereToOpen(url, disposition, wc.getURL());
    if (where === 'popup') return popupFor(t.identity, t.agent);
    if (where === 'here') { wc.loadURL(url).catch(() => {}); return { action: 'deny' }; }
    // 'both' (the default from 0.7, as in other browsers): go to the new tab and pause nothing.
    // 'switch': pause the old one and play the new. 'stay': stay; the new tab waits quietly.
    const mode = settings().videoSwitch || 'both';
    const calm = t.playing && mode === 'stay'; // stay on the video; the new tab opens quietly behind it
    const nt = openTab({ url, identity: t.identity, background: calm || disposition === 'background-tab', after: t, agent: t.agent });
    if (calm) nt.calm = true; else if (t.playing && mode === 'switch') { nt.from = t.id; nt.openedAt = Date.now(); }
    return { action: 'deny' };
  });
}

function sharesSplit(t) { const sp = store.data.split; return sp.mode !== 'single' && sp.ids.includes(t.id); }

const FRESH_TAB = 30000;                // a new tab that starts playing this soon after opening is what the link was for
const KEEP_PAUSED = 3 * 60 * 60 * 1000; // a video you paused keeps its place this long, however many tabs are asleep

// Netflix and its like won't start in Cue. Better to say so once than leave a spinning player.
const toldProtected = new Set();
function sayProtected(url) {
  const name = protectedSite(url);
  // With Widevine loaded these sites simply play, so there is nothing to say.
  if (drmReady) return;
  if (!name || toldProtected.has(name) || live || programId || process.env.CUE_TEST) return;
  toldProtected.add(name);
  const message = `${name} can't play its shows in Cue yet.`;
  const detail = `It uses protected video, and the player Cue needs for it did not load${drmLog ? ` (${drmLog})` : ''}. Everything else on the site works.`;
  dialog.showMessageBox(mainWin, MAC
    ? { type: 'info', buttons: ['Open in Safari', 'Stay Here'], defaultId: 0, cancelId: 1, message, detail }
    : { type: 'info', buttons: ['OK'], message, detail })
    .then((r) => { if (MAC && r.response === 0) require('child_process').execFile('/usr/bin/open', ['-a', 'Safari', url], () => {}); });
}

function hostWindow(t) { return t.host === 'stage' ? stageWin : t.host === 'popout' ? t.popout : mainWin; }

// The site a URL belongs to, with www dropped so youtube.com and www.youtube.com
// are treated as one place.
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// The handful of sites kept open all day (settings().everyday: the ones picked on the first-run
// sheet, or the owner's four from before). Each folder listed in store.data.everydayPinned gets its
// own pinned tab for each one, once, so each folder's Instagram is its own sign-in and each
// WhatsApp its own phone. Pin or unpin them after this and Cue leaves the choice alone.
const everyday = () => (Array.isArray(settings().everyday) ? settings().everyday : []);

// Only for the folders listed - a new person's folder starts with nothing in it but what they
// open themselves.
function seedEveryday() {
  const done = store.data.everydayPinned || {};
  const list = everyday();
  for (const identity of Object.keys(done).filter(isPerson)) {
    // Remember which ones have been put there, not just that it happened once,
    // so a site added to the list later still arrives - and one that is unpinned
    // stays unpinned.
    const had = Array.isArray(done[identity]) ? done[identity] : (done[identity] ? list.slice(0, 3) : []);
    for (const url of list) {
      if (had.includes(url)) continue;
      had.push(url);
      const host = hostOf(url);
      if (tabs.some((t) => t.identity === identity && hostOf(t.url) === host)) continue;
      tabs.push(makeTab({ url, identity, pinned: true }));
    }
    done[identity] = had;
  }
  store.data.everydayPinned = done;
}

// A tab opened from another one lands where "New tabs open" says. It decides the
// ORDER only. It used to stamp the group of whichever tab it landed beside, so a
// cricket score opened from a school app was filed under Nathaniel School for
// ever, and a bank page opened from Facebook lived in Social. A tab's group is
// its address, every time, unless you move it yourself.
function placeTab(t, from) {
  const list = spaceOrder().filter((x) => !x.pinned && x !== t);
  const how = from.pinned && settings().newTabPlace === 'next' ? 'start' : settings().newTabPlace;
  const beside = how === 'start' ? list[0] : how === 'end' ? list[list.length - 1] : from;
  if (!beside) { t.order = from.order + 0.001; return; }
  const group = groupOf(beside);
  const next = list[list.indexOf(beside) + 1];
  if (how === 'start') t.order = beside.order - 1;
  else if (how === 'end' || !next || groupOf(next) !== group) t.order = beside.order + 1;
  else t.order = (beside.order + next.order) / 2;
}

// Go to the tab already showing this site in the folder he has open, rather than piling up a
// second WhatsApp. A blank url means he asked for a new tab.
function jumpTo(url) {
  const folder = openFolder();
  if (isLocked(folder)) { askUnlock(folder); return; }
  if (!url) { openTab({}); return; }
  let want = '';
  try { want = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { want = ''; }
  const here = tabs.find((t) => !t.private && t.identity === folder
    && String(hostOf(t.url) || '').toLowerCase().replace(/^www\./, '') === want);
  if (here) { activate(here.id); return; }
  openTab({ url, identity: folder });
}

// Some sites are one place, not many: your inbox, your WhatsApp, YouTube. Ten
// Gmail tabs are ten copies of the same page and all the mess that follows.
// Each folder keeps ONE tab for each of these and every later ask lands in it.
const ONE_PER_FOLDER = [
  /^mail\.google\.com$/i,
  /^web\.whatsapp\.com$/i,
  /^([a-z0-9-]+\.)?youtube\.com$/i,
  /^studio\.youtube\.com$/i,
  /^calendar\.google\.com$/i,
  /^drive\.google\.com$/i,
  /^([a-z0-9-]+\.)?instagram\.com$/i,
  /^([a-z0-9-]+\.)?facebook\.com$/i,
];
// Apps that are a PLACE, not a page, kept in the strip at the top of the sidebar for ever - one per
// folder - so they never appear as a row to pin, unpin or tidy (settings().alwaysPinned, a list of
// sites). A plain install has none: anything pinned can be unpinned. The owner's install keeps its
// four (WhatsApp, Gmail, Instagram, Facebook), and so does the school's starting setup.
const alwaysPinned = (url) => { const h = hostOf(url); return !!h && presets.hostIn(h, settings().alwaysPinned || []); };
// YouTube is three different jobs under one address, and he uses all three at
// once: the channel he is watching, Studio where he publishes, and the posts
// page where the community lives. Each keeps its own tab. Everything else on
// youtube.com is "watching".
const oneKey = (url) => {
  const h = hostOf(url);
  if (!h) return '';
  if (/^studio\.youtube\.com$/i.test(h)) return 'studio.youtube.com';
  if (/youtube\.com$/i.test(h)) {
    let path = '';
    try { path = new URL(url).pathname; } catch {}
    return /\/(posts|community)(\/|$)|^\/post\//i.test(path) ? 'youtube-community' : 'youtube.com';
  }
  return ONE_PER_FOLDER.some((r) => r.test(h)) ? h.toLowerCase() : '';
};
// The tab this folder already keeps for that site, if it has one.
function soleTab(url, who) {
  const key = oneKey(url);
  if (!key) return null;
  return tabs.filter((t) => t.identity === who && t.id !== programId && oneKey(t.url) === key && !t.private)
    .sort((a, b) => b.lastActive - a.lastActive)[0] || null;
}

// Tabs that were already piled up before the rule above existed. Keeps the one
// used most recently in each folder and closes its copies. Pinned tabs are
// never the one that goes.
function mergeDupes() {
  const keep = new Map();
  const drop = [];
  for (const t of [...tabs].sort((a, b) => (b.pinned - a.pinned) || (b.lastActive - a.lastActive))) {
    if (!isFolder(t.identity) || t.private || t.id === programId || t.agent || isStart(t.url) || !t.url) continue;
    // Either a site that is only ever one place, or the very same address open
    // twice in the same folder — three Chord Trees tabs are three of one thing.
    const key = oneKey(t.url) || t.url;
    if (!key) continue;
    const k = `${t.identity}|${key}`;
    // A pinned tab counts as the one this folder keeps. It used to be skipped
    // altogether, so a pinned WhatsApp and a loose second one both survived -
    // an icon at the top and a row under Social at the same time. The pinned one
    // wins (it sorts first) and the loose copy goes; a pinned tab is never the
    // one closed.
    if (keep.has(k)) { if (!t.pinned) drop.push(t); } else keep.set(k, t);
  }
  for (const t of drop) {
    const i = tabs.indexOf(t);
    if (i >= 0) tabs.splice(i, 1);
    if (t.view) { try { t.view.webContents.close(); } catch {} }
  }
  return drop.length;
}

function openTab({ url, identity, background, after, agent, pinned, focusUi, own, temp } = {}) {
  if (identity === 'vanish') return vanish.add(url && !isStart(url) ? url : undefined);
  const who = identityOf(identity) ? identity : folderForNewTab();
  if (isLocked(who)) throw new Error(`${folderName(who)} is locked. Type its passcode first.`);
  // `own`: an agent's own tab, beside his. Without it, "one Gmail per folder" would hand the agent
  // HIS inbox and move it to the agent's search while he reads.
  const only = url && isFolder(who) && !own ? soleTab(url, who) : null;
  if (only) {
    // Go to the one that is already open, and take it where you asked to go.
    ensureView(only);
    if (url && hostOf(url) === hostOf(only.url) && url !== only.url) {
      only.url = url;
      only.view.webContents.loadURL(guardUrl(url)).catch(() => {});
    }
    if (!background) activate(only.id, agent ? 'agent' : 'user', { keepUiFocus: focusUi });
    pushState();
    return only;
  }
  const safe = settings().httpsFirst !== false && url ? secureVersion(url) : null;
  // A link opened from a "Just for now" tab is just for now too, unless asked otherwise.
  const t = makeTab({ url: safe || url || START_URL, identity: who, agent, pinned, temp: temp ?? !!(after && after.temp && after.identity === who && !agent) });
  if (safe) t.httpsFrom = url;
  if (after) {
    const i = tabs.indexOf(after);
    placeTab(t, after);
    tabs.splice(i + 1, 0, t);
  } else tabs.push(t);
  ensureView(t);
  if (!background) activate(t.id, agent ? 'agent' : 'user', { keepUiFocus: focusUi });
  pushState(); persist();
  return t;
}

// `by` is who asked. Only HE moves the folder he has open. An agent reading
// Personal's mail while he works in School used to swap the sidebar to Personal
// mid-sentence, which greyed out every tab he had and sent the next Google
// sign-in into the wrong folder. Automation may bring a tab forward inside the
// folder he is already in; a tab in another folder is left in the background,
// where an agent can work in it perfectly well without taking his window.
// `keepUiFocus` is for the one case where the tab comes up but the typing must
// not: a brand-new tab, where he is about to type an address. Giving the page
// keyboard focus there swallowed every keystroke - the address bar lit up, the
// engine row appeared, and the letters went into the empty start page instead.
function activate(id, by = 'user', { keepUiFocus = false } = {}) {
  const t = byId(id); if (!t) return;
  if (isLocked(t.identity)) { if (by === 'user') askUnlock(t.identity); return; }
  if (by !== 'user' && isFolder(t.identity) && t.identity !== openFolder()) return;
  if (t.space !== store.data.space && t.id !== programId) enterSpace(t.space);
  if (t.id !== programId && by === 'user') followFolder(t);
  activeId = id; t.lastActive = Date.now();
  if (t.mini) { miniBack(t); } else if (t.host === 'popout' && t.popout) { t.popout.focus(); }
  ensureView(t);
  if (t.calm) { t.calm = false; if (t.held) { t.held = false; t.view.webContents.send('cue:media', 'play'); } }
  const sp = store.data.split;
  if (sp.mode !== 'single' && !sp.ids.includes(id)) sp.ids = [id];
  layout(); pushState(); persist();
  if (t.view && t.host === 'main' && !keepUiFocus) t.view.webContents.focus();
}

// The last tab closed IN THE FOLDER THAT IS OPEN. Another person's closed tabs are theirs.
function reopenClosed(folder = openFolder()) {
  if (isLocked(folder)) return null;
  for (let i = closedStack.length - 1; i >= 0; i--) {
    if (closedStack[i].identity !== folder) continue;
    const [s] = closedStack.splice(i, 1);
    const t = makeTab(s); tabs.push(t); activate(t.id);
    return t;
  }
  return null;
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id); if (i < 0) return;
  const t = tabs[i];
  if (t.identity !== 'vanish') closedStack.push(serialize(t));
  if (t.fullscreen) { const w = hostWindow(t); if (w) w.setFullScreen(false); }
  if (recTabId === id) { sendEvent('rec-stop'); recTabId = null; }
  if (t.id === programId) { programId = null; showStandby(); }
  if (cueIds.includes(t.id)) { cueIds = cueIds.filter((x) => x !== t.id); if (cueNextId === t.id) cueNextId = cueIds[0] || null; }
  destroyView(t);
  if (t.popout) { const w = t.popout; t.popout = null; w.destroy(); }
  tabs.splice(i, 1);
  store.data.split.ids = store.data.split.ids.filter((x) => x !== id);
  fitSplit(store.data.split);
  if (activeId === id) {
    // The next tab of the same folder, so closing a tab never walks you into somebody else's.
    const next = byId(store.data.split.ids[0]) || spaceOrder().find((x) => x.identity === t.identity);
    if (next) activate(next.id);
    else if (isFolder(t.identity) && !isLocked(t.identity)) openTab({ identity: t.identity });
    else { const any = spaceOrder()[0]; if (any) activate(any.id); else if (!isLocked(openFolder())) openTab({}); }
  }
  layout(); pushState(); persist();
}

function destroyView(t) {
  if (!t.view) return;
  clearTimeout(t.awakeTimer); t.awake = false;
  const v = t.view; t.view = null;
  if (shield) { try { shield.forget(v.webContents.id); } catch {} }
  for (const w of [mainWin, stageWin, t.popout]) { try { if (w) w.contentView.removeChildView(v); } catch {} }
  try { v.webContents.close(); } catch {}
}

function serialize(t) {
  const { uid, url, title, name, favicon, identity, pinned, groupOverride, volume, muted, private: p, obsScene, order, zoom, aiAllowed, space, lastActive, agent } = t;
  return { uid, url, title, name, favicon, identity, pinned, groupOverride, volume, muted, private: p, obsScene, order, zoom, aiAllowed, space, lastActive, agent, ...(t.temp ? { temp: true, tempAt: t.tempAt } : {}) };
}

// ---------------------------------------------------------------- the two tiers of tabs
// Tier 1, kept: pinned apps and ordinary tabs stay until the person closes them (archiveDays 0).
// Tier 2, "Just for now": their own section under the ordinary tabs. With tempClear 'quit' they
// are never written to cue.json at all, so neither a quit nor a crash brings them back; with a
// number of hours they are saved and cleared once that long has passed since they became temp.
const tempHours = () => { const v = settings().tempClear; return v === 'quit' || v == null ? 0 : Math.max(1, Number(v) || 0); };
const savesTemp = () => tempHours() > 0;
// Make a tab "Just for now" or keep it. A pinned tab is kept by definition, so making one
// temporary unpins it - except the strip apps, which are one per folder for good.
function setTemp(t, on) {
  if (!t || !isFolder(t.identity)) return { error: 'Only a tab in a folder can be just for now.' };
  on = !!on;
  if (on && t.pinned && alwaysPinned(t.url)) return { error: `${tabName(t)} lives in the strip, one in each folder, so it is always kept.` };
  if (on === !!t.temp) return { ok: true };
  if (on) { t.temp = true; t.tempAt = Date.now(); t.pinned = false; } else { delete t.temp; delete t.tempAt; }
  t.order = Date.now();
  pushState(); persist();
  return { ok: true };
}
// Throw "Just for now" tabs away: no archive, and out of Reopen Closed Tab for good.
// `folder` limits it to one person's folder; `olderThan` (ms timestamp) to tabs past the limit.
function clearTemp({ folder, olderThan, spare = [] } = {}) {
  const gone = tabs.filter((t) => t.temp && (!folder || t.identity === folder) && (!olderThan || (t.tempAt || 0) <= olderThan) && !spare.includes(t.id));
  const uids = new Set(gone.map((t) => t.uid));
  for (const t of gone) closeTab(t.id);
  for (let i = closedStack.length - 1; i >= 0; i--) {
    const c = closedStack[i];
    if (uids.has(c.uid) || (c.temp && (!folder || c.identity === folder) && (!olderThan || (c.tempAt || 0) <= olderThan))) closedStack.splice(i, 1);
  }
  if (gone.length) { layout(); pushState(); persist(); }
  return gone.length;
}
// From the one-minute timer. `now` is a parameter so the test can move the clock.
function sweepTemp(now = Date.now()) {
  const h = tempHours();
  if (!h) return 0;
  // The tab you are reading and the one on air wait for the next sweep after you leave them.
  return clearTemp({ olderThan: now - h * 3600000, spare: [activeId, programId].filter(Boolean) });
}

function persist() {
  store.data.tabs = tabs.filter((t) => t.identity !== 'vanish' && !(t.temp && !savesTemp())).map(serialize);
  store.data.cue = cueTabs().map((t) => t.uid);
  const a = byId(activeId);
  store.data.activeIndex = a ? store.data.tabs.findIndex((s) => s.uid === a.uid) : 0;
  // Tab numbers change on every launch, so split views are saved by each tab's lasting id.
  const lasting = (sp) => ({ ...sp, ids: undefined, uids: sp.ids.map((id) => byId(id)?.uid).filter(Boolean) });
  store.data.savedSplit = lasting(store.data.split);
  store.data.savedSpaceSplit = Object.fromEntries(Object.entries(store.data.spaceSplit).map(([k, v]) => [k, lasting(v)]));
  store.save();
}

// ---------------------------------------------------------------- layout
function contentRect() {
  const [w, h] = mainWin.getContentSize();
  const top = TOOLBAR + (stripOpen ? STRIP : 0); const x = sideSpace();
  return { x, y: top, width: Math.max(0, w - x - (aiView ? aiWidth() + AI_GRIP : 0)), height: Math.max(0, h - top) };
}

function splitRects(mode, r, sp = {}) {
  const g = GAP; const out = [];
  const cols = (n) => {
    const room = r.width - g * (n + 1); const fr = sp.fr && sp.fr.length === n ? sp.fr : Array(n).fill(1 / n); let x = r.x + g;
    for (let i = 0; i < n; i++) { const w = room * fr[i]; out.push({ x, y: r.y, width: w, height: r.height - g }); x += w + g; }
  };
  if (mode === 'cols2') cols(2);
  else if (mode === 'cols3') cols(3);
  else if (mode === 'rows2') {
    const room = r.height - g * 2; const fr = sp.fr && sp.fr.length === 2 ? sp.fr : [0.5, 0.5]; let y = r.y;
    for (let i = 0; i < 2; i++) { const h = room * fr[i]; out.push({ x: r.x + g, y, width: r.width - g * 2, height: h }); y += h + g; }
  } else if (mode === 'grid4') {
    const rx = r.width - g * 3; const ry = r.height - g * 2; const fx = sp.fx || 0.5; const fy = sp.fy || 0.5;
    const xs = [r.x + g, r.x + g * 2 + rx * fx]; const ws = [rx * fx, rx * (1 - fx)];
    const ys = [r.y, r.y + g + ry * fy]; const hs = [ry * fy, ry * (1 - fy)];
    for (let i = 0; i < 4; i++) out.push({ x: xs[i % 2], y: ys[Math.floor(i / 2)], width: ws[i % 2], height: hs[Math.floor(i / 2)] });
  } else out.push({ ...r });
  return out.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) }));
}

// The gaps between split panes are real handles: dragging one resizes the panes either side.
function resizeSplit({ i, axis, pos }) {
  const sp = store.data.split; const r = contentRect(); const n = SPLITS[sp.mode];
  const clamp = (v) => Math.max(0.14, Math.min(0.86, v));
  if (sp.mode === 'grid4') {
    if (axis === 'x') sp.fx = clamp((pos - r.x) / r.width); else sp.fy = clamp((pos - r.y) / r.height);
  } else if (sp.mode !== 'single') {
    const size = axis === 'x' ? r.width : r.height; const from = axis === 'x' ? r.x : r.y;
    const fr = sp.fr && sp.fr.length === n ? [...sp.fr] : Array(n).fill(1 / n);
    const before = fr.slice(0, i).reduce((a, b) => a + b, 0); const pair = fr[i] + fr[i + 1];
    const left = Math.max(0.14, Math.min(pair - 0.14, (pos - from) / size - before));
    fr[i] = left; fr[i + 1] = pair - left; sp.fr = fr;
  }
  layout(); pushState(); persist();
}

function splitGutters(rects, mode) {
  const out = [];
  if (mode === 'cols2' || mode === 'cols3') rects.slice(0, -1).forEach((b, i) => out.push({ i, axis: 'x', x: b.x + b.width, y: b.y, width: GAP, height: b.height }));
  else if (mode === 'rows2') out.push({ i: 0, axis: 'y', x: rects[0].x, y: rects[0].y + rects[0].height, width: rects[0].width, height: GAP });
  else if (mode === 'grid4') {
    out.push({ i: 0, axis: 'x', x: rects[0].x + rects[0].width, y: rects[0].y, width: GAP, height: rects[2].y + rects[2].height - rects[0].y });
    out.push({ i: 0, axis: 'y', x: rects[0].x, y: rects[0].y + rects[0].height, width: rects[1].x + rects[1].width - rects[0].x, height: GAP });
  }
  return out;
}

let panes = [];
let gutters = [];
let wasFull = false;
// A page that has gone - crashed, or closed from under us - leaves a view
// object on the tab that throws "Object has been destroyed" the moment anything
// touches it. One dead view used to take down the whole layout pass, and with
// it whatever Jason or an agent had just asked for. Clear them first; the tab
// is simply asleep and wakes on its next use.
function reapDeadViews() {
  for (const t of tabs) {
    if (t.view && t.view.webContents.isDestroyed()) { t.view = null; t.sleeping = true; }
  }
}

function layout() {
  if (!mainWin || mainWin.isDestroyed()) return;
  reapDeadViews();
  const [w, h] = mainWin.getContentSize();
  // A revealed sidebar floats over the page, so the page itself never jumps.
  uiView.setBounds({ x: 0, y: 0, width: sideReveal && !overlay ? sideWidth() : w, height: h });
  const sp = store.data.split;
  const active = byId(activeId);
  let ids = sp.mode !== 'single' && sp.ids.includes(activeId) ? sp.ids.filter((id) => byId(id)) : [activeId];
  ids = ids.filter((id) => { const t = byId(id); return t && t.host === 'main' && !(live && id === programId); });
  const full = active && active.fullscreen && active.host === 'main';
  const rects = full ? [{ x: 0, y: 0, width: w, height: h }] : splitRects(ids.length > 1 ? sp.mode : 'single', contentRect(), sp);
  gutters = !full && ids.length > 1 ? splitGutters(rects, sp.mode) : [];
  panes = [];
  const shown = full ? [activeId] : ids;
  for (const t of tabs) {
    if (!t.view || t.host !== 'main') continue;
    const k = shown.indexOf(t.id);
    if (k >= 0 && rects[k]) { unsize(t); t.view.setBounds(rects[k]); t.view.setVisible(true); panes.push({ id: t.id, rect: rects[k] }); }
    // A tab an agent is working in stays drawn, but outside the window's visible area: see wake().
    else if (t.awake) { t.view.setBounds(offStage()); t.view.setVisible(true); }
    else { t.view.setVisible(false); t.view.setBounds(rects[0] || contentRect()); }
  }
  if (aiView) { aiView.setBounds({ x: w - aiWidth(), y: TOOLBAR + AI_HEAD, width: aiWidth(), height: Math.max(0, h - TOOLBAR - AI_HEAD) }); aiView.setVisible(!full); }
  if (peek) {
    const r = contentRect(); const pw = Math.round(r.width * 0.5);
    peek.view.setBounds({ x: r.x + r.width - pw - 8, y: r.y + 8, width: pw, height: r.height - 16 });
    peek.view.setVisible(!full);
    if (!overlay && !full) mainWin.contentView.addChildView(peek.view);
  }
  // A video in full screen owns the whole screen. The AI panel, Peek and the sidebar's view were
  // still stacked above it (seen 13-Nov-2026): they took the mouse over a third of the picture,
  // so the controls never came back and the pointer stayed hidden until Escape. The playing tab
  // goes to the top while it is full screen, and the sidebar's view back on top when it leaves
  // with a panel or a revealed sidebar showing.
  if (full && active.view) mainWin.contentView.addChildView(active.view);
  else if (wasFull && (overlay || sideReveal)) mainWin.contentView.addChildView(uiView);
  wasFull = !!full;
  if (stageWin && !stageWin.isDestroyed()) {
    const [sw, sh] = stageWin.getContentSize();
    // One tab fills the stage; two or three share it in equal columns, which is
    // how a class sees the app and the notation at the same time.
    const up = stageTabs();
    const n = Math.max(1, up.length);
    up.forEach((t, i) => {
      if (!t.view) return;
      const x = Math.round((sw * i) / n);
      const w = Math.round((sw * (i + 1)) / n) - x;
      t.view.setBounds({ x, y: 0, width: w, height: sh });
    });
    if (stageStandby) stageStandby.setBounds({ x: 0, y: 0, width: sw, height: sh });
  }
  for (const t of tabs) {
    if (t.host === 'popout' && t.popout && t.view) { const [pw, ph] = t.popout.getContentSize(); t.view.setBounds({ x: 0, y: 0, width: pw, height: ph }); }
  }
}

function setSplit(mode) {
  if (!SPLITS[mode]) return;
  const sp = store.data.split; if (sp.mode !== mode) { delete sp.fr; delete sp.fx; delete sp.fy; } sp.mode = mode;
  if (mode === 'single') { sp.ids = [activeId]; }
  else {
    const ordered = spaceOrder().filter((t) => t.host === 'main' && !(live && t.id === programId));
    const ids = [activeId, ...sp.ids.filter((x) => x !== activeId && byId(x))];
    for (const t of ordered) { if (ids.length >= SPLITS[mode]) break; if (!ids.includes(t.id)) ids.push(t.id); }
    sp.ids = ids.slice(0, SPLITS[mode]);
    sp.ids.forEach((id) => ensureView(byId(id)));
  }
  layout(); pushState(); persist();
}

// A split with fewer tabs than its layout has room for closes up rather than leaving a hole.
function fitSplit(sp) {
  const n = sp.ids.length; const was = sp.mode;
  if (n <= 1) sp.mode = 'single';
  else if (n < SPLITS[sp.mode]) sp.mode = n === 3 ? 'cols3' : (sp.mode === 'rows2' ? 'rows2' : 'cols2');
  if (sp.mode !== was) { delete sp.fr; delete sp.fx; delete sp.fy; }
  return sp;
}

function addToSplit(id) {
  const sp = store.data.split;
  if (sp.mode === 'single') { sp.mode = 'cols2'; sp.ids = [activeId]; }
  if (sp.ids.includes(id)) sp.ids = sp.ids.filter((x) => x !== id);
  else {
    if (sp.ids.length >= SPLITS[sp.mode]) sp.mode = sp.ids.length + 1 >= 4 ? 'grid4' : sp.ids.length + 1 === 3 ? 'cols3' : 'cols2';
    sp.ids.push(id);
  }
  if (sp.ids.length <= 1) { sp.mode = 'single'; }
  ensureView(byId(id));
  layout(); pushState(); persist();
}

// A locked folder's tabs are in no list at all: not the sidebar, not the agents', not the pedal's,
// not Ctrl-Tab's. They are still there, asleep, for when the folder is unlocked.
function sidebarOrder() {
  const order = groupList().map((g) => g.id);
  return tabs.filter((t) => !isLocked(t.identity)).sort((a, b) => (b.pinned - a.pinned) || (order.indexOf(groupOf(a)) - order.indexOf(groupOf(b))) || (a.order - b.order));
}
function spaceOrder() { return sidebarOrder().filter((t) => t.space === store.data.space); }

// ---------------------------------------------------------------- spaces
// Each Space keeps its own tabs, its own usual login and its own split layout.
function enterSpace(name) {
  if (!spaces().includes(name) || name === store.data.space) return;
  store.data.spaceSplit[store.data.space] = store.data.split;
  store.data.space = name;
  const saved = store.data.spaceSplit[name] || { mode: 'single', ids: [] };
  store.data.split = fitSplit({ mode: saved.mode, ids: saved.ids.filter((id) => byId(id) && !isLocked(byId(id).identity)) });
  if (store.data.split.ids.length < 2) store.data.split = { mode: 'single', ids: [] };
  store.data.split.ids.forEach((id) => ensureView(byId(id)));
}
function switchSpace(name) {
  if (name === store.data.space) return;
  enterSpace(name);
  const list = tabs.filter((t) => t.space === name && t.id !== programId && !isLocked(t.identity)).sort((a, b) => b.lastActive - a.lastActive);
  const first = list.find((t) => store.data.split.ids.includes(t.id)) || list[0];
  // Landing on a tab takes you into that tab's folder (activate does it). An
  // empty Space has no tab to follow, so it falls back to the folder this Space
  // usually uses — Teach to School, Create to Personal, as set in Settings.
  if (first) activate(first.id);
  else {
    const usual = usualFolderFor(name);
    if (!isLocked(usual)) store.data.folder = usual;
    if (!isLocked(openFolder())) openTab({});
  }
  layout(); pushState(); persist();
}

// ---------------------------------------------------------------- live / stage
function openStage() {
  if (stageWin && !stageWin.isDestroyed()) return;
  const s = settings();
  stageWin = new BaseWindow({
    width: s.stageWidth, height: s.stageHeight, useContentSize: true, title: 'Cue Stage — On Air',
    backgroundColor: '#000000', enableLargerThanScreen: true, fullscreenable: true, show: false,
    // No title bar. What OBS and Zoom capture is then the page and nothing
    // else — no bar across the top of the class's screen. Cue opens, sizes and
    // closes this window itself, so there is nothing on it to need dragging.
    frame: false, movable: true,
  });
  stageWin.setContentSize(s.stageWidth, s.stageHeight);
  // It opens behind him, not over him. The Stage is what OBS and Zoom capture;
  // he carries on working in Cue's own window and never has to put it back.
  stageWin.showInactive();
  stageStandby = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  stageWin.contentView.addChildView(stageStandby);
  stageStandby.webContents.loadFile(STAGE_HTML);
  stageWin.on('resize', layout);
  stageWin.on('closed', () => { stageWin = null; stageStandby = null; if (live) setLive(false, true); });
  // macOS hands OBS its list of capturable windows on a delay, so a window a
  // second old is still "invalid" to it. Three goes, spread out, and the last
  // one always lands.
  obsAimAtStage().catch(() => {});
  layout();
}

function showStandby() { if (stageStandby) stageStandby.setVisible(true); }

// OBS was set to capture Cue the APPLICATION, which hands the class every Cue
// window there is — sidebar, address bar and all. What a class should see is
// the Stage window and nothing else. The window's id changes every time the
// Stage opens, which is why doing this by hand never stayed done, so Cue tells
// OBS the new id itself: whenever the Stage opens, and again whenever OBS
// reconnects. Any screen-capture source already pointed at Cue is re-aimed, so
// his existing scenes keep working with no setting up.
async function obsAimAtStage() {
  if (!stageWin || stageWin.isDestroyed() || obs.status !== 'connected') return;
  let window = 0;
  try { window = Number(String(stageWin.getMediaSourceId()).split(':')[1]) || 0; } catch { return; }
  if (!window) return;
  let names = [];
  try { names = await obs.inputs('screen_capture'); } catch { return; }
  const ours = [];
  for (const name of names) {
    let was = null;
    try { was = await obs.settings(name); } catch { continue; }
    if (was && (was.application === 'com.jasonzac.cue' || /\bcue\b/i.test(name))) ours.push({ name, was });
  }
  if (!ours.length) return;

  // Wait until OBS's own list of capturable windows has the Stage in it.
  // Setting it before that leaves the source dark with "Invalid target window
  // ID" in the log, and OBS ignores a second attempt with the same numbers, so
  // guessing at delays never fixed it.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let known = false;
  for (let i = 0; i < 12 && !known; i++) {
    try { known = (await obs.propertyItems(ours[0].name, 'window')).some((x) => Number(x.itemValue) === window); } catch { return; }
    if (!known) await wait(700);
  }
  if (!known) return;

  for (const { name, was } of ours) {
    // Unchanged numbers are a no-op to OBS, so land on something else first
    // when the capture is already pointed here but showing nothing.
    if (was && was.type === 1 && Number(was.window) === window) await obs.setSettings(name, { window: 0 });
    await obs.setSettings(name, { type: 1, window, application: 'com.jasonzac.cue', show_cursor: false });
  }
  sendEvent('toast', `OBS is showing the Stage only${ours.length > 1 ? ` (${ours.length} sources)` : ''}.`);
}

// Coming out of a full-screen video used to leave the page in a half-finished
// state: no mouse pointer, no scroll bar, the picture still the full-screen
// shape inside a normal window. The window is still animating when the page is
// told, so the page measures the wrong size and Chromium keeps the pointer
// hidden the way the video asked. Lay it out again once the animation has
// finished, hand the keyboard back, and move the mouse a hair so the pointer
// comes back without him having to click.
// The Mac's full-screen animation resizes the window for about half a second after Cue has
// placed the page, and the page's view can keep listening for the mouse over the rectangle it had
// before. A one-pixel nudge once the animation is over makes it measure itself again.
// An update reopens Cue with app.exit, which skips before-quit: write the tabs down first.
function saveNow() { try { persist(); store.flush(); } catch {} }

// Why now is NOT a good moment to put an update in place and reopen. '' means it is.
function quietMomentRefusal() {
  if (process.env.CUE_TEST) return 'test';
  let idle = 0; let idleState = 'active';
  try { idle = powerMonitor.getSystemIdleTime(); idleState = powerMonitor.getSystemIdleState(20 * 60); } catch { return 'cannot tell'; }
  return quietRefusal({
    ready: !!(updater && updater.ready()), auto: settings().autoUpdate !== false, idle, idleState,
    onAir: !!(live || programId || recTabId),
    busy: tabs.some((t) => t.holdAwake || t.playing || t.audible || t.dirty) || openPopups.size > 0, // a sign-in window is someone mid-sign-in
    downloading: downloads.some((d) => d.state === 'progressing'),
    vanish: !!(vanish && vanish.window()),
    temp: !tempHours() && tabs.some((t) => t.temp),
  });
}

function settleAfterFullScreen(t, entering = false) {
  const again = () => {
    if (!t || !t.view || t.view.webContents.isDestroyed()) return;
    layout();
    if (entering && t.fullscreen) {
      try { const b = t.view.getBounds(); t.view.setBounds({ ...b, width: Math.max(1, b.width - 1) }); t.view.setBounds(b); } catch {}
    }
    try { t.view.webContents.focus(); } catch {}
    try {
      const b = t.view.getBounds();
      const x = Math.round(b.width / 2); const y = Math.round(b.height / 2);
      t.view.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      t.view.webContents.sendInputEvent({ type: 'mouseMove', x: x + 1, y: y + 1 });
    } catch {}
  };
  setTimeout(again, 120);
  setTimeout(again, 600);   // the Mac's full-screen animation is about half a second
  if (entering) setTimeout(again, 1200);
}

function moveView(t, toWin, host) {
  if (!t.view) ensureView(t);
  const from = hostWindow(t);
  try { if (from && !from.isDestroyed()) from.contentView.removeChildView(t.view); } catch {}
  t.host = host;
  toWin.contentView.addChildView(t.view);
  t.view.setVisible(true);
  if (toWin === mainWin && overlay) mainWin.contentView.addChildView(uiView);
}

function setLive(on, stageClosed) {
  if (on === live) return;
  live = on;
  tabs.forEach((t) => t.view && t.view.webContents.send('cue:hold', on));
  if (on) {
    heldCount = 0;
    // Going live is the moment OBS has to be there. If it was shut when Cue
    // started, try again now rather than fail quietly mid-class.
    if (obs.status !== 'connected' && settings().obs.host) obs.connect(settings().obs);
    openStage();
  } else {
    if (heldCount) sendEvent('toast', `${heldCount} notification${heldCount === 1 ? '' : 's'} held during class. See Bills & alerts.`);
    for (const t of stageIds.map(byId)) {
      if (!t) continue;
      t.view && t.view.webContents.send('cue:safe', false);
      if (t.host === 'stage') moveView(t, mainWin, 'main');
    }
    const p = byId(programId);
    if (p && p.host === 'stage') { p.view && p.view.webContents.send('cue:safe', false); moveView(p, mainWin, 'main'); }
    programId = null; stageIds = [];
    if (!stageClosed && stageWin && !stageWin.isDestroyed()) stageWin.destroy();
    stageWin = null; stageStandby = null;
  }
  layout(); pushState();
}

// ---------------------------------------------------------------- the cue list
// What is lined up to go on air, in his order, drag by drag. Before this, TAKE
// put up whatever tab he happened to be looking at — which meant lining a class
// up was the same as clicking through it. Now he drags the tabs he will use
// into the box once, and from then on the class is TAKE, TAKE, TAKE.
//
// Every cued tab is kept awake and rendered, so going on air is a swap, not a
// page load: that is what keeps the switch instant with nothing to catch up on.
let cueIds = [];
let cueNextId = null;
// What is on the stage right now. Usually one tab; two or three when he has
// asked for a side-by-side stage, which OBS and Zoom then capture as one
// window with no sidebar and no address bar in it.
let stageIds = [];
const stageTabs = () => stageIds.map(byId).filter((t) => t && t.view && t.host === 'stage');
const cueTabs = () => cueIds.map(byId).filter((t) => t && !isLocked(t.identity));
// Every folder a tab can be opened in right now, Vanish last: the menus' "Open as" lists.
const openableIds = () => [...allFolders().filter((k) => !isLocked(k)), 'vanish'];
const CUE_MAX = 6;

function cueWake() {
  for (const t of cueTabs()) ensureView(t);
}
function cueAdd(id) {
  const t = byId(id);
  if (!t || t.private || t.identity === 'vanish') { sendEvent('toast', 'That tab never goes on air.'); return; }
  if (cueIds.includes(id)) { cueNextId = id; pushState(); return; }
  if (cueIds.length >= CUE_MAX) { sendEvent('toast', `Six is as many as the cue holds. Take one out first.`); return; }
  cueIds.push(id);
  if (!cueNextId) cueNextId = id;
  ensureView(t);
  pushState(); persist();
  sendEvent('toast', `${t.title} is cued at ${cueIds.length}. Press TAKE to put it on air.`);
}
function cueRemove(id) {
  cueIds = cueIds.filter((x) => x !== id);
  if (cueNextId === id) cueNextId = cueIds[0] || null;
  pushState(); persist();
}
function cueMove(id, to) {
  const from = cueIds.indexOf(id);
  if (from < 0) return;
  cueIds.splice(from, 1);
  cueIds.splice(Math.max(0, Math.min(to, cueIds.length)), 0, id);
  pushState(); persist();
}
// Step to the one after whatever is on air. One key, all class long.
function cueStep(d = 1) {
  const list = cueTabs();
  if (!list.length) return;
  const at = list.findIndex((t) => t.id === programId);
  const i = at < 0 ? 0 : (at + d + list.length) % list.length;
  take(list[i].id);
}

// Two or three cued tabs on the stage at once, in cue order: the app beside the
// notation, say. One is the ordinary stage, so n=1 goes back to a single tab.
function stageSplit(n) {
  const want = Math.max(1, Math.min(3, n));
  const list = cueTabs().filter((t) => !t.private).slice(0, want);
  if (!list.length) { sendEvent('toast', 'Nothing is cued yet. Drag a tab onto the On-air box first.'); return; }
  if (!live) setLive(true);
  // Anything up there that is not in the new set comes home first.
  for (const t of stageIds.map(byId)) {
    if (t && t.host === 'stage' && !list.includes(t)) { t.view && t.view.webContents.send('cue:safe', false); moveView(t, mainWin, 'main'); }
  }
  for (const t of list) {
    ensureView(t);
    if (t.host === 'popout' && t.popout) { const w = t.popout; t.popout = null; moveView(t, mainWin, 'main'); w.destroy(); }
    if (t.host !== 'stage') moveView(t, stageWin, 'stage');
    if (settings().safeShare) t.view.webContents.send('cue:safe', true);
  }
  stageIds = list.map((t) => t.id);
  programId = stageIds[0];
  if (stageStandby) stageStandby.setVisible(false);
  const first = list[0];
  if (first && first.obsScene) obs.setScene(first.obsScene);
  // Never leave him looking at a tab that has gone to the stage.
  if (stageIds.includes(activeId)) {
    const other = spaceOrder().find((t) => !stageIds.includes(t.id));
    if (other) { ensureView(other); activeId = other.id; }
  }
  layout(); pushState();
  sendEvent('toast', want === 1 ? `${first.title} is on air.` : `${want} tabs are on air side by side.`);
}

// `id` lets a tab be put up straight from the cue list or dropped on the box:
// that tab goes up, whatever is in front of him. With no id it is the one the
// cue list has marked next, and only if the cue is empty does it fall back to
// the tab he is looking at.
function take(id) {
  if (!live) { setLive(true); }
  const cued = cueTabs();
  const pick = id != null ? id
    : (cued.find((t) => t.id === cueNextId) || cued.find((t) => t.id !== programId) || {}).id
    ?? activeId;
  const next = byId(pick);
  if (!next) return;
  if (next.private) { sendEvent('toast', `${next.title} is a private tab. It never goes on air.`); return; }
  if (next.id === programId) { sendEvent('toast', 'That tab is already on air.'); return; }
  const prev = byId(programId);
  ensureView(next);
  if (next.host === 'popout' && next.popout) { const w = next.popout; next.popout = null; moveView(next, mainWin, 'main'); w.destroy(); }
  moveView(next, stageWin, 'stage');
  if (stageStandby) stageStandby.setVisible(false);
  programId = next.id;
  stageIds = [next.id];
  if (settings().safeShare) next.view.webContents.send('cue:safe', true);
  if (prev) {
    prev.view && prev.view.webContents.send('cue:safe', false);
    moveView(prev, mainWin, 'main');
    activeId = prev.id;
  } else {
    const other = spaceOrder().find((t) => t.id !== next.id);
    activeId = other ? other.id : activeId;
    if (other) ensureView(other);
  }
  if (next.obsScene) obs.setScene(next.obsScene);
  // The cue moves on by itself, so TAKE, TAKE, TAKE walks the class in order.
  const list = cueTabs();
  const at = list.findIndex((t) => t.id === next.id);
  cueNextId = at >= 0 ? (list[(at + 1) % list.length] || {}).id || null : (list[0] || {}).id || null;
  cueWake();
  layout(); pushState();
  sendEvent('toast', `${next.title} is on air${next.obsScene ? ` · OBS: ${next.obsScene}` : ''}.`);
}

function popOut(t) {
  if (!t || t.host !== 'main') return;
  ensureView(t);
  const w = new BaseWindow({ width: 1280, height: 720, useContentSize: true, title: `Cue · ${t.title}`, backgroundColor: '#FFFFFF' });
  t.popout = w;
  moveView(t, w, 'popout');
  w.on('resize', layout);
  w.on('closed', () => { if (t.popout === w) { t.popout = null; t.mini = false; if (t.view) moveView(t, mainWin, 'main'); layout(); pushState(); } });
  layout(); pushState();
}

// Mini player. The thing he is watching keeps playing in a small window that
// floats over everything - over Cue, over Final Cut, over a full-screen app -
// while he carries on in another tab. It is the same plumbing as popping a tab
// out, only small, pinned on top and remembered, so clicking the tab in the
// sidebar puts it back where it came from.
function miniBack(t) {
  if (!t || !t.popout) return false;
  const w = t.popout; t.popout = null; t.mini = false;
  if (t.view) { t.view.webContents.executeJavaScript(MINI_UNFILL, true).catch(() => {}); moveView(t, mainWin, 'main'); }
  w.destroy(); layout(); pushState();
  return true;
}

function miniPlay(t) {
  if (!t) return;
  if (t.mini) { miniBack(t); return; }
  // What is on air belongs to the class, and the Stage is its window.
  if (t.host === 'stage' || t.id === programId) { sendEvent('toast', 'That tab is on air. Take it off air first.'); return; }
  if (t.host === 'popout') miniBack(t);
  ensureView(t);
  const size = settings().miniSize || { width: 480, height: 270 };
  const area = screen.getPrimaryDisplay().workArea;
  const w = new BaseWindow({
    width: size.width, height: size.height, useContentSize: true,
    x: area.x + area.width - size.width - 24, y: area.y + area.height - size.height - 24,
    title: `Cue mini \u00b7 ${t.title}`, backgroundColor: '#000000',
    alwaysOnTop: true, minimizable: false, fullscreenable: false, maximizable: false,
  });
  w.setAlwaysOnTop(true, 'floating');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  t.popout = w; t.mini = true;
  moveView(t, w, 'popout');
  // Give the page a beat to settle in the small window before the video takes it over.
  const fill = () => t.view && t.view.webContents.executeJavaScript(MINI_FILL, true).catch(() => {});
  setTimeout(fill, 150); setTimeout(fill, 1200);
  w.on('resize', () => { const [cw, ch] = w.getContentSize(); setSetting('miniSize', { width: cw, height: ch }); layout(); });
  w.on('closed', () => { if (t.popout === w) { t.popout = null; t.mini = false; if (t.view) { t.view.webContents.executeJavaScript(MINI_UNFILL, true).catch(() => {}); moveView(t, mainWin, 'main'); } layout(); pushState(); } });
  layout(); pushState();
}

// ---------------------------------------------------------------- navigation
function resolveInput(text, engine) {
  const q = (text || '').trim();
  if (!q) return START_URL;
  if (engine && ENGINES[engine]) return ENGINES[engine] + encodeURIComponent(q);
  const m = q.match(/^(\w+)\s+(.+)$/);
  if (m && PREFIX[m[1].toLowerCase()]) return ENGINES[PREFIX[m[1].toLowerCase()]] + encodeURIComponent(m[2]);
  if (/^[a-z][\w+.-]*:\/\//i.test(q) || /^(about|file|data|mailto):/i.test(q)) return q;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(q) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(q)) return 'http://' + q;
  if (!/\s/.test(q) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(q)) return 'https://' + q;
  return ENGINES.google + encodeURIComponent(q);
}

function navigate({ text, engine, newTab, identity }) {
  const typed = resolveInput(text, engine);
  const secure = (settings().httpsFirst !== false && secureVersion(typed)) || typed;
  const t = byId(activeId);
  if (newTab || !t) {
    const who = identity || (t ? t.identity : undefined);
    return openTab({ url: googleForFolder(secure, who || store.data.folder), identity: who });
  }
  const url = googleForFolder(secure, t.identity);
  ensureView(t);
  t.url = url;
  if (url !== typed) t.httpsFrom = typed;
  t.view.webContents.loadURL(guardUrl(url)).catch(() => {});
  t.view.webContents.focus();
  pushState();
}

function contextMenu(t, p) {
  const wc = t.view.webContents;
  const items = [];
  const ids = openableIds();
  if (p.linkURL) {
    items.push({ label: 'Open link in new tab', click: () => openTab({ url: p.linkURL, identity: t.identity, background: true, after: t }) });
    items.push({ label: 'Peek at this link', click: () => openPeek(p.linkURL, t) });
    items.push({ label: 'Open link as…', submenu: ids.map((i) => ({ label: folderName(i), click: () => openTab({ url: p.linkURL, identity: i, after: t }) })) });
    items.push({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push({ label: 'Open image in new tab', click: () => openTab({ url: p.srcURL, identity: t.identity, after: t }) });
    items.push({ label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) });
    items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) });
    items.push({ label: 'Search this image with Google Lens', click: () => openTab({ url: 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(p.srcURL), identity: t.identity, after: t }) });
    items.push({ label: 'Ask Claude about this image', click: () => askAI('claude', `Tell me about this image: ${p.srcURL}`) });
    if (kit('designer') && t.identity !== 'vanish') {
      const mine = lib.in(t.identity); // this folder's boards, never another's
      const boards = mine.boardList();
      items.push({ label: 'Add to board', submenu: [...boards.map((b) => ({ label: b.name, click: () => addToBoard(t, p, b.id) })), { type: 'separator' }, { label: 'New board', click: () => addToBoard(t, p, mine.boardCreate(`Board ${boards.length + 1}`)) }] });
      items.push({ label: 'Palette from this image', click: () => imagePalette(t, p) });
    }
    items.push({ type: 'separator' });
  }
  const sel = (p.selectionText || '').trim();
  if (sel) {
    const short = sel.length > 30 ? sel.slice(0, 30) + '…' : sel;
    items.push({ label: 'Copy', role: 'copy' });
    items.push({ label: `Search Google for “${short}”`, click: () => openTab({ url: resolveInput(sel, 'google'), identity: t.identity, after: t }) });
    items.push({ label: 'Ask Claude about this', click: () => openTab({ url: resolveInput(sel, 'claude'), identity: t.identity, after: t }) });
    items.push({ label: 'Ask ChatGPT about this', click: () => openTab({ url: resolveInput(sel, 'chatgpt'), identity: t.identity, after: t }) });
    items.push({ type: 'separator' });
  }
  if (p.misspelledWord) {
    for (const word of (p.dictionarySuggestions || []).slice(0, 5)) items.push({ label: word, click: () => wc.replaceMisspelling(word) });
    items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
  }
  if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }, { type: 'separator' });
  if (p.mediaType === 'video') items.push({ label: 'Picture in Picture', click: () => wc.executeJavaScript(PICTURE_IN_PICTURE, true).catch(() => {}) }, { type: 'separator' });
  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    { label: 'Print…', click: () => wc.print() },
    { type: 'separator' },
    { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
  );
  Menu.buildFromTemplate(items).popup({ window: hostWindow(t) });
}

function tabMenu(t) {
  if (!t) return;
  Menu.buildFromTemplate(tabMenuItems(t)).popup({ window: mainWin });
}
function tabMenuItems(t) {
  const ids = openableIds();
  const moveTo = allFolders().filter((i) => i !== t.identity && !isLocked(i));
  const items = [
    { label: t.pinned ? 'Unpin' : 'Pin', click: () => { t.pinned = !t.pinned; if (t.pinned) { delete t.temp; delete t.tempAt; } pushState(); persist(); } },
    // The two tiers: a tab is kept until you close it, or it is just for now.
    ...(isFolder(t.identity) ? [t.temp
      ? { label: 'Keep this tab', click: () => setTemp(t, false) }
      : { label: 'Just for now', enabled: !(t.pinned && alwaysPinned(t.url)), click: () => { const r = setTemp(t, true); if (r.error) sendEvent('toast', r.error); } }] : []),
    { label: t.muted ? 'Unmute' : 'Mute', click: () => setMuted(t, !t.muted) },
    // Opens the tab's volume control in the sidebar, with the keyboard in it.
    { label: `Volume… (${Math.round((t.volume ?? 1) * 100)}%)`, click: () => { try { uiView.webContents.focus(); } catch {} sendEvent('volume-pop', { id: t.id }); } },
    { label: 'Duplicate', click: () => openTab({ url: t.url, identity: t.identity, after: t }) },
    // Two different things, named for what they do: one leaves this tab where
    // it is and opens a second copy elsewhere; the other takes this tab with you.
    { label: 'Move to folder', enabled: isFolder(t.identity) && moveTo.length > 0, submenu: moveTo.length ? moveTo.map((i) => ({ label: folderName(i), click: () => moveToFolder({ id: t.id, to: i }) })) : [{ label: 'No other folder', enabled: false }] },
    { label: 'Open a copy in…', submenu: ids.filter((i) => i !== t.identity).map((i) => ({ label: folderName(i), click: () => openTab({ url: t.url, identity: i, after: t }) })) },
    { label: 'Add to split view', click: () => addToSplit(t.id) },
    { label: 'Move to Space', submenu: spaces().map((n) => ({ label: n, type: 'radio', checked: t.space === n, click: () => { t.space = n; const sp = store.data.split; sp.ids = sp.ids.filter((x) => x !== t.id); fitSplit(sp); if (t.id === activeId) { const o = spaceOrder().filter((x) => x.id !== t.id)[0]; if (o) activate(o.id); else openTab({}); } pushState(); persist(); } })) },
    { label: t.mini ? 'Back from the mini player' : 'Mini player (floats while you work)', click: () => miniPlay(t) },
    { label: 'Pop out to its own window (for Zoom and OBS)', enabled: t.host === 'main', click: () => popOut(t) },
    { type: 'separator' },
    { label: 'Off air: never shown to the class', type: 'checkbox', checked: t.private, click: () => { t.private = !t.private; pushState(); persist(); } },
    { label: 'Let AI agents use this tab', type: 'checkbox', checked: t.aiAllowed || t.agent, enabled: !t.agent, click: () => { t.aiAllowed = !t.aiAllowed; pushState(); persist(); } },
    { label: 'Move to group', submenu: [{ label: 'Automatic', type: 'radio', checked: !t.groupOverride, click: () => { t.groupOverride = null; pushState(); persist(); } }, ...groupList().map((g) => ({ label: g.name, type: 'radio', checked: t.groupOverride === g.id, click: () => { t.groupOverride = g.id; pushState(); persist(); } }))] },
    { type: 'separator' },
    { label: 'Close tab', click: () => closeTab(t.id) },
  ];
  return items;
}

// Picture of a tab, even one that is behind others: briefly show it underneath the visible tabs.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function captureTab(t) {
  ensureView(t);
  const v = t.view; const w = hostWindow(t);
  const hidden = !v.getVisible();
  if (hidden && w) { w.contentView.addChildView(v, 1); v.setVisible(true); await wait(200); }
  try {
    for (let i = 0; ; i++) {
      try { const img = await v.webContents.capturePage(); if (!img.isEmpty()) return img; } catch (e) { if (i >= 4) throw e; }
      if (i >= 4) return null;
      await wait(250);
    }
  } finally { if (hidden && t.view === v) v.setVisible(false); }
}

function setMuted(t, m) { t.muted = m; if (t.view) t.view.webContents.setAudioMuted(m); pushState(); persist(); }
function setVolume(t, v) {
  t.volume = Math.max(0, Math.min(1, Number(v) || 0));
  if (t.view) t.view.webContents.send('cue:volume', t.volume);
  if (t.volume > 0 && t.muted) setMuted(t, false);
  pushState(); persist();
}

function setOverlay(on) {
  overlay = !!on;
  if (!mainWin) return;
  if (overlay || sideReveal) mainWin.contentView.addChildView(uiView);
  else mainWin.contentView.addChildView(uiView, 0);
  layout();
  // Settings sits OVER the page, but the keyboard was still in the page
  // underneath, so Escape went to the website and the panel stayed open. The
  // panel takes the keyboard while it is up, and hands it back when it closes.
  if (overlay) { try { uiView.webContents.focus(); } catch {} }
  else { const t = byId(activeId); if (t && t.view) { try { t.view.webContents.focus(); } catch {} } }
}

function setSideReveal(on) {
  if (!settings().sideHidden && on) return;
  if (sideReveal === !!on) return;
  sideReveal = !!on;
  setOverlay(overlay); pushState();
}

function setSideHidden(on) { settings().sideHidden = !!on; sideReveal = false; store.save(); setOverlay(overlay); pushState(); }

// ---------------------------------------------------------------- UI state
let stateTimer = null;
function pushState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; sendState(); }, 30);
}

// The sidebar is told about ONE folder: the one that is open. Every other folder is a name, a
// colour, a picture, whether it is locked, and counts - never a title, an address or an account.
// A locked folder is not even counted. The only tabs of another folder that are named at all are
// the ones on air or in the cue, because the class can already see those, and even they go with
// no address.
function folderFaces(here) {
  const ids = allFolders().filter((k) => k !== 'agent' || tabs.some((t) => t.identity === 'agent'));
  const identities = { vanish: { name: BUILTIN.vanish.name, color: BUILTIN.vanish.color } };
  const info = {};
  for (const id of ids) {
    const v = identityOf(id);
    const locked = isLocked(id);
    identities[id] = { name: v.name, color: v.color, picture: v.picture, locked, ...(id === here ? { about: v.about } : {}) };
    if (locked) { info[id] = { locked: true }; continue; }
    const mine = tabs.filter((t) => t.identity === id);
    info[id] = {
      tabs: mine.length,
      here: mine.filter((t) => t.space === store.data.space).length,
      unread: mine.reduce((n, t) => n + (t.badge || 0), 0),
    };
  }
  return { ids, identities, info };
}

function sendState() {
  if (!uiView || uiView.webContents.isDestroyed()) return;
  const s = settings();
  const here = openFolder();
  const shut = isLocked(here);
  const faces = folderFaces(here);
  const mine = shut ? [] : sidebarOrder().filter((t) => t.identity === here);
  const shown = new Set([programId, ...stageIds, ...cueIds]);
  const away = shut ? [] : sidebarOrder().filter((t) => t.identity !== here && shown.has(t.id)).map((t) => ({
    id: t.id, url: '', title: t.title, name: t.name || null, siteName: tabName(t), identity: t.identity, away: true,
    pinned: false, group: 'other', space: t.space, muted: t.muted, volume: t.volume, host: t.host, private: t.private,
  }));
  lastState = {
    tabs: [...mine.map((t) => ({
      id: t.id, url: isStart(t.url) ? '' : t.url, title: t.title, name: t.name || null, favicon: t.favicon, identity: t.identity, pinned: t.pinned,
      siteName: tabName(t), siteLogo: siteLogo(t),
      group: groupOf(t), volume: t.volume, muted: t.muted, private: t.private, obsScene: t.obsScene, agent: t.agent,
      aiAllowed: t.aiAllowed, aiOk: agentCanAct(t), aiSite: handedOverSite(t),
      // Handed over whether or not agents are paused, so the AI row can still
      // show him what they have while they are on hold.
      aiHanded: !t.private && t.id !== programId && !t.url.startsWith('cue://') && (t.agent || t.aiAllowed || HANDED_OVER(t) || t.identity === 'agent'),
      playing: t.playing, audible: t.audible, loading: t.loading, sleeping: !t.view,
      host: t.host, mini: !!t.mini, canBack: t.canBack, canFwd: t.canFwd, crashed: !!t.crashed, space: t.space, badge: t.badge,
      lastActive: t.lastActive, temp: !!t.temp, tempAt: t.tempAt || 0,
      aiBusy: !!t.aiBusy,
      blocked: t.view && !t.view.webContents.isDestroyed() && shield ? shield.blockedOn(t.view.webContents.id) : 0,
      adsOk: !!(shield && t.url && shield.isAllowed(t.url)),
    })), ...away],
    space: store.data.space, spaces: spaces(), spaceList: spaceList(), spaceTints: SPACE_TINTS, kits: KITS,
    preset: (() => { const p = presets.active(); return p ? { id: p.id, name: p.name, commands: p.commands || [], appLabel: p.appLabel || 'App', undo: !!s.presetUndo } : null; })(),
    peek: peek && peek.identity === here ? { title: peek.title, url: peek.url } : null,
    ai: aiView ? { which: aiWhich(), names: AI_NAMES, folder: aiIdentity } : null, strip: stripOpen, recording: recTabId, alertCount: shut ? 0 : alertCount(), billCount: shut ? 0 : billCount(),
    canCarryFromChrome: canCarryFromChrome(),
    activeId: shut ? null : activeId, programId, live, cue: cueIds.filter((id) => byId(id)), cueNext: cueNextId, stageIds, groups: groupList(),
    identities: faces.identities, labels: shut ? {} : { [here]: emailOf(here) },
    // The top row is the people's folders. The AI agent folder only appears while it still holds
    // tabs from before, because agents work in the folders they are allowed into now.
    folder: here, folderLocked: shut, folders: faces.ids, pickFolders: faces.ids, folderInfo: faces.info,
    aiPaused: aiPaused(), aiCount: shut ? 0 : aiTabs().filter((t) => t.identity === here).length,
    whose: shut ? {} : { [here]: whoseIn(here) },
    split: store.data.split, panes, gutters, sideReveal, sideWidth: sideWidth(), aiWidth: aiWidth(),
    // Settings without anything that belongs to another folder: no account names, and only this
    // folder's own nine number keys.
    settings: { ...s, identityLabels: undefined, presetUndo: undefined, quickKeys: shut ? [] : quickKeysFor(here), sharedPairs: undefined, obs: { ...s.obs, password: s.obs.password ? '••••' : '' } },
    collapsed: store.data.collapsed, obs: obs.status, downloads: shut ? [] : downloads.filter((d) => d.folder === here).slice(0, 8),
    agent: { port: AGENT_PORT, on: doorOpen, listening: s.agentPort !== false, last: (() => { const l = agentLog[agentLog.length - 1]; return l ? { agent: l.agent, tool: l.tool, ok: l.ok } : null; })(),
      sites: Object.entries(AGENT_SITES).map(([id, v]) => ({ id, name: v.name, what: v.what })) },
    update: updater ? updater.state() : null,
    vanishKeys: VANISH_KEYS_SHOWN,
  };
  uiView.webContents.send('ui:state', lastState);
}
let lastState = null; // what the sidebar was last told, kept for the tests that prove what it was NOT told
const VANISH_KEYS_SHOWN = vanishKeys.shown();

function sendEvent(name, data) { if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.send('ui:event', name, data); }

let thumbTimer = null;
function startThumbs() {
  clearInterval(thumbTimer);
  thumbTimer = setInterval(async () => {
    const p = byId(programId);
    if (!live || !p || !p.view) return;
    try {
      const img = await p.view.webContents.capturePage();
      if (!img.isEmpty()) sendEvent('program-thumb', img.resize({ width: 232 }).toDataURL());
    } catch {}
  }, 1500);
}

// ---------------------------------------------------------------- IPC
ipcMain.on('cue:tab-init', (e) => {
  const t = byWC(e.sender);
  const ytAds = settings().blockAds !== false && !(shield && shield.isAllowed('https://youtube.com/'));
  e.returnValue = { ytAds, volume: t ? t.volume : 1, originalSound: settings().originalSound, safe: !!(t && live && t.id === programId && settings().safeShare), hold: live, quiet: quietSite(e.sender.getURL() || (t && t.url) || '') };
});
ipcMain.on('cue:media-state', (e, playing) => { const t = byWC(e.sender); if (t) { t.playing = playing; pushState(); } });
ipcMain.on('cue:dirty', (e) => { const t = byWC(e.sender); if (t) t.dirty = true; });
ipcMain.on('cue:play-link', (e, op) => {
  const sp = store.data.split;
  const t = byWC(e.sender);
  if (!settings().syncPlay || !t || !sharesSplit(t)) return;
  for (const id of sp.ids) { const o = byId(id); if (o && o !== t && o.view) o.view.webContents.send('cue:media', op); }
});
ipcMain.on('cue:scroll', (e, ratio) => {
  const sp = store.data.split;
  if (!settings().syncScroll || sp.mode === 'single') return;
  const t = byWC(e.sender); if (!t || !sp.ids.includes(t.id)) return;
  for (const id of sp.ids) { const o = byId(id); if (o && o !== t && o.view) o.view.webContents.send('cue:scroll-to', ratio); }
});

ipcMain.on('cue:peek', (e, url) => { const t = byWC(e.sender); if (t) openPeek(url, t); });
ipcMain.on('cue:music-state', (_e, st) => sendEvent('music-state', st));
ipcMain.on('cue:note', (e, n) => {
  const t = byWC(e.sender); if (!t || t.identity === 'vanish' || !n) return;
  const now = Date.now(); // a page can send these as fast as it likes, so it gets a few a minute and no more
  t.noteTimes = (t.noteTimes || []).filter((at) => now - at < 60000);
  if (t.noteTimes.length >= 5) return;
  t.noteTimes.push(now);
  if (live) heldCount++;
  addAlert({ source: hostName(t.url), title: String(n.title || '').slice(0, 200), body: String(n.body || '').slice(0, 500), url: t.url, held: live, folder: t.identity });
});
// A password saved in one folder is offered in another ONLY when the person paired those two
// folders, and never on a site where people keep two accounts.
const sharesPasswords = (identity, origin) => partnersOf(identity).length > 0 && !hasTwoAccounts(hostName(origin));
// Which saved login applies here, found the same way for both handlers below so
// the answer to "is there one" can never differ from the one that is handed out.
function credFor(e) {
  const t = byWC(e.sender);
  if (!t || e.senderFrame !== e.sender.mainFrame || t.identity === 'vanish' || t.id === programId || agentCanAct(t) || isLocked(t.identity)) return null;
  const origin = safeOrigin(e.senderFrame.url);
  if (!securePage(origin)) return null;
  let c = vault.find(t.identity, origin);
  if (!c && sharesPasswords(t.identity, origin)) {
    for (const p of partnersOf(t.identity)) { if (isLocked(p)) continue; c = vault.find(p, origin); if (c) break; }
  }
  return c ? { c, origin } : null;
}

// Asked the moment a password box appears. It says whether Cue holds a login
// and whether that site fills itself - never the password. The password is
// handed over by cue:cred-get, and on every site but our own that only happens
// after you have clicked the box yourself.
ipcMain.handle('cue:cred-ready', (e) => {
  const hit = credFor(e);
  if (!hit) return null;
  return { handsFree: !!hit.c.auto || Vault.ownSite(hit.origin) };
});
ipcMain.handle('cue:cred-get', (e) => {
  const hit = credFor(e);
  if (!hit) return null;
  const { c, origin } = hit;
  vault.used(c.id);
  let submit = false;
  if (c.auto && Date.now() - (autoTried[origin] || 0) > 120000) { autoTried[origin] = Date.now(); submit = true; }
  return { username: c.username, password: c.password, submit };
});
ipcMain.on('cue:cred-offer', (e, c) => {
  const t = byWC(e.sender);
  if (!t || e.senderFrame !== e.sender.mainFrame || t.identity === 'vanish' || agentCanAct(t) || !c.password) return;
  const origin = safeOrigin(e.senderFrame.url);
  if (!securePage(origin) || vault.never.includes(origin) || vault.has(t.identity, origin, c.username, c.password)) return;
  pendingCred = { identity: t.identity, origin, username: c.username, password: c.password };
  sendEvent('save-password', { origin, username: c.username });
});
ipcMain.handle('cue:internal', async (e, cmd, a = {}) => {
  if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame || !e.senderFrame.url.startsWith('cue://') || !Object.hasOwn(internal, cmd)) throw new Error('Not allowed');
  const from = byWC(e.sender);
  // A cue:// page acts on the folder of the tab it is in. One that is in no tab of Cue's (a Vanish
  // window) reads no folder's library at all.
  if (from && isLocked(from.identity)) throw new Error('Not allowed');
  return internal[cmd](a, from, e.sender);
});

// A brand-new tab's page grabs the keyboard the moment it finishes loading,
// about a tenth of a second after it opens. Nobody asks it to - Chromium gives
// a freshly attached view the keyboard once its first document is up. So every
// letter he typed straight after Cmd+T, and every address he pasted, went into
// the empty start page and disappeared. Hold the address bar across that
// moment, then stop: after two thirds of a second the page may have the
// keyboard, because by then he meant to click into it.
function holdOmnibox(t) {
  if (!t || !t.view) return;
  const wc = t.view.webContents;
  const until = Date.now() + 1500;
  const hold = () => {
    if (Date.now() > until || activeId !== t.id || wc.isDestroyed() || !uiView || uiView.webContents.isDestroyed()) return;
    uiView.webContents.focus();
    sendEvent('refocus-omnibox');
  };
  wc.once('dom-ready', hold);
  wc.once('did-finish-load', hold);
  for (const ms of [80, 250, 600]) setTimeout(hold, ms);
}

// Anything that goes wrong in a command - a locked folder refusing a new tab, say - is said in a
// line on screen rather than lost in the log.
function uiCommand(cmd, a = {}) {
  try { return uiCommandRaw(cmd, a); } catch (e) {
    sendEvent('toast', String((e && e.message) || e));
    return { error: String((e && e.message) || e) };
  }
}
// What the person did that changes a folder. Each says so on screen when it cannot be done.
function folderCommand(cmd, a) {
  const say = (r) => { if (r && r.error && !process.env.CUE_TEST) sendEvent('toast', r.error); return r; };
  switch (cmd) {
    case 'folder.add': {
      const r = addFolder({ name: a.name, color: a.color });
      if (r.ok && a.open !== false) setFolder(r.folder.id);
      return say(r);
    }
    case 'folder.rename': return say(renameFolder(a));
    case 'folder.color': return say(recolorFolder(a));
    case 'folder.email': return say(setFolderEmail(a));
    case 'folder.agents': return say(setFolderAgents(a));
    case 'folder.share': return say(setShared(a));
    case 'folder.lock-now': return lockFolder(a.id) ? { ok: true } : say({ error: 'That folder has no passcode yet. Set one in Settings, under Folders and accounts.' });
    case 'folder.remove': return removeFolder(a).then(say);
    case 'folder-menu': {
      const f = folderById(a.id);
      if (!f) return null;
      Menu.buildFromTemplate([
        { label: hasLock(f.id) ? (isLocked(f.id) ? 'Locked' : 'Lock now') : 'Lock now (set a passcode first)', enabled: hasLock(f.id) && !isLocked(f.id), click: () => lockFolder(f.id) },
        { type: 'separator' },
        { label: 'Folders and accounts…', click: () => sendEvent('open-settings', 'folders') },
      ]).popup({ window: mainWin });
      return { ok: true };
    }
    default: return null;
  }
}
function tidyDupes() {
  const n = mergeDupes();
  layout(); pushState(); persist();
  return n ? `Closed ${n} duplicate${n === 1 ? '' : 's'}. One Gmail, one WhatsApp, one YouTube per folder.` : 'Nothing to tidy: you already have one of each.';
}
// Spaces, by name. Renaming carries every tab, login, layout and collapsed group filed under the
// old name, so the only thing that changes is the word. Removing never closes a tab: they move
// to the first Space that is left. Every answer is { ok, said } or { error }.
function spaceCommand(cmd, a = {}) {
  const list = spaceList();
  const at = (n) => list.findIndex((x) => x.name === n);
  const save = (next, extra) => {
    store.data.spaces = next.map(({ name, tint }) => ({ name, tint }));
    if (extra) extra();
    buildMenu(); store.save(); persist(); layout(); pushState();
  };
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 18);
  switch (cmd) {
    case 'space.rename': {
      const i = at(a.from); const to = clean(a.name);
      if (i < 0) return { error: 'That Space is not there any more.' };
      if (!to) return { error: 'A Space needs a name.' };
      if (to === a.from) return { ok: true, said: '' };
      if (at(to) >= 0) return { error: `You already have a Space called ${to}.` };
      list[i] = { ...list[i], name: to };
      save(list, () => {
        for (const x of tabs) if (x.space === a.from) x.space = to;
        for (const box of [store.data.spaceSplit, store.data.savedSpaceSplit, settings().spaceLogins, store.data.collapsed]) {
          if (box && Object.prototype.hasOwnProperty.call(box, a.from)) { box[to] = box[a.from]; delete box[a.from]; }
        }
        if (store.data.space === a.from) store.data.space = to;
      });
      return { ok: true, said: `That Space is called ${to} now.` };
    }
    case 'space.tint': {
      const i = at(a.name);
      if (i < 0) return { error: 'That Space is not there any more.' };
      if (!SPACE_TINTS.includes(a.tint)) return { error: 'That colour is not one of the swatches.' };
      list[i] = { ...list[i], tint: a.tint };
      save(list);
      return { ok: true, said: '' };
    }
    case 'space.move': {
      const i = at(a.name); const j = i + (Number(a.dir) < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= list.length) return { ok: true, said: '' };
      [list[i], list[j]] = [list[j], list[i]];
      save(list);
      return { ok: true, said: `${a.name} is number ${j + 1} now.` };
    }
    case 'space.add': {
      if (list.length >= SPACES_MAX) return { error: 'Nine Spaces is the most Cue keeps.' };
      const to = clean(a.name) || `Space ${list.length + 1}`;
      if (at(to) >= 0) return { error: `You already have a Space called ${to}.` };
      const used = new Set(list.map((x) => x.tint));
      list.push({ name: to, tint: SPACE_TINTS.includes(a.tint) ? a.tint : (SPACE_TINTS.find((x) => !used.has(x)) || tintFor(to, list.length)) });
      save(list);
      return { ok: true, said: `${to} is ready. Click it in the sidebar to work there.` };
    }
    case 'space.remove': {
      const i = at(a.name);
      if (i < 0) return { error: 'That Space is not there any more.' };
      if (list.length <= 1) return { error: 'The last Space stays.' };
      list.splice(i, 1);
      const home = list[0].name;
      let moved = 0;
      save(list, () => {
        for (const x of tabs) if (x.space === a.name) { x.space = home; moved++; }
        for (const box of [store.data.spaceSplit, store.data.savedSpaceSplit, store.data.collapsed]) if (box) delete box[a.name];
        if (settings().spaceLogins) delete settings().spaceLogins[a.name];
        if (store.data.space === a.name) store.data.space = home;
      });
      return { ok: true, said: moved ? `${a.name} is gone. Its ${moved} tab${moved === 1 ? '' : 's'} moved to ${home}.` : `${a.name} is gone.` };
    }
    default: return { error: 'Unknown Space command.' };
  }
}
function uiCommandRaw(cmd, a = {}) {
  let t = a.id ? byId(a.id) : byId(activeId);
  if (t && isLocked(t.identity)) t = null; // a locked folder's tab cannot be touched from here
  const wc = t && t.view ? t.view.webContents : null;
  if (cmd.startsWith('folder.') || cmd === 'folder-menu') return folderCommand(cmd, a);
  switch (cmd) {
    case 'navigate': navigate(a); break;
    case 'activate': activate(a.id); break;
    case 'app-open': openApp(a.url); break;
    case 'close': closeTab(a.id); break;
    case 'new-tab':
      if (!a.identity && vanish.focused()) { vanish.add(); break; }
      { const nt = openTab({ identity: a.identity, url: a.url, after: t && t.space === store.data.space ? t : undefined, focusUi: true, temp: !!a.temp });
        uiView.webContents.focus(); sendEvent('focus-omnibox'); holdOmnibox(nt); }
      break;
    case 'back': if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': if (wc) { const site = offlineSite(wc.getURL()); if (site) wc.loadURL(site).catch(() => {}); else wc.reload(); } break;
    case 'stop': if (wc) wc.stop(); break;
    case 'mute': if (t) setMuted(t, !t.muted); break;
    case 'volume': if (t) setVolume(t, a.value); break;
    case 'media': if (t) { if (!t.view) ensureView(t); t.view.webContents.send('cue:media', a.cmd || 'toggle'); } break;
    case 'rename': if (t) { const n = String(a.name || '').trim().slice(0, 60); t.name = n || null; pushState(); persist(); } break;
    case 'tab-menu': tabMenu(t); break;
    case 'reorder': reorder(a); break;
    case 'pin': {
      if (!t) break;
      const on = a.on === undefined ? !t.pinned : !!a.on;
      // WhatsApp, Gmail, Instagram and Facebook stay in the strip. There is only
      // ever one of each per folder, so taking it out of the strip just turns it
      // into a row to tidy up later.
      if (!on && alwaysPinned(t.url)) { sendEvent('toast', `${hostOf(t.url)} lives in the strip at the top \u2014 one in each folder. Nothing to unpin.`); break; }
      t.pinned = on; t.order = Date.now();
      if (on) { delete t.temp; delete t.tempAt; } // pinning keeps it
      pushState(); persist(); break;
    }
    case 'tab-temp': { const r = setTemp(t, a.on === undefined ? !(t && t.temp) : !!a.on); if (r && r.error) sendEvent('toast', r.error); break; }
    case 'temp-clear': clearTemp({ folder: openFolder() }); break;
    case 'move-tab': moveTab(a); break;
    case 'split': setSplit(a.mode); break;
    case 'split-add': addToSplit(a.id); break;
    case 'live': setLive(!!a.on); break;
    case 'take': take(a.id); break;
    case 'cue-add': cueAdd(Number(a.id)); break;
    case 'cue-remove': cueRemove(Number(a.id)); break;
    case 'cue-next': cueNextId = Number(a.id); pushState(); break;
    case 'cue-move': cueMove(Number(a.id), Number(a.to)); break;
    case 'cue-step': cueStep(a.dir === -1 ? -1 : 1); break;
    case 'stage-split': stageSplit(Number(a.n) || 1); break;
    case 'cue-clear': cueIds = []; cueNextId = null; pushState(); persist(); break;
    case 'popout': popOut(t); break;
    case 'mini': miniPlay(t); break;
    case 'overlay': setOverlay(a.on); break;
    case 'collapse': store.data.collapsed[a.group] = !store.data.collapsed[a.group]; store.save(); pushState(); break;
    case 'setting': setSetting(a.key, a.value); break;
    case 'find': if (wc) { if (a.stop || !a.text) wc.stopFindInPage('clearSelection'); else wc.findInPage(a.text, { forward: a.forward !== false, findNext: !!a.next }); } break;
    case 'zoom': if (vanish.focused()) { vanish.zoom(a); break; } if (wc) { t.zoom = a.reset ? 0 : t.zoom + (a.dir || 0) * 0.5; wc.setZoomLevel(t.zoom); persist(); } break;
    case 'download-open': { const d = downloads.find((x) => x.id === a.id && x.folder === openFolder()); if (d) shell.showItemInFolder(d.file); break; }
    case 'downloads-clear': { const keep = downloads.filter((x) => x.folder !== openFolder()); downloads.splice(0, downloads.length, ...keep); pushState(); break; }
    case 'obs-connect': obs.connect(settings().obs); break;
    case 'share-choose': {
      const cb = pendingShare; pendingShare = null; setOverlay(false);
      if (!cb) break;
      if (a.tabId) { const st = byId(a.tabId); if (st && st.view) { cb({ video: st.view.webContents.mainFrame, audio: st.view.webContents.mainFrame }); break; } }
      if (a.sourceId) {
        desktopCapturer.getSources({ types: ['screen', 'window'] }).then((srcs) => {
          const s = srcs.find((x) => x.id === a.sourceId); cb(s ? { video: s } : {});
        }).catch(() => cb({}));
        break;
      }
      cb({});
      break;
    }
    case 'side-width': settings().sideWidth = a.w; store.save(); layout(); pushState(); break;
    case 'side-hide': setSideHidden(!settings().sideHidden); break;
    case 'side-reveal': setSideReveal(a.on); break;
    case 'ai-width': settings().aiWidth = a.w; store.save(); layout(); pushState(); break;
    case 'split-size': resizeSplit(a); break;
    // Double-click the divider to put the panes back to equal, the way
    // double-clicking a column edge in a spreadsheet does.
    case 'split-even': { const sp = store.data.split; delete sp.fr; delete sp.fx; delete sp.fy; layout(); pushState(); persist(); break; }
    case 'clear-cache': clearCaches(); break;
    // Some sites genuinely break when their ads are blocked. This lets that one
    // site through and leaves every other site alone.
    // The Space commands answer in words; from the sidebar the words are a toast, and from
    // Settings they are shown on the row (uiInvoke 'space.*').
    case 'space-rename': { const r = spaceCommand('space.rename', a); if (r.error || r.said) sendEvent('toast', r.error || r.said); break; }
    case 'space-add': { const r = spaceCommand('space.add', a); if (r.error || r.said) sendEvent('toast', r.error || r.said); break; }
    case 'space-remove': { const r = spaceCommand('space.remove', a); if (r.error || r.said) sendEvent('toast', r.error || r.said); break; }
    case 'tidy-dupes': sendEvent('toast', tidyDupes()); break;
    case 'ads-here': {
      if (!shield || !t) break;
      const host = shield.hostOf(t.url);
      if (!host) break;
      const list = new Set(settings().adsAllowed || []);
      const block = a.block === undefined ? list.has(host) : !!a.block;
      if (block) list.delete(host); else list.add(host);
      settings().adsAllowed = [...list];
      shield.setAllowed(settings().adsAllowed);
      store.save();
      sendEvent('toast', block ? `Ads are blocked on ${host} again. Reloading.` : `Ads are allowed on ${host}. Reloading.`);
      if (wc) wc.reload();
      pushState();
      break;
    }
    case 'ai-door': {
      doorOpen = !!a.on;
      // Switching AI tools on for the first time also opens the port they knock on, and it stays
      // listening from then on (settings().agentPort), the way an upgraded install always was.
      if (doorOpen && settings().agentPort === false) { settings().agentPort = true; openAgentPort(); }
      setSetting('aiDoor', doorOpen);
      if (!doorOpen) agentSeen.clear();
      sendEvent('toast', doorOpen
        ? 'AI agents can drive Cue until you close it.'
        : 'The AI door is closed. Nothing can drive Cue but you.');
      pushState();
      break;
    }
    case 'space': switchSpace(a.name); break;
    case 'folder': setFolder(a.name); break;
    // Reachable from Settings as well as from Cue's own pages: the sidebar and
    // the cue:// pages speak to two different tables.
    case 'signin.carry-all': internal['signin.carry-all'](a); break;
    case 'signin.google': internal['signin.google'](a); break;
    case 'move-folder': moveToFolder({ id: a.id, to: a.to }); break;
    case 'peek-close': closePeek(); break;
    case 'peek-keep': { if (peek) { const url = peek.url; const from = peek.identity; closePeek(); openTab({ url, identity: from }); } break; }
    case 'ai': toggleAI(a.which); break;
    // One click on the AI badge in the sidebar, the same thing the right-click menu does.
    case 'ai-tab': { const x = byId(a.id); if (x && !x.agent && x.identity !== 'vanish' && !x.private) { x.aiAllowed = !x.aiAllowed; pushState(); persist(); } break; }
    case 'ai-ask': askAboutPage(a.which); break;
    case 'strip': stripOpen = !stripOpen; layout(); pushState(); break;
    case 'music': if (wc) wc.send('cue:music', a.op, a.value); break;
    case 'tool': runTool(a.name, t); break;
    case 'open-page': openCuePage(a.page, openFolder()); break;
    case 'cred-save': if (pendingCred && !isLocked(pendingCred.identity)) { vault.save({ ...pendingCred, auto: !!a.auto }); pendingCred = null; sendEvent('toast', 'Password saved.'); } break;
    case 'cred-never': if (pendingCred) { vault.neverFor(pendingCred.origin); pendingCred = null; } break;
    case 'cred-dismiss': pendingCred = null; break;
    // Only a login of the folder that is open can be changed from its Settings.
    case 'pw-auto': { const pw = vault.get(a.pw); if (pw && pw.identity === openFolder() && !isLocked(pw.identity)) vault.setAuto(a.pw, a.on); break; }
    case 'pw-remove': { const pw = vault.get(a.pw); if (pw && pw.identity === openFolder() && !isLocked(pw.identity)) vault.remove(a.pw); break; }
    case 'download-run': {
      const d = downloads.find((x) => x.id === a.id && x.folder === openFolder());
      if (d) { shell.openPath(d.file); if (d.kind === 'Installers') { store.data.installersOpened.push({ file: d.file, at: Date.now() }); store.save(); } }
      break;
    }
    case 'make-default': app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https'); break;
    case 'set-scene': if (t) { t.obsScene = a.scene || ''; pushState(); persist(); } break;
    case 'update-check': if (updater) updater.check({ quiet: false }); break;
    case 'update-get': if (updater) updater.download(); break;
    case 'update-install': if (updater) { saveNow(); updater.install(); } break;
    case 'update-notes': if (updater) updater.openPage(); break;
    case 'update-dismiss': if (updater) updater.dismiss(); break;
    case 'agent-copy': clipboard.writeText(agentSetupText()); sendEvent('toast', 'AI setup copied.'); break;
    default: break;
  }
}
// Only Cue's own sidebar (or the menu, which sends no page) may give these orders.
const fromUi = (e) => !(e && e.sender) || (uiView && e.sender === uiView.webContents);
ipcMain.on('ui:cmd', (e, cmd, a = {}) => { if (fromUi(e)) uiCommand(cmd, a); });

ipcMain.handle('ui:invoke', (e, cmd, a = {}) => { if (!fromUi(e)) throw new Error('Not allowed'); return uiInvoke(cmd, a); });
async function uiInvoke(cmd, a = {}) {
  if (cmd === 'obs-scenes') return obs.scenes();
  if (cmd === 'suggest') { const r = suggestions(a.q); warmUp(r); return r; }
  if (cmd === 'import-find') return findImports();
  if (cmd === 'import-run') return runImport(a);
  if (cmd === 'open-disk-access') return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  if (cmd === 'passwords') return isLocked(openFolder()) ? [] : vault.list(openFolder());
  // ---- people's folders
  if (cmd === 'folders') return { rows: folderRows(), lockMinutes: Number(settings().lockMinutes ?? 15) };
  if (cmd === 'folder-unlock') {
    const r = tryUnlock(a.id, a.code);
    if (r.ok) { setFolder(a.id); openWaitingLinks(a.id); }
    return r;
  }
  if (cmd === 'folder-passcode') return setPasscode(a);
  if (cmd.startsWith('folder.')) { try { return await folderCommand(cmd, a); } catch (e) { return { error: e.message }; } }
  if (cmd === 'storage') return storageReport();
  // Settings asks for these and shows the answer on the row, so it never has to close.
  if (cmd.startsWith('space.')) return spaceCommand(cmd, a);
  if (cmd === 'tidy-dupes') return { ok: true, said: tidyDupes() };
  if (cmd === 'temp.clear') return { ok: true, n: clearTemp({ folder: openFolder() }) };
  if (cmd === 'team-vault') return teamSite() ? loadTeamVault(teamSite(), { into: [openFolder()] }) : { signedIn: false };
  if (cmd === 'team-offered') return teamImportOffered();
  if (cmd === 'welcome.finish') return finishWelcome(a);
  if (cmd === 'welcome.skip') { if (store.data.welcome === 'pending') { store.data.welcome = 'done'; store.save(); } return { ok: true }; }
  if (cmd === 'preset.apply') return applyPreset(String(a.id || ''));
  if (cmd === 'preset.remove') return removePreset();
  if (cmd === 'presets') return presets.available();
  if (cmd === 'ext-find') return findExtensions();
  if (cmd === 'ext-add') return addExtension(a);
  if (cmd === 'ext-remove') return removeExtension(a.id);
  if (cmd === 'lens-file') return lensFile(a);
  // A tab's view is built lazily, so a tab that has not been looked at yet has
  // none. Recording used to refuse with "Open a tab first" in that case, which
  // is both wrong and baffling. Build the view, then record it.
  if (cmd === 'rec-start') { const t = byId(activeId); if (!t || isLocked(t.identity)) return null; ensureView(t); if (!t.view) return null; recTabId = t.id; pushState(); return { title: t.title }; }
  if (cmd === 'rec-cancel') { recTabId = null; pushState(); return true; }
  if (cmd === 'rec-save') {
    recTabId = null; pushState();
    const file = capture.saveRecording(a.title, a.buffer, a.ext);
    sendEvent('toast', 'Recording saved in Cue Captures.'); capture.reveal(file);
    return file;
  }
  // The shield's own two answers. They had only ever been wired to Cue's
  // internal pages, so Settings asked and nothing ever answered: the line under
  // the shield switches said "Checking..." for ever. The button beside it did
  // work - it just could never say so.
  if (cmd === 'shield.status' || cmd === 'shield.refresh') return internal[cmd]({});
  return null;
}

function reorder({ id, beforeId, group }) {
  const t = byId(id); if (!t) return;
  if (group && group !== groupOf(t)) t.groupOverride = group;
  if (beforeId) {
    const b = byId(beforeId);
    if (b) {
      const list = sidebarOrder().filter((x) => groupOf(x) === groupOf(b) && x !== t);
      const i = list.indexOf(b);
      const prev = list[i - 1];
      t.order = prev ? (prev.order + b.order) / 2 : b.order - 1;
      if (b.pinned !== t.pinned) t.pinned = b.pinned;
      if (t.pinned) { delete t.temp; delete t.tempAt; }
    }
  } else t.order = Date.now();
  pushState(); persist();
}

// Move a tab one place up or down inside its own group. Dragging was the only
// way to reorder, which is awkward with a long list and impossible from the
// keyboard.
// Move an open tab into another folder, keeping the page.
//
// A folder IS its cookie jar, so the same page in another folder is the same
// page signed in as somebody else: the view has to be built again in the other
// session. That is a reload, not a loss — same address, same name, same Space,
// same group, same place in the list, same zoom and volume, and it stays the
// tab you are looking at. What it cannot keep is anything the old account was
// holding on the page: a half-typed message, a sign-in, an unsaved form. So it
// always asks first and names both folders. A tab never changes folder on its
// own — this is the only thing that moves one, and only you can start it.
async function moveToFolder({ id, to, confirmed }) {
  const t = byId(id);
  if (!t || !isFolder(to) || !isFolder(t.identity) || t.identity === to || isLocked(to) || isLocked(t.identity)) return;
  const from = folderName(t.identity); const into = folderName(to);
  if (!confirmed) {
    const r = await dialog.showMessageBox(hostWindow(t), {
      type: 'question', buttons: [`Move to ${into}`, 'Cancel'], defaultId: 0, cancelId: 1,
      message: `Move this tab from ${from} to ${into}?`,
      detail: `${t.title || hostName(t.url)}\n\nThe page opens again as ${into}, signed in as that account. Anything you have typed on it and not sent will be lost.`,
    });
    if (r.response !== 0) return;
  }
  const live = t.id === activeId;
  const wasSplit = store.data.split.ids.includes(t.id);
  if (t.view) { // let go of the old session's view; the tab object itself stays
    try { mainWin.contentView.removeChildView(t.view); } catch {}
    try { t.view.webContents.close(); } catch {}
    t.view = null;
  }
  t.identity = to;
  t.sleeping = false;
  ensureView(t); // rebuilt in the new folder's cookie jar
  t.view.webContents.loadURL(t.url);
  if (live) activate(t.id); else if (wasSplit) { layout(); pushState(); }
  pushState(); persist();
  sendEvent('toast', `Moved to ${into}. This page is now signed in as ${into}.`);
}

function moveTab({ id, dir }) {
  const t = byId(id); if (!t || !dir) return;
  const list = sidebarOrder().filter((x) => groupOf(x) === groupOf(t) && x.pinned === t.pinned);
  const i = list.indexOf(t);
  if (i < 0) return;
  const j = i + (dir < 0 ? -1 : 1);
  if (j < 0 || j >= list.length) return;
  const target = list[j];
  // Swap the two orders outright: neighbours keep their places and no
  // fractional order can collapse onto another tab's.
  const a = t.order; t.order = target.order; target.order = a;
  pushState(); persist();
}

function setSetting(key, value) {
  const s = settings();
  if (key.startsWith('obs.')) { s.obs[key.slice(4)] = key === 'obs.port' ? Number(value) || 4455 : value; }
  else if (key.startsWith('agentSites.')) { s.agentSites = { ...s.agentSites, [key.slice(11)]: !!value }; }
  // label.<folder> is the Google address the folder holds; it lives on the folder now.
  else if (key.startsWith('label.')) { const who = key.slice(6); if (isPerson(who)) setFolderEmail({ id: who, email: value }); else s.identityLabels[who] = value; }
  else if (key.startsWith('kit.')) { s.kits[key.slice(4)] = !!value; buildMenu(); if (key === 'kit.music' && !value) stripOpen = false; layout(); }
  else if (key.startsWith('spaceLogin.')) { if (isPerson(value)) s.spaceLogins[key.slice(11)] = value; }
  else if (key === 'sharedPairs') { s.sharedPairs = Array.isArray(value) ? value : []; wireSharing(); }
  // quick.<slot>.name / quick.<slot>.url - a number key he has re-pointed. The menu carries the
  // accelerators, so it has to be rebuilt or the key would still go to the old site.
  else if (key.startsWith('quick.')) {
    // quick.<slot>.<field> edits the folder in front of you; quick.<folder>.<slot>.<field>
    // names the folder outright, which is what the Settings page sends.
    const parts = key.split('.');
    const who = isFolder(parts[1]) ? parts[1] : openFolder();
    const [slot, field] = isFolder(parts[1]) ? [parts[2], parts[3]] : [parts[1], parts[2]];
    const list = quickKeysFor(who).map((q) => ({ ...q }));
    const i = Number(slot) - 1;
    if (list[i] && (field === 'name' || field === 'url') && !isLocked(who)) {
      list[i][field] = String(value || '').trim();
      // An older flat list becomes a folder each, once, the first time one is edited.
      const was = s.quickKeys;
      const box = Array.isArray(was) || !was ? Object.fromEntries(allFolders().map((f) => [f, quickKeysFor(f)])) : { ...was };
      box[who] = list;
      s.quickKeys = box;
      buildMenu();
    }
  }
  else if (key === 'archiveDays') s.archiveDays = Math.max(0, Math.round(Number(value) || 0));
  // 'quit' (never written to disk) or a number of hours. Saving at once means switching to
  // "when Cue closes" takes the "Just for now" tabs out of cue.json there and then.
  else if (key === 'tempClear') { s.tempClear = [1, 4, 12, 24].includes(Number(value)) ? Number(value) : 'quit'; if (store) persist(); }
  else if (key === 'muteSites') {
    s.muteSites = String(value || '').split(/[\n,]/).map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean);
  }
  else if (key === 'quietSites') {
    // Typed as plain site names, one per line or comma separated.
    s.quietSites = String(value || '').split(/[\n,]/).map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean);
  }
  else s[key] = value;
  // Every open tab has to learn its new answer there and then, or WhatsApp keeps
  // popping boxes up until it is reloaded.
  if (key === 'quietSites') tabs.forEach((x) => x.view && x.view.webContents.send('cue:quiet', quietSite(x.url)));
  // The sidebar is a layout, not just a number in a file: hiding it from
  // Settings has to move the page over there and then, like the ⌘\ key does.
  if (key === 'sideHidden') { setSideHidden(!!value); return; }
  if (key === 'showDownloads') layout();
  if (key.startsWith('vanish') && vanish) vanish.applyPrefs();
  if (key === 'githubUser') loadRepos();
  store.save();
  if (key === 'originalSound') tabs.forEach((x) => x.view && x.view.webContents.send('cue:original-sound', value));
  // Switching the shield off has to take effect without restarting Cue, so the
  // blocking is pulled out of every login's session there and then.
  if (key === 'blockAds' && shield) {
    for (const ses of sessionsReady) {
      if (value) shield.enable(ses); else shield.disable(ses);
    }
    sendEvent('toast', value ? 'Ads and trackers are blocked again.' : 'Ads are allowed everywhere now.');
  }
  if (key === 'safeShare') { const p = byId(programId); if (p && p.view) p.view.webContents.send('cue:safe', !!value); }
  pushState();
}

// ---------------------------------------------------------------- helpers for the features below
const kit = (k) => settings().kits[k] !== false;
const hostName = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const BROKEN_PAGE = /^(access denied|forbidden|403|404|not found|page not found|error|server error|bad gateway|service unavailable|too many requests|just a moment|attention required|problem loading page|site can.t be reached)/i;
const securePage = (origin) => /^https:/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const remembers = (t) => t.identity !== 'vanish' && !t.agent;

function logTab(t, level, text) { t.log.push({ at: new Date().toISOString(), level, text: String(text).slice(0, 500) }); if (t.log.length > 200) t.log.shift(); }

// "(3) Inbox" style counts in a page's title, for mail and messages.
function countIn(t, title) {
  if (!COUNT_HOSTS.test(hostName(t.url))) return 0;
  const m = String(title).match(/\((\d+)\+?\)/);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------- one bar, Cmd+K
// Only the open folder's history, bookmarks and Boards - and nothing at all from a locked one.
function suggestions(q, folder = openFolder()) {
  const ql = String(q || '').trim().toLowerCase();
  if (!ql || isLocked(folder)) return { history: [], bookmarks: [], boards: [], apps: [], repos: [] };
  const hit = (x) => `${x.name} ${x.what || ''}`.toLowerCase().includes(ql);
  const mine = lib.in(folder);
  return {
    history: mine.suggest(ql, 6),
    bookmarks: mine.bookmarks(ql, 5),
    boards: kit('designer') ? mine.searchBoards(ql) : [],
    apps: presets.apps().filter(hit).slice(0, 5),
    repos: repos.filter(hit).slice(0, 5),
  };
}

// Open the connection to the most likely page before Enter is pressed.
function warmUp(r) {
  const top = r.history[0] || r.bookmarks[0];
  if (!top || !/^https:/.test(top.url)) return;
  try { sessionFor(openFolder()).preconnect({ url: top.url, numSockets: 1 }); } catch {}
}

async function loadRepos() {
  const user = settings().githubUser; repos = [];
  if (!user) return;
  try {
    for (let page = 1; page <= 5; page++) {
      const r = await net.fetch(`https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed&page=${page}`, { headers: { accept: 'application/vnd.github+json' } });
      if (!r.ok) break;
      const list = await r.json();
      repos.push(...list.map((x) => ({ name: x.name, what: x.description || '', url: x.html_url })));
      if (list.length < 100) break;
    }
  } catch {}
}

// ---------------------------------------------------------------- cache limits
const CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache'];
async function folderBytes(dir) {
  let total = 0;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(p);
    else total += await fs.promises.stat(p).then((s) => s.size, () => 0);
  }
  return total;
}
const persistentLogins = () => allFolders();
async function cacheBytes(ses) { let n = 0; for (const d of CACHE_DIRS) n += await folderBytes(path.join(ses.storagePath, d)); return n; }
async function dropCaches(ses) {
  await ses.clearCache().catch(() => {});
  await ses.clearCodeCaches({ urls: [] }).catch(() => {});
  await ses.clearStorageData({ storages: ['cachestorage', 'shadercache'] }).catch(() => {}); // sign-ins and site data stay
}
// Sites write to more places than the normal cache, so the disk cap alone does not hold.
async function trimCaches() {
  for (const k of persistentLogins()) {
    const ses = sessionFor(k);
    if (await cacheBytes(ses) > STORAGE_MB * 1048576) await dropCaches(ses);
  }
  const log = path.join(app.getPath('userData'), 'agent-log.jsonl');
  try { if (fs.statSync(log).size > 5242880) fs.renameSync(log, `${log}.old`); } catch {}
  lib.trim(50000);
}
async function clearCaches() {
  for (const k of persistentLogins()) await dropCaches(sessionFor(k));
  sendEvent('toast', 'Cache cleared. You are still signed in.');
}
async function storageReport() {
  const out = {}; let caches = 0;
  for (const k of persistentLogins()) caches += await cacheBytes(sessionFor(k));
  out.cacheMB = Math.round(caches / 1048576);
  out.totalMB = Math.round(await folderBytes(app.getPath('userData')) / 1048576);
  out.limitMB = STORAGE_MB * persistentLogins().length;
  return out;
}

// ---------------------------------------------------------------- updates
function newerVersion(a, b) {
  const p = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}

// ---------------------------------------------------------------- peek
// Peek and the AI panel are pages like any tab: the same guards, and a "Continue with Google"
// in either of them gets a real sign-in window in the right folder, not a tab that never reports back.
function wireSidePage(wc, getIdentity) {
  protectPage(wc, { identity: getIdentity() }, null);
  watchGoogleRefusal(wc, getIdentity);
  wc.setWindowOpenHandler(({ url: u, disposition }) => {
    if (refuseOpen(u, wc.getURL())) return { action: 'deny' };
    if (whereToOpen(u, disposition, wc.getURL()) === 'popup') return popupFor(getIdentity(), false);
    openTab({ url: u, identity: getIdentity() });
    return { action: 'deny' };
  });
  wc.on('did-create-window', (w) => wirePopup(w, getIdentity, false));
}
function openPeek(url, from) {
  // A page can ask for a Peek by alt-clicking a link of its own making, so only
  // ordinary web links come through here: never a file on this Mac, never one
  // of Cue's own pages.
  if (!/^https?:\/\//i.test(String(url || ''))) return;
  closePeek();
  const view = new WebContentsView({ webPreferences: { session: sessionFor(from.identity), preload: TAB_PRELOAD, contextIsolation: true, sandbox: true } });
  view.setBackgroundColor('#FFFFFF');
  peek = { view, url, title: hostName(url), identity: from.identity };
  const wc = view.webContents;
  wc.on('page-title-updated', (_e, title) => { if (peek && peek.view === view) { peek.title = title; pushState(); } });
  wc.on('did-navigate', (_e, u) => { if (peek && peek.view === view) { peek.url = u; pushState(); } });
  wc.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); closePeek(); } });
  wireSidePage(wc, () => from.identity);
  mainWin.contentView.addChildView(view);
  wc.loadURL(url).catch(() => {});
  layout(); pushState();
  wc.focus();
}
function closePeek() {
  if (!peek) return;
  const v = peek.view; peek = null;
  try { mainWin.contentView.removeChildView(v); v.webContents.close(); } catch {}
  layout(); pushState();
  const t = byId(activeId); if (t && t.view) t.view.webContents.focus();
}

// ---------------------------------------------------------------- AI side panel
// An older Cue stored "claude" or "chatgpt" here, which were the two consumer chats. Anything that
// is not one of the two tools now becomes Claude Code.
const aiWhich = () => (AI_HOME[store.data.aiWhich] ? store.data.aiWhich : 'claudecode');
// The panel borrows the open folder's login, so Claude Code and Codex come up already signed in as
// whoever he is working as. Switching folder reloads it as that account rather than leaving the
// last one's session sitting in the panel.
let aiIdentity = null;
function toggleAI(which) {
  if (aiView && (!which || which === aiWhich())) {
    const v = aiView; aiView = null; aiIdentity = null;
    try { mainWin.contentView.removeChildView(v); v.webContents.close(); } catch {}
  } else openAI(which || aiWhich());
  layout(); pushState();
}
function openAI(which, url) {
  const id = openFolder();
  if (isLocked(id)) throw new Error(`${folderName(id)} is locked. Type its passcode first.`);
  store.data.aiWhich = AI_HOME[which] ? which : aiWhich(); store.save();
  if (aiView && aiIdentity !== id) {
    const v = aiView; aiView = null;
    try { mainWin.contentView.removeChildView(v); v.webContents.close(); } catch {}
  }
  if (!aiView) {
    aiIdentity = id;
    aiView = new WebContentsView({ webPreferences: { session: sessionFor(id), preload: TAB_PRELOAD, contextIsolation: true, sandbox: true } });
    aiView.setBackgroundColor('#FFFFFF');
    wireSidePage(aiView.webContents, () => id);
    mainWin.contentView.addChildView(aiView);
  }
  aiView.webContents.loadURL(url || AI_HOME[store.data.aiWhich]).catch(() => {});
  layout(); pushState();
}
// A question needs a surface that takes one in its address. Codex has no such address, so asking
// about a page goes to Claude's chat whichever tool the panel is showing.
function askAI(which, prompt) {
  openAI(which, 'https://claude.ai/new?q=' + encodeURIComponent(prompt.slice(0, 6000)));
}
async function askAboutPage(which) {
  const t = byId(activeId);
  if (!t || !t.view || t.identity === 'vanish' || isStart(t.url)) { openAI(which || aiWhich()); return; }
  const wc = t.view.webContents; let text = '';
  try { text = await wc.executeJavaScript('(getSelection().toString() || document.body.innerText).slice(0, 4000)', true); } catch {}
  askAI(which || aiWhich(), `I'm looking at this page: ${wc.getTitle()}\n${wc.getURL()}\n\n${text}\n\nWhat should I know about it?`);
}

// ---------------------------------------------------------------- alerts and bills
// An alert belongs to the folder it came from (a.folder) and is only shown there. One with no
// folder - Cue's own "a new version is ready" - is everybody's.
function addAlert(a) {
  store.data.alerts.unshift({ id: Date.now() + Math.random(), at: Date.now(), held: false, ...a });
  store.data.alerts.length = Math.min(store.data.alerts.length, 200);
  store.save(); pushState();
}
const alertsOf = (folder) => store.data.alerts.filter((a) => !a.folder || a.folder === folder);
// Bills from before folders were kept for the whole browser; they are filed under Personal, as the
// history is.
const billFolder = (b) => b.folder || 'personal';
const billsOf = (folder) => store.data.bills.filter((b) => billFolder(b) === folder);
const alertCount = (folder = openFolder()) => alertsOf(folder).filter((a) => !a.seen).length + tabs.filter((t) => t.identity === folder).reduce((n, t) => n + (t.badge || 0), 0);
const billCount = (folder = openFolder()) => billsOf(folder).filter((b) => ['due', 'failed'].includes(bills.status(b))).length;

function checkBills() {
  store.data.bills.forEach((b) => bills.roll(b));
  for (const b of store.data.bills) {
    const st = bills.status(b);
    const key = `${st}|${b.renews}`;
    if (st !== 'due' && st !== 'failed') continue;
    if (b.warned === key) continue;
    b.warned = key;
    const d = b.renews ? bills.daysUntil(b.renews) : null;
    addAlert({ source: b.name, title: st === 'failed' ? `${b.name}: card failed` : `${b.name}: due in ${d} day${d === 1 ? '' : 's'}`, body: b.amountINR ? `₹${b.amountINR.toLocaleString('en-IN')}` : '', url: b.url, folder: billFolder(b) });
  }
  store.save(); pushState();
}

function readBillPage(t) {
  // It used to read only pages filed under "AI & Subscriptions", and a tab lands
  // in that group by its address - so a bill on any other site was never seen,
  // and the radar sat empty. Now any page whose own address says billing,
  // invoice, subscription or plan is read, in any folder but Vanish.
  if (!kit('business') || t.identity === 'vanish' || !/^https?:/.test(t.url || '') || !bills.BILLING_URL.test(t.url)) return;
  const url = t.url;
  const folder = t.identity;
  setTimeout(async () => {
    if (!t.view || t.url !== url) return;
    try {
      const text = await t.view.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 40000) : ""', true);
      // Read against this folder's own bills, and a new one is filed in this folder.
      const mine = billsOf(folder);
      const b = bills.fromPage(mine, url, text, store.data.usdToInr);
      if (b) {
        if (!store.data.bills.includes(b)) { b.folder = folder; store.data.bills.push(b); }
        checkBills();
      }
    } catch {}
  }, 2500);
}

function bookmarkTab(t) {
  if (!t || t.identity === 'vanish' || !/^https?:/.test(t.url)) { sendEvent('toast', 'This page can\'t be bookmarked.'); return; }
  lib.in(t.identity).importBookmarks([{ url: t.url, title: t.title, folder: '' }]);
  sendEvent('toast', 'Bookmarked.');
}

// ---------------------------------------------------------------- tidying
// A browser that keeps every tab for ever is a drawer nobody can shut. Cue has
// two kinds of tab and says so out loud:
//
//   KEPT   - the apps in the strip at the top (pinned), anything you have named
//            yourself, anything playing, on air, in a split, half-typed, or the
//            one you are looking at. These never go, whatever their age.
//   PASSING - everything else: the search you ran on Tuesday, the shop you
//            looked at once. These close on their own after a few days and go
//            into Library → Archived, where one click brings them back.
//
// Nothing is ever lost, so the sweep can be brisk. A blank "New tab" that was
// never used is not worth archiving at all - it just goes.
function keepForever(t, inSplit) {
  return t.pinned || !!t.name || t.id === activeId || t.id === programId || cueIds.includes(t.id)
    || t.identity === 'vanish' || t.agent || t.playing || t.audible || t.dirty
    || mustStayAwake(t) || inSplit.has(t.id) || t.mini;
}

function archiveOldTabs() {
  const inSplit = new Set(store.data.split.ids);
  // A blank tab left open an hour ago is nothing. Close it quietly.
  for (const t of [...tabs]) {
    if (keepForever(t, inSplit) || !isStart(t.url) || Date.now() - t.lastActive < 3600000) continue;
    destroyView(t); tabs.splice(tabs.indexOf(t), 1);
  }
  const days = settings().archiveDays;
  if (days) {
    const cutoff = Date.now() - days * 86400000;
    let went = 0;
    for (const t of [...tabs]) {
      // "Just for now" tabs are never archived: they have their own clock (sweepTemp).
      if (t.temp || keepForever(t, inSplit) || isStart(t.url) || t.lastActive > cutoff) continue;
      store.data.archived.unshift({ id: Date.now() + Math.random(), url: t.url, title: t.title, identity: t.identity, space: t.space, archivedAt: Date.now() });
      destroyView(t); tabs.splice(tabs.indexOf(t), 1); went++;
    }
    store.data.archived.length = Math.min(store.data.archived.length, 500);
    // Say it out loud. A sidebar that is suddenly shorter looks like something
    // went wrong unless you are told where everything went.
    if (went) sendEvent('toast', `${went} tab${went === 1 ? '' : 's'} you had not opened in ${days} day${days === 1 ? '' : 's'} went to Library \u2192 Archived.`);
  }
  if (!tabs.some((t) => isFolder(t.identity)) && !isLocked(openFolder())) openTab({});
  pushState(); persist();
}

// ---------------------------------------------------------------- Cue's own pages
// One Library, one Boards, one Bills per folder: go back to the page this folder already has open.
function openCuePage(page, identity) {
  const who = isFolder(identity) ? identity : openFolder();
  const open = tabs.filter((x) => x.url.startsWith(`cue://${page}`) && x.identity === who);
  const have = open.find((x) => x.space === store.data.space) || open[0];
  if (have) { activate(have.id); return have; }
  return openTab({ url: `cue://${page}`, identity: who });
}

// The folder a cue:// page acts on: the folder of the tab it is in. A call with no page behind it
// (the test rig, Settings) means the open folder. A page that is in none of Cue's tabs - a Vanish
// window - has no folder, and reads and changes nothing.
const pageFolder = (from, sender) => {
  if (from) return isFolder(from.identity) && !isLocked(from.identity) ? from.identity : null;
  if (sender) return null;
  const f = openFolder();
  return isLocked(f) ? null : f;
};
const inPage = (fn, empty) => (a = {}, from, sender) => {
  const f = pageFolder(from, sender);
  return f ? fn(a, f, from, sender) : empty;
};

// Settings names the folder; one of Cue's own pages may only ever act on the folder of its own tab.
function askedFolder(a, from, sender) {
  if (sender) { if (!from || !isFolder(from.identity)) throw new Error('Not allowed'); return from.identity; }
  return isFolder(a.identity) ? a.identity : openFolder();
}
const internal = {
  open: inPage(({ url, background }, f, from) => { if (/^https?:/.test(url)) openTab({ url, identity: f, background: !!background, after: background ? from : undefined }); }),
  'boards.list': inPage((_a, f) => lib.in(f).boardList(), []),
  'boards.create': inPage(({ name }, f) => lib.in(f).boardCreate(name), null),
  'boards.rename': inPage(({ id, name }, f) => lib.in(f).boardRename(id, name)),
  'boards.delete': inPage(({ id }, f) => lib.in(f).boardDelete(id)),
  'boards.removeItem': inPage(({ itemId }, f) => lib.in(f).boardRemoveItem(itemId)),
  'bills.list': inPage((_a, f) => {
    const mine = billsOf(f);
    mine.forEach((b) => bills.roll(b));
    return { bills: mine.map((b) => ({ ...b, status: bills.status(b) })), usdToInr: store.data.usdToInr, currency: store.data.currency || 'USD' };
  }, { bills: [], usdToInr: 1, currency: 'USD' }),
  'bills.save': inPage(({ bill }, f) => {
    const cur = store.data.bills.find((b) => b.id === bill.id);
    if (cur && billFolder(cur) !== f) return;
    if (cur) Object.assign(cur, bill, { folder: f }); else store.data.bills.push({ ...bill, id: bill.id || Date.now().toString(36), folder: f });
    checkBills();
  }),
  'bills.delete': inPage(({ id }, f) => { store.data.bills = store.data.bills.filter((b) => !(b.id === id && billFolder(b) === f)); store.save(); pushState(); }),
  'bills.setRate': inPage(({ usdToInr }) => { store.data.usdToInr = Number(usdToInr) || store.data.usdToInr; store.save(); }),
  'alerts.list': inPage((_a, f) => {
    const mine = alertsOf(f);
    mine.forEach((a) => { a.seen = true; }); store.save(); pushState();
    const counts = tabs.filter((t) => t.badge && t.identity === f).map((t) => ({ id: `tab${t.id}`, source: hostName(t.url), title: `${t.badge} new`, body: t.title, at: Date.now(), url: t.url, held: false }));
    return [...counts, ...mine];
  }, []),
  'alerts.clear': inPage((_a, f) => { store.data.alerts = store.data.alerts.filter((a) => a.folder && a.folder !== f); store.save(); pushState(); }),
  'library.bookmarks': inPage((_a, f) => lib.in(f).bookmarks(''), []),
  'library.history': inPage(({ q }, f) => lib.in(f).history(q, 500), []),
  'library.sites': inPage(({ q }, f) => {
    // Filed under the same headings the sidebar uses, so History reads the way
    // your tabs do: Nathaniel School, AI & Subscriptions, Google, Social, Code.
    const groups = groupList();
    const name = (id) => (id === 'other' ? 'Everything else' : (groups.find((g) => g.id === id) || {}).name || 'Everything else');
    const rank = (id) => (id === 'other' ? 99 : groups.findIndex((g) => g.id === id));
    return lib.in(f).sites(q, 400).map((r) => { const id = groupFor(`https://${r.host}/`); return { ...r, title: siteLabel(r.host, r.title), group: name(id), rank: rank(id) }; });
  }, []),
  'library.pages': inPage(({ host }, f) => lib.in(f).pages(host, 500), []),
  'library.forget': inPage(({ host }, f) => { lib.in(f).forgetSite(host); return true; }, false),
  'shield.status': () => (shield ? { ...shield.status(), on: shield.status().on && settings().blockAds !== false } : { on: false, lists: 0, dangerous: 0, listsAt: 0, dangerAt: 0, allowed: [] }),
  'shield.refresh': async () => {
    if (!shield) return null;
    await shield.refreshDanger();
    const ads = await shield.refreshAds();
    return { ...shield.status(), ok: ads };
  },
  // "Open it anyway" on the warning page. One host, until Cue is closed.
  'shield.close': (_a, from) => { if (from) closeTab(from.id); return true; },
  'shield.proceed': ({ site }, from, sender) => {
    if (!shield || !/^https?:\/\//i.test(String(site || ''))) return false;
    const host = shield.hostOf(site);
    if (!host) return false;
    // A Vanish tab has no entry in Cue's tab list, so it must never fall through to the active tab,
    // and its "open it anyway" is forgotten with the Vanish window.
    // Only from the warning page itself, about the site it is warning about.
    if (sender) {
      let shown = '';
      try { const u = new URL(sender.getURL()); if (u.protocol === 'cue:' && u.hostname === 'danger') shown = u.searchParams.get('site') || ''; } catch {}
      if (!shown || shield.hostOf(shown) !== host) return false;
    }
    if (!from && sender && vanish && vanish.tabs.some((x) => x.view.webContents === sender)) { vanishDangerOk.add(host); sender.loadURL(site).catch(() => {}); return true; }
    if (!from && sender) return false;
    dangerOk.add(host);
    const t = from || byId(activeId);
    if (t && t.view) t.view.webContents.loadURL(site).catch(() => {});
    return true;
  },
  'library.archived': inPage((_a, f) => store.data.archived.filter((x) => x.identity === f), []),
  'library.restore': inPage(({ id }, f) => {
    const a = store.data.archived.find((x) => x.id === id && x.identity === f); if (!a) return;
    store.data.archived = store.data.archived.filter((x) => x !== a);
    openTab({ url: a.url, identity: a.identity });
  }),
  'library.history.clear': inPage((_a, f) => lib.in(f).clearHistory()),
  // The two ways on from cue://signin-blocked. The name 'signin.from-chrome' is the old one and is
  // kept for the page; nothing is carried from Chrome - it clears this folder's Google state and
  // opens Google's own form again. In a pop-up it signs in again right there.
  'signin.from-chrome': (a, t, sender) => signInAgain(t, sender, false),
  'signin.other-account': (a, t, sender) => signInAgain(t, sender, true),
  'signin.google': (a, from, sender) => googleSignIn(askedFolder(a, from, sender)).then(({ cleared }) => ({ signin: true, cleared })),
  'signin.close': (_a, t, sender) => {
    if (t) { closeTab(t.id); return; }
    if (sender && popupIdentity.has(sender)) { const w = require('electron').BrowserWindow.fromWebContents(sender); if (w) w.close(); }
  },
  // Meta's sign-ins, into one folder, from the folder's own row in Settings.
  // Instagram and Facebook accept a carried jar; Google does not - see
  // carryAllFromChrome for what copying Google's cookies actually did.
  'signin.carry-all': async (a, from, sender) => {
    const who = askedFolder(a, from, sender);
    if (isLocked(who)) return [{ name: 'Instagram and Facebook', error: `${folderName(who)} is locked.` }];
    const name = folderName(who);
    if (!canCarryFromChrome()) { sendEvent('toast', 'There is no Chrome on this computer to bring a sign-in from.'); return []; }
    const done = await carryAllFromChrome(who);
    if (done.length && done.every((d) => d.cancelled)) return done;
    const got = done.filter((d) => d.count);
    const stuck = done.find((d) => d.error);
    if (got.length) {
      sendEvent('toast', `${got.map((d) => d.name).join(' and ')} came over from Chrome into ${name}.`);
    } else {
      sendEvent('toast', stuck ? stuck.error : `Chrome has no sign-in to bring into ${name}.`);
    }
    pushState();
    return done;
  },
};

// ---------------------------------------------------------------- move in from another browser
function findImports() {
  return importer.findBrowsers().map((b) => ({
    id: b.id, name: b.name,
    profiles: b.profiles.map((p) => ({ ...p, counts: importer.summarize(b, p), identity: guessIdentity(p) })),
  }));
}
// The folder whose Google address matches that browser profile's, or the one that is open.
function guessIdentity(p) {
  const want = String(p.email || '').toLowerCase();
  const hit = want && userFolders().find((f) => !isLocked(f.id) && emailOf(f.id).toLowerCase() === want);
  return hit ? hit.id : openFolder();
}
// Everything moved in goes into the ONE folder picked for it: its bookmarks, history, tabs,
// passwords and sign-ins, and nowhere else.
async function runImport({ browser, profile, identity, what }) {
  const b = importer.findBrowsers().find((x) => x.id === browser);
  const p = b && b.profiles.find((x) => x.dir === profile);
  if (!b || !p) return { error: 'That browser was not found.' };
  if (!isPerson(identity)) return { error: 'Pick the folder to move it into.' };
  if (isLocked(identity)) return { error: `${folderName(identity)} is locked. Unlock it first.` };
  const done = {};
  const mine = lib.in(identity);
  if (what.bookmarks) done.bookmarks = mine.importBookmarks(importer.readBookmarks(b, p));
  if (what.history) done.history = mine.importHistory(importer.readHistory(b, p));
  if (what.tabs) { const list = importer.readOpenTabs(b, p); list.forEach((x) => { const t = makeTab({ url: x.url, title: x.title, identity }); tabs.push(t); }); done.tabs = list.length; pushState(); persist(); }
  if (what.passwords || what.cookies) {
    const key = await importer.getKey(b);
    if (!key) done.note = 'Sign-ins and passwords could not be unlocked.';
    else {
      if (what.passwords) done.passwords = vault.importMany(identity, importer.readPasswords(b, p, key));
      if (what.cookies) {
        const ses = sessionFor(identity); let n = 0;
        for (const c of importer.readCookies(b, p, key)) { try { await ses.cookies.set(c); n++; } catch {} }
        await ses.cookies.flushStore(); done.cookies = n;
        await syncShared(identity);
        if (await teamImportOffered(identity)) { // only ever true with a starting setup that has a team site
          const team = await loadTeamVault(teamSite(), { quiet: true, into: [identity] });
          if (team.count) done.passwords = (done.passwords || 0) + team.count;
        }
      }
    }
  }
  return done;
}

// ---------------------------------------------------------------- the school's own password vault
// Reads the team site's vault from inside your signed-in tab and keeps the logins in Cue's
// locked vault, so the portals and their admin pages sign themselves in. Cards, banks and
// Wi-Fi stay out: they aren't website logins, and they should never be filled in by themselves.
const READ_TEAM_VAULT = `(async () => {
  const r = await fetch('/api/vault/passwords', { credentials: 'include' });
  if (!r.ok) return { signedIn: false };
  const rows = await r.json();
  const logins = rows.filter((x) => x.url && !/card|bank|wi-?fi|insurance|confidential/i.test(String(x.category) + ' ' + String(x.siteName)));
  const out = [];
  for (const x of logins) {
    const d = await fetch('/api/vault/passwords/' + x.id + '/decrypt', { method: 'POST', credentials: 'include' });
    if (!d.ok) continue;
    const { password } = await d.json();
    if (password) out.push({ origin: /^https?:/.test(x.url) ? x.url : 'https://' + x.url, username: x.username || '', password });
  }
  return { signedIn: true, rows: out };
})()`;
// A one-time import for the school's own staff. Everyone else moves in from Chrome or Safari,
// so nothing about it shows unless this computer is signed in to the team site.
// Asked of one folder: the one that is open, or the one being moved into.
async function teamImportOffered(folder = openFolder()) {
  if (!teamSite() || settings().teamLoaded || !isPerson(folder) || isLocked(folder)) return false;
  return (await sessionFor(folder).cookies.get({ domain: new URL(teamSite()).hostname })).length > 0;
}
let teamLoading = false;
async function teamSignedIn(t) { // runs itself the first time staff sign in to the team site
  if (teamLoading || !teamSite() || settings().teamLoaded || !t.url.startsWith(teamSite()) || !isPerson(t.identity) || t.agent) return;
  teamLoading = true;
  try { await loadTeamVault(teamSite(), { quiet: true, into: [t.identity] }); } catch {}
  teamLoading = false;
}
// `into`: the folders the logins go into - only the ones the person picked (the folder they are
// in when they press Load, or the folder they signed in to the team site in). Never every folder.
async function loadTeamVault(site = teamSite(), { quiet = false, into } = {}) {
  if (!site) return { signedIn: false };
  const targets = (Array.isArray(into) && into.length ? into : [openFolder()]).filter((f) => isPerson(f) && !isLocked(f));
  if (!targets.length) return { signedIn: false, error: 'Pick a folder that is not locked.' };
  const open = tabs.find((t) => t.url.startsWith(site) && t.identity === targets[0]);
  const t = open || openTab({ url: `${site}/vault`, identity: targets[0], background: true });
  ensureView(t);
  const wc = t.view.webContents;
  for (let i = 0; i < 100 && wc.isLoading(); i++) await wait(100);
  let got;
  try { got = await wc.executeJavaScript(READ_TEAM_VAULT, true); } catch { got = { signedIn: false }; }
  if (!got.signedIn) {
    if (quiet) { if (!open) closeTab(t.id); return { signedIn: false }; }
    activate(t.id); sendEvent('toast', 'Sign in to the team site here, then press Load again.'); return { signedIn: false };
  }
  let n = 0;
  for (const who of targets) n = vault.importMany(who, got.rows);
  vault.autoForOwnSites();
  if (n) { settings().teamLoaded = true; store.save(); }
  if (!open) closeTab(t.id);
  sendEvent('toast', `${n} logins loaded from the team site.`);
  return { signedIn: true, count: n };
}

// ---------------------------------------------------------------- extensions
function findExtensions() {
  const out = []; const seen = new Set(); const have = new Set(extensions.installed(extDir).map((e) => e.id));
  for (const b of importer.findBrowsers()) {
    for (const p of b.profiles) {
      if (!b.root) continue;
      for (const e of extensions.scan(path.join(b.root, p.dir))) {
        if (seen.has(e.id) || have.has(e.id)) continue;
        seen.add(e.id); out.push({ ...e, from: b.name });
      }
    }
  }
  return { available: out, installed: extensions.installed(extDir).map((e) => ({ id: e.id, name: e.name, version: e.version, can: e.can, on: extsLoaded.has(e.id) })) };
}
async function addExtension({ id, dir, name }) {
  const to = extensions.adopt(extDir, { id, dir });
  for (const k of allFolders()) { // every folder, as sessionFor loads them at start
    try { await sessionFor(k).extensions.loadExtension(to); } catch (e) { return { ok: false, error: e.message, name }; }
  }
  return { ok: true, name };
}
// Switched off in every login, then moved to the Trash rather than deleted, so
// an extension removed by mistake can be put back.
function removeExtension(id) {
  if (!/^[a-p]{32}$/.test(String(id || ''))) return false;
  for (const k of allFolders()) {
    const ses = sessionFor(k); const ext = ses.extensions.getAllExtensions().find((e) => path.basename(e.path) === id);
    if (ext) ses.extensions.removeExtension(ext.id);
  }
  extsLoaded.delete(id);
  const from = path.join(extDir, id);
  if (!fs.existsSync(from)) return true;
  shell.trashItem(from).catch((e) => logProblem('extension', e));
  return true;
}

// ---------------------------------------------------------------- image search from a file
async function lensFile({ name, type, bytes }) {
  const t = openTab({ url: 'about:blank' });
  const boundary = `----cue${Date.now()}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="encoded_image"; filename="${String(name || 'image').replace(/[\r\n"]/g, '')}"\r\nContent-Type: ${type || 'image/png'}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  await t.view.webContents.loadURL('https://lens.google.com/v3/upload', {
    postData: [{ type: 'rawData', bytes: Buffer.concat([head, Buffer.from(bytes), tail]) }],
    extraHeaders: `Content-Type: multipart/form-data; boundary=${boundary}`,
  }).catch(() => {});
  return true;
}

// ---------------------------------------------------------------- Boards, designer and video tools
async function addToBoard(t, p, boardId) {
  const wc = t.view.webContents; let thumb = '';
  try {
    const r = await wc.executeJavaScript(tools.rectAt(p.x, p.y), true);
    const img = await wc.capturePage(r);
    if (!img.isEmpty()) thumb = `data:image/jpeg;base64,${img.resize({ width: 360 }).toJPEG(82).toString('base64')}`;
  } catch {}
  lib.in(t.identity).boardAdd(boardId, { img: p.srcURL, source: wc.getURL(), title: p.titleText || p.altText || wc.getTitle(), thumb });
  sendEvent('toast', 'Added to board.');
}

async function imagePalette(t, p) {
  const wc = t.view.webContents;
  const r = await wc.executeJavaScript(tools.rectAt(p.x, p.y), true);
  const img = await wc.capturePage(r);
  if (img.isEmpty()) return;
  sendEvent('palette', { colors: tools.palette(img) });
}

async function runTool(name, t) {
  if (!t) return;
  if (name === 'boards' || name === 'library' || name === 'bills' || name === 'thumbcheck') { openCuePage(name, t.identity); return; }
  ensureView(t);
  const wc = t.view.webContents;
  try {
    if (name === 'colour') {
      const shot = await wc.capturePage();
      const pt = await wc.executeJavaScript(tools.PICK_POINT, true);
      if (!pt) return;
      const size = shot.getSize();
      const hex = tools.pixelHex(shot, pt.x * size.width / pt.w, pt.y * size.height / pt.h);
      copy(hex); sendEvent('palette', { colors: [hex] });
    } else if (name === 'font') {
      const f = await wc.executeJavaScript(tools.FONT_FINDER, true);
      if (f) { copy(f); sendEvent('toast', `Copied: ${f}`); }
    } else if (name === 'ruler') {
      await wc.executeJavaScript(tools.RULER, true);
    } else if (name === 'fullpage') {
      const r = await capture.fullPage(wc, t.title);
      sendEvent('toast', `Page saved in Cue Captures (${r.width} × ${r.height}).`); capture.reveal(r.file);
    } else if (name === 'gif') {
      sendEvent('toast', 'Recording a 6 second GIF of this tab.');
      const r = await capture.gif(wc, t.title);
      sendEvent('toast', 'GIF saved in Cue Captures.'); capture.reveal(r.file);
    } else if (name === 'record') {
      sendEvent(recTabId ? 'rec-stop' : 'rec-start');
    } else if (name === 'mark') {
      const s = await wc.executeJavaScript(tools.VIDEO_TIME, true);
      if (s == null) { sendEvent('toast', 'No video on this page.'); return; }
      const whole = Math.floor(s);
      const yt = t.url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
      t.marks.push(yt ? `${tools.stamp(whole)} https://youtu.be/${yt[1]}?t=${whole}` : `${tools.stamp(whole)} ${t.url}`);
      copy(t.marks.join('\n'));
      sendEvent('toast', `Marked ${tools.stamp(whole)}. All ${t.marks.length} copied.`);
    } else if (name === 'frame') {
      const g = await wc.executeJavaScript(tools.GRAB_FRAME, true);
      if (!g) { sendEvent('toast', 'No video on this page.'); return; }
      const png = g.png ? Buffer.from(g.png.split(',')[1], 'base64') : (await wc.capturePage(g.rect)).toPNG();
      const file = capture.nameFor(`Frame ${tools.stamp(g.time)} ${t.title}`, 'png');
      fs.writeFileSync(file, png);
      sendEvent('toast', 'Frame saved in Cue Captures.'); capture.reveal(file);
    }
  } catch (e) { sendEvent('toast', 'That tool could not run on this page.'); console.error(name, e.message); }
}

// ---------------------------------------------------------------- AI port
function agentSetupText() {
  // In the installed app the bridge sits outside the archive, in app.asar.unpacked, so node can run it.
  const bridge = !app.isPackaged ? path.join(ROOT, '..', 'bin', 'cue-mcp.js')
    : [path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', 'cue-mcp.js'), path.join(process.resourcesPath, 'app', 'bin', 'cue-mcp.js')].find((f) => fs.existsSync(f))
      || path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', 'cue-mcp.js');
  return `Cue AI port: http://127.0.0.1:${AGENT_PORT}\nToken file: ${agentTokenFile()}\nMCP bridge: node "${bridge}"`;
}
function agentTokenFile() { return path.join(app.getPath('userData'), 'agent-port.json'); }

function logAgent(entry) {
  const e = { at: new Date().toISOString(), ...entry };
  agentLog.push(e); if (agentLog.length > 200) agentLog.shift();
  // An agent reading its own tab is the normal thing and says nothing. An agent
  // reaching into a tab he opened himself is worth a line on screen, once.
  if (e.ok && e.tab) {
    const t = byId(Number(e.tab));
    const seen = `${e.agent}|${e.tab}`;
    if (t && !t.agent && !agentSeen.has(seen)) {
      agentSeen.add(seen);
      sendEvent('toast', `${e.agent} used “${(t.title || t.url || 'a tab').slice(0, 40)}” — a tab you did not hand it.`);
    }
  }
  fs.appendFile(path.join(app.getPath('userData'), 'agent-log.jsonl'), JSON.stringify(e) + '\n', { mode: 0o600 }, () => {});
  pushState();
}

// WAKING A BACKGROUND TAB FOR AN AGENT. A tab nobody is looking at is hidden from Chromium, and a
// hidden page does not draw: no animation frames, no scroll events, and a tab that was never on
// screen has no size at all (innerWidth 0). Pages that draw only what fits break on that - on
// 11-Nov-2026 Gmail in an agent's tab had all fifty search rows in the page and showed one, and a
// walk of the school's WhatsApp list saw 25 chats of hundreds, because its list redraws on frames
// and the hidden tab got none ("no frame in 1.5s", measured in the page).
//
// So while an agent works in a tab, the tab is SHOWN - but placed just outside the window's
// visible area, at its normal size. Chromium then draws it as if it were on screen: frames, scroll
// events, a real size. Nothing appears on his screen, nothing is brought forward, and his keyboard
// stays where it is. Background throttling is off for the same stretch. Fifteen seconds after the
// agent's last call it is hidden again; if he opens that tab himself, layout() puts it in its
// normal place at once. Tried first and dropped (11-Nov-2026): webContents.incrementCapturerCount
// no longer exists in Electron 44, and Chromium's view-size override gives a size but only one frame.
// Is a film or song in this page really making sound? Playing, not muted, volume up, and sound decoded.
const SOUNDING = `[...document.querySelectorAll('video, audio')].some((m) => !m.paused && !m.muted && m.volume > 0 && ((m.webkitAudioDecodedByteCount || 0) > 0 || (m.audioTracks && m.audioTracks.length > 0)))`;
const AWAKE_MS = 15000;
function offStage() {
  const r = contentRect();
  const width = Math.max(800, r.width), height = Math.max(600, r.height);
  return { x: -(width + 400), y: r.y, width, height };
}
function wake(t) {
  if (!t || !t.view || t.host !== 'main') return Promise.resolve();
  const wc = t.view.webContents;
  if (wc.isDestroyed()) return Promise.resolve();
  const first = !t.awake;
  t.awake = true;
  try { wc.setBackgroundThrottling(false); } catch {}
  clearTimeout(t.awakeTimer);
  t.awakeTimer = setTimeout(() => sleepAgain(t), AWAKE_MS);
  const onScreen = panes.some((p) => p.id === t.id);
  if (onScreen) return Promise.resolve();
  // Shown afresh on every call: a page that reloaded comes back hidden inside a view that still
  // says it is visible, and draws nothing until it is shown again.
  const r = offStage();
  if (!first) t.view.setVisible(false);
  t.view.setBounds(r); t.view.setVisible(true);
  // Chromium sizes a view by the part of it inside the window, which off stage is nothing, so the
  // page is told its size outright with Chromium's own view-size override.
  const size = { width: r.width, height: r.height };
  return new Promise((ok) => setTimeout(ok, first ? 250 : 60)).then(() => wc.executeJavaScript('innerWidth', true)).then(async (w) => {
    if (w || wc.isDestroyed() || !t.awake) return;
    try { if (t.sized) wc.disableDeviceEmulation(); } catch {}
    try { wc.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: size, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: size, scale: 1 }); t.sized = true; } catch {}
    for (let i = 0; i < 20; i++) { await new Promise((ok) => setTimeout(ok, 50)); if (await wc.executeJavaScript('innerWidth', true).catch(() => 1)) break; }
  }).catch(() => {});
}
// The size override comes off the moment the tab is on screen or asleep again.
function unsize(t) {
  if (!t.sized) return;
  t.sized = false;
  const wc = t.view && t.view.webContents;
  if (wc && !wc.isDestroyed()) { try { wc.disableDeviceEmulation(); } catch {} }
}
function sleepAgain(t) {
  clearTimeout(t.awakeTimer);
  if (!t.awake) return;
  t.awake = false;
  const wc = t.view && t.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  unsize(t);
  try { wc.setBackgroundThrottling(true); } catch {}
  layout();
}

// Which folder an agent means, from what it said: a folder's name or id, any case. It is refused
// - in words that say why - when the folder is locked or the person has not opened it to AI
// agents. "agent" is the agents' own lane, always theirs.
function agentFolder(said, what = 'that') {
  const key = String(said || '').trim().toLowerCase();
  if (key === 'agent' || key === 'ai agent') return 'agent';
  const id = resolveWho(said, userFolders().map((f) => ({ id: f.id, name: f.name })), what);
  const name = folderName(id);
  if (isLocked(id)) throw new Error(`${possessive(name)} folder is locked. Nothing in it can be used until the person unlocks it. Nothing was done.`);
  if (!agentsMay(id)) throw new Error(`${possessive(name)} folder is not open to AI agents. The person can allow it in Cue Settings, under Folders and accounts. Nothing was done.`);
  return id;
}

// ---- files, for agents: cue_attach puts files from this computer onto a page (src/main/attach.js),
// cue_download saves one into Downloads/Cue Agents. Neither shows a dialog or brings anything forward.
const attacher = attachKit.makeAttach();
// Cue's own data folder is never handed to a page, wherever it lives (CUE_USER_DATA in tests).
const agentFiles = (list) => attachKit.vetFiles(list, { protectedDirs: [app.getPath('userData'), path.join(app.getPath('appData'), 'Cue')], exempt: [path.join(app.getPath('downloads'), 'Cue Agents')] });
function agentDownloadDir() { const d = path.join(app.getPath('downloads'), 'Cue Agents'); fs.mkdirSync(d, { recursive: true }); return d; }
const agentDownloads = [];
// Called by will-download: is this the download an agent is waiting for in that tab?
function takeAgentDownload(item, fromWc) {
  const now = Date.now();
  for (let i = agentDownloads.length - 1; i >= 0; i--) if (agentDownloads[i].until < now) agentDownloads.splice(i, 1);
  let chain = []; try { chain = item.getURLChain(); } catch {}
  const k = agentDownloads.findIndex((w) => fromWc && w.wcId === fromWc.id && (!w.url || w.url === item.getURL() || chain.includes(w.url)));
  return k < 0 ? null : agentDownloads.splice(k, 1)[0];
}
async function agentDownload(t, a = {}) {
  const wc = t.view.webContents;
  let url = a.url ? agentApi.safeUrl(a.url) : '';
  let click = false;
  if (!url && !a.selector) throw new Error('Say what to download: url (the file\'s address) or selector (the link or button on the page). Nothing was downloaded.');
  if (!url) {
    const hit = await wc.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(String(a.selector))}); if (!el) return null;
      const link = el.closest('a[href]'); const href = link ? link.href : (el.src || ''); return { href: /^https?:/.test(href) ? href : '' }; })()`, true).catch(() => null);
    if (!hit) throw new Error(`Nothing on the page matches “${a.selector}”. Nothing was downloaded.`);
    if (hit.href) url = hit.href; else click = true;
  }
  if (url && shield && shield.verdict(url)) throw new Error(`Cue will not download from ${shield.hostOf(url)}: that site is reported for ${shield.verdict(url)}. Nothing was downloaded.`);
  let wait;
  const done = new Promise((ok, no) => {
    const w = {
      wcId: wc.id, url: click ? '' : url, until: Date.now() + 20000,
      fail: (m) => { clearTimeout(wait); no(new Error(m)); },
      started: (item, file) => {
        clearTimeout(wait);
        wait = setTimeout(() => { try { item.cancel(); } catch {} no(new Error(`The download of ${path.basename(file)} took longer than ten minutes, so Cue stopped it. Nothing was saved.`)); }, 10 * 60000);
        item.once('done', (_e, state) => {
          clearTimeout(wait);
          const saved = item.getSavePath() || file;
          if (state === 'completed') ok({ file: saved, size: item.getReceivedBytes() });
          else no(new Error(`The download of ${path.basename(saved)} ${state === 'cancelled' ? 'was cancelled' : 'stopped'}. Nothing was saved.`));
        });
      },
    };
    agentDownloads.push(w);
    wait = setTimeout(() => {
      const i = agentDownloads.indexOf(w); if (i >= 0) agentDownloads.splice(i, 1);
      no(new Error(click ? `Clicking “${a.selector}” did not start a download within 20 seconds. Nothing was saved.` : `${url} did not start downloading within 20 seconds. Nothing was saved.`));
    }, 20000);
  });
  if (click) await wc.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(String(a.selector))}); el.click(); return true; })()`, true);
  else wc.downloadURL(url);
  const got = await done;
  return { text: `Saved ${path.basename(got.file)} (${attachKit.human(got.size)}) to ${got.file}\nAttach it anywhere with cue_attach and files:[${JSON.stringify(got.file)}].`, path: got.file, size: got.size };
}

const whatsapp = makeWhatsApp({
  tabs, openTab, ensureView, hostOf, activate, programId: () => programId, frontId: () => activeId, wake,
  who: (said) => agentFolder(said, 'WhatsApp'), nameOf: folderName,
  vetFiles: (list) => agentFiles(list), attachFiles: (wc, files, opts) => attacher.attach(wc, files, opts),
});
// The agent's own Gmail tab in a folder: never the person's inbox (see `own` in openTab).
function agentGmailTab(identity, url) {
  const host = hostOf(url);
  const home = url.split('#')[0].split('?')[0];
  let t = tabs.find((x) => x.agent && x.identity === identity && x.id !== programId && !x.private && hostOf(x.url) === host && String(x.url).startsWith(home));
  if (!t) t = openTab({ url: googleForFolder(url, identity), identity, background: true, agent: true, own: true });
  ensureView(t);
  t.aiBusy = Date.now(); clearTimeout(t.aiTimer); t.aiTimer = setTimeout(() => { t.aiBusy = 0; pushState(); }, 60000); pushState();
  return t;
}
const gmail = makeGmail({ agentTab: agentGmailTab, wake, label: folderName, who: (said) => agentFolder(said, 'Gmail'),
  vetFiles: (list) => agentFiles(list), attachFiles: (wc, files, opts) => attacher.attach(wc, files, opts) });

const agentApi = {
  doorOpen: () => doorOpen,
  // Somebody tried while the door was shut. Say it once a minute, no more.
  knock: (who) => {
    const now = Date.now();
    if (now - lastKnock < 60000) return;
    lastKnock = now;
    sendEvent('toast', `${who} asked to use Cue. The AI door is closed - open it in Settings.`);
  },
  // Only the folders an agent may use: unlocked, and opened to agents by the person. A locked
  // folder, or one kept private from agents, is not even named.
  identities: () => [...userFolders().filter((f) => agentsMay(f.id)).map((f) => ({ id: f.id, name: f.name, account: emailOf(f.id) })),
    { id: 'agent', name: BUILTIN.agent.name, account: emailOf('agent') }],
  list: () => sidebarOrder().filter((t) => t.identity !== 'vanish' && agentsMay(t.identity)).map((t) => ({
    id: t.id, title: hiddenFromAI(t) ? 'Private' : t.title, url: isStart(t.url) || hiddenFromAI(t) ? '' : t.url, identity: t.identity, folder: folderName(t.identity), group: groupOf(t),
    onAir: t.id === programId, private: t.private, agentTab: t.agent, aiCanAct: agentCanAct(t), audible: t.audible, muted: t.muted, volume: t.volume,
  })),
  get: (id) => byId(Number(id)),
  canRead: (t) => !!t && t.identity !== 'vanish' && agentsMay(t.identity) && !hiddenFromAI(t) && !/^(cue|file):/.test(t.url), // your Library, Bills and own files stay yours
  canAct: (t) => agentCanAct(t),
  paused: () => aiPaused(),
  open: ({ url, identity, background = true, newTab = false }) => {
    const target = agentApi.safeUrl(url);
    // An agent works in the person's accounts, in the folder they have open (or the one it
    // names), not in a separate browser of its own. That is what stops a second WhatsApp and a
    // second inbox appearing beside the ones they use. A folder that is locked or not opened to
    // agents is refused, named or not.
    let who;
    if (identity !== undefined && identity !== null && identity !== '' && identity !== 'vanish') who = agentFolder(identity);
    else {
      who = openFolder();
      if (!agentsMay(who)) throw new Error(`The folder that is open (${folderName(who)}) is not open to AI agents${isLocked(who) ? ', and it is locked' : ''}. Name a folder from cue_identities with identity, or "agent" for your own lane. Nothing was opened.`);
    }
    // One tab per site, not one per instruction. An agent sent to WhatsApp six
    // times used to leave six WhatsApp tabs behind; now it goes back to the one
    // it already has open for that site and navigates it. A tab the person has handed
    // over counts as that one tab: opening WhatsApp used to build a twin beside
    // their own linked tab, which left two of everything in the sidebar.
    // Their own handed-over tab is never navigated away from the page they left it
    // on: it is reused only when it already sits on the address asked for.
    // Anything that needs a different page goes to the agent's own tab.
    if (!newTab) {
      const host = hostOf(target);
      const mine = (t) => t.agent && t.identity === who && t.id !== programId && hostOf(t.url) === host;
      const his = (t) => agentCanAct(t) && !t.agent && t.identity === who && t.url === target;
      const reuse = tabs.find(his) || tabs.find(mine);
      if (reuse) {
        ensureView(reuse);
        if (reuse.url !== target) reuse.view.webContents.loadURL(target);
        if (!background) activate(reuse.id, 'agent');
        return reuse;
      }
    }
    // own: the agent's own tab. Without it the one-per-folder rule handed agents HIS Gmail and
    // moved it to their search (11-Nov-2026: his Personal inbox was left on an agent's search).
    return openTab({ url: googleForFolder(target, who), identity: who, background, agent: true, own: true });
  },
  safeUrl: (url) => {
    const target = resolveInput(url);
    if (!/^(https?:|about:blank)/i.test(target)) throw new Error('Only web pages can be opened here. Cue\'s own pages and files on this computer stay private.');
    return target;
  },
  // The AI mark on a row means an agent is working in that tab NOW, not that it
  // is allowed to one day. Every read or click an agent makes lights it; it goes
  // out by itself a minute later.
  ensure: (t) => { t.aiBusy = Date.now(); clearTimeout(t.aiTimer); t.aiTimer = setTimeout(() => { t.aiBusy = 0; pushState(); }, 60000); pushState(); return ensureView(t); },
  capture: (t) => captureTab(t),
  close: (t) => closeTab(t.id),
  fullPage: (t) => capture.fullPage(t.view.webContents, t.title),
  problems: (t) => t.log,
  // Everyone's tray unless the agent names the folder it is about.
  alert: (a) => {
    let folder;
    if (a.identity || a.folder) folder = agentFolder(a.identity || a.folder);
    return addAlert({ source: a.source || 'AI agent', title: a.title, body: a.body || '', url: a.url || '', ...(folder && folder !== 'agent' ? { folder } : {}) });
  },
  bills: () => store.data.bills.filter((b) => agentsMay(billFolder(b))).map((b) => ({ ...b, status: bills.status(b) })),
  // WhatsApp is its own narrow door. A general agent may not click or type in the person's own
  // tabs, and that stays true; this tool can work in a folder's WhatsApp tab because it can
  // do nothing else there — list chats, read one, send a message they asked for, and say whether
  // the account is linked. Private tabs, Vanish tabs, the tab on air, locked folders and folders
  // not opened to agents are still off limits.
  whatsapp: (a) => {
    if (aiPaused()) throw new Error('AI agents are paused in Cue, WhatsApp included. Stop here and say so — do not open WhatsApp another way.');
    return whatsapp(a);
  },
  // Gmail, the same narrow way: search and read, in the agent's own Gmail tab of that folder.
  gmail: (a) => {
    if (aiPaused()) throw new Error('AI agents are paused in Cue, Gmail included. Stop here and say so.');
    if ((settings().agentSites || {}).gmail === false) throw new Error('Gmail is switched off for agents in Cue Settings.');
    return gmail(a);
  },
  wake: (t) => wake(t),
  // Files (cue_attach, cue_download). The door checks the tab first; these do the work.
  vetFiles: (list) => agentFiles(list),
  attachFiles: (t, files, opts) => attacher.attach(t.view.webContents, files, opts),
  sayAttached: attachKit.sayAttached,
  fileTargets: (t) => attacher.targets(t.view.webContents),
  download: (t, a) => agentDownload(t, a),
  setMuted, setVolume,
  // ---- the teaching rig's door (Stream Deck pedal + OBS), not an AI agent's.
  // OBS captures Cue as an application, so the class sees whatever tab is
  // showing in Cue's window. A pedal press is therefore just "show slot N".
  // Jason's own tabs are the slots: a background tab an agent opened must
  // never become what a class is looking at. A locked folder has no slots.
  slots: () => sidebarOrder().filter((t) => t.identity !== 'vanish' && !t.agent && !isLocked(t.identity))
    .map((t) => ({ id: t.id, title: t.private ? 'Private' : t.title, url: isStart(t.url) || t.private ? '' : t.url, showing: t.id === activeId })),
  show: (id) => activate(Number(id)),
  take: () => take(),
  // Raise the window WITHOUT taking focus. He is usually teaching over Zoom
  // when this fires; showInactive keeps his keystrokes where they were while
  // still giving ScreenCaptureKit a frontmost Cue window to capture.
  front: ({ focus = false } = {}) => {
    if (!mainWin) return { ok: false };
    if (focus) mainWin.show(); else { mainWin.showInactive(); mainWin.moveTop(); }
    return { ok: true };
  },
  rig: () => ({
    pid: process.pid,
    bundle: 'com.jasonzac.cue',
    showing: activeId,
    onAir: programId,
    live,
    stageOpen: !!stageWin,
    tabs: sidebarOrder().filter((t) => t.identity !== 'vanish' && !t.agent).length,
  }),
  log: logAgent,
};

// The AI port, opened once per launch at most.
let portUp = false;
function openAgentPort() {
  if (portUp) return;
  portUp = true;
  startAgentPort({ port: AGENT_PORT, tokenFile: agentTokenFile(), api: agentApi })
    .catch((e) => { portUp = false; logAgent({ tool: 'port', error: e.message }); });
}

function hiddenFromAI(t) { return t.private || t.id === programId; }
// WhatsApp is the one site handed over on purpose: the agents answer for the person there, in
// the tab their phone is linked to, because a second linked browser is not a thing WhatsApp
// allows. Everything else still has to be a tab an agent opened, or one the person ticked.
// The host comes from whatsapp.js so there is one answer to "is this WhatsApp", not two
// that drift apart the day either side changes.
// Two sites are handed over by the setting rather than tab by tab, because handing them over one
// tab at a time is the thing nobody keeps up with. WhatsApp has to work this way - a second linked
// browser is not a thing WhatsApp allows, so the agents answer in the tab the phone is linked to.
// Gmail is here because he asked for it: the agents read and draft in the same inbox that is open,
// in whichever folder it belongs to, instead of a second copy. Either can be switched off in
// Settings, and neither reaches a private tab, a Vanish tab, the tab on air, or a folder that is
// locked or not opened to agents.
const AGENT_SITES = {
  whatsapp: { name: 'WhatsApp', what: 'Read and reply in the tab your phone is linked to', is: (h) => h === WA_HOST() },
  gmail: { name: 'Gmail', what: 'Read and draft in the inbox you already have open', is: (h) => h === 'mail.google.com' },
};
const handedOverSite = (t) => {
  if (!isPerson(t.identity) || !agentsMay(t.identity)) return null;
  const h = hostOf(t.url); const on = settings().agentSites || {};
  const hit = Object.entries(AGENT_SITES).find(([k, v]) => on[k] !== false && v.is(h));
  return hit ? hit[1].name : null;
};
const HANDED_OVER = (t) => !!handedOverSite(t);
// One switch that stops every agent mid-job without taking anything away. The
// tabs stay handed over, so resuming is one click and nothing has to be set up
// again.
const aiPaused = () => !!settings().aiPaused;
function agentCanAct(t) { return !aiPaused() && !!t && t.identity !== 'vanish' && agentsMay(t.identity) && !t.private && t.id !== programId && !t.url.startsWith('cue://') && (t.agent || t.aiAllowed || HANDED_OVER(t)); }
// What the AI row in the sidebar counts: every tab an agent may work in, plus
// any tab still sitting in the old AI agent folder. Paused or not — he needs to
// see what is handed over even while it is on hold.
const aiTabs = () => tabs.filter((t) => t.identity !== 'vanish' && agentsMay(t.identity) && !t.private && t.id !== programId
  && !t.url.startsWith('cue://') && (t.agent || t.aiAllowed || HANDED_OVER(t) || t.identity === 'agent'));

// ---------------------------------------------------------------- menus
const MAC = process.platform === 'darwin';
// The one place you can ask. With "Update Cue by itself" on, the update bar stays hidden,
// so the answer has to be said out loud here.
async function checkForUpdates() {
  if (!updater) return;
  const u = await updater.check({ quiet: false });
  if (u.state === 'available') return; // "Update Cue by itself" is off: the bar is asking already
  const waiting = u.state === 'ready' || u.state === 'downloading';
  const said = u.blocked === 'readonly'
    ? { message: 'Cue cannot update itself here.', detail: UPDATE_SAY.readonly }
    : u.state === 'error'
    ? { message: 'Cue could not check for updates.', detail: u.error }
    : waiting
      ? { message: `Cue ${u.latest} is on its way.`, detail: 'It goes in the next time you close Cue.' }
      : { message: 'You have the newest Cue.', detail: `This is version ${app.getVersion()}.` };
  if (!process.env.CUE_TEST) dialog.showMessageBox(mainWin, { type: 'info', buttons: ['OK'], ...said });
}

function buildMenu() {
  const raw = (c, a) => () => ipcMain.emit('ui:cmd', {}, c, a);
  // A Vanish window is a player, not the browser. Its own keys belong to it, and
  // the main window's keys must not reach past it: pressing one used to switch a
  // tab behind the film and throw him out of what he was watching.
  const inVanish = () => { try { return vanish.focused(); } catch { return false; } };
  const mainOnly = (fn) => () => { if (inVanish()) return; fn(); };
  const cmd = (c, a) => mainOnly(raw(c, a));
  const ids = openableIds();
  const tpl = [
    ...(process.platform === 'darwin' ? [{
      label: app.name, submenu: [
        { role: 'about' },
        // Where every Mac app keeps it, so it is findable without hunting for
        // the cog at the foot of the sidebar.
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: mainOnly(() => sendEvent('open-settings')) },
        { label: 'Check for Updates…', click: () => checkForUpdates() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File', submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: cmd('new-tab') },
        { label: 'New Tab Just for Now', accelerator: 'CmdOrCtrl+Alt+T', click: cmd('new-tab', { temp: true }) },
        { label: 'New Vanish Tab', accelerator: 'CmdOrCtrl+Shift+N', click: raw('new-tab', { identity: 'vanish' }) },
        { label: 'New Vanish Tab', accelerator: 'CmdOrCtrl+Alt+N', visible: false, acceleratorWorksWhenHidden: true, click: raw('new-tab', { identity: 'vanish' }) }, // for Macs where another app owns Cmd+Shift+N
        { label: 'New Tab As', submenu: ids.map((i) => ({ label: folderName(i), click: cmd('new-tab', { identity: i }) })) },
        { label: 'Move In From Another Browser…', click: () => sendEvent('import') },
        { label: 'Bring This Site\u2019s Sign-in Over From Chrome…', visible: canCarryFromChrome(), click: () => carrySignIn(byId(activeId)) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: mainOnly(() => reopenClosed()) },
        { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: mainOnly(() => { uiView.webContents.focus(); sendEvent('focus-omnibox'); }) },
        { label: 'Find Anything', accelerator: 'CmdOrCtrl+K', click: mainOnly(() => { uiView.webContents.focus(); sendEvent('palette-open'); }) },
        { label: 'Pop Out Tab', accelerator: 'CmdOrCtrl+Shift+P', click: cmd('popout') },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: mainOnly(() => { const t = byId(activeId); if (t && t.view) t.view.webContents.print(); }) },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => { if (vanish.focused()) vanish.closeTab(vanish.activeId()); else closeTab(activeId); } },
        { type: 'separator' },
        // His own nine. The label says where each key goes, so the menu is also the reminder.
        ...quickKeys().filter((q) => !quickEmpty(q)).map((q) => ({
          label: q.url ? `Go to ${q.name || hostOf(q.url) || q.url}` : q.name,
          accelerator: `CmdOrCtrl+${q.key}`,
          click: mainOnly(() => jumpTo(q.url)),
        })),
        { type: 'separator' },
        { label: 'Move Tab Up', accelerator: 'Alt+CmdOrCtrl+Up', click: mainOnly(() => moveTab({ id: activeId, dir: -1 })) },
        { label: 'Move Tab Down', accelerator: 'Alt+CmdOrCtrl+Down', click: mainOnly(() => moveTab({ id: activeId, dir: 1 })) },
        // Windows and Linux have no app menu, so Settings, updates and Quit live here.
        ...(MAC ? [] : [
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'Ctrl+,', click: mainOnly(() => sendEvent('open-settings')) },
          { label: 'Check for Updates…', click: () => checkForUpdates() },
          { type: 'separator' },
          { label: 'Quit Cue', accelerator: 'Ctrl+Q', click: () => app.quit() },
        ]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View', submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: cmd('reload') },
        { label: 'Hide or Show Sidebar', accelerator: 'CmdOrCtrl+\\', click: mainOnly(() => setSideHidden(!settings().sideHidden)) },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: mainOnly(() => { uiView.webContents.focus(); sendEvent('focus-find'); }) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd('zoom', { dir: 1 }) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd('zoom', { dir: -1 }) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: cmd('zoom', { reset: true }) },
        { type: 'separator' },
        ...(MAC ? [] : [{ role: 'togglefullscreen' }, { type: 'separator' }]), // the Mac adds its own Full Screen item
        { label: 'One Tab', accelerator: 'CmdOrCtrl+Alt+1', click: cmd('split', { mode: 'single' }) },
        { label: 'Side by Side', accelerator: 'CmdOrCtrl+Alt+2', click: cmd('split', { mode: 'cols2' }) },
        { label: 'Top and Bottom', accelerator: 'CmdOrCtrl+Alt+3', click: cmd('split', { mode: 'rows2' }) },
        { label: 'Three Columns', accelerator: 'CmdOrCtrl+Alt+4', click: cmd('split', { mode: 'cols3' }) },
        { label: 'Grid of Four', accelerator: 'CmdOrCtrl+Alt+5', click: cmd('split', { mode: 'grid4' }) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: mainOnly(() => { const t = byId(activeId); if (t && t.view) t.view.webContents.toggleDevTools(); }) },
      ],
    },
    {
      label: 'History', submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: cmd('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: cmd('forward') },
        { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: mainOnly(() => bookmarkTab(byId(activeId))) },
        { label: 'Bookmarks, History and Archived Tabs', accelerator: 'CmdOrCtrl+Y', click: cmd('open-page', { page: 'library' }) },
      ],
    },
    ...(kit('teacher') ? [{
      label: 'Live', submenu: [
        { label: 'Go Live / End Live', accelerator: 'CmdOrCtrl+Shift+L', click: mainOnly(() => setLive(!live)) },
        { label: 'TAKE: Put Cued Tab On Air', accelerator: 'CmdOrCtrl+Enter', click: mainOnly(() => take()) },
        { type: 'separator' },
        { label: 'Cue This Tab', accelerator: 'CmdOrCtrl+Shift+C', click: mainOnly(() => cueAdd(activeId)) },
        { label: 'Stage: One Tab', click: () => stageSplit(1) },
        { label: 'Stage: Two Side by Side', click: () => stageSplit(2) },
        { label: 'Stage: Three Side by Side', click: () => stageSplit(3) },
        { label: 'Next Cued Tab On Air', accelerator: 'CmdOrCtrl+Shift+Right', click: mainOnly(() => cueStep(1)) },
        { label: 'Previous Cued Tab On Air', accelerator: 'CmdOrCtrl+Shift+Left', click: mainOnly(() => cueStep(-1)) },
        { type: 'separator' },
        // One key per slot, so a class is numbers, not hunting for a tab.
        ...[1, 2, 3, 4, 5, 6].map((n) => ({
          label: `On Air: Cue ${n}`, accelerator: `CmdOrCtrl+Shift+${n}`,
          click: mainOnly(() => { const x = cueTabs()[n - 1]; if (x) take(x.id); else sendEvent('toast', `Nothing is cued at ${n} yet. Drag a tab onto the On-air box.`); }),
        })),
      ],
    }] : []),
    { label: 'Tools', submenu: toolMenu(cmd) },
    {
      label: 'Tab', submenu: [
        ...spaces().map((n, i) => ({ label: `Space: ${n}`, accelerator: `${MAC ? 'Ctrl' : 'Alt'}+${i + 1}`, click: mainOnly(() => switchSpace(n)) })),
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: mainOnly(() => cycle(1)) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: mainOnly(() => cycle(-1)) },
        { label: 'Mute / Unmute Tab', accelerator: 'Ctrl+M', click: cmd('mute') },
        { label: 'Play / Pause Tab', accelerator: MAC ? 'Ctrl+P' : 'Alt+P', click: cmd('media', { cmd: 'toggle' }) },
        { label: 'Mini Player (keeps playing while you work)', accelerator: MAC ? 'Control+Cmd+M' : 'Ctrl+Alt+M', click: cmd('mini') },
        { label: 'Picture in Picture', accelerator: 'CmdOrCtrl+Alt+P', click: () => { if (vanish.focused()) { vanish.pictureInPicture(); return; } const t = byId(activeId); if (t && t.view) t.view.webContents.executeJavaScript(PICTURE_IN_PICTURE, true).catch(() => {}); } },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, visible: false, click: mainOnly(() => { const o = spaceOrder(); const x = n === 9 ? o[o.length - 1] : o[n - 1]; if (x) activate(x.id); }) })),
      ],
    },
    {
      // 'window' (not 'windowMenu') so the Mac still lists open windows here and our items stay.
      label: 'Window', role: 'window', submenu: [
        { role: 'minimize' },
        ...(MAC ? [{ role: 'zoom' }] : [{ role: 'close' }]),
        { type: 'separator' },
        { label: 'Vanish', id: 'vanish-menu', submenu: vanishMenu() },
        ...(MAC ? [{ type: 'separator' }, { role: 'front' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// Window > Vanish lists every Vanish shortcut from the same table the Vanish window's key handler
// uses (vanish-keys.js), so the menu is also the reminder. The keys are written into the label
// rather than registered: the Vanish window answers them itself, and registering them here as
// well would put a second Cmd+T and Cmd+W into the menu and let them act from the main window.
function vanishMenu() {
  return vanishKeys.shown().filter((k) => k.id !== 'leave').map((k) => ({
    label: `${k.label}   ${k.keys}`, id: `vanish-${k.id}`,
    click: () => {
      if (k.id === 'open') { vanish.add(); return; }
      if (!vanish.window()) return;
      if (k.id === 'goto') return; // a number, typed in the window
      vanish.run(k.id);
    },
  }));
}

function toolMenu(cmd) {
  const tool = (label, name, accelerator) => ({ label, accelerator, click: cmd('tool', { name }) });
  return [
    { label: 'AI Side Panel', accelerator: 'CmdOrCtrl+J', click: cmd('ai') },
    { label: 'Ask AI About This Page', accelerator: 'CmdOrCtrl+Shift+J', click: cmd('ai-ask') },
    { type: 'separator' },
    ...(kit('music') ? [{ label: 'Music Bar', accelerator: 'CmdOrCtrl+Shift+M', click: cmd('strip') }] : []),
    ...(kit('video') ? [
      tool('Save Whole Page as a Picture', 'fullpage', 'CmdOrCtrl+Shift+S'),
      tool('Record This Tab / Stop', 'record', 'CmdOrCtrl+Shift+R'),
      tool('Make a 6 Second GIF', 'gif'),
      tool('Mark Video Timestamp', 'mark', 'CmdOrCtrl+Shift+U'),
      tool('Grab Video Frame', 'frame', 'CmdOrCtrl+Shift+F'),
    ] : []),
    ...(kit('designer') ? [
      { type: 'separator' },
      tool('Pick a Colour', 'colour', 'CmdOrCtrl+Shift+C'), tool('Find a Font', 'font'), tool('Ruler', 'ruler'), tool('Boards', 'boards', 'CmdOrCtrl+Shift+B'),
    ] : []),
    ...(kit('creator') ? [
      { type: 'separator' },
      tool('Thumbnail Check', 'thumbcheck'),
      { label: 'YouTube Studio', click: () => openTab({ url: 'https://studio.youtube.com' }) },
      { label: 'YouTube Comments', click: () => openTab({ url: 'https://studio.youtube.com/channel/UC/comments/inbox' }) },
    ] : []),
    ...(kit('business') ? [{ type: 'separator' }, tool('Bills and Alerts', 'bills')] : []),
  ];
}

function cycle(d) {
  const o = spaceOrder(); const i = o.findIndex((t) => t.id === activeId);
  const n = o[(i + d + o.length) % o.length]; if (n) activate(n.id);
}

// ---------------------------------------------------------------- sleep
// A call, a tab being recorded and a half-typed form are all lost if the tab goes to sleep.
function mustStayAwake(t) { return t.holdAwake || t.dirty || t.id === recTabId; }
setInterval(() => {
  const mins = settings && store ? settings().sleepMinutes : 30;
  const cutoff = Date.now() - mins * 60000;
  const visible = new Set(panes.map((p) => p.id));
  for (const t of tabs) {
    if (!t.view || t.host !== 'main' || visible.has(t.id) || t.id === activeId) continue;
    if (t.audible || t.playing || t.lastActive > cutoff || mustStayAwake(t)) continue;
    if (t.videoAt > Date.now() - KEEP_PAUSED) continue; // waking a tab starts its video again from the top
    destroyView(t);
  }
  if (store) { try { sweepTemp(); } catch (e) { logProblem('temp', e); } }
  pushState();
}, 60000);

setInterval(() => { if (store) { archiveOldTabs(); checkBills(); tidyInstallers(); loadRepos(); trimCaches(); } }, 3600000);
// Folders with a passcode lock again after a spell of not being used (settings().lockMinutes).
setInterval(() => { if (store && mainWin) { try { lockSweep(); } catch (e) { logProblem('lock', e); } } }, 30000);

// ---------------------------------------------------------------- start
async function setupBlocker() {
  app.configureHostResolver({ secureDnsMode: 'automatic' }); // private lookups wherever the network's provider offers them
  shield = createShield({ dir: app.getPath('userData'), log: (e) => logAgent(e) });
  await shield.start({
    sessions: settings().blockAds === false ? [] : [...sessionsReady],
    allowSites: settings().adsAllowed || [],
    presetSites: presets.field('adblockHosts', []),
    // The number on the shield is the only proof you ever get that any of this
    // is running, so it reaches the window as the requests are stopped.
    onCount: (wcId, n) => {
      const t = tabs.find((x) => x.view && !x.view.webContents.isDestroyed() && x.view.webContents.id === wcId);
      if (t) sendEvent('blocked', { id: t.id, n });
    },
  });
  pushState();
}

// One bad page or a failed background job must never bring the whole browser down.
function logProblem(kind, e) {
  const line = `${new Date().toISOString()} ${kind} ${e && e.stack ? e.stack : e}\n`;
  console.error(line);
  try {
    const f = path.join(app.getPath('userData'), 'problems.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 1048576) fs.rmSync(f);
    fs.appendFileSync(f, line, { mode: 0o600 });
  } catch {}
}
process.on('uncaughtException', (e) => logProblem('uncaught', e));
process.on('unhandledRejection', (e) => logProblem('rejected', e));
app.on('child-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') logProblem('process', `${d.type} ${d.reason}`); });

// A window saved on a screen that is no longer plugged in comes back on one that is.
function onScreen(saved) {
  const b = saved || { width: 1440, height: 900 };
  if (b.x === undefined || b.y === undefined) return b;
  try {
    const { screen } = require('electron');
    const seen = screen.getAllDisplays().some(({ workArea: w }) =>
      Math.min(b.x + b.width, w.x + w.width) - Math.max(b.x, w.x) >= 120 && Math.min(b.y + b.height, w.y + w.height) - Math.max(b.y, w.y) >= 80);
    if (seen) return b;
    const w = screen.getPrimaryDisplay().workArea;
    const width = Math.min(b.width, w.width); const height = Math.min(b.height, w.height);
    return { x: w.x + Math.round((w.width - width) / 2), y: w.y + Math.round((w.height - height) / 2), width, height };
  } catch { return { width: b.width, height: b.height }; }
}
function createMain() {
  const b = onScreen(store.data.bounds);
  mainWin = new BaseWindow({
    ...b, minWidth: 760, minHeight: 480, title: 'Cue', backgroundColor: '#E3E6E9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', trafficLightPosition: { x: 16, y: 18 },
  });
  uiView = new WebContentsView({ webPreferences: { preload: UI_PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  // Cue's own chrome must never be throttled. When the window sat behind
  // another app, Chromium slowed this renderer down and starting a recording
  // could stall indefinitely — which is exactly when you are recording a tab
  // and looking at something else.
  uiView.webContents.setBackgroundThrottling(false);
  uiView.setBackgroundColor('#00000000');
  mainWin.contentView.addChildView(uiView);
  uiView.webContents.loadFile(UI_HTML);
  uiView.webContents.on('did-finish-load', () => {
    sendState();
    if (isLocked(openFolder())) askUnlock(openFolder()); // nothing open but locked folders
    // You were never asked and never waited, so this is the only time the
    // update is mentioned at all: once, after it has already happened.
    const was = store.data.lastVersion;
    if (was && was !== app.getVersion()) sendEvent('toast', `Cue updated itself to ${app.getVersion()}.`);
    const moved = settledMessage(); if (moved) sendEvent('toast', moved);
    store.data.lastVersion = app.getVersion(); store.save();
    // A brand-new install says hello once, in the sidebar. Never in a test unless it asks.
    if (store.data.welcome === 'pending' && !process.env.CUE_TEST && !process.env.CUE_SMOKE && !isLocked(openFolder())) sendEvent('welcome', welcomeData());
    if (process.env.CUE_SMOKE) { console.log('CUE_SMOKE_OK'); app.quit(); }
  });
  mainWin.on('resize', () => { layout(); if (!mainWin.isFullScreen() && !mainWin.isSimpleFullScreen()) { store.data.bounds = mainWin.getBounds(); store.save(); } });
  mainWin.on('enter-full-screen', () => { const t = byId(activeId); if (t && t.fullscreen) settleAfterFullScreen(t, true); });
  mainWin.on('move', () => { if (!mainWin.isFullScreen() && !mainWin.isSimpleFullScreen()) { store.data.bounds = mainWin.getBounds(); store.save(); } });
  // Leaving full screen by the green button, Escape or a Mac swipe tells the WINDOW
  // but never told the PAGE, so the video stayed in its full-screen layout inside a
  // normal window - controls off the bottom, the picture the wrong shape. The Vanish
  // window has always done this; the main one had not. Now both let the page know.
  mainWin.on('leave-full-screen', () => {
    const t = byId(activeId);
    if (!t || !t.fullscreen) return;
    t.fullscreen = false; layout(); pushState();
    if (t.view && !t.view.webContents.isDestroyed()) {
      t.view.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
    }
    settleAfterFullScreen(t);
  });
  mainWin.on('closed', () => { mainWin = null; if (stageWin && !stageWin.isDestroyed()) stageWin.destroy(); app.quit(); });

  const saved = store.data.tabs || [];
  // A tab of a folder that is no longer there is dropped. It used to be shown in whatever folder
  // was open, which put one person's page in somebody else's folder.
  // "Just for now" tabs come back only when they are saved by the hours setting, and only until
  // their time is up. With "when Cue closes" they were never written, and a stray one is dropped.
  const tempCut = tempHours() ? Date.now() - tempHours() * 3600000 : Infinity;
  for (const s of saved) if (isFolder(s.identity) && !(s.temp && (s.tempAt || 0) <= tempCut)) tabs.push(makeTab(s));
  // Deliberately NOT merged at launch. Closing his tabs for him, unasked, is
  // the kind of help nobody wants: the rule in openTab stops new copies being
  // made, and the button in Settings tidies the old ones when he says so.
  // The cue survives a restart: the tabs he lined up for a class are still
  // lined up tomorrow morning.
  cueIds = (store.data.cue || []).map((u) => (tabs.find((t) => t.uid === u) || {}).id).filter(Boolean);
  cueNextId = cueIds[0] || null;
  seedEveryday();
  // Every passcode folder is locked at launch. Stand in one that is not, if there is one.
  if (isLocked(openFolder())) {
    const open = userFolders().find((f) => !isLocked(f.id));
    if (open) store.data.folder = open.id;
  }
  const usable = () => tabs.filter((t) => !isLocked(t.identity));
  if (!usable().some((t) => t.identity === openFolder()) && !isLocked(openFolder())) tabs.push(makeTab({ url: START_URL, identity: openFolder() }));
  // Where Cue lands when you open it. "The app I start in" puts you in the
  // folder's own WhatsApp (your own in Personal, the school's in School) rather
  // than wherever you happened to stop last night. Anything else, and it is the
  // tab you were last on, as before.
  const list = usable();
  if (!list.length) { askUnlock(openFolder()); return; } // every folder is locked: the sheet asks first
  let first = tabs[Math.max(0, Math.min(store.data.activeIndex || 0, tabs.length - 1))];
  if (!first || isLocked(first.identity) || first.identity !== openFolder()) first = list.filter((t) => t.identity === openFolder()).sort((a, b) => b.lastActive - a.lastActive)[0] || list[0];
  if (settings().openOn === 'home') {
    const who = openFolder();
    const want = hostOf(settings().homeApp || '');
    const mine = list.filter((t) => t.identity === who && t.id !== programId);
    const home = want && mine.find((t) => hostOf(t.url) === want);
    first = home || mine.sort((a, b) => b.lastActive - a.lastActive)[0] || first;
  }
  const current = (sp) => ({ ...sp, uids: undefined, ids: (sp.uids || []).map((u) => tabs.find((t) => t.uid === u && !isLocked(t.identity))?.id).filter(Boolean) });
  store.data.spaceSplit = Object.fromEntries(Object.entries(store.data.savedSpaceSplit || {}).map(([k, v]) => [k, current(v)]));
  store.data.split = fitSplit(current(store.data.savedSplit || { mode: 'single' }));
  // The split you were in comes back even when the tab Cue opens on is not part of it: Cue opens
  // on the split instead (the tab in it you used last), so the layout is never quietly dropped.
  if (store.data.split.mode !== 'single' && store.data.split.ids.length >= 2) {
    if (!store.data.split.ids.includes(first.id)) {
      const inSplit = store.data.split.ids.map(byId).filter(Boolean).sort((a, b) => (b.identity === openFolder()) - (a.identity === openFolder()) || b.lastActive - a.lastActive);
      if (inSplit[0]) first = inSplit[0];
    }
  } else if (!store.data.split.ids.includes(first.id)) store.data.split = { mode: 'single', ids: [] };
  store.data.split.ids.forEach((id) => ensureView(byId(id)));
  activate(first.id);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', (_e, argv) => {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.focus();
  const url = argv.find((x) => /^https?:\/\//.test(x)); if (url) openFromApp(url);
});
let pendingUrls = [];
// A link or file sent to Cue from another app (Mail, Slack, a PDF). Settings can start links in "Just for now". If the folder it would open in is locked, it waits
// for the passcode and opens the moment the folder is unlocked, rather than being lost.
let lockedPending = [];
function openFromApp(url, { file = false } = {}) {
  if (!file && !/^https?:\/\//i.test(String(url || ''))) return null;
  const item = { url, temp: !file && settings().linksJustForNow === true };
  const who = folderForNewTab();
  if (isLocked(who)) { lockedPending.push(item); if (mainWin) askUnlock(who); return null; }
  try { return openTab(item); } catch (e) { logProblem('open-link', e); return null; }
}
function openWaitingLinks(id) {
  if (!lockedPending.length || isLocked(id) || folderForNewTab() !== id) return;
  for (const item of lockedPending.splice(0)) { try { openTab({ ...item, identity: id }); } catch (e) { logProblem('open-link', e); } }
}
app.on('open-url', (e, url) => { e.preventDefault(); if (mainWin) openFromApp(url); else pendingUrls.push(url); });
app.on('open-file', (e, file) => { e.preventDefault(); const url = pathToFileURL(file).href; if (mainWin) openFromApp(url, { file: true }); else pendingUrls.push(url); });

// Protected video (Netflix, Prime Video, JioHotstar, Disney+, Spotify) needs
// Widevine, which stock Electron does not ship. Cue is built on castLabs'
// Electron, which fetches the player component on first run - so wait for it
// before any window opens, or the first show of the session fails even though
// every later one works. It is a download the first time and instant after.
// Wrapped so Cue still starts on a plain Electron, where there is no such API.
async function widevineReady() {
  let components;
  try { ({ components } = require('electron')); } catch { return; }
  if (!components || typeof components.whenReady !== 'function') return;
  try {
    await components.whenReady();
    drmReady = true;
  } catch (e) {
    drmLog = String((e && e.message) || e).slice(0, 200);
  }
}

// ---------------------------------------------------------------- the owner's world, frozen
// Up to 0.6.18 a lot of Cue's behaviour came from defaults in the code that were his: four Spaces
// named for his work, number keys to the school's apps, WhatsApp/Gmail/Instagram/Facebook kept in
// the strip, every kit on, WhatsApp silent, the AI door listening, bills in rupees. From 0.7 a new
// install is plain. So an install that has run before gets every one of those values WRITTEN into
// its cue.json, once ('legacy-freeze-0.7' in MIGRATIONS), before any default changes under it, and
// the school's starting setup switched on - after which it looks and behaves exactly as 0.6.18 did.
// `raw` is cue.json exactly as it was read, so a value that was only ever a code default is told
// apart from one he saved. `overwrite` (tests only) writes the old values over whatever is there.
function legacyWorld() {
  const p = presets.load('nsm') || {};
  return {
    spaces: [...(p.spaces || [])], spaceLogins: { ...(p.spaceLogins || {}) }, quickKeys: (p.quickKeys || PLAIN_KEYS).map((q) => ({ ...q })),
    kits: { teacher: true, music: true, creator: true, designer: true, video: true, business: true },
    everyday: [...(p.pinned || [])], alwaysPinned: [...(p.alwaysPinned || [])],
    openOn: 'home', homeApp: 'https://web.whatsapp.com/', muteSites: ['web.whatsapp.com'], quietSites: ['web.whatsapp.com'],
    agentPort: true, agentSites: { whatsapp: true, gmail: true },
    aiWhich: 'claudecode', currency: 'INR', usdToInr: 88, space: p.startSpace || 'Teach', folder: p.startFolder || 'school',
  };
}
function freezeLegacy(data, raw = {}, { overwrite = false } = {}) {
  const L = legacyWorld();
  const rs = (!overwrite && raw && raw.settings) || {};
  const s = data.settings = data.settings || {};
  const missing = (k) => overwrite || rs[k] === undefined;
  // Spaces, the Space and folder that were open, the AI panel, the money.
  if (overwrite || !Array.isArray(raw.spaces)) data.spaces = [...L.spaces];
  for (const k of ['space', 'folder', 'aiWhich', 'currency', 'usdToInr']) if (overwrite || raw[k] === undefined) data[k] = L[k];
  // Settings that were code defaults.
  s.spaceLogins = { ...L.spaceLogins, ...(overwrite ? {} : rs.spaceLogins || {}) };
  s.kits = { ...L.kits, ...(overwrite ? {} : rs.kits || {}) };
  for (const k of ['everyday', 'alwaysPinned', 'openOn', 'homeApp', 'muteSites', 'quietSites', 'agentPort', 'agentSites']) if (missing(k)) s[k] = structuredClone(L[k]);
  // The nine, resolved the way 0.6.18 resolved them, so an empty name keeps showing the old one.
  const mat = (list) => L.quickKeys.map((d, i) => { const x = list[i] || {}; return { key: d.key, name: String(x.name || d.name), url: typeof x.url === 'string' ? x.url : d.url }; });
  const nine = (list) => (Array.isArray(list) && list.length === 9 ? mat(list) : L.quickKeys.map((q) => ({ ...q })));
  const q = overwrite ? undefined : rs.quickKeys;
  if (q && typeof q === 'object' && !Array.isArray(q)) {
    s.quickKeys = Object.fromEntries(Object.entries(q).map(([f, list]) => [f, nine(list)]));
    for (const f of ['personal', 'school']) if (!s.quickKeys[f]) s.quickKeys[f] = nine(null);
  } else s.quickKeys = nine(q);
  // 0.6.18 put the four in both of his folders on every launch.
  const ep = (!overwrite && raw.everydayPinned && typeof raw.everydayPinned === 'object') ? { ...raw.everydayPinned } : {};
  for (const f of ['personal', 'school']) if (ep[f] === undefined) ep[f] = [];
  data.everydayPinned = ep;
  s.preset = 'nsm';
  return s;
}

// ---------------------------------------------------------------- money
// The bills reader works in the person's own money: the currency of the country the computer is
// set to, and how many of it one US dollar buys (US prices are converted at that rate). The rates
// are only a starting point, changed on the Bills page.
const EURO = ['AT', 'BE', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES'];
const COUNTRY_MONEY = { IN: 'INR', US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', SG: 'SGD', AE: 'AED', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', ZA: 'ZAR', BR: 'BRL', MX: 'MXN', CN: 'CNY', HK: 'HKD', KR: 'KRW', LK: 'LKR', PK: 'PKR', BD: 'BDT', NP: 'NPR', MY: 'MYR', ID: 'IDR', PH: 'PHP', TH: 'THB', SA: 'SAR', IL: 'ILS', TR: 'TRY', PL: 'PLN', ...Object.fromEntries(EURO.map((c) => [c, 'EUR'])) };
const USD_RATE = { USD: 1, INR: 88, EUR: 0.86, GBP: 0.76, CAD: 1.4, AUD: 1.53, NZD: 1.75, JPY: 154, SGD: 1.3, AED: 3.67, CHF: 0.8, SEK: 9.5, NOK: 10.1, DKK: 6.4, ZAR: 17.3, BRL: 5.3, MXN: 18.4, CNY: 7.1, HKD: 7.8, KRW: 1450, LKR: 300, PKR: 281, BDT: 122, NPR: 141, MYR: 4.15, IDR: 16600, PHP: 58.5, THB: 32.5, SAR: 3.75, ILS: 3.25, TRY: 42, PLN: 3.65 };
function localMoney() {
  let cc = '';
  try { cc = String(app.getLocaleCountryCode() || '').toUpperCase(); } catch {}
  const code = COUNTRY_MONEY[cc] || 'USD';
  return { code, rate: USD_RATE[code] || 1 };
}

// ---------------------------------------------------------------- starting setups
// A preset (presets.js) is switched on or off from Settings, or chosen on the first-run sheet. It
// never touches sign-ins, tabs or folders. Switching one on: its Spaces join yours (an empty plain
// Home makes way), its number keys fill any folder whose saved keys are still the plain ones, every
// kit comes on, its apps stay in the strip, and the money is its currency. What it changed is kept
// in settings().presetUndo, so going back to plain puts exactly that back and leaves alone anything
// changed since. With no presetUndo (an upgraded install, frozen above) going back to plain only
// takes the organisation's own things away: its apps, tiles, trusted sites and group.
const sameKey = (a, b) => !!a && !!b && String(a.name || '') === String(b.name || '') && String(a.url || '') === String(b.url || '');
function applyPreset(id, { firstRun = false } = {}) {
  const p = presets.load(id);
  if (!p) return { error: 'Cue does not have that setup.' };
  const s = settings();
  if (s.preset === id) return { ok: true, already: true };
  if (s.preset) removePreset();
  const undo = { spaces: Array.isArray(store.data.spaces) ? [...store.data.spaces] : null, space: store.data.space, addedSpaces: [], addedLogins: [], kits: { ...s.kits }, addedPinned: [], currency: store.data.currency, usdToInr: store.data.usdToInr, keysSet: [], autoIds: [] };
  // Spaces: yours first (an empty plain Home makes way), then the preset's. On the first-run sheet
  // there is nothing of yours yet, so the preset's are the list and the first tab moves into it.
  const held = (n) => tabs.some((t) => t.space === n);
  const list = firstRun ? [] : spaces().filter((n) => !(SPACES_DEFAULT.includes(n) && !held(n)));
  for (const n of p.spaces || []) if (!list.includes(n)) { list.push(n); if (!spaces().includes(n)) undo.addedSpaces.push(n); }
  if (firstRun) for (const t of tabs) if (!list.includes(t.space)) t.space = list[0];
  store.data.spaces = list.slice(0, SPACES_MAX);
  if (!spaces().includes(store.data.space)) store.data.space = spaces().includes(p.startSpace) ? p.startSpace : spaces()[0];
  s.spaceLogins = s.spaceLogins || {};
  for (const [sp, f] of Object.entries(p.spaceLogins || {})) if (isPerson(f) && !s.spaceLogins[sp]) { s.spaceLogins[sp] = f; undo.addedLogins.push(sp); }
  // Number keys: a folder whose saved nine are still the plain ones takes the preset's. (Unsaved
  // ones follow the preset by themselves.)
  if (s.quickKeys && Array.isArray(p.quickKeys)) {
    const box = Array.isArray(s.quickKeys) ? Object.fromEntries(allFolders().map((f) => [f, s.quickKeys])) : { ...s.quickKeys };
    for (const [f, nine] of Object.entries(box)) {
      if (Array.isArray(nine) && nine.every((q, i) => sameKey(q, PLAIN_KEYS[i]) || quickEmpty(q))) { box[f] = p.quickKeys.map((q) => ({ ...q })); undo.keysSet.push(f); }
    }
    s.quickKeys = box;
  }
  s.kits = { ...s.kits, ...(p.kits || {}) };
  s.alwaysPinned = Array.isArray(s.alwaysPinned) ? s.alwaysPinned : [];
  for (const h of p.alwaysPinned || []) if (!s.alwaysPinned.includes(h)) { s.alwaysPinned.push(h); undo.addedPinned.push(h); }
  if (p.currency) { store.data.currency = p.currency; if (p.usdRate) store.data.usdToInr = p.usdRate; }
  s.preset = id;
  s.presetUndo = undo;
  undo.autoIds = vault ? vault.autoForOwnSites() : [];
  presetChanged();
  return { ok: true };
}
function removePreset() {
  const s = settings();
  const p = presets.active();
  const u = s.presetUndo || null;
  if (!s.preset) return { ok: true, already: true };
  // Off first, so everything below reads the plain defaults (spaces() falls back to them).
  delete s.preset; delete s.presetUndo;
  if (u) {
    const held = (n) => tabs.some((t) => t.space === n);
    const list = spaces().filter((n) => !((u.addedSpaces || []).includes(n) && !held(n)));
    if (!list.length || (u.spaces === null && list.length === 1 && SPACES_DEFAULT.includes(list[0]))) delete store.data.spaces;
    else store.data.spaces = list;
    if (!spaces().includes(store.data.space)) store.data.space = spaces().includes(u.space) ? u.space : spaces()[0];
    for (const sp of u.addedLogins || []) if (s.spaceLogins && !spaces().includes(sp)) delete s.spaceLogins[sp];
    for (const [k, was] of Object.entries(u.kits || {})) if (s.kits[k] === true && was === false) s.kits[k] = false;
    s.alwaysPinned = (s.alwaysPinned || []).filter((h) => !(u.addedPinned || []).includes(h));
    if (p && store.data.currency === p.currency && u.currency) { store.data.currency = u.currency; store.data.usdToInr = u.usdToInr; }
    if (p && s.quickKeys && Array.isArray(p.quickKeys)) {
      const fix = (nine) => (Array.isArray(nine) ? nine.map((q, i) => (sameKey(q, p.quickKeys[i]) ? { ...PLAIN_KEYS[i] } : q)) : nine);
      s.quickKeys = Array.isArray(s.quickKeys) ? fix(s.quickKeys) : Object.fromEntries(Object.entries(s.quickKeys).map(([f, nine]) => [f, fix(nine)]));
    }
    if (vault) for (const id of u.autoIds || []) vault.setAuto(id, false);
  }
  presetChanged();
  return { ok: true };
}
// Everything that reads the preset live, told it changed.
function presetChanged() {
  if (shield) shield.setPresetHosts(presets.field('adblockHosts', []));
  buildMenu(); store.save(); persist(); layout(); pushState();
  for (const t of tabs) if (t.view && !t.view.webContents.isDestroyed() && isStart(t.view.webContents.getURL())) t.view.webContents.reload();
}
// The preset's own tiles on the start page, put in by main so start.html itself names nobody.
function dressStartPage(wc) {
  const st = presets.field('startTiles', null);
  if (!st || wc.isDestroyed()) return;
  const code = `(() => {
    const st = ${JSON.stringify(st)};
    if (document.getElementById('preset-tiles')) return;
    const main = document.querySelector('main'); if (!main) return;
    for (const [from, to] of Object.entries(st.replace || {})) {
      const a = [...document.querySelectorAll('.tiles a')].find((x) => x.getAttribute('href') === from);
      if (a) { a.setAttribute('href', to.href); const sp = a.querySelector('span'); if (sp && to.note) sp.textContent = to.note; }
    }
    const h = document.createElement('h2'); h.textContent = st.heading || ''; h.id = 'preset-tiles';
    const box = document.createElement('div'); box.className = 'tiles';
    for (const t of st.tiles || []) {
      const a = document.createElement('a'); a.href = t.href;
      if (t.logo) { const i = document.createElement('img'); i.src = '../../assets/logos/' + t.logo; i.alt = ''; a.append(i); } else a.className = 'nologo';
      const b = document.createElement('b'); b.textContent = t.name; const s = document.createElement('span'); s.textContent = t.note || '';
      a.append(b, s); box.append(a);
    }
    main.append(h, box);
  })()`;
  wc.executeJavaScript(code, true).catch(() => {});
}

// ---------------------------------------------------------------- the first-run sheet
// A brand-new install asks three small things in the sidebar (never a system dialog, and it can be
// skipped): what to call the first folder, which everyday sites to pin, and which starting setup.
const WELCOME_SITES = [
  { name: 'WhatsApp', url: 'https://web.whatsapp.com/' }, { name: 'Gmail', url: 'https://mail.google.com/' },
  { name: 'Google Calendar', url: 'https://calendar.google.com/' }, { name: 'Google Drive', url: 'https://drive.google.com/' },
  { name: 'YouTube', url: 'https://www.youtube.com/' }, { name: 'Instagram', url: 'https://www.instagram.com/' },
  { name: 'Facebook', url: 'https://www.facebook.com/' }, { name: 'X', url: 'https://x.com/' },
  { name: 'LinkedIn', url: 'https://www.linkedin.com/' }, { name: 'ChatGPT', url: 'https://chatgpt.com/' }, { name: 'Claude', url: 'https://claude.ai/' },
];
function welcomeData() {
  const f = userFolders()[0] || {};
  return {
    name: f.name || '', color: f.color || NEUTRAL, colors: FOLDER_COLORS, sites: WELCOME_SITES,
    setups: presets.available().map((x) => ({ ...x, pinned: (presets.load(x.id) || {}).pinned || [], school: !!(presets.load(x.id) || {}).schoolFolder })),
  };
}
function finishWelcome({ name, color, sites, preset, school } = {}) {
  if (store.data.welcome !== 'pending') return { ok: true, already: true };
  const f = userFolders()[0];
  if (f) {
    const nm = cleanName(name);
    if (nm && nm !== f.name) { const r = renameFolder({ id: f.id, name: nm }); if (r.error) return r; }
    if (/^#[0-9a-f]{6}$/i.test(String(color || ''))) f.color = color;
    f.picture = ''; // a coloured initial; nobody's photo
  }
  store.data.welcome = 'done';
  const p = preset ? presets.load(preset) : null;
  if (p) {
    const sf = p.schoolFolder;
    if (school && sf && !folderById(sf.id)) {
      const r = addFolder({ name: sf.name, color: sf.color, id: sf.id });
      if (r.ok) Object.assign(r.folder, { picture: sf.picture || '', about: sf.about || '' });
    }
    applyPreset(preset, { firstRun: true });
  }
  const want = new Set((Array.isArray(sites) ? sites : []).map(String));
  const urls = WELCOME_SITES.map((x) => x.url).concat(p ? (p.pinned || []) : []).filter((u, i, a) => want.has(u) && a.indexOf(u) === i);
  if (f && urls.length) {
    settings().everyday = urls;
    store.data.everydayPinned = { ...(store.data.everydayPinned || {}), [f.id]: [] };
    seedEveryday();
  }
  store.save(); persist(); layout(); pushState();
  return { ok: true };
}

// One-time changes to an existing profile, each done once and remembered by name in
// store.data.migrated, so turning a setting back on afterwards sticks. Each step is handed the
// settings, the whole saved data, and cue.json as it was read (store.raw).
const MIGRATIONS = {
  // Before any 0.7 default changes, an existing install keeps 0.6.18's world (freezeLegacy above).
  // A brand-new install has nothing to keep; it is marked done so it never runs later.
  'legacy-freeze-0.7': (_s, data, raw) => { if (!store.fresh) freezeLegacy(data, raw); },
  // Before 0.7 one video at a time was on for everyone. Other browsers never pause one tab for
  // another, so it goes off once; Settings > Tabs and sound turns it back on.
  'onePlayer-off-0.7': (s) => { s.onePlayer = false; },
  // Ordinary tabs are kept until the person closes them; only "Just for now" tabs are cleared.
  // Before 0.7 tabs unused for two days were put away into Library > Archived (a saved 7 was
  // even forced down to 2), which is the opposite. Settings > Keeping tabs turns it back on.
  'archive-off-0.7': (s) => { s.archiveDays = 0; },
};
function runMigrations() {
  const done = store.data.migrated && typeof store.data.migrated === 'object' ? store.data.migrated : {};
  let changed = false;
  for (const [name, step] of Object.entries(MIGRATIONS)) {
    if (done[name]) continue;
    step(store.data.settings, store.data, store.raw || {});
    done[name] = true; changed = true;
  }
  store.data.migrated = done;
  if (changed) store.save();
  return done;
}

app.whenReady().then(async () => {
  if (!gotLock) return; // a second copy only hands its link to the first and goes
  // Windows and Linux: the first run from an unzipped folder copies Cue to its
  // own per-user home and opens it again from there (src/main/settle.js).
  const settled = await settle({ app, shell, log: (e) => console.error('settle', (e && e.message) || e) });
  if (settled.relaunch) { app.relaunch(settled.relaunch); app.exit(0); return; }
  await widevineReady();
  // The defaults are a plain browser's. An install that has run before keeps 0.6.18's own world:
  // runMigrations() writes it into cue.json ('legacy-freeze-0.7') BEFORE these defaults fill
  // anything in, so none of them ever reaches it.
  store = new Store(app.getPath('userData'), 'cue.json', {
    tabs: [], activeIndex: 0, bounds: null, split: { mode: 'single', ids: [] }, savedSplit: null, savedSpaceSplit: {}, collapsed: {}, permissions: {},
    space: SPACES_DEFAULT[0], spaceSplit: {}, folder: 'personal', whose: {}, aiWhich: 'claudecode', bills: [], alerts: [], archived: [], installersOpened: [],
    settings: {
      autoGroup: true, onePlayer: false, syncScroll: false, originalSound: false, safeShare: true,
      stageWidth: 1920, stageHeight: 1080, obs: { host: '127.0.0.1', port: 4455, password: '' },
      defaultIdentity: 'personal', identityLabels: { personal: '', school: '', agent: '' }, sleepMinutes: 15,
    },
  });
  presets.configure(() => (store && store.data.settings ? store.data.settings.preset : null));
  if (store.fresh) {
    // Nothing to repair on a brand-new install, and the one-off repairs below would otherwise put
    // the owner's WhatsApp lists back in. The first-run sheet asks the rest.
    Object.assign(store.data, { financeNamed: true, tidyDefaults: true, quietDefaults: true, stripDefaults: true, groupsRepaired: true, welcome: 'pending' });
  }
  runMigrations();
  store.data.settings = { ...{ sideWidth: 248, sideHidden: false, aiWidth: 440, autoGroup: true, onePlayer: false, syncScroll: false, syncPlay: false, originalSound: false, safeShare: true, stageWidth: 1920, stageHeight: 1080, defaultIdentity: 'personal', agentPort: false, sleepMinutes: 15, archiveDays: 0, tempClear: 'quit', linksJustForNow: false, cacheCapMB: 1024, lowDiskGB: 5, tidyInstallers: true, githubUser: '', blockAds: true, warnDangerous: true, httpsFirst: true, hideRealIP: true, autoUpdate: true, adsAllowed: [], newTabPlace: 'next', videoSwitch: 'both', vanishOnePlayer: false, vanishNewTab: 'go', vanishNewTabPlace: 'next', vanishPauseOnBlur: false, vanishHideFromCapture: true, vanishFullScreen: false, showDownloads: true, quietSites: [], muteSites: [], openOn: 'last', homeApp: '', agentSites: { whatsapp: false, gmail: false }, alwaysPinned: [], everyday: [] }, ...store.data.settings };
  if (!Array.isArray(store.data.settings.adsAllowed)) store.data.settings.adsAllowed = [];
  // Teacher (on air, OBS) and Business (bills) are one person's tools; a plain install starts
  // without them, and they are one switch away in Settings > What you see.
  store.data.settings.kits = { teacher: false, music: true, creator: true, designer: true, video: true, business: false, ...(store.data.settings.kits || {}) };
  store.data.settings.spaceLogins = { ...(store.data.settings.spaceLogins || {}) };
  if (!store.data.currency) { const m = localMoney(); store.data.currency = m.code; if (!(Number(store.data.usdToInr) > 0)) store.data.usdToInr = m.rate; }
  if (!(Number(store.data.usdToInr) > 0)) store.data.usdToInr = USD_RATE[store.data.currency] || 1;
  // The Space called Business is the money one, so it says Finance. Done once;
  // double-click it in the sidebar to call it anything else.
  if (!store.data.financeNamed) {
    store.data.financeNamed = true;
    const list = Array.isArray(store.data.spaces) ? [...store.data.spaces] : [...SPACES_DEFAULT];
    const i = list.indexOf('Business');
    if (i >= 0 && !list.includes('Finance')) {
      list[i] = 'Finance';
      store.data.spaces = list;
      for (const t of store.data.tabs || []) if (t.space === 'Business') t.space = 'Finance';
      for (const box of [store.data.savedSpaceSplit, store.data.collapsed, store.data.settings.spaceLogins]) {
        if (box && Object.prototype.hasOwnProperty.call(box, 'Business')) { box.Finance = box.Business; delete box.Business; }
      }
      if (store.data.space === 'Business') store.data.space = 'Finance';
    }
  }
  // Spaces are saved as { name, tint } from 0.7; an older plain list of names becomes that here,
  // each keeping the colour it already showed.
  if (Array.isArray(store.data.spaces) && store.data.spaces.some((x) => typeof x === 'string')) store.data.spaces = spaceList();
  // Existing profiles had no quiet list, so WhatsApp kept popping boxes up.
  if (!store.data.quietDefaults) {
    store.data.quietDefaults = true;
    const q = store.data.settings.quietSites;
    if (!Array.isArray(q) || !q.length) store.data.settings.quietSites = ['web.whatsapp.com'];
  }
  // Existing profiles: WhatsApp starts silent, and the four apps that live in
  // the strip are put there whether or not they were pinned before.
  if (!store.data.stripDefaults) {
    store.data.stripDefaults = true;
    const m = store.data.settings.muteSites;
    if (!Array.isArray(m) || !m.length) store.data.settings.muteSites = ['web.whatsapp.com'];
    for (const t of store.data.tabs || []) if (alwaysPinned(t.url)) t.pinned = true;
  }
  if (!store.data.groupsRepaired) {
    store.data.groupsRepaired = true;
    // Opening a link used to stamp the new tab with the group of whatever it
    // landed beside, so cricket scores sat under Nathaniel School and a bank
    // page under Social. Those stamps are wiped; a group you chose yourself
    // from the right-click menu is set again the same way, in one click.
    for (const t of store.data.tabs || []) delete t.groupOverride;
  }
  // The list of people's folders. An install that has run before, with no list saved yet, gets
  // the owner's two folders back exactly as they were - same names, colours, pictures, ids (so
  // the same partitions, sign-ins and tabs) - with sign-ins shared between them as before and
  // agents allowed in both. A brand-new install starts with one plain folder, private in every
  // way; naming it is a later step.
  if (!Array.isArray(store.data.folders) || !store.data.folders.length) {
    const labels = store.data.settings.identityLabels || {};
    if (store.fresh) {
      store.data.folders = [{ id: 'personal', name: 'Personal', color: NEUTRAL, picture: '', email: '', lock: null, agents: false }];
      if (!Array.isArray(store.data.settings.sharedPairs)) store.data.settings.sharedPairs = [];
    } else {
      store.data.folders = ['personal', 'school'].map((id) => ({ id, ...LEGACY_FOLDERS[id], email: String(labels[id] || ''), lock: null, agents: true }));
      if (!Array.isArray(store.data.settings.sharedPairs)) store.data.settings.sharedPairs = [['personal', 'school']];
    }
  }
  if (!Array.isArray(store.data.settings.sharedPairs)) store.data.settings.sharedPairs = [];
  if (store.data.settings.lockMinutes === undefined) store.data.settings.lockMinutes = 15;
  // Browsers that have been running since before folders existed have no folder
  // in the store. Open the one the tabs are actually in, not a guess.
  if (!isFolder(store.data.folder)) {
    const tally = {};
    for (const t of store.data.tabs || []) if (isFolder(t.identity)) tally[t.identity] = (tally[t.identity] || 0) + 1;
    store.data.folder = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] || usualFolderFor(store.data.space);
  }
  if (!store.data.whose || typeof store.data.whose !== 'object') store.data.whose = {};
  if (store.data.settings.cacheCapMB === 1024) store.data.settings.cacheCapMB = CACHE_MB;
  extDir = path.join(app.getPath('userData'), 'extensions');
  lib = new Library(app.getPath('userData'));
  vanish = createVanish({
    drm: () => drmReady,
    session: () => sessionFor('vanish'), preload: TAB_PRELOAD, uiPreload: path.join(ROOT, 'preload', 'vanish.js'),
    uiFile: path.join(ROOT, 'ui', 'vanish.html'), startFile: pathToFileURL(path.join(ROOT, 'ui', 'vanish-start.html')).href, resolveInput, guardUrl: (u) => guardUrl(u, vanishDangerOk), protect: protectPage, prefs: () => settings(),
    sounding: SOUNDING,
    onClosed: () => { vanishDangerOk.clear(); VANISH_NO_HTTPS.clear(); vanishLocationTold.clear(); },
    logo: (u) => pick(siteLogos(), String(hostOf(u) || '').toLowerCase()),
  });
  ipcMain.on('vanish:cmd', (e, c, a) => { const ui = vanish.ui(); if (!ui || e.sender !== ui.webContents) return; vanish.command(c, a); });
  vault = new Vault(app.getPath('userData'));
  vault.autoForOwnSites();
  store.data.settings.obs = { host: '127.0.0.1', port: 4455, password: '', ...(store.data.settings.obs || {}) };
  store.data.settings.identityLabels = { personal: '', school: '', agent: '', ...(store.data.settings.identityLabels || {}) };
  obs.onStatus = (st) => {
    pushState();
    // Reconnected mid-class: point it back at the Stage before anyone notices.
    if (st === 'connected') setTimeout(() => { obsAimAtStage().catch(() => {}); }, 300);
  };
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    const t = byId(recTabId);
    if (t && t.view) cb({ video: t.view.webContents.mainFrame, audio: t.view.webContents.mainFrame }); else cb({});
  });
  buildMenu();
  createMain();
  // One Gmail, one WhatsApp, one YouTube per folder, every launch, without him
  // having to ask for it. mergeDupes never closes a pinned tab. Only on the owner's install: anyone
  // else keeps every tab they left open, and can tidy copies from Settings when they want.
  // Some Linux systems (recent Ubuntu) stop Chromium's sandbox, and Cue then runs without it.
  // Say so once, plainly, rather than run with less protection than it looks like.
  if (process.platform === 'linux' && !process.env.CUE_TEST && (process.env.CUE_LINUX_UNSANDBOXED === '1' || app.commandLine.hasSwitch('no-sandbox')) && !store.data.toldNoSandbox) {
    setTimeout(() => {
      store.data.toldNoSandbox = true; store.save();
      dialog.showMessageBox(mainWin, { type: 'warning', buttons: ['OK'], message: 'This computer is running Cue with less protection.', detail: 'Your Linux system blocks the sandbox that keeps each website shut in its own box, so Cue started without it. Pages still work, but a harmful page has an easier way out. To fix it, allow Cue in AppArmor (search "AppArmor unprivileged user namespaces" for your Linux version), then open Cue again.' }).catch(() => {});
    }, 4000);
  }
  if (settings().preset === 'nsm') setTimeout(() => { try { if (mergeDupes()) { layout(); pushState(); persist(); } } catch (e) { logProblem('tidy', e); } }, 8000);
  setTimeout(() => { try { archiveOldTabs(); } catch (e) { logProblem('tidy', e); } }, 20000);
  checkBills(); tidyInstallers(); loadRepos(); setTimeout(() => trimCaches().catch((e) => logProblem('trim', e)), 60000);
  setInterval(() => trimCaches().catch((e) => logProblem('trim', e)), 30 * 60000); // caches are checked all day, not only at launch
  const launchLink = process.argv.slice(1).find((x) => /^https?:\/\//.test(x)); if (launchLink) pendingUrls.push(launchLink);
  try { pendingUrls.forEach((url) => openFromApp(url, { file: /^file:/i.test(url) })); } catch (e) { logProblem('launch-url', e); }
  pendingUrls = [];
  setupBlocker();
  startThumbs();
  // His switch, as he left it. When it is off the port still answers, so that an
  // AI tool that tries is told why in words and Cue can say so on screen - better
  // than a silence nobody can explain.
  doorOpen = settings().aiDoor === true;
  // A plain install has no AI door at all until the person switches AI tools on in Settings.
  if (settings().agentPort !== false) openAgentPort();
  updater = createUpdater({
    onState: () => pushState(),
    // A browser must never end a class. While a tab is on air, being recorded,
    // or a page is holding the camera, the update waits and says why.
    canInterrupt: () => {
      if (live || programId) return 'A tab is on air. The update will wait.';
      if (recTabId) return 'A tab is being recorded. The update will wait.';
      if (tabs.some((t) => t.holdAwake)) return 'A page is using your camera or microphone. The update will wait.';
      return '';
    },
    auto: () => settings().autoUpdate,
    // Tabs and every folder's cookies on disk before the swap closes Cue, so a sign-in made a
    // moment ago is still there when it opens again.
    beforeExit: async () => { saveNow(); await Promise.all([...sessionsReady].map((ses) => ses.cookies.flushStore().catch(() => {}))); },
    log: logAgent,
  });
  updater.start();
  // He rarely closes Cue, so "when you close it" could mean never: 0.7.0 sat waiting on the Mac
  // mini for a day. A ready update also goes in at a quiet moment - nobody has touched the
  // computer for twenty minutes, or the screen has been locked for ten - and Cue reopens on the
  // same tabs. Never while anything could be lost or interrupted: a tab on air or recording,
  // the camera in use, sound playing, a download running, a half-filled form, a Vanish window,
  // or "Just for now" tabs that are meant to go only when he closes Cue himself.
  setInterval(() => {
    const why = quietMomentRefusal();
    if (why) return;
    logAgent({ tool: 'update', note: `installing ${updater.state().latest} at a quiet moment` });
    saveNow();
    updater.install().catch((e) => logAgent({ tool: 'update', error: String(e && e.message) }));
  }, 5 * 60 * 1000).unref();
  // The new version goes in as Cue closes, when there is no window to disturb
  // and nothing to lose. Open Cue again and it is simply the new one.
  app.on('will-quit', () => {
    if (!updater || !updater.ready()) return;
    const v = updater.state().latest;
    if (updater.installOnQuit()) logAgent({ tool: 'update', note: `installed ${v} on quit` });
  });
  // Connect to OBS on its own. It used to wait for a button nobody knew was
  // there, so a class would start with Cue and OBS not talking. OBS being shut
  // costs one failed socket and nothing else.
  if (settings().obs.autoConnect !== false && settings().obs.host) obs.connect(settings().obs);
  // Sign-ins are shared only between the folders the person paired (settings().sharedPairs).
  wireSharing();
  sharedLogins = { syncNow: () => syncShared() };
  if (sharing.size) setTimeout(() => syncShared().catch(() => {}), 3000); // after the first pages, so start-up stays quick
  if (process.env.CUE_TEST) require(path.join(ROOT, '..', 'test', process.env.CUE_TEST === '1' ? 'in-app.js' : `${process.env.CUE_TEST}.js`))({ app, tabs, byId, openTab, activate, closeTab, setSplit, take, setLive, setVolume, setMuted, layout, captureTab, lib, vault, store, addAlert, checkBills, archiveOldTabs, switchSpace, openPeek, closePeek, toggleAI, askAI, runTool, internal, sendEvent, setSetting, suggestions, command: uiCommand, setFolder, moveToFolder, openFolder, rememberWhose, addToBoard, lensFile, bookmarkTab, newerVersion, sidebarOrder, loadTeamVault, agentApi, siteName: tabName, siteLogo, quickKeys, jumpTo, midiOk, sessionFor, persist, vanish, shield: () => shield, secureVersion, extensions, trimCaches, storageReport, resizeSplit, setSideHidden, setSideReveal, setOverlay, sharedLogins: () => sharedLogins, getPeek: () => peek, getAI: () => aiView, getState: () => ({ activeId, programId, live, panes, split: store.data.split }), win: () => mainWin, stage: () => stageWin, ui: () => uiView,
    // people's folders (test/people.js)
    addFolder, removeFolder, renameFolder, lockFolder, tryUnlock, setPasscode, lockSweep, isLocked, folderRows, userFolders, setShared, reopenClosed,
    lastState: () => lastState, sendState, closedStack, downloads, invoke: uiInvoke, internalAs: (cmd, a, from) => internal[cmd](a, from),
    // Vanish (test/vanish-settings.js)
    runMigrations, vanishMemory: () => ({ dangerOk: [...vanishDangerOk], noHttps: [...VANISH_NO_HTTPS] }),
    // Google sign-in and the Chrome carry (test/signin.js)
    signinGate: () => signinGate, chromeCarry: () => ({ canCarryFromChrome, chromeProfilesFor }),
    // Settings, Spaces and the two tiers of tabs (test/settings-tabs.js)
    spaceList, spaceCommand, setTemp, clearTemp, sweepTemp, tabMenuItems: (t) => tabMenuItems(t), openFromApp,
    // starting setups, the frozen owner's world and the first-run sheet (test/first-run.js, test/world.js)
    applyPreset, removePreset, presets, freezeLegacy, legacyFolders: () => structuredClone(LEGACY_FOLDERS), seedEveryday, buildMenu, wireSharing,
    welcomeData, finishWelcome, showWelcome: () => { store.data.welcome = 'pending'; sendEvent('welcome', welcomeData()); },
    midiAsks: () => [...midiAsks], portUp: () => portUp, agentPort: AGENT_PORT, startUrl: START_URL, spaces, alwaysPinned, credReady: (identity, origin) => { const c = vault.find(identity, origin); return c ? { handsFree: !!c.auto || Vault.ownSite(origin) } : null; },
    // Volume on the pinned apps (test/tile-volume.js): put a tab to sleep the way Cue does
    destroyView });
});

app.on('before-quit', () => { if (store) { persist(); store.flush(); } if (lib) lib.close(); });
app.on('window-all-closed', () => app.quit());
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
});
