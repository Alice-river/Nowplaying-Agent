const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
  onConfig: (cb) => ipcRenderer.on('relay:config', (_event, config) => cb(config)),
  onSend: (cb) => ipcRenderer.on('relay:send', (_event, payload) => cb(payload)),
  status: (value) => ipcRenderer.send('relay:status', value),
  subStatus: (value) => ipcRenderer.send('relay:sub-status', value),
  serverState: (state) => ipcRenderer.send('relay:server-state', state),
  command: (message) => ipcRenderer.send('relay:command', message),
});
