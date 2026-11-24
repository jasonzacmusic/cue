// Schedule clicks against the audio clock. No timer runs while stopped.
const metronome = (() => {
  const play = document.querySelector('#metro-play');
  const field = document.querySelector('#metro-bpm');
  const tap = document.querySelector('#metro-tap');
  let audio = null, timer = null, next = 0, beat = 0, taps = [];
  const bpm = () => Math.max(30, Math.min(300, Math.round(Number(field.value) || 100)));
  const stored = Number(localStorage.getItem('cue-metronome-bpm'));
  if (stored >= 30 && stored <= 300) field.value = stored;
  field.onchange = () => { field.value = bpm(); localStorage.setItem('cue-metronome-bpm', field.value); };
  function schedule() {
    if (!audio || audio.state !== 'running') return;
    if (next < audio.currentTime) next = audio.currentTime + 0.01;
    while (next < audio.currentTime + 0.11) {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.frequency.value = beat % 4 === 0 ? 1350 : 900;
      gain.gain.setValueAtTime(0.16, next);
      gain.gain.exponentialRampToValueAtTime(0.001, next + 0.04);
      osc.connect(gain); gain.connect(audio.destination);
      osc.start(next); osc.stop(next + 0.045);
      next += 60 / bpm(); beat++;
    }
  }
  function stop() {
    if (!audio && !timer) return;
    clearInterval(timer); timer = null;
    if (audio) { audio.close().catch(() => {}); audio = null; }
    play.setAttribute('aria-pressed', 'false'); play.textContent = 'Metronome';
  }
  play.onclick = async () => {
    if (audio) { stop(); return; }
    const ctx = audio = new AudioContext();
    try { await ctx.resume(); } catch { if (audio === ctx) stop(); return; }
    if (audio !== ctx) return;
    next = ctx.currentTime + 0.02; beat = 0;
    play.setAttribute('aria-pressed', 'true'); play.textContent = 'Stop click';
    schedule(); timer = setInterval(schedule, 50);
  };
  tap.onclick = () => {
    const now = performance.now();
    if (!taps.length || now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now); taps = taps.slice(-6);
    if (taps.length > 1) { field.value = Math.round(60000 * (taps.length - 1) / (now - taps[0])); field.onchange(); }
  };
  return { stop };
})();
