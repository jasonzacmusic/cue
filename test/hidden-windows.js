// Tests run behind whatever Jason is doing: no Dock icon, no focus, nothing to see or click on.
// Windows stay "open" at zero opacity so pages still draw, play video and take pictures.
// Real macOS full screen would switch his whole screen, so tests only act it out: same events,
// same size. Check the real thing by hand on the installed app.
const Module = require('module');
const electron = require('electron');

const { app, screen } = electron;
if (process.platform === 'darwin') app.setActivationPolicy('accessory');

function behindEverything(Base) {
  return class extends Base {
    constructor(o = {}) {
      super({ ...o, show: false, opacity: 0 });
      this.setIgnoreMouseEvents(true);
      if (o.show !== false) this.showInactive();
    }
    show() { this.showInactive(); }
    focus() {}
    moveTop() {}
    setFullScreen(on) {
      if (on === !!this.actedFull) return;
      this.actedFull = on;
      if (on) { this.before = this.getBounds(); this.setBounds(screen.getPrimaryDisplay().bounds); } else this.setBounds(this.before);
      setImmediate(() => { if (!this.isDestroyed()) this.emit(on ? 'enter-full-screen' : 'leave-full-screen'); });
    }
    isFullScreen() { return !!this.actedFull; }
  };
}

const swapped = new Proxy(electron, {
  get(t, k) {
    if (k === 'BaseWindow' || k === 'BrowserWindow') return swaps[k];
    return t[k];
  },
});
const swaps = { BaseWindow: behindEverything(electron.BaseWindow), BrowserWindow: behindEverything(electron.BrowserWindow) };

const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? swapped : load.call(this, request, ...rest); };
