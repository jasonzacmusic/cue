// Run with node --test test/beat-grid.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const fit = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ui/beat-grid.js'), 'utf8') + '\nfitBeatGrid');

test('finds tempo and beat position with syncopated offbeats and timing jitter', () => {
  for (const tempo of [80, 101, 113.5, 120, 144]) {
    const period = 60 / tempo;
    const hits = [];
    for (let i = 0; i < 16; i++) {
      const t = 0.19 + i*period + .006*Math.sin(i);
      hits.push({ t, v: 40 }, { t: t + period/2, v: 14 });
      if (i%3 === 0) hits.push({ t: t + period*.75, v: 11 });
    }
    const grid = fit(hits, null);
    assert(Math.abs(60/grid.period-tempo) < .5, 'tempo ' + tempo);
    const index = (grid.anchor-.19)/period;
    assert(Math.abs(index-Math.round(index))*period < .015, 'phase ' + tempo);
  }
});

test('waits for a repeated pulse', () => {
  assert.equal(fit([], null), null);
  assert.equal(fit([{t:.1,v:19},{t:.6,v:20}], null), null);
});
