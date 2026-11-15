'use strict';
const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('ruic', {
  isDesktop: true,
  getState: () => ipcRenderer.invoke('ruic:state'),
  action: (name, arg) => ipcRenderer.invoke('ruic:action', name, arg),
  projectChanged: (id) => ipcRenderer.send('ruic:project', id),
  onState: (cb) => {
    const handler = (_e, s) => { try { cb(s); } catch {} };
    ipcRenderer.on('ruic:state', handler);
    return () => ipcRenderer.removeListener('ruic:state', handler);
  },
});
