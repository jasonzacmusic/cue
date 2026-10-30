// Talks to a running Cue through the MCP bridge, the same way Claude Code or Codex would.
const { spawn } = require('child_process');
const path = require('path');

const p = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cue-mcp.js')], { env: { ...process.env, CUE_AGENT_NAME: 'Test agent' } });
let buf = ''; const waiting = new Map(); let n = 0;
p.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
});
const rpc = (method, params) => new Promise((r) => { const id = ++n; waiting.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = async (name, args) => {
  const m = await rpc('tools/call', { name: `cue_${name}`, arguments: args || {} });
  const c = m.result.content[0];
  return { error: !!m.result.isError, data: c.type === 'text' ? (() => { try { return JSON.parse(c.text); } catch { return c.text; } })() : `<${c.type} ${c.data.length} chars>` };
};

(async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'mcp-check' }, capabilities: {} });
  console.log('server:', init.result.serverInfo);
  const list = await rpc('tools/list', {});
  console.log('tools:', list.result.tools.map((t) => t.name).join(', '));
  console.log('identities:', JSON.stringify((await tool('identities')).data));
  const tabs = (await tool('tabs')).data;
  console.log('tabs:', tabs.length);
  const userTab = tabs.find((t) => !t.agentTab && !t.onAir);
  const refused = await tool('click', { id: userTab.id, text: 'anything' });
  console.log('act in user tab refused:', refused.error, '-', String(refused.data).slice(0, 90));
  const opened = (await tool('open', { url: 'https://apps.nathanielschool.com', identity: 'personal' })).data;
  console.log('opened:', opened);
  const snap = (await tool('snapshot', { id: opened.id })).data;
  console.log('snapshot elements:', snap.elements.length, snap.elements.slice(0, 4).map((e) => `${e.ref}:${e.label}`).join(' | '));
  const link = snap.elements.find((e) => e.tag === 'a' && /chord/i.test(e.label)) || snap.elements.find((e) => e.tag === 'a' && e.inView);
  const clicked = await tool('click', { id: opened.id, ref: link.ref });
  console.log('clicked:', link.label, '->', JSON.stringify(clicked.data));
  const read = (await tool('read', { id: opened.id, maxChars: 200 })).data;
  console.log('read:', read.title, '|', read.text.replace(/\s+/g, ' ').slice(0, 120));
  const shot = await tool('screenshot', { id: opened.id, width: 640 });
  console.log('screenshot:', shot.data);
  const q = (await tool('open', { url: 'G major scale' })).data;
  console.log('search as agent:', JSON.stringify(q).slice(0, 160));
  p.kill();
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); p.kill(); process.exit(1); });
