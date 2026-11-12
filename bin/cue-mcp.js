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
  ['identities', 'List the folders you may work in: each person in Cue has a private folder with their own sign-ins, and only the unlocked folders the person has opened to AI agents are listed, plus "agent" (a clean login of your own). Each has an id, a name and the Google account it holds. Use one of these instead of asking anyone to log in.', {}],
  ['tabs', 'List the open tabs you may see, with id, title, address, folder (identity), group, and whether you may act in them.', {}],
  ['open', 'Open a page in your own AI lane. Cue keeps ONE tab per site for you: calling this again for the same site reuses that tab and navigates it, so WhatsApp, the Learning Portal and YouTube each stay a single tab however many times you visit them. Do not try to manage tabs yourself, and only pass newTab:true when you genuinely need two pages of the same site side by side. identity: a folder name or id from cue_identities, to work inside that folder\'s existing sign-ins; "agent" is a clean login.', { url: { type: 'string', description: 'Address or search words' }, identity: { type: 'string', description: 'A folder name or id from cue_identities, or "agent"' }, background: { type: 'boolean' }, newTab: { type: 'boolean', description: 'Force a second tab for a site you already have open. Rarely needed.' } }, ['url']],
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
  ['whatsapp', 'WhatsApp, in one call. Use this for anything on WhatsApp instead of opening web.whatsapp.com and clicking: it works in the tab that is already linked, in the background, and answers in short plain lines. who: a folder name or id from cue_identities - each folder is one person\'s WhatsApp, so always say which; it never guesses. action: "chats" (recent chats, or unreadOnly for the ones waiting), "read" (a conversation), "send" (a message, confirmed only when it is seen in the conversation), "search" (find a chat), "status" (is this account linked; show:true puts the tab in front for the one-time scan). chat: the FULL name as WhatsApp shows it, or a phone number ("+91 85003 50600" or "8500350600"); a part of a name works only when it fits one chat, otherwise it answers with the choices. Every read checks the open chat\'s full name before answering and fails loudly if it is not the one asked for. Calls on one account run one after another; different folders work side by side, and none is ever brought in front of the user. ATTACHING FILES: action "send" with files: [full paths on this computer] (up to 25; PDFs and other files go as documents, photos and videos as media; as:"document" sends a picture as a file) and an optional caption. No file dialog opens. It reports sent only once the file bubbles are seen in the chat. Example: {"who": "School", "action": "send", "chat": "Jolly Joseph", "files": ["/Users/me/Downloads/Jolly invoice.pdf", "/Users/me/Downloads/Jolly receipt.pdf"], "caption": "Your invoice and receipt"}',
    { who: { type: 'string', description: 'A folder name or id from cue_identities' },
      action: { type: 'string', enum: ['chats', 'read', 'send', 'search', 'status'] },
      chat: { type: 'string', description: 'Who the conversation is with, as it is named in WhatsApp' },
      message: { type: 'string', description: 'For send: exactly the words to send' },
      files: { type: 'array', items: { type: 'string' }, description: 'For send: full paths of files to send, e.g. ["/Users/me/Downloads/Invoice.pdf"]' },
      caption: { type: 'string', description: 'For send with files: words to go with them' },
      as: { type: 'string', enum: ['document', 'media'], description: 'For send with files: force documents or media; by default PDFs and other files go as documents, photos and videos as media' },
      query: { type: 'string', description: 'For search' },
      unreadOnly: { type: 'boolean' }, limit: { type: 'number' }, show: { type: 'boolean' } },
    ['who']],
  ['gmail', 'Gmail, in one call: search a mailbox, read whole emails, and write emails with attachments, as plain lines. Works in your own background Gmail tab of that folder (never the inbox the user is reading) and returns EVERY result row, not just the one a background tab shows. identity: a folder name or id from cue_identities - always say which. action: "search" (query in Gmail\'s own words: from:, subject:, newer_than:7d; up to 50 rows, each ending in its [id]), "read" (id from search: every message in that thread, with its full text; Gmail marks it read), "compose" (to, subject, body, files) or "reply" (id from search, body, files). ATTACHING FILES: files: [full paths on this computer]; no file dialog opens, and Cue waits until Gmail shows every attachment uploaded. compose and reply leave a DRAFT and say so; only send:true sends, confirmed from Gmail\'s "Message sent" and the Sent folder. Example: {"identity": "School", "action": "compose", "to": "jolly@example.com", "subject": "Your invoice", "body": "Hi Jolly, both attached.", "files": ["/Users/me/Downloads/Jolly invoice.pdf"]}',
    { identity: { type: 'string', description: 'A folder name or id from cue_identities' },
      action: { type: 'string', enum: ['search', 'read', 'compose', 'reply'] },
      query: { type: 'string', description: 'For search: Gmail search words' },
      id: { type: 'string', description: 'For read and reply: the [id] search printed' },
      limit: { type: 'number', description: 'For search: rows to return, up to 50' },
      to: { type: 'string', description: 'For compose: addresses, separated by commas' },
      cc: { type: 'string', description: 'For compose: addresses, separated by commas' },
      subject: { type: 'string', description: 'For compose' },
      body: { type: 'string', description: 'For compose and reply: the words of the email' },
      files: { type: 'array', items: { type: 'string' }, description: 'For compose and reply: full paths of files to attach' },
      send: { type: 'boolean', description: 'For compose and reply: true sends it; left out, it stays a draft' } },
    ['identity']],
  ['attach', 'Attach files from this computer to any web page (a job form, an uploader, a portal) with no file dialog and nothing brought in front of the user. Cue finds the place itself: a file box (even a hidden one, or one inside an iframe or a shadow root), the button that opens a file chooser, or a drop zone. files: full paths, up to 25, from the home folder, /tmp or a drive under /Volumes (never ~/Library, ~/.ssh, keychains or Cue\'s own data). Say the tab with id (one you may act in), or identity and url to open the page first. selector (optional): the file input, or the button that opens its chooser, when a page has more than one place. submit:true also submits the form the file box is in. The answer names what took the files and what the page now says it holds. cue_snapshot lists where a page takes files. For WhatsApp and Gmail use cue_whatsapp and cue_gmail with files instead. Example: {"id": 12, "files": ["/Users/me/Downloads/Invoice.pdf", "/Users/me/Downloads/Receipt.pdf"]}',
    { id, tab: { type: 'number', description: 'Same as id' },
      identity: { type: 'string', description: 'With url: the folder to open the page in, from cue_identities, or "agent"' },
      url: { type: 'string', description: 'With identity: open this page first, in your own tab' },
      files: { type: 'array', items: { type: 'string' }, description: 'Full paths of the files, e.g. ["/Users/me/Downloads/Invoice.pdf"]' },
      selector: { type: 'string', description: 'Optional CSS selector: the file input, or the button that opens the file chooser' },
      submit: { type: 'boolean', description: 'Also submit the form around the file box' } },
    ['files']],
  ['download', 'Save a file from a page into Downloads/Cue Agents with no save dialog, and get its full path back, so you can attach it somewhere else with cue_attach. id: a tab you may act in; url: the file\'s address, or selector: the link or button on the page that downloads it. Example: {"id": 12, "selector": "a.invoice-pdf"}',
    { id, url: { type: 'string', description: 'The file\'s address' }, selector: { type: 'string', description: 'The link or button that downloads it' } },
    ['id']],
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
      serverInfo: { name: 'cue', version: '0.7.0' },
      instructions: 'Cue is the user\'s browser and the user works in it while you do. Keep it tidy: Cue gives you ONE tab per site, so call cue_open as often as you like for the same site and it will reuse that tab rather than piling up new ones. Never open a second tab for a site you already have, and clean up with cue_close when a job is finished. Each person in Cue has a private folder. Use cue_identities to see the folders you may work in (locked folders and folders not opened to AI agents are never listed), then cue_open with identity set to one of those names or ids to work inside that folder\'s sign-ins without asking anyone to log in. Work only in tabs you open, in the background, so you never steal the window the person is using. Never use tabs marked private or on air. For WhatsApp, never open web.whatsapp.com and click: call cue_whatsapp, which works in the tab that is already linked and answers in a few plain lines. Say whose folder every time, by its name or id from cue_identities. To put files from this computer on a page, never click a file box (that opens a dialog nobody can answer): use cue_attach, or files on cue_whatsapp and cue_gmail; cue_download saves a file from a page and gives you its path.',
    });
  }
  if (method === 'ping') return reply(msgId, {});
  if (method === 'tools/list') return reply(msgId, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const out = await call(params.name, params.arguments);
      if (out && out.base64) return reply(msgId, { content: [{ type: 'image', data: out.base64, mimeType: out.mime || 'image/png' }] });
      // Some tools answer in lines a person could read. Those go through untouched: a page of
      // pretty-printed JSON costs the agent many times what the same answer costs as text.
      if (out && typeof out.text === 'string' && Object.keys(out).length <= 3) return reply(msgId, { content: [{ type: 'text', text: out.text }] });
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
