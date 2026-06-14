import { configureTransport } from '@orpheus-aviary/owl-shared';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { getPlatform } from './platform';
import './style.css';

// Wire the shared API transport to this host before any component renders. The
// base URL comes from the platform adapter (Electron: injected daemon port).
// This Electron entry attaches no auth headers — the local daemon needs none
// until A6's local token. The web host (apps/web/src/main.tsx) supplies the
// cloud bearer through this same seam (Phase B / B1).
configureTransport({
  baseUrl: () => getPlatform().daemonBaseUrl(),
  getAuthHeaders: () => ({}),
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('owl: #root element not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
