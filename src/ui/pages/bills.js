'use strict';
// Bills radar and alert tray. Every string from the app is written with textContent.
(() => {
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
  function nice(s) { const d = parseDay(s); return d ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : 'No date'; }
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) { const h = Math.floor(s / 3600); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    const d = Math.floor(s / 86400); if (d === 1) return 'yesterday'; if (d < 7) return d + ' days ago';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  // Amounts are kept in the person's own currency (the field is still called amountINR, which is
  // what it held when Cue only knew rupees). The currency comes from main with the bills.
  let currency = 'USD';
  const money = (n) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, }).format(Number(n) || 0); } catch { return currency + ' ' + Math.round(Number(n) || 0).toLocaleString(); } };
  const symbol = () => { try { return (new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0).find((x) => x.type === 'currency') || {}).value || currency; } catch { return currency; } };
  const inr = money;

  const call = (cmd, args = {}) => window.cueInternal.invoke(cmd, args);

  // ---- state ----
  let bills = []; let rate = 1; let alerts = [];
  let editing = null;      // bill id being edited, or 'new'
  let confirmDel = null;

  async function load() {
    try {
      const r = (await call('bills.list')) || {};
      bills = r.bills || []; if (r.usdToInr > 0) rate = r.usdToInr; if (r.currency) currency = r.currency;
    } catch (e) { bills = []; toast('Could not load your bills.'); }
    try { alerts = (await call('alerts.list')) || []; } catch (e) { alerts = []; }
    render();
  }

  function status(b) {
    const d = daysUntil(b.renews);
    if (b.status === 'paid') return { cls: 'ok', text: 'Paid' };
    if (b.status === 'failed') return { cls: 'bad', text: 'Card failed' };
    if (d == null) return b.status === 'due' ? { cls: 'soon', text: 'Marked due' } : { cls: '', text: 'No date' };
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
      if (d != null && d >= 0 && d <= 7) { total += Number(b.amountINR) || 0; n++; }
    }
    const t1 = el('div', 'tile' + (total > 0 ? ' warn' : ' good'));
    t1.append(el('div', 'k', 'Due today or in the next 7 days'), el('div', 'v', inr(total)), el('div', 's', n === 0 ? 'Nothing coming up' : n === 1 ? '1 bill to pay' : n + ' bills to pay'));
    const t2 = el('div', 'tile' + (failed ? ' bad' : ' good'));
    t2.append(el('div', 'k', 'Cards that failed'), el('div', 'v', String(failed)), el('div', 's', failed ? 'Fix these first, the service may stop' : 'No failures reported'));
    const t3 = el('div', 'tile rate-tile'); t3.append(el('div', 'k', 'Dollar price'));
    const row = el('label', 'rate'); const inp = el('input'); inp.type = 'number'; inp.min = '1'; inp.step = '0.01'; inp.value = String(rate);
    inp.setAttribute('aria-label', currency + ' per US dollar');
    row.append(el('span', null, '1 US dollar = ' + symbol()), inp);
    inp.addEventListener('change', async () => {
      const v = parseFloat(inp.value); if (!(v > 0)) { inp.value = String(rate); return; }
      rate = v; try { await call('bills.setRate', { usdToInr: v }); toast('Saved. 1 US dollar is ' + symbol() + v + '.'); } catch (e) { toast('Could not save the rate.'); }
    });
    t3.append(row, el('div', 's', 'Used when you type a price in dollars'));
    s.append(t1, t2);
    if (currency !== 'USD') s.append(t3);
  }

  function field(label, input, cls) { const l = el('label', 'field' + (cls ? ' ' + cls : '')); l.append(el('span', null, label), input); return l; }
  function mkInput(type, value, ph) { const i = el('input'); i.type = type; i.value = value == null ? '' : value; if (ph) i.placeholder = ph; return i; }

  function renderForm(b) {
    const isNew = !b.id;
    const f = el('form', 'form');
    const name = mkInput('text', b.name, 'e.g. Zoom Pro'); name.required = true; name.maxLength = 80;
    const url = mkInput('url', b.url, 'https://… (where you pay)');
    const amt = mkInput('number', b.amountINR || '', '0'); amt.min = '0'; amt.step = '0.01';
    const usd = mkInput('number', '', 'or dollars'); usd.min = '0'; usd.step = '0.01';
    usd.addEventListener('input', () => { const v = parseFloat(usd.value); if (v > 0) amt.value = String(Math.round(v * rate * 100) / 100); });
    const date = mkInput('date', b.renews ?? '');
    const st = el('select'); [['ok', 'Follow due date'], ['due', 'Due, needs paying'], ['paid', 'Paid'], ['failed', 'Card failed']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; st.appendChild(o); });
    st.value = b.savedStatus || b.status || 'ok';
    const repeat = el('select');
    for (const [v, label] of [['once','One time'], ['monthly','Monthly']]) {
      const option = el('option', null, label); option.value = v; repeat.append(option);
    }
    repeat.value = b.repeat || (isNew ? 'once' : 'monthly');
    const note = mkInput('text', b.note, 'Anything to remember'); note.maxLength = 200;
    f.append(field('Name', name, 'span3'), field('Due date', date, 'span3'), field('Repeats', repeat, 'span2'), field('Amount (' + symbol() + ')', amt, 'span2'), ...(currency === 'USD' ? [] : [field('Or amount in US dollars', usd, 'span2')]), field('Status', st, 'span2'), field('Payment page', url, 'span3'), field('Note', note, 'span3'));
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
      const bill = { name: name.value.trim(), url: url.value.trim(), amountINR: Number(amt.value) || 0, renews: date.value, status: st.value, repeat: repeat.value, note: note.value.trim() };
      if (save.disabled) return;
      if (!bill.name) { name.focus(); return; }
      if (b.id) bill.id = b.id;
      save.disabled = true;
      try { if (!await call('bills.save', { bill })) throw new Error('Bill unavailable'); toast(isNew ? 'Added ' + bill.name : 'Saved ' + bill.name); } catch (err) { save.disabled = false; toast('Could not save the bill. Check the date, amount and payment link.'); return; }
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
    li.appendChild(el('div', 'sub', (b.renews ? 'Due ' + nice(b.renews) : 'No due date') + (b.repeat === 'monthly' ? ' · Monthly' : '')));
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
    const groups = ['Payment failed', 'Overdue', 'Due today', 'Due in 1–7 days', 'Marked due', 'Later', 'No due date', 'Paid'];
    const group = b => {
      if (b.status === 'failed') return 0;
      if (b.status === 'paid') return 7;
      const d = daysUntil(b.renews);
      if (d !== null && d <= 7) return d < 0 ? 1 : d === 0 ? 2 : 3;
      return b.status === 'due' ? 4 : d === null ? 6 : 5;
    };
    for (const [i, label] of groups.entries()) {
      const items = sorted.filter(b => group(b) === i);
      if (!items.length) continue;
      const head = el('li'); head.append(el('h3', '', label)); ul.append(head);
      for (const b of items) {
        if (editing === b.id) { const li = el('li'); li.append(renderForm(b)); ul.append(li); }
        else ul.append(renderBill(b));
      }
    }
  }

  function renderAlerts() {
    const ul = $('alerts'); ul.textContent = '';
    $('clearAlerts').hidden = !alerts.length;
    const unread = alerts.filter(a => !a.seen && !a.unverifiedSite).length;
    $('readAlerts').hidden = !unread;
    $('readAlerts').textContent = 'Mark ' + unread + ' as read';
    const kind = a => a.unverifiedSite ? 'history' : a.kind || (a.origin ? 'website' : 'other');
    const filter = $('alertFilter').value;
    if (!alerts.length) { const li = el('li'); const e = el('div', 'empty'); e.append(el('b', null, 'No alerts'), el('p', null, 'Bill reminders appear here while Cue is running or the next time it opens. Websites must have permission to send alerts.')); li.appendChild(e); ul.appendChild(li); return; }
    const visible = alerts.filter(a => filter === 'all' || kind(a) === filter);
    if (!visible.length) ul.append(el('li', 'empty', 'No alerts in this category.'));
    for (const a of visible.slice().sort((x, y) => (y.at || 0) - (x.at || 0))) {
      const li = el('li', 'alert' + (a.held ? ' held' : ''));
      const top = el('div', 'top'); top.appendChild(el('span', 'src', a.source || 'Cue'));
      top.append(el('span', 'badge', ({bill:'Bill reminder',website:'Website',agent:'Agent',other:'Cue',history:'History'})[kind(a)] || 'Cue'));
      if (!a.seen && !a.unverifiedSite) {
        const read = el('button', 'btn small', 'Mark read');
        read.onclick = async () => { await call('alerts.read', { ids: [a.id] }); await refreshAlerts(); };
        top.append(read);
      }
      if (a.unverifiedSite) top.appendChild(el('span', 'badge', 'Earlier alert · permission unverified'));
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
  async function refreshAlerts() {
    alerts = await call('alerts.list'); renderAlerts();
  }
  $('alertFilter').onchange = renderAlerts;
  $('readAlerts').onclick = async () => {
    await call('alerts.read', { ids: alerts.filter(a => !a.seen && !a.unverifiedSite).map(a => a.id) }); await refreshAlerts();
  };
  window.addEventListener('cue-alerts-updated', refreshAlerts);
  window.addEventListener('focus', refreshAlerts);
  load();
})();
