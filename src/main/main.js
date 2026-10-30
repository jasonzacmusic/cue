// Cue — the browser for people who make things.
// Main process: windows, tabs, identities, split views, the on-air stage and the AI port.
const {
  app, BaseWindow, WebContentsView, session, ipcMain, Menu, shell, dialog, desktopCapturer, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { groupFor, GROUP_LIST } = require('./groups');
const { OBS } = require('./obs');
const { startAgentPort } = require('./agent-port');

app.setName('Cue');
if (process.env.CUE_USER_DATA) app.setPath('userData', process.env.CUE_USER_DATA);
const ROOT = path.join(__dirname, '..');
const UI_HTML = path.join(ROOT, 'ui', 'index.html');
const STAGE_HTML = path.join(ROOT, 'ui', 'stage.html');
const START_URL = pathToFileURL(path.join(ROOT, 'ui', 'start.html')).href;
const TAB_PRELOAD = path.join(ROOT, 'preload', 'tab.js');
const UI_PRELOAD = path.join(ROOT, 'preload', 'ui.js');
const SIDEBAR = 264;
const TOOLBAR = 52;
const GAP = 6;
const AGENT_PORT = 8813;

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

const settings = () => store.data.settings;
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
    item.setSavePath(file);
    const d = { id: Date.now() + Math.random(), name: path.basename(file), file, received: 0, total: item.getTotalBytes(), state: 'progressing' };
    downloads.unshift(d); downloads.length = Math.min(downloads.length, 30);
    item.on('updated', (_ev, state) => { d.received = item.getReceivedBytes(); d.state = state; pushState(); });
    item.once('done', (_ev, state) => { d.state = state; d.received = d.total; pushState(); });
    pushState();
  });
  return ses;
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
    identity: IDENTITIES[opts.identity] ? opts.identity : settings().defaultIdentity,
    pinned: !!opts.pinned, groupOverride: opts.groupOverride || null, volume: opts.volume ?? 1, muted: !!opts.muted,
    private: !!opts.private, obsScene: opts.obsScene || '', agent: !!opts.agent, aiAllowed: !!opts.aiAllowed,
    order: opts.order ?? Date.now(), playing: false, audible: false, loading: false,
    view: null, host: 'main', popout: null, lastActive: Date.now(), canBack: false, canFwd: false, zoom: opts.zoom || 0,
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
  wc.on('page-title-updated', (_e, title) => { t.title = title; if (t.popout) t.popout.setTitle(`Cue · ${title}`); pushState(); persist(); });
  wc.on('page-favicon-updated', (_e, favs) => { t.favicon = favs[0] || null; pushState(); persist(); });
  const nav = () => {
    t.url = wc.getURL(); t.canBack = wc.navigationHistory.canGoBack(); t.canFwd = wc.navigationHistory.canGoForward();
    pushState(); persist();
  };
  wc.on('did-navigate', nav);
  wc.on('did-navigate-in-page', nav);
  wc.on('did-start-loading', () => { t.loading = true; pushState(); });
  wc.on('did-stop-loading', () => { t.loading = false; nav(); });
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
    if (disposition === 'new-window') {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, webPreferences: { session: sessionFor(t.identity) } } };
    }
    const nt = openTab({ url, identity: t.identity, background: disposition === 'background-tab', after: t, agent: t.agent });
    nt.groupOverride = t.groupOverride;
    return { action: 'deny' };
  });
}

function hostWindow(t) { return t.host === 'stage' ? stageWin : t.host === 'popout' ? t.popout : mainWin; }

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
    const next = tabs[Math.min(i, tabs.length - 1)];
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
  const { url, title, favicon, identity, pinned, groupOverride, volume, muted, private: p, obsScene, order, zoom, aiAllowed } = t;
  return { url, title, favicon, identity, pinned, groupOverride, volume, muted, private: p, obsScene, order, zoom, aiAllowed };
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
  return { x: SIDEBAR, y: TOOLBAR, width: Math.max(0, w - SIDEBAR), height: Math.max(0, h - TOOLBAR) };
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
    const ordered = sidebarOrder().filter((t) => t.host === 'main' && !(live && t.id === programId));
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
  if (on) {
    openStage();
  } else {
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
    const other = sidebarOrder().find((t) => t.id !== next.id);
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
    items.push({ label: 'Open link as…', submenu: ids.map((i) => ({ label: IDENTITIES[i].name, click: () => openTab({ url: p.linkURL, identity: i, after: t }) })) });
    items.push({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push({ label: 'Open image in new tab', click: () => openTab({ url: p.srcURL, identity: t.identity, after: t }) });
    items.push({ label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) });
    items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) });
    items.push({ label: 'Search this image with Google Lens', click: () => openTab({ url: 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(p.srcURL), identity: t.identity, after: t }) });
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
      host: t.host, canBack: t.canBack, canFwd: t.canFwd, crashed: !!t.crashed,
    })),
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
  e.returnValue = { volume: t ? t.volume : 1, originalSound: settings().originalSound, safe: !!(t && live && t.id === programId && settings().safeShare) };
});
ipcMain.on('cue:media-state', (e, playing) => { const t = byWC(e.sender); if (t) { t.playing = playing; pushState(); } });
ipcMain.on('cue:scroll', (e, ratio) => {
  const sp = store.data.split;
  if (!settings().syncScroll || sp.mode === 'single') return;
  const t = byWC(e.sender); if (!t || !sp.ids.includes(t.id)) return;
  for (const id of sp.ids) { const o = byId(id); if (o && o !== t && o.view) o.view.webContents.send('cue:scroll-to', ratio); }
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
    case 'set-scene': if (t) { t.obsScene = a.scene || ''; pushState(); persist(); } break;
    case 'agent-copy': clipboard.writeText(agentSetupText()); sendEvent('toast', 'AI setup copied.'); break;
    default: break;
  }
});

ipcMain.handle('ui:invoke', async (_e, cmd) => {
  if (cmd === 'obs-scenes') return obs.scenes();
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

function setSetting(key, value) {
  const s = settings();
  if (key.startsWith('obs.')) { s.obs[key.slice(4)] = key === 'obs.port' ? Number(value) || 4455 : value; }
  else if (key.startsWith('label.')) { s.identityLabels[key.slice(6)] = value; }
  else s[key] = value;
  store.save();
  if (key === 'originalSound') tabs.forEach((x) => x.view && x.view.webContents.send('cue:original-sound', value));
  if (key === 'safeShare') { const p = byId(programId); if (p && p.view) p.view.webContents.send('cue:safe', !!value); }
  pushState();
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
  canRead: (t) => t && t.identity !== 'vanish' && !t.private,
  canAct: (t) => agentCanAct(t),
  open: ({ url, identity = 'agent', background = true }) => {
    const t = openTab({ url: resolveInput(url), identity: IDENTITIES[identity] && identity !== 'vanish' ? identity : 'agent', background, agent: true });
    return t;
  },
  ensure: (t) => ensureView(t),
  capture: (t) => captureTab(t),
  close: (t) => closeTab(t.id),
  setMuted, setVolume,
  log: logAgent,
};

function agentCanAct(t) { return !!t && t.identity !== 'vanish' && !t.private && t.id !== programId && (t.agent || t.aiAllowed); }

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
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => { const s = closedStack.pop(); if (s) { const t = makeTab(s); tabs.push(t); activate(t.id); } } },
        { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: () => { uiView.webContents.focus(); sendEvent('focus-omnibox'); } },
        { label: 'Pop Out Tab', accelerator: 'CmdOrCtrl+Shift+P', click: cmd('popout') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
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
      ],
    },
    {
      label: 'Live', submenu: [
        { label: 'Go Live / End Live', accelerator: 'CmdOrCtrl+Shift+L', click: () => setLive(!live) },
        { label: 'TAKE: Put Cued Tab On Air', accelerator: 'CmdOrCtrl+Enter', click: () => take() },
      ],
    },
    {
      label: 'Tab', submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => cycle(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => cycle(-1) },
        { label: 'Mute / Unmute Tab', accelerator: 'Ctrl+M', click: cmd('mute') },
        { label: 'Play / Pause Tab', accelerator: 'Ctrl+P', click: cmd('media', { cmd: 'toggle' }) },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, visible: false, click: () => { const o = sidebarOrder(); const x = n === 9 ? o[o.length - 1] : o[n - 1]; if (x) activate(x.id); } })),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function cycle(d) {
  const o = sidebarOrder(); const i = o.findIndex((t) => t.id === activeId);
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

// ---------------------------------------------------------------- start
async function setupBlocker() {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const cache = path.join(app.getPath('userData'), 'blocker.bin');
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache, read: fs.promises.readFile, write: fs.promises.writeFile,
    });
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
  uiView.webContents.on('did-finish-load', sendState);
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
    settings: {
      autoGroup: true, onePlayer: true, syncScroll: false, originalSound: false, safeShare: true,
      stageWidth: 1920, stageHeight: 1080, obs: { host: '127.0.0.1', port: 4455, password: '' },
      defaultIdentity: 'personal', identityLabels: { personal: '', school: '', agent: '' }, agentPort: true, sleepMinutes: 30,
    },
  });
  store.data.settings = { ...{ autoGroup: true, onePlayer: true, syncScroll: false, originalSound: false, safeShare: true, stageWidth: 1920, stageHeight: 1080, defaultIdentity: 'personal', agentPort: true, sleepMinutes: 30 }, ...store.data.settings };
  store.data.settings.obs = { host: '127.0.0.1', port: 4455, password: '', ...(store.data.settings.obs || {}) };
  store.data.settings.identityLabels = { personal: '', school: '', agent: '', ...(store.data.settings.identityLabels || {}) };
  obs.onStatus = () => pushState();
  buildMenu();
  createMain();
  pendingUrls.forEach((url) => openTab({ url })); pendingUrls = [];
  setupBlocker();
  startThumbs();
  if (settings().agentPort) {
    startAgentPort({ port: AGENT_PORT, tokenFile: agentTokenFile(), api: agentApi })
      .catch((e) => logAgent({ tool: 'port', error: e.message }));
  }
  if (settings().obs.autoConnect) obs.connect(settings().obs);
  if (process.env.CUE_TEST) require(path.join(ROOT, '..', 'test', 'in-app.js'))({ app, tabs, byId, openTab, activate, setSplit, take, setLive, setVolume, setMuted, layout, captureTab, getState: () => ({ activeId, programId, live, panes, split: store.data.split }), win: () => mainWin, stage: () => stageWin, ui: () => uiView });
});

app.on('before-quit', () => { if (store) { persist(); store.flush(); } });
app.on('window-all-closed', () => app.quit());
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
});
