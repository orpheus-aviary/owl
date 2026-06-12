import { configureTransport } from '@orpheus-aviary/owl-shared';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { getPlatform } from './platform';
import './style.css';

// Wire the shared API transport to this host before any component renders. The
// base URL comes from the platform adapter (Electron: injected daemon port;
// web: same-origin). Step 0 attaches no auth headers — Phase A supplies them
// through this same seam.
configureTransport({
  baseUrl: () => getPlatform().daemonBaseUrl(),
  getAuthHeaders: () => ({}),
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
