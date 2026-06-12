import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { subscribeSse } from '../lib/sse-client';
import { useConflictsStore } from '../stores/conflicts-store';
import { useDataBus } from '../stores/data-bus';
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
 * Uses `subscribeSse` (fetch-based) rather than native `EventSource` so the
 * request can carry auth headers (Phase A) and so the same code runs in a
 * browser host. `subscribeSse` owns its own exponential-backoff reconnect;
 * `controller.abort()` in cleanup tears it down on unmount and on StrictMode's
 * dev-mode double-mount — no long-lived leaks either way.
 *
 * `onEvent` receives the RAW data string; `handleDaemonEvent` parses it (and
 * silently ignores unknown event names like the daemon's keep-alive 'hello').
 *
 * On mount we also fire one `GET /sync/status` to seed the status bar
 * for the cold-start case (daemon has been running before the renderer
 * opened, so no `sync:status_changed` has fired yet).
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
    const controller = new AbortController();
    const handlers = {
      openNoteById,
      navigate: (path: string) => navigate(path),
      setSyncStatus,
      refreshConflicts,
      bumpConflicts,
    };

    subscribeSse({
      path: '/events',
      signal: controller.signal,
      onEvent: (event, rawData) => {
        void handleDaemonEvent(event, rawData, handlers);
      },
    });

    return () => controller.abort();
  }, [navigate, setSyncStatus, refreshConflicts, bumpConflicts]);

  return null;
}
