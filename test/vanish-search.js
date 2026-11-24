// Exercise the File menu entry point and the actual search box, from a fresh private session.
const assert = require('node:assert/strict');
const { Menu } = require('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check, timeout = 10000) {
  const until = Date.now() + timeout;
  do { if (await check()) return; await sleep(100); } while (Date.now() < until);
  throw new Error('Timed out waiting for ' + check.toString());
}
module.exports = async (c) => {
  try {
    await sleep(900);
    const menu = Menu.getApplicationMenu().items.find((m) => m.submenu?.items.some((i) => i.label === 'New Vanish Tab'));
    const entry = menu.submenu.items.find((i) => i.label === 'New Vanish Tab');
    const previous = c.getState().activeId;
    entry.click();
    const bar = c.vanish.ui().webContents;
    const tab = c.vanish.tabs[0];
    await wait(() => !bar.isLoading() && bar.executeJavaScript("document.activeElement?.id === 'url'"));
    if (process.env.CUE_REAL_SCREEN) assert(c.vanish.window().isFocused());
    assert.equal(c.getState().activeId, previous);
    assert.equal(tab.view.webContents.session.getStoragePath(), null);
    const query = 'music concert pitch definition';
    await bar.insertText(query);
    bar.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    bar.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait(() => tab.view.webContents.getURL().startsWith('https://www.google.com/search'), 20000);
    assert.equal(new URL(tab.view.webContents.getURL()).searchParams.get('q'), query);
    await wait(() => !tab.view.webContents.isLoading(), 30000);
    const page = await tab.view.webContents.executeJavaScript("({title:document.title, results:document.querySelectorAll('#search h3, #rso h3').length, providerCheck:!!document.querySelector('form#captcha-form')})");
    console.log('Google search', JSON.stringify(page));
    assert(page.results > 0, 'Google did not return a results list');
    c.vanish.close(); console.log('PASS First Vanish window, keyboard focus and signed-out Google results');
    c.app.exit(0);
  } catch (e) { console.error(e.message); c.vanish.close(); c.app.exit(1); }
};
