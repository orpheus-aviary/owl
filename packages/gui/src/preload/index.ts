import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('owlAPI', {
  daemonUrl: 'http://127.0.0.1:47010',
});
