const { contextBridge, ipcRenderer } = require('electron');
const role = new URLSearchParams(location.search).get('role');

if (location.protocol === 'file:') {
    contextBridge.exposeInMainWorld('setup', {
        connect: server => ipcRenderer.invoke('evrika:connect', server)
    });
} else {
    contextBridge.exposeInMainWorld('evrika', {
        role,
        fullscreen: () => ipcRenderer.invoke('evrika:fullscreen'),
        minimize: () => ipcRenderer.invoke('evrika:minimize'),
        configure: () => ipcRenderer.invoke('evrika:configure'),
        notify: () => ipcRenderer.invoke('evrika:notify'),
        notifyMonitor: count => ipcRenderer.invoke('evrika:notify-monitor', count),
        openListing: url => ipcRenderer.invoke('evrika:open-listing', url),
        readCredentials: () => ipcRenderer.invoke('evrika:read-credentials'),
        writeCredentials: credentials => ipcRenderer.invoke('evrika:write-credentials', credentials)
    });
}
