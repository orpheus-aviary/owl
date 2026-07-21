import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { SseHttpError, subscribeSse } from '../lib/sse-client';
import { clearWebSession, getWebSession } from '../platform/web-session';
import { invalidateSession } from '../session/session-actions';
import { useConflictsStore } from '../stores/conflicts-store';
import { useDataBus } from '../stores/data-bus';
import { openNoteById } from '../stores/editor-store';
import { currentGen, isStale } from '../stores/session-epoch';
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
 * `onEvent` receives the RAW data string; `handleDaemonEvent` parses it. The
 * daemon's keep-alive 'hello' frame is routed to a status re-probe (①).
 *
 * On mount we also fire one `GET /sync/status` to seed the status bar
 * for the cold-start case (daemon has been running before the renderer
 * opened, so no `sync:status_changed` has fired yet). ① — the same probe is
 * re-run on every SSE (re)connect (`hello`) and every disconnect, so a
 * `pending`/`unreachable` status self-heals as the channel recovers.
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
    // ③ (P1-4): capture the session generation this subscription belongs to.
    // Between an epoch bump and this effect's cleanup/abort there is a window
    // where an already-dispatched SSE frame (open_note → navigate,
    // sync:status_changed → setSyncStatus, conflicts:changed → refresh+bump)
    // could still run — tearing down the stream alone doesn't stop queued
    // frames. Every handler bails when the session has moved on, so a stale
    // subscription can never write into the new session.
    const gen = currentGen();
    const controller = new AbortController();
    const handlers = {
      openNoteById, // captures its own gen internally around the GET
      navigate: (path: string) => {
        if (isStale(gen)) return;
        navigate(path);
      },
      setSyncStatus: (snap: Parameters<typeof setSyncStatus>[0]) => {
        if (isStale(gen)) return;
        setSyncStatus(snap);
      },
      refreshConflicts: async () => {
        if (isStale(gen)) return;
        await refreshConflicts();
      },
      bumpConflicts: () => {
        if (isStale(gen)) return;
        bumpConflicts();
      },
      onConnected: () => {
        if (isStale(gen)) return;
        void fetchSyncStatus();
      },
    };

    subscribeSse({
      path: '/events',
      signal: controller.signal,
      onEvent: (event, rawData) => {
        if (isStale(gen)) return;
        void handleDaemonEvent(event, rawData, handlers);
      },
      // Every connection-lifecycle end (error OR silent EOF) re-probes status,
      // so「未连接」flips back once the daemon answers again (D12). ④ (§5.3):
      // fixed order stale → 401 → re-probe.
      onDisconnect: ({ error, usedToken }) => {
        if (isStale(gen)) return;
        // Web: an SSE 401 for the CURRENTLY-active session deactivates, mirroring
        // the REST 401 hook — and BEFORE the status re-probe, so we don't fire a
        // now-tokenless probe that would just 401 again. `usedToken` (captured
        // per attempt) vs `getWebSession()?.token` keeps a stale subscription's
        // late 401 from kicking a newer session. No-op on desktop (session null).
        if (
          error instanceof SseHttpError &&
          error.status === 401 &&
          usedToken === getWebSession()?.token
        ) {
          clearWebSession();
          invalidateSession();
          return;
        }
        void fetchSyncStatus();
      },
    });

    return () => controller.abort();
  }, [navigate, setSyncStatus, fetchSyncStatus, refreshConflicts, bumpConflicts]);

  return null;
}
