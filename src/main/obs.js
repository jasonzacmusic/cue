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
    ws.onclose = () => { this.ready = false; this.setStatus('off'); };
    ws.onerror = () => { this.ready = false; this.setStatus('off'); };
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
