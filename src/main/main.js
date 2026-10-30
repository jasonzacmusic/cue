// Cue — the browser for people who make things.
// Main process: windows, tabs, identities, split views, the on-air stage and the AI port.
const {
  app, BaseWindow, WebContentsView, session, ipcMain, Menu, shell, dialog, desktopCapturer, clipboard, protocol, net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { groupFor, GROUP_LIST } = require('./groups');
const { OBS } = require('./obs');
const { startAgentPort } = require('./agent-port');
const { Library } = require('./db');
const { Vault } = require('./vault');
const bills = require('./bills');
const tools = require('./page-tools');
const capture = require('./capture');
const importer = require('./importer');
const extensions = require('./extensions');
const NSM_APPS = require('./nsm-apps.json');

app.setName('Cue');
if (process.env.CUE_USER_DATA) app.setPath('userData', process.env.CUE_USER_DATA);
if (process.env.CUE_TEST) { app.commandLine.appendSwitch('use-mock-keychain'); app.setPath('downloads', path.join(app.getPath('userData'), 'downloads')); }
protocol.registerSchemesAsPrivileged([{ scheme: 'cue', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
// The cache cap has to be set before Chromium starts, so read it straight from the settings file.
try {
  const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'cue.json'), 'utf8'));
  app.commandLine.appendSwitch('disk-cache-size', String((saved.settings.cacheCapMB || 1024) * 1048576));
} catch { app.commandLine.appendSwitch('disk-cache-size', String(1024 * 1048576)); }
const ROOT = path.join(__dirname, '..');
const UI_HTML = path.join(ROOT, 'ui', 'index.html');
const STAGE_HTML = path.join(ROOT, 'ui', 'stage.html');
const START_URL = pathToFileURL(path.join(ROOT, 'ui', 'start.html')).href;
const TAB_PRELOAD = path.join(ROOT, 'preload', 'tab.js');
const UI_PRELOAD = path.join(ROOT, 'preload', 'ui.js');
const PAGES = path.join(ROOT, 'ui', 'pages');
const SIDEBAR = 264;
const TOOLBAR = 52;
const GAP = 6;
const AGENT_PORT = 8813;
const AI_W = 440;
const AI_HEAD = 38;
const STRIP = 44;
const SPACES = ['Teach', 'Create', 'Business', 'Build'];
const KITS = {
  teacher: { name: 'Teacher', what: 'On air, OBS and Safe-share' },
  music: { name: 'Music', what: 'Loop, transpose and speed for any video' },
  creator: { name: 'Creator', what: 'Thumbnail check, YouTube Studio and comments' },
  designer: { name: 'Designer', what: 'Colour picker, palettes, font finder, ruler, Boards' },
  video: { name: 'Video', what: 'Page capture, tab recording, GIFs, timestamps, frame grabs' },
  business: { name: 'Business', what: 'Bills radar and alert tray' },
};
const AI_HOME = { claude: 'https://claude.ai/new', chatgpt: 'https://chatgpt.com/' };
const COUNT_HOSTS = /(^|\.)(mail\.google\.com|instagram\.com|youtube\.com|whatsapp\.com|facebook\.com|linkedin\.com)$/;

const IDENTITIES = {
  personal: { name: 'Personal', color: '#2A64CC', partition: 'persist:personal' },
  school: { name: 'School', color: '#C2410C', partition: 'persist:school' },
  agent: { name: 'AI agent', color: '#5F40CF', partition: 'persist:agent' },
  vanish: { name: 'Vanish', color: '#8A939C', partition: 'vanish' }, // no "persist:" = memory only
};

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

function chromeUA() {
  const major = process.versions.chrome.split('.')[0];
  const os = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
app.userAgentFallback = chromeUA();

// ---------------------------------------------------------------- state
let store;
let mainWin = null;
let uiView = null;
let stageWin = null;
let stageStandby = null;
let blocker = null;
const obs = new OBS();
const tabs = [];
let activeId = null;
let programId = null;
let live = false;
let overlay = false;
let nextId = 1;
const closedStack = [];
const downloads = [];
const agentLog = [];
const sessionsReady = new Set();
let pendingShare = null;
let lib = null;
let vault = null;
let pendingCred = null;
const autoTried = {};
let peek = null;
let aiView = null;
let stripOpen = false;
let recTabId = null;
let heldCount = 0;
let repos = [];
let extDir = '';
const extsLoaded = new Set();

const settings = () => store.data.settings;
const copy = (text) => { if (!process.env.CUE_TEST) clipboard.writeText(text); };
const byId = (id) => tabs.find((t) => t.id === id);
const byWC = (wc) => tabs.find((t) => t.view && t.view.webContents === wc);
const isStart = (url) => !url || url === START_URL;

// ---------------------------------------------------------------- sessions
function sessionFor(identity) {
  const ses = session.fromPartition((IDENTITIES[identity] || IDENTITIES.personal).partition);
  if (sessionsReady.has(ses)) return ses;
  sessionsReady.add(ses);
  ses.setUserAgent(chromeUA());
  enableBlocker(ses);
  if (identity === 'vanish') ses.setSpellCheckerEnabled(false);
  servePages(ses);
  if (identity !== 'vanish') extensions.loadAll(ses, extDir).then((r) => r.forEach((x) => x.ok ? extsLoaded.add(x.id) : console.error('extension', x.name, x.error)));
  ses.webRequest.onErrorOccurred((d) => {
    if (d.error === 'net::ERR_BLOCKED_BY_CLIENT' || d.error === 'net::ERR_ABORTED' || !d.webContents) return;
    const t = byWC(d.webContents); if (t) logTab(t, 'failed-request', `${d.error} ${d.url}`);
  });

  ses.setPermissionRequestHandler(async (wc, permission, cb, details) => {
    const always = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'speaker-selection', 'midi', 'midiSysex', 'window-management'];
    if (always.includes(permission)) return cb(true);
    if (permission === 'notifications') return cb(!live);
    if (permission === 'media' || permission === 'geolocation') {
      const origin = safeOrigin(details.requestingUrl || wc.getURL());
      const key = `${identity}|${origin}|${permission}`;
      const remembered = store.data.permissions[key];
      if (remembered !== undefined) return cb(remembered);
      const what = permission === 'media' ? (details.mediaTypes || []).map((m) => (m === 'video' ? 'camera' : 'microphone')).join(' and ') || 'microphone' : 'location';
      const r = await dialog.showMessageBox(mainWin, {
        type: 'question', buttons: ['Allow', 'Block'], defaultId: 0, cancelId: 1,
        message: `${origin} wants to use your ${what}.`, checkboxLabel: 'Remember for this site', checkboxChecked: true,
      });
      const ok = r.response === 0;
      if (r.checkboxChecked) { store.data.permissions[key] = ok; store.save(); }
      return cb(ok);
    }
    cb(false);
  });

  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (pendingShare) pendingShare({});
    pendingShare = callback;
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .catch(() => [])
      .then((sources) => {
        setOverlay(true);
        sendEvent('share-picker', {
          tabs: tabs.filter((t) => t.view && !t.private).map((t) => ({ id: t.id, title: t.title, url: t.url })),
          sources: sources.map((s) => ({ id: s.id, name: s.name })),
        });
      });
  });

  ses.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads');
    let name = item.getFilename(); let file = path.join(dir, name); let n = 1;
    while (fs.existsSync(file)) { const ext = path.extname(name); file = path.join(dir, `${path.basename(name, ext)} (${n++})${ext}`); }
    // Vanish leaves no file behind unless you choose where it goes.
    if (identity === 'vanish') item.setSaveDialogOptions({ title: 'Vanish tab: save this file?', defaultPath: file });
    else item.setSavePath(file);
    const d = { id: Date.now() + Math.random(), name: path.basename(file), file, kind: fileKind(file), received: 0, total: item.getTotalBytes(), state: 'progressing' };
    downloads.unshift(d); downloads.length = Math.min(downloads.length, 30);
    item.on('updated', (_ev, state) => { d.received = item.getReceivedBytes(); d.state = state; pushState(); });
    item.once('done', (_ev, state) => {
      d.state = state; d.received = d.total;
      if (item.getSavePath()) { d.file = item.getSavePath(); d.name = path.basename(d.file); }
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
function servePages(ses) {
  if (ses.protocol.isProtocolHandled('cue')) return;
  ses.protocol.handle('cue', (req) => {
    const u = new URL(req.url);
    const rel = u.pathname.replace(/^\/+/, '') || `${u.hostname}.html`;
    const file = path.normalize(path.join(PAGES, rel));
    if (!file.startsWith(PAGES + path.sep) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
}

// The ad blocker registers one shared message handler; clear it before adding each new login's session.
function enableBlocker(ses) {
  if (!blocker || blocker.isBlockingEnabled(ses)) return;
  ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters');
  ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled');
  try { blocker.enableBlockingInSession(ses); } catch (e) { console.error('blocker', e.message); }
}

function safeOrigin(url) { try { return new URL(url).origin; } catch { return url; } }

// ---------------------------------------------------------------- tabs
function makeTab(opts) {
  const t = {
    id: nextId++, url: opts.url || START_URL, title: opts.title || 'New tab', favicon: opts.favicon || null,
    identity: IDENTITIES[opts.identity] ? opts.identity : (settings().spaceLogins[opts.space || store.data.space] || settings().defaultIdentity),
    pinned: !!opts.pinned, groupOverride: opts.groupOverride || null, volume: opts.volume ?? 1, muted: !!opts.muted,
    private: !!opts.private, obsScene: opts.obsScene || '', agent: !!opts.agent, aiAllowed: !!opts.aiAllowed,
    order: opts.order ?? Date.now(), playing: false, audible: false, loading: false, space: SPACES.includes(opts.space) ? opts.space : store.data.space,
    view: null, host: 'main', popout: null, lastActive: opts.lastActive || Date.now(), canBack: false, canFwd: false, zoom: opts.zoom || 0,
    badge: 0, marks: [], log: [],
  };
  return t;
}

function groupOf(t) {
  if (t.groupOverride) return t.groupOverride;
  if (!settings().autoGroup) return 'other';
  return groupFor(t.url);
}

function ensureView(t) {
  if (t.view) return t.view;
  const view = new WebContentsView({
    webPreferences: {
      session: sessionFor(t.identity), preload: TAB_PRELOAD, contextIsolation: true, sandbox: true,
      spellcheck: t.identity !== 'vanish', backgroundThrottling: true,
    },
  });
  view.setBackgroundColor('#FFFFFF');
  t.view = view; t.sleeping = false;
  wireTab(t);
  mainWin.contentView.addChildView(view);
  view.setVisible(false);
  view.setBounds(contentRect());
  if (overlay) mainWin.contentView.addChildView(uiView);
  view.webContents.loadURL(t.url).catch(() => {});
  if (t.zoom) view.webContents.setZoomLevel(t.zoom);
  return view;
}

function wireTab(t) {
  const wc = t.view.webContents;
  wc.setAudioMuted(t.muted);
  wc.on('page-title-updated', (_e, title) => {
    t.title = title; if (t.popout) t.popout.setTitle(`Cue · ${title}`);
    if (remembers(t)) lib.title(wc.getURL(), title);
    t.badge = countIn(t, title);
    pushState(); persist();
  });
  wc.on('page-favicon-updated', (_e, favs) => { t.favicon = favs[0] || null; pushState(); persist(); });
  const nav = () => {
    t.url = wc.getURL(); t.canBack = wc.navigationHistory.canGoBack(); t.canFwd = wc.navigationHistory.canGoForward();
    pushState(); persist();
  };
  const visit = () => { if (remembers(t) && /^https?:/.test(wc.getURL())) lib.visit(wc.getURL(), wc.getTitle()); };
  wc.on('did-navigate', () => { nav(); visit(); });
  wc.on('did-navigate-in-page', (_e, _u, main) => { nav(); if (main) visit(); });
  wc.on('did-start-loading', () => { t.loading = true; pushState(); });
  wc.on('did-stop-loading', () => { t.loading = false; nav(); readBillPage(t); });
  wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') logTab(t, e.level, `${e.message} (${e.sourceId}:${e.lineNumber})`); });
  wc.on('audio-state-changed', (e) => { t.audible = e.audible; pushState(); });
  wc.on('media-started-playing', () => {
    t.playing = true;
    if (settings().onePlayer) {
      for (const o of tabs) {
        if (o !== t && o.view && o.playing && o.id !== programId) o.view.webContents.send('cue:media', 'pause');
      }
    }
    pushState();
  });
  wc.on('media-paused', () => { t.playing = false; pushState(); });
  wc.on('enter-html-full-screen', () => { t.fullscreen = true; const w = hostWindow(t); if (w) w.setFullScreen(true); layout(); });
  wc.on('leave-html-full-screen', () => { t.fullscreen = false; const w = hostWindow(t); if (w) w.setFullScreen(false); layout(); });
  wc.on('found-in-page', (_e, r) => sendEvent('find-result', { active: r.activeMatchOrdinal, total: r.matches }));
  wc.on('focus', () => {
    if (t.id !== activeId && store.data.split.ids.includes(t.id) && t.host === 'main') { activeId = t.id; t.lastActive = Date.now(); pushState(); }
  });
  wc.on('render-process-gone', () => { t.crashed = true; pushState(); });
  wc.on('context-menu', (_e, p) => contextMenu(t, p));
  wc.on('did-finish-load', () => {
    if (t.volume !== 1) wc.send('cue:volume', t.volume);
  });
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (recTabId === t.id) return { action: 'deny' };
    if (disposition === 'new-window') {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, webPreferences: { session: sessionFor(t.identity) } } };
    }
    const nt = openTab({ url, identity: t.identity, background: disposition === 'background-tab', after: t, agent: t.agent });
    nt.groupOverride = t.groupOverride;
    return { action: 'deny' };
  });
}

function hostWindow(t) { return t.host === 'stage' ? stageWin : t.host === 'popout' ? t.popout : mainWin; }

// The site a URL belongs to, with www dropped so youtube.com and www.youtube.com
// are treated as one place.
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function openTab({ url, identity, background, after, agent, pinned } = {}) {
  const t = makeTab({ url: url || START_URL, identity, agent, pinned });
  if (after) {
    const i = tabs.indexOf(after);
    t.order = after.order + 0.001;
    tabs.splice(i + 1, 0, t);
  } else tabs.push(t);
  ensureView(t);
  if (!background) activate(t.id);
  pushState(); persist();
  return t;
}

function activate(id) {
  const t = byId(id); if (!t) return;
  if (t.space !== store.data.space && t.id !== programId) enterSpace(t.space);
  activeId = id; t.lastActive = Date.now();
  if (t.host === 'popout' && t.popout) { t.popout.focus(); }
  ensureView(t);
  const sp = store.data.split;
  if (sp.mode !== 'single' && !sp.ids.includes(id)) sp.ids = [id];
  layout(); pushState(); persist();
  if (t.view && t.host === 'main') t.view.webContents.focus();
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id); if (i < 0) return;
  const t = tabs[i];
  if (t.identity !== 'vanish') closedStack.push(serialize(t));
  if (t.id === programId) { programId = null; showStandby(); }
  destroyView(t);
  if (t.popout) { const w = t.popout; t.popout = null; w.destroy(); }
  tabs.splice(i, 1);
  store.data.split.ids = store.data.split.ids.filter((x) => x !== id);
  if (activeId === id) {
    const next = spaceOrder()[0];
    if (next) activate(next.id); else openTab({});
  }
  layout(); pushState(); persist();
}

function destroyView(t) {
  if (!t.view) return;
  const v = t.view; t.view = null;
  for (const w of [mainWin, stageWin, t.popout]) { try { if (w) w.contentView.removeChildView(v); } catch {} }
  try { v.webContents.close(); } catch {}
}

function serialize(t) {
  const { url, title, favicon, identity, pinned, groupOverride, volume, muted, private: p, obsScene, order, zoom, aiAllowed, space, lastActive } = t;
  return { url, title, favicon, identity, pinned, groupOverride, volume, muted, private: p, obsScene, order, zoom, aiAllowed, space, lastActive };
}

function persist() {
  store.data.tabs = tabs.filter((t) => t.identity !== 'vanish' && !t.agentTemp).map(serialize);
  const a = byId(activeId);
  store.data.activeIndex = a ? store.data.tabs.findIndex((s) => s.order === a.order) : 0;
  store.save();
}

// ---------------------------------------------------------------- layout
function contentRect() {
  const [w, h] = mainWin.getContentSize();
  const top = TOOLBAR + (stripOpen ? STRIP : 0);
  return { x: SIDEBAR, y: top, width: Math.max(0, w - SIDEBAR - (aiView ? AI_W : 0)), height: Math.max(0, h - top) };
}

function splitRects(mode, r) {
  const g = GAP; const out = [];
  const cols = (n) => { const w = (r.width - g * (n + 1)) / n; for (let i = 0; i < n; i++) out.push({ x: r.x + g + i * (w + g), y: r.y, width: w, height: r.height - g }); };
  if (mode === 'cols2') cols(2);
  else if (mode === 'cols3') cols(3);
  else if (mode === 'rows2') { const h = (r.height - g * 2) / 2; for (let i = 0; i < 2; i++) out.push({ x: r.x + g, y: r.y + i * (h + g), width: r.width - g * 2, height: h }); }
  else if (mode === 'grid4') {
    const w = (r.width - g * 3) / 2; const h = (r.height - g * 2) / 2;
    for (let i = 0; i < 4; i++) out.push({ x: r.x + g + (i % 2) * (w + g), y: r.y + Math.floor(i / 2) * (h + g), width: w, height: h });
  } else out.push({ ...r });
  return out.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) }));
}

let panes = [];
function layout() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const [w, h] = mainWin.getContentSize();
  uiView.setBounds({ x: 0, y: 0, width: w, height: h });
  const sp = store.data.split;
  const active = byId(activeId);
  let ids = sp.mode !== 'single' && sp.ids.includes(activeId) ? sp.ids.filter((id) => byId(id)) : [activeId];
  ids = ids.filter((id) => { const t = byId(id); return t && t.host === 'main' && !(live && id === programId); });
  const full = active && active.fullscreen && active.host === 'main';
  const rects = full ? [{ x: 0, y: 0, width: w, height: h }] : splitRects(ids.length > 1 ? sp.mode : 'single', contentRect());
  panes = [];
  const shown = full ? [activeId] : ids;
  for (const t of tabs) {
    if (!t.view || t.host !== 'main') continue;
    const k = shown.indexOf(t.id);
    if (k >= 0 && rects[k]) { t.view.setBounds(rects[k]); t.view.setVisible(true); panes.push({ id: t.id, rect: rects[k] }); }
    else { t.view.setVisible(false); t.view.setBounds(rects[0] || contentRect()); }
  }
  if (aiView) aiView.setBounds({ x: w - AI_W, y: TOOLBAR + AI_HEAD, width: AI_W, height: Math.max(0, h - TOOLBAR - AI_HEAD) });
  if (peek) {
    const r = contentRect(); const pw = Math.round(r.width * 0.5);
    peek.view.setBounds({ x: r.x + r.width - pw - 8, y: r.y + 8, width: pw, height: r.height - 16 });
    if (!overlay) mainWin.contentView.addChildView(peek.view);
  }
  if (stageWin && !stageWin.isDestroyed()) {
    const [sw, sh] = stageWin.getContentSize();
    const p = byId(programId);
    if (p && p.view) p.view.setBounds({ x: 0, y: 0, width: sw, height: sh });
    if (stageStandby) stageStandby.setBounds({ x: 0, y: 0, width: sw, height: sh });
  }
  for (const t of tabs) {
    if (t.host === 'popout' && t.popout && t.view) { const [pw, ph] = t.popout.getContentSize(); t.view.setBounds({ x: 0, y: 0, width: pw, height: ph }); }
  }
}

function setSplit(mode) {
  if (!SPLITS[mode]) return;
  const sp = store.data.split; sp.mode = mode;
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

function sidebarOrder() {
  const order = GROUP_LIST.map((g) => g.id);
  return [...tabs].sort((a, b) => (b.pinned - a.pinned) || (order.indexOf(groupOf(a)) - order.indexOf(groupOf(b))) || (a.order - b.order));
}
function spaceOrder() { return sidebarOrder().filter((t) => t.space === store.data.space); }

// ---------------------------------------------------------------- spaces
// Each Space keeps its own tabs, its own usual login and its own split layout.
function enterSpace(name) {
  if (!SPACES.includes(name) || name === store.data.space) return;
  store.data.spaceSplit[store.data.space] = store.data.split;
  store.data.space = name;
  const saved = store.data.spaceSplit[name] || { mode: 'single', ids: [] };
  store.data.split = { mode: saved.mode, ids: saved.ids.filter((id) => byId(id)) };
  if (store.data.split.ids.length < 2) store.data.split = { mode: 'single', ids: [] };
}
function switchSpace(name) {
  if (name === store.data.space) return;
  enterSpace(name);
  const list = tabs.filter((t) => t.space === name && t.id !== programId).sort((a, b) => b.lastActive - a.lastActive);
  if (list[0]) activate(list[0].id); else openTab({});
  layout(); pushState(); persist();
}

// ---------------------------------------------------------------- live / stage
function openStage() {
  if (stageWin && !stageWin.isDestroyed()) return;
  const s = settings();
  stageWin = new BaseWindow({
    width: s.stageWidth, height: s.stageHeight, useContentSize: true, title: 'Cue Stage — On Air',
    backgroundColor: '#000000', enableLargerThanScreen: true, fullscreenable: true, show: true,
  });
  stageWin.setContentSize(s.stageWidth, s.stageHeight);
  stageStandby = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  stageWin.contentView.addChildView(stageStandby);
  stageStandby.webContents.loadFile(STAGE_HTML);
  stageWin.on('resize', layout);
  stageWin.on('closed', () => { stageWin = null; stageStandby = null; if (live) setLive(false, true); });
  layout();
}

function showStandby() { if (stageStandby) stageStandby.setVisible(true); }

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
    openStage();
  } else {
    if (heldCount) sendEvent('toast', `${heldCount} notification${heldCount === 1 ? '' : 's'} held during class. See Bills & alerts.`);
    const p = byId(programId);
    if (p) { p.view && p.view.webContents.send('cue:safe', false); moveView(p, mainWin, 'main'); }
    programId = null;
    if (!stageClosed && stageWin && !stageWin.isDestroyed()) stageWin.destroy();
    stageWin = null; stageStandby = null;
  }
  layout(); pushState();
}

function take() {
  if (!live) { setLive(true); }
  const next = byId(activeId);
  if (!next) return;
  if (next.private) { sendEvent('toast', `${next.title} is a private tab. It never goes on air.`); return; }
  if (next.id === programId) { sendEvent('toast', 'That tab is already on air.'); return; }
  const prev = byId(programId);
  ensureView(next);
  if (next.host === 'popout' && next.popout) { const w = next.popout; next.popout = null; moveView(next, mainWin, 'main'); w.destroy(); }
  moveView(next, stageWin, 'stage');
  if (stageStandby) stageStandby.setVisible(false);
  programId = next.id;
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
  w.on('closed', () => { if (t.popout === w) { t.popout = null; if (t.view) moveView(t, mainWin, 'main'); layout(); pushState(); } });
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
  const url = resolveInput(text, engine);
  const t = byId(activeId);
  if (newTab || !t) return openTab({ url, identity: identity || (t ? t.identity : undefined) });
  ensureView(t);
  t.url = url;
  t.view.webContents.loadURL(url).catch(() => {});
  t.view.webContents.focus();
  pushState();
}

function contextMenu(t, p) {
  const wc = t.view.webContents;
  const items = [];
  const ids = Object.keys(IDENTITIES);
  if (p.linkURL) {
    items.push({ label: 'Open link in new tab', click: () => openTab({ url: p.linkURL, identity: t.identity, background: true, after: t }) });
    items.push({ label: 'Peek at this link', click: () => openPeek(p.linkURL, t) });
    items.push({ label: 'Open link as…', submenu: ids.map((i) => ({ label: IDENTITIES[i].name, click: () => openTab({ url: p.linkURL, identity: i, after: t }) })) });
    items.push({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push({ label: 'Open image in new tab', click: () => openTab({ url: p.srcURL, identity: t.identity, after: t }) });
    items.push({ label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) });
    items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) });
    items.push({ label: 'Search this image with Google Lens', click: () => openTab({ url: 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(p.srcURL), identity: t.identity, after: t }) });
    items.push({ label: 'Ask Claude about this image', click: () => askAI('claude', `Tell me about this image: ${p.srcURL}`) });
    if (kit('designer')) {
      const boards = lib.boardList();
      items.push({ label: 'Add to board', submenu: [...boards.map((b) => ({ label: b.name, click: () => addToBoard(t, p, b.id) })), { type: 'separator' }, { label: 'New board', click: () => addToBoard(t, p, lib.boardCreate(`Board ${boards.length + 1}`)) }] });
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
  if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }, { type: 'separator' });
  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    { type: 'separator' },
    { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
  );
  Menu.buildFromTemplate(items).popup({ window: hostWindow(t) });
}

function tabMenu(t) {
  if (!t) return;
  const ids = Object.keys(IDENTITIES);
  const items = [
    { label: t.pinned ? 'Unpin' : 'Pin', click: () => { t.pinned = !t.pinned; pushState(); persist(); } },
    { label: t.muted ? 'Unmute' : 'Mute', click: () => setMuted(t, !t.muted) },
    { label: 'Duplicate', click: () => openTab({ url: t.url, identity: t.identity, after: t }) },
    { label: 'Open as…', submenu: ids.filter((i) => i !== t.identity).map((i) => ({ label: IDENTITIES[i].name, click: () => openTab({ url: t.url, identity: i, after: t }) })) },
    { label: 'Add to split view', click: () => addToSplit(t.id) },
    { label: 'Move to Space', submenu: SPACES.map((n) => ({ label: n, type: 'radio', checked: t.space === n, click: () => { t.space = n; if (t.id === activeId) { const o = spaceOrder().filter((x) => x.id !== t.id)[0]; if (o) activate(o.id); else openTab({}); } pushState(); persist(); } })) },
    { label: 'Pop out to its own window (for Zoom and OBS)', enabled: t.host === 'main', click: () => popOut(t) },
    { type: 'separator' },
    { label: 'Private: never goes on air', type: 'checkbox', checked: t.private, click: () => { t.private = !t.private; pushState(); persist(); } },
    { label: 'Let AI agents use this tab', type: 'checkbox', checked: t.aiAllowed || t.agent, enabled: !t.agent, click: () => { t.aiAllowed = !t.aiAllowed; pushState(); persist(); } },
    { label: 'Move to group', submenu: [{ label: 'Automatic', type: 'radio', checked: !t.groupOverride, click: () => { t.groupOverride = null; pushState(); persist(); } }, ...GROUP_LIST.map((g) => ({ label: g.name, type: 'radio', checked: t.groupOverride === g.id, click: () => { t.groupOverride = g.id; pushState(); persist(); } }))] },
    { type: 'separator' },
    { label: 'Close tab', click: () => closeTab(t.id) },
  ];
  Menu.buildFromTemplate(items).popup({ window: mainWin });
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
  if (overlay) mainWin.contentView.addChildView(uiView);
  else mainWin.contentView.addChildView(uiView, 0);
}

// ---------------------------------------------------------------- UI state
let stateTimer = null;
function pushState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; sendState(); }, 30);
}

function sendState() {
  if (!uiView || uiView.webContents.isDestroyed()) return;
  const s = settings();
  uiView.webContents.send('ui:state', {
    tabs: sidebarOrder().map((t) => ({
      id: t.id, url: isStart(t.url) ? '' : t.url, title: t.title, favicon: t.favicon, identity: t.identity, pinned: t.pinned,
      group: groupOf(t), volume: t.volume, muted: t.muted, private: t.private, obsScene: t.obsScene, agent: t.agent,
      aiAllowed: t.aiAllowed, playing: t.playing, audible: t.audible, loading: t.loading, sleeping: !t.view,
      host: t.host, canBack: t.canBack, canFwd: t.canFwd, crashed: !!t.crashed, space: t.space, badge: t.badge,
    })),
    space: store.data.space, spaces: SPACES, kits: KITS, peek: peek ? { title: peek.title, url: peek.url } : null,
    ai: aiView ? { which: store.data.aiWhich } : null, strip: stripOpen, recording: recTabId, alertCount: alertCount(), billCount: billCount(),
    activeId, programId, live, groups: GROUP_LIST, identities: IDENTITIES, labels: s.identityLabels,
    split: store.data.split, panes, settings: { ...s, obs: { ...s.obs, password: s.obs.password ? '••••' : '' } },
    collapsed: store.data.collapsed, obs: obs.status, downloads: downloads.slice(0, 8),
    agent: { port: AGENT_PORT, on: s.agentPort, last: agentLog[agentLog.length - 1] || null },
  });
}

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
  e.returnValue = { volume: t ? t.volume : 1, originalSound: settings().originalSound, safe: !!(t && live && t.id === programId && settings().safeShare), hold: live };
});
ipcMain.on('cue:media-state', (e, playing) => { const t = byWC(e.sender); if (t) { t.playing = playing; pushState(); } });
ipcMain.on('cue:scroll', (e, ratio) => {
  const sp = store.data.split;
  if (!settings().syncScroll || sp.mode === 'single') return;
  const t = byWC(e.sender); if (!t || !sp.ids.includes(t.id)) return;
  for (const id of sp.ids) { const o = byId(id); if (o && o !== t && o.view) o.view.webContents.send('cue:scroll-to', ratio); }
});

ipcMain.on('cue:peek', (e, url) => { const t = byWC(e.sender); if (t) openPeek(url, t); });
ipcMain.on('cue:music-state', (_e, st) => sendEvent('music-state', st));
ipcMain.on('cue:note', (e, n) => {
  const t = byWC(e.sender); if (!t || t.identity === 'vanish') return;
  if (live) heldCount++;
  addAlert({ source: hostName(t.url), title: n.title, body: n.body, url: t.url, held: live });
});
ipcMain.handle('cue:cred-get', (e) => {
  const t = byWC(e.sender);
  if (!t || e.senderFrame !== e.sender.mainFrame || t.identity === 'vanish' || t.id === programId || agentCanAct(t)) return null;
  const origin = safeOrigin(e.senderFrame.url);
  if (!securePage(origin)) return null;
  const c = vault.find(t.identity, origin);
  if (!c) return null;
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
  if (!e.senderFrame.url.startsWith('cue://') || !internal[cmd]) throw new Error('Not allowed');
  return internal[cmd](a);
});

ipcMain.on('ui:cmd', (_e, cmd, a = {}) => {
  const t = a.id ? byId(a.id) : byId(activeId);
  const wc = t && t.view ? t.view.webContents : null;
  switch (cmd) {
    case 'navigate': navigate(a); break;
    case 'activate': activate(a.id); break;
    case 'close': closeTab(a.id); break;
    case 'new-tab': openTab({ identity: a.identity, url: a.url }); sendEvent('focus-omnibox'); break;
    case 'back': if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': if (wc) wc.reload(); break;
    case 'stop': if (wc) wc.stop(); break;
    case 'mute': if (t) setMuted(t, !t.muted); break;
    case 'volume': if (t) setVolume(t, a.value); break;
    case 'media': if (t) { if (!t.view) ensureView(t); t.view.webContents.send('cue:media', a.cmd || 'toggle'); } break;
    case 'tab-menu': tabMenu(t); break;
    case 'reorder': reorder(a); break;
    case 'move-tab': moveTab(a); break;
    case 'split': setSplit(a.mode); break;
    case 'split-add': addToSplit(a.id); break;
    case 'live': setLive(!!a.on); break;
    case 'take': take(); break;
    case 'popout': popOut(t); break;
    case 'overlay': setOverlay(a.on); break;
    case 'collapse': store.data.collapsed[a.group] = !store.data.collapsed[a.group]; store.save(); pushState(); break;
    case 'setting': setSetting(a.key, a.value); break;
    case 'find': if (wc) { if (a.stop || !a.text) wc.stopFindInPage('clearSelection'); else wc.findInPage(a.text, { forward: a.forward !== false, findNext: !!a.next }); } break;
    case 'zoom': if (wc) { t.zoom = a.reset ? 0 : t.zoom + (a.dir || 0) * 0.5; wc.setZoomLevel(t.zoom); persist(); } break;
    case 'download-open': { const d = downloads.find((x) => x.id === a.id); if (d) shell.showItemInFolder(d.file); break; }
    case 'downloads-clear': downloads.length = 0; pushState(); break;
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
    case 'space': switchSpace(a.name); break;
    case 'peek-close': closePeek(); break;
    case 'peek-keep': { if (peek) { const url = peek.url; const from = peek.identity; closePeek(); openTab({ url, identity: from }); } break; }
    case 'ai': toggleAI(a.which); break;
    case 'ai-ask': askAboutPage(a.which); break;
    case 'strip': stripOpen = !stripOpen; layout(); pushState(); break;
    case 'music': if (wc) wc.send('cue:music', a.op, a.value); break;
    case 'tool': runTool(a.name, t); break;
    case 'open-page': openTab({ url: `cue://${a.page}`, identity: byId(activeId)?.identity === 'vanish' ? undefined : byId(activeId)?.identity }); break;
    case 'cred-save': if (pendingCred) { vault.save({ ...pendingCred, auto: !!a.auto }); pendingCred = null; sendEvent('toast', 'Password saved.'); } break;
    case 'cred-never': if (pendingCred) { vault.neverFor(pendingCred.origin); pendingCred = null; } break;
    case 'cred-dismiss': pendingCred = null; break;
    case 'pw-auto': vault.setAuto(a.pw, a.on); break;
    case 'pw-remove': vault.remove(a.pw); break;
    case 'download-run': {
      const d = downloads.find((x) => x.id === a.id);
      if (d) { shell.openPath(d.file); if (d.kind === 'Installers') { store.data.installersOpened.push({ file: d.file, at: Date.now() }); store.save(); } }
      break;
    }
    case 'make-default': app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https'); break;
    case 'set-scene': if (t) { t.obsScene = a.scene || ''; pushState(); persist(); } break;
    case 'agent-copy': clipboard.writeText(agentSetupText()); sendEvent('toast', 'AI setup copied.'); break;
    default: break;
  }
});

ipcMain.handle('ui:invoke', async (_e, cmd, a = {}) => {
  if (cmd === 'obs-scenes') return obs.scenes();
  if (cmd === 'suggest') return suggestions(a.q);
  if (cmd === 'import-find') return findImports();
  if (cmd === 'import-run') return runImport(a);
  if (cmd === 'passwords') return vault.list();
  if (cmd === 'ext-find') return findExtensions();
  if (cmd === 'ext-add') return addExtension(a);
  if (cmd === 'ext-remove') return removeExtension(a.id);
  if (cmd === 'lens-file') return lensFile(a);
  if (cmd === 'rec-start') { const t = byId(activeId); if (!t || !t.view) return null; recTabId = t.id; pushState(); return { title: t.title }; }
  if (cmd === 'rec-cancel') { recTabId = null; pushState(); return true; }
  if (cmd === 'rec-save') {
    recTabId = null; pushState();
    const file = capture.saveRecording(a.title, a.buffer, a.ext);
    sendEvent('toast', 'Recording saved in Cue Captures.'); capture.reveal(file);
    return file;
  }
  return null;
});

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
    }
  } else t.order = Date.now();
  pushState(); persist();
}

// Move a tab one place up or down inside its own group. Dragging was the only
// way to reorder, which is awkward with a long list and impossible from the
// keyboard.
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
  else if (key.startsWith('label.')) { s.identityLabels[key.slice(6)] = value; }
  else if (key.startsWith('kit.')) { s.kits[key.slice(4)] = !!value; buildMenu(); if (key === 'kit.music' && !value) stripOpen = false; layout(); }
  else if (key.startsWith('spaceLogin.')) { s.spaceLogins[key.slice(11)] = value; }
  else s[key] = value;
  if (key === 'githubUser') loadRepos();
  store.save();
  if (key === 'originalSound') tabs.forEach((x) => x.view && x.view.webContents.send('cue:original-sound', value));
  if (key === 'safeShare') { const p = byId(programId); if (p && p.view) p.view.webContents.send('cue:safe', !!value); }
  pushState();
}

// ---------------------------------------------------------------- helpers for the features below
const kit = (k) => settings().kits[k] !== false;
const hostName = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
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
function suggestions(q) {
  const ql = String(q || '').trim().toLowerCase();
  if (!ql) return { history: [], bookmarks: [], boards: [], apps: [], repos: [] };
  const hit = (x) => `${x.name} ${x.what || ''}`.toLowerCase().includes(ql);
  return {
    history: lib.suggest(ql, 6),
    bookmarks: lib.bookmarks(ql, 5),
    boards: kit('designer') ? lib.searchBoards(ql) : [],
    apps: NSM_APPS.filter(hit).slice(0, 5),
    repos: repos.filter(hit).slice(0, 5),
  };
}

async function loadRepos() {
  const user = settings().githubUser; repos = [];
  if (!user) return;
  try {
    const r = await net.fetch(`https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`, { headers: { accept: 'application/vnd.github+json' } });
    if (r.ok) repos = (await r.json()).map((x) => ({ name: x.name, what: x.description || '', url: x.html_url }));
  } catch {}
}

// ---------------------------------------------------------------- peek
function openPeek(url, from) {
  closePeek();
  const view = new WebContentsView({ webPreferences: { session: sessionFor(from.identity), preload: TAB_PRELOAD, contextIsolation: true, sandbox: true } });
  view.setBackgroundColor('#FFFFFF');
  peek = { view, url, title: hostName(url), identity: from.identity };
  const wc = view.webContents;
  wc.on('page-title-updated', (_e, title) => { if (peek && peek.view === view) { peek.title = title; pushState(); } });
  wc.on('did-navigate', (_e, u) => { if (peek && peek.view === view) { peek.url = u; pushState(); } });
  wc.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); closePeek(); } });
  wc.setWindowOpenHandler(({ url: u }) => { openTab({ url: u, identity: from.identity }); return { action: 'deny' }; });
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
function toggleAI(which) {
  if (aiView && (!which || which === store.data.aiWhich)) {
    const v = aiView; aiView = null;
    try { mainWin.contentView.removeChildView(v); v.webContents.close(); } catch {}
  } else openAI(which || store.data.aiWhich);
  layout(); pushState();
}
function openAI(which, url) {
  const id = settings().defaultIdentity;
  store.data.aiWhich = which; store.save();
  if (!aiView) {
    aiView = new WebContentsView({ webPreferences: { session: sessionFor(id), preload: TAB_PRELOAD, contextIsolation: true, sandbox: true } });
    aiView.setBackgroundColor('#FFFFFF');
    aiView.webContents.setWindowOpenHandler(({ url: u }) => { openTab({ url: u, identity: id }); return { action: 'deny' }; });
    mainWin.contentView.addChildView(aiView);
  }
  aiView.webContents.loadURL(url || AI_HOME[which]).catch(() => {});
  layout(); pushState();
}
function askAI(which, prompt) {
  const base = which === 'chatgpt' ? 'https://chatgpt.com/?q=' : 'https://claude.ai/new?q=';
  openAI(which, base + encodeURIComponent(prompt.slice(0, 6000)));
}
async function askAboutPage(which) {
  const t = byId(activeId);
  if (!t || !t.view || t.identity === 'vanish' || isStart(t.url)) { openAI(which || store.data.aiWhich); return; }
  const wc = t.view.webContents; let text = '';
  try { text = await wc.executeJavaScript('(getSelection().toString() || document.body.innerText).slice(0, 4000)', true); } catch {}
  askAI(which || store.data.aiWhich, `I'm looking at this page: ${wc.getTitle()}\n${wc.getURL()}\n\n${text}\n\nWhat should I know about it?`);
}

// ---------------------------------------------------------------- alerts and bills
function addAlert(a) {
  store.data.alerts.unshift({ id: Date.now() + Math.random(), at: Date.now(), held: false, ...a });
  store.data.alerts.length = Math.min(store.data.alerts.length, 200);
  store.save(); pushState();
}
const alertCount = () => store.data.alerts.filter((a) => !a.seen).length + tabs.reduce((n, t) => n + (t.badge || 0), 0);
const billCount = () => store.data.bills.filter((b) => ['due', 'failed'].includes(bills.status(b))).length;

function checkBills() {
  store.data.bills.forEach((b) => bills.roll(b));
  for (const b of store.data.bills) {
    const st = bills.status(b);
    const key = `${st}|${b.renews}`;
    if (st !== 'due' && st !== 'failed') continue;
    if (b.warned === key) continue;
    b.warned = key;
    const d = b.renews ? bills.daysUntil(b.renews) : null;
    addAlert({ source: b.name, title: st === 'failed' ? `${b.name}: card failed` : `${b.name}: due in ${d} day${d === 1 ? '' : 's'}`, body: b.amountINR ? `₹${b.amountINR.toLocaleString('en-IN')}` : '', url: b.url });
  }
  store.save(); pushState();
}

function readBillPage(t) {
  if (!kit('business') || t.identity === 'vanish' || groupOf(t) !== 'ai' || !bills.BILLING_URL.test(t.url)) return;
  const url = t.url;
  setTimeout(async () => {
    if (!t.view || t.url !== url) return;
    try {
      const text = await t.view.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 40000) : ""', true);
      if (bills.fromPage(store.data.bills, url, text, store.data.usdToInr)) checkBills();
    } catch {}
  }, 2500);
}

function bookmarkTab(t) {
  if (!t || t.identity === 'vanish' || !/^https?:/.test(t.url)) { sendEvent('toast', 'This page can\'t be bookmarked.'); return; }
  lib.importBookmarks([{ url: t.url, title: t.title, folder: '' }]);
  sendEvent('toast', 'Bookmarked.');
}

// ---------------------------------------------------------------- tidying
function archiveOldTabs() {
  const days = settings().archiveDays; if (!days) return;
  const cutoff = Date.now() - days * 86400000;
  const inSplit = new Set(store.data.split.ids);
  for (const t of [...tabs]) {
    if (t.pinned || t.id === activeId || t.id === programId || t.identity === 'vanish' || t.agent || t.playing || t.audible || inSplit.has(t.id) || t.lastActive > cutoff || isStart(t.url)) continue;
    store.data.archived.unshift({ id: Date.now() + Math.random(), url: t.url, title: t.title, identity: t.identity, space: t.space, archivedAt: Date.now() });
    destroyView(t); tabs.splice(tabs.indexOf(t), 1);
  }
  store.data.archived.length = Math.min(store.data.archived.length, 500);
  pushState(); persist();
}

// ---------------------------------------------------------------- Cue's own pages
const internal = {
  open: ({ url }) => { if (/^https?:/.test(url)) openTab({ url }); },
  'boards.list': () => lib.boardList(),
  'boards.create': ({ name }) => lib.boardCreate(name),
  'boards.rename': ({ id, name }) => lib.boardRename(id, name),
  'boards.delete': ({ id }) => lib.boardDelete(id),
  'boards.removeItem': ({ itemId }) => lib.boardRemoveItem(itemId),
  'bills.list': () => { store.data.bills.forEach((b) => bills.roll(b)); return { bills: store.data.bills.map((b) => ({ ...b, status: bills.status(b) })), usdToInr: store.data.usdToInr }; },
  'bills.save': ({ bill }) => {
    const cur = store.data.bills.find((b) => b.id === bill.id);
    if (cur) Object.assign(cur, bill); else store.data.bills.push({ ...bill, id: bill.id || Date.now().toString(36) });
    checkBills();
  },
  'bills.delete': ({ id }) => { store.data.bills = store.data.bills.filter((b) => b.id !== id); store.save(); pushState(); },
  'bills.setRate': ({ usdToInr }) => { store.data.usdToInr = Number(usdToInr) || store.data.usdToInr; store.save(); },
  'alerts.list': () => {
    store.data.alerts.forEach((a) => { a.seen = true; }); store.save(); pushState();
    const counts = tabs.filter((t) => t.badge).map((t) => ({ id: `tab${t.id}`, source: hostName(t.url), title: `${t.badge} new`, body: t.title, at: Date.now(), url: t.url, held: false }));
    return [...counts, ...store.data.alerts];
  },
  'alerts.clear': () => { store.data.alerts = []; store.save(); pushState(); },
  'library.bookmarks': () => lib.bookmarks(''),
  'library.history': ({ q }) => lib.history(q, 500),
  'library.archived': () => store.data.archived,
  'library.restore': ({ id }) => {
    const a = store.data.archived.find((x) => x.id === id); if (!a) return;
    store.data.archived = store.data.archived.filter((x) => x !== a);
    openTab({ url: a.url, identity: a.identity });
  },
  'library.history.clear': () => lib.clearHistory(),
};

// ---------------------------------------------------------------- move in from another browser
function findImports() {
  return importer.findBrowsers().map((b) => ({
    id: b.id, name: b.name,
    profiles: b.profiles.map((p) => ({ ...p, counts: importer.summarize(b, p), identity: guessIdentity(p) })),
  }));
}
function guessIdentity(p) {
  const labels = settings().identityLabels;
  const hit = Object.keys(labels).find((k) => labels[k] && labels[k].toLowerCase() === String(p.email || '').toLowerCase());
  return hit || 'personal';
}
async function runImport({ browser, profile, identity, what }) {
  const b = importer.findBrowsers().find((x) => x.id === browser);
  const p = b && b.profiles.find((x) => x.dir === profile);
  if (!b || !p) return { error: 'That browser was not found.' };
  const done = {};
  if (what.bookmarks) done.bookmarks = lib.importBookmarks(importer.readBookmarks(b, p));
  if (what.history) done.history = lib.importHistory(importer.readHistory(b, p));
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
      }
    }
  }
  return done;
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
  return { available: out, installed: extensions.installed(extDir).map((e) => ({ id: e.id, name: e.name, version: e.version })) };
}
async function addExtension({ id, dir, name }) {
  const to = extensions.adopt(extDir, { id, dir });
  for (const k of ['personal', 'school', 'agent']) {
    try { await sessionFor(k).extensions.loadExtension(to); } catch (e) { return { ok: false, error: e.message, name }; }
  }
  return { ok: true, name };
}
function removeExtension(id) {
  for (const k of ['personal', 'school', 'agent']) {
    const ses = sessionFor(k); const ext = ses.extensions.getAllExtensions().find((e) => path.basename(e.path) === id);
    if (ext) ses.extensions.removeExtension(ext.id);
  }
  fs.rmSync(path.join(extDir, id), { recursive: true, force: true });
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
  lib.boardAdd(boardId, { img: p.srcURL, source: wc.getURL(), title: p.titleText || p.altText || wc.getTitle(), thumb });
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
  if (name === 'boards' || name === 'library' || name === 'bills' || name === 'thumbcheck') { openTab({ url: `cue://${name}`, identity: t.identity === 'vanish' ? undefined : t.identity }); return; }
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
  const bridge = path.join(app.isPackaged ? process.resourcesPath : path.join(ROOT, '..'), app.isPackaged ? 'app/bin/cue-mcp.js' : 'bin/cue-mcp.js');
  return `Cue AI port: http://127.0.0.1:${AGENT_PORT}\nToken file: ${agentTokenFile()}\nMCP bridge: node "${bridge}"`;
}
function agentTokenFile() { return path.join(app.getPath('userData'), 'agent-port.json'); }

function logAgent(entry) {
  const e = { at: new Date().toISOString(), ...entry };
  agentLog.push(e); if (agentLog.length > 200) agentLog.shift();
  fs.appendFile(path.join(app.getPath('userData'), 'agent-log.jsonl'), JSON.stringify(e) + '\n', () => {});
  pushState();
}

const agentApi = {
  identities: () => Object.entries(IDENTITIES).filter(([k]) => k !== 'vanish').map(([k, v]) => ({ id: k, name: v.name, account: settings().identityLabels[k] || '' })),
  list: () => sidebarOrder().filter((t) => t.identity !== 'vanish').map((t) => ({
    id: t.id, title: t.title, url: isStart(t.url) ? '' : t.url, identity: t.identity, group: groupOf(t),
    onAir: t.id === programId, private: t.private, agentTab: t.agent, aiCanAct: agentCanAct(t), audible: t.audible, muted: t.muted, volume: t.volume,
  })),
  get: (id) => byId(Number(id)),
  canRead: (t) => t && t.identity !== 'vanish' && !t.private && !t.url.startsWith('cue://'), // your Library and Bills pages stay yours
  canAct: (t) => agentCanAct(t),
  open: ({ url, identity = 'agent', background = true, newTab = false }) => {
    const target = resolveInput(url);
    if (target.startsWith('cue://')) throw new Error('Cue\'s own pages are private to the person using it.');
    const who = IDENTITIES[identity] && identity !== 'vanish' ? identity : 'agent';
    // One tab per site, not one per instruction. An agent sent to WhatsApp six
    // times used to leave six WhatsApp tabs behind; now it goes back to the one
    // it already has open for that site and navigates it.
    if (!newTab) {
      const host = hostOf(target);
      const reuse = tabs.find((t) => t.agent && t.identity === who && t.id !== programId && hostOf(t.url) === host);
      if (reuse) {
        ensureView(reuse);
        if (reuse.url !== target) reuse.view.webContents.loadURL(target);
        if (!background) activate(reuse.id);
        return reuse;
      }
    }
    return openTab({ url: target, identity: who, background, agent: true });
  },
  ensure: (t) => ensureView(t),
  capture: (t) => captureTab(t),
  close: (t) => closeTab(t.id),
  fullPage: (t) => capture.fullPage(t.view.webContents, t.title),
  problems: (t) => t.log,
  alert: (a) => addAlert({ source: a.source || 'AI agent', title: a.title, body: a.body || '', url: a.url || '' }),
  bills: () => store.data.bills.map((b) => ({ ...b, status: bills.status(b) })),
  setMuted, setVolume,
  log: logAgent,
};

function agentCanAct(t) { return !!t && t.identity !== 'vanish' && !t.private && t.id !== programId && !t.url.startsWith('cue://') && (t.agent || t.aiAllowed); }

// ---------------------------------------------------------------- menus
function buildMenu() {
  const cmd = (c, a) => () => ipcMain.emit('ui:cmd', {}, c, a);
  const ids = Object.keys(IDENTITIES);
  const tpl = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File', submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: cmd('new-tab') },
        { label: 'New Vanish Tab', accelerator: 'CmdOrCtrl+Shift+N', click: cmd('new-tab', { identity: 'vanish' }) },
        { label: 'New Tab As', submenu: ids.map((i) => ({ label: IDENTITIES[i].name, click: cmd('new-tab', { identity: i }) })) },
        { label: 'Move In From Another Browser…', click: () => sendEvent('import') },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => { const s = closedStack.pop(); if (s) { const t = makeTab(s); tabs.push(t); activate(t.id); } } },
        { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: () => { uiView.webContents.focus(); sendEvent('focus-omnibox'); } },
        { label: 'Find Anything', accelerator: 'CmdOrCtrl+K', click: () => { uiView.webContents.focus(); sendEvent('palette-open'); } },
        { label: 'Pop Out Tab', accelerator: 'CmdOrCtrl+Shift+P', click: cmd('popout') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
        { label: 'Move Tab Up', accelerator: 'Alt+CmdOrCtrl+Up', click: () => moveTab({ id: activeId, dir: -1 }) },
        { label: 'Move Tab Down', accelerator: 'Alt+CmdOrCtrl+Down', click: () => moveTab({ id: activeId, dir: 1 }) },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View', submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: cmd('reload') },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => { uiView.webContents.focus(); sendEvent('focus-find'); } },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd('zoom', { dir: 1 }) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd('zoom', { dir: -1 }) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: cmd('zoom', { reset: true }) },
        { type: 'separator' },
        { label: 'One Tab', accelerator: 'CmdOrCtrl+Alt+1', click: cmd('split', { mode: 'single' }) },
        { label: 'Side by Side', accelerator: 'CmdOrCtrl+Alt+2', click: cmd('split', { mode: 'cols2' }) },
        { label: 'Top and Bottom', accelerator: 'CmdOrCtrl+Alt+3', click: cmd('split', { mode: 'rows2' }) },
        { label: 'Three Columns', accelerator: 'CmdOrCtrl+Alt+4', click: cmd('split', { mode: 'cols3' }) },
        { label: 'Grid of Four', accelerator: 'CmdOrCtrl+Alt+5', click: cmd('split', { mode: 'grid4' }) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => { const t = byId(activeId); if (t && t.view) t.view.webContents.toggleDevTools(); } },
      ],
    },
    {
      label: 'History', submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: cmd('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: cmd('forward') },
        { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: () => bookmarkTab(byId(activeId)) },
        { label: 'Bookmarks, History and Archived Tabs', accelerator: 'CmdOrCtrl+Y', click: cmd('open-page', { page: 'library' }) },
      ],
    },
    ...(kit('teacher') ? [{
      label: 'Live', submenu: [
        { label: 'Go Live / End Live', accelerator: 'CmdOrCtrl+Shift+L', click: () => setLive(!live) },
        { label: 'TAKE: Put Cued Tab On Air', accelerator: 'CmdOrCtrl+Enter', click: () => take() },
      ],
    }] : []),
    { label: 'Tools', submenu: toolMenu(cmd) },
    {
      label: 'Tab', submenu: [
        ...SPACES.map((n, i) => ({ label: `Space: ${n}`, accelerator: `Ctrl+${i + 1}`, click: () => switchSpace(n) })),
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => cycle(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => cycle(-1) },
        { label: 'Mute / Unmute Tab', accelerator: 'Ctrl+M', click: cmd('mute') },
        { label: 'Play / Pause Tab', accelerator: 'Ctrl+P', click: cmd('media', { cmd: 'toggle' }) },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, visible: false, click: () => { const o = spaceOrder(); const x = n === 9 ? o[o.length - 1] : o[n - 1]; if (x) activate(x.id); } })),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
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
setInterval(() => {
  const mins = settings && store ? settings().sleepMinutes : 30;
  const cutoff = Date.now() - mins * 60000;
  const visible = new Set(panes.map((p) => p.id));
  for (const t of tabs) {
    if (!t.view || t.host !== 'main' || visible.has(t.id) || t.id === activeId) continue;
    if (t.audible || t.playing || t.lastActive > cutoff) continue;
    destroyView(t);
  }
  pushState();
}, 60000);

setInterval(() => { if (store) { archiveOldTabs(); checkBills(); tidyInstallers(); loadRepos(); } }, 3600000);

// ---------------------------------------------------------------- start
async function setupBlocker() {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const cache = path.join(app.getPath('userData'), 'blocker.bin');
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache, read: fs.promises.readFile, write: fs.promises.writeFile,
    });
    // Blocker scripts clash with YouTube's player pages, and YouTube Studio must behave exactly as in Chrome.
    blocker.updateFromDiff({ added: ['@@||youtube.com^$document', '@@||youtube-nocookie.com^$document', '@@||ytimg.com^', '@@||googlevideo.com^'] });
    const inject = blocker.onInjectCosmeticFilters;
    blocker.onInjectCosmeticFilters = async (e, url, msg) => (/^https:\/\/([\w-]+\.)*(youtube\.com|youtube-nocookie\.com)\//.test(url) ? undefined : inject(e, url, msg));
    for (const ses of sessionsReady) enableBlocker(ses);
  } catch (e) { console.error('blocker', e.message); }
}

function createMain() {
  const b = store.data.bounds || { width: 1440, height: 900 };
  mainWin = new BaseWindow({
    ...b, minWidth: 760, minHeight: 480, title: 'Cue', backgroundColor: '#E3E6E9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', trafficLightPosition: { x: 16, y: 18 },
  });
  uiView = new WebContentsView({ webPreferences: { preload: UI_PRELOAD, contextIsolation: true, sandbox: true } });
  uiView.setBackgroundColor('#00000000');
  mainWin.contentView.addChildView(uiView);
  uiView.webContents.loadFile(UI_HTML);
  uiView.webContents.on('did-finish-load', () => { sendState(); if (process.env.CUE_SMOKE) { console.log('CUE_SMOKE_OK'); app.quit(); } });
  mainWin.on('resize', () => { layout(); store.data.bounds = mainWin.getBounds(); store.save(); });
  mainWin.on('move', () => { store.data.bounds = mainWin.getBounds(); store.save(); });
  mainWin.on('closed', () => { mainWin = null; if (stageWin && !stageWin.isDestroyed()) stageWin.destroy(); app.quit(); });

  const saved = store.data.tabs || [];
  for (const s of saved) tabs.push(makeTab(s));
  if (!tabs.length) tabs.push(makeTab({ url: START_URL }));
  const first = tabs[Math.max(0, Math.min(store.data.activeIndex || 0, tabs.length - 1))];
  store.data.split = { mode: 'single', ids: [] };
  activate(first.id);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', (_e, argv) => {
  if (!mainWin) return;
  mainWin.focus();
  const url = argv.find((x) => /^https?:\/\//.test(x)); if (url) openTab({ url });
});
let pendingUrls = [];
app.on('open-url', (e, url) => { e.preventDefault(); if (mainWin) openTab({ url }); else pendingUrls.push(url); });

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'), 'cue.json', {
    tabs: [], activeIndex: 0, bounds: null, split: { mode: 'single', ids: [] }, collapsed: {}, permissions: {},
    space: 'Teach', spaceSplit: {}, aiWhich: 'claude', bills: [], usdToInr: 88, alerts: [], archived: [], installersOpened: [],
    settings: {
      autoGroup: true, onePlayer: true, syncScroll: false, originalSound: false, safeShare: true,
      stageWidth: 1920, stageHeight: 1080, obs: { host: '127.0.0.1', port: 4455, password: '' },
      defaultIdentity: 'personal', identityLabels: { personal: '', school: '', agent: '' }, agentPort: true, sleepMinutes: 30,
    },
  });
  store.data.settings = { ...{ autoGroup: true, onePlayer: true, syncScroll: false, originalSound: false, safeShare: true, stageWidth: 1920, stageHeight: 1080, defaultIdentity: 'personal', agentPort: true, sleepMinutes: 30, archiveDays: 7, cacheCapMB: 1024, lowDiskGB: 5, tidyInstallers: true, githubUser: '' }, ...store.data.settings };
  store.data.settings.kits = { teacher: true, music: true, creator: true, designer: true, video: true, business: true, ...(store.data.settings.kits || {}) };
  store.data.settings.spaceLogins = { Teach: 'school', Create: 'personal', Business: 'school', Build: 'personal', ...(store.data.settings.spaceLogins || {}) };
  extDir = path.join(app.getPath('userData'), 'extensions');
  lib = new Library(app.getPath('userData'));
  vault = new Vault(app.getPath('userData'));
  vault.autoForOwnSites();
  store.data.settings.obs = { host: '127.0.0.1', port: 4455, password: '', ...(store.data.settings.obs || {}) };
  store.data.settings.identityLabels = { personal: '', school: '', agent: '', ...(store.data.settings.identityLabels || {}) };
  obs.onStatus = () => pushState();
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    const t = byId(recTabId);
    if (t && t.view) cb({ video: t.view.webContents.mainFrame, audio: t.view.webContents.mainFrame }); else cb({});
  });
  buildMenu();
  createMain();
  checkBills(); tidyInstallers(); loadRepos();
  pendingUrls.forEach((url) => openTab({ url })); pendingUrls = [];
  setupBlocker();
  startThumbs();
  if (settings().agentPort) {
    startAgentPort({ port: AGENT_PORT, tokenFile: agentTokenFile(), api: agentApi })
      .catch((e) => logAgent({ tool: 'port', error: e.message }));
  }
  if (settings().obs.autoConnect) obs.connect(settings().obs);
  if (process.env.CUE_TEST) require(path.join(ROOT, '..', 'test', process.env.CUE_TEST === 'features' ? 'features.js' : 'in-app.js'))({ app, tabs, byId, openTab, activate, closeTab, setSplit, take, setLive, setVolume, setMuted, layout, captureTab, lib, vault, store, addAlert, checkBills, archiveOldTabs, switchSpace, openPeek, closePeek, toggleAI, askAI, runTool, internal, sendEvent, setSetting, suggestions, addToBoard, lensFile, bookmarkTab, getPeek: () => peek, getAI: () => aiView, getState: () => ({ activeId, programId, live, panes, split: store.data.split }), win: () => mainWin, stage: () => stageWin, ui: () => uiView });
});

app.on('before-quit', () => { if (store) { persist(); store.flush(); } if (lib) lib.close(); });
app.on('window-all-closed', () => app.quit());
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
});
