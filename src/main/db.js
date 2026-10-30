// Cue's local library: history, bookmarks and Boards in one small database file.
// Nothing here is ever written for Vanish tabs; main.js does not call it for them.
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

class Library {
  constructor(dir) {
    this.db = new DatabaseSync(path.join(dir, 'cue-library.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS history (url TEXT PRIMARY KEY, title TEXT, visits INTEGER DEFAULT 1, last INTEGER);
      CREATE INDEX IF NOT EXISTS history_last ON history(last DESC);
      CREATE TABLE IF NOT EXISTS bookmarks (url TEXT PRIMARY KEY, title TEXT, folder TEXT);
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS board_items (id TEXT PRIMARY KEY, board TEXT, img TEXT, source TEXT, title TEXT, thumb TEXT, added INTEGER);
    `);
    this.upHist = this.db.prepare(`INSERT INTO history (url, title, visits, last) VALUES (?, ?, 1, ?)
      ON CONFLICT(url) DO UPDATE SET visits = visits + 1, last = excluded.last, title = COALESCE(NULLIF(excluded.title, ''), title)`);
  }

  visit(url, title) { this.upHist.run(url, title || '', Date.now()); }
  title(url, title) { if (title) this.db.prepare('UPDATE history SET title = ? WHERE url = ?').run(title, url); }

  importHistory(rows) {
    const ins = this.db.prepare(`INSERT INTO history (url, title, visits, last) VALUES (?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET visits = MAX(visits, excluded.visits), last = MAX(last, excluded.last)`);
    this.tx(() => rows.forEach((r) => ins.run(r.url, r.title || '', r.visits || 1, r.lastVisit || 0)));
    return rows.length;
  }

  importBookmarks(rows) {
    const ins = this.db.prepare('INSERT OR REPLACE INTO bookmarks (url, title, folder) VALUES (?, ?, ?)');
    this.tx(() => rows.forEach((r) => ins.run(r.url, r.title || '', r.folder || '')));
    return rows.length;
  }

  tx(fn) { this.db.exec('BEGIN'); try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; } }

  history(q, limit = 200) {
    const like = `%${String(q || '').replace(/[%_\\]/g, '\\$&')}%`;
    return this.db.prepare(`SELECT url, title, visits, last AS lastVisit FROM history
      WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' ORDER BY last DESC LIMIT ?`).all(like, like, limit);
  }

  // Best matches for the search bar: frequently and recently visited first.
  suggest(q, limit = 6) {
    const like = `%${String(q || '').replace(/[%_\\]/g, '\\$&')}%`;
    return this.db.prepare(`SELECT url, title FROM history WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'
      ORDER BY visits DESC, last DESC LIMIT ?`).all(like, like, limit);
  }

  clearHistory() { this.db.exec('DELETE FROM history'); }

  bookmarks(q, limit = 5000) {
    const like = `%${String(q || '').replace(/[%_\\]/g, '\\$&')}%`;
    return this.db.prepare(`SELECT url, title, folder FROM bookmarks WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' ORDER BY folder, title LIMIT ?`).all(like, like, limit);
  }

  boardList() {
    const items = this.db.prepare('SELECT id, board, img, source, title, thumb, added AS addedAt FROM board_items ORDER BY added DESC').all();
    return this.db.prepare('SELECT id, name FROM boards ORDER BY created').all()
      .map((b) => ({ ...b, items: items.filter((i) => i.board === b.id) }));
  }

  boardCreate(name) {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO boards (id, name, created) VALUES (?, ?, ?)').run(id, String(name || 'New board').slice(0, 80), Date.now());
    return id;
  }

  boardRename(id, name) { this.db.prepare('UPDATE boards SET name = ? WHERE id = ?').run(String(name).slice(0, 80), id); }
  boardDelete(id) { this.db.prepare('DELETE FROM board_items WHERE board = ?').run(id); this.db.prepare('DELETE FROM boards WHERE id = ?').run(id); }
  boardRemoveItem(id) { this.db.prepare('DELETE FROM board_items WHERE id = ?').run(id); }
  boardAdd(board, { img, source, title, thumb }) {
    this.db.prepare('INSERT INTO board_items (id, board, img, source, title, thumb, added) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), board, img, source, title || '', thumb || '', Date.now());
  }

  searchBoards(q, limit = 4) {
    const like = `%${String(q || '').replace(/[%_\\]/g, '\\$&')}%`;
    return this.db.prepare(`SELECT source AS url, title FROM board_items WHERE title LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\' LIMIT ?`).all(like, like, limit);
  }

  // History is the one table that grows for ever, so the oldest rows go first.
  trim(keep) {
    this.db.prepare('DELETE FROM history WHERE rowid NOT IN (SELECT rowid FROM history ORDER BY last DESC LIMIT ?)').run(keep);
  }

  close() { try { this.db.close(); } catch {} }
}

module.exports = { Library };
