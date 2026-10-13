'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voice', {
  info: () => ipcRenderer.invoke('app:info'),
  startServer: (opts) => ipcRenderer.invoke('server:start', opts),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  serverStatus: () => ipcRenderer.invoke('server:status'),
  bindPtt: (binding) => ipcRenderer.invoke('ptt:bind', binding),
  onPtt: (fn) => {
    const handler = (_e, down) => fn(down);
    ipcRenderer.on('ptt', handler);
    return () => ipcRenderer.off('ptt', handler);
  },
  requestMediaAccess: () => ipcRenderer.invoke('media:access'),
  attention: () => ipcRenderer.send('app:attention'),
});
