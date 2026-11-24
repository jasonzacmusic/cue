// Run inside Cue with CUE_TEST=homepages-bills and an empty CUE_USER_DATA.
const assert = require('node:assert/strict');
const { homepageKey } = require('../src/main/homepage');
const bills = require('../src/main/bills');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(read, message) {
  for (let i = 0; i < 100; i++) { if (await read()) return; await wait(70); }
  throw Error(message);
}
module.exports = async c => {
  try {
    for (const text of ['Your invoice is not paid', 'If your payment failed, contact support']) assert.equal(bills.readPage(text).status, undefined);
    assert.equal(bills.readPage('Payment status: Paid').status, 'paid');
    const folder = 'personal';
    const open = url => c.openTab({ url, identity: folder });
    for (const host of ['yahoo.com', 'espncricinfo.com', 'youtube.com']) {
      const home = open('https://' + host + '/');
      assert.equal(open('https://www.' + host + '/?utm_source=link').id, home.id);
    }
    const drive = open('https://drive.google.com/drive/u/0/home');
    assert.equal(open('https://drive.google.com/').id, drive.id);
    assert.notEqual(open('https://drive.google.com/drive/u/1/home').id, drive.id);
    const files = ['drive/folders/a', 'drive/folders/b'].map(p => open('https://drive.google.com/' + p));
    assert.notEqual(files[0].id, files[1].id);
    const videos = ['watch?v=a', 'watch?v=b'].map(p => open('https://www.youtube.com/' + p));
    assert.notEqual(videos[0].id, videos[1].id);
    for (const p of ['/results?search_query=music', '/#inbox', '/?q=news', '/shorts/video']) assert.equal(homepageKey('https://example.test'+p), '');
    c.setSetting('reuseHomepages', false);
    assert.notEqual(open('https://drive.google.com/').id, drive.id);
    c.setSetting('reuseHomepages', true);
    const fresh = c.openTab({identity:folder}); c.activate(fresh.id);
    c.command('navigate', {text:'https://drive.google.com/'});
    assert(!c.byId(fresh.id)); assert.notEqual(c.getState().activeId, fresh.id);
    console.log('PASS homepage reuse, separate Drive accounts and folders, videos, setting off, empty-tab address entry');
    const tab = open('cue://bills'); c.activate(tab.id);
    const page = code => tab.view.webContents.executeJavaScript(code, true);
    await until(()=>page("!!document.querySelector('#bills .empty')").catch(()=>false), 'empty real bills page');
    assert.equal(await page("document.querySelectorAll('li.bill,li.alert').length"), 0);
    assert.equal(await c.ui().webContents.executeJavaScript("document.querySelector('#openbills').hidden"),false);
    const today = new Date();
    function date(offset) { const d = new Date(today); d.setDate(d.getDate() + offset); return bills.iso(d); }
    async function add(name, offset) {
      const due = date(offset);
      await page(`document.querySelector('#addBtn').click();
        const form=document.querySelector('form');
        form.querySelector('input[type=text]').value=${JSON.stringify(name)};
        form.querySelector('input[type=date]').value=${JSON.stringify(due)};
        form.querySelector('input[type=number]').value='19.95';
        form.querySelector('button[type=submit]').click(); true`.replace('const form=', 'var form='));
      await until(()=>page(`[...document.querySelectorAll('.nm')].some(x=>x.textContent===${JSON.stringify(name)})`),'bill saved');
    }
    await add('Week boundary',7); await add('Later bill',8); await add('Due now',0); await add('Missed payment',-2);
    assert.equal(c.store.data.bills.length,4); assert.equal(c.store.data.alerts.length,3);
    assert(c.store.data.alerts.every(a=>a.kind==='bill' && a.billId && a.folder===folder));
    assert(c.store.data.alerts.some(a=>a.title.includes('overdue by 2 days')));
    assert.equal(c.store.data.bills.find(b=>b.name==='Missed payment').renews,date(-2));
    c.checkBills(); assert.equal(c.store.data.alerts.length,3);
    assert.equal(await page("document.querySelectorAll('li.alert').length"),3);
    assert.equal(await page("document.querySelectorAll('#bills h3').length"),4);
    await page("document.querySelector('#alertFilter').value='website';document.querySelector('#alertFilter').dispatchEvent(new Event('change'))");
    assert.equal(await page("document.querySelectorAll('li.alert').length"),0);
    await page("document.querySelector('#readAlerts').click()");
    await until(()=>c.store.data.alerts.every(a=>a.seen),'mark read');
    await page("[...document.querySelectorAll('li.bill')].find(n=>n.textContent.includes('Missed payment')).querySelector('button').click()");
    await until(()=>c.store.data.bills.find(b=>b.name==='Missed payment').status==='paid','mark overdue bill paid');
    tab.view.webContents.reload();
    await until(()=>page("document.querySelectorAll('li.bill').length===4").catch(()=>false),'bills survived reload');
    console.log('PASS fresh bell, Add bill through real form, currency decimals, seven-day boundary, overdue, due today, alert filter, explicit read, mark paid and reload');
    assert.equal(bills.fromPage([], 'https://shop.test/plans', 'Plan costs $20. Update your payment details.', 1),null);
    const paid = {status:'paid',renews:'2026-01-31',repeat:'monthly'};
    bills.roll(paid,new Date(2026,1,1)); assert.equal(paid.renews,'2026-02-28'); assert.equal(paid.status,'ok');
    console.log('PASS generic pricing ignored and paid monthly renewal advances to month end');
    c.app.exit(0);
  } catch (e) { console.error(e); c.app.exit(1); }
};
