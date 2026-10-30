// Smoke test for a built Cue: runs it with CUE_SMOKE=1 and a throwaway profile folder, and passes
// only if it prints CUE_SMOKE_OK within 90 seconds.
// Usage: node scripts/smoke.js <path-to-Cue-executable> [extra app args...]
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [exe, ...args] = process.argv.slice(2);
if (!exe) { console.error('usage: node scripts/smoke.js <executable> [args...]'); process.exit(2); }
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90000);
const MARKER = 'CUE_SMOKE_OK';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-smoke-'));
const child = spawn(exe, args, {
  env: { ...process.env, CUE_SMOKE: '1', CUE_USER_DATA: userData },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
let done = false;
let result = 1;
function onData(buf) {
  const text = buf.toString();
  process.stdout.write(text);
  output += text;
  if (!done && output.includes(MARKER)) finish(0, 'found ' + MARKER);
}
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('error', (e) => finish(1, 'could not start: ' + e.message));
child.on('exit', (code, sig) => {
  if (done) { cleanup(); process.exit(result); }
  // Give any last buffered output a moment to arrive before judging.
  setTimeout(() => finish(output.includes(MARKER) ? 0 : 1, output.includes(MARKER) ? 'found ' + MARKER : `app exited (code ${code}, signal ${sig}) without printing ${MARKER}`), 500);
});
const timer = setTimeout(() => finish(1, `no ${MARKER} within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);

function killTree() {
  if (child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGKILL');
}
function finish(code, why) {
  if (done) return;
  done = true;
  result = code;
  clearTimeout(timer);
  console.log(`\n[smoke] ${code === 0 ? 'PASS' : 'FAIL'}: ${why}`);
  // The app should quit by itself once it has said OK; give it 5s, then force it.
  setTimeout(() => { killTree(); cleanup(); process.exit(code); }, code === 0 ? 5000 : 0);
}
function cleanup() { try { fs.rmSync(userData, { recursive: true, force: true }); } catch {} }
