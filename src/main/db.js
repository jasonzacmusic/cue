// Cue's local library: history, bookmarks and Boards in one small database file.
// Nothing here is ever written for Vanish tabs; main.js does not call it for them.
//
// Every row belongs to ONE folder. A page visited in one person's folder is not in anyone else's
// history, bookmarks or search suggestions. main.js always reaches the library through
// lib.in(folder); the bare methods on Library work on "personal", the folder every older Cue
// filed everything under, so code that predates folders still reads what it always read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const LEGACY = 'personal';

class Library {
  constructor(dir) {
    this.db = new DatabaseSync(path.join(dir, 'cue-library.db'));
    try { fs.chmodSync(path.join(dir, 'cue-library.db'), 0o600); } catch {} // history is for this login only
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS history (folder TEXT NOT NULL DEFAULT 'personal', url TEXT, title TEXT, visits INTEGER DEFAULT 1, last INTEGER, host TEXT, PRIMARY KEY (folder, url));
      CREATE TABLE IF NOT EXISTS sites (folder TEXT NOT NULL DEFAULT 'personal', host TEXT, title TEXT, visits INTEGER DEFAULT 1, last INTEGER, PRIMARY KEY (folder, host));
      CREATE TABLE IF NOT EXISTS bookmarks (owner TEXT NOT NULL DEFAULT 'personal', url TEXT, title TEXT, folder TEXT, PRIMARY KEY (owner, url));
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT, created INTEGER, folder TEXT NOT NULL DEFAULT 'personal');
      CREATE TABLE IF NOT EXISTS board_items (id TEXT PRIMARY KEY, board TEXT, img TEXT, source TEXT, title TEXT, thumb TEXT, added INTEGER, folder TEXT NOT NULL DEFAULT 'personal');
    `);
    this.upgrade();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS history_last ON history(folder, last DESC);
      CREATE INDEX IF NOT EXISTS history_host ON history(folder, host, last DESC);
      CREATE INDEX IF NOT EXISTS sites_last ON sites(folder, last DESC);
    `);
    this.foldOldHistory();
    this.upHist = this.db.prepare(`INSERT INTO history (folder, url, title, host, visits, last) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(folder, url) DO UPDATE SET visits = visits + 1, last = excluded.last, host = excluded.host, title = COALESCE(NULLIF(excluded.title, ''), title)`);
    this.upSite = this.db.prepare(`INSERT INTO sites (folder, host, title, visits, last) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(folder, host) DO UPDATE SET visits = visits + 1, last = excluded.last, title = COALESCE(NULLIF(excluded.title, ''), title)`);
  }

  cols(table) { return this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); }

  // A library from before folders: one shared history, one set of bookmarks. Its rows are filed
  // under "personal", which is where every older Cue's own tabs mostly lived. The keys change too
  // (the same address can now be in two folders), and SQLite cannot change a key in place, so
  // those tables are rebuilt once, in one transaction.
  upgrade() {
    const h = this.cols('history');
    if (!h.includes('host')) { try { this.db.exec('ALTER TABLE history ADD COLUMN host TEXT'); } catch {} }
    const rebuild = (table, create, copy) => {
      this.tx(() => {
        this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
        // Indexes travel with a renamed table and keep their names, which would stop the new
        // table getting its own.
        for (const ix of this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}_old' AND sql IS NOT NULL`).all()) this.db.exec(`DROP INDEX IF EXISTS ${ix.name}`);
        this.db.exec(create);
        this.db.exec(copy);
        this.db.exec(`DROP TABLE ${table}_old`);
      });
    };
    if (!this.cols('history').includes('folder')) {
      rebuild('history',
        "CREATE TABLE history (folder TEXT NOT NULL DEFAULT 'personal', url TEXT, title TEXT, visits INTEGER DEFAULT 1, last INTEGER, host TEXT, PRIMARY KEY (folder, url))",
        `INSERT OR IGNORE INTO history (folder, url, title, visits, last, host) SELECT '${LEGACY}', url, title, visits, last, host FROM history_old`);
    }
    if (!this.cols('sites').includes('folder')) {
      rebuild('sites',
        "CREATE TABLE sites (folder TEXT NOT NULL DEFAULT 'personal', host TEXT, title TEXT, visits INTEGER DEFAULT 1, last INTEGER, PRIMARY KEY (folder, host))",
        `INSERT OR IGNORE INTO sites (folder, host, title, visits, last) SELECT '${LEGACY}', host, title, visits, last FROM sites_old`);
    }
    // bookmarks already had a "folder" column: the bookmark folder it was filed in, from the
    // browser it was moved in from. Whose it is goes in "owner".
    if (!this.cols('bookmarks').includes('owner')) {
      rebuild('bookmarks',
        "CREATE TABLE bookmarks (owner TEXT NOT NULL DEFAULT 'personal', url TEXT, title TEXT, folder TEXT, PRIMARY KEY (owner, url))",
        `INSERT OR IGNORE INTO bookmarks (owner, url, title, folder) SELECT '${LEGACY}', url, title, folder FROM bookmarks_old`);
    }
    for (const t of ['boards', 'board_items']) {
      if (!this.cols(t).includes('folder')) this.db.exec(`ALTER TABLE ${t} ADD COLUMN folder TEXT NOT NULL DEFAULT '${LEGACY}'`);
    }
  }

  // The first time this version runs, the old page-by-page list is folded into
  // the sites it came from and the pages themselves are let go. That list was
  // thousands of rows of search results and error pages; the sites are the part
  // worth keeping, and Cue starts gathering pages again from here.
  foldOldHistory() {
    const done = this.db.prepare('SELECT COUNT(*) AS n FROM sites').get();
    if (done.n > 0) return;
    const rows = this.db.prepare('SELECT folder, url, title, visits, last FROM history').all();
    if (!rows.length) return;
    const by = new Map();
    for (const r of rows) {
      const h = Library.hostOf(r.url);
      if (!h) continue;
      const k = `${r.folder}\n${h}`;
      const cur = by.get(k) || { folder: r.folder, host: h, visits: 0, last: 0, title: '' };
      cur.visits += r.visits || 1;
      if ((r.last || 0) > cur.last) { cur.last = r.last || 0; cur.title = r.title || cur.title; }
      by.set(k, cur);
    }
    const ins = this.db.prepare('INSERT OR REPLACE INTO sites (folder, host, title, visits, last) VALUES (?, ?, ?, ?, ?)');
    this.tx(() => {
      for (const v of by.values()) ins.run(v.folder, v.host, v.title || v.host, v.visits, v.last);
      this.db.exec('DELETE FROM history');
    });
  }

  static hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
  static like(q) { return `%${String(q || '').replace(/[%_\\]/g, '\\$&')}%`; }

  // ---- everything below takes the folder first. lib.in(folder) binds it.
  visitIn(f, url, title) {
    const host = Library.hostOf(url);
    if (!host) return;
    const now = Date.now();
    this.upSite.run(f, host, title || host, now);
    this.upHist.run(f, url, title || '', host, now);
  }
  titleIn(f, url, title) {
    if (!title) return;
    this.db.prepare('UPDATE history SET title = ? WHERE folder = ? AND url = ?').run(title, f, url);
    const h = Library.hostOf(url);
    if (h) this.db.prepare('UPDATE sites SET title = ? WHERE folder = ? AND host = ? AND (title IS NULL OR title = ? OR title = \'\')').run(title, f, h, h);
  }

  importHistoryIn(f, rows) {
    const ins = this.db.prepare(`INSERT INTO history (folder, url, title, host, visits, last) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(folder, url) DO UPDATE SET visits = MAX(visits, excluded.visits), last = MAX(last, excluded.last)`);
    this.tx(() => rows.forEach((r) => ins.run(f, r.url, r.title || '', Library.hostOf(r.url), r.visits || 1, r.lastVisit || 0)));
    return rows.length;
  }

  importBookmarksIn(f, rows) {
    const ins = this.db.prepare('INSERT OR REPLACE INTO bookmarks (owner, url, title, folder) VALUES (?, ?, ?, ?)');
    this.tx(() => rows.forEach((r) => ins.run(f, r.url, r.title || '', r.folder || '')));
    return rows.length;
  }

  tx(fn) { this.db.exec('BEGIN'); try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; } }

  // The sites you have been to, newest first. This is what History shows now:
  // one line per place, not one line per page.
  sitesIn(f, q, limit = 400) {
    const like = Library.like(q);
    return this.db.prepare(`SELECT s.host, s.title, s.visits, s.last AS lastVisit,
        (SELECT COUNT(*) FROM history h WHERE h.folder = s.folder AND h.host = s.host) AS pages
      FROM sites s WHERE s.folder = ? AND (s.host LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')
      ORDER BY s.last DESC LIMIT ?`).all(f, like, like, limit);
  }

  // Everything Cue has kept from one site, for when you open it up.
  pagesIn(f, host, limit = 500) {
    return this.db.prepare(`SELECT url, title, visits, last AS lastVisit FROM history
      WHERE folder = ? AND host = ? ORDER BY last DESC LIMIT ?`).all(f, String(host || ''), limit);
  }

  // Forget one place completely: the site and every page of it.
  forgetSiteIn(f, host) {
    this.db.prepare('DELETE FROM history WHERE folder = ? AND host = ?').run(f, String(host || ''));
    this.db.prepare('DELETE FROM sites WHERE folder = ? AND host = ?').run(f, String(host || ''));
  }

  historyIn(f, q, limit = 200) {
    const like = Library.like(q);
    return this.db.prepare(`SELECT url, title, visits, last AS lastVisit FROM history
      WHERE folder = ? AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\') ORDER BY last DESC LIMIT ?`).all(f, like, like, limit);
  }

  // Best matches for the search bar: frequently and recently visited first.
  suggestIn(f, q, limit = 6) {
    const like = Library.like(q);
    return this.db.prepare(`SELECT url, title FROM history WHERE folder = ? AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')
      ORDER BY visits DESC, last DESC LIMIT ?`).all(f, like, like, limit);
  }

  clearHistoryIn(f) {
    this.db.prepare('DELETE FROM history WHERE folder = ?').run(f);
    this.db.prepare('DELETE FROM sites WHERE folder = ?').run(f);
  }

  bookmarksIn(f, q, limit = 5000) {
    const like = Library.like(q);
    return this.db.prepare(`SELECT url, title, folder FROM bookmarks WHERE owner = ? AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\') ORDER BY folder, title LIMIT ?`).all(f, like, like, limit);
  }

  boardListIn(f) {
    const items = this.db.prepare('SELECT id, board, img, source, title, thumb, added AS addedAt FROM board_items WHERE folder = ? ORDER BY added DESC').all(f);
    return this.db.prepare('SELECT id, name FROM boards WHERE folder = ? ORDER BY created').all(f)
      .map((b) => ({ ...b, items: items.filter((i) => i.board === b.id) }));
  }

  boardCreateIn(f, name) {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO boards (id, name, created, folder) VALUES (?, ?, ?, ?)').run(id, String(name || 'New board').slice(0, 80), Date.now(), f);
    return id;
  }

  boardRenameIn(f, id, name) { this.db.prepare('UPDATE boards SET name = ? WHERE id = ? AND folder = ?').run(String(name).slice(0, 80), id, f); }
  boardDeleteIn(f, id) {
    this.db.prepare('DELETE FROM board_items WHERE board = ? AND folder = ?').run(id, f);
    this.db.prepare('DELETE FROM boards WHERE id = ? AND folder = ?').run(id, f);
  }
  boardRemoveItemIn(f, id) { this.db.prepare('DELETE FROM board_items WHERE id = ? AND folder = ?').run(id, f); }
  boardAddIn(f, board, { img, source, title, thumb }) {
    // Only onto a board of the same folder.
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id = ? AND folder = ?').get(board, f)) return false;
    this.db.prepare('INSERT INTO board_items (id, board, img, source, title, thumb, added, folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), board, img, source, title || '', thumb || '', Date.now(), f);
    return true;
  }

  searchBoardsIn(f, q, limit = 4) {
    const like = Library.like(q);
    return this.db.prepare(`SELECT source AS url, title FROM board_items WHERE folder = ? AND (title LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\') LIMIT ?`).all(f, like, like, limit);
  }

  // A folder that has been removed takes everything it kept with it.
  removeFolder(f) {
    this.tx(() => {
      for (const [t, col] of [['history', 'folder'], ['sites', 'folder'], ['bookmarks', 'owner'], ['board_items', 'folder'], ['boards', 'folder']]) {
        this.db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(f);
      }
    });
  }

  // How many rows a folder holds, for the tests that prove a removed folder left nothing behind.
  countIn(f) {
    let n = 0;
    for (const [t, col] of [['history', 'folder'], ['sites', 'folder'], ['bookmarks', 'owner'], ['board_items', 'folder'], ['boards', 'folder']]) {
      n += this.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).get(f).n;
    }
    return n;
  }

  // One folder's view of the library. This is the only way main.js reaches it.
  in(f) {
    const folder = String(f || LEGACY);
    return {
      folder,
      visit: (url, title) => this.visitIn(folder, url, title),
      title: (url, title) => this.titleIn(folder, url, title),
      importHistory: (rows) => this.importHistoryIn(folder, rows),
      importBookmarks: (rows) => this.importBookmarksIn(folder, rows),
      sites: (q, limit) => this.sitesIn(folder, q, limit),
      pages: (host, limit) => this.pagesIn(folder, host, limit),
      forgetSite: (host) => this.forgetSiteIn(folder, host),
      history: (q, limit) => this.historyIn(folder, q, limit),
      suggest: (q, limit) => this.suggestIn(folder, q, limit),
      clearHistory: () => this.clearHistoryIn(folder),
      bookmarks: (q, limit) => this.bookmarksIn(folder, q, limit),
      boardList: () => this.boardListIn(folder),
      boardCreate: (name) => this.boardCreateIn(folder, name),
      boardRename: (id, name) => this.boardRenameIn(folder, id, name),
      boardDelete: (id) => this.boardDeleteIn(folder, id),
      boardRemoveItem: (id) => this.boardRemoveItemIn(folder, id),
      boardAdd: (board, item) => this.boardAddIn(folder, board, item),
      searchBoards: (q, limit) => this.searchBoardsIn(folder, q, limit),
    };
  }

  // The old, folder-less calls: they read and write "personal", as every Cue before folders did.
  visit(url, title) { return this.visitIn(LEGACY, url, title); }
  title(url, title) { return this.titleIn(LEGACY, url, title); }
  importHistory(rows) { return this.importHistoryIn(LEGACY, rows); }
  importBookmarks(rows) { return this.importBookmarksIn(LEGACY, rows); }
  sites(q, limit) { return this.sitesIn(LEGACY, q, limit); }
  pages(host, limit) { return this.pagesIn(LEGACY, host, limit); }
  forgetSite(host) { return this.forgetSiteIn(LEGACY, host); }
  history(q, limit) { return this.historyIn(LEGACY, q, limit); }
  suggest(q, limit) { return this.suggestIn(LEGACY, q, limit); }
  clearHistory() { return this.clearHistoryIn(LEGACY); }
  bookmarks(q, limit) { return this.bookmarksIn(LEGACY, q, limit); }
  boardList() { return this.boardListIn(LEGACY); }
  boardCreate(name) { return this.boardCreateIn(LEGACY, name); }
  boardRename(id, name) { return this.boardRenameIn(LEGACY, id, name); }
  boardDelete(id) { return this.boardDeleteIn(LEGACY, id); }
  boardRemoveItem(id) { return this.boardRemoveItemIn(LEGACY, id); }
  boardAdd(board, item) { return this.boardAddIn(LEGACY, board, item); }
  searchBoards(q, limit) { return this.searchBoardsIn(LEGACY, q, limit); }

  // History is the one table that grows for ever, so the oldest rows go first.
  trim(keep) {
    this.db.prepare('DELETE FROM history WHERE rowid NOT IN (SELECT rowid FROM history ORDER BY last DESC LIMIT ?)').run(keep);
    this.db.exec('DELETE FROM sites WHERE last < 0');
  }

  close() { try { this.db.close(); } catch {} }
}

module.exports = { Library };
