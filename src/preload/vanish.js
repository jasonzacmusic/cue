// Bridge for the Vanish window's small toolbar.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vanish', {
  send: (cmd, args) => ipcRenderer.send('vanish:cmd', cmd, args),
  onState: (cb) => ipcRenderer.on('vanish:state', (_e, s) => cb(s)),
  onFocus: (cb) => ipcRenderer.on('vanish:focus', () => cb()),
  onNote: (cb) => ipcRenderer.on('vanish:note', (_e, text) => cb(text)),
  onFindOpen: (cb) => ipcRenderer.on('vanish:find-open', () => cb()),
  onFindResult: (cb) => ipcRenderer.on('vanish:find-result', (_e, r) => cb(r)),
});
