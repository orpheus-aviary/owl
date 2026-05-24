import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { baseUrl } from '../lib/api';
import { useConflictsStore } from '../stores/conflicts-store';
import { useDataBus } from '../stores/data-bus';
import { openNoteById } from '../stores/editor-store';
import { useSyncStatus } from '../stores/sync-status';
import { EVENT_TYPES, handleDaemonEvent } from './events-subscriber-core';

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
 *
 * P5-c §6.30: the addEventListener loop is now table-driven from
 * `EVENT_TYPES` in `events-subscriber-core.ts`. Adding a new daemon
 * event type means appending to that array and adding a branch in
 * `handleDaemonEvent` — no extra `es.addEventListener` boilerplate
 * here, no risk of "forgot to register" mistakes.
 */
export function EventsSubscriber(): null {
  const navigate = useNavigate();
  const setSyncStatus = useSyncStatus((s) => s.setSnapshot);
  const fetchSyncStatus = useSyncStatus((s) => s.fetch);
  const refreshConflicts = useConflictsStore((s) => s.refresh);
  const bumpConflicts = useDataBus((s) => s.bumpConflicts);

  useEffect(() => {
    void fetchSyncStatus();
  }, [fetchSyncStatus]);

  useEffect(() => {
    const es = new EventSource(`${baseUrl()}/events`);
    const handlers = {
      openNoteById,
      navigate: (path: string) => navigate(path),
      setSyncStatus,
      refreshConflicts,
      bumpConflicts,
    };

    for (const eventName of EVENT_TYPES) {
      es.addEventListener(eventName, (ev: MessageEvent<string>) => {
        void handleDaemonEvent(eventName, ev.data, handlers);
      });
    }

    return () => es.close();
  }, [navigate, setSyncStatus, refreshConflicts, bumpConflicts]);

  return null;
}
