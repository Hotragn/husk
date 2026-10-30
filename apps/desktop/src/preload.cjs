// The one door between the desktop app and the small windows it opens (a
// computer's window, the row of 3D computers, the notch): their state comes
// in, and a short list of requests goes out. computers.mjs checks every
// request against the window that sent it. Nothing else is exposed: no Node,
// no files, no raw IPC. The console's own window has no preload at all.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('huskDesktop', {
  platform: process.platform,
  act: (msg) => ipcRenderer.invoke('husk:act', msg),
  onState(cb) {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('husk:state', listener);
    ipcRenderer.send('husk:hello');
    return () => ipcRenderer.removeListener('husk:state', listener);
  },
});
