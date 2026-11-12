// Small JSON store in the app's own folder. Writes are debounced and atomic.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir, name, defaults) {
    this.file = path.join(dir, name);
    this.data = structuredClone(defaults);
    // A brand-new install, as opposed to one that has run before. Main uses it to decide what an
    // install with no folder list saved should look like: the owner's two folders, or one.
    this.fresh = !fs.existsSync(this.file);
    // cue.json exactly as it was read, so a one-time step can tell a value that was saved from one
    // that only ever came from a default (main.js: freezeLegacy).
    this.raw = {};
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.raw = structuredClone(saved);
      this.data = { ...this.data, ...saved };
    } catch { /* first run */ }
    this.timer = null;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 600);
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
