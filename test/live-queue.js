const assert = require('node:assert/strict');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
module.exports = async (c) => {
  try {
    require('./world').asOwner(c);
    const page = (name) => c.openTab({ url: 'data:text/html,<title>' + name + '</title>' + name });
    const a = page('first'), b = page('second'), other = page('desk');
    await sleep(500);
    const queue = c.agentApi.livequeue;
    assert.equal(queue('enter').position, 0);
    assert.equal(c.getState().programId, null);
    for (const t of [a, b]) c.command('cue-add', { id: t.id });
    queue('enter'); assert.equal(c.getState().programId, a.id);
    assert.equal(a.view.webContents.getBackgroundThrottling(), false);
    c.activate(other.id);
    assert.equal(c.getState().programId, a.id);
    c.take(other.id); assert.equal(c.getState().programId, a.id);
    queue('next'); assert.equal(c.getState().programId, b.id);
    assert.equal(a.view.webContents.getBackgroundThrottling(), true);
    assert.equal(b.view.webContents.getBackgroundThrottling(), false);
    queue('next'); assert.equal(c.getState().programId, a.id);
    c.command('cue-remove', { id: a.id }); assert.equal(c.getState().programId, b.id);
    c.command('cue-remove', { id: b.id }); assert.equal(c.getState().programId, null);
    assert.equal(other.host, 'main');
    c.setLive(false);
    c.activate(other.id); await sleep(300);
    const ui = c.ui().webContents;
    const kept = await ui.executeJavaScript("window.testRow = document.querySelector('.tab'); !!testRow");
    assert(kept); for (let i = 0; i < 20; i++) c.sendState(); await sleep(300);
    assert(await ui.executeJavaScript("testRow.isConnected && document.querySelector('.tab') === testRow"));
    console.log('PASS queue only, standby, cycle, wrap, removal, off-air browsing and stable sidebar across 20 updates');
    c.app.exit(0);
  } catch (e) { console.error(e.stack); c.app.exit(1); }
};
