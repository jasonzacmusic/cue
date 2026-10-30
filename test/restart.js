// Restart test: CUE_TEST=restart CUE_PHASE=1 then CUE_PHASE=2 on the same CUE_USER_DATA.
// Phase 1 builds a three-column split and a split in another Space, then quits. Phase 2 checks both came back.
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (n) => `data:text/html,<title>Pane ${n}</title>`;
module.exports = async (c) => {
  await sleep(500);
  if (process.env.CUE_PHASE === '1') {
    ['A', 'B', 'C'].forEach((n) => c.openTab({ url: page(n), identity: 'personal' }));
    c.setSplit('cols3');
    c.switchSpace('Create');
    ['D', 'E'].forEach((n) => c.openTab({ url: page(n), identity: 'personal' }));
    c.setSplit('rows2');
    c.switchSpace('Teach');
    await sleep(800);
    const names = (sp) => sp.ids.map((id) => c.byId(id)?.title).sort().join(',');
    fs.writeFileSync(path.join(c.app.getPath('userData'), 'want.json'), JSON.stringify({ teach: names(c.store.data.split), create: names(c.store.data.spaceSplit.Create) }));
    c.app.quit();
    return;
  }
  await sleep(1500);
  const want = JSON.parse(fs.readFileSync(path.join(c.app.getPath('userData'), 'want.json'), 'utf8'));
  const titles = (ids) => ids.map((id) => c.byId(id)?.title).sort().join(',');
  const s = c.getState();
  const first = s.split.mode === 'cols3' && s.panes.length === 3 && titles(s.split.ids) === want.teach;
  console.log(`[cue-restart] ${first ? 'PASS' : 'FAIL'} three columns came back`, s.split.mode, titles(s.split.ids), s.panes.length);
  c.switchSpace('Create'); await sleep(800);
  const t = c.getState();
  const second = t.split.mode === 'rows2' && t.panes.length === 2 && titles(t.split.ids) === want.create;
  console.log(`[cue-restart] ${second ? 'PASS' : 'FAIL'} the other Space kept its own split`, t.split.mode, titles(t.split.ids), t.panes.length);
  c.closeTab(t.split.ids[0]); await sleep(300);
  const u = c.getState();
  console.log(`[cue-restart] ${u.split.mode === 'single' ? 'PASS' : 'FAIL'} closing one of two closes up the split`, u.split.mode, u.panes.length);
  c.app.quit();
};
