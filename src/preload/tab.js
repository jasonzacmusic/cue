// Runs in every web page Cue shows. Installs small hooks in the page's own world for
// per-tab volume, play/pause, original sound, safe-share blur and synced scrolling.
const { contextBridge, ipcRenderer } = require('electron');

function install(init) {
  if (window.__cue) return;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  let tabVol = init.volume;
  let originalSound = init.originalSound;

  // ---- volume: scale whatever volume the page asks for by the tab's volume
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const pageVol = new WeakMap();
  const seen = new Set();
  const apply = (el) => {
    if (!pageVol.has(el)) pageVol.set(el, desc.get.call(el));
    desc.set.call(el, clamp(pageVol.get(el) * tabVol));
  };
  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    configurable: true, enumerable: true,
    get() { return pageVol.has(this) ? pageVol.get(this) : desc.get.call(this); },
    set(v) { pageVol.set(this, v); desc.set.call(this, clamp(v * tabVol)); },
  });
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { seen.add(this); apply(this); return origPlay.apply(this, arguments); };

  const gains = new Map();
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (typeof AudioDestinationNode !== 'undefined' && dest instanceof AudioDestinationNode) {
      const ctx = dest.context;
      let g = gains.get(ctx);
      if (!g) { g = ctx.createGain(); g.gain.value = tabVol; origConnect.call(g, dest); gains.set(ctx, g); }
      origConnect.call(this, g, ...rest);
      return dest;
    }
    return origConnect.call(this, dest, ...rest);
  };

  const media = () => {
    document.querySelectorAll('audio,video').forEach((e) => seen.add(e));
    return [...seen];
  };

  // ---- original sound: no echo cancel, noise cut or auto-volume on the mic
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const origGUM = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => {
      if (originalSound && c && c.audio) {
        const a = typeof c.audio === 'object' ? c.audio : {};
        c = { ...c, audio: { ...a, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } } };
      }
      return origGUM(c);
    };
  }

  // ---- safe-share: blur emails, phone numbers, money and keys while on air
  const SENSITIVE = /([\w.+-]+@[\w-]+\.[\w.-]+)|(\+?\d[\d\s-]{8,}\d)|([₹$€£]\s?\d[\d,]*(\.\d+)?)|(\b(sk|pk|rk|ghp|gho|xox[bp])[-_][A-Za-z0-9_-]{8,})/g;
  let safeOn = false; let observer = null;
  const mark = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && !n.parentElement.closest('script,style,[data-cue-safe]') && SENSITIVE.test(n.data)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const nodes = []; let n; while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
      SENSITIVE.lastIndex = 0;
      const frag = document.createDocumentFragment(); let last = 0; let m;
      while ((m = SENSITIVE.exec(node.data))) {
        frag.append(node.data.slice(last, m.index));
        const s = document.createElement('span'); s.dataset.cueSafe = '1'; s.textContent = m[0];
        s.style.cssText = 'filter:blur(6px)!important;user-select:none';
        frag.append(s); last = m.index + m[0].length;
      }
      frag.append(node.data.slice(last));
      node.replaceWith(frag);
    }
  };
  const setSafe = (on) => {
    safeOn = on;
    if (on) {
      if (document.body) mark(document.body);
      observer = observer || new MutationObserver((ms) => { if (!safeOn) return; ms.forEach((m) => m.addedNodes.forEach((a) => a.nodeType === 1 && mark(a))); });
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    } else {
      if (observer) observer.disconnect();
      document.querySelectorAll('[data-cue-safe]').forEach((s) => { s.style.filter = 'none'; });
    }
  };

  Object.defineProperty(window, '__cue', {
    enumerable: false,
    value: {
      setVolume(v) { tabVol = clamp(v); media().forEach(apply); gains.forEach((g) => { g.gain.value = tabVol; }); },
      media(cmd) {
        const els = media();
        if (cmd === 'pause') els.forEach((e) => { try { e.pause(); } catch {} });
        if (cmd === 'play' || (cmd === 'toggle' && !els.some((e) => !e.paused))) {
          const e = els.find((x) => x.paused && x.currentTime > 0) || els.find((x) => x.paused);
          if (e) e.play().catch(() => {});
          return true;
        }
        if (cmd === 'toggle') els.forEach((e) => { try { e.pause(); } catch {} });
        return els.some((e) => !e.paused);
      },
      setOriginalSound(on) { originalSound = on; },
      effective() { return media().map((e) => desc.get.call(e)); },
      setSafe,
    },
  });
  if (init.safe) document.addEventListener('DOMContentLoaded', () => setSafe(true));
}

const init = ipcRenderer.sendSync('cue:tab-init') || { volume: 1, originalSound: false, safe: false };
contextBridge.executeInMainWorld({ func: install, args: [init] });

const call = (name, ...args) => contextBridge.executeInMainWorld({
  func: (n, a) => (window.__cue ? window.__cue[n](...a) : null), args: [name, args],
});

ipcRenderer.on('cue:volume', (_e, v) => call('setVolume', v));
ipcRenderer.on('cue:media', (_e, cmd) => {
  const playing = call('media', cmd);
  ipcRenderer.send('cue:media-state', !!playing);
});
ipcRenderer.on('cue:original-sound', (_e, on) => call('setOriginalSound', on));
ipcRenderer.on('cue:safe', (_e, on) => call('setSafe', on));

// synced scrolling between tabs in a split view
let quietUntil = 0;
ipcRenderer.on('cue:scroll-to', (_e, ratio) => {
  quietUntil = Date.now() + 200;
  const max = document.documentElement.scrollHeight - innerHeight;
  window.scrollTo({ top: Math.round(max * ratio), behavior: 'instant' });
});
let ticking = false;
window.addEventListener('scroll', () => {
  if (ticking || Date.now() < quietUntil) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    if (max > 0) ipcRenderer.send('cue:scroll', window.scrollY / max);
  });
}, { passive: true });
