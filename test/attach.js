// Attach test: CUE_QUIET=1 CUE_MCP=1 CUE_AGENT_PORT=18871 CUE_TEST=attach CUE_USER_DATA=<new dir> CUE_OUT=<new dir> npx electron .
//
// Proves cue_attach puts REAL files from this computer onto a page with no native dialog and
// without bringing anything forward, through the real AI door (HTTP, with its token, logged) and,
// with CUE_MCP=1, through the real MCP bridge process too (bin/cue-mcp.js, as Claude Code runs it).
//
// The test site has one page per shape a real uploader takes: (a) a plain file box, (b) a hidden
// box behind a button, (c) a box made only when its button is clicked, (d) a box inside a
// cross-origin iframe, (e) one inside an open shadow root, (f) a drop zone and nothing else, and
// (g) a real multipart POST after attaching, where the server checks the bytes (sha256) of two
// generated PDFs and a PNG. Then the refusals, each in plain words, and cue_download.
//
// Optional: CUE_LIVE_WA=1 also opens the real web.whatsapp.com in a fresh agent-allowed folder
// (it shows the link screen; nothing is linked or sent) and checks the answer says "not linked".
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { dialog } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'cue-attach-'));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`[cue-attach] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 300)}` : ''}`); };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- files made for the test
function pdf(text) {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>'];
  const stream = `BT /F1 12 Tf 20 50 Td (${text}) Tj ET`;
  objs.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  let out = '%PDF-1.4\n'; const at = [];
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png() {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(4 * (1 + 16)); for (let y = 0; y < 4; y++) { raw[y * 17] = 0; for (let x = 0; x < 4; x++) { const o = y * 17 + 1 + x * 4; raw[o] = 40 * x; raw[o + 1] = 200; raw[o + 2] = 60 * y; raw[o + 3] = 255; } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- the test site
const LIST = `<ul id="list"></ul><script>
  function show(files) { document.getElementById('list').innerHTML = [...files].map((f) => '<li>' + f.name + ' ' + f.size + '</li>').join(''); }
</script>`;
function pages(port) {
  const other = `http://localhost:${port}`;
  return {
    '/a': `<!doctype html><title>Plain</title><form id="f" action="/upload" method="post" enctype="multipart/form-data">
      <label for="docs">Your documents</label><input type="file" id="docs" name="docs" multiple onchange="show(this.files)"><button>Send</button></form>${LIST}`,
    '/b': `<!doctype html><title>Hidden</title><input type="file" id="hid" accept=".pdf,application/pdf" multiple hidden onchange="show(this.files)">
      <button id="pick" onclick="document.getElementById('hid').click()">Choose PDFs</button>${LIST}`,
    '/c': `<!doctype html><title>Made on click</title><button id="up">Upload files</button>${LIST}<script>
      window.made = 0;
      document.getElementById('up').addEventListener('click', () => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; window.made++;
        i.addEventListener('change', () => show(i.files)); i.click(); });</script>`,
    '/d': `<!doctype html><title>Iframe</title><p>The uploader lives in another site's frame.</p><iframe id="fr" src="${other}/inner" width="400" height="200"></iframe>`,
    '/inner': `<!doctype html><title>Inner</title><input type="file" id="inner" multiple onchange="show(this.files)">${LIST}`,
    '/e': `<!doctype html><title>Shadow</title><up-loader></up-loader>${LIST}<script>
      customElements.define('up-loader', class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<input type="file" id="sh" multiple>'; r.querySelector('input').addEventListener('change', (e) => show(e.target.files)); } });</script>`,
    '/f': `<!doctype html><title>Drop</title><div id="zone" style="width:320px;height:200px;border:2px dashed #888">Drop files here</div>${LIST}<script>
      const z = document.getElementById('zone');
      z.addEventListener('dragover', (e) => e.preventDefault());
      z.addEventListener('drop', async (e) => { e.preventDefault(); const files = e.dataTransfer.files; show(files);
        const fd = new FormData(); for (const f of files) fd.append('dropped', f, f.name);
        await fetch('/upload', { method: 'POST', body: fd }); document.title = 'Dropped ' + files.length; });</script>`,
    '/s': `<!doctype html><title>One only</title><input type="file" id="one" onchange="show(this.files)">${LIST}`,
    '/n': `<!doctype html><title>Nothing</title><p>No uploads here.</p><a href="/a">Upload page</a>`,
    '/dl': `<!doctype html><title>Downloads</title><a id="get" href="/file/report.pdf">Report</a><button id="blob">Make one</button><script>
      document.getElementById('blob').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['made in the page'], { type: 'text/plain' })); a.download = 'made.txt'; a.click(); };</script>`,
  };
}
function parseMultipart(body, type) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type || ''); if (!m) return [];
  const sep = Buffer.from(`--${m[1] || m[2]}`);
  const out = []; let i = body.indexOf(sep);
  while (i >= 0) {
    const next = body.indexOf(sep, i + sep.length); if (next < 0) break;
    const part = body.slice(i + sep.length + 2, next - 2); // drop the CRLF after the boundary and before the next
    const h = part.indexOf('\r\n\r\n');
    const head = part.slice(0, h).toString();
    const fn = /filename="([^"]*)"/.exec(head);
    if (fn && fn[1]) out.push({ name: fn[1], sha: sha(part.slice(h + 4)), size: part.length - h - 4 });
    i = next;
  }
  return out;
}

module.exports = async (c) => {
  const { app, agentApi, tabs, command, setSetting, addFolder, setPasscode, lockFolder, getState, win } = c;
  let server;
  const dialogs = [];
  // A native dialog would be a failure: catch every way one could be asked for.
  for (const k of ['showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync', 'showMessageBox']) {
    const orig = dialog[k];
    dialog[k] = (...args) => { dialogs.push(k); console.log('[cue-attach] DIALOG ASKED FOR', k); return k.endsWith('Sync') ? undefined : Promise.resolve({ canceled: true, filePaths: [], response: 0 }); };
    void orig;
  }
  let focused = 0;
  app.on('browser-window-focus', () => { focused++; });
  let focusedAtStart = false;
  if (win()) win().on('focus', () => { focused++; console.log(`[cue-attach] window focus after check ${results.length}: ${(results[results.length - 1] || {}).name}`); });
  try {
    const uploads = [];
    server = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      if (req.method === 'POST' && u === '/upload') {
        const chunks = []; req.on('data', (d) => chunks.push(d));
        req.on('end', () => { const got = parseMultipart(Buffer.concat(chunks), req.headers['content-type']); uploads.push(got); res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>Received</title><p>Received ${got.map((g) => g.name).join(', ')}</p>`); });
        return;
      }
      if (u === '/file/report.pdf') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"' }); return res.end(pdf('Downloaded report')); }
      const p = pages(server.address().port)[u];
      res.writeHead(p ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(p || 'not here');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // The files: two small real PDFs and a PNG, in the test's own folder under /tmp.
    const dir = path.join(OUT, 'files'); fs.mkdirSync(dir, { recursive: true });
    const F = { a: path.join(dir, 'Jolly invoice.pdf'), b: path.join(dir, 'Jolly receipt.pdf'), p: path.join(dir, 'chord chart.png') };
    fs.writeFileSync(F.a, pdf('Invoice for Jolly')); fs.writeFileSync(F.b, pdf('Receipt for Jolly, paid')); fs.writeFileSync(F.p, png());
    const want = Object.fromEntries(Object.values(F).map((f) => [path.basename(f), sha(fs.readFileSync(f))]));

    // ---- the door, as an agent reaches it
    command('ai-door', { on: true });
    const tokenFile = path.join(app.getPath('userData'), 'agent-port.json');
    let conn = null;
    for (let i = 0; i < 50 && !conn; i++) { await sleep(100); try { conn = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch {} }
    const door = async (tool, args) => {
      const r = await fetch(`${conn.url}/tool/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json', 'x-agent': 'Attach test' }, body: JSON.stringify(args || {}) });
      const body = await r.json();
      return r.ok ? body : { error: body.error };
    };
    let up = null;
    for (let i = 0; i < 50 && !up; i++) { await sleep(100); try { up = await door('identities'); } catch {} }
    check('the AI door answers on its own port', Array.isArray(up), conn && conn.url);
    // The window settling at launch is not an agent's doing: count from here.
    await sleep(500); focused = 0; focusedAtStart = win() ? win().isFocused() : false;

    const frontBefore = getState().activeId;
    const openPage = async (p) => { const o = await door('open', { url: base + p, identity: 'agent', newTab: true }); await sleep(300); return o.id; };
    const pageText = (id) => agentApi.get(id).view.webContents.executeJavaScript('document.body.innerText', true);

    // ---- what happened before cue_attach (the cause of the block), shown safely: with the chooser
    // intercepted by the test itself, a script click on a file box - with a gesture (as cue_eval
    // and cue_click have) and, in Cue, even without one - asks Chromium for the native Open panel,
    // which no agent can answer. Measured 12-Nov-2026: both clicks asked.
    {
      const id = await openPage('/a');
      const wc = agentApi.get(id).view.webContents;
      await agentApi.wake(agentApi.get(id));
      const dbg = wc.debugger; let asked = 0;
      const on = (_e, m) => { if (m === 'Page.fileChooserOpened') asked++; };
      dbg.on('message', on);
      await dbg.sendCommand('Page.enable'); await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
      await wc.executeJavaScript('document.getElementById("docs").click()', false); await sleep(500);
      const noGesture = asked;
      await wc.executeJavaScript('document.getElementById("docs").click()', true); await sleep(500);
      check('today: a script click on a file box asks for the native Open panel, gesture or not', noGesture === 1 && asked === 2, { noGesture, withGesture: asked - noGesture });
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); await dbg.sendCommand('Page.disable');
      dbg.removeListener('message', on);
      await door('close', { id });
    }

    // ---- (a) a plain file box, and (g) its real multipart POST
    const files3 = [F.a, F.b, F.p];
    {
      const id = await openPage('/a');
      const r = await door('attach', { id, files: files3 });
      check('(a) a plain file box takes three files', r.text && /Attached 3 files to the file box “Your documents” \(input#docs\)/.test(r.text) && r.confirmed, r.text || r.error);
      check('(a) the answer lists names and sizes, and what the page holds', /- Jolly invoice\.pdf · \d/.test(r.text) && /holds: Jolly invoice\.pdf/.test(r.text) && /The page shows: .*chord chart\.png/.test(r.text), r.text);
      const sub = await door('attach', { id, files: files3, submit: true });
      await sleep(500);
      const got = uploads[uploads.length - 1] || [];
      const same = got.length === 3 && got.every((g) => want[g.name] === g.sha);
      check('(g) after submit the server received byte-identical files (sha256)', same, got.map((g) => `${g.name}:${g.sha.slice(0, 8)}`));
      check('(g) and the answer says the form was submitted', /Submitted its form/.test(sub.text || ''), sub.text || sub.error);
      await door('close', { id });
    }
    // ---- (b) a hidden box behind a button, that takes PDFs only
    {
      const id = await openPage('/b');
      const r = await door('attach', { id, files: [F.a, F.b] });
      check('(b) a hidden file box behind a button takes the PDFs', /the hidden file box/.test(r.text || '') && r.confirmed && /Jolly receipt\.pdf/.test(await pageText(id)), r.text || r.error);
      const png1 = await door('attach', { id, files: [F.p] });
      check('(b) a picture offered to a PDF-only box is refused in words', /takes only \.pdf/.test(png1.error || ''), png1.error || png1.text);
      await door('close', { id });
    }
    // ---- (c) a box made only when its button is clicked: the chooser is intercepted
    {
      const id = await openPage('/c');
      const r = await door('attach', { id, files: files3 });
      const t = await pageText(id);
      check('(c) a box made on click is answered through the intercepted chooser', /file chooser behind “Upload files”/.test(r.text || '') && /chord chart\.png/.test(t) && r.confirmed, r.text || r.error);
      await door('close', { id });
    }
    // ---- (d) a cross-origin iframe
    {
      const id = await openPage('/d');
      await sleep(600);
      const r = await door('attach', { id, files: [F.a] });
      const wc = agentApi.get(id).view.webContents;
      const inner = wc.mainFrame.frames.find((f) => /localhost/.test(f.url));
      const innerText = inner ? await inner.executeJavaScript('document.body.innerText') : '';
      check('(d) a file box inside a cross-origin iframe takes the file', /iframe from localhost/.test(r.text || '') && /Jolly invoice\.pdf/.test(innerText), r.text || r.error);
      await door('close', { id });
    }
    // ---- (e) an open shadow root
    {
      const id = await openPage('/e');
      const r = await door('attach', { id, files: [F.p, F.b] });
      check('(e) a file box inside an open shadow root takes the files', /in a shadow root/.test(r.text || '') && /chord chart\.png/.test(await pageText(id)), r.text || r.error);
      await door('close', { id });
    }
    // ---- (f) a drop zone and nothing else: the real files are dragged on, and uploaded by the page
    {
      const id = await openPage('/f');
      const before = uploads.length;
      const r = await door('attach', { id, files: files3 });
      await sleep(800);
      const got = uploads.slice(before).flat();
      check('(f) a drop-zone-only page takes the files by drag and drop', /drop zone “Drop files here”/.test(r.text || '') && r.confirmed, r.text || r.error);
      check('(f) and the bytes the page uploaded from the drop are the real files', got.length === 3 && got.every((g) => want[g.name] === g.sha), got.map((g) => g.name));
      await door('close', { id });
    }
    // ---- a selector: the input itself, or the button that opens the chooser
    {
      const id = await openPage('/c');
      const r = await door('attach', { id, files: [F.a], selector: '#up' });
      check('a selector naming the button that opens the chooser works', /chooser behind “Upload files”/.test(r.text || ''), r.text || r.error);
      const bad = await door('attach', { id, files: [F.a], selector: '##nope' });
      check('a broken selector is said plainly', /not a CSS selector/.test(bad.error || ''), bad.error);
      await door('close', { id });
    }
    // ---- one-file boxes, pages with nothing
    {
      const id = await openPage('/s');
      const two = await door('attach', { id, files: [F.a, F.b] });
      check('two files for a one-file box is refused, and says why', /one file at a time/.test(two.error || '') && /Nothing was attached/.test(two.error || ''), two.error || two.text);
      const one = await door('attach', { id, files: [F.a] });
      check('control: the same box takes one file', one.confirmed && /input#one/.test(one.text), one.text || one.error);
      await door('close', { id });
      const id2 = await openPage('/n');
      const none = await door('attach', { id: id2, files: [F.a] });
      check('a page with nowhere to put files says so in plain words', /Nothing on this page takes files/.test(none.error || ''), none.error);
      check('and it did not follow the page\'s "Upload page" link', /\/n$/.test(agentApi.get(id2).view.webContents.getURL()), agentApi.get(id2).view.webContents.getURL());
      await door('close', { id: id2 });
    }
    // ---- cue_snapshot shows where files can go
    {
      const id = await openPage('/b');
      const s = await door('snapshot', { id });
      check('cue_snapshot lists the hidden file box (and how to use it)', s.files && s.files.inputs.some((i) => i.where === 'input#hid' && i.hidden && /pdf/.test(i.accept)) && /cue_attach/.test(s.files.how), s.files);
      const id2 = await openPage('/f');
      const s2 = await door('snapshot', { id: id2 });
      check('and a drop zone', s2.files && s2.files.dropZones.length === 1, s2.files);
      const id3 = await openPage('/n');
      const s3 = await door('snapshot', { id: id3 });
      check('control: a page with no file places has no files section', !s3.files, s3.files);
      for (const x of [id, id2, id3]) await door('close', { id: x });
    }

    // ---- refusals, each in plain words
    const id = await openPage('/a');
    const refuse = async (files, extra = {}) => (await door('attach', { id, files, ...extra })).error || '';
    check('a missing file is refused', /There is no file at .*nope\.pdf/.test(await refuse([path.join(dir, 'nope.pdf')])));
    check('a folder is refused', /is a folder/.test(await refuse([dir])));
    check('a path that is not a full path is refused', /not a full path/.test(await refuse(['Jolly invoice.pdf'])));
    check('~/Library is refused by name', /holds this computer's own settings/.test(await refuse([path.join(os.homedir(), 'Library/Preferences/com.apple.finder.plist')])));
    check('~/.ssh is refused by name', /private keys/.test(await refuse([path.join(os.homedir(), '.ssh/id_ed25519')])));
    check('a keychain is refused', /keychain/.test(await refuse(['/private/tmp/login.keychain-db'])));
    const own = path.join(app.getPath('userData'), 'agent-port.json');
    check('Cue\'s own data folder is refused (the token file in it)', /Cue's own data folder/.test(await refuse([own])));
    const sneaky = path.join(dir, 'looks-harmless.pdf');
    try { fs.unlinkSync(sneaky); } catch {} fs.symlinkSync(own, sneaky);
    check('a link that leads into Cue\'s data folder is refused too', /leads to .*Cue's own data folder/.test(await refuse([sneaky])));
    check('a path outside home and /tmp is refused', /only attaches files from your home folder/.test(await refuse(['/etc/hosts'])));
    check('more than 25 files is refused', /at most 25/.test(await refuse(Array.from({ length: 26 }, () => F.a))));
    check('the same file twice is refused', /in the list twice/.test(await refuse([F.a, F.a])));
    check('no files at all is a question, not a crash', /Say which files/.test(await refuse(undefined)));
    // private tab, locked folder, a folder not open to agents
    agentApi.get(id).private = true;
    check('a private tab is refused', /private/.test(await refuse([F.a])));
    agentApi.get(id).private = false;
    addFolder({ id: 'lockme', name: 'Lockme' }); command('folder.agents', { id: 'lockme', on: true });
    setPasscode({ id: 'lockme', code: 'attach-test-1' }); lockFolder('lockme');
    const locked = (await door('attach', { identity: 'Lockme', url: `${base}/a`, files: [F.a] })).error || '';
    check('a locked folder is refused', /folder is locked/.test(locked), locked);
    addFolder({ id: 'shut', name: 'Shut' });
    const shut = (await door('attach', { identity: 'Shut', url: `${base}/a`, files: [F.a] })).error || '';
    check('a folder not open to agents is refused', /not open to AI agents/.test(shut), shut);
    command('folder.agents', { id: 'personal', on: true });
    const viaUrl = await door('attach', { identity: 'agent', url: `${base}/a`, files: [F.p] });
    check('control: identity + url opens the page and attaches', viaUrl.confirmed, viaUrl.text || viaUrl.error);
    // His own tab, not handed over: reading is fine, attaching is not.
    const his = c.openTab({ url: `${base}/a`, identity: 'personal', background: true });
    await sleep(600);
    const hisRefused = (await door('attach', { id: his.id, files: [F.a] })).error || '';
    check('a tab he did not hand over is refused', /only act in tabs they opened/.test(hisRefused), hisRefused);
    // Paused agents: refused, and said so.
    setSetting('aiPaused', true);
    const paused = await refuse([F.a]);
    setSetting('aiPaused', false);
    check('paused agents are refused', /paused/.test(paused), paused);

    // ---- the log has the names, never the contents
    await sleep(200);
    const log = fs.readFileSync(path.join(app.getPath('userData'), 'agent-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const att = log.filter((e) => e.tool === 'attach');
    check('every attach is logged with the file names', att.length >= 20 && att.some((e) => e.ok && (e.files || []).includes('Jolly invoice.pdf')), att.length);
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'agent-log.jsonl'), 'utf8');
    check('and never with what is in them; the files field holds bare names', !raw.includes('Invoice for Jolly') && !raw.includes('%PDF') && att.every((e) => (e.files || []).every((f) => !f.includes('/'))), raw.length);
    check('the tab shows the "an agent is working here" mark', !!agentApi.get(id).aiBusy);

    // ---- cue_download: a file from one page, into Downloads/Cue Agents, then onto another page
    {
      const dl = await openPage('/dl');
      const r = await door('download', { id: dl, selector: '#get' });
      const where = path.join(app.getPath('downloads'), 'Cue Agents', 'report.pdf');
      check('cue_download saves a linked file into Downloads/Cue Agents, no dialog', r.path === where && fs.existsSync(where) && /^%PDF/.test(fs.readFileSync(where, 'latin1')), r.text || r.error);
      const r2 = await door('download', { id: dl, selector: '#blob' });
      check('a file the page makes on a click is saved too', r2.path && /made\.txt$/.test(r2.path) && fs.readFileSync(r2.path, 'utf8') === 'made in the page', r2.text || r2.error);
      const r3 = await door('download', { id: dl, url: `${base}/file/report.pdf` });
      check('a url downloads to a new name, never over the last one', r3.path && /report \(1\)\.pdf$/.test(r3.path), r3.path || r3.error);
      const again = await door('attach', { id, files: [where] });
      check('and what was downloaded can be attached elsewhere', again.confirmed, again.text || again.error);
      await door('close', { id: dl });
    }

    // ---- the MCP bridge, the way Claude Code and Codex run it
    if (process.env.CUE_MCP) {
      const p = spawn('node', [path.join(__dirname, '..', 'bin', 'cue-mcp.js')], { env: { ...process.env, CUE_TOKEN_FILE: tokenFile, CUE_AGENT_NAME: 'Attach bridge' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = ''; const waiting = new Map(); let n = 0;
      p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
      const rpc = (method, params) => new Promise((r) => { const k = ++n; waiting.set(k, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); });
      const tool = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); return { error: !!m.result.isError, text: m.result.content[0].text }; };
      await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'attach-check' }, capabilities: {} });
      const list = (await rpc('tools/list', {})).result.tools;
      const d = (k) => (list.find((t) => t.name === k) || {}).description || '';
      check('MCP: cue_attach and cue_download are listed', !!list.find((t) => t.name === 'cue_attach') && !!list.find((t) => t.name === 'cue_download'));
      check('MCP: the descriptions say how to attach, with an example', /files/.test(d('cue_attach')) && /Example/i.test(d('cue_attach')) && /files/.test(d('cue_whatsapp')) && /Example/i.test(d('cue_whatsapp')) && /files/.test(d('cue_gmail')) && /Example/i.test(d('cue_gmail')));
      const opened = JSON.parse((await tool('cue_open', { url: `${base}/c`, identity: 'agent', newTab: true })).text);
      const r = await tool('cue_attach', { id: opened.id, files: [F.a, F.p] });
      check('MCP: cue_attach through the bridge answers in plain lines', !r.error && /^Attached 2 files to the file chooser/.test(r.text), r.text);
      const bad = await tool('cue_attach', { id: opened.id, files: ['/etc/hosts'] });
      check('MCP: a refusal comes back as an error in words', bad.error && /only attaches files from your home folder/.test(bad.text), bad.text);
      p.kill();
    }

    // ---- live, harmless: the real WhatsApp, unlinked, in a fresh folder. Nothing is sent.
    if (process.env.CUE_LIVE_WA) {
      addFolder({ id: 'walive', name: 'Live check' }); command('folder.agents', { id: 'walive', on: true });
      setSetting('agentSites.whatsapp', true);
      const r = await door('whatsapp', { who: 'Live check', action: 'send', chat: 'Nobody', files: [F.a] });
      check('LIVE: the real WhatsApp, not linked, says "not linked" in plain words', /not linked/.test(r.error || '') && /scan/i.test(r.error || ''), r.error || r.text);
    }

    // ---- nothing on his screen
    check('no native dialog was asked for, start to finish', dialogs.length === 0, dialogs);
    check('no window was focused or raised', focused === 0 && (win() ? win().isFocused() : false) === focusedAtStart, { focused, focusedAtStart });
    check('the tab in front of him never changed', getState().activeId === frontBefore, `${frontBefore} -> ${getState().activeId}`);
    check('control: a failing check is visible (expected FAIL below)', false, 'this one is meant to fail');
  } catch (e) {
    check('the suite ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  } finally {
    const pass = results.filter((r) => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'attach.json'), JSON.stringify(results, null, 2));
    console.log(`[cue-attach] DONE ${pass}/${results.length} passed (1 deliberate failure expected)`);
    if (server) server.close();
    setTimeout(() => app.exit(0), 300);
  }
};
