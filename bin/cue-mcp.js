#!/usr/bin/env node
// MCP bridge for Cue's AI port. Claude Code, Codex and other MCP clients run this over stdio;
// it forwards each tool call to the running Cue app on this computer.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN_FILES = [
  process.env.CUE_TOKEN_FILE,
  path.join(os.homedir(), 'Library/Application Support/Cue/agent-port.json'),
  path.join(process.env.APPDATA || '', 'Cue/agent-port.json'),
  path.join(os.homedir(), '.config/Cue/agent-port.json'),
].filter(Boolean);

function conn() {
  for (const f of TOKEN_FILES) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
  throw new Error('Cue is not running yet. Open Cue first, then try again.');
}

const id = { type: 'number', description: 'Tab id from cue_tabs' };
const TOOLS = [
  ['identities', 'List the logins Cue keeps signed in (Personal, School, AI agent) and which account each holds. Use one of these instead of asking the user to log in.', {}],
  ['tabs', 'List open tabs with id, title, address, login (identity), group, and whether you may act in them.', {}],
  ['open', 'Open a page in your own AI lane. Cue keeps ONE tab per site for you: calling this again for the same site reuses that tab and navigates it, so WhatsApp, the Learning Portal and YouTube each stay a single tab however many times you visit them. Do not try to manage tabs yourself, and only pass newTab:true when you genuinely need two pages of the same site side by side. Pick identity "personal" or "school" to use the user\'s existing Google and other logins; "agent" is a clean login.', { url: { type: 'string', description: 'Address or search words' }, identity: { type: 'string', enum: ['agent', 'personal', 'school'] }, background: { type: 'boolean' }, newTab: { type: 'boolean', description: 'Force a second tab for a site you already have open. Rarely needed.' } }, ['url']],
  ['navigate', 'Go to an address in a tab you may act in.', { id, url: { type: 'string' } }, ['id', 'url']],
  ['back', 'Go back in a tab you may act in.', { id }, ['id']],
  ['read', 'Read the visible text of a tab.', { id, maxChars: { type: 'number' } }, ['id']],
  ['snapshot', 'List the clickable things and fields on a page, each with a ref to use with click and type.', { id }, ['id']],
  ['screenshot', 'Take a picture of a tab.', { id, width: { type: 'number', description: 'Resize to this width' } }, ['id']],
  ['click', 'Click an element by ref (from snapshot), CSS selector, or its visible text.', { id, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' } }, ['id']],
  ['type', 'Type into a field (found by ref, selector or label). Set submit to press Enter after.', { id, value: { type: 'string' }, ref: { type: 'string' }, selector: { type: 'string' }, label: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' } }, ['id', 'value']],
  ['press', 'Press a key such as Enter, Tab, Escape, Down.', { id, key: { type: 'string' } }, ['id', 'key']],
  ['scroll', 'Scroll a tab by dy pixels.', { id, dy: { type: 'number' } }, ['id']],
  ['wait', 'Wait for a selector or some text to appear, or for loading to finish.', { id, selector: { type: 'string' }, text: { type: 'string' }, ms: { type: 'number' } }, ['id']],
  ['eval', 'Run JavaScript in a tab you may act in and return the result.', { id, script: { type: 'string' } }, ['id', 'script']],
  ['volume', 'Set a tab\'s volume (0 to 1) or mute it.', { id, value: { type: 'number' }, muted: { type: 'boolean' } }, ['id']],
  ['close', 'Close a tab you opened.', { id }, ['id']],
  ['problems', 'List console errors, warnings and failed network requests a tab has had. Use this when testing an app to report what broke.', { id }, ['id']],
  ['fullpage', 'Save a picture of the whole page, however long, to the Cue Captures folder.', { id }, ['id']],
  ['alert', 'Put a message in the user\'s Cue alert tray, such as a failed deploy. It stays quiet during class.', { title: { type: 'string' }, body: { type: 'string' }, url: { type: 'string' }, source: { type: 'string' } }, ['title']],
  ['bills', 'List the subscriptions Cue is tracking with amounts in rupees, renewal dates and status.', {}],
].map(([name, description, props, required = []]) => ({ name: `cue_${name}`, description, inputSchema: { type: 'object', properties: props, required } }));

async function call(name, args) {
  const c = conn();
  const r = await fetch(`${c.url}/tool/${name.replace(/^cue_/, '')}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json', 'x-agent': process.env.CUE_AGENT_NAME || clientName || 'AI agent' },
    body: JSON.stringify(args || {}),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `Cue said ${r.status}`);
  return body;
}

let clientName = '';
function reply(msgId, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msgId, result }) + '\n'); }
function fail(msgId, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msgId, error: { code: -32000, message } }) + '\n'); }

async function handle(msg) {
  const { id: msgId, method, params } = msg;
  if (msgId === undefined) return; // notification
  if (method === 'initialize') {
    clientName = (params && params.clientInfo && params.clientInfo.name) || '';
    return reply(msgId, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'cue', version: '0.5.0' },
      instructions: 'Cue is the user\'s browser and he works in it while you do. Keep it tidy: Cue gives you ONE tab per site, so call cue_open as often as you like for the same site and it will reuse that tab rather than piling up new ones. Never open a second tab for a site you already have, and clean up with cue_close when a job is finished. Use cue_identities to see which logins are already signed in, then cue_open with identity "personal" or "school" to work inside those accounts without asking the user to log in. Work only in tabs you open, in the background, so you never steal the window he is using. Never use tabs marked private or on air.',
    });
  }
  if (method === 'ping') return reply(msgId, {});
  if (method === 'tools/list') return reply(msgId, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const out = await call(params.name, params.arguments);
      if (out && out.base64) return reply(msgId, { content: [{ type: 'image', data: out.base64, mimeType: out.mime || 'image/png' }] });
      return reply(msgId, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      return reply(msgId, { content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return fail(msgId, `Unknown method ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => fail(msg.id, e.message));
  }
});
