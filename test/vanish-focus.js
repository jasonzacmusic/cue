// Repeatedly close and reopen a private window while its previous session clears.
const assert = require('node:assert/strict');
const { Menu } = require('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async (c) => {
  try {
    const items = Menu.getApplicationMenu().items.flatMap((m) => m.submenu?.items || []);
    const open = items.find((item) => item.label === 'New Vanish Tab');
    for (let i = 0; i < 6; i++) {
      open.click();
      const bar = c.vanish.ui().webContents;
      const deadline = Date.now() + 5000;
      const inputReady = () => bar.executeJavaScript("document.activeElement?.id === 'url'");
      while (Date.now() < deadline && (bar.isLoading() || !await inputReady())) await sleep(50);
      assert(await inputReady(), 'Opening ' + (i + 1) + ' must focus the address field');
      if (process.env.CUE_REAL_SCREEN) assert(c.vanish.window().isFocused() && bar.isFocused());
      c.vanish.close();
      await sleep(150);
    }
    console.log('PASS first keystroke reaches the private address field through six opens');
    c.app.exit(0);
  } catch (error) { console.error(error); c.app.exit(1); }
};
