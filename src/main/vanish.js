// The Vanish window: a separate dark window with no sidebar, no history, no AI, no bookmarks.
// Its tabs are kept here and never join Cue's own tab list, so nothing that saves, syncs or
// shares tabs can reach them. Closing the window wipes its memory-only session.
const { BaseWindow, WebContentsView, Menu, clipboard, screen, dialog } = require('electron');
const { whereToOpen, refuseOpen } = require('./signin');
const { PICTURE_IN_PICTURE, protectedSite } = require('./video');
const vanishKeys = require('./vanish-keys');

const BAR = 86; // tab strip + address bar

// prefs() is Cue's settings, but Vanish reads only its own vanish* keys: it has nothing to do with
// how the main window's tabs open or play, and the main window's rules never reach in here.
function createVanish({ session, preload, uiPreload, uiFile, startFile, resolveInput, guardUrl, protect, prefs, drm, logo, onClosed, sounding }) {
  let win = null; let ui = null; let activeId = null; let nextId = -1; let full = false; // full: a video has taken over the window
  let winFull = false; // he asked for full screen himself (the key, or "Open Vanish in full screen")
  const pref = (k) => (prefs() || {})[k];
  // One place for a notice that belongs to Vanish: a line in its own toolbar, never the main window.
  const say = (text) => { if (ui && !ui.webContents.isDestroyed()) ui.webContents.send('vanish:note', String(text)); };
  // Closing the window empties its session, and that takes a moment. A Vanish tab opened in that
  // moment used to have its page cancelled by the clearing and sat there blank, which is why a new
  // Vanish tab sometimes did nothing. Pages now wait for the clearing to finish.
  let wiping = null;
  const whenWiped = (go) => { if (wiping) wiping.then(go, go); else go(); };
  // Netflix and its like use protected video, which Cue cannot play yet. The main
  // window has always said so rather than leaving a player spinning; in here it said
  // nothing at all, which looked like Vanish being broken. Said once per site per
  // window, and the window forgets it along with everything else when it closes.
  const toldProtected = new Set();
  const sayProtected = (url) => {
    // With Widevine loaded these sites simply play, in here too.
    if (typeof drm === 'function' && drm()) return;
    const name = protectedSite(url);
    if (!name || toldProtected.has(name) || !win || process.env.CUE_TEST) return;
    toldProtected.add(name);
    dialog.showMessageBox(win, {
      type: 'info', buttons: process.platform === 'darwin' ? ['Open in Safari', 'Stay Here'] : ['OK'],
      defaultId: 0, cancelId: 1,
      message: `${name} can't play its shows in Cue yet.`,
      detail: "It uses protected video, which Cue can't play yet. Everything else on the site works. Opening it in Safari leaves nothing behind in here either.",
    }).then((r) => {
      if (process.platform === 'darwin' && r.response === 0) require('child_process').execFile('/usr/bin/open', ['-a', 'Safari', url], () => {});
    });
  };
  const tabs = [];
  const byId = (id) => tabs.find((t) => t.id === id);

  function state() {
    if (!ui || ui.webContents.isDestroyed()) return;
    const a = byId(activeId);
    ui.webContents.send('vanish:state', {
      tabs: tabs.map((t) => ({ id: t.id, title: t.url === startFile ? 'New tab' : t.title, icons: icons(t), active: t.id === activeId, loading: t.loading && !t.favicon, muted: !!t.muted })),
      url: a && !a.url.startsWith('file:') ? a.url : '', canBack: !!a && a.view.webContents.navigationHistory.canGoBack(), canFwd: !!a && a.view.webContents.navigationHistory.canGoForward(),
    });
  }

  // Where a tab's logo can come from: the one the page names, then the site's usual address (most
  // sites never name one, and Cue's engine does not look there by itself), then a logo Cue ships.
  // Never Google's icon service, which the main window uses: that would tell Google the site.
  function icons(t) {
    const list = [t.favicon];
    if (/^https?:/.test(t.url)) {
      // A logo Cue ships goes FIRST where it has one: it is already on the disk,
      // it always draws, and it costs the site nothing. Then the page's own
      // icon, then the two addresses nearly every site keeps one at.
      const own = typeof logo === 'function' && logo(t.url);
      if (own) list.unshift(`../../assets/logos/${own}`);
      try {
        const o = new URL(t.url).origin;
        list.push(`${o}/favicon.ico`, `${o}/apple-touch-icon.png`, `${o}/favicon.png`);
      } catch {}
    }
    return [...new Set(list.filter(Boolean))];
  }

  // Cmd+ and Cmd- work here as in the main window, one tab at a time, kept in memory only.
  function zoom({ dir = 0, reset = false } = {}) {
    const a = byId(activeId); if (!a) return;
    a.zoom = reset ? 0 : Math.max(-8, Math.min(9, (a.zoom || 0) + dir * 0.5));
    a.view.webContents.setZoomLevel(a.zoom);
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

  // A Mac's own full screen moves the window to a desktop of its own, and the Mac can land on
  // Cue's main window on the way there or back. This fills the screen where the window already is.
  // A film leaving full screen does not take the window out of the full screen he asked for.
  function fillScreen(on) {
    if (!win || win.isFullScreen()) { layout(); return; } // the green button got there first
    const want = on || winFull;
    if (process.platform === 'darwin') win.setSimpleFullScreen(want); else win.setFullScreen(want);
    layout();
    if (on) { win.focus(); const a = byId(activeId); if (a) a.view.webContents.focus(); }
  }

  // Coming back from a full-screen film left no pointer and no scroll bar: the
  // window was still animating when the page was told its new size, and the
  // video had asked for the pointer to be hidden. Measure again once the
  // animation is over and nudge the mouse so the pointer comes back.
  function settle(t) {
    const again = () => {
      if (!t || !t.view || t.view.webContents.isDestroyed()) return;
      layout();
      try { t.view.webContents.focus(); } catch {}
      try {
        const b = t.view.getBounds();
        const x = Math.round(b.width / 2); const y = Math.round(b.height / 2);
        t.view.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        t.view.webContents.sendInputEvent({ type: 'mouseMove', x: x + 1, y: y + 1 });
      } catch {}
    };
    setTimeout(again, 120);
    setTimeout(again, 600);
  }

  function leaveFull(wc) {
    if (!full) return;
    wc.executeJavaScript('document.fullscreenElement ? document.exitFullscreen() : 0', true).catch(() => {});
    setTimeout(() => { if (full) { full = false; fillScreen(false); } }, 800); // the page never answered
  }

  // Every key comes from the one table in vanish-keys.js, which the menu and Settings read too.
  // A key the table does not name is left alone, and the main window's menu ignores it while
  // this window is in front (mainOnly in main.js).
  function keys(e, input, fromStrip) {
    const hit = vanishKeys.match(input);
    if (!hit) return;
    if (run(hit.id, { n: hit.n, fromStrip }) !== false) e.preventDefault();
  }

  function run(id, { n, fromStrip } = {}) {
    const a = byId(activeId); const wc = a && a.view.webContents;
    switch (id) {
      case 'open': case 'new': add(); return true;
      case 'close': if (a) closeTab(a.id); return true;
      case 'next': step(1); return true;
      case 'prev': step(-1); return true;
      case 'goto': { const t = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1]; if (t) activate(t.id); return true; } // Cmd+9 is always the last tab
      case 'play': if (wc) wc.send('cue:media', 'toggle'); return true;
      case 'mute': if (a) { a.muted = !wc.isAudioMuted(); wc.setAudioMuted(a.muted); state(); } return true;
      case 'find': openFind(); return true;
      case 'full': toggleFull(); return true;
      case 'leave':
        if (full) { if (a) leaveFull(wc); return true; }
        // Escape still reaches the page (a menu or a dialog on it may want it); it also leaves full screen.
        if (winFull && !fromStrip) toggleFull(false);
        return false;
      case 'forget': forget(); return true;
      case 'address': focusBar(); return true;
      case 'reload': if (wc) wc.reload(); return true;
      case 'back': if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return true;
      case 'forward': if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return true;
      case 'moveLeft': if (a) move(a.id, tabs.indexOf(a) - 1); return true;
      case 'moveRight': if (a) move(a.id, tabs.indexOf(a) + 1); return true;
      case 'zoomIn': zoom({ dir: 1 }); return true;
      case 'zoomOut': zoom({ dir: -1 }); return true;
      case 'zoomReset': zoom({ reset: true }); return true;
      case 'pip': pictureInPicture(); return true;
      default: return false;
    }
  }

  function toggleFull(on = !winFull) {
    if (!win) return;
    winFull = !!on;
    fillScreen(full);
  }

  // Find on the page, in a small box in the Vanish toolbar.
  let finding = '';
  function openFind() {
    if (!ui || ui.webContents.isDestroyed()) return;
    ui.webContents.focus(); ui.webContents.send('vanish:find-open');
  }
  function find({ text = '', back = false } = {}) {
    const a = byId(activeId); if (!a) return;
    const wc = a.view.webContents;
    if (!text) { finding = ''; wc.stopFindInPage('clearSelection'); ui.webContents.send('vanish:find-result', { active: 0, total: 0 }); return; }
    const again = text === finding; finding = text;
    wc.findInPage(text, { forward: !back, findNext: !again });
  }
  function stopFind() {
    finding = '';
    for (const t of tabs) { try { t.view.webContents.stopFindInPage('clearSelection'); } catch {} }
  }

  // "Close Vanish and forget everything": exactly what closing the last tab does - the window
  // closes, and its 'closed' handler empties the session.
  function forget() { if (win) win.close(); }

  function add(url, { from, background } = {}) {
    if (!win) build();
    else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } // it may be behind Cue or on another desktop
    const view = new WebContentsView({ webPreferences: { session: session(), preload, contextIsolation: true, sandbox: true, spellcheck: false, disableHtmlFullscreenWindowResize: true } });
    view.setBackgroundColor('#0B0B0D');
    view.webContents.setVisualZoomLevelLimits(1, 5).catch(() => {}); // pinch to zoom, as in the main window
    const t = { id: nextId--, view, identity: 'vanish', url: url || startFile, title: 'Vanish', favicon: null, loading: false, playing: false };
    // A link from a page either brings its new tab to the front (Vanish's own setting, "go" by
    // default) or opens it behind. Opened behind a video that is playing, it waits silent until
    // you go to it, so nothing starts talking over the film.
    const behind = !!from && (!!background || pref('vanishNewTab') === 'stay');
    if (behind && from.playing) t.calm = true;
    if (from && pref('vanishNewTabPlace') !== 'end') tabs.splice(tabs.indexOf(from) + 1, 0, t);
    else tabs.push(t);
    win.contentView.addChildView(view);
    const wc = view.webContents;
    const sync = () => { t.url = wc.getURL(); state(); };
    wc.on('page-title-updated', (_e, title) => { t.title = title; state(); });
    wc.on('page-favicon-updated', (_e, f) => { t.favicon = f[0] || null; state(); });
    wc.on('did-navigate', () => { t.favicon = null; sync(); sayProtected(wc.getURL()); }); wc.on('did-navigate-in-page', sync);
    wc.on('did-start-loading', () => { t.loading = true; state(); });
    wc.on('did-stop-loading', () => { t.loading = false; sync(); });
    wc.on('did-finish-load', () => { if (t.zoom) wc.setZoomLevel(t.zoom); }); // a new page keeps the tab's size
    wc.on('enter-html-full-screen', () => { full = true; fillScreen(true); });
    wc.on('leave-html-full-screen', () => { full = false; fillScreen(false); });
    wc.on('media-started-playing', () => {
      t.playing = true;
      if (t.calm) { t.held = true; wc.send('cue:media', 'pause'); return; }
      // A Vanish window is for watching, and he often has two things going at once - a match in
      // one tab, a film in another - so by default nothing here pauses anything else. With
      // "Only one video plays at a time in Vanish" on, the others in THIS window pause, once the
      // new one is really making sound (a silent hover preview pauses nothing). The main window's
      // tabs are never touched from here, and the main window's rule never reaches these tabs.
      if (!pref('vanishOnePlayer')) return;
      setTimeout(async () => {
        if (wc.isDestroyed() || !t.playing || !tabs.includes(t)) return;
        let loud = false;
        try { loud = wc.isCurrentlyAudible(); } catch {}
        if (!loud && sounding) loud = await wc.executeJavaScript(sounding, true).catch(() => false);
        if (!loud || !t.playing) return;
        for (const o of tabs) if (o !== t && o.playing && !o.view.webContents.isDestroyed()) o.view.webContents.send('cue:media', 'pause');
      }, 600);
    });
    wc.on('media-paused', () => { t.playing = false; });
    wc.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 500); });
    wc.on('before-input-event', keys);
    wc.on('context-menu', (_e, p) => {
      const items = [];
      if (p.linkURL) items.push({ label: 'Open link in new Vanish tab', click: () => add(p.linkURL, { from: t, background: true }) }, { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
      if (p.mediaType === 'video') items.push({ label: 'Picture in Picture', click: pictureInPicture }, { type: 'separator' });
      if (p.selectionText) items.push({ role: 'copy' });
      if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
      items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() }, { label: 'Reload', click: () => wc.reload() });
      Menu.buildFromTemplate(items).popup({ window: win });
    });
    wc.setWindowOpenHandler(({ url: u, disposition }) => {
      if (refuseOpen(u, wc.getURL())) return { action: 'deny' };
      const where = whereToOpen(u, disposition, wc.getURL());
      if (where === 'popup') return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, webPreferences: { session: session() } } };
      if (where === 'here') wc.loadURL(guardUrl(u)).catch(() => {}); else add(u, { from: t, background: disposition === 'background-tab' });
      return { action: 'deny' };
    });
    wc.on('did-create-window', (popup) => popup.setContentProtection(pref('vanishHideFromCapture') !== false));
    wc.on('found-in-page', (_e, r) => { if (ui && !ui.webContents.isDestroyed() && activeId === t.id) ui.webContents.send('vanish:find-result', { active: r.activeMatchOrdinal, total: r.matches }); });
    // Cue's own pages (Library, Bills, Boards) hold his history and his money; none of them opens
    // in here. The one exception is the dangerous-site warning, which Cue itself puts up.
    wc.on('will-navigate', (e, u) => { if (/^cue:/i.test(u)) { e.preventDefault(); say('Cue\u2019s own pages do not open in Vanish.'); } });
    if (!url) wc.once('did-finish-load', () => { if (activeId === t.id) focusBar(); }); // the page takes focus when it lands
    protect(wc, t);
    whenWiped(() => { if (!wc.isDestroyed()) wc.loadURL(guardUrl(t.url)).catch(() => {}); });
    if (behind) { layout(); state(); } else activate(t.id);
    if (!url) focusBar();
    return t;
  }

  function activate(id) {
    const t = byId(id); if (!t) return;
    const was = byId(activeId);
    if (full && was && was !== t) leaveFull(was.view.webContents);
    if (was && was !== t && finding) { stopFind(); if (ui && !ui.webContents.isDestroyed()) ui.webContents.send('vanish:find-result', { active: 0, total: 0, closed: true }); }
    activeId = id; layout(); state(); t.view.webContents.focus();
    if (t.calm) { t.calm = false; if (t.held) { t.held = false; t.view.webContents.send('cue:media', 'play'); } }
  }

  function pictureInPicture() {
    const a = byId(activeId);
    if (a) a.view.webContents.executeJavaScript(PICTURE_IN_PICTURE, true).catch(() => {});
  }

  function closeTab(id) {
    const t = byId(id); if (!t) return;
    const i = tabs.indexOf(t);
    if (full && id === activeId) { full = false; fillScreen(false); }
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
    // Kept out of Zoom shares, OBS and screenshots unless he turns that off in Settings > Vanish.
    win.setContentProtection(pref('vanishHideFromCapture') !== false);
    // The strip shares the wiped session, so tab icons never reach Cue's normal cache.
    ui = new WebContentsView({ webPreferences: { session: session(), preload: uiPreload, contextIsolation: true, sandbox: true } });
    ui.setBackgroundColor('#0B0B0D');
    win.contentView.addChildView(ui);
    ui.webContents.loadFile(uiFile);
    ui.webContents.on('did-finish-load', () => { state(); const a = byId(activeId); if (a && a.url === startFile) focusBar(); });
    ui.webContents.on('before-input-event', (e, input) => keys(e, input, true));
    win.on('resize', layout);
    // "Pause Vanish when I switch to another window": everything playing in here pauses when
    // this window loses the front. Off by default; nothing restarts by itself.
    win.on('blur', () => {
      if (!pref('vanishPauseOnBlur')) return;
      for (const t of tabs) if (t.playing && !t.view.webContents.isDestroyed()) t.view.webContents.send('cue:media', 'pause');
    });
    if (pref('vanishFullScreen')) { winFull = true; fillScreen(false); }
    win.on('leave-full-screen', () => { // the green button or a Mac gesture left full screen
      if (!full) return;
      full = false; layout();
      const a = byId(activeId);
      if (a) a.view.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
      settle(a);
    });
    win.on('closed', () => {
      win = null; ui = null; activeId = null; full = false; winFull = false; finding = '';
      tabs.splice(0).forEach((t) => { try { t.view.webContents.close(); } catch {} });
      wipe();
      if (onClosed) onClosed();
    });
  }

  function wipe() {
    const ses = session();
    const job = (async () => {
      await ses.clearData().catch(() => {});
      await ses.clearAuthCache().catch(() => {});
      await ses.clearHostResolverCache().catch(() => {});
    })();
    wiping = job;
    job.then(() => { if (wiping === job) wiping = null; });
    return job;
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
    if (cmd === 'navigate' && wc) {
      const asked = resolveInput(a.text);
      if (/^cue:/i.test(asked)) { say('Cue\u2019s own pages do not open in Vanish.'); return; }
      const u = guardUrl(asked); t.url = u; whenWiped(() => { if (!wc.isDestroyed()) wc.loadURL(u).catch(() => {}); }); wc.focus();
    }
    if (cmd === 'back' && wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (cmd === 'forward' && wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (cmd === 'reload' && wc) wc.reload();
    if (cmd === 'new') add();
    if (cmd === 'activate') activate(a.id);
    if (cmd === 'close') closeTab(a.id);
    if (cmd === 'move') move(a.id, a.to);
    if (cmd === 'zoom') zoom(a);
    if (cmd === 'find') find(a);
    if (cmd === 'find-close') { stopFind(); if (wc) wc.focus(); }
    if (cmd === 'run') run(a.id);
  }

  // A setting changed in Settings > Vanish takes effect in an open window there and then.
  function applyPrefs() {
    if (!win || win.isDestroyed()) return;
    win.setContentProtection(pref('vanishHideFromCapture') !== false);
  }

  const owns = (wc) => !!wc && (tabs.some((t) => t.view.webContents === wc) || (!!ui && ui.webContents === wc));
  return { add, closeTab, command, run, say, owns, applyPrefs, forget, toggleFull, pictureInPicture, wipe, zoom, wiping: () => wiping, tabs, activate, step, move, window: () => win, ui: () => ui, isFull: () => full, isWinFull: () => winFull, activeId: () => activeId, focused: () => !!win && win.isFocused(), close: () => { if (win) win.close(); } };
}

module.exports = { createVanish };
