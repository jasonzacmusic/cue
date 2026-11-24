// Run with node --test test/obs-queue.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { OBS } = require('../src/main/obs');

function rig(studio = false) {
  const obs = new OBS();
  const stage = { sourceName: 'Cue Live Queue Stage', sceneItemEnabled: true, inputKind: 'screen_capture' };
  const inputs = [stage, { sourceName: 'Face Circle — DSLR', sceneItemEnabled: true, inputKind: 'av_capture_input_v2' }];
  const settings = { type: 1, window: 81, application: 'com.jasonzac.cue' };
  const switches = [];
  obs.request = async (command, data) => {
    if (command === 'GetSceneItemList') return { responseData: { sceneItems: inputs } };
    if (command === 'GetSceneItemTransform') return { responseData: { sceneItemTransform: { sourceWidth: 3840, sourceHeight: 2160 } } };
    if (command === 'GetInputSettings') return { responseData: { inputSettings: settings } };
    if (command === 'GetStudioModeEnabled') return { responseData: { studioModeEnabled: studio } };
    switches.push([command, data.sceneName]);
    return { requestStatus: { result: true } };
  };
  return { obs, settings, inputs, switches };
}

test('Live selects the verified Stage in Program and Studio Preview', async () => {
  for (const studio of [false, true]) {
    const { obs, switches } = rig(studio);
    await obs.selectQueueStage(81, () => true);
    const expected = [['SetCurrentProgramScene', 'Cue Live Queue']];
    if (studio) expected.push(['SetCurrentPreviewScene', 'Cue Live Queue']);
    assert.deepEqual(switches, expected);
  }
});

test('stale, whole-app, hidden and mixed captures cannot select the queue scene', async () => {
  for (const change of [
    (r) => { r.settings.window = 91; }, (r) => { r.settings.type = 0; },
    (r) => { r.inputs[0].sceneItemEnabled = false; },
    (r) => { r.inputs.push({ sourceName: 'Desktop', sceneItemEnabled: true, inputKind: 'screen_capture' }); },
  ]) {
    const r = rig(true);
    change(r);
    await assert.rejects(r.obs.selectQueueStage(81, () => true));
    assert.deepEqual(r.switches, []);
  }
  const r = rig(true);
  await r.obs.selectQueueStage(81, () => false);
  assert.deepEqual(r.switches, []);
});

test('wait for the exact Stage window before rebinding, and keep an existing stream on subsequent cuts', async () => {
  const obs = new OBS();
  let settings = { application: 'com.jasonzac.cue', type: 1, window: 12 };
  const writes = [];
  obs.settings = async () => settings;
  obs.setSettings = async (_, next) => { writes.push(next); settings = next; return { requestStatus: { result: true } }; };
  let attempts = 0;
  obs.propertyItems = async () => ++attempts === 1
    ? [{ itemValue: 81, itemName: '[Cue] Personal' }]
    : [{ itemValue: 81, itemName: '[Cue] Cue Stage — On Air' }];
  await obs.bindQueueStage(81, () => true);
  await obs.bindQueueStage(81, () => true);
  assert.equal(attempts, 3);
  assert.deepEqual(writes, [{ type: 1, window: 81, application: 'com.jasonzac.cue', show_cursor: false }]);
});
