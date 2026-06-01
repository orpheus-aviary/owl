/**
 * P5-d Phase 17 (W8) — shape returned by `owlAPI.sync.run()`.
 *
 * Mirrors `@owl/core`'s `RunSyncResult` (sync/engine.ts) verbatim: the daemon
 * passes the engine's result through `POST /sync/run` unchanged, and GUI main
 * forwards `body.data` as-is. Owned here in `shared/` (not imported from core)
 * so the renderer type-graph never drags Node/core modules in — same boundary
 * as `SyncStatusResult` in `sync-status-types.ts`.
 *
 * The status bar's manual-sync action (Phase 17) only needs success/failure;
 * the counts are carried for parity + future display.
 */
export interface RunSyncResult {
  pulledTotal: number;
  appliedTotal: number;
  skippedTotal: number;
  pushedTotal: number;
  duplicatesTotal: number;
  serverSeqHigh: number;
  cursorBefore: number;
  cursorAfter: number;
  conflictsRecorded: number;
}
