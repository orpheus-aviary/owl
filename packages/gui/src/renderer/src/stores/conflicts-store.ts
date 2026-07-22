/**
 * P5-c §6.19 / §6.33 — renderer-side conflict count + list.
 *
 * Two refresh sources:
 *   1. SSE `conflicts:changed` event from daemon (see
 *      `events-subscriber-core.ts` — dispatches into `refresh()`).
 *   2. cold-start fetch on `MainApp` mount — covers the case where the
 *      daemon has been running with unresolved conflicts before the
 *      renderer attached, so no SSE event has fired yet.
 *
 * `count` is the value the sidebar 红点 reads. `list` is populated lazily
 * by `ConflictsPage` calling `refreshList()` on mount; the sidebar count
 * never needs the full list, so we keep them on separate refresh paths
 * to avoid pulling N rows for a number-only render.
 */

import { type ConflictRecord, getConflictCount, listConflicts } from '@/lib/api';
import { create } from 'zustand';
import { currentGen, isStale } from './session-epoch';

interface ConflictsStore {
  /** Unresolved conflict count, refreshed on event + cold-start fetch. */
  count: number;
  /** Lazily populated by ConflictsPage. */
  list: ConflictRecord[];
  /** True between `refresh()` start and resolution. */
  loading: boolean;
  /** Last fetch error (null on success or before first fetch). */
  error: string | null;
  /** Fetch /conflicts/count and update `count`. Used by sidebar + events. */
  refresh: () => Promise<void>;
  /** Fetch /conflicts list and update `list`. Used by ConflictsPage. */
  refreshList: (limit?: number) => Promise<void>;
  /** ③: back to the initial per-session shape. */
  reset: () => void;
}

export const useConflictsStore = create<ConflictsStore>((set) => ({
  count: 0,
  list: [],
  loading: false,
  error: null,
  refresh: async () => {
    const gen = currentGen();
    try {
      const res = await getConflictCount();
      if (isStale(gen)) return;
      set({ count: res.data?.count ?? 0, error: null });
    } catch (err) {
      if (isStale(gen)) return;
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  refreshList: async (limit?: number) => {
    const gen = currentGen();
    set({ loading: true });
    try {
      const res = await listConflicts(limit);
      if (isStale(gen)) return;
      const rows = res.data?.conflicts ?? [];
      // AC4: `count` is owned solely by `refresh()` (GET /conflicts/count).
      // `list` is capped at `limit` (default 50), so setting count=rows.length
      // here would under-report the sidebar 红点 whenever there are >limit
      // unresolved conflicts. List and count stay on separate refresh paths.
      set({ list: rows, loading: false, error: null });
    } catch (err) {
      if (isStale(gen)) return;
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  reset: () => set({ count: 0, list: [], loading: false, error: null }),
}));
