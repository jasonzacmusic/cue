// The AI port: a local, token-protected door that lets Claude Code, Codex and other AI tools
// drive Cue. Agents read any normal tab, but may only click, type or run scripts in tabs they
// opened themselves or tabs you marked "Let AI agents use this tab". Private tabs, Vanish tabs
// and the tab that is on air are always off limits. Every call is logged.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

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

  const need = (t, act) => {
    if (!t) throw new Error('No tab with that id.');
    if (!api.canRead(t)) throw new Error('That tab is private or in a Vanish window. Agents cannot use it.');
    if (act && !api.canAct(t)) throw new Error('Agents can only act in tabs they opened, or tabs marked "Let AI agents use this tab". Open your own tab with the open tool (it can use the Personal or School logins).');
    api.ensure(t);
    return t.view.webContents;
  };
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
    navigate: async (a) => { const t = api.get(a.id); const wc = need(t, true); await wc.loadURL(a.url).catch(() => {}); await waitLoad(wc); return { url: wc.getURL(), title: wc.getTitle() }; },
    back: async (a) => { const t = api.get(a.id); const wc = need(t, true); if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); await waitLoad(wc); return { url: wc.getURL() }; },
    close: async (a) => { const t = api.get(a.id); need(t, true); api.close(t); return { closed: a.id }; },
    read: async (a) => {
      const t = api.get(a.id); const wc = need(t, false); await waitLoad(wc);
      const text = await wc.executeJavaScript('document.body ? document.body.innerText : ""', true);
      const max = Math.min(Number(a.maxChars) || 20000, 200000);
      return { id: t.id, title: wc.getTitle(), url: wc.getURL(), text: text.slice(0, max), truncated: text.length > max };
    },
    snapshot: async (a) => { const t = api.get(a.id); const wc = need(t, false); await waitLoad(wc); return { url: wc.getURL(), title: wc.getTitle(), elements: await wc.executeJavaScript(SNAPSHOT_JS, true) }; },
    screenshot: async (a) => { const t = api.get(a.id); need(t, false); const img = await api.capture(t); if (!img) throw new Error('Could not take a picture of that tab yet. Try again in a moment.'); const out = a.width ? img.resize({ width: Number(a.width) }) : img; return { mime: 'image/png', base64: out.toPNG().toString('base64') }; },
    click: async (a) => {
      const t = api.get(a.id); const wc = need(t, true);
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
      const t = api.get(a.id); const wc = need(t, true);
      if (a.ref || a.selector || a.text) {
        const p = await wc.executeJavaScript(findJS({ ref: a.ref, selector: a.selector, text: a.label }), true);
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
    press: async (a) => { const t = api.get(a.id); const wc = need(t, true); wc.sendInputEvent({ type: 'keyDown', keyCode: a.key }); wc.sendInputEvent({ type: 'keyUp', keyCode: a.key }); await sleep(150); return { pressed: a.key }; },
    scroll: async (a) => { const t = api.get(a.id); const wc = need(t, false); await wc.executeJavaScript(`window.scrollBy(0, ${Number(a.dy) || 600})`, true); return { ok: true }; },
    eval: async (a) => { const t = api.get(a.id); const wc = need(t, true); const r = await wc.executeJavaScript(String(a.script), true); return { result: r === undefined ? null : r }; },
    wait: async (a) => {
      const t = api.get(a.id); const wc = need(t, false); const end = Date.now() + Math.min(Number(a.ms) || 5000, 30000);
      while (Date.now() < end) {
        if (a.selector) { if (await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(a.selector)})`, true)) return { found: true }; }
        else if (a.text) { if (await wc.executeJavaScript(`document.body && document.body.innerText.includes(${JSON.stringify(a.text)})`, true)) return { found: true }; }
        else if (!wc.isLoading()) return { loaded: true };
        await sleep(200);
      }
      return { found: false };
    },
    problems: async (a) => { const t = api.get(a.id); need(t, false); return { url: t.url, problems: api.problems(t) }; },
    fullpage: async (a) => { const t = api.get(a.id); need(t, false); return api.fullPage(t); },
    alert: async (a) => { api.alert(a); return { ok: true }; },
    bills: async () => api.bills(),
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
    const m = req.url.match(/^\/tool\/(\w+)$/);
    if (!m || req.method !== 'POST' || !tools[m[1]]) return send(404, { error: 'Unknown tool.', tools: Object.keys(tools) });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      let args = {}; try { args = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'Body must be JSON.' }); }
      const agent = String(req.headers['x-agent'] || 'AI agent').slice(0, 40);
      try {
        const out = await tools[m[1]](args);
        api.log({ agent, tool: m[1], tab: args.id, url: args.url, ok: true });
        send(200, out);
      } catch (e) {
        api.log({ agent, tool: m[1], tab: args.id, ok: false, error: e.message });
        send(400, { error: e.message });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

module.exports = { startAgentPort };
