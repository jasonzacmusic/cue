// Fit a regular beat to recent attacks in media time. Require several distinct
// beats; a loud transient or two is insufficient evidence of tempo.
function fitBeatGrid(attacks, prior) {
  if (attacks.length < 4 || attacks.at(-1).t - attacks[0].t < 1.5) return null;
  const mean = attacks.reduce((s, a) => s + a.v, 0) / attacks.length;
  const hits = attacks.map(a => ({ t: a.t, w: Math.min(2.5, a.v / mean) }));
  const seeds = [...hits].sort((a, b) => b.w - a.w).slice(0, 12);
  const start = hits[0].t, end = hits.at(-1).t;
  const total = hits.reduce((s, a) => s + a.w, 0);
  let best = null;
  for (let tempo = 68; tempo <= 176; tempo += 0.5) {
    const period = 60 / tempo;
    for (const seed of seeds) {
      let match = 0, subdivisions = 0, count = 0;
      for (const hit of hits) {
        const offset = (hit.t - seed.t) / period;
        const error = Math.abs(offset - Math.round(offset)) * period;
        // Repeated eighths and sixteenths distinguish the pulse from an
        // attractive but incorrect dotted-eighth tempo on a syncopated track.
        const eighth = Math.abs(offset*2 - Math.round(offset*2)) * period/2;
        const sixteenth = Math.abs(offset*4 - Math.round(offset*4)) * period/4;
        subdivisions += hit.w * (.6*Math.max(0,1-eighth/.036) + .4*Math.max(0,1-sixteenth/.024));
        if (error >= .065) continue;
        match += hit.w * (1 - error / .065);
        count++;
      }
      const coverage = Math.min(1, count / (1 + (end - start) / period));
      if (count < 4 || coverage < .5) continue;
      const continuity = prior && Math.abs(prior.period - period) < .012 ? .035 : 0;
      const score = (match * (match/count) * Math.sqrt(coverage) + .65*subdivisions) / total + continuity;
      if (!best || score > best.score) best = { score, period, anchor: seed.t };
    }
  }
  if (!best || best.score < .25) return null;
  // Regress attack time against beat number to refine both tempo and phase.
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const h of hits) {
    const x = Math.round((h.t - best.anchor) / best.period);
    const deviation = Math.abs(h.t - best.anchor - x * best.period);
    if (deviation > .055) continue;
    const w = h.w * (1 - deviation / .06);
    n += w; sx += w*x; sy += w*h.t; sxx += w*x*x; sxy += w*x*h.t;
  }
  const denominator = n*sxx - sx*sx;
  if (denominator < .01) return null;
  const period = (n*sxy - sx*sy) / denominator;
  if (!Number.isFinite(period) || Math.abs(period - best.period) > .02) return null;
  return { period, anchor: (sy - period*sx) / n, score: best.score };
}
