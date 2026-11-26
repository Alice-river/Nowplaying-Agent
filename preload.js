const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('np', {
  onState: (cb) => ipcRenderer.on('state', (_event, state) => cb(state)),
  onConfig: (cb) => ipcRenderer.on('config', (_event, config) => cb(config)),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setDiscord: (enabled, appId) => ipcRenderer.send('settings:set-discord', { enabled: !!enabled, appId }),
  onDiscordStatus: (cb) => ipcRenderer.on('discord-status', (_event, label) => cb(label)),
  setAutostart: (on) => ipcRenderer.send('settings:set-autostart', !!on),
  setDesktop: (key, on) => ipcRenderer.send('settings:set-desktop', { key: String(key), on: !!on }),
  setBlur: (on) => ipcRenderer.send('settings:set-blur', !!on),
  setRelay: (enabled, address) => ipcRenderer.invoke('settings:set-relay', { enabled: !!enabled, address: String(address) }),
  onRelayStatus: (cb) => ipcRenderer.on('relay-status', (_event, label) => cb(label)),
  onRelayEnabled: (cb) => ipcRenderer.on('relay-enabled', (_event, on) => cb(on)),
  setRemote: (on) => ipcRenderer.send('settings:set-remote', !!on),
  setSkipSpotify: (on) => ipcRenderer.send('settings:set-skip-spotify', !!on),
  onRemoteEnabled: (cb) => ipcRenderer.on('remote-enabled', (_event, on) => cb(on)),
  setTransparency: (value) => ipcRenderer.send('settings:set-transparency', value),
});
