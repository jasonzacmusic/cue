// Small JSON store in the app's own folder. Writes are debounced and atomic.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir, name, defaults) {
    this.file = path.join(dir, name);
    this.data = structuredClone(defaults);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
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
