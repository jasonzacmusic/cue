// Run with node test/alert-migration.js to exercise an upgrade and restart.
const assert = require('node:assert/strict');
module.exports = async (c) => {
  try {
    const entries = c.store.data.alerts;
    const alert = (id) => entries.find((a) => a.id === id);
    assert.equal(entries.length, 4);
    assert.equal(alert(1).unverifiedSite, true);
    assert.equal(alert(1).seen, false);
    for (const id of [2, 3, 4]) assert.equal(alert(id).unverifiedSite, undefined);
    c.sendState();
    assert.equal(c.lastState().alertCount, 2);
    console.log('PASS legacy website history preserved, two authenticated or local unread entries counted');
    c.app.exit(0);
  } catch (error) { console.error(error); c.app.exit(1); }
};

if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-alert-migration-'));
  const url = 'https://example.test/';
  const entry = { folder: 'personal', source: 'example.test', url, seen: false, at: Date.now() };
  const origin = new URL(url).origin;
  const alerts = [
    { ...entry, id: 1, title: 'Earlier alert' }, { ...entry, id: 2, title: 'Approved', origin },
    { ...entry, id: 3, title: 'example.test: card failed' }, { ...entry, id: 4, title: 'Read', origin, seen: true },
  ];
  try {
    fs.writeFileSync(path.join(profile, 'cue.json'), JSON.stringify({
      folder: 'personal', folders: [{ id: 'personal', name: 'Personal' }], alerts,
      bills: [{ name: entry.source, url, folder: entry.folder }], migrated: { 'legacy-freeze-0.7': true },
    }));
    for (let run = 0; run < 2; run++) execFileSync(require('electron'), ['.'], {
      cwd: path.join(__dirname, '..'), stdio: 'inherit', timeout: 30000,
      env: { ...process.env, CUE_TEST: 'alert-migration', CUE_OFFLINE: '1', CUE_QUIET: '1', CUE_USER_DATA: profile },
    });
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}
