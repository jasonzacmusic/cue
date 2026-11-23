// Run with CUE_TEST=tab-lifecycle CUE_USER_DATA=<disposable profile> npx electron .
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');

async function until(test, description) {
  for (let i = 0; i < 200; i++) {
    const result = test();
    if (result) return result;
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function pageAt(tab, url) {
  const wc = tab.view?.webContents;
  return wc && !wc.isDestroyed() && !wc.isLoading() && wc.getURL() === url && wc;
}

async function losePage(tab) {
  const old = tab.view;
  const wc = old.webContents;
  await new Promise((resolve) => {
    wc.once('destroyed', resolve);
    wc.close();
  });
  assert.ok(!old.webContents, 'Electron keeps the view but removes the page');
  return old;
}

module.exports = async (c) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Cue tab recovery test</title><p>A test page</p>');
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const active = c.openTab({ url: base + '/active' });
    const background = c.openTab({ url: base + '/background', background: true });
    const activePage = await until(() => pageAt(active, base + '/active'), 'active tab');
    await until(() => pageAt(background, base + '/background'), 'background tab');
    await activePage.executeJavaScript("sessionStorage.setItem('control', 'preserved')");
    const old = await losePage(background);
    assert.ok(!c.win().contentView.children.includes(old), 'destroyed view was detached');
    c.sendState();
    assert.equal(c.lastState().tabs.find(({ id }) => id === background.id).sleeping, true);
    assert.equal(c.lastState().tabs.find(({ id }) => id === background.id).blocked, 0);
    c.layout();
    assert.equal(active.view.webContents, activePage);
    assert.equal(await activePage.executeJavaScript("sessionStorage.getItem('control')"), 'preserved');
    assert.equal(background.view, null, 'a background tab stays asleep until requested');
    console.log('PASS sidebar and the other tab keep working when a background page disappears');

    c.setVolume(background, 0.35);
    c.setMuted(background, true);
    c.agentApi.ensure(background);
    const agentPage = await until(() => pageAt(background, base + '/background'), 'agent tab recovery');
    assert.ok(agentPage.isAudioMuted());
    assert.equal(background.volume, 0.35);
    console.log('PASS agent action recreates the same tab and preserves its audio controls');

    c.command('cue-add', { id: background.id });
    await losePage(background);
    c.command('take', { id: background.id });
    assert.equal(c.getState().programId, background.id, 'TAKE still works after a cued page disappears');
    assert.ok(c.stage().contentView.children.includes(background.view), 'recovery uses the Stage window');
    await until(() => pageAt(background, base + '/background'), 'Stage page after TAKE');
    await losePage(background);
    await until(() => pageAt(background, base + '/background'), 'on-air tab recovery');
    assert.ok(c.stage().contentView.children.includes(background.view));
    assert.equal(c.getState().programId, background.id);
    c.setLive(false);
    assert.ok(c.win().contentView.children.includes(background.view));
    console.log('PASS TAKE and on-air recovery preserve the Stage and return the tab to Cue');

    c.activate(active.id);
    await losePage(active);
    await until(() => pageAt(active, base + '/active'), 'visible tab automatic recovery');
    await losePage(active);
    await wait(120);
    assert.equal(active.view, null, 'a repeatedly disappearing page cannot cause an automatic reload loop');
    c.command('reload', { id: active.id });
    await until(() => pageAt(active, base + '/active'), 'manual reload after repeated loss');
    console.log('PASS visible pages recover once and Reload works after repeated loss');

    const popped = c.openTab({ url: base + '/popout' });
    c.command('popout', { id: popped.id });
    const popout = popped.popout;
    await until(() => pageAt(popped, base + '/popout'), 'popout');
    await losePage(popped);
    await until(() => pageAt(popped, base + '/popout'), 'popout recovery');
    assert.ok(popout.contentView.children.includes(popped.view));
    popout.close();
    await until(() => popped.host === 'main', 'popout returned to main window');
    c.closeTab(popped.id);
    assert.ok(!c.tabs.includes(popped));
    console.log('PASS popout keeps its host and a deliberate close never reopens the tab');

    c.openPeek(base + '/peek', active);
    const peek = c.getPeek();
    await until(() => pageAt(peek, base + '/peek'), 'Peek');
    await losePage(peek);
    assert.equal(c.getPeek(), null);
    const privateTab = c.vanish.add(base + '/vanish');
    await until(() => pageAt(privateTab, base + '/vanish'), 'Vanish page');
    await losePage(privateTab);
    assert.equal(privateTab.view, null);
    c.vanish.command('reload');
    const privatePage = await until(() => pageAt(privateTab, base + '/vanish'), 'Vanish reload');
    assert.equal(privatePage.session, c.sessionFor('vanish'));
    assert.ok(!c.tabs.includes(privateTab));
    c.vanish.close();
    console.log('PASS Peek dismisses safely and Vanish reloads in its private session');

    const log = path.join(c.app.getPath('userData'), 'problems.log');
    assert.doesNotMatch(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', /reading 'isDestroyed'|Object has been destroyed/);
    c.app.exit(0);
  } catch (error) {
    console.error(error);
    c.app.exit(1);
  } finally {
    server.close();
  }
};
