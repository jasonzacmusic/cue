'use strict';
// Runs under plain `node test/importer-test.js` (no Electron). Builds fake browser folders in
// the temp directory with a KNOWN key, checks every reader, then deletes them.
// The real-Helium control prints counts only. No Keychain reads, no secrets printed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const imp = require('../src/main/importer');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, 'got ' + g + ' want ' + w);
}

const KEY = crypto.pbkdf2Sync('known-test-secret', 'saltysalt', 1003, 16, 'sha1');
function encrypt(plain, key = KEY, prefix = 'v10') {
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(prefix), c.update(plain), c.final()]);
}
const EPOCH = 11644473600; // seconds from 1601 to 1970
const chromeUs = (unixMs) => BigInt(unixMs) * 1000n + BigInt(EPOCH) * 1000000n;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-importer-test-'));

function makeHistory(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)');
  const ins = db.prepare('INSERT INTO urls (url,title,visit_count,typed_count,last_visit_time,hidden) VALUES (?,?,?,?,?,?)');
  ins.run('https://old.example.com/', 'Old one', 2, 0, chromeUs(1600000000000), 0);
  ins.run('https://new.example.com/a', 'Newest', 7, 1, chromeUs(1760000000000), 0);
  ins.run('https://mid.example.com/', 'Middle', 1, 0, chromeUs(1700000000000), 0);
  ins.run('https://hidden.example.com/', 'Hidden frame', 1, 0, chromeUs(1710000000000), 1);
  db.close();
}

function makeLogins(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE logins (origin_url VARCHAR, username_value VARCHAR, password_value BLOB, blacklisted_by_user INTEGER)');
  const ins = db.prepare('INSERT INTO logins VALUES (?,?,?,?)');
  ins.run('https://site.example.com/login', 'alice', encrypt(Buffer.from('s3cret-pass')), 0);
  ins.run('https://other.example.org/', 'bob', encrypt(Buffer.from('pässwörd-✓')), 0);
  ins.run('https://never.example.net/', '', Buffer.alloc(0), 1); // "never save" marker
  ins.run('https://broken.example.net/', 'carol', Buffer.from('v10notreallyencryptedxxxxxxxxxxxxxxxx'), 0);
  db.close();
}

function makeCookies(file, version, withHash) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)');
  db.prepare('INSERT INTO meta VALUES (?,?)').run('version', String(version));
  db.exec(`CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
    path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)`);
  const ins = db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const future = Date.now() + 86400000 * 30;
  const enc = (host, val) => encrypt(Buffer.concat([
    withHash ? crypto.createHash('sha256').update(host).digest() : Buffer.alloc(0),
    Buffer.from(val),
  ]));
  ins.run(1n, '.example.com', 'sid', '', enc('.example.com', 'abc123'), '/', chromeUs(future), 1, 1, 1, 1);
  ins.run(1n, 'host.example.org', 'plain', 'visible', Buffer.alloc(0), '/app', chromeUs(future), 0, 0, 1, 2);
  ins.run(1n, '.expired.com', 'old', '', enc('.expired.com', 'dead'), '/', chromeUs(1500000000000), 1, 0, 1, 0);
  ins.run(1n, '.session.com', 'sess', '', enc('.session.com', 'tmp'), '/', 0n, 1, 0, 0, -1);
  ins.run(1n, 'secure.example.net', '__Host-tok', '', enc('secure.example.net', 'hosttok'), '/', chromeUs(future), 1, 1, 1, 1);
  db.close();
  return future;
}

// A Chromium session file: SNSS header, then records holding length-prefixed url + utf16 title.
function snssRecord(url, title) {
  const u = Buffer.from(url, 'latin1');
  const pad = (4 - (u.length % 4)) % 4;
  const t = Buffer.from(title, 'utf16le');
  const head = Buffer.alloc(12); // fake pickle size, tab id, index
  const ulen = Buffer.alloc(4); ulen.writeInt32LE(u.length);
  const tlen = Buffer.alloc(4); tlen.writeInt32LE(title.length);
  return Buffer.concat([head, ulen, u, Buffer.alloc(pad), tlen, t, Buffer.alloc(4)]);
}

let fakeRoot;
let future;
try {
  // ------------------------------------------------------------ build fixtures
  fakeRoot = path.join(tmp, 'fakechrome');
  const d1 = path.join(fakeRoot, 'Default');
  const d2 = path.join(fakeRoot, 'Profile 2');
  fs.mkdirSync(path.join(d1, 'Sessions'), { recursive: true });
  fs.mkdirSync(path.join(d2, 'Network'), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, 'Local State'), JSON.stringify({
    profile: { info_cache: {
      Default: { name: 'Jason', user_name: 'jason@example.com' },
      'Profile 2': { name: 'Work', user_name: '' },
      'Profile 9': { name: 'Gone', user_name: 'gone@example.com' }, // folder missing -> skipped
    } },
  }));
  fs.writeFileSync(path.join(d1, 'Bookmarks'), JSON.stringify({
    roots: {
      bookmark_bar: { name: 'Bookmarks bar', type: 'folder', children: [
        { type: 'url', name: 'Cue', url: 'https://cue.example/' },
        { type: 'folder', name: 'Music', children: [
          { type: 'url', name: 'Lessons', url: 'https://lessons.example/' },
          { type: 'folder', name: 'Deep', children: [{ type: 'url', name: 'Scales', url: 'https://scales.example/' }] },
        ] },
      ] },
      other: { name: 'Other bookmarks', type: 'folder', children: [{ type: 'url', name: 'Misc', url: 'https://misc.example/' }] },
      synced: { name: 'Mobile bookmarks', type: 'folder', children: [] },
      sync_transaction_version: '12',
    },
  }));
  makeHistory(path.join(d1, 'History'));
  makeLogins(path.join(d1, 'Login Data'));
  future = makeCookies(path.join(d1, 'Cookies'), 24, true);
  makeCookies(path.join(d2, 'Network', 'Cookies'), 23, false);
  fs.writeFileSync(path.join(d1, 'Sessions', 'Session_1'), Buffer.concat([Buffer.from('SNSS\x03\x00\x00\x00'), snssRecord('https://old-session.example/', 'Stale')]));
  const newer = path.join(d1, 'Sessions', 'Session_2');
  fs.writeFileSync(newer, Buffer.concat([
    Buffer.from('SNSS\x03\x00\x00\x00'),
    snssRecord('https://tab-one.example/page?x=1', 'Tab One'),
    snssRecord('https://tab-two.example/', 'Tab Two ♫'),
    snssRecord('https://tab-one.example/page?x=1', 'Tab One again'),
    snssRecord('http://plain-http.example/', ''),
    Buffer.from('junk https://notalength.example/ junk'),
  ]));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(newer, later, later);

  const browser = { id: 'fakechrome', name: 'Fake Chrome', root: fakeRoot, profiles: [] };
  const P1 = { dir: 'Default' };
  const P2 = { dir: 'Profile 2' };

  // ------------------------------------------------------------ findBrowsers
  const home = path.join(tmp, 'home');
  const mac = path.join(home, 'Library', 'Application Support');
  fs.mkdirSync(path.join(mac, 'net.imput.helium', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(mac, 'net.imput.helium', 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'You', user_name: 'me@x.com' } } } }));
  fs.mkdirSync(path.join(mac, 'Google', 'Chrome', 'Default'), { recursive: true }); // no Local State -> fallback to Default
  fs.mkdirSync(path.join(mac, 'Arc', 'User Data', 'Default'), { recursive: true });
  const found = imp.findBrowsers({ platform: 'darwin', home, env: {}, safariPresent: true });
  eq('findBrowsers mac ids in order (Helium first)', found.map((b) => b.id), ['helium', 'chrome', 'arc', 'safari']);
  eq('findBrowsers Helium profile from Local State', found[0].profiles, [{ dir: 'Default', name: 'You', email: 'me@x.com' }]);
  eq('findBrowsers falls back to Default without Local State', found[1].profiles, [{ dir: 'Default', name: 'Default', email: '' }]);
  check('findBrowsers Helium mac root', found[0].root === path.join(mac, 'net.imput.helium'));
  check('findBrowsers Arc mac root', found[2].root === path.join(mac, 'Arc', 'User Data'));
  eq('findBrowsers skips browsers that are not installed', imp.findBrowsers({ platform: 'darwin', home: path.join(tmp, 'empty'), env: {}, safariPresent: false }), []);
  const lin = path.join(tmp, 'linhome', '.config', 'BraveSoftware', 'Brave-Browser', 'Default');
  fs.mkdirSync(lin, { recursive: true });
  eq('findBrowsers linux Brave path', imp.findBrowsers({ platform: 'linux', home: path.join(tmp, 'linhome'), env: {} }).map((b) => b.id), ['brave']);
  const winRoot = path.join(tmp, 'winhome', 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default');
  fs.mkdirSync(winRoot, { recursive: true });
  eq('findBrowsers windows Edge path', imp.findBrowsers({ platform: 'win32', home: path.join(tmp, 'winhome'), env: {} }).map((b) => b.id), ['edge']);
  const profs = (() => {
    const b = imp.findBrowsers({ platform: 'darwin', home, env: {}, safariPresent: false });
    return b.length;
  })();
  eq('findBrowsers no Safari when absent', profs, 3);

  // profiles read from fake root (Local State, missing folder skipped)
  const fakeFound = (() => {
    const h = path.join(tmp, 'home2');
    const target = path.join(h, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser');
    fs.cpSync(fakeRoot, target, { recursive: true });
    return imp.findBrowsers({ platform: 'darwin', home: h, env: {}, safariPresent: false })[0];
  })();
  eq('Local State: names, emails, missing folder skipped', fakeFound.profiles, [
    { dir: 'Default', name: 'Jason', email: 'jason@example.com' },
    { dir: 'Profile 2', name: 'Work', email: '' },
  ]);

  // ------------------------------------------------------------ bookmarks
  eq('readBookmarks walks roots and folders', imp.readBookmarks(browser, P1), [
    { title: 'Cue', url: 'https://cue.example/', folder: 'Bookmarks bar' },
    { title: 'Lessons', url: 'https://lessons.example/', folder: 'Bookmarks bar/Music' },
    { title: 'Scales', url: 'https://scales.example/', folder: 'Bookmarks bar/Music/Deep' },
    { title: 'Misc', url: 'https://misc.example/', folder: 'Other bookmarks' },
  ]);
  eq('readBookmarks missing file -> []', imp.readBookmarks(browser, P2), []);
  eq('readBookmarks missing profile -> []', imp.readBookmarks(browser, { dir: 'Nope' }), []);
  eq('readBookmarks missing root -> []', imp.readBookmarks({ id: 'x', root: path.join(tmp, 'nothing') }, P1), []);
  eq('readBookmarks garbage args -> []', imp.readBookmarks(null, null), []);

  // Safari JSON shape (what plutil prints)
  const safariJson = JSON.stringify({
    Title: '', WebBookmarkType: 'WebBookmarkTypeList', Children: [
      { Title: 'History', WebBookmarkType: 'WebBookmarkTypeProxy' },
      { Title: 'BookmarksBar', WebBookmarkType: 'WebBookmarkTypeList', Children: [
        { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://fav.example/', URIDictionary: { title: 'Fav' } },
        { Title: 'Folder', WebBookmarkType: 'WebBookmarkTypeList', Children: [
          { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://inner.example/', URIDictionary: { title: 'Inner' } } ] },
      ] },
      { Title: 'com.apple.ReadingList', WebBookmarkType: 'WebBookmarkTypeList', Children: [
        { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://reading.example/', URIDictionary: { title: 'Later' } } ] },
    ],
  });
  eq('Safari plist JSON parsed, Reading List skipped', imp.parseSafariBookmarks(safariJson), [
    { title: 'Fav', url: 'https://fav.example/', folder: 'Favorites' },
    { title: 'Inner', url: 'https://inner.example/', folder: 'Favorites/Folder' },
  ]);
  eq('Safari bad JSON -> []', imp.parseSafariBookmarks('not json'), []);
  eq('readBookmarks(safari) never throws', Array.isArray(imp.readBookmarks({ id: 'safari', root: '' }, { dir: '' })), true);

  // ------------------------------------------------------------ history
  const hist = imp.readHistory(browser, P1);
  eq('readHistory newest first, hidden skipped, Chromium time -> JS ms', hist, [
    { url: 'https://new.example.com/a', title: 'Newest', visits: 7, lastVisit: 1760000000000 },
    { url: 'https://mid.example.com/', title: 'Middle', visits: 1, lastVisit: 1700000000000 },
    { url: 'https://old.example.com/', title: 'Old one', visits: 2, lastVisit: 1600000000000 },
  ]);
  eq('readHistory respects limit', imp.readHistory(browser, P1, 1).map((h) => h.title), ['Newest']);
  eq('readHistory missing file -> []', imp.readHistory(browser, P2), []);
  eq('chromiumToMs known value (2020-01-01)', imp.chromiumToMs(13222310400000000n), 1577836800000);
  eq('chromiumToMs zero -> 0', imp.chromiumToMs(0n), 0);
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cue-import-'));
  const before = leftovers().length;
  imp.readHistory(browser, P1);
  eq('readHistory deletes its temp copy', leftovers().length, before);
  eq('readHistory leaves original untouched (still readable)', imp.readHistory(browser, P1).length, 3);
  const bad = path.join(fakeRoot, 'Profile 2', 'History');
  fs.writeFileSync(bad, 'this is not a database');
  eq('readHistory corrupt file -> [] and no temp left', [imp.readHistory(browser, P2), leftovers().length - before], [[], 0]);
  fs.rmSync(bad);

  // ------------------------------------------------------------ decryptValue
  eq('decryptValue v10 round trip', imp.decryptValue(encrypt(Buffer.from('hello')), KEY), 'hello');
  eq('decryptValue v11 prefix', imp.decryptValue(encrypt(Buffer.from('linux'), KEY, 'v11'), KEY), 'linux');
  eq('decryptValue wrong key -> ""', imp.decryptValue(encrypt(Buffer.from('hello')), Buffer.alloc(16, 1)), '');
  eq('decryptValue null key -> ""', imp.decryptValue(encrypt(Buffer.from('hello')), null), '');
  eq('decryptValue garbage -> ""', imp.decryptValue(Buffer.from('plain text'), KEY), '');
  eq('decryptValue empty / null -> ""', [imp.decryptValue(Buffer.alloc(0), KEY), imp.decryptValue(null, KEY), imp.decryptValue(undefined, undefined)], ['', '', '']);
  eq('decryptValue truncated ciphertext -> ""', imp.decryptValue(encrypt(Buffer.from('hello')).subarray(0, 12), KEY), '');
  const withHash = encrypt(Buffer.concat([crypto.createHash('sha256').update('.example.com').digest(), Buffer.from('value')]));
  eq('decryptValue stripHash drops 32 bytes', imp.decryptValue(withHash, KEY, { stripHash: true }), 'value');

  // ------------------------------------------------------------ passwords
  const pw = imp.readPasswords(browser, P1, KEY);
  eq('readPasswords decrypts, skips blocked + undecryptable', pw, [
    { origin: 'https://site.example.com/login', username: 'alice', password: 's3cret-pass' },
    { origin: 'https://other.example.org/', username: 'bob', password: 'pässwörd-✓' },
  ]);
  eq('readPasswords without key -> []', imp.readPasswords(browser, P1, null), []);
  eq('readPasswords wrong key -> []', imp.readPasswords(browser, P1, Buffer.alloc(16, 9)), []);
  eq('readPasswords missing file -> []', imp.readPasswords(browser, P2, KEY), []);

  // ------------------------------------------------------------ cookies
  const ck = imp.readCookies(browser, P1, KEY);
  const byName = Object.fromEntries(ck.map((c) => [c.name, c]));
  eq('cookies v24: expired skipped, session kept', ck.map((c) => c.name).sort(), ['__Host-tok', 'plain', 'sess', 'sid']);
  eq('cookies v24: 32-byte host hash stripped', byName.sid.value, 'abc123');
  eq('cookies v24: all hash-prefixed values clean', [byName.sess.value, byName['__Host-tok'].value], ['tmp', 'hosttok']);
  eq('cookies plain value used as is', byName.plain.value, 'visible');
  eq('cookies expires_utc -> seconds since 1970', byName.sid.expirationDate, Math.floor(future / 1000));
  check('cookies expirationDate is in seconds, not ms', byName.sid.expirationDate < 1e11);
  eq('cookies session cookie has no expirationDate', 'expirationDate' in byName.sess, false);
  eq('cookies full shape (sid)', byName.sid, {
    url: 'https://example.com/', name: 'sid', value: 'abc123', path: '/', secure: true, httpOnly: true,
    sameSite: 'lax', domain: '.example.com', expirationDate: Math.floor(future / 1000),
  });
  eq('cookies http url + strict sameSite', [byName.plain.url, byName.plain.secure, byName.plain.sameSite, byName.plain.domain], ['http://host.example.org/app', false, 'strict', 'host.example.org']);
  eq('cookies unspecified sameSite (-1)', byName.sess.sameSite, 'unspecified');
  eq('cookies __Host- has no domain', 'domain' in byName['__Host-tok'], false);
  const ck2 = imp.readCookies(browser, P2, KEY);
  eq('cookies v23 in Network/Cookies: no hash strip', ck2.find((c) => c.name === 'sid').value, 'abc123');
  eq('cookies without key keeps only plaintext ones', imp.readCookies(browser, P1, null).map((c) => c.name), ['plain']);
  eq('cookies missing file -> []', imp.readCookies(browser, { dir: 'Nope' }, KEY), []);

  // ------------------------------------------------------------ open tabs
  eq('readOpenTabs reads newest session file, dedupes, ignores junk', imp.readOpenTabs(browser, P1), [
    { url: 'https://tab-one.example/page?x=1', title: 'Tab One' },
    { url: 'https://tab-two.example/', title: 'Tab Two ♫' },
    { url: 'http://plain-http.example/', title: '' },
  ]);
  eq('readOpenTabs no sessions -> []', imp.readOpenTabs(browser, P2), []);
  const big = Buffer.concat([Buffer.from('SNSS\x03\x00\x00\x00')].concat(Array.from({ length: 300 }, (_, i) => snssRecord('https://t' + i + '.example/', 'T' + i))));
  fs.mkdirSync(path.join(fakeRoot, 'Profile 2', 'Sessions'), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, 'Profile 2', 'Sessions', 'Session_9'), big);
  eq('readOpenTabs capped at 200', imp.readOpenTabs(browser, P2).length, 200);
  // A real session file replays to the tabs that are open, on the page each one is showing.
  const cmd = (id, body) => { const h = Buffer.alloc(3); h.writeUInt16LE(body.length + 1, 0); h[2] = id; return Buffer.concat([h, body]); };
  const ints = (...n) => { const b = Buffer.alloc(n.length * 4); n.forEach((v, i) => b.writeInt32LE(v, i * 4)); return b; };
  const nav = (tab, index, url, title) => {
    const u = Buffer.from(url, 'latin1'); const pad = Buffer.alloc((4 - (u.length % 4)) % 4);
    return cmd(6, Buffer.concat([ints(0, tab, index, u.length), u, pad, ints(title.length), Buffer.from(title, 'utf16le')]));
  };
  const session = Buffer.concat([Buffer.from('SNSS\x03\x00\x00\x00', 'latin1'),
    cmd(0, ints(1, 10)), nav(10, 0, 'https://back.example/', 'Old page'), nav(10, 1, 'https://here.example/', 'Showing'), cmd(7, ints(10, 1)),
    cmd(0, ints(1, 11)), nav(11, 0, 'https://closed.example/', 'Closed'), cmd(16, ints(11, 0, 0)),
    cmd(0, ints(2, 12)), nav(12, 0, 'https://gone.example/', 'Window closed'), cmd(17, ints(2, 0, 0)),
    cmd(0, ints(1, 13)), nav(13, 0, 'chrome://newtab/', 'New Tab')]);
  fs.mkdirSync(path.join(fakeRoot, 'Profile 3', 'Sessions'), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, 'Profile 3', 'Sessions', 'Session_1'), session);
  eq('readOpenTabs keeps only tabs really open, on their current page', imp.readOpenTabs(browser, { dir: 'Profile 3' }), [
    { url: 'https://here.example/', title: 'Showing' },
  ]);
  // Arc
  const arcDir = path.join(tmp, 'Arc');
  fs.mkdirSync(path.join(arcDir, 'User Data', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(arcDir, 'StorableSidebar.json'), JSON.stringify({ sidebar: { containers: [{ items: [
    'someid',
    { id: 'a', title: 'ignored', data: { tab: { savedURL: 'https://arc-one.example/', savedTitle: 'Arc One' } } },
    { id: 'b', data: { tab: { savedURL: 'https://arc-two.example/', savedTitle: '' } }, title: 'Arc Two' },
    { id: 'c', data: { list: {} }, title: 'folder' },
    { id: 'd', data: { tab: { savedURL: 'chrome://settings', savedTitle: 'x' } } },
  ] }] } }));
  eq('readOpenTabs Arc StorableSidebar.json', imp.readOpenTabs({ id: 'arc', root: path.join(arcDir, 'User Data') }, { dir: 'Default' }), [
    { url: 'https://arc-one.example/', title: 'Arc One' },
    { url: 'https://arc-two.example/', title: 'Arc Two' },
  ]);
  eq('readOpenTabs garbage args -> []', imp.readOpenTabs(null, null), []);

  // ------------------------------------------------------------ summarize
  eq('summarize counts only', imp.summarize(browser, P1), { bookmarks: 4, history: 3 });
  eq('summarize missing profile -> zeros', imp.summarize(browser, { dir: 'Nope' }), { bookmarks: 0, history: 0 });

  // ------------------------------------------------------------ getKey (no Keychain touched)
  (async () => {
    try {
      let seen = null;
      const fake = (file, args, options, cb) => { seen = { file, args }; cb(null, 'known-test-secret\n'); };
      const k = await imp.getKey({ id: 'helium' }, { platform: 'darwin', exec: fake });
      eq('getKey mac runs security with an argument array', seen, { file: 'security', args: ['find-generic-password', '-w', '-s', 'Helium Storage Key'] });
      check('getKey mac derives PBKDF2-SHA1 1003 rounds', Buffer.isBuffer(k) && k.equals(KEY));
      const svc = {};
      for (const id of ['chrome', 'brave', 'edge', 'arc']) {
        await imp.getKey({ id }, { platform: 'darwin', exec: (f, a, o, cb) => { svc[id] = a[3]; cb(null, 'x'); } });
      }
      eq('getKey service names', svc, { chrome: 'Chrome Safe Storage', brave: 'Brave Safe Storage', edge: 'Microsoft Edge Safe Storage', arc: 'Arc Safe Storage' });
      eq('getKey mac denied -> null', await imp.getKey({ id: 'helium' }, { platform: 'darwin', exec: (f, a, o, cb) => cb(new Error('denied')) }), null);
      eq('getKey mac unknown browser -> null', await imp.getKey({ id: 'netscape' }, { platform: 'darwin', exec: fake }), null);
      const lk = await imp.getKey({ id: 'chrome' }, { platform: 'linux' });
      check('getKey linux = PBKDF2 peanuts, 1 round', lk.equals(crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')));
      eq('getKey windows -> null', await imp.getKey({ id: 'chrome' }, { platform: 'win32' }), null);
      eq('getKey safari -> null', await imp.getKey({ id: 'safari' }, { platform: 'darwin', exec: fake }), null);

      // ---------------------------------------------------------- control: real Helium, counts only
      const real = imp.findBrowsers();
      console.log('CONTROL browsers on this computer: ' + real.map((b) => b.name + '(' + b.profiles.length + ' profile' + (b.profiles.length === 1 ? '' : 's') + ')').join(', '));
      const helium = real.find((b) => b.id === 'helium');
      if (helium) {
        const hp = helium.profiles[0];
        const s = imp.summarize(helium, hp);
        const tabs = imp.readOpenTabs(helium, hp).length;
        console.log('CONTROL real Helium (' + hp.dir + '): bookmarks=' + s.bookmarks + ' history=' + s.history + ' openTabs=' + tabs);
        check('control: Helium found and reads without throwing', true);
        check('control: Helium bookmark count matches readBookmarks', imp.readBookmarks(helium, hp).length === s.bookmarks);
      } else {
        console.log('CONTROL Helium not installed on this computer, skipped');
      }
    } catch (e) {
      fail++; console.log('FAIL async section threw: ' + e.message);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      const gone = !fs.existsSync(tmp);
      check('fixtures deleted', gone);
      console.log('\n' + pass + ' passed, ' + fail + ' failed');
      process.exit(fail ? 1 : 0);
    }
  })();
} catch (e) {
  fail++;
  console.log('FAIL setup threw: ' + (e && e.stack));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(1);
}
