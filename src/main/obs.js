// Minimal OBS remote control (obs-websocket v5, built into OBS 28+).
// Used to switch scenes when a tab goes on air.
const crypto = require('crypto');

class OBS {
  constructor() {
    this.ws = null;
    this.ready = false;
    this.pending = new Map();
    this.status = 'off';
    this.onStatus = () => {};
  }

  setStatus(s) { this.status = s; this.onStatus(s); }

  connect({ host = '127.0.0.1', port = 4455, password = '' } = {}) {
    this.close();
    this.setStatus('connecting');
    let ws;
    try { ws = new WebSocket(`ws://${host}:${port}`); } catch { this.setStatus('off'); return; }
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.op === 0) { // Hello
        const ident = { rpcVersion: 1 };
        const auth = msg.d.authentication;
        if (auth) {
          const secret = crypto.createHash('sha256').update(password + auth.salt).digest('base64');
          ident.authentication = crypto.createHash('sha256').update(secret + auth.challenge).digest('base64');
        }
        ws.send(JSON.stringify({ op: 1, d: ident }));
      } else if (msg.op === 2) { // Identified
        this.ready = true;
        this.setStatus('connected');
      } else if (msg.op === 7) { // RequestResponse
        const p = this.pending.get(msg.d.requestId);
        if (p) { this.pending.delete(msg.d.requestId); p(msg.d); }
      }
    };
    ws.onclose = () => { if (this.ws !== ws) return; this.ready = false; this.setStatus('off'); };
    ws.onerror = () => { if (this.ws !== ws) return; this.ready = false; this.setStatus('off'); };
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null; this.ready = false;
  }

  request(requestType, requestData = {}) {
    if (!this.ready) return Promise.resolve(null);
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      setTimeout(() => { if (this.pending.delete(requestId)) resolve(null); }, 3000);
    });
  }

  setScene(sceneName) {
    if (!sceneName) return Promise.resolve(null);
    return this.request('SetCurrentProgramScene', { sceneName });
  }

  // This scene belongs to the class rig. A modified scene must never expose a
  // second picture, and a stale capture must never be sent to the audience.
  async selectQueueStage(window, stillLive) {
    const sceneName = 'Cue Live Queue', source = 'Cue Live Queue Stage';
    const items = (await this.request('GetSceneItemList', { sceneName }))?.responseData?.sceneItems;
    if (!items) return; // OBS installations without the dedicated rig keep their selected scene.
    const enabled = items.filter((item) => item.sceneItemEnabled);
    const allowed = new Map([[source, 'screen_capture'], ['Face Circle — DSLR', 'av_capture_input_v2'],
      ['Face Circle — Gold Ring', 'image_source']]);
    const stage = enabled.find((item) => item.sourceName === source);
    const settings = await this.settings(source);
    if (!stage || enabled.some((item) => allowed.get(item.sourceName) !== item.inputKind || !allowed.has(item.sourceName))
        || settings?.type !== 1 || Number(settings.window) !== window || settings.application !== 'com.jasonzac.cue') {
      throw new Error('Check the sources in the OBS Cue Live Queue scene.');
    }
    const target = { sceneName, sceneItemId: stage.sceneItemId };
    // ScreenCaptureKit can accept the new window ID before its window list catches up.
    // Resending identical settings is ignored by OBS. Restart the window stream only,
    // preserving the window ID, and restore its cursor setting immediately afterward.
    for (let attempt = 0; attempt < 12; attempt++) {
      if (!stillLive()) return;
      const size = (await this.request('GetSceneItemTransform', target))?.responseData?.sceneItemTransform;
      if (size?.sourceWidth > 0 && size?.sourceHeight > 0) break;
      if (attempt === 11) throw new Error('OBS has no frames from Cue Stage. Press the queue pedal to reconnect it.');
      if (attempt === 2 || attempt === 6) {
        const windows = await this.propertyItems(source, 'window');
        if (windows.some((w) => Number(w.itemValue) === window && w.itemName.includes('Cue Stage')) && stillLive()) {
          await this.setSettings(source, { show_cursor: true });
          await new Promise((resolve) => setTimeout(resolve, 120));
          await this.setSettings(source, { show_cursor: false });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const studio = (await this.request('GetStudioModeEnabled'))?.responseData?.studioModeEnabled;
    if (!stillLive()) return;
    const result = await this.setScene(sceneName);
    if (!result?.requestStatus?.result) throw new Error('OBS could not show Cue Live Queue.');
    if (studio && stillLive()) await this.request('SetCurrentPreviewScene', { sceneName });
  }

  async inputs(kind) {
    const r = await this.request('GetInputList', kind ? { inputKind: kind } : {});
    return r && r.responseData ? r.responseData.inputs.map((i) => i.inputName) : [];
  }

  async settings(name) {
    const r = await this.request('GetInputSettings', { inputName: name });
    return r && r.responseData ? r.responseData.inputSettings : null;
  }

  setSettings(name, inputSettings) {
    return this.request('SetInputSettings', { inputName: name, inputSettings, overlay: true });
  }

  // What OBS itself thinks it can capture right now. macOS hands it this list
  // on a delay, so a window a second old is still missing from it.
  async propertyItems(inputName, propertyName) {
    const r = await this.request('GetInputPropertiesListPropertyItems', { inputName, propertyName });
    return r && r.responseData ? r.responseData.propertyItems : [];
  }

  async scenes() {
    const r = await this.request('GetSceneList');
    return r && r.responseData ? r.responseData.scenes.map((s) => s.sceneName) : [];
  }
}

module.exports = { OBS };
