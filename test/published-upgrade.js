// Run on a clean GitHub-hosted Windows or Linux runner after publishing a release.
// Start the preceding signed-feed package and confirm both update prompts. The new release
// must open the original profile itself.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const core = require('../src/main/update-core');

async function waitFor(check, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for ' + label);
}

async function main() {
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  const target = require('../package.json').version;
  const repo = 'https://github.com/jasonzacmusic/cue/releases';
  const get = async (url) => {
    const response = await fetch(url);
    assert.equal(response.status, 200, url);
    return response;
  };
  const feed = await (await get(repo + '/latest/download/cue-feed.json')).json();
  assert.ok(core.verifyFeed(feed, core.FEED_PUBLIC_KEY));
  assert.equal(feed.version, target);
  const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-version:refname'], { encoding: 'utf8' }).trim().split(/\s+/);
  const previous = tags.find((tag) => /^v\d+\.\d+\.\d+$/.test(tag) && core.newer(target, tag.slice(1)));
  assert.ok(previous);
  const old = await (await get(repo + '/download/' + previous + '/cue-feed.json')).json();
  assert.ok(core.verifyFeed(old, core.FEED_PUBLIC_KEY));
  assert.equal(old.version, previous.slice(1));
  const platform = process.platform;
  const key = core.platformKey(platform, process.arch);
  const entry = core.pickEntry(old, key);
  const bytes = Buffer.from(await (await get(entry.url)).arrayBuffer());
  assert.equal(bytes.length, entry.size);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'cue-upgrade-'));
  const archive = path.join(dir, platform === 'win32' ? 'old.zip' : 'old.tar.gz');
  fs.writeFileSync(archive, bytes);
  const unpacked = await core.extract(archive, path.join(dir, 'old'), platform);
  const profile = path.join(dir, 'profile');
  const env = { ...process.env, CUE_USER_DATA: profile, CUE_QUIET: '1', XDG_DATA_HOME: path.join(dir, 'data'), LOCALAPPDATA: path.join(dir, 'local') };
  const live = core.perUserHome(platform, env);
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.renameSync(unpacked, live);
  fs.mkdirSync(profile);
  const marker = 'Upgrade test profile';
  const config = path.join(profile, 'cue.json');
  fs.writeFileSync(config, JSON.stringify({ welcome: 'done', toldNoSandbox: true, folders: [{ id: 'personal', name: marker }], settings: { autoUpdate: false, agentPort: false, preset: null } }));
  const exe = path.join(live, core.exeName(platform));
  const args = platform === 'linux' ? ['--no-sandbox'] : [];
  args.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0');
  // Preserve startup diagnostics for both processes if the native relaunch fails.
  const logFile = path.join(dir, 'cue-output.log');
  const output = fs.openSync(logFile, 'w');
  const app = spawn(exe, args, { env, stdio: ['ignore', output, output] });
  fs.closeSync(output);
  const staged = path.join(profile, 'updates', target);
  // Click only the update buttons of the test app's own sidebar in this disposable profile.
  let shell;
  await waitFor(async () => {
    try {
      const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      shell = pages.find((p) => p.url.startsWith('file:') && p.url.endsWith('/ui/index.html'));
      return !!shell;
    } catch { return false; }
  }, 'Cue sidebar');
  const socket = new WebSocket(shell.webSocketDebuggerUrl);
  await new Promise((ok, no) => { socket.onopen = ok; socket.onerror = no; });
  app.unref();
  let seq = 0;
  async function clickUpdate(label) {
    const expression = `(() => {
      const bar = document.querySelector('#updatebar');
      if (!bar || bar.hidden) return false;
      const button = [...bar.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)});
      if (!button) return false;
      button.click(); return true;
    })()`;
    const id = ++seq;
    const response = new Promise((ok) => {
      const reply = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id !== id) return;
        socket.removeEventListener('message', reply);
        ok(msg.result?.result?.value === true);
      };
      socket.addEventListener('message', reply);
    });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, userGesture: true } }));
    return response;
  }
  await waitFor(() => clickUpdate('Update'), 'previous Cue to offer the live release');
  await waitFor(() => fs.existsSync(path.join(staged, 'ok.json')), 'download and signature checks');
  const info = JSON.parse(fs.readFileSync(path.join(staged, 'ok.json')));
  assert.equal(info.version, target);
  const hashApp = (root) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'resources', 'app.asar'))).digest('hex');
  const expected = hashApp(path.join(staged, info.dir));
  assert.notEqual(hashApp(live), expected);
  if (platform === 'linux') {
    // Diagnostic only: isolate the desktop identity inherited by Electron's relauncher.
    const p = path.join(staged, info.dir, 'Cue');
    fs.renameSync(p, p + '.bin');
    fs.writeFileSync(p, '#!/bin/sh\nunset CHROME_DESKTOP\nexec "${0}.bin" "$@"\n', {mode:0o755});
  }
  await waitFor(() => clickUpdate('Install and reopen'), 'confirmation button');
  socket.close();
  await waitFor(() => {
    try { return hashApp(live) === expected; } catch { return false; }
  }, 'verified package to replace old installation');
  await waitFor(() => app.exitCode !== null || app.signalCode, 'old process to exit');
  try {
    await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(config)).lastVersion === target; } catch { return false; }
    }, 'new Cue to reopen the same profile', 60000);
  } catch (error) {
    console.error('Installed file verified. Old process exit:', app.exitCode, app.signalCode);
    console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n'));
    if (platform === 'linux') {
      console.error(execFileSync('ps', ['-eo', 'pid,comm'], { encoding: 'utf8' }).split('\n').filter((line) => /cue|electron|chrome/i.test(line)).join('\n'));
      const launcher = path.join(require('os').homedir(), '.local', 'bin', 'cue');
      const retry = spawn(launcher, [], { env, stdio: 'ignore' });
      retry.unref();
      await waitFor(() => JSON.parse(fs.readFileSync(config)).lastVersion === target, 'normal desktop launcher', 30000);
      console.error('Confirmed the signed update also opens from the apps menu after the previous process has exited.');
    }
    throw error;
  }
  assert.ok(JSON.parse(fs.readFileSync(config)).folders.some((folder) => folder.name === marker));
  console.log(`PASS ${platform}: ${old.version} discovered, verified and installed ${target}; new Cue opened with the original profile.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
