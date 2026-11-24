// Runs in every web page Cue shows. Installs small hooks in the page's own world for
// per-tab volume, play/pause, original sound, safe-share blur and synced scrolling.
const { contextBridge, ipcRenderer } = require('electron');

function install(init) {
  if (Object.getOwnPropertyDescriptor(window, init.key)) return;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  let tabVol = init.volume;
  let originalSound = init.originalSound;

  // ---- volume: scale whatever volume the page asks for by the tab's volume
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const pageVol = new WeakMap();
  // Pages can create a new audio element for every message or clip.
  const tracked = new WeakMap(), references = new Set();
  const collected = new FinalizationRegistry(ref => references.delete(ref));
  const seen = {
    add(element) {
      if (tracked.has(element)) return;
      const ref = new WeakRef(element); tracked.set(element, ref);
      references.add(ref); collected.register(element, ref);
    },
    *[Symbol.iterator]() { for (const ref of references) { const el = ref.deref(); if (el) yield el; } },
  };
  const apply = (el) => {
    if (!pageVol.has(el)) pageVol.set(el, desc.get.call(el));
    desc.set.call(el, clamp(pageVol.get(el) * tabVol));
  };
  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    configurable: true, enumerable: true,
    get() { return pageVol.has(this) ? pageVol.get(this) : desc.get.call(this); },
    set(v) { pageVol.set(this, v); desc.set.call(this, clamp(v * tabVol)); },
  });
  // Spotify's public preview CDN serves anonymous CORS audio. Choose that
  // standard mode before first playback so a later pitch change needs no reload.
  if (location.hostname === 'open.spotify.com') {
    const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    const prepare = (element, url) => {
      if (element.crossOrigin != null || !/^https:\/\/p\.scdn\.co\/mp3-preview\//.test(url)) return;
      element.crossOrigin = 'anonymous';
      const fallback = () => {
        element.removeEventListener('loadedmetadata', cleanup);
        if (element.src === url && element.crossOrigin === 'anonymous') { element.removeAttribute('crossorigin'); element.load(); }
      };
      const cleanup = () => element.removeEventListener('error', fallback);
      element.addEventListener('error', fallback, { once: true });
      element.addEventListener('loadedmetadata', cleanup, { once: true });
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'src', { ...src, set(url) { prepare(this, String(url)); src.set.call(this, url); } });
  }
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { seen.add(this); apply(this); return origPlay.apply(this, arguments); };
  // A film that starts by itself (autoplay, or one the page adds later) never calls play(),
  // and used to sound at full volume whatever the tab was set to. Catch it as it loads and
  // again as it starts, so the tab's volume is there from the first sound.
  for (const type of ['loadstart', 'play']) {
    document.addEventListener(type, (e) => { const el = e.target; if (el instanceof HTMLMediaElement) { seen.add(el); apply(el); } }, true);
  }

  const gains = new Map();
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (typeof AudioDestinationNode !== 'undefined' && dest instanceof AudioDestinationNode) {
      const ctx = dest.context;
      let g = gains.get(ctx);
      if (!g) { g = ctx.createGain(); g.gain.value = tabVol; origConnect.call(g, dest); gains.set(ctx, g);
        ctx.addEventListener('statechange', () => { if (ctx.state === 'closed') gains.delete(ctx); }); }
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
  if (init.vanish && md?.getDisplayMedia) md.getDisplayMedia = async () => {
    document.dispatchEvent(new Event(init.key + 'display-denied'));
    throw new DOMException('Screen sharing is unavailable in Vanish.', 'NotAllowedError');
  };
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
  // Some sites are simply too loud to be allowed a box on the screen - WhatsApp
  // above all, two accounts of it, class groups and leads all day. Quiet means
  // the message still reaches Cue's alert tray and the sidebar count, it just
  // never jumps in front of what he is doing. Settings holds the list.
  let quiet = !!init.quiet;
  const report = (title, opts) => document.dispatchEvent(new CustomEvent(`${init.key}n`, { detail: JSON.stringify({ title: String(title || ''), body: String(opts?.body || ''), tag: String(opts?.tag || '') }) }));
  if (window.Notification) {
    const RealN = window.Notification;
    const Quiet = function Notification(title, opts) {
      if (window.Notification.permission === 'granted') report(title, opts);
      if (held || quiet) return new EventTarget();
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
      if (window.Notification.permission === 'granted') report(title, opts);
      return (held || quiet) ? Promise.resolve() : realShow.call(this, title, opts);
    };
  }

  // ---- music kit: speed, A-B loop and transpose on whatever video or audio is playing
  const main = () => media().filter(e => e.readyState > 0)
    .sort((a, b) => Number(a.paused) - Number(b.paused) || Number(a.muted) - Number(b.muted)
      || (b.videoWidth || 0) - (a.videoWidth || 0))[0];
  const loop = { a: null, b: null, on: false, timer: 0, player: null, source: '' };
  const clearLoop = () => { clearInterval(loop.timer); Object.assign(loop, { a:null, b:null, on:false, timer:0 }); };
  const checkLoop = () => {
    const e = loop.player;
    if (!e || e.currentSrc !== loop.source) { clearLoop(); return; }
    if (!e.paused && e.currentTime >= loop.b) e.currentTime = loop.a;
  };
  const loopEnded = (event) => {
    const e = event.target;
    if (!loop.on || e !== loop.player || e.currentSrc !== loop.source) return;
    e.currentTime = loop.a;
    e.play().catch(() => clearLoop());
  };
  document.addEventListener('ended', loopEnded, true);
  const shifters = new WeakMap();
  // Two crossfaded read heads over a short delay line: steady pitch, tempo untouched.
  const makeShifter = (src) => {
    const ctx = src.context;
    const output = ctx.createGain();
    origConnect.call(output, ctx.destination);
    const node = ctx.createScriptProcessor(4096, 2, 2);
    const size = 8192; const grain = 3072;
    const buf = [new Float32Array(size), new Float32Array(size)];
    let w = 0; let phase = 0;
    const s = { ratio: 1, output };
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
    s.semis = 0;
    s.setPitch = (value) => {
      if (s.semis === value) return;
      src.disconnect(); node.disconnect();
      if (value === 0) src.connect(output);
      else { src.connect(node); node.connect(output); }
      s.semis = value; s.ratio = 2 ** (value / 12);
      ctx.resume().catch(() => {});
    };
    return s;
  };

  function mediaShifter(element) {
    const ctx = new AudioContext();
    try { return makeShifter(ctx.createMediaElementSource(element)); }
    catch (error) { ctx.close().catch(() => {}); throw error; }
  }
  function synthMusic(op, value) {
    const buses = [...gains.values()].filter(gain => gain.context.state === 'running' || shifters.has(gain));
    if (!buses.length) return { none: true, status: op === 'status' };
    let error;
    if (op === 'transpose' || op === 'reset') {
      const pitch = op === 'reset' ? 0 : Math.max(-12, Math.min(12, Math.round(value)));
      for (const bus of buses) {
        let shifter = shifters.get(bus);
        if (!shifter && pitch) { shifter = makeShifter(bus); shifters.set(bus, shifter); }
        shifter?.setPitch(pitch);
      }
    } else if (['speed', 'a', 'b', 'loop'].includes(op)) error = 'This live instrument has no playback timeline.';
    return { synth: true, speed: 1, semis: shifters.get(buses[0])?.semis || 0, error };
  }

  // Some public previews allow anonymous CORS but their player never requests
  // it. Ask the media server before switching the player to that mode.
  let pitchRequest = 0, pitchReset = 0;
  const upgrades = new WeakMap();
  async function anonymousPlayback(e, url, reset) {
    const response = await fetch(url, { method: 'HEAD', mode: 'cors', credentials: 'omit',
      signal: AbortSignal.timeout(4000) });
    if (!response.ok || reset !== pitchReset || e.currentSrc !== url || e.mediaKeys) return false;
    const position = e.currentTime, playing = !e.paused, speed = e.playbackRate;
    async function reload(mode) {
      const ready = new Promise((resolve) => {
        const finish = (ok) => { clearTimeout(timer); e.removeEventListener('loadedmetadata', yes); e.removeEventListener('error', no); resolve(ok); };
        const yes = () => finish(true), no = () => finish(false);
        const timer = setTimeout(no, 5000);
        e.addEventListener('loadedmetadata', yes); e.addEventListener('error', no);
      });
      if (mode) e.crossOrigin = mode; else e.removeAttribute('crossorigin');
      e.load();
      if (!await ready || e.currentSrc !== url) return false;
      e.currentTime = position;
      if (playing) await e.play();
      e.defaultPlaybackRate = speed; e.playbackRate = speed;
      // Some players apply their default rate in a task after their play event.
      setTimeout(() => {
        if (e.currentSrc === url && e.defaultPlaybackRate === speed && e.playbackRate === 1) e.playbackRate = speed;
      }, 250);
      return true;
    }
    if (await reload('anonymous').catch(() => false)) return true;
    if (e.currentSrc === url || e.src === url) await reload(null);
    return false;
  }
  function preparePitch(e, value, ticket) {
    let pending = upgrades.get(e);
    if (!pending) {
      pending = anonymousPlayback(e, e.currentSrc, pitchReset).catch(() => false);
      upgrades.set(e, pending); pending.finally(() => upgrades.delete(e));
    }
    pending.then(ok => {
      if (ticket !== pitchRequest || main() !== e) return;
      const state = ok && e.crossOrigin != null ? api.music('transpose', value) : { speed: e.playbackRate, error: 'This player restricts pitch processing.' };
      document.dispatchEvent(new CustomEvent(init.key + 'm', { detail: JSON.stringify(state) }));
    });
  }

  // Listen only after the operator asks to sync. The spectral envelope stays
  // on this device. Detection never asks for a microphone or a desktop source.
  let followWake = null, followTimer = null, listening = null, snapshot = '', lastReport = 0;
  function reportBeat(value) {
    document.dispatchEvent(new CustomEvent(init.key + 'beat', { detail: JSON.stringify(value) }));
  }
  function detachListener() {
    if (!listening) return;
    const { source, analyser, stream, ownContext } = listening;
    try { source?.disconnect(analyser); } catch {}
    stream?.getTracks().forEach(track => track.stop());
    if (ownContext) ownContext.close().catch(() => {});
    listening = null;
  }
  function follow(on) {
    clearTimeout(followTimer); followTimer = null;
    const wakeEvents = ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'loadeddata', 'emptied', 'ended'];
    if (followWake) wakeEvents.forEach(name => document.removeEventListener(name, followWake, true));
    followWake = null;
    detachListener(); snapshot = ''; lastReport = 0;
    if (!on) return;
    let lastMedia, lastUrl, failed = false, state = '', attacks = [];
    let prevFlux = 0, prevTime = 0, beforeFlux = 0, noise = 0;
    let lastPosition = null, lastRate = 0;
    const emit = (kind, e, force = false) => {
      const now = performance.now();
      if (!force && kind === state && now - lastReport < 480) return;
      const reset = kind !== state; state = kind; lastReport = now;
      reportBeat({ state: kind, session: snapshot, position: e?.currentTime || 0, rate: e?.playbackRate || 1,
        at: performance.timeOrigin + now, attacks: kind === 'playing' ? attacks : [], reset });
    };
    const sample = () => {
      // Reuse the current player between reports. Rescan when another player
      // takes over, or when the last player is detached or paused.
      const e = lastMedia && !lastMedia.paused && lastMedia.isConnected ? lastMedia : main();
      const url = e?.currentSrc || '';
      if (e !== lastMedia || url !== lastUrl) {
        detachListener(); failed = false; attacks = []; noise = prevFlux = beforeFlux = 0;
        lastPosition = null; state = ''; lastReport = 0;
        snapshot = String(performance.timeOrigin + performance.now()); lastMedia = e; lastUrl = url;
      }
      if (!e) { emit('no-media', null); return; }
      if (e.mediaKeys || failed) { emit('unavailable', e); return; }
      if (e.paused || e.ended || e.seeking || e.readyState < 3) {
        emit('paused', e); lastPosition = null; return;
      }
      try {
        const shifted = shifters.get(e)?.output;
        if (!listening || shifted !== listening.shifted) {
          detachListener();
          const stream = shifted ? null : e.captureStream();
          const tracks = stream?.getAudioTracks();
          if (tracks && !tracks.length) { stream.getTracks().forEach(t => t.stop()); failed = true; emit('unavailable', e); return; }
          const ctx = shifted?.context || new AudioContext();
          listening = { stream, ownContext: shifted ? null : ctx, shifted };
          const source = shifted || ctx.createMediaStreamSource(new MediaStream([tracks[0]]));
          const analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0;
          origConnect.call(source, analyser);
          Object.assign(listening, { source, analyser, bins: new Uint8Array(512), prev: new Uint8Array(512), rate: ctx.sampleRate });
          ctx.resume().catch(() => {});
        }
        const { analyser, bins, prev, rate } = listening;
        const pos = e.currentTime, speed = e.playbackRate;
        if (lastPosition == null || pos < lastPosition - .015 || pos - lastPosition > .28 || speed !== lastRate) {
          attacks = []; prev.fill(0); prevTime = 0; noise = prevFlux = beforeFlux = 0;
          emit('playing', e, true);
        }
        lastPosition = pos; lastRate = speed;
        analyser.getByteFrequencyData(bins);
        let low = 0, mid = 0, high = 0;
        const lowEnd = Math.max(3, Math.round(180 * 1024 / rate)), midEnd = Math.round(1800 * 1024 / rate);
        const highEnd = Math.min(512, Math.round(8500 * 1024 / rate));
        for (let i = 1; i < highEnd; i++) {
          const rise = Math.max(0, bins[i] - prev[i]);
          if (i < lowEnd) low += rise; else if (i < midEnd) mid += rise; else high += rise;
        }
        prev.set(bins);
        const flux = low/(lowEnd-1) + .7*mid/(midEnd-lowEnd) + .6*high/(highEnd-midEnd);
        noise += .08*(flux-noise);
        if (prevTime && prevFlux > beforeFlux && prevFlux >= flux && prevFlux > Math.max(1.5,noise*1.25)) {
          const hit = { t: prevTime, v: prevFlux };
          const last = attacks.at(-1);
          if (!last || hit.t - last.t > .085) attacks.push(hit);
          else if (hit.v > last.v) attacks[attacks.length-1] = hit;
        }
        while (attacks.length && attacks[0].t < pos-12) attacks.shift();
        beforeFlux = prevFlux; prevFlux = flux; prevTime = pos - speed*.014;
        emit('playing', e);
      } catch { detachListener(); failed = true; emit('unavailable', e, true); }
    };
    followWake = () => {
      clearTimeout(followTimer);
      sample();
      if (state === 'playing') followTimer = setTimeout(followWake, 18);
      else if (lastMedia && !lastMedia.paused && !failed) followTimer = setTimeout(followWake, 250);
    };
    wakeEvents.forEach(name => document.addEventListener(name, followWake, true));
    followWake();
  }

  // These are Cue's hooks, not the page's. A website must not be able to un-blur
  // Safe-share, switch its own notifications back on in the middle of a class, or
  // undo the volume you set for its tab, so they sit behind a secret Cue makes
  // fresh for every page and never hands out.
  const api = {
      follow,
      setHold(on) { held = !!on; },
      setQuiet(on) { quiet = !!on; },
      music(op, v) {
        if (op === 'transpose' || op === 'reset') pitchRequest++;
        if (op === 'reset') pitchReset++;
        const e = main();
        if (!e) return synthMusic(op, v);
        if (loop.player !== e || loop.source !== e.currentSrc) {
          clearLoop(); loop.player = e; loop.source = e.currentSrc;
        }
        let error;
        if (op === 'reset') { clearLoop(); shifters.get(e)?.setPitch(0); e.preservesPitch = true; e.defaultPlaybackRate = e.playbackRate = 1; }
        if (op === 'toggle') {
          if (e.paused) e.play().catch(() => document.dispatchEvent(new CustomEvent(init.key + 'm',
            { detail: JSON.stringify({ ...api.music('status'), error: 'Start playback in this player.' }) })));
          else e.pause();
        }
        if (op === 'speed') { e.preservesPitch = true; e.defaultPlaybackRate = e.playbackRate = Math.max(0.25, Math.min(2, v)); }
        if (['a', 'b', 'loop'].includes(op) && !e.seekable.length) error = 'This player has no seekable passage to loop.';
        else if (op === 'a') { loop.a = e.currentTime; if (loop.b <= loop.a) { loop.b = null; loop.on = false; } }
        else if (op === 'b') {
          if (loop.a == null) loop.a = 0;
          if (e.currentTime > loop.a + 0.05) { loop.b = e.currentTime; loop.on = true; }
          else error = 'Play past the loop start, then set B.';
        }
        if (op === 'loop' && !error) loop.on = !!v && loop.a != null && loop.b != null;
        if (op === 'clear') clearLoop();
        if (op === 'transpose') {
          const value = Math.max(-12, Math.min(12, Math.round(v)));
          let shifter = shifters.get(e);
          if (e.mediaKeys) {
            error = 'This player restricts pitch processing. Its original audio is preserved.';
          } else if (!shifter && value && !e.crossOrigin && /^https?:/.test(e.currentSrc) && new URL(e.currentSrc).origin !== location.origin) {
            preparePitch(e, value, pitchRequest);
          } else if (value || shifter) {
            try {
              if (!shifter) { shifter = mediaShifter(e); shifters.set(e, shifter); }
              shifter.setPitch(value);
            } catch { error = 'This player manages its own audio processing.'; }
          }
        }
        if (loop.on && !loop.timer) loop.timer = setInterval(checkLoop, 40);
        if (!loop.on && loop.timer) { clearInterval(loop.timer); loop.timer = 0; }
        return { playing: !e.paused && !e.ended, speed: e.playbackRate, a: loop.a, b: loop.b, loop: loop.on, semis: shifters.get(e)?.semis || 0, error };
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
  // Under a name made fresh for every page, so nothing a site can look for says "Cue".
  Object.defineProperty(window, init.key, {
    enumerable: false,
    value: Object.freeze({ call(k, n, ...a) { return k === init.key && api[n] ? api[n](...a) : null; } }),
  });
  if (init.safe) document.addEventListener('DOMContentLoaded', () => setSafe(true));
}

// YouTube sends its ads from the same addresses as the video, so a filter list can't touch them.
// This takes them out of the page's own data before the player reads it. Anything that still gets
// through is run to its end the moment it starts. Studio is left alone.
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

  document.addEventListener('timeupdate', (e) => { // only fires while a video plays, so an idle tab costs nothing
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    const player = v.closest('.html5-video-player');
    if (player && player.classList.contains('ad-showing')) {
      if (Number.isFinite(v.duration) && v.currentTime < v.duration - 0.1) v.currentTime = v.duration;
      const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
      if (skip) skip.click();
    }
  }, true);
}

// Which browser this is - navigator.userAgent, navigator.userAgentData, the headers - is no longer
// answered here: src/main/identity.js sets it for the page, its iframes and its workers through
// Chromium itself, and a preload written from the same file covers service workers.

// The name and the headers were never the whole question. Google's sign-in page also reaches for
// window.chrome, and in a real Chrome that object carries loadTimes, csi, app and the three sync
// encryption calls; in Electron it is there but EMPTY, with not one key on it. Measured side by
// side on this Mac, that emptiness was the only difference left, and it is what makes Google turn a
// personal gmail.com address away while it lets a Workspace one through. So Cue now wears the same
// surface, functions that answer and read as native, nothing that does anything behind the page's
// back.
function wearChrome() {
  const c = window.chrome;
  if (!c || typeof c.loadTimes === 'function') return; // a real Chrome, or already dressed
  const native = (name, body) => {
    const f = body || function () {};
    try {
      Object.defineProperty(f, 'name', { value: name, configurable: true });
      Object.defineProperty(f, 'toString', {
        value: function toString() { return `function ${name}() { [native code] }`; }, configurable: true, writable: true,
      });
    } catch { /* a frozen function is still better than no function */ }
    return f;
  };
  const t = () => performance.timeOrigin / 1000;
  const nav = () => performance.getEntriesByType('navigation')[0] || {};
  const put = (name, value) => {
    try { Object.defineProperty(c, name, { value, configurable: true, writable: true, enumerable: true }); } catch { /* leave what is there */ }
  };

  put('loadTimes', native('loadTimes', () => {
    const n = nav();
    const s = (ms) => (ms ? t() + ms / 1000 : 0);
    return {
      requestTime: t(), startLoadTime: t(), commitLoadTime: s(n.responseStart),
      finishDocumentLoadTime: s(n.domContentLoadedEventEnd), finishLoadTime: s(n.loadEventEnd),
      firstPaintTime: s((performance.getEntriesByName('first-paint')[0] || {}).startTime),
      firstPaintAfterLoadTime: 0, navigationType: 'Other',
      wasFetchedViaSpdy: n.nextHopProtocol === 'h2' || n.nextHopProtocol === 'h3',
      wasNpnNegotiated: false, npnNegotiatedProtocol: n.nextHopProtocol || 'unknown',
      wasAlternateProtocolAvailable: false, connectionInfo: n.nextHopProtocol || 'unknown',
    };
  }));
  put('csi', native('csi', () => {
    const n = nav();
    return { startE: Math.round(performance.timeOrigin), onloadT: Math.round(performance.timeOrigin + (n.loadEventEnd || 0)), pageT: performance.now(), tran: 15 };
  }));
  put('app', {
    isInstalled: false,
    getDetails: native('getDetails', () => null),
    getIsInstalled: native('getIsInstalled', () => false),
    installState: native('installState', (cb) => { if (typeof cb === 'function') setTimeout(() => cb('not_installed'), 0); }),
    runningState: native('runningState', () => 'cannot_run'),
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
  });
  // Chrome only hangs these on Google's own sign-in host, and so does Cue: they are the calls the
  // page uses to hand Chrome a sync key, and there is nothing here to hand one to.
  if (/(^|\.)google\.[a-z.]+$/i.test(location.hostname)) {
    for (const name of ['setSyncEncryptionKeys', 'setClientEncryptionKeys', 'addTrustedSyncEncryptionRecoveryMethod']) {
      put(name, native(name, (cb) => { if (typeof cb === 'function') setTimeout(cb, 0); }));
    }
  }
}


const KEY = `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const init = ipcRenderer.sendSync('cue:tab-init') || { volume: 1, originalSound: false, safe: false, hold: false };
contextBridge.executeInMainWorld({ func: wearChrome });
contextBridge.executeInMainWorld({ func: install, args: [{ ...init, key: KEY }] });
if (init.ytAds && /^(www|m|music)\.youtube\.com$/.test(location.hostname)) contextBridge.executeInMainWorld({ func: quietYouTube });

const call = (name, ...args) => contextBridge.executeInMainWorld({
  func: (k, n, a) => (window[k] ? window[k].call(k, n, ...a) : null), args: [KEY, name, args],
});

if (init.vanish) document.addEventListener(KEY + 'display-denied', () => ipcRenderer.send('cue:vanish-share-denied'));
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
ipcRenderer.on('cue:quiet', (_e, on) => call('setQuiet', on));
// The page usually keeps keyboard focus as the pointer crosses the Music bar.
let practiceZone = '';
ipcRenderer.on('cue:practice-hover', (_e, zone) => { practiceZone = zone; });
window.addEventListener('keydown', (e) => {
  if (!e.isTrusted || !practiceZone || e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing ||
      e.composedPath().some(n => n.isContentEditable || n.matches?.('input,textarea,select'))) return;
  if (practiceZone === 'tempo' ? e.key.toLowerCase() !== 't' : !['+', '=', '-'].includes(e.key)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  ipcRenderer.send('cue:practice-key', e.key);
}, true);
for (const event of ['loadedmetadata', 'play', 'pause', 'ended', 'emptied', 'ratechange']) {
  window.addEventListener(event, e => { if (e.target instanceof HTMLMediaElement) ipcRenderer.send('cue:player-changed'); }, true);
}
ipcRenderer.on('cue:follow', (_e, on) => call('follow', !!on));
document.addEventListener(KEY + 'beat', e => {
  if (typeof e.detail !== 'string' || e.detail.length > 24576) return;
  try {
    const d = JSON.parse(e.detail);
    if (!['playing', 'paused', 'no-media', 'unavailable'].includes(d.state) ||
        typeof d.session !== 'string' || d.session.length > 64 ||
        ![d.at, d.position, d.rate].every(Number.isFinite) || d.rate <= 0 || d.rate > 16 ||
        !Array.isArray(d.attacks) || d.attacks.length > 160 ||
        !d.attacks.every(a => Number.isFinite(a.t) && Number.isFinite(a.v) && a.v > 0)) return;
    ipcRenderer.send('cue:beat', d);
  } catch {}
});
ipcRenderer.on('cue:music', (_e, op, v) => ipcRenderer.send('cue:music-state', call('music', op, v)));
document.addEventListener(`${KEY}m`, e => {
  try { ipcRenderer.send('cue:music-state', JSON.parse(e.detail)); } catch {}
});
document.addEventListener(`${KEY}n`, (e) => {
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
  if (location.hostname === 'bills') ipcRenderer.on('cue:alerts-updated', () => window.dispatchEvent(new Event('cue-alerts-updated')));
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
