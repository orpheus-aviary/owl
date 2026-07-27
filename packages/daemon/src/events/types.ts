/**
 * Event types broadcast over the daemon → GUI reverse channel.
 *
 * `hello` is emitted once per subscription at the moment GET /events
 * establishes, so renderers / tests can observe that the channel is live
 * before relying on downstream events.
 *
 * `open_note` is pushed by `POST /events/emit` and makes the GUI open
 * the target note's editor tab. The daemon validates the id (exists and
 * not trashed) before emitting, so subscribers can trust the payload.
 *
 * `sync:status_changed` (P5-b §6.3) carries the latest `SyncStatusSnapshot`
 * so the GUI status bar can reflect manual-sync / SSE-bridge state
 * transitions in real time. The snapshot mirrors the snake_case shape
 * `/sync/status` already returns, with `state` + `last_error` layered on
 * top. Daemon-internal reminder reload is handled by direct
 * `ctx.scheduler.reload()` calls — intentionally NOT a separate event,
 * to avoid leaking internal lifecycle to the GUI.
 *
 * `conflicts:changed` (P5-c §6.19) is a payload-free poke — GUI fetches
 * fresh count via `/conflicts/count` on receipt. Emitted by `manual.ts`
 * when `runSync` returns `conflictsRecorded > 0`, and by `/conflicts/:id/ignore`
 * after the soft-delete UPDATE so other windows see the count drop.
 *
 * `notes:changed` (Problem A / Phase 1b) is the same shape of poke for note +
 * folder data a sync round applied from the remote. Without it the renderer's
 * data-bus is only ever bumped by LOCAL mutations, so a pulled change landed in
 * sqlite while every list and open editor kept showing the pre-sync state until
 * the user navigated or restarted. Emitted by `manual.ts` when `runSync`
 * returns `appliedTotal > 0`.
 *
 * Deliberately payload-free even though the engine knows which rows it touched:
 * the receiver's cost is bounded by how many tabs are OPEN (it re-reads those),
 * not by how many changes arrived, so a first-sync bootstrap applying thousands
 * of rows still costs one refetch per open tab.
 *
 * New event types should be added here and mirrored in the renderer
 * dispatcher (see `packages/gui/src/renderer/src/components/
 * events-subscriber-core.ts`). The wire contract is simply
 * `event: <type>` with `data: JSON.stringify(event)`.
 */
export type OwlEvent =
  | { type: 'hello'; server_time: number }
  | { type: 'open_note'; note_id: string }
  | { type: 'sync:status_changed'; status: SyncStatusSnapshot }
  | { type: 'conflicts:changed' }
  | { type: 'notes:changed' };

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline';

/**
 * Aggregated sync state for the GUI. Extends `SyncStatusResult` (the
 * existing `/sync/status` response) with `state` + `last_error`. Field
 * names stay snake_case to match the existing endpoint so an adapter
 * round-trip between fetch and SSE is unnecessary.
 */
export interface SyncStatusSnapshot {
  state: SyncState;
  server_url: string | null;
  device_id: string | null;
  workspace_id: string | null;
  pending_count: number;
  pulled_seq: number;
  pushed_seq: number;
  last_sync_at: number | null;
  last_error: string | null;
}
