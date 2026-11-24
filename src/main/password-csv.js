// Read a browser's user-exported CSV. Preserve quoted newlines, commas and escaped quotes.
function passwordRows(text) {
  const records = [];
  let row = [], value = '', quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ',') {
      row.push(value); value = '';
    } else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(value); records.push(row); row = []; value = '';
    } else value += c;
  }
  if (quoted) throw new Error('A quoted field is incomplete. Export the file again.');
  if (value || row.length) { row.push(value); records.push(row); }
  const header = (records.shift() || []).map((s) => s.trim().toLowerCase());
  const url = header.indexOf('url'), user = header.indexOf('username'), password = header.indexOf('password');
  if ([url, user, password].includes(-1)) throw new Error('Choose a CSV with URL, Username and Password columns.');
  return records.filter((r) => r.some(Boolean)).map((r) => ({ origin: r[url], username: r[user], password: r[password] }));
}
module.exports = { passwordRows };
