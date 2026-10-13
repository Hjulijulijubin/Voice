'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function listen(channel) {
  return (fn) => {
    const handler = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  };
}

contextBridge.exposeInMainWorld('voice', {
  info: () => ipcRenderer.invoke('app:info'),
  setHardwareAcceleration: (on) => ipcRenderer.invoke('app:set-hardware-acceleration', on),
  onInvite: listen('invite'),

  rendezvous: {
    configure: (opts) => ipcRenderer.invoke('rv:configure', opts),
    join: (topic) => ipcRenderer.invoke('rv:join', topic),
    leave: (topic) => ipcRenderer.invoke('rv:leave', topic),
    publish: (topic, payload) => ipcRenderer.invoke('rv:publish', topic, payload),
    status: () => ipcRenderer.invoke('rv:status'),
    onMessage: listen('rv:message'),
    onStatus: listen('rv:status'),
  },

  files: {
    begin: (room, fileId) => ipcRenderer.invoke('fs:begin', room, fileId),
    write: (token, offset, data) => ipcRenderer.invoke('fs:write', token, offset, data),
    finish: (token, sha) => ipcRenderer.invoke('fs:finish', token, sha),
    abort: (token) => ipcRenderer.invoke('fs:abort', token),
    importPath: (room, fileId, src) => ipcRenderer.invoke('fs:import', room, fileId, src),
    read: (room, fileId, offset, length) => ipcRenderer.invoke('fs:read', room, fileId, offset, length),
    size: (room, fileId) => ipcRenderer.invoke('fs:size', room, fileId),
    remove: (room, fileId) => ipcRenderer.invoke('fs:remove', room, fileId),
    list: (room) => ipcRenderer.invoke('fs:list', room),
    removeRoom: (room) => ipcRenderer.invoke('fs:remove-room', room),
    saveAs: (room, fileId, name) => ipcRenderer.invoke('fs:save-as', room, fileId, name),
    open: (room, fileId, name) => ipcRenderer.invoke('fs:open', room, fileId, name),
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file) || null;
      } catch {
        return null;
      }
    },
  },

  bindPtt: (binding) => ipcRenderer.invoke('ptt:bind', binding),
  onPtt: listen('ptt'),
  requestMediaAccess: () => ipcRenderer.invoke('media:access'),
  attention: () => ipcRenderer.send('app:attention'),
});
