import { App } from '@/App';
import { getPlatform } from '@/platform';
import { configureTransport } from '@orpheus-aviary/owl-shared';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './style.css';

// Browser entry — mirrors the renderer's own main.tsx, but this is the web
// host. The base URL comes from the web platform adapter (same-origin relative
// path). B0 attaches no auth headers; B1 swaps getAuthHeaders for the bearer
// once /auth/login lands, through this same seam.
configureTransport({
  baseUrl: () => getPlatform().daemonBaseUrl(),
  getAuthHeaders: () => ({}),
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('owl-web: #root element not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
