// Files from this computer onto a page, for the agents. No native dialog, nothing brought forward.
//
// WHY THIS EXISTS. On 12-Nov-2026 an agent on another Mac had two PDFs to send and wrote "Cue
// blocks me from attaching files". It was right. The door had no tool for files, and every way
// round it fails: a page-script .click() on <input type=file> is refused by Chromium without a
// user gesture, and WITH one (cue_click, or eval, which runs with a gesture) Chromium asks the
// app for its native Open panel, which no agent can answer. Drag-and-drop cannot be faked from a
// page script with real files at all: a File made in the page is not the file on disk.
//
// HOW. Chromium's own DevTools protocol, through webContents.debugger - the same attachment that
// dresses every page in Chrome's identity (wearIdentity in main.js). It is shared, never detached
// here unless this file attached it itself.
//   - DOM.setFileInputFiles puts real files into a real <input type=file>, hidden or not, in the
//     page, in any same- or cross-origin iframe (each OOPIF is its own session, tracked below) and
//     inside open shadow roots. The page sees the input and change events a person's pick makes.
//   - A page that only makes its input when its button is clicked (common): file-chooser
//     interception (Page.setInterceptFileChooserDialog) is switched on, the button is clicked with
//     a gesture, and the chooser Chromium would have shown is answered with the files instead.
//   - A page that only has a drop zone: Input.dispatchDragEvent with the real paths at the zone.
// Elements are found from an isolated world in each frame, so the page's own scripts never see Cue.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_FILES = 25;

// ---------------------------------------------------------------- which files may go to a page
const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.3gp': 'video/3gpp',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.txt': 'text/plain',
  '.csv': 'text/csv', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.mid': 'audio/midi', '.midi': 'audio/midi', '.musicxml': 'application/vnd.recordare.musicxml+xml',
};
const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
// Photos and videos go to WhatsApp as media; everything else as a document.
const isMedia = (file) => /^(image|video)\//.test(mimeOf(file)) && !/svg/.test(mimeOf(file));
const human = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const within = (p, dir) => { const rel = path.relative(dir, p); return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel)); };
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// The rule, in one place: a page gets a file only from the computer user's own home, from /tmp,
// or from a mounted volume the path names. Never the computer's own settings, keys or keychains,
// and never Cue's own data folder (that is where its sign-ins and passwords live).
// `exempt`: folders inside a protected one that are still fine (Downloads, when a test puts it there).
function vetFiles(list, { protectedDirs = [], exempt = [], home = os.homedir() } = {}) {
  if (typeof list === 'string') list = [list];
  if (!Array.isArray(list) || !list.length) throw new Error('Say which files: "files" is a list of full paths on this computer, such as ["/Users/you/Downloads/Invoice.pdf"]. Nothing was attached.');
  if (list.length > MAX_FILES) throw new Error(`That is ${list.length} files; Cue attaches at most ${MAX_FILES} in one call. Nothing was attached.`);
  const homes = [...new Set([home, realOr(home)])];
  const system = [
    ...homes.map((h) => [path.join(h, 'Library'), 'it holds this computer\'s own settings, passwords and app data']),
    ...homes.flatMap((h) => ['.ssh', '.gnupg', '.aws'].map((d) => [path.join(h, d), 'it holds this computer\'s private keys'])),
  ];
  const cueData = protectedDirs.filter(Boolean).flatMap((d) => [d, realOr(d)]);
  const spared = exempt.filter(Boolean).flatMap((d) => [d, realOr(d)]);
  const why = (p) => {
    if (/(^|[\\/])Keychains([\\/]|$)|\.keychain(-db)?$/i.test(p)) return 'it is a keychain';
    const hit = system.find(([d]) => within(p, d));
    if (hit) return hit[1];
    if (cueData.some((d) => within(p, d)) && !spared.some((d) => within(p, d))) return 'it is Cue\'s own data folder, where its sign-ins and passwords are kept';
    return '';
  };
  const allowedRoot = (p) => homes.some((h) => within(p, h))
    || ['/tmp', '/private/tmp'].some((d) => within(p, d))
    || (process.platform === 'darwin' && /^\/Volumes\/[^/]+\/./.test(p))
    || (process.platform === 'linux' && /^\/(media|mnt)\/[^/]+\/./.test(p))
    || (process.platform === 'win32' && within(p, os.tmpdir()));
  const seen = new Set();
  return list.map((raw) => {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('Every entry in "files" must be a full path, as text. Nothing was attached.');
    let p = raw.trim();
    if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1));
    if (!path.isAbsolute(p)) throw new Error(`“${raw}” is not a full path. Give the whole path, starting with / (or ~/). Nothing was attached.`);
    p = path.resolve(p);
    // Refused by name first, so a guarded file is never even looked at.
    let bad = why(p);
    if (bad) throw new Error(`Cue will not give a web page anything from ${p}: ${bad}. Nothing was attached.`);
    let real;
    try { real = fs.realpathSync(p); } catch { throw new Error(`There is no file at ${p}. Nothing was attached.`); }
    bad = why(real);
    if (bad) throw new Error(`Cue will not give a web page ${p}: it leads to ${real}, and ${bad}. Nothing was attached.`);
    if (!allowedRoot(real)) throw new Error(`Cue only attaches files from your home folder, /tmp or a mounted drive under /Volumes. ${p} is outside them. Nothing was attached.`);
    let st;
    try { st = fs.statSync(real); } catch { throw new Error(`Cue could not look at ${p}. Nothing was attached.`); }
    if (st.isDirectory()) throw new Error(`${p} is a folder. Attach the files inside it one by one (or zip it first). Nothing was attached.`);
    if (!st.isFile()) throw new Error(`${p} is not an ordinary file. Nothing was attached.`);
    try { fs.accessSync(real, fs.constants.R_OK); } catch { throw new Error(`Cue is not allowed to read ${p}. Nothing was attached.`); }
    if (seen.has(real)) throw new Error(`${path.basename(p)} is in the list twice. Nothing was attached.`);
    seen.add(real);
    return { path: real, name: path.basename(p), size: st.size, type: mimeOf(real) };
  });
}

// ---------------------------------------------------------------- the frames of a page
// Every cross-origin iframe is its own protocol session (wearIdentity auto-attaches them, flat).
// The sessions are remembered from the moment the page is made, so a file input three iframes
// deep is as reachable as one on the page itself.
function trackFrames(wc) {
  if (!wc || wc.__cueFrames) return;
  const frames = new Map();
  wc.__cueFrames = frames;
  try {
    wc.debugger.on('message', (_e, method, params) => {
      if (method === 'Target.attachedToTarget' && params && params.targetInfo && params.targetInfo.type === 'iframe') frames.set(params.sessionId, params.targetInfo.url || '');
      else if (method === 'Target.detachedFromTarget' && params) frames.delete(params.sessionId);
    });
  } catch {}
}

// The debugger, for the length of one call. Shared with wearIdentity: if it is attached already
// it is used as it is and left attached; if Cue attached it here, it is detached afterwards.
function session(wc) {
  const dbg = wc.debugger;
  let mine = false;
  if (!dbg.isAttached()) { dbg.attach('1.3'); mine = true; }
  const listeners = new Set();
  const onMsg = (_e, method, params, sid) => { for (const l of listeners) { try { l(method, params, sid); } catch {} } };
  dbg.on('message', onMsg);
  return {
    send: (method, params = {}, sid) => (sid ? dbg.sendCommand(method, params, sid) : dbg.sendCommand(method, params)),
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    children: () => [...(wc.__cueFrames || new Map()).keys()],
    close: () => { dbg.removeListener('message', onMsg); if (mine && !wc.__identity) { try { dbg.detach(); } catch {} } },
  };
}

// Runs in an isolated world of ONE frame: its document and every open shadow root inside it.
// Finds file inputs, the buttons that open a chooser, and drop zones, and keeps the elements
// (globalThis.__cueEls) for the next step. Plain data comes back, never markup.
const FINDER = (o) => `(() => {
  const o = ${JSON.stringify(o)};
  const roots = [];
  const walk = (root) => { roots.push(root); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot); };
  walk(document);
  const all = (sel) => { const out = []; for (const r of roots) { try { out.push(...r.querySelectorAll(sel)); } catch (e) { return null; } } return out; };
  const shown = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05; };
  const words = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tooltip'), el.getAttribute('data-icon'), el.getAttribute('command'), el.innerText, el.value]
    .filter((s) => typeof s === 'string' && s).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const where = (el) => { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; else if (el.getAttribute('name')) s += '[name=' + el.getAttribute('name') + ']'; if (el.getRootNode() !== document) s += ' (in a shadow root)'; return s; };
  const labelOf = (el) => {
    let t = el.getAttribute('aria-label') || el.title || '';
    if (!t && el.id) { const l = all('label[for="' + CSS.escape(el.id) + '"]'); if (l && l[0]) t = l[0].innerText; }
    if (!t && el.closest('label')) t = el.closest('label').innerText;
    if (!t && el.parentElement) t = el.parentElement.innerText || '';
    return String(t).replace(/\\s+/g, ' ').trim().slice(0, 60);
  };
  const isFile = (el) => el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'file';
  const scope = o.scope ? (all(o.scope) || [])[0] : null;
  // Asked to look only inside one element: a frame without it offers nothing.
  if (o.scope && !scope) { globalThis.__cueEls = { i: [], c: [], z: [] }; return { inputs: [], controls: [], zones: [], title: document.title, url: location.href, main: window === window.top }; }
  const ok = (el) => !scope || scope.contains(el) || (el.getRootNode() !== document && scope.contains(el.getRootNode().host));
  const ATTACH = /\\b(attach(ment)?s?|upload|choose files?|select files?|browse|add files?|add (a )?photos?|insert files?|paperclip|clip|attach-menu-plus|plus-rounded)\\b/i;
  let inputs = [], controls = [], zones = [];
  if (o.selector) {
    const picked = all(o.selector);
    if (picked === null) return { badSelector: true };
    for (const el of picked.filter(ok)) {
      if (isFile(el)) inputs.push(el);
      else if (el.tagName === 'LABEL' && isFile(el.control)) inputs.push(el.control);
      else if (isFile(el.querySelector && el.querySelector('input[type=file]'))) inputs.push(el.querySelector('input[type=file]'));
      else controls.push(el);
    }
  } else {
    inputs = (all('input[type=file]') || []).filter(ok);
    if (o.controlText) {
      const re = new RegExp(o.controlText, 'i');
      controls = (all('button,[role=button],[role=menuitem],li,a,label,div[command],span[data-icon],[aria-label],[data-tooltip],[title]') || [])
        .filter(ok).filter(shown).filter((el) => re.test(words(el)));
    } else {
      controls = (all('button,[role=button],a,label,div[command],[aria-label],[data-tooltip],[title]') || [])
        .filter(ok).filter(shown).filter((el) => { const r = el.getBoundingClientRect(); return r.width * r.height < 160000 && ATTACH.test(words(el)); });
    }
    // Never a link that would take the tab somewhere else.
    const leaves = (el) => el.tagName === 'A' && el.getAttribute('href') && !/^(#|javascript:)/i.test(el.getAttribute('href'));
    controls = controls.filter((el) => !leaves(el));
    // Drop zones: what says so in its markup, or the smallest box whose own words say "drop".
    const marked = (all('[data-dropzone],[dropzone],.dropzone,.drop-zone,[class*="drop" i],[id*="drop" i],[aria-dropeffect]') || []).filter(ok).filter(shown);
    const said = (all('div,section,label,form,main,article,span,p') || []).filter(ok).filter(shown).filter((el) => /\\b(drag|drop)\\b/i.test(el.innerText || '') && (el.innerText || '').length < 300);
    zones = [...new Set([...marked, ...said])];
    zones = zones.filter((z) => !zones.some((y) => y !== z && z.contains(y) && marked.includes(y)));
    zones.sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (b.getBoundingClientRect().width * b.getBoundingClientRect().height));
  }
  // Inner elements of a control (an icon inside its button) are the same control.
  controls = controls.filter((c) => !controls.some((d) => d !== c && d.contains(c)));
  globalThis.__cueEls = { i: inputs, c: controls, z: zones };
  return {
    inputs: inputs.map((el, k) => ({ k, accept: el.getAttribute('accept') || '', multiple: !!el.multiple, disabled: !!el.disabled, visible: shown(el), label: labelOf(el), where: where(el), has: el.files ? el.files.length : 0 })),
    controls: controls.slice(0, 12).map((el, k) => ({ k, label: words(el).slice(0, 60), where: where(el) })),
    zones: zones.slice(0, 6).map((el, k) => ({ k, label: (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 60), where: where(el) })),
    title: document.title, url: location.href, main: window === window.top,
  };
})()`;

// Does this <input accept="..."> take this file? Empty accept takes anything.
function accepts(accept, file) {
  const list = String(accept || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length || list.includes('*') || list.includes('*/*')) return true;
  const ext = path.extname(file.name).toLowerCase();
  const type = file.type.toLowerCase();
  return list.some((a) => (a.startsWith('.') ? a === ext : a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : a === type));
}

function makeAttach() {
  // Every frame of the page, each searched from its own isolated world.
  async function scan(c, opts) {
    const found = [];
    const seenFrames = new Set();
    for (const sid of [undefined, ...c.children()]) {
      let tree;
      try { tree = await c.send('Page.getFrameTree', {}, sid); } catch { continue; }
      const frames = [];
      const flat = (n) => { frames.push(n.frame); (n.childFrames || []).forEach(flat); };
      flat(tree.frameTree);
      for (const f of frames.slice(0, 30)) {
        if (seenFrames.has(f.id)) continue;
        let ctx;
        try { ctx = (await c.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'cue-files', grantUniveralAccess: false }, sid)).executionContextId; } catch { continue; }
        let r;
        try { r = await c.send('Runtime.evaluate', { expression: FINDER(opts), contextId: ctx, returnByValue: true }, sid); } catch { continue; }
        const v = r && r.result && r.result.value;
        if (!v) continue;
        seenFrames.add(f.id);
        found.push({ sid, ctx, frameId: f.id, ...v });
      }
    }
    return found;
  }
  const objectOf = async (c, where, list, k) => {
    const r = await c.send('Runtime.evaluate', { expression: `globalThis.__cueEls.${list}[${k}]`, contextId: where.ctx }, where.sid);
    if (!r.result || !r.result.objectId) throw new Error('The page changed while Cue was attaching. Nothing was attached.');
    return r.result.objectId;
  };
  const filesOn = async (c, sid, objectId) => {
    const r = await c.send('Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: 'function () { return this.files ? [...this.files].map((f) => ({ name: f.name, size: f.size })) : []; }' }, sid);
    return (r.result && r.result.value) || [];
  };
  const setFiles = async (c, sid, target, files) => {
    const params = { files: files.map((f) => f.path), ...target };
    try { await c.send('DOM.setFileInputFiles', params, sid); } catch (e) {
      // Some builds want the DOM agent to have seen the document first.
      await c.send('DOM.getDocument', { depth: 0 }, sid).catch(() => {});
      await c.send('DOM.setFileInputFiles', params, sid);
      void e;
    }
  };
  // What the page itself now says: the file names in its own text (preview chips, lists).
  const pageShows = async (c, files) => {
    const shown = [];
    for (const sid of [undefined, ...c.children()]) {
      try {
        const r = await c.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }, sid);
        const text = String((r.result && r.result.value) || '');
        for (const f of files) if (text.includes(f.name) && !shown.includes(f.name)) shown.push(f.name);
      } catch {}
    }
    return shown;
  };
  // Click a control with a user gesture, with the chooser intercepted, and answer the chooser.
  async function viaChooser(c, where, k, files, ms) {
    const sessions = [undefined, ...c.children()];
    for (const sid of sessions) {
      await c.send('Page.enable', {}, sid).catch(() => {});
      await c.send('Page.setInterceptFileChooserDialog', { enabled: true }, sid).catch(() => {});
    }
    let off = () => {};
    try {
      const opened = new Promise((ok) => { off = c.on((method, params, sid) => { if (method === 'Page.fileChooserOpened') ok({ ...params, sid }); }); });
      await c.send('Runtime.evaluate', {
        contextId: where.ctx, userGesture: true, awaitPromise: false,
        expression: `(() => { const el = globalThis.__cueEls.c[${k}]; el.scrollIntoView({ block: 'center' });
          const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 1 };
          for (const t of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
          el.click(); return true; })()`,
      }, where.sid);
      const got = await Promise.race([opened, sleep(ms).then(() => null)]);
      if (!got) return null;
      // A chooser for one file, asked for several: answered with nothing, the way Cancel would.
      if (files.length > 1 && got.mode === 'selectSingle') {
        await c.send('DOM.setFileInputFiles', { files: [], backendNodeId: got.backendNodeId }, got.sid).catch(() => {});
        return { single: true };
      }
      await setFiles(c, got.sid, { backendNodeId: got.backendNodeId }, files);
      let has = [];
      try {
        const node = await c.send('DOM.resolveNode', { backendNodeId: got.backendNodeId }, got.sid);
        if (node.object && node.object.objectId) has = await filesOn(c, got.sid, node.object.objectId);
      } catch {}
      return { has, mode: got.mode };
    } finally {
      off();
      for (const sid of sessions) {
        await c.send('Page.setInterceptFileChooserDialog', { enabled: false }, sid).catch(() => {});
        await c.send('Page.disable', {}, sid).catch(() => {});
      }
    }
  }
  // Drag the real files onto the zone, as a person dragging them from Finder would.
  async function viaDrop(c, where, k, files) {
    const r = await c.send('Runtime.evaluate', {
      contextId: where.ctx, returnByValue: true,
      expression: `(() => { const el = globalThis.__cueEls.z[${k}]; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    }, where.sid);
    const { x, y } = r.result.value;
    const data = { items: [], files: files.map((f) => f.path), dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await c.send('Input.dispatchDragEvent', { type, x, y, data }, where.sid);
      await sleep(60);
    }
  }

  // After the files are in: submit the box's own form, as its submit button would.
  async function submitForm(c, sid, objectId, wc) {
    const r = await c.send('Runtime.callFunctionOn', {
      objectId, userGesture: true, returnByValue: true,
      functionDeclaration: `function () {
        const f = this.form || (this.closest && this.closest('form'));
        if (!f) return 'no-form';
        const btn = f.querySelector('button[type=submit], input[type=submit], button:not([type])');
        if (f.requestSubmit) f.requestSubmit(btn || undefined); else f.submit();
        return 'sent';
      }`,
    }, sid);
    if (r.result && r.result.value === 'no-form') return 'There is no form around that file box, so nothing was submitted; the files are in the box, waiting.';
    await sleep(400);
    const end = Date.now() + 20000;
    while (wc.isLoading() && Date.now() < end) await sleep(100);
    return `Submitted its form; the tab is now at ${shortUrl(wc.getURL())}.`;
  }

  const placeOf = (fr) => (fr.main ? shortUrl(fr.url) : `an iframe from ${shortUrl(fr.url)}`);
  const describeInput = (i) => {
    const label = i.label ? ` “${i.label}”` : '';
    const hidden = i.visible ? '' : 'hidden ';
    return `the ${hidden}file box${label} (${i.where}) on ${placeOf(i.fr)}`;
  };

  // The one call. opts: selector (the input, or the button that opens the chooser), scope (only
  // look inside this element), controlText (a pattern for the button's words), submit, drop:false,
  // chooserMs. Returns { how, target, has, shows, submitted } or throws in plain words.
  async function attach(wc, files, opts = {}) {
    const c = session(wc);
    try {
      const many = files.length > 1;
      const why = [];
      const look = () => scan(c, { selector: opts.selector || null, scope: opts.scope || null, controlText: opts.controlText || null });
      let found = await look();
      if (found.some((f) => f.badSelector)) throw new Error(`“${opts.selector}” is not a CSS selector the page understands. Nothing was attached.`);

      // 1. A real file input that takes these files: visible ones first, then the page's own frame.
      const viaInput = async () => {
        const live = found.flatMap((fr) => fr.inputs.map((i) => ({ ...i, fr }))).filter((i) => !i.disabled);
        const fit = live.filter((i) => files.every((f) => accepts(i.accept, f)));
        if (live.length && !fit.length) why.push(`its file box takes only ${[...new Set(live.map((i) => i.accept))].join(' / ')}`);
        const ok = fit.filter((i) => !many || i.multiple);
        if (fit.length && !ok.length) why.push(`its file box takes one file at a time (it has no “multiple”) and you gave ${files.length}; attach them one call each if the page allows more than one`);
        ok.sort((a, b) => (Number(b.visible) - Number(a.visible)) || (Number(b.fr.main) - Number(a.fr.main)));
        const pick = ok[0];
        if (!pick) return null;
        const objectId = await objectOf(c, pick.fr, 'i', pick.k);
        await setFiles(c, pick.fr.sid, { objectId }, files);
        await sleep(200);
        const has = await filesOn(c, pick.fr.sid, objectId);
        const submitted = opts.submit ? await submitForm(c, pick.fr.sid, objectId, wc) : '';
        return { how: 'input', target: describeInput(pick), has, submitted };
      };
      // controlsOnly: the caller knows which button it means (WhatsApp's "Document"), so a file box
      // of the wrong kind elsewhere on the page is not taken instead.
      let done = opts.controlsOnly ? null : await viaInput();

      // 2. A button that opens a chooser (or a menu with the file box in it).
      if (!done) {
        const controls = found.flatMap((fr) => fr.controls.map((x) => ({ ...x, fr }))).slice(0, 3);
        for (const ctl of controls) {
          const got = await viaChooser(c, ctl.fr, ctl.k, files, opts.chooserMs || 3500);
          if (got && got.single) { why.push(`the chooser behind “${ctl.label}” takes one file at a time and you gave ${files.length}`); continue; }
          if (got) { done = { how: 'chooser', target: `the file chooser behind “${ctl.label || ctl.where}” on ${placeOf(ctl.fr)}`, has: got.has, submitted: '' }; break; }
          // No chooser, but the click may have opened a menu that holds a file box.
          if (opts.controlsOnly) { why.push(`clicking “${ctl.label || ctl.where}” opened no file chooser`); continue; }
          await sleep(300);
          found = await look();
          done = await viaInput();
          if (done) { done.target += ` (opened by “${ctl.label || ctl.where}”)`; break; }
          why.push(`clicking “${ctl.label || ctl.where}” opened no file chooser`);
        }
      }

      // 3. A drop zone on the page itself.
      if (!done && opts.drop !== false) {
        const zone = found.filter((fr) => fr.main && fr.zones.length).map((fr) => ({ ...fr.zones[0], fr }))[0];
        if (zone) {
          await viaDrop(c, zone.fr, zone.k, files);
          await sleep(500);
          done = { how: 'drop', target: `the drop zone “${zone.label || zone.where}” on ${placeOf(zone.fr)}`, has: [], submitted: '' };
        }
      }

      if (!done) {
        const frames = found.length;
        throw new Error(`Nothing on this page takes files${why.length ? `: ${why.join('; ')}` : ': no file box, no button that opens a file chooser, and no drop zone'} (looked in ${frames} frame${frames === 1 ? '' : 's'}). Nothing was attached.`);
      }
      done.shows = await pageShows(c, files);
      return done;
    } finally { c.close(); }
  }

  // Where files can go on this page, for cue_snapshot. Small on purpose.
  async function targets(wc) {
    const c = session(wc);
    try {
      const found = await scan(c, {});
      const inputs = found.flatMap((fr) => fr.inputs.map((i) => ({ where: i.where, label: i.label, accept: i.accept || 'anything', multiple: i.multiple, hidden: !i.visible, frame: fr.main ? 'page' : shortUrl(fr.url) })));
      const openers = found.flatMap((fr) => fr.controls.map((x) => ({ label: x.label, where: x.where, frame: fr.main ? 'page' : shortUrl(fr.url) })));
      const dropZones = found.filter((fr) => fr.main).flatMap((fr) => fr.zones.map((z) => ({ label: z.label, where: z.where })));
      return { inputs: inputs.slice(0, 10), openers: openers.slice(0, 6), dropZones: dropZones.slice(0, 4) };
    } finally { c.close(); }
  }

  return { attach, targets };
}

const shortUrl = (u) => { try { const x = new URL(u); return x.host + (x.pathname.length > 1 ? x.pathname.slice(0, 40) : ''); } catch { return String(u || '').slice(0, 40); } };

// Plain lines for the agent: what took the files, the files, and what the PAGE now says it has.
function sayAttached(r, files) {
  const lines = [`Attached ${files.length} file${files.length === 1 ? '' : 's'} to ${r.target}:`];
  for (const f of files) lines.push(`- ${f.name} · ${human(f.size)}`);
  const want = files.map((f) => f.name);
  const held = (r.has || []).map((h) => h.name);
  if (r.has && r.has.length) lines.push(`The page's file box now holds: ${r.has.map((h) => `${h.name} (${human(h.size)})`).join(', ')}.`);
  if (r.shows && r.shows.length) lines.push(`The page shows: ${r.shows.join(', ')}.`);
  const confirmed = want.every((n) => held.includes(n) || (r.shows || []).includes(n));
  if (!confirmed) lines.push(`Not confirmed: the page does not show ${want.filter((n) => !held.includes(n) && !(r.shows || []).includes(n)).join(', ')} yet. Look at the page (cue_read) before relying on it.`);
  if (r.submitted) lines.push(r.submitted);
  return { text: lines.join('\n'), confirmed };
}

module.exports = { vetFiles, trackFrames, makeAttach, sayAttached, accepts, isMedia, mimeOf, human, MAX_FILES };
