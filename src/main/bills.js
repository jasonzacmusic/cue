// Bills radar. Reads a billing page's text when you open it, and warns before a card is charged.
// Every site words this differently, so the reader only claims what the page says plainly.
const crypto = require('crypto');

const BILLING_URL = /(billing|invoice|subscription|payment|\/plans?\b|\/usage\b|\/account\b|\/settings\/plan)/i;
const FAILED = /(payment (has )?failed|card (was |has been )?declined|unable to charge your card|unable to process your payment|payment method (has )?expired)/i;
const PAID = /\b(?:invoice|payment|receipt)(?:\s+(?:status|is|was|has been))?\s*[:–—-]?\s*paid\b|\bpaid\s+(?:invoice|receipt)\b/i;
const HYPOTHETICAL = /\b(?:if|unless|when|not|never|why|what if)\b/i;
const NEXT = /(next|upcoming|renew(s|al)?|due)[^\n]{0,40}?(?:on\s+|date:?\s+|:\s*)?((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d\d|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+20\d\d|20\d\d-\d\d-\d\d)/i;
const MONEY = /(₹|INR\s?|\$|USD\s?)\s?(\d[\d,]*(?:\.\d{1,2})?)/;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function readPage(text) {
  const out = {};
  const statements = text.split(/[\n.!?]+/).filter(line => !HYPOTHETICAL.test(line));
  if (statements.some(line => FAILED.test(line))) out.status = 'failed';
  else if (statements.some(line => PAID.test(line))) out.status = 'paid';
  const n = text.match(NEXT);
  if (n) { const d = new Date(n[3].replace(/(\d)(st|nd|rd|th)/i, '$1')); if (!Number.isNaN(+d)) out.renews = iso(d); }
  const near = n ? text.slice(Math.max(0, n.index - 120), n.index + n[0].length + 120) : text;
  const m = near.match(MONEY);
  if (m) out.amount = { value: Number(m[2].replace(/,/g, '')), usd: /\$|USD/.test(m[1]) };
  return out;
}

function daysUntil(dateStr, now = new Date()) {
  const a = new Date(`${dateStr}T00:00:00`); const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86400000);
}

// A missed payment stays overdue. Only a paid recurring bill starts another cycle.
function roll(bill, now = new Date()) {
  if (bill.status !== 'paid' || bill.repeat === 'once' || !bill.renews || !(daysUntil(bill.renews, now) < 0)) return bill;
  const due = new Date(bill.renews + 'T00:00:00');
  const day = bill.monthDay || due.getDate();
  const last = new Date(due.getFullYear(), due.getMonth() + 2, 0);
  last.setDate(Math.min(day, last.getDate()));
  bill.renews = iso(last); bill.monthDay = day; bill.status = 'ok';
  return bill;
}

function status(bill, now = new Date()) {
  if (bill.status === 'failed' || bill.status === 'paid') return bill.status;
  if (bill.status === 'due' || (bill.renews && daysUntil(bill.renews, now) <= 7)) return 'due';
  return 'ok';
}

function reminder(b, now = new Date()) {
  const st = status(b, now);
  if (st !== 'due' && st !== 'failed') return null;
  const days = b.renews ? daysUntil(b.renews, now) : null;
  let detail = 'marked due';
  if (st === 'failed') detail = 'payment failed';
  else if (days === 0) detail = 'due today';
  else if (days < 0) detail = 'overdue by ' + -days + (days === -1 ? ' day' : ' days');
  else if (days > 0) detail = 'due in ' + days + (days === 1 ? ' day' : ' days');
  const phase = st === 'due' && days !== null && days <= 0 ? (days === 0 ? 'today' : 'overdue') : st;
  return { key: phase + '|' + (b.renews || ''), title: b.name + ': ' + detail };
}

function fromPage(bills, url, text, usdToInr) {
  const u = new URL(url);
  const read = readPage(text);
  if (!read.status && !read.renews) return null;
  const host = u.hostname.replace(/^www\./, '');
  let b = bills.find((x) => { if (x.source !== 'page' && x.note !== 'Found on this page') return false; try { return new URL(x.url).hostname.replace(/^www\./, '') === host; } catch { return false; } });
  if (!b) { b = { id: crypto.randomUUID(), name: host, url, amountINR: 0, renews: '', status: 'ok', note: 'Found on this page', source: 'page' }; bills.push(b); }
  if (read.status) b.status = read.status;
  if (read.renews) b.renews = read.renews;
  if (read.amount) b.amountINR = Math.round(read.amount.usd ? read.amount.value * usdToInr : read.amount.value);
  b.url = url;
  return b;
}

module.exports = { BILLING_URL, readPage, daysUntil, roll, status, reminder, fromPage, iso };
