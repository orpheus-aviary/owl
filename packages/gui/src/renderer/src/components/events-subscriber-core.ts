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
 */
export interface EventHandlers {
  openNoteById: (id: string) => Promise<void>;
  navigate: (path: string) => void;
  setSyncStatus: (snapshot: SyncStatusSnapshot) => void;
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
