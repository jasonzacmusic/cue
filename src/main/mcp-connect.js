// One-click MCP setup for Gemini CLI, Google Antigravity, Claude Code, Claude Desktop,
// Codex CLI, and Cursor. Reads and writes only the "cue" MCP entry cleanly without touching
// other servers or settings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function searchDirs() {
  const home = os.homedir();
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  let nvmBins = [];
  try {
    nvmBins = fs.readdirSync(nvm)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(nvm, v, 'bin'));
  } catch {}
  const fnm = path.join(home, '.local', 'share', 'fnm', 'node-versions');
  let fnmBins = [];
  try {
    fnmBins = fs.readdirSync(fnm)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(fnm, v, 'installation', 'bin'));
  } catch {}
  const extra = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
        path.join(process.env.APPDATA || '', 'npm'),
        path.join(home, '.volta', 'bin'),
      ]
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.volta', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        ...nvmBins,
        ...fnmBins,
      ];
  const seen = new Set();
  const out = [];
  for (const d of [...(process.env.PATH || '').split(path.delimiter), ...extra]) {
    if (!d || !path.isAbsolute(d) || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

function findExe(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of searchDirs()) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function resolveNodeBin() {
  // Packaged Electron's process.execPath is Cue itself, not node. Always prefer a real node binary.
  return findExe('node') || 'node';
}

function claudeDesktopConfigPath(home) {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

function appInstalled(darwinAppName, winRelPath) {
  if (process.platform === 'darwin') {
    return fs.existsSync(path.join('/Applications', darwinAppName)) || fs.existsSync(path.join(os.homedir(), 'Applications', darwinAppName));
  }
  if (process.platform === 'win32' && winRelPath) {
    return fs.existsSync(path.join(process.env.LOCALAPPDATA || '', winRelPath));
  }
  return false;
}

function clientDefs(home = os.homedir()) {
  return [
    {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      badge: 'Gemini',
      format: 'json',
      key: 'mcpServers',
      configPath: path.join(home, '.gemini', 'settings.json'),
      hint: 'Google account / Gemini Pro CLI',
      isInstalled: () => !!findExe('gemini') || fs.existsSync(path.join(home, '.gemini', 'settings.json')),
    },
    {
      id: 'antigravity',
      name: 'Google Antigravity',
      badge: 'Gemini',
      format: 'json',
      key: 'mcpServers',
      configPath: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      hint: 'Google Antigravity agent IDE',
      isInstalled: () => fs.existsSync(path.join(home, '.gemini', 'antigravity')) || appInstalled('Antigravity.app'),
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      badge: 'Claude',
      format: 'json',
      key: 'mcpServers',
      configPath: path.join(home, '.claude.json'),
      hint: 'Claude Pro / Max terminal agent',
      isInstalled: () => !!findExe('claude') || fs.existsSync(path.join(home, '.claude.json')),
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      badge: 'Claude',
      format: 'json',
      key: 'mcpServers',
      configPath: claudeDesktopConfigPath(home),
      hint: 'Claude desktop app',
      isInstalled: () => fs.existsSync(path.dirname(claudeDesktopConfigPath(home))) || appInstalled('Claude.app', 'AnthropicClaude\\claude.exe'),
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      badge: 'OpenAI',
      format: 'toml',
      configPath: path.join(home, '.codex', 'config.toml'),
      hint: 'ChatGPT Plus / Pro coding agent',
      isInstalled: () => !!findExe('codex') || fs.existsSync(path.join(home, '.codex')),
    },
    {
      id: 'cursor',
      name: 'Cursor',
      badge: 'IDE',
      format: 'json',
      key: 'mcpServers',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      hint: 'Cursor AI editor',
      isInstalled: () => fs.existsSync(path.join(home, '.cursor')) || appInstalled('Cursor.app', 'Programs\\cursor\\Cursor.exe'),
    },
  ];
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    return null;
  }
}

function atomicWrite(file, content, fallbackMode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = fallbackMode;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  const tmp = `${file}.cue-tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode });
  try { fs.chmodSync(tmp, mode); } catch {}
  fs.renameSync(tmp, file);
}

function tomlEscape(s) {
  return JSON.stringify(String(s));
}

function removeTomlCueSections(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const out = [];
  let skip = false;
  for (const line of lines) {
    const m = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (m) {
      const sec = m[1].trim();
      skip = sec === 'mcp_servers.cue' || sec.startsWith('mcp_servers.cue.');
    }
    if (!skip) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function hasTomlCueSection(raw) {
  return /^\s*\[mcp_servers\.cue\]\s*(?:#.*)?$/m.test(String(raw || ''));
}

function isConnected(def) {
  if (def.format === 'toml') {
    try { return hasTomlCueSection(fs.readFileSync(def.configPath, 'utf8')); } catch { return false; }
  }
  const j = readJsonSafe(def.configPath);
  return !!(j && j[def.key] && j[def.key].cue && typeof j[def.key].cue === 'object');
}

function listClients({ home = os.homedir() } = {}) {
  return clientDefs(home).map((def) => ({
    id: def.id,
    name: def.name,
    badge: def.badge,
    hint: def.hint,
    installed: def.isInstalled(),
    connected: isConnected(def),
    configPath: def.configPath,
  }));
}

function connectClient(id, { bridgePath, tokenFile, nodeBin, home = os.homedir() }) {
  const def = clientDefs(home).find((c) => c.id === id);
  if (!def) throw new Error(`Unknown AI client: ${id}`);
  if (!bridgePath) throw new Error('Cue MCP bridge path is missing.');
  const node = nodeBin || resolveNodeBin();
  const env = tokenFile ? { CUE_TOKEN_FILE: tokenFile } : undefined;

  if (def.format === 'toml') {
    let raw = '';
    try { raw = fs.readFileSync(def.configPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const cleaned = removeTomlCueSections(raw);
    const block = [
      '[mcp_servers.cue]',
      `command = ${tomlEscape(node)}`,
      `args = [${tomlEscape(bridgePath)}]`,
      ...(env ? ['', '[mcp_servers.cue.env]', `CUE_TOKEN_FILE = ${tomlEscape(tokenFile)}`] : []),
    ].join('\n');
    const next = (cleaned ? cleaned + '\n\n' : '') + block + '\n';
    atomicWrite(def.configPath, next, 0o600);
    return { ok: true, id, configPath: def.configPath, connected: true };
  }

  const j = readJsonSafe(def.configPath);
  if (j === null) throw new Error(`${path.basename(def.configPath)} has invalid JSON. Fix it first before connecting Cue.`);
  if (!j[def.key] || typeof j[def.key] !== 'object' || Array.isArray(j[def.key])) j[def.key] = {};
  const entry = { command: node, args: [bridgePath] };
  if (env) entry.env = env;
  j[def.key].cue = entry;
  atomicWrite(def.configPath, JSON.stringify(j, null, 2) + '\n', 0o600);
  return { ok: true, id, configPath: def.configPath, connected: true };
}

function disconnectClient(id, { home = os.homedir() } = {}) {
  const def = clientDefs(home).find((c) => c.id === id);
  if (!def) throw new Error(`Unknown AI client: ${id}`);

  if (def.format === 'toml') {
    let raw = '';
    try { raw = fs.readFileSync(def.configPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { ok: true, id, connected: false }; throw e; }
    if (!hasTomlCueSection(raw)) return { ok: true, id, connected: false };
    const cleaned = removeTomlCueSections(raw);
    atomicWrite(def.configPath, cleaned ? cleaned + '\n' : '', 0o600);
    return { ok: true, id, connected: false };
  }

  const j = readJsonSafe(def.configPath);
  if (j === null) throw new Error(`${path.basename(def.configPath)} has invalid JSON.`);
  if (j[def.key] && j[def.key].cue) {
    delete j[def.key].cue;
    atomicWrite(def.configPath, JSON.stringify(j, null, 2) + '\n', 0o600);
  }
  return { ok: true, id, connected: false };
}

module.exports = {
  findExe,
  resolveNodeBin,
  listClients,
  connectClient,
  disconnectClient,
  searchDirs,
};
