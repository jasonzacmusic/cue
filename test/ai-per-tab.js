// Tests for Cue's per-tab AI system: all Gemini/Claude/ChatGPT side panel modes,
// 1-click MCP auto-connect across 6 clients, strict per-tab scoped token isolation,
// built-in Gemini API function calling, and (when CUE_LIVE_AI=1) live Claude + Codex + Gemini
// autonomously driving 3 separate tabs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFormHtml(label) {
  return `<!doctype html><html><head><title>${label}</title></head><body>
    <h1>${label}</h1>
    <label for="msg">Message</label>
    <input id="msg" aria-label="Message" placeholder="Type message here">
    <button id="send" onclick="document.getElementById('status').textContent='DONE: ' + document.getElementById('msg').value">Submit</button>
    <div id="status">READY</div>
  </body></html>`;
}

module.exports = async (c) => {
  let passed = 0;
  const check = (name, ok, detail) => {
    if (!ok) {
      console.error(`[ai-per-tab] FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
      throw new Error(`Failed: ${name}`);
    }
    passed++;
    console.log(`[ai-per-tab] PASS ${name}`);
  };

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/tab1') return res.end(makeFormHtml('Tab 1 — Claude Workspace'));
    if (req.url === '/tab2') return res.end(makeFormHtml('Tab 2 — ChatGPT Workspace'));
    if (req.url === '/tab3') return res.end(makeFormHtml('Tab 3 — Gemini Workspace'));
    if (req.url === '/private') return res.end('<title>Private Secret</title><p>TOP_SECRET_BANK_42</p>');
    res.end('<title>Home</title><p>ok</p>');
  });

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-mcp-home-'));
  try {
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;

    // 1. All 8 AI side-panel modes exist & map to expected hosts
    const expectedModes = {
      gemini: 'gemini.google.com',
      aistudio: 'aistudio.google.com',
      notebooklm: 'notebooklm.google.com',
      jules: 'jules.google.com',
      claudecode: 'claude.ai',
      claude: 'claude.ai',
      codex: 'chatgpt.com',
      chatgpt: 'chatgpt.com',
    };
    for (const [k, host] of Object.entries(expectedModes)) {
      check(`AI_HOME has ${k}`, typeof c.AI_HOME[k] === 'string' && c.AI_HOME[k].includes(host), c.AI_HOME[k]);
    }

    // 2. Side panel follows active folder's persistent session partition (stays logged in per account!)
    c.addFolder({ name: 'Work', color: '#10B981' });
    const workId = c.userFolders().find((f) => f.name === 'Work').id;
    c.setFolder('personal');
    c.openAI('gemini', `${base}/tab3`);
    await sleep(300);
    const sesPersonal = c.getAI().webContents.session;
    check('AI panel opens in Personal persistent partition', sesPersonal === c.sessionFor('personal'));
    c.setFolder(workId);
    await sleep(300);
    const sesWork = c.getAI().webContents.session;
    check('AI panel switches to Work persistent partition when account changes', sesWork === c.sessionFor(workId) && sesWork !== sesPersonal);
    c.toggleAI();
    c.setFolder('personal');

    // 3. Encrypted Gemini API key storage round-trip
    check('Gemini key starts unset', !c.hasGeminiKey());
    c.setGeminiKey('AIzaTestFakeKey12345');
    check('Gemini key saves and decrypts', c.hasGeminiKey() && c.getGeminiKey() === 'AIzaTestFakeKey12345');
    c.setGeminiKey('');
    check('Gemini key clears cleanly', !c.hasGeminiKey() && c.getGeminiKey() === '');

    // 4. 1-Click MCP Auto-Connect across all 6 clients (preserving existing servers!)
    fs.mkdirSync(path.join(tmpHome, '.gemini', 'antigravity'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'echo', args: ['hi'] } } }, null, 2));
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "echo"\nargs = ["ok"]\n');

    const bridge = c.agentBridgePath();
    const tokFile = c.agentTokenFile();
    const clients0 = c.mcpConnect.listClients({ home: tmpHome });
    check('MCP detects all 6 clients', clients0.length === 6 && clients0.every((x) => !x.connected));

    for (const cli of clients0) {
      c.mcpConnect.connectClient(cli.id, { bridgePath: bridge, tokenFile: tokFile, nodeBin: process.execPath, home: tmpHome });
    }
    const clients1 = c.mcpConnect.listClients({ home: tmpHome });
    check('MCP connects all 6 clients cleanly', clients1.every((x) => x.connected));

    // Verify existing config entries were preserved untouched!
    const gJson = JSON.parse(fs.readFileSync(path.join(tmpHome, '.gemini', 'settings.json'), 'utf8'));
    check('Gemini CLI settings preserves theme + other MCP servers', gJson.theme === 'dark' && gJson.mcpServers.other.command === 'echo' && gJson.mcpServers.cue.args[0] === bridge);
    const codexToml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf8');
    check('Codex config.toml preserves model + other MCP + adds cue', codexToml.includes('model = "gpt-5"') && codexToml.includes('[mcp_servers.other]') && codexToml.includes('[mcp_servers.cue]'));

    for (const cli of clients1) {
      c.mcpConnect.disconnectClient(cli.id, { home: tmpHome });
    }
    const clients2 = c.mcpConnect.listClients({ home: tmpHome });
    check('MCP disconnects all 6 clients cleanly', clients2.every((x) => !x.connected));
    const gJsonAfter = JSON.parse(fs.readFileSync(path.join(tmpHome, '.gemini', 'settings.json'), 'utf8'));
    check('Gemini CLI disconnect leaves other MCP intact', gJsonAfter.mcpServers.other.command === 'echo' && !gJsonAfter.mcpServers.cue);

    // 5. Open 3 separate tabs (Claude, ChatGPT, Gemini) + 1 Private tab & verify strict per-tab scoped token!
    const t1 = c.openTab({ url: `${base}/tab1`, identity: 'personal' });
    const t2 = c.openTab({ url: `${base}/tab2`, identity: 'personal' });
    const t3 = c.openTab({ url: `${base}/tab3`, identity: 'personal' });
    const tp = c.openTab({ url: `${base}/private`, identity: 'personal', private: true });
    await sleep(600);

    const agentSrv = await c.openAgentPort();
    assert(agentSrv && typeof agentSrv.issueScopedToken === 'function', 'agent server ready');

    // Global AI door stays OFF — scoped per-tab token should STILL work ONLY on t1!
    const stepsSeen = [];
    const scopedTok = agentSrv.issueScopedToken(t1.id, { agentName: 'Test Scoped', onTool: (x) => stepsSeen.push(x.tool) });
    const post = async (tool, body) => {
      const r = await fetch(`${agentSrv.portUrl}/tool/${tool}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${scopedTok}`, 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return { status: r.status, body: await r.json() };
    };

    const snap1 = await post('snapshot', { id: t1.id });
    check('Scoped token snapshots assigned Tab 1 (even with global AI door OFF)', snap1.status === 200 && snap1.body.elements.length >= 2);
    const type1 = await post('type', { id: t1.id, selector: '#msg', value: 'Scoped OK' });
    const click1 = await post('click', { id: t1.id, selector: '#send' });
    const read1 = await post('read', { id: t1.id });
    check('Scoped token drives Tab 1 (type + click + read)', type1.status === 200 && click1.status === 200 && read1.body.text.includes('DONE: Scoped OK'));
    check('Scoped token emitted live tool step events', stepsSeen.includes('snapshot') && stepsSeen.includes('type') && stepsSeen.includes('click'));

    // Cross-tab isolation checks
    const blockTab2 = await post('read', { id: t2.id });
    const blockPriv = await post('read', { id: tp.id });
    const blockEval = await post('eval', { id: t1.id, script: '1+1' });
    const blockOpen = await post('open', { url: 'https://example.com' });
    const blockTabs = await post('tabs', {});
    check('Scoped token HARD-BLOCKS Tab 2', blockTab2.status === 403);
    check('Scoped token HARD-BLOCKS Private tab', blockPriv.status === 403);
    check('Scoped token HARD-BLOCKS eval/open/tabs', blockEval.status === 403 && blockOpen.status === 403 && blockTabs.status === 403);

    // Revocation check
    agentSrv.revokeScopedToken(scopedTok);
    const afterRevoke = await post('read', { id: t1.id });
    check('Revoked scoped token immediately returns 401', afterRevoke.status === 401);

    // 6. Verify Tab 3 via built-in Gemini API function-calling loop (local mock Gemini REST server)
    // Monkey-patch fetch ONLY for generativelanguage.googleapis.com so we test the exact real multi-step loop!
    const origFetch = global.fetch;
    let gemTurn = 0;
    global.fetch = async (url, opts) => {
      if (String(url).startsWith('https://generativelanguage.googleapis.com/')) {
        gemTurn++;
        let parts;
        if (gemTurn === 1) parts = [{ functionCall: { name: 'snapshot_page', args: {} } }];
        else if (gemTurn === 2) parts = [{ functionCall: { name: 'type_text', args: { selector: '#msg', value: 'Gemini drove Tab 3' } } }];
        else if (gemTurn === 3) parts = [{ functionCall: { name: 'click_element', args: { selector: '#send' } } }];
        else parts = [{ text: 'Filled the form with "Gemini drove Tab 3" and clicked Submit.' }];
        return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return origFetch(url, opts);
    };
    c.setGeminiKey('AIzaMockTestKey');
    const gRes = await c.driveTab({ id: t3.id, which: 'gemini-api', goal: 'Type "Gemini drove Tab 3" into Message and click Submit.' });
    global.fetch = origFetch;
    c.setGeminiKey('');
    const t3Status = await t3.view.webContents.executeJavaScript('document.getElementById("status").textContent');
    check('Built-in Gemini API multi-step loop drove Tab 3 autonomously', gRes.ok && t3Status === 'DONE: Gemini drove Tab 3', { t3Status, answer: gRes.answer });

    // 7. Optional LIVE 3-Tab Real AI Proof of Concept (Claude Max on Tab 1 + ChatGPT/Codex on Tab 2!)
    if (process.env.CUE_LIVE_AI === '1') {
      // Reset Tab 1 fresh for live Claude
      await t1.view.webContents.loadURL(`${base}/tab1`);
      await sleep(400);
      console.log('[ai-per-tab] LIVE: Driving Tab 1 with signed-in Claude (Claude Max)...');
      const liveClaude = await c.driveTab({
        id: t1.id,
        which: 'claudecode',
        goal: 'Type "Claude Live OK" into the Message input box, click the Submit button, and confirm what the status text says.',
      });
      const t1LiveStatus = await t1.view.webContents.executeJavaScript('document.getElementById("status").textContent');
      check('LIVE Claude autonomously drove Tab 1', t1LiveStatus === 'DONE: Claude Live OK', { t1LiveStatus, answer: liveClaude.answer });

      console.log('[ai-per-tab] LIVE: Driving Tab 2 with signed-in Codex (ChatGPT)...');
      const liveCodex = await c.driveTab({
        id: t2.id,
        which: 'codex',
        goal: 'Type "Codex Live OK" into the Message input box, click the Submit button, and confirm what the status text says.',
      });
      const t2LiveStatus = await t2.view.webContents.executeJavaScript('document.getElementById("status").textContent');
      check('LIVE Codex autonomously drove Tab 2', t2LiveStatus === 'DONE: Codex Live OK', { t2LiveStatus, answer: liveCodex.answer });

      if (c.mcpConnect.findExe('gemini') && process.env.CUE_LIVE_GEMINI === '1') {
        await t3.view.webContents.loadURL(`${base}/tab3`);
        await sleep(400);
        console.log('[ai-per-tab] LIVE: Driving Tab 3 with Gemini CLI...');
        const liveGemini = await c.driveTab({
          id: t3.id,
          which: 'gemini-cli',
          goal: 'Type "Gemini Live OK" into the Message input box, click the Submit button, and confirm what the status text says.',
        });
        const t3LiveStatus = await t3.view.webContents.executeJavaScript('document.getElementById("status").textContent');
        check('LIVE Gemini CLI autonomously drove Tab 3', t3LiveStatus === 'DONE: Gemini Live OK', { t3LiveStatus, answer: liveGemini.answer });
      }
    }

    console.log(`[ai-per-tab] ALL ${passed} CHECKS PASSED`);
    srv.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    c.app.exit(0);
  } catch (err) {
    console.error('[ai-per-tab] ERROR:', err);
    srv.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    c.app.exit(1);
  }
};
