// Run on a clean GitHub-hosted Windows or Linux runner after publishing a release.
// Start the preceding signed-feed package, let it discover the live offer, close its window,
// then launch the installed update with the same profile. Older releases install on normal quit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const core = require('../src/main/update-core');

async function waitFor(check, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
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
  fs.writeFileSync(config, JSON.stringify({ welcome: 'done', toldNoSandbox: true, folders: [{ id: 'personal', name: marker }], settings: { autoUpdate: true, agentPort: false, preset: null } }));
  const exe = path.join(live, core.exeName(platform));
  const args = platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [];
  const app = spawn(exe, args, { env, stdio: 'ignore' });
  const staged = path.join(profile, 'updates', target);
  await waitFor(() => fs.existsSync(path.join(staged, 'ok.json')), 'previous Cue to verify and stage ' + target);
  const info = JSON.parse(fs.readFileSync(path.join(staged, 'ok.json')));
  assert.equal(info.version, target);
  const hashApp = (root) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'resources', 'app.asar'))).digest('hex');
  const expected = hashApp(path.join(staged, info.dir));
  assert.notEqual(hashApp(live), expected);
  if (platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `if (!(Get-Process -Id ${app.pid}).CloseMainWindow()) { exit 1 }`]);
  } else {
    execFileSync('xdotool', ['search', '--onlyvisible', '--pid', String(app.pid), 'windowactivate', '--sync', 'key', 'ctrl+q']);
  }
  await waitFor(() => {
    try { return hashApp(live) === expected; } catch { return false; }
  }, 'verified package to replace old installation');
  await waitFor(() => app.exitCode !== null || app.signalCode, 'old process to exit');
  const stdout = execFileSync(exe, args, { env: { ...env, CUE_SMOKE: '1' }, encoding: 'utf8', timeout: 90000 });
  assert.ok(stdout.includes('CUE_SMOKE_OK'));
  assert.ok(JSON.parse(fs.readFileSync(config)).folders.some((folder) => folder.name === marker));
  console.log(`PASS ${platform}: ${old.version} discovered, verified and installed ${target}; new Cue opened with the original profile.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
