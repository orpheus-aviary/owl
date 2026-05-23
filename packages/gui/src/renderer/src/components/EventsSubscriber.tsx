import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { baseUrl } from '../lib/api';
import { openNoteById } from '../stores/editor-store';
import { useSyncStatus } from '../stores/sync-status';
import { handleDaemonEvent } from './events-subscriber-core';

/**
 * Subscribes to the daemon's reverse-channel SSE stream (GET /events)
 * and dispatches known events to store actions. Renders nothing.
 *
 * Must be mounted inside `<HashRouter>` so `useNavigate` has a route
 * context. See `MainApp.tsx`.
 *
 * Native `EventSource` is chosen over the POST-based `streamSse` helper
 * because subscriptions have no body and benefit from the browser's
 * built-in exponential-backoff reconnect. `es.close()` in cleanup
 * covers both unmount and StrictMode's dev-mode double-mount — no
 * long-lived leaks either way.
 *
 * The 'hello' event is informational (connection-live signal); 'error'
 * events fire during the browser's auto-reconnect loop and are safe to
 * ignore.
 *
 * On mount we also fire one `GET /sync/status` to seed the status bar
 * for the cold-start case (daemon has been running before the renderer
 * opened, so no `sync:status_changed` has fired yet).
 */
export function EventsSubscriber(): null {
  const navigate = useNavigate();
  const setSyncStatus = useSyncStatus((s) => s.setSnapshot);
  const fetchSyncStatus = useSyncStatus((s) => s.fetch);

  useEffect(() => {
    void fetchSyncStatus();
  }, [fetchSyncStatus]);

  useEffect(() => {
    const es = new EventSource(`${baseUrl()}/events`);

    es.addEventListener('open_note', (ev: MessageEvent<string>) => {
      void handleDaemonEvent('open_note', ev.data, {
        openNoteById,
        navigate: (path) => navigate(path),
        setSyncStatus,
      });
    });

    es.addEventListener('sync:status_changed', (ev: MessageEvent<string>) => {
      void handleDaemonEvent('sync:status_changed', ev.data, {
        openNoteById,
        navigate: (path) => navigate(path),
        setSyncStatus,
      });
    });

    return () => es.close();
  }, [navigate, setSyncStatus]);

  return null;
}
