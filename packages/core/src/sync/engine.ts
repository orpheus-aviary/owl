/**
 * P5-a Step 5 — core sync engine.
 *
 * `runSync(deps)` performs one pull → push round against a structural
 * client (`SkybridgeClientLike`). The interface deliberately mirrors a
 * minimal subset of `@orpheus-aviary/skybridge-client` so this package keeps zero
 * skybridge dependencies — daemon adapts the real client at the seam.
 *
 * Semantics summary (design doc §7):
 *  - pull: drain server batches into per-batch transactions. Per change:
 *      • non-note → skip + log + cursor advance
 *      • note missing `updated_at_ms` → metadata op (pin / reorder) skip
 *      • note with `updated_at_ms` → validate, then apply via §7.4 LWW
 *    A validator failure throws and rolls back the whole batch; the
 *    cursor is not advanced; the error propagates.
 *  - push: read pending outbox rows, hand them to the client, then in a
 *    single transaction backfill server_seq + synced_at for every
 *    accepted/duplicate cid.
 *  - cursor: pull writes pulled_seq; push writes pushed_seq. Upsert keyed
 *    by endpoint URL so the first sync inserts and subsequent ones
 *    update.
 *  - protocol guard: `changes.length === 0 && hasMore === true` aborts
 *    instead of busy-looping.
 *
 * The per-change apply logic lives in ./apply.ts (LWW primitives in ./lww.ts);
 * runSync only orchestrates the pull/push loop + cursor bookkeeping.
 */

import type Database from 'better-sqlite3';
import type { OwlDatabase } from '../db/index.js';
import { applyOneChange } from './apply.js';
import { setServerTimeOffset } from './hlc.js';
import type { ConflictSink } from './lww.js';
import { type WithRetryOptions, withRetry } from './retry.js';

// ─── Structural client surface (no @orpheus-aviary/skybridge-* imports) ─────────────

export interface LocalChangeLike {
  clientChangeId: string;
  entityType: string;
  entityId: string;
  op: string;
  payload: unknown;
  clientLocalSeq: number;
  clientCreatedAt: number;
  attachmentRefs: null;
}

/**
 * Minimal subset of `@orpheus-aviary/skybridge-proto` `ServerChange` that runSync
 * actually reads. `serverReceivedAt` / `clientLocalSeq` / `clientCreatedAt`
 * / `attachmentRefs` are intentionally dropped — the daemon adapter only
 * forwards what's needed.
 */
export interface ServerChangeLike {
  serverSeq: number;
  clientChangeId: string;
  /** Origin device of the change. Recorded on the local row for forensic
   *  logging; never used for dedup (dedup goes through `clientChangeId`). */
  deviceId: string;
  entityType: string;
  entityId: string;
  op: string;
  payload: unknown;
}

export interface PushAckLike {
  clientChangeId: string;
  serverSeq: number;
}

export interface PushResultLike {
  accepted: PushAckLike[];
  duplicates: PushAckLike[];
  /**
   * W3 (Phase 16c): server wall-clock (Unix ms) at response time. The real
   * client always returns it (skybridge ≥ 0.1.4); optional here so the many
   * structural test fakes don't all have to supply it. runSync uses it to
   * refresh `server_time_offset_ms` when present.
   */
  serverTime?: number;
}

export interface PullResultLike {
  changes: ServerChangeLike[];
  hasMore: boolean;
  /** W3 (Phase 16c): server wall-clock (Unix ms). See PushResultLike.serverTime. */
  serverTime?: number;
}

/** Structural subset of `@orpheus-aviary/skybridge-client` `SkybridgeClient`. */
export interface SkybridgeClientLike {
  pullChanges(workspaceId: string, sinceServerSeq: number): Promise<PullResultLike>;
  pushChanges(workspaceId: string, changes: LocalChangeLike[]): Promise<PushResultLike>;
}

/**
 * `debug` is where every per-change line goes (apply / skip). Those are
 * O(changes) and drown the round-level signal at info — the 0.6.2 soak logs
 * were 24785 per-change lines against 9 retention records in a single day.
 * Required rather than optional so a logger that forgets it fails to compile
 * instead of silently swallowing the lines.
 */
export interface RunSyncLogger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
}

export interface RunSyncDeps {
  /** P5-b §5.2: drizzle wrapper needed by syncNoteTags / syncReminders during note apply. */
  db: OwlDatabase;
  sqlite: Database.Database;
  client: SkybridgeClientLike;
  workspaceId: string;
  /** Persisted `sync_cursor.endpoint` key. Use the server base URL. */
  serverUrl: string;
  nowMs?: () => number;
  logger?: RunSyncLogger;
  /**
   * P5-c §2.3 — HTTP retry options for the push / pull calls. Defaults to
   * `withRetry`'s baked-in 5-retry / 1-2-4-8-16s ladder when omitted.
   * Tests inject `{ sleep, random, isRetryable }` to make the retry loop
   * deterministic. Set `maxRetries: 0` to opt out of retry entirely.
   */
  retryOptions?: WithRetryOptions;
}

export interface RunSyncResult {
  pulledTotal: number;
  appliedTotal: number;
  /** Self-replay echoes, LWW losers, non-note rows, missing-local-row updates. */
  skippedTotal: number;
  pushedTotal: number;
  duplicatesTotal: number;
  serverSeqHigh: number;
  cursorBefore: number;
  cursorAfter: number;
  /**
   * P5-c §6.16/§6.19 — count of `conflict_record` rows written during this
   * runSync. Only `note + op=update + localTs<remoteTs + content differs`
   * cases bump the counter; LWW skips / self-replay / non-note rows do not.
   */
  conflictsRecorded: number;
}

export class SkybridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkybridgeProtocolError';
  }
}

// ─── sync_cursor upsert ─────────────────────────────────────────────

/**
 * Idempotent write into `sync_cursor`. First call for an endpoint inserts
 * with zeros for the column that isn't being updated; subsequent calls
 * leave the opposite column untouched.
 *
 * ⚠️ The DO UPDATE arms MUST read the bound parameters (`@pulled` / `@pushed`),
 * never `excluded.*`. Schema v4 columns are `NOT NULL DEFAULT 0`, so the
 * INSERT arm has to launder NULL through `COALESCE(@x, 0)` — which means
 * `excluded.pulled_seq` is **0, not NULL**, for a push-only write. Reading it
 * there makes `COALESCE(excluded.pulled_seq, sync_cursor.pulled_seq)` collapse
 * to 0 and wipe the other cursor.
 *
 * That was the 0.6.3 V1 bug: every push zeroed `pulled_seq`, so the next round
 * re-pulled the whole change log (49 full replays/day on the 0.6.2 soak
 * machine), and every pull zeroed `pushed_seq`, which is why `/sync/status`
 * always reported `pushed_seq: 0`. See docs/plans/2026-08-11-0.6.3-plan.md §2.
 *
 * 0 is a real value here, not a sentinel — passing `pulledSeq: 0` writes 0.
 */
export function upsertSyncCursor(
  sqlite: Database.Database,
  endpoint: string,
  fields: { pulledSeq?: number; pushedSeq?: number; nowMs: number },
): void {
  sqlite
    .prepare(
      `INSERT INTO sync_cursor (endpoint, pulled_seq, pushed_seq, updated_at)
         VALUES (@endpoint, COALESCE(@pulled, 0), COALESCE(@pushed, 0), @now)
       ON CONFLICT(endpoint) DO UPDATE SET
         pulled_seq = COALESCE(@pulled, sync_cursor.pulled_seq),
         pushed_seq = COALESCE(@pushed, sync_cursor.pushed_seq),
         updated_at = @now`,
    )
    .run({
      endpoint,
      pulled: fields.pulledSeq ?? null,
      pushed: fields.pushedSeq ?? null,
      now: fields.nowMs,
    });
}

// ─── outbox row shape (read-only) ───────────────────────────────────

interface OutboxRow {
  local_seq: number;
  client_change_id: string;
  entity_type: string;
  entity_id: string;
  op: string;
  payload: string;
  created_at: number;
}

// ─── runSync ────────────────────────────────────────────────────────

const NOOP_LOGGER: RunSyncLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
};

/**
 * W3: refresh `server_time_offset_ms` from a pull/push response's serverTime.
 * No-op on the pre-W3 fakes that don't carry it.
 */
function refreshServerOffset(
  sqlite: Database.Database,
  serverTime: number | undefined,
  nowMs: number,
): void {
  if (serverTime !== undefined) setServerTimeOffset(sqlite, serverTime - nowMs);
}

/**
 * One pull → push round.
 *
 * Throws on:
 *  - validator failure during pull (whole batch rolls back, cursor stays)
 *  - protocol violation `(changes.length === 0 && hasMore === true)`
 *  - any network error surfaced by the client
 *
 * Caller (daemon) is responsible for concurrency dedupe (a module-level
 * in-flight Promise) so two callers in the same daemon process don't
 * fire two rounds in parallel — see design §7.5.
 */
export async function runSync(deps: RunSyncDeps): Promise<RunSyncResult> {
  const { db, sqlite, client, workspaceId, serverUrl } = deps;
  const now = deps.nowMs ?? Date.now;
  const logger = deps.logger ?? NOOP_LOGGER;
  // P5-c §2.3: HTTP retry wrapper. Default 5 retries / 1-2-4-8-16s. Plumbed
  // into push + pull only — non-HTTP errors (validator failures, protocol
  // violations) skip the retry layer.
  const retryOptions = deps.retryOptions;
  const retryLogger = retryOptions?.logger ?? {
    warn: (obj: object, msg: string) => logger.warn?.({ kind: 'sync', ...obj }, msg),
  };
  const retryPush = (): Promise<PushResultLike> =>
    // biome-ignore lint/style/noNonNullAssertion: localChangesRef.value is set before retryPush runs in the push loop (hot sync path; cleaner narrowing deferred with the engine.ts split)
    withRetry(() => client.pushChanges(workspaceId, localChangesRef.value!), {
      ...retryOptions,
      logger: retryLogger,
    });
  const retryPull = (sinceServerSeq: number): Promise<PullResultLike> =>
    withRetry(() => client.pullChanges(workspaceId, sinceServerSeq), {
      ...retryOptions,
      logger: retryLogger,
    });
  // Captured-reference trick so we can hoist retryPush() out of the loop
  // body even though `localChanges` is computed later.
  const localChangesRef: { value: LocalChangeLike[] | null } = { value: null };

  // ── Step 0: read cursor ────────────────────────────────────────
  const cursorRow = sqlite
    .prepare('SELECT pulled_seq FROM sync_cursor WHERE endpoint = ?')
    .get(serverUrl) as { pulled_seq: number } | undefined;
  const cursorBefore = cursorRow?.pulled_seq ?? 0;

  let cursor = cursorBefore;
  let pulledTotal = 0;
  let appliedTotal = 0;
  let skippedTotal = 0;
  // P5-c §6.16: per-runSync conflict sink, threaded into applyNoteChange.
  const conflictSink: ConflictSink = { count: 0, nowMs: deps.nowMs };

  // ── Step 1: pull loop ──────────────────────────────────────────
  // Each batch processed in a single sync transaction (better-sqlite3's
  // transactions are sync). Validator throws inside → batch rolls back,
  // outer await unwinds, cursor un-advanced.
  for (;;) {
    const pulled = await retryPull(cursor);

    // W3: refresh the server-clock offset every round — including the empty
    // catch-up pull — so a device that's been offline re-bases immediately on
    // reconnect rather than waiting for the next change.
    refreshServerOffset(sqlite, pulled.serverTime, now());

    if (pulled.changes.length === 0 && pulled.hasMore) {
      throw new SkybridgeProtocolError(
        `pullChanges returned empty batch with hasMore=true at cursor=${cursor}`,
      );
    }
    if (pulled.changes.length === 0) {
      // empty + !hasMore — caught up
      break;
    }

    let batchApplied = 0;
    let batchSkipped = 0;
    const batchHigh = pulled.changes.reduce((m, c) => (c.serverSeq > m ? c.serverSeq : m), cursor);

    const runBatch = sqlite.transaction(() => {
      // P5-c follow-up #2: defer FK checks until COMMIT so out-of-order
      // arrival within a batch (e.g. note.folder_id pointing at a folder
      // that appears later in the same pull) doesn't fail INSERT. SQLite
      // only respects this pragma INSIDE a transaction; it auto-resets
      // on commit/rollback, so no cleanup needed. The 0008 backfill
      // pushes notes before folders (sync_changes order), and a real
      // user could also create a note in folder X before folder X
      // itself reaches the wire — same shape, same fix.
      sqlite.pragma('defer_foreign_keys = ON');
      for (const change of pulled.changes) {
        const outcome = applyOneChange(db, sqlite, change, logger, conflictSink);
        if (outcome === 'applied') batchApplied += 1;
        else batchSkipped += 1;
      }
      upsertSyncCursor(sqlite, serverUrl, { pulledSeq: batchHigh, nowMs: now() });
    });

    runBatch.immediate();

    pulledTotal += pulled.changes.length;
    appliedTotal += batchApplied;
    skippedTotal += batchSkipped;
    cursor = batchHigh;

    if (!pulled.hasMore) break;
  }

  // ── Step 2: push pending outbox ────────────────────────────────
  const pendingRows = sqlite
    .prepare(
      `SELECT local_seq, client_change_id, entity_type, entity_id, op, payload, created_at
         FROM sync_changes
        WHERE synced_at IS NULL
        ORDER BY local_seq`,
    )
    .all() as OutboxRow[];

  let pushedTotal = 0;
  let duplicatesTotal = 0;
  let serverSeqHigh = 0;

  if (pendingRows.length > 0) {
    const localChanges: LocalChangeLike[] = pendingRows.map((row) => ({
      clientChangeId: row.client_change_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      op: row.op,
      payload: JSON.parse(row.payload),
      clientLocalSeq: row.local_seq,
      clientCreatedAt: row.created_at,
      attachmentRefs: null,
    }));

    localChangesRef.value = localChanges;
    const result = await retryPush();

    // W3: push responses also carry serverTime — refresh the offset.
    refreshServerOffset(sqlite, result.serverTime, now());

    const acks: PushAckLike[] = [...result.accepted, ...result.duplicates];
    serverSeqHigh = acks.reduce((m, a) => (a.serverSeq > m ? a.serverSeq : m), 0);

    const backfill = sqlite.transaction(() => {
      const stmt = sqlite.prepare(
        'UPDATE sync_changes SET server_seq = ?, synced_at = ? WHERE client_change_id = ?',
      );
      const ts = now();
      for (const ack of acks) {
        stmt.run(ack.serverSeq, ts, ack.clientChangeId);
      }
      if (serverSeqHigh > 0) {
        upsertSyncCursor(sqlite, serverUrl, { pushedSeq: serverSeqHigh, nowMs: ts });
      }
    });
    backfill.immediate();

    pushedTotal = result.accepted.length;
    duplicatesTotal = result.duplicates.length;
  }

  // ── Step 3: assemble result ────────────────────────────────────
  return {
    pulledTotal,
    appliedTotal,
    skippedTotal,
    pushedTotal,
    duplicatesTotal,
    serverSeqHigh,
    cursorBefore,
    cursorAfter: cursor,
    conflictsRecorded: conflictSink.count,
  };
}

export { ConversationPayloadInvalidError } from './payloads/conversation.js';
export { FolderPayloadInvalidError } from './payloads/folder.js';
export { NotePayloadInvalidError } from './payloads/note.js';
