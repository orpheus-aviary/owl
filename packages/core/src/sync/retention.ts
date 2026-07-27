/**
 * 0.6.2 W2 — pruning of already-synced `sync_changes` rows.
 *
 * Until 0.6.1 the outbox only ever grew: `engine.ts` stamps `server_seq` /
 * `synced_at` on ack and never DELETEs. A 7×24 cloud daemon accumulates a row
 * per mutation forever, which is both disk and (via the `count(*)` in the
 * status broadcaster) latency.
 *
 * ───── The only thing a synced row is still good for ─────
 *
 * `isSelfReplay` (lww.ts): when the server echoes our own change back, we match
 * `client_change_id` against synced rows and skip it. Delete the row too early
 * and the echo is applied as if it were a remote edit. Everything else in the
 * codebase reads `synced_at IS NULL` (pending) only.
 *
 * So a row is safe to drop once the server can never deliver it again, i.e.
 * once the pull cursor has passed its `server_seq`. That statement only holds
 * if every synced row in the table belongs to the *same* server seq space —
 * and the table has no endpoint column (0005 backfills only `server_seq` /
 * `synced_at`). Four gates stand in for the missing column:
 *
 *   1. endpoint singularity — `sync_cursor` rows are never deleted, so
 *      "exactly one cursor row AND it is the endpoint we're syncing with"
 *      proves this db never synced through a *different* URL.
 *   2. provenance watermark — gate 1 can't prove the same URL always backed the
 *      same change log. A local db carrying sync traces may have been claimed
 *      into a different account (0.5.x/0.6.1 allow it), whose seq space is
 *      unrelated. So we only ever prune rows written *after* this db was
 *      installed against the current session: `local_seq > safeAfter`. Rows
 *      below the watermark are of unknown provenance and kept forever.
 *   3. cursor watermark — `server_seq <= pulled_seq` of the current endpoint.
 *   4. time window — `synced_at < now - RETENTION_MS`, slack for manual
 *      debugging and for "synced a second ago, then switched endpoint".
 *
 * Any gate that doesn't hold skips the whole round (degrading to 0.6.1
 * behaviour: nothing is pruned, nothing is lost).
 *
 * Accepted residual risk: if the endpoint's cursor is later reset to 0 and the
 * whole log is re-pulled, pruned rows come back as "remote" changes that
 * `isSelfReplay` no longer recognises. The three-tuple LWW gate then decides —
 * `update`/`trash` equal-or-older are skipped, a `create` may briefly resurrect
 * a locally-deleted note until the later `delete` in the same stream removes it
 * again. No data loss, one replay.
 *
 * ⚠️ INVARIANT for future migrations: **never** derive anything from "does this
 * entity have a historical row in sync_changes" (the 0008 style of existence
 * backfill). Those rows are no longer guaranteed to exist. Use a business-table
 * column or a `local_metadata` marker instead.
 */

import type Database from 'better-sqlite3';

/** `local_metadata` key holding the provenance watermark (gate 2). */
const WATERMARK_KEY = 'sync_retention_safe_after_local_seq';

/**
 * How long a synced row is kept after its ack. Deliberately a module constant
 * rather than a toml knob — the long-run test after 0.6.2 is what decides
 * whether 7 days is the right default.
 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Upper bound on rows deleted per round, so one call can't stall a sync. */
export const MAX_PRUNE_ROWS = 5000;

export interface PruneOptions {
  /** Current `session.serverUrl` — the exact string `runSync` uses. */
  endpoint: string;
  retentionMs?: number;
  maxRows?: number;
  nowMs?: () => number;
}

export type PruneSkipReason =
  | 'no_cursor'
  | 'multi_endpoint'
  | 'endpoint_mismatch'
  | 'watermark_initialized';

export type PruneResult =
  | { pruned: true; deleted: number; cutoff: number; pulledSeq: number; safeAfter: number }
  | { pruned: false; reason: PruneSkipReason };

interface CursorRow {
  endpoint: string;
  pulled_seq: number;
}

function readWatermark(sqlite: Database.Database): number | null {
  const row = sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(WATERMARK_KEY) as
    | { value: string | null }
    | undefined;
  if (!row || row.value === null) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute the watermark for a db that doesn't have one yet:
 *   - has any `sync_cursor` row → it synced before 0.6.2 under an endpoint we
 *     can't attribute per row, so freeze everything that exists today;
 *   - no cursor row → never synced, nothing to protect, start at 0.
 */
function computeWatermark(sqlite: Database.Database): number {
  const cursor = sqlite.prepare('SELECT 1 FROM sync_cursor LIMIT 1').get();
  if (cursor === undefined) return 0;
  const row = sqlite.prepare('SELECT MAX(local_seq) AS n FROM sync_changes').get() as {
    n: number | null;
  };
  return row.n ?? 0;
}

function ensureWatermark(sqlite: Database.Database): { safeAfter: number; initialized: boolean } {
  const existing = readWatermark(sqlite);
  if (existing !== null) return { safeAfter: existing, initialized: false };
  const safeAfter = computeWatermark(sqlite);
  sqlite
    .prepare(
      `INSERT INTO local_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(WATERMARK_KEY, String(safeAfter));
  return { safeAfter, initialized: true };
}

/**
 * Write the provenance watermark if this db doesn't have one, and return it.
 * Idempotent — the first writer wins, later calls are pure reads. Called right
 * after a session is installed (daemon `installSkybridgeSession`) so every row
 * emitted from then on is attributable to that endpoint.
 */
export function ensureRetentionWatermark(sqlite: Database.Database): number {
  return ensureWatermark(sqlite).safeAfter;
}

/**
 * Delete acked `sync_changes` rows that can never be replayed by the server.
 * Safe to call after any successful sync round; every failure mode is a
 * `{pruned:false}` no-op, never a partial delete.
 */
export function pruneSyncedChanges(sqlite: Database.Database, opts: PruneOptions): PruneResult {
  // Gate 2 — a db that only got its watermark just now has no attributable
  // rows yet, so this round establishes the baseline and deletes nothing.
  const { safeAfter, initialized } = ensureWatermark(sqlite);
  if (initialized) return { pruned: false, reason: 'watermark_initialized' };

  // Gate 1 — endpoint singularity.
  const cursors = sqlite
    .prepare('SELECT endpoint, pulled_seq FROM sync_cursor')
    .all() as CursorRow[];
  if (cursors.length === 0) return { pruned: false, reason: 'no_cursor' };
  if (cursors.length > 1) return { pruned: false, reason: 'multi_endpoint' };
  const [cursor] = cursors;
  if (cursor.endpoint !== opts.endpoint) return { pruned: false, reason: 'endpoint_mismatch' };

  const now = opts.nowMs?.() ?? Date.now();
  const cutoff = now - (opts.retentionMs ?? RETENTION_MS);
  const maxRows = opts.maxRows ?? MAX_PRUNE_ROWS;

  // `local_seq > safeAfter` turns the whole subquery into a rowid range
  // SEARCH, so no retention-specific index is worth its size (a partial index
  // over `synced_at IS NOT NULL` would be roughly a second copy of the table).
  // Measured at 200k rows: ~5ms steady state (nothing prunable, walks the
  // range), ~4ms when a full 5000-row batch is deleted — and it runs at most
  // once an hour. See retention.perf.test.ts (OWL_PERF=1).
  const result = sqlite
    .prepare(
      `DELETE FROM sync_changes WHERE local_seq IN (
         SELECT local_seq FROM sync_changes
          WHERE local_seq  >  ?
            AND synced_at IS NOT NULL
            AND synced_at  <  ?
            AND server_seq IS NOT NULL
            AND server_seq <= ?
          ORDER BY local_seq
          LIMIT ?)`,
    )
    .run(safeAfter, cutoff, cursor.pulled_seq, maxRows);

  return {
    pruned: true,
    deleted: result.changes,
    cutoff,
    pulledSeq: cursor.pulled_seq,
    safeAfter,
  };
}
