// Schedule clicks against the audio clock. No timer runs while stopped.
const metronome = (() => {
  const play = document.querySelector('#metro-play');
  const field = document.querySelector('#metro-bpm');
  const tap = document.querySelector('#metro-tap');
  let audio = null, timer = null, next = 0, beat = 0, taps = [];
  const dots = [...document.querySelectorAll('#metro-beats i')];
  const pendingBeats = new Set();
  const sync = document.querySelector('#metro-follow');
  let following = false, grid = null, candidate = null, track = null, lastBeat = null;
  let evidence = null, candidateSince = 0;
  const voices = new Set();
  const nowMs = () => performance.timeOrigin + performance.now();
  function cancelScheduled() {
    for (const voice of voices) { try { voice.stop(); } catch {} }
    voices.clear();
    for (const timer of pendingBeats) clearTimeout(timer);
    pendingBeats.clear();
    dots.forEach(dot => dot.classList.remove('current'));
    lastBeat = null;
  }
  function leaveTrack() {
    if (!following) return;
    following = false;
    window.cue.send('follow-track', { on: false });
    track = grid = candidate = evidence = null; candidateSince = 0;
    sync.setAttribute('aria-pressed', 'false'); sync.textContent = 'Sync to track';
    cancelScheduled(); if (audio) next = audio.currentTime + .02;
  }
  function updateTrack(data) {
    if (!following) return;
    if (!track || track.session !== data.session) { grid = candidate = evidence = null; candidateSince = 0; cancelScheduled(); }
    if (track && (track.state !== data.state || track.rate !== data.rate ||
      Math.abs(data.position - track.position - (data.at-track.at)*track.rate/1000) > .22)) cancelScheduled();
    track = data;
    if (data.state !== 'playing') {
      sync.textContent = data.state === 'paused' ? 'Sync · paused' : data.state === 'unavailable' ? 'Sync unavailable' : 'Waiting for track';
      return;
    }
    const latest = data.attacks.at(-1)?.t;
    if (grid && latest != null && data.position - latest > 5 * data.rate) {
      grid = candidate = null;
      cancelScheduled();
    }
    if (latest != null && latest !== evidence) {
      evidence = latest;
      const d = fitBeatGrid(data.attacks, grid || candidate);
      const span = latest-data.attacks[0].t;
      if (!d || !candidate || Math.abs(d.period-candidate.period) > .009) candidateSince = latest;
      const steady = d && latest-candidateSince > (grid ? 1.5 : .8);
      const clearPulse = d && (d.score > 1.04 ? span > 1.9 : span > 4.5);
      if (steady && clearPulse && (!grid || Math.abs(d.period-grid.period) < .018 || span > 7.5)) grid = d;
      candidate = d;
    }
    sync.textContent = grid ? '● In sync' : 'Listening…';
    if (grid) field.value = Math.round(60*data.rate/grid.period);
  }
  let bus = null, silent = false;
  function setMode(live, muted) {
    silent = live || muted;
    if (bus) bus.gain.value = silent ? 0 : 1;
    const mode = document.querySelector('#metro-mode');
    mode.hidden = !silent;
    mode.textContent = live ? 'Visual only · Live' : muted ? 'Cue muted' : '';
    play.title = silent ? 'Start or stop the visual metronome' : 'Start or stop the audible metronome';
  }
  const bpm = () => Math.max(30, Math.min(300, Math.round(Number(field.value) || 100)));
  const stored = Number(localStorage.getItem('cue-metronome-bpm'));
  if (stored >= 30 && stored <= 300) field.value = stored;
  field.onchange = () => { leaveTrack(); field.value = bpm(); localStorage.setItem('cue-metronome-bpm', field.value); };
  function schedule() {
    if (!audio || audio.state !== 'running') return;
    if (following) {
      if (!grid || track?.state !== 'playing' || nowMs()-track.at > 1200) return;
      const rate = track.rate, elapsed = (nowMs()-track.at)/1000;
      const output = audio.getOutputTimestamp();
      const latency = output.performanceTime > 0 ? Math.max(0, Math.min(.15,
        audio.currentTime - output.contextTime - (performance.now()-output.performanceTime)/1000)) : 0;
      const pos = track.position + (elapsed+latency)*rate;
      const index = Math.ceil((pos-grid.anchor)/grid.period);
      const time = grid.anchor+index*grid.period;
      // A refined grid may choose a different reference beat on each report.
      if (lastBeat !== null && Math.abs(time-lastBeat) < grid.period*.55) return;
      next = audio.currentTime + (time-pos)/rate;
      if (next >= audio.currentTime+.11) return;
      lastBeat = time; beat = Math.round(time/grid.period);
    } else if (next < audio.currentTime) next = audio.currentTime + 0.01;
    while (next < audio.currentTime + 0.11) {
      const osc = audio.createOscillator(), gain = audio.createGain();
      // A beat grid does not establish which beat begins the bar.
      osc.frequency.value = !following && beat % 4 === 0 ? 1350 : 900;
      voices.add(osc); osc.onended = () => voices.delete(osc);
      gain.gain.setValueAtTime(0.16, next);
      gain.gain.exponentialRampToValueAtTime(0.001, next + 0.04);
      osc.connect(gain); gain.connect(bus);
      const index = ((beat % dots.length) + dots.length) % dots.length;
      const indicator = setTimeout(() => {
        pendingBeats.delete(indicator);
        dots.forEach((dot, i) => dot.classList.toggle('current', i === index));
      }, Math.max(0, (next - audio.currentTime) * 1000));
      pendingBeats.add(indicator);
      osc.start(next); osc.stop(next + 0.045);
      if (following) return;
      next += 60 / bpm(); beat++;
    }
  }
  function stop() {
    leaveTrack();
    if (!audio && !timer) return;
    clearInterval(timer); timer = null;
    if (audio) { audio.close().catch(() => {}); audio = null; }
    for (const indicator of pendingBeats) clearTimeout(indicator);
    pendingBeats.clear();
    dots.forEach(dot => dot.classList.remove('current'));
    voices.clear(); bus = null;
    play.setAttribute('aria-pressed', 'false'); play.textContent = '▶ Metronome';
  }
  play.onclick = async () => {
    if (audio) { stop(); return; }
    const ctx = audio = new AudioContext();
    try { await ctx.resume(); } catch { if (audio === ctx) stop(); return; }
    if (audio !== ctx) return;
    bus = ctx.createGain();
    bus.gain.value = silent ? 0 : 1;
    bus.connect(ctx.destination);
    next = ctx.currentTime + 0.02; beat = 0;
    play.setAttribute('aria-pressed', 'true'); play.textContent = '■ Stop';
    schedule(); timer = setInterval(schedule, 50);
  };
  sync.onclick = () => {
    if (following) { stop(); return; }
    following = true; cancelScheduled();
    sync.setAttribute('aria-pressed','true'); sync.textContent = 'Listening…';
    window.cue.send('follow-track', { on: true });
    if (!audio) play.click();
  };
  tap.onclick = () => {
    leaveTrack();
    const now = performance.now();
    if (!taps.length || now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now); taps = taps.slice(-6);
    if (taps.length > 1) { field.value = Math.round(60000 * (taps.length - 1) / (now - taps[0])); field.onchange(); }
  };
  return { stop, setMode, updateTrack };
})();
