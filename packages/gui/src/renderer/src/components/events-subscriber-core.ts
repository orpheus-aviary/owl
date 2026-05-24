import type { SyncStatusSnapshot } from '@/lib/api';

/**
 * Pure event-dispatch helper for the daemon → GUI reverse channel.
 *
 * Kept React-free and EventSource-free so it can be unit-tested with
 * plain mocks. `EventsSubscriber` is just a thin wrapper that hooks
 * this into `EventSource.addEventListener` and `useNavigate`.
 *
 * Failures inside the handler chain (malformed payload, note deleted
 * between daemon emit and this handler, network glitch inside
 * `openNoteById`) are swallowed with a warn, because our only caller
 * invokes us via `void handleDaemonEvent(...)` from an EventSource
 * listener — anything thrown or rejected would surface as an
 * unhandled rejection. The emit side already surfaces real failures
 * to the CLI; renderer-side we just want to stay silent.
 *
 * P5-c §6.30 — `EVENT_TYPES` drives the `addEventListener` loop in
 * `EventsSubscriber.tsx`. Adding a new daemon event type requires:
 *   1. Add a branch to `handleDaemonEvent` below.
 *   2. Append the event name to `EVENT_TYPES`.
 * The matching `OwlEvent` union lives in
 * `packages/daemon/src/events/types.ts`.
 */
export const EVENT_TYPES = ['open_note', 'sync:status_changed', 'conflicts:changed'] as const;
export type EventName = (typeof EVENT_TYPES)[number];

export interface EventHandlers {
  openNoteById: (id: string) => Promise<void>;
  navigate: (path: string) => void;
  setSyncStatus: (snapshot: SyncStatusSnapshot) => void;
  /** P5-c §6.19: pulled when daemon signals `conflicts:changed`. */
  refreshConflicts: () => Promise<void>;
  /** P5-c §6.19: nudges data-bus subscribers (ConflictsPage list refetch). */
  bumpConflicts: () => void;
}

export async function handleDaemonEvent(
  eventName: string,
  rawData: string,
  handlers: EventHandlers,
): Promise<void> {
  if (eventName === 'open_note') {
    return handleOpenNote(rawData, handlers);
  }
  if (eventName === 'sync:status_changed') {
    return handleSyncStatusChanged(rawData, handlers);
  }
  if (eventName === 'conflicts:changed') {
    return handleConflictsChanged(handlers);
  }
}

async function handleOpenNote(rawData: string, handlers: EventHandlers): Promise<void> {
  let data: { note_id?: unknown };
  try {
    data = JSON.parse(rawData);
  } catch {
    console.warn('[events] malformed open_note payload');
    return;
  }
  if (typeof data.note_id !== 'string' || !data.note_id) {
    console.warn('[events] open_note missing note_id');
    return;
  }

  try {
    await handlers.openNoteById(data.note_id);
    handlers.navigate('/');
  } catch (err) {
    console.warn('[events] open_note handler failed:', err);
  }
}

/**
 * Daemon emits `sync:status_changed` with the full event envelope:
 *   { type: 'sync:status_changed', status: SyncStatusSnapshot }
 * (see `packages/daemon/src/events/types.ts`).
 *
 * We only validate that `status.state` is one of the four known values
 * — every other field is plumbed straight into the snapshot. A bad
 * payload gets warned and dropped; we never throw because that would
 * surface as an unhandled rejection in the EventSource listener.
 */
function handleSyncStatusChanged(rawData: string, handlers: EventHandlers): void {
  let data: unknown;
  try {
    data = JSON.parse(rawData);
  } catch {
    console.warn('[events] malformed sync:status_changed payload');
    return;
  }
  if (typeof data !== 'object' || data === null) {
    console.warn('[events] sync:status_changed not an object');
    return;
  }
  const status = (data as { status?: unknown }).status;
  if (typeof status !== 'object' || status === null) {
    console.warn('[events] sync:status_changed missing status');
    return;
  }
  const state = (status as { state?: unknown }).state;
  if (state !== 'idle' && state !== 'syncing' && state !== 'error' && state !== 'offline') {
    console.warn('[events] sync:status_changed unknown state:', state);
    return;
  }
  handlers.setSyncStatus(status as SyncStatusSnapshot);
}

/**
 * P5-c §6.19 — `conflicts:changed` is payload-free. Refresh the count
 * via `GET /conflicts/count` and bump data-bus so any open ConflictsPage
 * refetches its list. Both calls are best-effort; refresh() swallows
 * its own errors into `useConflictsStore.error`.
 */
async function handleConflictsChanged(handlers: EventHandlers): Promise<void> {
  await handlers.refreshConflicts();
  handlers.bumpConflicts();
}
