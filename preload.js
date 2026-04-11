const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  updateRPC: (data) => ipcRenderer.send('update-rpc', data),
  onUpdateMsg: (cb) => ipcRenderer.on('update-msg', (_e, msg) => cb(msg)),
  onUpdateEvent: (cb) => ipcRenderer.on('update-event', (_e, payload) => cb(payload)),
  signalReady: () => ipcRenderer.send('renderer-ready'),
  checkUpdate: () => ipcRenderer.send('manual-check-update'),
  quitAndInstall: () => ipcRenderer.send('quit-and-install'),
});
