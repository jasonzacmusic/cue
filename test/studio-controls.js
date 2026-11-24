// Exercise the actual music-strip controls, screenshot picker and separate mute layers.
const assert = require('node:assert/strict');
const { clipboard, Menu } = require('electron');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async c => {
  const write = clipboard.writeImage;
  try {
    await wait(1200);
    require('./world').asOwner(c);
    const html = '<body style="margin:0"><section style="width:220px;height:160px;background:lime">Part</section><div style="height:2500px"></div>';
    const tab = c.openTab({ url:'data:text/html,' + encodeURIComponent(html) });
    const wc = tab.view.webContents;
    while (wc.isLoading()) await wait(60);
    c.activate(tab.id); await wait(550);
    assert.equal(c.getState().activeId, tab.id);
    let picture;
    clipboard.writeImage = image => { picture = image; };
    let notice;
    const sidebar = c.ui().webContents, send = sidebar.send.bind(sidebar);
    sidebar.send = (ch, ...args) => { if (ch === 'ui:event' && args[0] === 'toast') notice = args[1]; return send(ch,...args); };
    const bounds = c.win().getBounds();
    c.win().setBounds({...bounds,x:-8500,y:0}); c.win().setOpacity(1);
    await wait(300);
    await c.runTool('copy-visible', tab);
    assert(picture && !picture.isEmpty(),notice || JSON.stringify({active:c.getState().activeId,id:tab.id,host:tab.host}));
    const visible = picture.getSize();
    await c.runTool('copy-full', tab);
    assert(picture.getSize().height > visible.height);
    for (const mode of ['area', 'section']) {
      picture = null;
      const pending = c.runTool('copy-' + mode, tab);
      await wait(200);
      for (const [type,x,y] of [['mouseMove',20,15],['mouseDown',20,15],['mouseMove',110,75],['mouseUp',110,75]]) {
        wc.sendInputEvent({type,x,y,button:'left',clickCount:1});
      }
      await Promise.race([pending, wait(5000).then(() => { throw Error(mode + ' selection timed out'); })]);
      assert(picture && !picture.isEmpty(), mode);
      const size = picture.getSize(), ratio = size.width / size.height;
      assert(Math.abs(ratio - (mode === 'area' ? 90/60 : 220/160)) < .04, mode + ' ' + JSON.stringify(size));
    }
    const ui = code => c.ui().webContents.executeJavaScript(code, true);
    c.command('strip'); await wait(150);
    await ui("document.querySelector('#metro-play').click()");
    await wait(250);
    assert.equal(await ui("document.querySelector('#metro-play').getAttribute('aria-pressed')"), 'true');
    await ui("document.querySelector('#metro-tap').click()"); await wait(500);
    await ui("document.querySelector('#metro-tap').click()");
    assert(Math.abs(await ui("Number(document.querySelector('#metro-bpm').value)") - 120) < 12);
    c.command('strip'); await wait(150);
    assert.equal(await ui("document.querySelector('#metro-play').getAttribute('aria-pressed')"), 'false');
    await wc.executeJavaScript(`window.synth = new AudioContext(); const osc = synth.createOscillator(); osc.connect(synth.destination); osc.start(); synth.resume()`, true);
    wc.send('cue:music', 'transpose', 5); await wait(200);
    assert.equal(await ui("document.querySelector('#m-semi').textContent"), '+5');
    wc.send('cue:music','reset'); await wait(100);
    assert.equal(await ui("document.querySelector('#m-semi').textContent"), '0');
    await wc.executeJavaScript('synth.close()', true);
    const quiet = c.openTab({url:'data:text/html,quiet'}); c.setMuted(quiet,true);
    c.command('master-mute'); assert(wc.isAudioMuted());
    const late = c.openTab({url:'data:text/html,late'}); assert(late.view.webContents.isAudioMuted());
    c.command('cue-add',{id:tab.id}); c.agentApi.livequeue('enter');
    assert(wc.isAudioMuted()); c.command('master-mute'); assert(!wc.isAudioMuted());
    assert(quiet.view.webContents.isAudioMuted() && late.view.webContents.isAudioMuted());
    c.agentApi.livequeue('leave'); assert(!late.view.webContents.isAudioMuted() && quiet.view.webContents.isAudioMuted());
    const keys = new Map();
    function walk(menu) {
      for (const item of menu.items) {
        if (item.submenu) walk(item.submenu);
        if (!item.accelerator) continue;
        const key = item.accelerator.toLowerCase().split('+').sort().join('+');
        assert(!keys.has(key), key + ' belongs to ' + keys.get(key) + ' and ' + item.label);
        keys.set(key,item.label);
      }
    }
    walk(Menu.getApplicationMenu());
    console.log('PASS capture visible/full/area/section, metronome, tap tempo, master mute, queue audio, unique menu shortcuts');
    c.app.quit();
  } catch(e) {console.error(e);c.app.exit(1);}
  finally { clipboard.writeImage = write; }
};
