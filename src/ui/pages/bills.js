'use strict';
// Bills radar and alert tray. Every string from the app is written with textContent.
(() => {
  const SAMPLE = !window.cueInternal;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  let toastTimer = 0;
  function toast(msg) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = el('div', 'toast', msg); t.setAttribute('role', 'status'); document.body.appendChild(t);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3200);
  }

  // ---- dates ----
  const DAY = 86400000;
  function todayStart() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function parseDay(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function daysUntil(s) { const d = parseDay(s); return d ? Math.round((d - todayStart()) / DAY) : null; }
  function isoDay(offset) { const d = new Date(todayStart().getTime() + offset * DAY); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function nice(s) { const d = parseDay(s); return d ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : 'No date'; }
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) { const h = Math.floor(s / 3600); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    const d = Math.floor(s / 86400); if (d === 1) return 'yesterday'; if (d < 7) return d + ' days ago';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

  // ---- sample data ----
  const sample = (() => {
    if (!SAMPLE) return null;
    const now = Date.now();
    const db = {
      usdToInr: 88.4,
      bills: [
        { id: 'a', name: 'Adobe Creative Cloud', url: 'https://account.adobe.com', amountINR: 4230, renews: isoDay(2), status: 'due', note: 'Card ending 4417' },
        { id: 'b', name: 'Claude Max', url: 'https://claude.ai/settings', amountINR: 17680, renews: isoDay(5), status: 'ok', note: '' },
        { id: 'c', name: 'Zoom Pro', url: 'https://zoom.us/billing', amountINR: 1560, renews: isoDay(-1), status: 'failed', note: 'Bank declined it. Try the other card.' },
        { id: 'd', name: 'Google Workspace', url: 'https://admin.google.com', amountINR: 2100, renews: isoDay(21), status: 'ok', note: '' },
        { id: 'e', name: 'Vercel Pro', url: 'https://vercel.com/account', amountINR: 1768, renews: isoDay(12), status: 'paid', note: 'Paid by Luna' },
        { id: 'f', name: 'Final Cut Pro cloud storage', url: '', amountINR: 790, renews: isoDay(0), status: 'due', note: '' },
      ],
      alerts: [
        { id: '1', source: 'gmail.com', title: 'Your Zoom payment did not go through', body: 'We could not charge the card on file for your Zoom Pro plan. Update your payment details to keep hosting meetings.', at: now - 25 * 60000, url: 'https://zoom.us/billing', held: true },
        { id: '2', source: 'web.whatsapp.com', title: 'Jatin', body: 'Sir, the interns are ready for tomorrow.', at: now - 3 * 3600000, url: '', held: true },
        { id: '3', source: 'studio.youtube.com', title: 'New comment on Circle of Fifths in 10 minutes', body: 'This finally made it click, thank you.', at: now - 26 * 3600000, url: 'https://studio.youtube.com', held: false },
        { id: '4', source: 'github.com', title: 'Build passed', body: '', at: now - 5 * 86400000, url: '', held: false },
      ],
    };
    return db;
  })();
  async function fake(cmd, a) {
    if (cmd === 'bills.list') return JSON.parse(JSON.stringify({ bills: sample.bills, usdToInr: sample.usdToInr }));
    if (cmd === 'bills.save') {
      const b = Object.assign({}, a.bill);
      if (!b.id) { b.id = 'n' + Date.now(); sample.bills.push(b); } else { const i = sample.bills.findIndex((x) => x.id === b.id); if (i >= 0) sample.bills[i] = b; }
      return b;
    }
    if (cmd === 'bills.delete') { sample.bills = sample.bills.filter((x) => x.id !== a.id); return true; }
    if (cmd === 'bills.setRate') { sample.usdToInr = a.usdToInr; return true; }
    if (cmd === 'alerts.list') return JSON.parse(JSON.stringify(sample.alerts));
    if (cmd === 'alerts.clear') { sample.alerts = []; return true; }
    if (cmd === 'open') { toast('Would open ' + a.url); return true; }
    return null;
  }
  const call = (cmd, args) => (window.cueInternal ? window.cueInternal.invoke(cmd, args || {}) : fake(cmd, args || {}));

  // ---- state ----
  let bills = []; let rate = 83; let alerts = [];
  let editing = null;      // bill id being edited, or 'new'
  let confirmDel = null;

  async function load() {
    try {
      const r = (await call('bills.list')) || {};
      bills = r.bills || []; if (r.usdToInr > 0) rate = r.usdToInr;
    } catch (e) { bills = []; toast('Could not load your bills.'); }
    try { alerts = (await call('alerts.list')) || []; } catch (e) { alerts = []; }
    render();
  }

  function status(b) {
    const d = daysUntil(b.renews);
    if (b.status === 'paid') return { cls: 'ok', text: 'Paid' };
    if (b.status === 'failed') return { cls: 'bad', text: 'Card failed' };
    if (d == null) return { cls: '', text: 'No date' };
    if (d < 0) return { cls: 'bad', text: 'Overdue by ' + (-d) + (d === -1 ? ' day' : ' days') };
    if (d === 0) return { cls: 'soon', text: 'Due today' };
    return { cls: (b.status === 'due' || d <= 7) ? 'soon' : '', text: 'Due in ' + d + (d === 1 ? ' day' : ' days') };
  }

  function renderStrip() {
    const s = $('strip'); s.textContent = '';
    let total = 0; let n = 0; let failed = 0;
    for (const b of bills) {
      if (b.status === 'failed') failed++;
      if (b.status === 'paid') continue;
      const d = daysUntil(b.renews);
      if (d != null && d <= 7) { total += Number(b.amountINR) || 0; n++; }
    }
    const t1 = el('div', 'tile' + (total > 0 ? ' warn' : ' good'));
    t1.append(el('div', 'k', 'Due in the next 7 days'), el('div', 'v', inr(total)), el('div', 's', n === 0 ? 'Nothing coming up' : n === 1 ? '1 bill to pay' : n + ' bills to pay'));
    const t2 = el('div', 'tile' + (failed ? ' bad' : ' good'));
    t2.append(el('div', 'k', 'Cards that failed'), el('div', 'v', String(failed)), el('div', 's', failed ? 'Fix these first, the service may stop' : 'All cards are working'));
    const t3 = el('div', 'tile rate-tile'); t3.append(el('div', 'k', 'Dollar price'));
    const row = el('label', 'rate'); const inp = el('input'); inp.type = 'number'; inp.min = '1'; inp.step = '0.01'; inp.value = String(rate);
    inp.setAttribute('aria-label', 'Rupees per US dollar');
    row.append(el('span', null, '1 US dollar = ₹'), inp);
    inp.addEventListener('change', async () => {
      const v = parseFloat(inp.value); if (!(v > 0)) { inp.value = String(rate); return; }
      rate = v; try { await call('bills.setRate', { usdToInr: v }); toast('Saved. 1 US dollar is ₹' + v + '.'); } catch (e) { toast('Could not save the rate.'); }
    });
    t3.append(row, el('div', 's', 'Used when you type a price in dollars'));
    s.append(t1, t2, t3);
  }

  function field(label, input, cls) { const l = el('label', 'field' + (cls ? ' ' + cls : '')); l.append(el('span', null, label), input); return l; }
  function mkInput(type, value, ph) { const i = el('input'); i.type = type; i.value = value == null ? '' : value; if (ph) i.placeholder = ph; return i; }

  function renderForm(b) {
    const isNew = !b.id;
    const f = el('form', 'form');
    const name = mkInput('text', b.name, 'e.g. Zoom Pro'); name.required = true; name.maxLength = 80;
    const url = mkInput('text', b.url, 'https://… (where you pay)');
    const amt = mkInput('number', b.amountINR || '', '0'); amt.min = '0'; amt.step = '1';
    const usd = mkInput('number', '', 'or dollars'); usd.min = '0'; usd.step = '0.01';
    usd.addEventListener('input', () => { const v = parseFloat(usd.value); if (v > 0) amt.value = String(Math.round(v * rate)); });
    const date = mkInput('date', b.renews || isoDay(30));
    const st = el('select'); [['ok', 'Fine, not due yet'], ['due', 'Due, needs paying'], ['paid', 'Paid'], ['failed', 'Card failed']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; st.appendChild(o); });
    st.value = b.status || 'ok';
    const note = mkInput('text', b.note, 'Anything to remember'); note.maxLength = 200;
    f.append(field('Name', name, 'span3'), field('Renews on', date, 'span3'), field('Amount in rupees (₹)', amt, 'span2'), field('Or amount in US dollars', usd, 'span2'), field('Status', st, 'span2'), field('Payment page', url, 'span3'), field('Note', note, 'span3'));
    const act = el('div', 'actions');
    const save = el('button', 'btn primary', isNew ? 'Add bill' : 'Save changes'); save.type = 'submit';
    const cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button';
    cancel.addEventListener('click', () => { editing = null; render(); });
    act.append(save, cancel, el('span', 'sp'));
    if (!isNew) {
      const del = el('button', 'btn danger' + (confirmDel === b.id ? ' sure' : ''), confirmDel === b.id ? 'Yes, delete it' : 'Delete'); del.type = 'button';
      del.addEventListener('click', async () => {
        if (confirmDel !== b.id) { confirmDel = b.id; render(); return; }
        confirmDel = null; editing = null;
        try { await call('bills.delete', { id: b.id }); toast('Deleted ' + b.name); } catch (e) { toast('Could not delete it.'); }
        load();
      });
      act.appendChild(del);
    }
    f.appendChild(act);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const bill = { name: name.value.trim(), url: url.value.trim(), amountINR: Math.max(0, Math.round(parseFloat(amt.value) || 0)), renews: date.value, status: st.value, note: note.value.trim() };
      if (!bill.name) { name.focus(); return; }
      if (b.id) bill.id = b.id;
      try { await call('bills.save', { bill }); toast(isNew ? 'Added ' + bill.name : 'Saved ' + bill.name); } catch (err) { toast('Could not save the bill.'); return; }
      editing = null; load();
    });
    setTimeout(() => name.focus(), 0);
    return f;
  }

  async function open(url) { try { await call('open', { url }); } catch (e) { toast('Could not open that page.'); } }

  function renderBill(b) {
    const s = status(b);
    const li = el('li', 'bill' + (b.status === 'failed' ? ' failed' : ''));
    li.appendChild(el('div', 'nm', b.name || 'Unnamed bill'));
    li.appendChild(el('div', 'amt', inr(b.amountINR)));
    li.appendChild(el('span', 'badge ' + s.cls, s.text));
    li.appendChild(el('div', 'sub', 'Renews ' + nice(b.renews)));
    const acts = el('div', 'acts');
    if (b.url) { const o = el('button', 'btn small', 'Open payment page'); o.type = 'button'; o.addEventListener('click', () => open(b.url)); acts.appendChild(o); }
    if (b.status !== 'paid') {
      const p = el('button', 'btn small', 'Mark paid'); p.type = 'button';
      p.addEventListener('click', async () => { try { await call('bills.save', { bill: Object.assign({}, b, { status: 'paid' }) }); toast('Marked ' + b.name + ' as paid'); } catch (e) { toast('Could not save.'); } load(); });
      acts.appendChild(p);
    }
    const ed = el('button', 'btn small', 'Edit'); ed.type = 'button'; ed.addEventListener('click', () => { editing = b.id; confirmDel = null; render(); });
    acts.appendChild(ed); li.appendChild(acts);
    if (b.note) li.appendChild(el('div', 'note', b.note));
    return li;
  }

  function renderBills() {
    const ul = $('bills'); ul.textContent = '';
    if (editing === 'new') { const li = el('li'); li.appendChild(renderForm({})); ul.appendChild(li); }
    if (!bills.length && editing !== 'new') {
      const li = el('li'); const e = el('div', 'empty'); e.append(el('b', null, 'No bills yet'), el('p', null, 'Add each subscription or card payment with the button above and Cue will count down to the day it renews.')); li.appendChild(e); ul.appendChild(li); return;
    }
    const sorted = bills.slice().sort((a, b) => String(a.renews || '9999').localeCompare(String(b.renews || '9999')));
    for (const b of sorted) {
      if (editing === b.id) { const li = el('li'); li.appendChild(renderForm(b)); ul.appendChild(li); } else ul.appendChild(renderBill(b));
    }
  }

  function renderAlerts() {
    const ul = $('alerts'); ul.textContent = '';
    $('clearAlerts').hidden = !alerts.length;
    if (!alerts.length) { const li = el('li'); const e = el('div', 'empty'); e.append(el('b', null, 'No alerts'), el('p', null, 'Messages and notifications that arrive while you are teaching are kept here until class is over.')); li.appendChild(e); ul.appendChild(li); return; }
    for (const a of alerts.slice().sort((x, y) => (y.at || 0) - (x.at || 0))) {
      const li = el('li', 'alert' + (a.held ? ' held' : ''));
      const top = el('div', 'top'); top.appendChild(el('span', 'src', a.source || 'Cue'));
      if (a.held) top.appendChild(el('span', 'badge soon', 'Held during class'));
      li.appendChild(top);
      const when = el('div', 'when', a.at ? ago(a.at) : ''); if (a.at) when.title = new Date(a.at).toLocaleString(); li.appendChild(when);
      li.appendChild(el('div', 'ttl', a.title || 'Notification'));
      if (a.body) li.appendChild(el('div', 'body', a.body));
      if (a.url) { const g = el('button', 'btn small go', 'Open'); g.type = 'button'; g.addEventListener('click', () => open(a.url)); li.appendChild(g); }
      ul.appendChild(li);
    }
  }

  function render() { renderStrip(); renderBills(); renderAlerts(); }

  $('addBtn').addEventListener('click', () => { editing = 'new'; confirmDel = null; render(); });
  $('clearAlerts').addEventListener('click', async () => {
    try { await call('alerts.clear'); toast('Alerts cleared'); } catch (e) { toast('Could not clear the alerts.'); }
    load();
  });
  if (SAMPLE) $('sampleNote').hidden = false;
  load();
})();
