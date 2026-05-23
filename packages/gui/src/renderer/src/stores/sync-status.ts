import { type SyncStatusSnapshot, getSyncStatus } from '@/lib/api';
import { create } from 'zustand';

/**
 * P5-b §6.3 — renderer-side mirror of daemon's `SyncStatusSnapshot`.
 *
 * Two sources feed this store:
 *   1. one-shot `GET /sync/status` on mount (covers the cold-start case
 *      where the daemon has been running before the renderer opened, so
 *      no `sync:status_changed` SSE event has fired yet). The GET shape
 *      lacks `state`/`last_error`, so we derive `state='idle'` from a
 *      successful fetch — SSE will overwrite with the live state when
 *      something actually flips.
 *   2. SSE `sync:status_changed` events from the existing `/events`
 *      channel (see `events-subscriber-core.ts`)
 *
 * `null` means "haven't heard from daemon yet" — distinct from "daemon
 * says no sync configured" (which surfaces as a snapshot with the
 * absence of `server_url`/`workspace_id`). The status bar treats `null`
 * like idle to avoid flashing an alarm during the first paint.
 */
interface SyncStatusStore {
  snapshot: SyncStatusSnapshot | null;
  setSnapshot: (snap: SyncStatusSnapshot) => void;
  fetch: () => Promise<void>;
}

export const useSyncStatus = create<SyncStatusStore>((set) => ({
  snapshot: null,
  setSnapshot: (snap) => set({ snapshot: snap }),
  fetch: async () => {
    try {
      const res = await getSyncStatus();
      if (!res.data) return;
      const { configured: _c, authenticated: _a, ...rest } = res.data;
      set({
        snapshot: {
          ...rest,
          state: 'idle',
          last_error: null,
        },
      });
    } catch {
      // Daemon down / sync not configured — leave snapshot null so the
      // status bar can show its "no daemon" fallback rather than a stale
      // value.
    }
  },
}));
