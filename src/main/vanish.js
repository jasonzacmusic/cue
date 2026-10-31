// The Vanish window: a separate dark window with no sidebar, no history, no AI, no bookmarks.
// Its tabs are kept here and never join Cue's own tab list, so nothing that saves, syncs or
// shares tabs can reach them. Closing the window wipes its memory-only session.
const { BaseWindow, WebContentsView, Menu, clipboard, screen } = require('electron');
const { whereToOpen, refuseOpen } = require('./signin');

const BAR = 86; // tab strip + address bar

function createVanish({ session, preload, uiPreload, uiFile, startFile, resolveInput, guardUrl, protect, onClosed }) {
  let win = null; let ui = null; let activeId = null; let nextId = -1; let full = false; // full: a video has taken over the window
  const tabs = [];
  const byId = (id) => tabs.find((t) => t.id === id);

  function state() {
    if (!ui || ui.webContents.isDestroyed()) return;
    const a = byId(activeId);
    ui.webContents.send('vanish:state', {
      tabs: tabs.map((t) => ({ id: t.id, title: t.url === startFile ? 'New tab' : t.title, favicon: t.favicon, active: t.id === activeId, loading: t.loading })),
      url: a && !a.url.startsWith('file:') ? a.url : '', canBack: !!a && a.view.webContents.navigationHistory.canGoBack(), canFwd: !!a && a.view.webContents.navigationHistory.canGoForward(),
    });
  }

  function layout() {
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    ui.setBounds({ x: 0, y: 0, width: w, height: h });
    for (const t of tabs) {
      t.view.setBounds(full ? { x: 0, y: 0, width: w, height: h } : { x: 0, y: BAR, width: w, height: Math.max(0, h - BAR) });
      t.view.setVisible(t.id === activeId);
    }
  }

  function focusBar() {
    if (!ui || ui.webContents.isLoading()) return;
    ui.webContents.focus(); ui.webContents.send('vanish:focus');
  }

  function step(by) {
    const i = tabs.indexOf(byId(activeId));
    if (i >= 0) activate(tabs[(i + by + tabs.length) % tabs.length].id);
  }

  function keys(e, input) {
    if (input.type !== 'keyDown' || !(input.meta || input.control)) return;
    const k = input.key.toLowerCase(); const a = byId(activeId); const wc = a && a.view.webContents;
    if (k === 'tab') { e.preventDefault(); step(input.shift ? -1 : 1); return; }
    if (input.alt && (input.key === 'ArrowLeft' || input.key === 'ArrowRight')) {
      e.preventDefault();
      if (a) move(a.id, tabs.indexOf(a) + (input.key === 'ArrowLeft' ? -1 : 1));
      return;
    }
    if (/^[1-9]$/.test(k)) { // Cmd+9 is always the last tab
      const t = k === '9' ? tabs[tabs.length - 1] : tabs[Number(k) - 1];
      e.preventDefault(); if (t) activate(t.id); return;
    }
    const run = {
      t: () => add(),
      n: () => add(),
      w: () => { if (a) closeTab(a.id); },
      r: () => wc && wc.reload(),
      l: focusBar,
      '[': () => wc && wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack(),
      ']': () => wc && wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward(),
      '{': () => step(-1),
      '}': () => step(1),
    }[k];
    if (run) { e.preventDefault(); run(); }
  }

  function add(url) {
    if (!win) build();
    else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } // it may be behind Cue or on another desktop
    const view = new WebContentsView({ webPreferences: { session: session(), preload, contextIsolation: true, sandbox: true, spellcheck: false } });
    view.setBackgroundColor('#0B0B0D');
    const t = { id: nextId--, view, identity: 'vanish', url: url || startFile, title: 'Vanish', favicon: null, loading: false };
    tabs.push(t);
    win.contentView.addChildView(view);
    const wc = view.webContents;
    const sync = () => { t.url = wc.getURL(); state(); };
    wc.on('page-title-updated', (_e, title) => { t.title = title; state(); });
    wc.on('page-favicon-updated', (_e, f) => { t.favicon = f[0] || null; state(); });
    wc.on('did-navigate', () => { t.favicon = null; sync(); }); wc.on('did-navigate-in-page', sync);
    wc.on('did-start-loading', () => { t.loading = true; state(); });
    wc.on('did-stop-loading', () => { t.loading = false; sync(); });
    wc.on('enter-html-full-screen', () => { full = true; win.setFullScreen(true); layout(); });
    wc.on('leave-html-full-screen', () => { full = false; win.setFullScreen(false); layout(); });
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
      if (refuseOpen(u, wc.getURL())) return { action: 'deny' };
      const where = whereToOpen(u, disposition, wc.getURL());
      if (where === 'popup') return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, webPreferences: { session: session() } } };
      if (where === 'here') wc.loadURL(guardUrl(u)).catch(() => {}); else add(u);
      return { action: 'deny' };
    });
    wc.on('did-create-window', (popup) => popup.setContentProtection(true));
    if (!url) wc.once('did-finish-load', () => { if (activeId === t.id) focusBar(); }); // the page takes focus when it lands
    protect(wc, t);
    wc.loadURL(guardUrl(t.url)).catch(() => {});
    activate(t.id);
    if (!url) focusBar();
    return t;
  }

  function activate(id) { if (!byId(id)) return; activeId = id; layout(); state(); byId(id).view.webContents.focus(); }

  function closeTab(id) {
    const t = byId(id); if (!t) return;
    const i = tabs.indexOf(t);
    if (full && id === activeId) { full = false; win.setFullScreen(false); }
    tabs.splice(i, 1);
    try { win.contentView.removeChildView(t.view); t.view.webContents.close(); } catch {}
    if (!tabs.length) { win.close(); return; }
    if (activeId === id) activate(tabs[Math.min(i, tabs.length - 1)].id); else { layout(); state(); }
  }

  function build() {
    win = new BaseWindow({
      ...screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea, // fills the screen you are on
      minWidth: 560, minHeight: 380, title: 'Vanish', backgroundColor: '#0B0B0D',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', trafficLightPosition: { x: 14, y: 13 },
    });
    win.setContentProtection(true); // kept out of Zoom shares, OBS and screenshots
    // The strip shares the wiped session, so tab icons never reach Cue's normal cache.
    ui = new WebContentsView({ webPreferences: { session: session(), preload: uiPreload, contextIsolation: true, sandbox: true } });
    ui.setBackgroundColor('#0B0B0D');
    win.contentView.addChildView(ui);
    ui.webContents.loadFile(uiFile);
    ui.webContents.on('did-finish-load', () => { state(); const a = byId(activeId); if (a && a.url === startFile) focusBar(); });
    ui.webContents.on('before-input-event', keys);
    win.on('resize', layout);
    win.on('leave-full-screen', () => { // the green button or a Mac gesture left full screen
      if (!full) return;
      full = false; layout();
      const a = byId(activeId);
      if (a) a.view.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
    });
    win.on('closed', () => {
      win = null; ui = null; activeId = null; full = false;
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

  // Vanish tabs live only in this array, so reordering IS the move: there is no
  // saved order to keep in step, which is why this never touches disk.
  function move(id, to) {
    const i = tabs.indexOf(byId(id));
    if (i < 0) return;
    const at = Math.max(0, Math.min(tabs.length - 1, to));
    if (at === i) return;
    tabs.splice(at, 0, tabs.splice(i, 1)[0]);
    state();
  }

  function command(cmd, a = {}) {
    const t = byId(activeId); const wc = t && t.view.webContents;
    if (cmd === 'navigate' && wc) { const u = guardUrl(resolveInput(a.text)); t.url = u; wc.loadURL(u).catch(() => {}); wc.focus(); }
    if (cmd === 'back' && wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (cmd === 'forward' && wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (cmd === 'reload' && wc) wc.reload();
    if (cmd === 'new') add();
    if (cmd === 'activate') activate(a.id);
    if (cmd === 'close') closeTab(a.id);
    if (cmd === 'move') move(a.id, a.to);
  }

  return { add, closeTab, command, wipe, tabs, activate, step, move, window: () => win, ui: () => ui, isFull: () => full, activeId: () => activeId, focused: () => !!win && win.isFocused(), close: () => { if (win) win.close(); } };
}

module.exports = { createVanish };
