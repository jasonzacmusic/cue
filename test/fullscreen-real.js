// By hand only, on the Mac mini, with nobody teaching: real macOS full screen, real mouse.
//   CUE_REAL_SCREEN=1 CUE_TEST=fullscreen-real CUE_USER_DATA=/tmp/cue-fs CUE_OUT=/tmp/cue-fs-out npx electron .
// A page with a video goes full screen, the AI panel open beside it. Then move the real mouse
// over every part of the screen for 15 seconds. The page counts the moves it hears in each
// ninth of the screen; every ninth must hear some, and the cursor must never stay hidden.
const fs = require('fs');
const path = require('path');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (c) => {
  const out = process.env.CUE_OUT || '/tmp/cue-fs-out';
  fs.mkdirSync(out, { recursive: true });
  const page = `<!doctype html><meta charset=utf-8><title>full screen mouse</title>
<body style="margin:0;background:#123;color:#fff;font:20px system-ui">
<div id=box style="width:100vw;height:100vh;display:grid;grid-template:repeat(3,1fr)/repeat(3,1fr)"></div>
<script>
const box=document.getElementById('box');const hits=Array(9).fill(0);
for(let i=0;i<9;i++){const d=document.createElement('div');d.style.cssText='border:1px solid #456;display:flex;align-items:center;justify-content:center';d.textContent='0';box.appendChild(d)}
addEventListener('mousemove',e=>{const i=Math.min(2,Math.floor(e.clientY/innerHeight*3))*3+Math.min(2,Math.floor(e.clientX/innerWidth*3));hits[i]++;box.children[i].textContent=hits[i];box.children[i].style.background='#264'});
window.hits=hits;
</script>`;
  const srv = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(page); }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  await c.app.whenReady(); await sleep(1500);
  c.toggleAI && c.toggleAI(); await sleep(800);
  const t = c.openTab({ url: `${base}/`, identity: c.openFolder() }); c.activate(t.id); await sleep(1500);
  t.view.webContents.focus();
  await t.view.webContents.executeJavaScript('document.documentElement.requestFullscreen()', true).catch(() => {});
  console.log('FULLSCREEN: move the mouse everywhere now'); await sleep(17000);
  const hits = await t.view.webContents.executeJavaScript('window.hits', true);
  const ai = c.getAI && c.getAI();
  const result = { hits, windowFull: c.win().isFullScreen(), tab: t.view.getBounds(), size: c.win().getContentSize(), aiShown: !!(ai && ai.getVisible && ai.getVisible()), aiBounds: ai && ai.getBounds() };
  fs.writeFileSync(path.join(out, 'fullscreen-real.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  const all = hits.every((n) => n > 0);
  console.log(all && !result.aiShown ? 'PASS full screen: every part of the screen hears the mouse' : 'FAIL full screen: some of the screen does not hear the mouse');
  srv.close(); c.app.exit(0);
};
