// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    on: ipcRenderer.on.bind(ipcRenderer),
    invoke: ipcRenderer.invoke.bind(ipcRenderer)
  }
});
