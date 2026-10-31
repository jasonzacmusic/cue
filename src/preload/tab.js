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

  // ---- notifications: every one goes to Cue's alert tray; during class they stay off the screen
  let held = !!init.hold;
  const report = (title, body) => document.dispatchEvent(new CustomEvent('cue-note', { detail: JSON.stringify({ title: String(title || ''), body: String(body || '') }) }));
  if (window.Notification) {
    const RealN = window.Notification;
    const Quiet = function Notification(title, opts) {
      report(title, opts && opts.body);
      if (held) return new EventTarget();
      return new RealN(title, opts);
    };
    Quiet.prototype = RealN.prototype;
    Object.defineProperty(Quiet, 'permission', { get: () => RealN.permission });
    Quiet.requestPermission = RealN.requestPermission.bind(RealN);
    Object.defineProperty(Quiet, 'maxActions', { get: () => RealN.maxActions });
    window.Notification = Quiet;
  }
  if (window.ServiceWorkerRegistration) {
    const realShow = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (title, opts) {
      report(title, opts && opts.body);
      return held ? Promise.resolve() : realShow.call(this, title, opts);
    };
  }

  // ---- music kit: speed, A-B loop and transpose on whatever video or audio is playing
  const main = () => media().filter((e) => e.duration > 0).sort((a, b) => ((b.videoWidth || 0) * (b.videoHeight || 0)) - ((a.videoWidth || 0) * (a.videoHeight || 0)) || (b.paused ? -1 : 1))[0];
  const loop = { a: null, b: null, on: false, timer: 0 };
  const checkLoop = () => {
    const e = main();
    if (e && loop.on && loop.a != null && loop.b != null && e.currentTime >= loop.b) e.currentTime = loop.a;
  };
  let semis = 0;
  const shifters = new WeakMap();
  // Two crossfaded read heads over a short delay line: steady pitch, tempo untouched.
  const makeShifter = (el) => {
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(el);
    const node = ctx.createScriptProcessor(4096, 2, 2);
    const size = 8192; const grain = 3072;
    const buf = [new Float32Array(size), new Float32Array(size)];
    let w = 0; let phase = 0;
    const s = { ratio: 1 };
    node.onaudioprocess = (ev) => {
      const n = ev.inputBuffer.length;
      for (let ch = 0; ch < 2; ch++) {
        const i = ev.inputBuffer.getChannelData(Math.min(ch, ev.inputBuffer.numberOfChannels - 1));
        const o = ev.outputBuffer.getChannelData(ch);
        let wr = w; let ph = phase;
        for (let k = 0; k < n; k++) {
          buf[ch][wr] = i[k];
          if (s.ratio === 1) { o[k] = i[k]; } else {
            const read = (head) => {
              const d = head * grain; const p = (wr - d - 1 + size * 2) % size;
              const a = Math.floor(p); const f = p - a;
              return buf[ch][a % size] * (1 - f) + buf[ch][(a + 1) % size] * f;
            };
            const h1 = ph; const h2 = (ph + 0.5) % 1;
            const g1 = Math.sin(Math.PI * h1) ** 2; const g2 = Math.sin(Math.PI * h2) ** 2;
            o[k] = read(h1) * g1 + read(h2) * g2;
            ph = (ph + (1 - s.ratio) / grain + 1) % 1;
          }
          wr = (wr + 1) % size;
        }
        if (ch === 1) { w = wr; phase = ph; }
      }
    };
    src.connect(node); node.connect(ctx.destination);
    return s;
  };

  // These are Cue's hooks, not the page's. A website must not be able to un-blur
  // Safe-share, switch its own notifications back on in the middle of a class, or
  // undo the volume you set for its tab, so they sit behind a secret Cue makes
  // fresh for every page and never hands out.
  const api = {
      setHold(on) { held = !!on; },
      music(op, v) {
        const e = main();
        if (!e) return { none: true };
        if (op === 'speed') { e.preservesPitch = true; e.playbackRate = Math.max(0.25, Math.min(2, v)); }
        if (op === 'a') { loop.a = e.currentTime; if (loop.b != null && loop.b <= loop.a) loop.b = null; }
        if (op === 'b') { loop.b = e.currentTime; if (loop.a == null) loop.a = 0; if (loop.b > loop.a) loop.on = true; }
        if (op === 'loop') loop.on = !!v && loop.a != null && loop.b != null;
        if (op === 'clear') { loop.a = null; loop.b = null; loop.on = false; }
        if (op === 'transpose') {
          semis = Math.max(-12, Math.min(12, Math.round(v)));
          let s = shifters.get(e);
          if (!s) { s = makeShifter(e); shifters.set(e, s); }
          s.ratio = 2 ** (semis / 12);
        }
        clearInterval(loop.timer);
        if (loop.on) loop.timer = setInterval(checkLoop, 40);
        return { speed: e.playbackRate, a: loop.a, b: loop.b, loop: loop.on, semis };
      },
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
  };
  Object.defineProperty(window, '__cue', {
    enumerable: false,
    value: Object.freeze({ call(k, n, ...a) { return k === init.key && api[n] ? api[n](...a) : null; } }),
  });
  if (init.safe) document.addEventListener('DOMContentLoaded', () => setSafe(true));
}

// YouTube sends its ads from the same addresses as the video, so a filter list can't touch them.
// This takes them out of the page's own data before the player reads it. Anything that still gets
// through is muted and run to its end the moment it starts. Studio is left alone.
function quietYouTube() {
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  const strip = (o) => {
    if (!o || typeof o !== 'object') return o;
    for (const k of AD_KEYS) delete o[k];
    if (o.playerResponse) strip(o.playerResponse);
    return o;
  };
  const parse = JSON.parse;
  JSON.parse = function (...a) { return strip(parse.apply(this, a)); };
  const json = Response.prototype.json;
  Response.prototype.json = function () { return json.call(this).then(strip); };
  let first;
  Object.defineProperty(window, 'ytInitialPlayerResponse', { configurable: true, get: () => first, set: (v) => { first = strip(v); } });

  const hide = new CSSStyleSheet(); // CSS this way can't be refused by the page's security rules
  hide.replaceSync(`#masthead-ad, #player-ads, ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-promoted-sparkles-web-renderer,
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer), ytd-companion-slot-renderer, .ytp-ad-overlay-container, ytd-enforcement-message-view-model,
    tp-yt-paper-dialog:has(ytd-enforcement-message-view-model) { display: none !important; }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, hide];

  let silenced = false; let wasMuted = false;
  document.addEventListener('timeupdate', (e) => { // only fires while a video plays, so an idle tab costs nothing
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    const player = v.closest('.html5-video-player');
    if (player && player.classList.contains('ad-showing')) {
      if (!silenced) { silenced = true; wasMuted = v.muted; v.muted = true; }
      if (Number.isFinite(v.duration) && v.currentTime < v.duration - 0.1) v.currentTime = v.duration;
      const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
      if (skip) skip.click();
    } else if (silenced) { silenced = false; v.muted = wasMuted; }
  }, true);
}

// Google asks the page itself which browser this is before it will let you sign in, and Electron
// answers "Chromium" where a real Chrome answers "Google Chrome" too. This adds the missing name,
// so the answer matches the user agent and the headers Cue already send.
function sayChrome() {
  const data = navigator.userAgentData;
  if (!data || data.brands.some((b) => b.brand === 'Google Chrome')) return;
  const major = (/Chrome\/(\d+)/.exec(navigator.userAgent) || [])[1];
  if (!major) return;
  const brands = Object.freeze([...data.brands.map((b) => ({ brand: b.brand, version: b.version })), { brand: 'Google Chrome', version: major }]);
  const high = data.getHighEntropyValues.bind(data);
  const patched = {
    brands,
    mobile: data.mobile,
    platform: data.platform,
    getHighEntropyValues: (hints) => high(hints).then((v) => {
      if (v.brands) v.brands = brands.map((b) => ({ brand: b.brand, version: b.version }));
      if (v.fullVersionList) v.fullVersionList = [...v.fullVersionList, { brand: 'Google Chrome', version: v.uaFullVersion || major }];
      return v;
    }),
    toJSON: () => ({ brands: brands.map((b) => ({ brand: b.brand, version: b.version })), mobile: data.mobile, platform: data.platform }),
  };
  Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => patched });
}

const KEY = `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const init = ipcRenderer.sendSync('cue:tab-init') || { volume: 1, originalSound: false, safe: false, hold: false };
contextBridge.executeInMainWorld({ func: sayChrome });
contextBridge.executeInMainWorld({ func: install, args: [{ ...init, key: KEY }] });
if (init.ytAds && /^(www|m|music)\.youtube\.com$/.test(location.hostname)) contextBridge.executeInMainWorld({ func: quietYouTube });

const call = (name, ...args) => contextBridge.executeInMainWorld({
  func: (k, n, a) => (window.__cue ? window.__cue.call(k, n, ...a) : null), args: [KEY, name, args],
});

ipcRenderer.on('cue:volume', (_e, v) => call('setVolume', v));
ipcRenderer.on('cue:media', (_e, cmd) => {
  linkQuiet = Date.now() + 500;
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

// a half-typed form must not be lost to tab sleep
let typed = false;
window.addEventListener('input', () => { if (!typed) { typed = true; ipcRenderer.send('cue:dirty'); } }, true);

// play and pause travel to the other tabs in a split view when Play Together is on
let linkQuiet = 0;
for (const type of ['play', 'pause']) {
  window.addEventListener(type, (e) => {
    if (e.target instanceof HTMLMediaElement && Date.now() >= linkQuiet) ipcRenderer.send('cue:play-link', type);
  }, true);
}

ipcRenderer.on('cue:hold', (_e, on) => call('setHold', on));
ipcRenderer.on('cue:music', (_e, op, v) => ipcRenderer.send('cue:music-state', call('music', op, v)));
document.addEventListener('cue-note', (e) => {
  try { const n = JSON.parse(e.detail); ipcRenderer.send('cue:note', n); } catch {}
});

// Alt-click a link to Peek at it without leaving the page.
document.addEventListener('click', (e) => {
  if (!e.altKey || !e.isTrusted) return;
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault(); e.stopPropagation();
  ipcRenderer.send('cue:peek', a.href);
}, true);

// ---- Cue's own pages (Boards, Library, Bills, Thumbnail check)
if (location.protocol === 'cue:') {
  contextBridge.exposeInMainWorld('cueInternal', { invoke: (cmd, args) => ipcRenderer.invoke('cue:internal', cmd, args) });
}

// ---- saved logins: fill when a password box appears, offer to save when a form is sent
if (window === window.top && /^https?:$/.test(location.protocol)) {
  let filled = false; let tried = false;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== 'hidden'; };
  const pwField = () => [...document.querySelectorAll('input[type=password]')].find(visible);
  const userField = (pw) => {
    const inputs = [...(pw.form || document).querySelectorAll('input')].filter((i) => /^(text|email|tel|)$/.test(i.type) && visible(i));
    const before = inputs.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before[before.length - 1] || inputs[0] || null;
  };
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const fill = async (pw) => {
    if (filled) return;
    const c = await ipcRenderer.invoke('cue:cred-get');
    if (!c) return;
    filled = true;
    const u = userField(pw);
    if (u && c.username && !u.value) setVal(u, c.username);
    setVal(pw, c.password);
    if (c.submit) {
      const form = pw.form;
      const btn = (form || document).querySelector('button[type=submit],input[type=submit],button:not([type])');
      setTimeout(() => { if (btn) btn.click(); else if (form) form.requestSubmit(); }, 250);
    }
  };
  // A saved password is typed into the box only after you touch it. A page that
  // loads a hidden login form - which is how passwords get read off a browser
  // that fills them unasked - gets nothing. The school's own sites are the
  // exception: those fill themselves, because signing in to them twenty times
  // a day is the job, not a risk.
  const tryFill = async () => {
    if (filled || tried) return;
    const pw = pwField();
    if (!pw) return;
    tried = true;
    const ready = await ipcRenderer.invoke('cue:cred-ready');
    if (!ready) return;
    if (ready.handsFree) { fill(pw); return; }
    const wake = (e) => {
      if (!e.isTrusted) return; // a real press only: a page's own script can focus a box or fake a press
      const box = e.target;
      if (!box || box.tagName !== 'INPUT') return;
      const now = pwField();
      if (!now || (box !== now && box !== userField(now))) return;
      document.removeEventListener('pointerdown', wake, true);
      fill(now);
    };
    document.addEventListener('pointerdown', wake, true);
  };
  const offer = () => {
    const pw = pwField();
    if (!pw || !pw.value) return;
    const u = userField(pw);
    ipcRenderer.send('cue:cred-offer', { username: u ? u.value : '', password: pw.value });
  };
  document.addEventListener('submit', offer, true);
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('button,input[type=submit],[role=button]')) offer(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.type === 'password') offer(); }, true);
  addEventListener('DOMContentLoaded', () => {
    tryFill();
    new MutationObserver(() => { if (!filled && !tried) tryFill(); }).observe(document.documentElement, { childList: true, subtree: true });
  });
}
