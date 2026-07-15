import { configureTransport } from '@orpheus-aviary/owl-shared';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { getPlatform } from './platform';
import './style.css';

// Wire the shared API transport to this host before any component renders. The
// base URL comes from the platform adapter (Electron: injected daemon port).
// A6 — attach the local daemon token as a bearer, read fresh per call (preload
// re-reads the 0600 file) so a daemon restart's rotated token is picked up on
// the next REST/SSE connect. The web host (apps/web/src/main.tsx) supplies the
// cloud session bearer through this same seam (Phase B / B1).
configureTransport({
  baseUrl: () => getPlatform().daemonBaseUrl(),
  getAuthHeaders: () => {
    const headers: Record<string, string> = {};
    const token = getPlatform().getDaemonToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('owl: #root element not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
