const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  updateRPC: (data) => ipcRenderer.send('update-rpc', data)
});
