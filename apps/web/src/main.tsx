import { App } from '@/App';
import { getPlatform } from '@/platform';
import { clearWebSession, getWebSession, getWebToken } from '@/platform/web-session';
import { invalidateSession } from '@/session/session-actions';
import { configureTransport } from '@orpheus-aviary/owl-shared';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './style.css';

// Browser entry — mirrors the renderer's own main.tsx, but this is the web
// host. The base URL comes from the web platform adapter (same-origin relative
// path). B1: every request carries the in-memory (or rehydrating) bearer; ④: a
// 401 clears the session AND invalidates the session generation so every store
// resets and the auth gate falls back to login.
configureTransport({
  baseUrl: () => getPlatform().daemonBaseUrl(),
  getAuthHeaders: () => {
    const headers: Record<string, string> = {};
    const token = getWebToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  },
  // ④ (§5.3): only deactivate when the 401 belongs to the CURRENTLY-active
  // session. Compare against `getWebSession()?.token`, not `getWebToken()` — the
  // latter includes the rehydration probe token, whose 401 is `SessionCoordinator`'s
  // to handle. A late 401 from a request issued under a replaced session no longer
  // matches, so it can't tear down the new session.
  onUnauthorized: ({ usedToken }) => {
    if (usedToken === getWebSession()?.token) {
      clearWebSession();
      invalidateSession();
    }
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('owl-web: #root element not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
