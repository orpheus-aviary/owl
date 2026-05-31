/**
 * P5-d Phase 16 (D10b) — claim-empty-account prompt IPC contract.
 *
 * Shared between main (`claim-prompt.ts`), preload, and the renderer
 * `ClaimAccountDialog`. Lives in `shared/` so neither side imports the other.
 */

export type ClaimChoice = 'merge' | 'independent';

export interface ClaimPromptInput {
  /** Email of the (empty) account being logged into. */
  email: string;
  /** Number of notes in the local workspace (trash_level < 2). */
  localCount: number;
  /**
   * True when the local db carries stale sync traces from a prior account
   * (legacy-migrated orphan) → show the B8 "will be re-uploaded" warning.
   */
  hasSyncTraces: boolean;
}
