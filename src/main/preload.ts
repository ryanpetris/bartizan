import { contextBridge, ipcRenderer } from 'electron';
import type { Event } from '../shared';
import { createClient } from '../client';
contextBridge.exposeInMainWorld('bartizan', createClient({
  request: request => ipcRenderer.invoke('request', request),
  readVnc: (connectionId, id, attempt) => ipcRenderer.invoke('vnc-read', connectionId, id, attempt),
  writeVnc: (connectionId, id, attempt, data) => ipcRenderer.invoke('vnc-write', connectionId, id, attempt, data),
  onEvent: callback => {
    const listener = (_: unknown, event: Event) => callback(event);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
}));
