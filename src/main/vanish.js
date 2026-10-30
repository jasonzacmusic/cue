// The Vanish window: a separate dark window with no sidebar, no history, no AI, no bookmarks.
// Its tabs are kept here and never join Cue's own tab list, so nothing that saves, syncs or
// shares tabs can reach them. Closing the window wipes its memory-only session.
const { BaseWindow, WebContentsView, Menu, clipboard } = require('electron');
const path = require('path');

const BAR = 46;
const AUTH_PAGE = /^https:\/\/(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|github\.com\/login|www\.facebook\.com\/(v[\d.]+\/)?dialog)/;

function createVanish({ session, preload, uiPreload, uiFile, startFile, resolveInput, onClosed }) {
  let win = null; let ui = null; let activeId = null; let nextId = -1;
  const tabs = [];
  const byId = (id) => tabs.find((t) => t.id === id);

  function state() {
    if (!ui || ui.webContents.isDestroyed()) return;
    const a = byId(activeId);
    ui.webContents.send('vanish:state', {
      tabs: tabs.map((t) => ({ id: t.id, title: t.title, favicon: t.favicon, active: t.id === activeId, loading: t.loading })),
      url: a && !a.url.startsWith('file:') ? a.url : '', canBack: !!a && a.view.webContents.navigationHistory.canGoBack(), canFwd: !!a && a.view.webContents.navigationHistory.canGoForward(),
    });
  }

  function layout() {
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    ui.setBounds({ x: 0, y: 0, width: w, height: h });
    for (const t of tabs) {
      t.view.setBounds({ x: 0, y: BAR, width: w, height: Math.max(0, h - BAR) });
      t.view.setVisible(t.id === activeId);
    }
  }

  function keys(e, input) {
    if (input.type !== 'keyDown' || !(input.meta || input.control)) return;
    const k = input.key.toLowerCase(); const a = byId(activeId); const wc = a && a.view.webContents;
    const run = {
      t: () => add(),
      n: () => add(),
      w: () => { if (a) closeTab(a.id); },
      r: () => wc && wc.reload(),
      l: () => { ui.webContents.focus(); ui.webContents.send('vanish:focus'); },
      '[': () => wc && wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack(),
      ']': () => wc && wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward(),
    }[k];
    if (run) { e.preventDefault(); run(); }
  }

  function add(url) {
    if (!win) build();
    const view = new WebContentsView({ webPreferences: { session: session(), preload, contextIsolation: true, sandbox: true, spellcheck: false } });
    view.setBackgroundColor('#0B0B0D');
    const t = { id: nextId--, view, identity: 'vanish', url: url || startFile, title: 'Vanish', favicon: null, loading: false };
    tabs.push(t);
    win.contentView.addChildView(view);
    const wc = view.webContents;
    const sync = () => { t.url = wc.getURL(); state(); };
    wc.on('page-title-updated', (_e, title) => { t.title = title; state(); });
    wc.on('page-favicon-updated', (_e, f) => { t.favicon = f[0] || null; state(); });
    wc.on('did-navigate', sync); wc.on('did-navigate-in-page', sync);
    wc.on('did-start-loading', () => { t.loading = true; state(); });
    wc.on('did-stop-loading', () => { t.loading = false; sync(); });
    wc.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 500); });
    wc.on('before-input-event', keys);
    wc.on('context-menu', (_e, p) => {
      const items = [];
      if (p.linkURL) items.push({ label: 'Open link in new Vanish tab', click: () => add(p.linkURL) }, { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
      if (p.selectionText) items.push({ role: 'copy' });
      if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
      items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() }, { label: 'Reload', click: () => wc.reload() });
      Menu.buildFromTemplate(items).popup({ window: win });
    });
    wc.setWindowOpenHandler(({ url: u, disposition }) => {
      if (disposition === 'new-window' || AUTH_PAGE.test(u)) return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, webPreferences: { session: session() } } };
      add(u);
      return { action: 'deny' };
    });
    wc.loadURL(t.url).catch(() => {});
    activate(t.id);
    return t;
  }

  function activate(id) { if (!byId(id)) return; activeId = id; layout(); state(); byId(id).view.webContents.focus(); }

  function closeTab(id) {
    const t = byId(id); if (!t) return;
    tabs.splice(tabs.indexOf(t), 1);
    try { win.contentView.removeChildView(t.view); t.view.webContents.close(); } catch {}
    if (!tabs.length) { win.close(); return; }
    if (activeId === id) activate(tabs[tabs.length - 1].id); else { layout(); state(); }
  }

  function build() {
    win = new BaseWindow({
      width: 1180, height: 780, minWidth: 560, minHeight: 380, title: 'Vanish', backgroundColor: '#0B0B0D',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', trafficLightPosition: { x: 14, y: 15 },
    });
    win.setContentProtection(true); // kept out of Zoom shares, OBS and screenshots
    ui = new WebContentsView({ webPreferences: { preload: uiPreload, contextIsolation: true, sandbox: true } });
    ui.setBackgroundColor('#0B0B0D');
    win.contentView.addChildView(ui);
    ui.webContents.loadFile(uiFile);
    ui.webContents.on('did-finish-load', state);
    ui.webContents.on('before-input-event', keys);
    win.on('resize', layout);
    win.on('closed', () => {
      win = null; ui = null; activeId = null;
      tabs.splice(0).forEach((t) => { try { t.view.webContents.close(); } catch {} });
      wipe();
      if (onClosed) onClosed();
    });
  }

  async function wipe() {
    const ses = session();
    await ses.clearData().catch(() => {});
    await ses.clearAuthCache().catch(() => {});
    await ses.clearHostResolverCache().catch(() => {});
  }

  function command(cmd, a = {}) {
    const t = byId(activeId); const wc = t && t.view.webContents;
    if (cmd === 'navigate' && wc) { const u = resolveInput(a.text); t.url = u; wc.loadURL(u).catch(() => {}); wc.focus(); }
    if (cmd === 'back' && wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (cmd === 'forward' && wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (cmd === 'reload' && wc) wc.reload();
    if (cmd === 'new') add();
    if (cmd === 'activate') activate(a.id);
    if (cmd === 'close') closeTab(a.id);
  }

  return { add, closeTab, command, wipe, tabs, window: () => win, close: () => { if (win) win.close(); } };
}

module.exports = { createVanish };
