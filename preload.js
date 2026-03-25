const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  updateRPC: (data) => ipcRenderer.send('update-rpc', data),
  onUpdateMsg: (cb) => ipcRenderer.on('update-msg', (event, msg) => cb(msg)),
  signalReady: () => ipcRenderer.send('renderer-ready'),
  checkUpdate: () => ipcRenderer.send('manual-check-update')
});
