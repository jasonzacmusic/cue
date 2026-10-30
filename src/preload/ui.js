// Bridge for Cue's own sidebar and toolbar.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cue', {
  send: (cmd, args) => ipcRenderer.send('ui:cmd', cmd, args),
  invoke: (cmd, args) => ipcRenderer.invoke('ui:invoke', cmd, args),
  onState: (cb) => ipcRenderer.on('ui:state', (_e, s) => cb(s)),
  onEvent: (cb) => ipcRenderer.on('ui:event', (_e, name, data) => cb(name, data)),
  platform: process.platform,
});
