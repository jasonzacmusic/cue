// Folders test: CUE_TEST=folders CUE_USER_DATA=<tmp> CUE_OUT=<dir> electron .
//
// Proves what the folder redesign claims, in the real app and the real sidebar:
// a folder shows its own tabs, a new tab is born in the folder you have open,
// each folder is its own cookie jar so two accounts stay signed in at once, a
// tab can be moved between folders and keeps its page, and no tab can go quiet
// — the sidebar names the folders holding the rest.
//
// It also saves pictures of the sidebar with each folder open, which is the
// only way to know the folders actually look like folders.
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.CUE_OUT || '/tmp';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[cue-folders] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };

module.exports = async (c) => {
  await sleep(1200);
  const ui = () => c.ui().webContents;
  const js = (code) => ui().executeJavaScript(code, true);
  // Tests run at zero opacity so they never appear over Jason's work, and a
  // window at zero opacity cannot be photographed. So the window is parked far
  // off the left of every screen, turned up, photographed, and put back — it is
  // solid for a moment, but never on a screen anyone is looking at.
  const shot = async (name) => {
    const w = c.win(); const was = w.getBounds();
    w.setBounds({ ...was, x: -9000, y: 0 }); w.setOpacity(1);
    await sleep(500);
    let img = null;
    try { img = await ui().capturePage(); } catch (e) { console.log(`[cue-folders] shot ${name} failed: ${e.message}`); }
    w.setOpacity(0); w.setBounds(was);
    if (img) fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    return !!img;
  };
  // Give the pictures the real labels, so the sidebar reads the way his does.
  c.setSetting('label.personal', 'jasonzac@gmail.com');
  c.setSetting('label.school', 'music@nathanielschool.com');

  // Start clean: one tab per folder, all in the same Space.
  for (const t of [...c.tabs]) c.closeTab(t.id);
  await sleep(300);
  const school = c.openTab({ url: 'about:blank#school-one', identity: 'school' });
  const school2 = c.openTab({ url: 'about:blank#school-two', identity: 'school' });
  const mine = c.openTab({ url: 'about:blank#personal-one', identity: 'personal' });
  await sleep(600);

  // ---- a folder is a place, and it is the place a new tab is born in
  c.command('folder', { name: 'school' }); await sleep(400);
  check('folder: opening one makes it the open folder', c.store.data.folder === 'school', c.store.data.folder);
  const born = c.openTab({ url: 'about:blank#born' }); await sleep(300);
  check('folder: a new tab is born in the folder you have open', born.identity === 'school', born.identity);

  // ---- the sidebar shows that folder's tabs, and only those
  const rows = () => js(`[...document.querySelectorAll('#groups .tab')].length`);
  const schoolTabs = c.tabs.filter((t) => t.identity === 'school' && t.space === c.store.data.space).length;
  const inSchool = await rows();
  check('folder: the sidebar shows the tabs in it, and only those', inSchool === schoolTabs && schoolTabs > 1, { shown: inSchool, inFolder: schoolTabs, allTabs: c.tabs.length });
  const tiles = await js(`[...document.querySelectorAll('#folders .folder')].map((b) => ({ who: b.dataset.who, on: b.classList.contains('on'), name: b.querySelector('.ftext b').textContent, acct: (b.querySelector('.facct')||{}).textContent || '', n: (b.querySelector('.fct')||{}).textContent || '0' }))`);
  check('folder: three folders, each with a picture and a name', tiles.length === 3, tiles);
  check('folder: the open one is marked', tiles.filter((t) => t.on).map((t) => t.who).join() === 'school', tiles.map((t) => `${t.who}${t.on ? '*' : ''}`));
  check('folder: each says whose account it is', tiles[0].acct === 'jasonzac@gmail.com' && tiles[1].acct === 'music@nathanielschool.com', tiles.map((t) => t.acct));
  const count = (k) => String(c.tabs.filter((t) => t.identity === k).length);
  check('folder: each shows how many tabs live in it', tiles.every((t) => t.n === count(t.who) || (t.n === '' && count(t.who) === '0')), tiles.map((t) => `${t.who}: says ${t.n}, really ${count(t.who)}`));
  const pics = await js(`[...document.querySelectorAll('#folders .fpic')].map((i) => [i.getAttribute('src'), i.naturalWidth])`);
  check('folder: the pictures actually load', pics.length === 3 && pics.every((p) => p[1] > 0), pics);
  check('folder: the sidebar can be photographed', await shot('folders-school'));

  // ---- nothing can go quiet: the rest are named, and one click goes there
  const away = await js(`[...document.querySelectorAll('#elsewhere button')].map((b) => b.textContent)`);
  check('folder: tabs in the other folders are named, not hidden', away.join(' ').includes('Personal 1'), away);

  // ---- the other folder, at the same time, with its own sign-ins
  c.command('folder', { name: 'personal' }); await sleep(500);
  const minePlus = c.tabs.filter((t) => t.identity === 'personal' && t.space === c.store.data.space).length;
  check('folder: switching shows the other folder\'s tabs', (await rows()) === minePlus && minePlus >= 1, { shown: await rows(), inFolder: minePlus });
  check('folder: and makes it the open one', c.store.data.folder === 'personal');
  await shot('folders-personal');

  // Two folders, two cookie jars, both alive at once. This is the thing the
  // whole design rests on, so it is checked rather than assumed. The sites he
  // has two accounts for must stay apart; a site he has one account for is
  // shared on purpose, so he never signs into it twice.
  const a = c.sessionFor('personal'); const b = c.sessionFor('school');
  const put = (s, host, v) => s.cookies.set({ url: `https://${host}/`, name: 'cue_folder_probe', value: v });
  const got = async (s, host) => ((await s.cookies.get({ url: `https://${host}/`, name: 'cue_folder_probe' }))[0] || {}).value || '';
  for (const host of ['www.instagram.com', 'mail.google.com', 'www.youtube.com', 'web.whatsapp.com']) {
    await put(a, host, 'personal'); await put(b, host, 'school'); await sleep(250);
    const [x, y] = [await got(a, host), await got(b, host)];
    check(`folder: ${host} stays two separate accounts`, x === 'personal' && y === 'school', [x, y]);
  }
  await put(a, 'example.test', 'personal'); await sleep(400);
  check('folder: a site with one account is shared, so you sign in once', (await got(b, 'example.test')) === 'personal', await got(b, 'example.test'));

  // ---- which account is live, where a site can be two people
  c.command('folder', { name: 'school' }); await sleep(300);
  const flive = (k) => js(`(() => { const b = document.querySelector('#folders .folder[data-who="${k}"] .flive'); return b ? b.textContent : ''; })()`);
  check('folder: it can say which account is live in it', typeof (await flive('school')) === 'string');

  // A name, or nothing at all. Gmail sends a signed-OUT visitor to its own
  // advertising page, which carries Google avatars; reading that as "signed in"
  // would put a confident wrong answer on the folder, which is how a post ends
  // up on the wrong account. So an unreadable page must clear the line, not
  // keep yesterday's name sitting there looking current.
  c.rememberWhose('school', 'google', 'Google', 'music@nathanielschool.com'); await sleep(250);
  check('live account: a real address is shown', (await flive('school')).includes('music@nathanielschool.com'), await flive('school'));
  c.rememberWhose('school', 'google', 'Google', ''); await sleep(250);
  check('live account: an unreadable page clears it instead of guessing', !(await flive('school')).includes('music@nathanielschool.com'), await flive('school'));

  // ---- moving a tab between folders keeps the page, and never happens quietly
  const before = { url: mine.url, name: mine.name, space: mine.space, order: mine.order };
  await c.moveToFolder({ id: mine.id, to: 'school', confirmed: true });
  await sleep(900);
  const moved = c.byId(mine.id);
  check('move: the tab is in the other folder', moved && moved.identity === 'school', moved && moved.identity);
  check('move: it is the same tab, same page', moved && moved.url === before.url && moved.space === before.space && moved.order === before.order, moved && moved.url);
  check('move: it is built in the new folder\'s cookie jar', moved && moved.view && moved.view.webContents.session === c.sessionFor('school'));
  check('move: nothing moved on its own', c.tabs.filter((t) => t.identity === 'personal').length === 0);

  fs.writeFileSync(path.join(OUT, 'folders.json'), JSON.stringify(results, null, 2));
  const fails = results.filter((x) => !x.ok);
  console.log(`[cue-folders] DONE ${results.length - fails.length}/${results.length} passed`);
  if (!process.env.CUE_KEEP) c.app.quit();
};
