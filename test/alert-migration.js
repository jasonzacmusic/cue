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
