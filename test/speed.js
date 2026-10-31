// Speed test: CUE_TEST=speed CUE_USER_DATA=<tmp> CUE_OUT=<dir> electron .
//
// The same busy pages with the shield off and on, from an empty cache. Prints what actually
// changed: requests, megabytes, seconds to finish loading, and memory for the tab.
const fs = require('fs');
const path = require('path');

const PAGES = process.env.CUE_PAGES ? process.env.CUE_PAGES.split(',') : ['https://www.ndtv.com/', 'https://timesofindia.indiatimes.com/', 'https://www.hindustantimes.com/', 'https://www.cnn.com/', 'https://www.theguardian.com/'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(c, url) {
  const ses = c.sessionFor('personal');
  await ses.clearCache();
  const t = c.openTab({ url: 'about:blank', identity: 'personal' }); await sleep(500);
  const wc = t.view.webContents;
  let requests = 0; let bytes = 0; const top = {};
  wc.debugger.attach('1.3');
  wc.debugger.on('message', (_e, m, p) => {
    if (m === 'Network.requestWillBeSent') { requests++; const u = String(p.request.url).split('?')[0]; top[u] = (top[u] || 0) + 1; }
    if (m === 'Network.loadingFinished') bytes += p.encodedDataLength;
  });
  await wc.debugger.sendCommand('Network.enable');
  const start = Date.now();
  const done = new Promise((r) => wc.once('did-finish-load', r));
  wc.loadURL(url).catch(() => {});
  await Promise.race([done, sleep(30000)]);
  const seconds = (Date.now() - start) / 1000;
  await sleep(8000); // what a page goes on fetching after it looks finished is the real cost of ads
  const pid = wc.getOSProcessId();
  const m = c.app.getAppMetrics().find((x) => x.pid === pid);
  if (process.env.CUE_PAGES) console.log('[cue-speed] busiest', JSON.stringify(Object.entries(top).sort((x, y) => y[1] - x[1]).slice(0, 5)));
  const out = { requests, mb: +(bytes / 1048576).toFixed(1), seconds: +seconds.toFixed(1), memoryMB: m ? Math.round(m.memory.workingSetSize / 1024) : null };
  try { wc.debugger.detach(); } catch {}
  c.closeTab(t.id); await sleep(800);
  return out;
}

const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);

module.exports = async function run(c) {
  while (!(c.shield() && c.shield().ready())) await sleep(500);
  const off = []; const on = [];
  for (const blockAds of [false, true]) {
    c.setSetting('blockAds', blockAds); await sleep(500);
    for (const url of PAGES) (blockAds ? on : off).push({ url, ...(await measure(c, url)) });
  }
  const totals = {};
  for (const k of ['requests', 'mb', 'seconds', 'memoryMB']) totals[k] = { off: +sum(off, k).toFixed(1), on: +sum(on, k).toFixed(1), saved: `${Math.round((1 - sum(on, k) / sum(off, k)) * 100)}%` };
  console.log('[cue-speed]', JSON.stringify(totals));
  for (let i = 0; i < PAGES.length; i++) console.log('[cue-speed]', PAGES[i], JSON.stringify(off[i]), JSON.stringify(on[i]));
  fs.writeFileSync(path.join(process.env.CUE_OUT || '/tmp', 'speed.json'), JSON.stringify({ totals, off, on }, null, 2));
  c.app.quit();
};
