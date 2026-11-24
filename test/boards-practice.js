// Disposable two-color tab, exercised with real mouse input and the folder's Boards database.
const assert = require('node:assert/strict');
const http = require('node:http');
const {nativeImage} = require('electron');
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
module.exports = async c => {
  const server = http.createServer((_q,r)=>{r.setHeader('content-type','text/html');r.end('<title>Practice arrangements</title><body style="margin:0;background:blue;height:2500px"><section style="width:220px;height:160px;background:lime"></section><button onclick="this.textContent=\'Marker selected\'">Select rehearsal</button><p>Lesson marker is tulip.</p>');});
  try {
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    require('./world').asOwner(c);
    const tab = c.openTab({url:'http://127.0.0.1:'+server.address().port+'/',identity:'personal'});
    c.activate(tab.id); const wc=tab.view.webContents, ui=c.ui().webContents;
    const bar = code=>ui.executeJavaScript(code,true);
    await wait(700);
    c.win().setBounds({...c.win().getBounds(),x:-8500,y:0}); c.win().setOpacity(1);
    const mine=c.lib.in('personal'), board=mine.boardCreate('Design references');
    await c.runTool('board-full',tab,board);
    const pending=c.runTool('board-area',tab,board);await wait(300);
    for (const [type,x,y] of [['mouseMove',20,15],['mouseDown',20,15],['mouseMove',110,75],['mouseUp',110,75]])
      wc.sendInputEvent({type,x,y,button:'left',clickCount:1});
    await pending;
    const items=mine.boardList()[0].items;assert.equal(items.length,2);
    const pics=items.map(i=>nativeImage.createFromBuffer(Buffer.from(mine.boardPicture(i.id))));
    const scale=await wc.executeJavaScript('devicePixelRatio');assert.equal(pics[0].getSize().width,90*scale);assert.equal(pics[0].getSize().height,60*scale);
    const pixels=pics[0].toBitmap();assert.equal(pixels[1],255);assert.equal(pixels[2],0);
    assert(pics[1].getSize().height>=2500);assert(!c.lib.in('school').boardPicture(items[0].id));
    assert(items.every(i=>i.source===wc.getURL()));
    const bt=c.openTab({url:'cue://boards',identity:'personal'});await wait(500);
    const boardPage=bt.view.webContents;
    assert.equal(await boardPage.executeJavaScript("document.querySelectorAll('.card').length"),2);
    assert.equal(await boardPage.executeJavaScript("document.querySelectorAll('.card img')[0].naturalWidth"),90*scale);
    console.log('PASS full page, pixel-checked drag selection, original pixels held locally in the right folder and rendered on Boards');
    c.activate(tab.id);c.command('side-width',{w:64});await wait(250);
    const pos=await bar(`(()=>{const r=document.querySelector('.tab[data-id="${tab.id}"] .fav').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const clickCount of [1,2]) { for(const type of ['mouseDown','mouseUp']) ui.sendInputEvent({type,...pos,button:'left',clickCount}); await wait(85); }
    assert(await bar("!!document.querySelector('#tab-rename-field')"));
    await bar("const f=document.querySelector('#tab-rename-field');f.value='Practice board';f.form.requestSubmit();true");
    await wait(150);assert.equal(tab.name,'Practice board');
    c.command('side-hide');await wait(200);assert(await bar("!document.querySelector('#sideshow').hidden"));await bar("document.querySelector('#sideshow').click()");await wait(200);assert(!c.store.data.settings.sideHidden);
    assert.equal(c.siteName({url:'https://claude.ai/chat/a',title:'Practice plans - Claude'}),'Practice plans');
    assert.equal(c.siteName({url:'https://claude.ai/chat/b',title:'Claude | Rhythm changes'}),'Rhythm changes');
    console.log('PASS compact icon double-click rename, hide/show toggle, separate Claude chat titles');
    if(process.env.CUE_ACCOUNT_PROOF) {
      const ask = (cmd,args)=>bar('window.cue.invoke('+JSON.stringify(cmd)+','+JSON.stringify(args)+')');
      const result=await ask('ask-local-run',{id:tab.id,which:'codex',question:'What is the lesson marker? Select the button named Select rehearsal.'});
      assert(/tulip/i.test(result.answer),result.answer);assert.equal(result.label,'Select rehearsal');
      assert(await ask('ask-local-click',{id:tab.id,doc:result.doc}));
      assert.equal(await wc.executeJavaScript("document.querySelector('button').textContent"),'Marker selected');
      console.log('PASS signed-in Codex read the marker, proposed the correct control, and the confirmed click changed the page');
    }
    server.close();c.app.exit(0);
  }catch(e){console.error(e);server.close();c.app.exit(1);}
};
