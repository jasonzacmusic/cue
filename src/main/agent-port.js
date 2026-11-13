// The AI port: a local, token-protected door that lets Claude Code, Codex and other AI tools
// drive Cue. The door is his own switch and stays as he left it, across restarts:
// the token file can be read by anything running as you, so the token is not the permission. Agents read any normal tab, but may only click, type or run scripts in tabs they
// opened themselves or tabs you marked "Let AI agents use this tab". Private tabs, Vanish tabs
// and the tab that is on air are always off limits. Every call is logged.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function loadToken(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j.token) return j.token; } catch {}
  return crypto.randomBytes(24).toString('hex');
}

const SNAPSHOT_JS = `(() => {
  const els = [...document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=true],summary,label[for]')];
  const out = []; let n = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const st = getComputedStyle(el); if (st.visibility === 'hidden' || st.display === 'none') continue;
    const ref = 'c' + (++n); el.setAttribute('data-cue-ref', ref);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    out.push({ ref, tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', label, href: el.href || undefined, inView: r.top < innerHeight && r.bottom > 0 });
    if (out.length >= 300) break;
  }
  return out;
})()`;

function findJS(target) {
  return `(() => {
    const t = ${JSON.stringify(target)};
    let el = null;
    if (t.ref) el = document.querySelector('[data-cue-ref="' + t.ref + '"]');
    if (!el && t.selector) el = document.querySelector(t.selector);
    if (!el && t.text) {
      const want = t.text.toLowerCase();
      const c = [...document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=menuitem],input[type=submit],input[type=button],summary,label')];
      el = c.find(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase() === want)
        || c.find(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').toLowerCase().includes(want));
    }
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() };
  })()`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startAgentPort({ port, tokenFile, api }) {
  const token = loadToken(tokenFile);
  fs.writeFileSync(tokenFile, JSON.stringify({ url: `http://127.0.0.1:${port}`, token }, null, 2), { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600); // the mode above only applies when the file is new

  const need = (t, act) => {
    if (!t) throw new Error('No tab with that id.');
    if (!api.canRead(t)) throw new Error('That tab is private, in a Vanish window, or in a folder that is locked or not open to AI agents. Agents cannot use it.');
    if (act && api.paused && api.paused()) throw new Error('AI agents are paused in Cue. The person is working in these tabs themselves. Stop here and say so — do not try another way in. They resume agents with the AI row in the sidebar.');
    if (act && !api.canAct(t)) throw new Error('Agents can only act in tabs they opened, or tabs marked "Let AI agents use this tab". Open your own tab with the open tool (it can use the sign-ins of any folder cue_identities lists).');
    api.ensure(t);
    return t.view.webContents;
  };
  // The same checks, then the tab is woken for the agent (wake() in main.js): drawn at its real
  // size outside the window's visible area, so a background page reads as it would on screen.
  const needAwake = async (t, act) => { const wc = need(t, act); if (api.wake) await api.wake(t); return wc; };
  const waitLoad = async (wc, ms = 15000) => {
    const end = Date.now() + ms;
    while (wc.isLoading() && Date.now() < end) await sleep(100);
  };

  const tools = {
    identities: async () => api.identities(),
    tabs: async () => api.list(),
    open: async (a) => {
      const t = api.open(a);
      await waitLoad(t.view.webContents);
      return { id: t.id, title: t.view.webContents.getTitle(), url: t.view.webContents.getURL(), identity: t.identity };
    },
    navigate: async (a) => { const t = api.get(a.id); const wc = await needAwake(t, true); await wc.loadURL(api.safeUrl(a.url)).catch(() => {}); await waitLoad(wc); return { url: wc.getURL(), title: wc.getTitle() }; },
    back: async (a) => { const t = api.get(a.id); const wc = await needAwake(t, true); if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); await waitLoad(wc); return { url: wc.getURL() }; },
    close: async (a) => { const t = api.get(a.id); need(t, true); api.close(t); return { closed: a.id }; },
    read: async (a) => {
      const t = api.get(a.id); const wc = await needAwake(t, false); await waitLoad(wc);
      const text = await wc.executeJavaScript('document.body ? document.body.innerText : ""', true);
      const max = Math.min(Number(a.maxChars) || 20000, 200000);
      return { id: t.id, title: wc.getTitle(), url: wc.getURL(), text: text.slice(0, max), truncated: text.length > max };
    },
    snapshot: async (a) => {
      const t = api.get(a.id); const wc = await needAwake(t, false); await waitLoad(wc);
      const out = { url: wc.getURL(), title: wc.getTitle(), elements: await wc.executeJavaScript(SNAPSHOT_JS, true) };
      // Where files can go (hidden boxes, iframes and shadow roots included), for cue_attach.
      try {
        const f = api.fileTargets ? await api.fileTargets(t) : null;
        if (f && (f.inputs.length || f.openers.length || f.dropZones.length)) out.files = { ...f, how: 'Put files here with cue_attach: files:[full paths], and selector if there is more than one place.' };
      } catch {}
      return out;
    },
    screenshot: async (a) => { const t = api.get(a.id); need(t, false); const img = await api.capture(t); if (!img) throw new Error('Could not take a picture of that tab yet. Try again in a moment.'); const out = a.width ? img.resize({ width: Number(a.width) }) : img; return { mime: 'image/png', base64: out.toPNG().toString('base64') }; },
    click: async (a) => {
      const t = api.get(a.id); const wc = await needAwake(t, true);
      const p = await wc.executeJavaScript(findJS({ ref: a.ref, selector: a.selector, text: a.text }), true);
      if (!p) throw new Error('Could not find that element. Call snapshot first and click by ref.');
      await sleep(80);
      wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
      wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(300); await waitLoad(wc, 8000);
      return { clicked: p.tag, url: wc.getURL() };
    },
    type: async (a) => {
      const t = api.get(a.id); const wc = await needAwake(t, true);
      const label = a.label ?? a.text; // the field's label, under either name
      if (a.ref || a.selector || label) {
        const p = await wc.executeJavaScript(findJS({ ref: a.ref, selector: a.selector, text: label }), true);
        if (!p) throw new Error('Could not find that field.');
        wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        await sleep(60);
      }
      if (a.clear) { await wc.executeJavaScript('document.execCommand("selectAll")', true); }
      await wc.insertText(String(a.value ?? a.textToType ?? ''));
      if (a.submit) { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); await sleep(300); await waitLoad(wc); }
      return { typed: true, url: wc.getURL() };
    },
    press: async (a) => { const t = api.get(a.id); const wc = await needAwake(t, true); wc.sendInputEvent({ type: 'keyDown', keyCode: a.key }); wc.sendInputEvent({ type: 'keyUp', keyCode: a.key }); await sleep(150); return { pressed: a.key }; },
    scroll: async (a) => { const t = api.get(a.id); const wc = await needAwake(t, false); await wc.executeJavaScript(`window.scrollBy(0, ${Number(a.dy) || 600})`, true); return { ok: true }; },
    // Say so when the script is missing. String(undefined) is the word "undefined", which evaluates
    // to nothing and comes back as a perfectly innocent null - three calls in a row looked like the
    // page was empty when the real answer was that the caller had named the argument something else.
    eval: async (a) => {
      const t = api.get(a.id); const wc = await needAwake(t, true);
      if (typeof a.script !== 'string' || !a.script.trim()) return { error: 'eval needs "script": the JavaScript to run, as a string.' };
      const r = await wc.executeJavaScript(a.script, true);
      return { result: r === undefined ? null : r };
    },
    wait: async (a) => {
      const t = api.get(a.id); const wc = await needAwake(t, false); const end = Date.now() + Math.min(Number(a.ms) || 5000, 30000);
      while (Date.now() < end) {
        if (a.selector) { if (await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(a.selector)})`, true)) return { found: true }; }
        else if (a.text) { if (await wc.executeJavaScript(`document.body && document.body.innerText.includes(${JSON.stringify(a.text)})`, true)) return { found: true }; }
        else if (!wc.isLoading()) return { loaded: true };
        await sleep(200);
      }
      return { found: false };
    },
    problems: async (a) => { const t = api.get(a.id); need(t, false); return { url: t.url, problems: api.problems(t) }; },
    fullpage: async (a) => { const t = api.get(a.id); await needAwake(t, false); return api.fullPage(t); },
    alert: async (a) => { api.alert(a); return { ok: true }; },
    bills: async () => api.bills(),
    // One call, one answer in plain lines. No snapshot, no picture, no tab juggling.
    whatsapp: async (a) => api.whatsapp(a),
    gmail: async (a) => api.gmail(a),
    // Real files from this computer onto a page, with no dialog: a file box (hidden, in an iframe
    // or a shadow root), the chooser a button opens, or a drop zone. The files are checked first.
    attach: async (a) => {
      const files = api.vetFiles(a.files);
      let t;
      if (a.id !== undefined || a.tab !== undefined) t = api.get(a.id ?? a.tab);
      else if (a.url) { t = api.open({ url: a.url, identity: a.identity, background: true }); await waitLoad(t.view.webContents); }
      else throw new Error('Say which tab: id (from cue_tabs or cue_open), or identity and url to open the page first. Nothing was attached.');
      const wc = await needAwake(t, true);
      await waitLoad(wc);
      const r = await api.attachFiles(t, files, { selector: a.selector || null, submit: !!a.submit });
      const said = api.sayAttached(r, files);
      return { text: `${said.text}\n(tab ${t.id})`, confirmed: said.confirmed };
    },
    // Save a file into Downloads/Cue Agents with no save dialog; the answer is its full path.
    download: async (a) => { const t = api.get(a.id ?? a.tab); await needAwake(t, true); return api.download(t, a); },
    // ---- the teaching rig (Stream Deck pedal, OBS). These change what a
    // CLASS is looking at, so they are the rig's tools, not an AI agent's:
    // never call them to get a page in front of yourself.
    slots: async () => ({ slots: api.slots() }),
    show: async (a) => {
      const list = api.slots();
      const pick = a.slot !== undefined ? list[Number(a.slot) - 1] : list.find((t) => t.id === Number(a.id));
      if (!pick) throw new Error(a.slot !== undefined ? `There is no tab ${a.slot}.` : 'No such tab.');
      api.show(pick.id);
      return { showing: pick.id, slot: list.indexOf(pick) + 1, title: pick.title };
    },
    take: async () => { api.take(); return api.rig(); },
    front: async (a) => api.front({ focus: !!(a && a.focus) }),
    rig: async () => api.rig(),
    volume: async (a) => { const t = api.get(a.id); need(t, false); if (a.muted !== undefined) api.setMuted(t, !!a.muted); if (a.value !== undefined) api.setVolume(t, a.value); return { volume: t.volume, muted: t.muted }; },
  };

  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host) || req.headers.origin) return send(403, { error: 'Local AI tools only.' });
    if (req.url === '/health') return send(200, { app: 'cue', ready: true });
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Missing or wrong token.' });
    // The key alone is not permission. Anything running as you can read this
    // file, so the door itself has to be opened by hand, and only for as long
    // as Cue is open.
    if (!api.doorOpen()) {
      api.knock(String(req.headers['x-agent'] || 'An AI tool').slice(0, 40));
      return send(403, { error: 'The AI door is closed. In Cue, open Settings and switch on "Let AI agents drive Cue". It stays on until the person switches it off.' });
    }
    const m = req.url.match(/^\/tool\/(\w+)$/);
    if (!m || req.method !== 'POST' || !tools[m[1]]) return send(404, { error: 'Unknown tool.', tools: Object.keys(tools) });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      let args = {}; try { args = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'Body must be JSON.' }); }
      const agent = String(req.headers['x-agent'] || 'AI agent').slice(0, 40);
      // The NAMES of any files an agent hands a page go in the log, never what is in them.
      const list = Array.isArray(args.files) ? args.files : typeof args.files === 'string' ? [args.files] : [];
      const files = list.length ? { files: list.slice(0, 25).map((f) => path.basename(String(f))) } : {};
      const tab = args.id ?? (typeof args.tab === 'number' || /^\d+$/.test(String(args.tab ?? '')) ? args.tab : undefined);
      try {
        const out = await tools[m[1]](args);
        api.log({ agent, tool: m[1], tab, url: args.url, ...files, ok: true });
        send(200, out);
      } catch (e) {
        api.log({ agent, tool: m[1], tab, ...files, ok: false, error: e.message });
        send(400, { error: e.message });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

module.exports = { startAgentPort };
