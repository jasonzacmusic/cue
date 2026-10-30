// Bills radar. Reads a billing page's text when you open it, and warns before a card is charged.
// Every site words this differently, so the reader only claims what the page says plainly.
const crypto = require('crypto');

const BILLING_URL = /(billing|invoice|subscription|payment|\/plans?\b|\/usage\b|\/account\b|\/settings\/plan)/i;
const FAILED = /(payment (has )?failed|past due|card (was |has been )?declined|unable to (charge|process)|update your (payment|card)|payment method (has )?expired|overdue)/i;
const PAID = /(invoice|payment|receipt)[^\n]{0,50}\bpaid\b|\bpaid\b[^\n]{0,30}(invoice|receipt)/i;
const NEXT = /(next|upcoming|renew(s|al)?|due)[^\n]{0,40}?(?:on\s+|date:?\s+|:\s*)?((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d\d|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+20\d\d|20\d\d-\d\d-\d\d)/i;
const MONEY = /(₹|INR\s?|\$|USD\s?)\s?(\d[\d,]*(?:\.\d{1,2})?)/;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function readPage(text) {
  const out = {};
  if (FAILED.test(text)) out.status = 'failed';
  else if (PAID.test(text)) out.status = 'paid';
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

// Past renewal dates roll forward a month. We never mark a roll-forward as paid: only a page says that.
function roll(bill, now = new Date()) {
  if (!bill.renews) return bill;
  let d = new Date(`${bill.renews}T00:00:00`);
  const day = d.getDate();
  while (daysUntil(iso(d), now) < 0) {
    const y = d.getFullYear(); const m = d.getMonth() + 1;
    const last = new Date(y, m + 1, 0).getDate();
    d = new Date(y, m, Math.min(day, last));
    if (bill.status === 'paid') bill.status = 'ok';
  }
  bill.renews = iso(d);
  return bill;
}

function status(bill, now = new Date()) {
  if (bill.status === 'failed') return 'failed';
  if (bill.status === 'paid') return 'paid';
  if (bill.renews && daysUntil(bill.renews, now) <= 7) return 'due';
  return 'ok';
}

function fromPage(bills, url, text, usdToInr) {
  const u = new URL(url);
  const read = readPage(text);
  if (!read.status && !read.renews && !read.amount) return null;
  const host = u.hostname.replace(/^www\./, '');
  let b = bills.find((x) => { try { return new URL(x.url).hostname.replace(/^www\./, '') === host; } catch { return false; } });
  if (!b) { b = { id: crypto.randomUUID(), name: host, url, amountINR: 0, renews: '', status: 'ok', note: 'Found on this page' }; bills.push(b); }
  if (read.status) b.status = read.status; else if (b.status === 'failed') b.status = 'ok';
  if (read.renews) b.renews = read.renews;
  if (read.amount) b.amountINR = Math.round(read.amount.usd ? read.amount.value * usdToInr : read.amount.value);
  b.url = url;
  return b;
}

module.exports = { BILLING_URL, readPage, daysUntil, roll, status, fromPage, iso };
