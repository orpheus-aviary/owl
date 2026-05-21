/**
 * P5-a Step 5 — core sync engine.
 *
 * `runSync(deps)` performs one pull → push round against a structural
 * client (`SkybridgeClientLike`). The interface deliberately mirrors a
 * minimal subset of `@skybridge/client` so this package keeps zero
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
 */

import type Database from 'better-sqlite3';
import { contentHash } from '../notes/hash.js';
import {
  type NoteApplyPayload,
  NotePayloadInvalidError,
  parseNotePayload,
} from './payloads/note.js';

// ─── Structural client surface (no @skybridge/* imports) ─────────────

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
 * Minimal subset of `@skybridge/proto` `ServerChange` that runSync
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
}

export interface PullResultLike {
  changes: ServerChangeLike[];
  hasMore: boolean;
}

/** Structural subset of `@skybridge/client` `SkybridgeClient`. */
export interface SkybridgeClientLike {
  pullChanges(workspaceId: string, sinceServerSeq: number): Promise<PullResultLike>;
  pushChanges(workspaceId: string, changes: LocalChangeLike[]): Promise<PushResultLike>;
}

export interface RunSyncLogger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
}

export interface RunSyncDeps {
  sqlite: Database.Database;
  client: SkybridgeClientLike;
  workspaceId: string;
  /** Persisted `sync_cursor.endpoint` key. Use the server base URL. */
  serverUrl: string;
  nowMs?: () => number;
  logger?: RunSyncLogger;
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
 * preserve the opposite column via `COALESCE(excluded.*, sync_cursor.*)`.
 *
 * Schema v4 columns are `NOT NULL DEFAULT 0`, but INSERT-ing a literal
 * NULL still violates the constraint — `COALESCE(?, 0)` covers that.
 */
export function upsertSyncCursor(
  sqlite: Database.Database,
  endpoint: string,
  fields: { pulledSeq?: number; pushedSeq?: number; nowMs: number },
): void {
  sqlite
    .prepare(
      `INSERT INTO sync_cursor (endpoint, pulled_seq, pushed_seq, updated_at)
         VALUES (?, COALESCE(?, 0), COALESCE(?, 0), ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         pulled_seq = COALESCE(excluded.pulled_seq, sync_cursor.pulled_seq),
         pushed_seq = COALESCE(excluded.pushed_seq, sync_cursor.pushed_seq),
         updated_at = excluded.updated_at`,
    )
    .run(endpoint, fields.pulledSeq ?? null, fields.pushedSeq ?? null, fields.nowMs);
}

// ─── note apply (raw SQL, never re-enters mutation funcs) ───────────

type ApplyOutcome = 'applied' | 'skipped';

/**
 * Apply one note ServerChange to the local sqlite.
 *
 * Bypasses `createNote` / `updateNote` etc. deliberately — those would
 * emit a new sync_changes row and create an echo loop. This writes
 * directly to `notes` via raw better-sqlite3.
 *
 * LWW: remote wins if and only if `remote.updated_at_ms > local.updated_at`
 * (tie = local wins). Delete is a special case: it removes the row when
 * local is older.
 *
 * Tags / FTS are intentionally not handled here — see design §7.5. The
 * logger receives a "skipped (P5-a)" line so the P5-b backfill has
 * something to grep for.
 */
function isSelfReplay(sqlite: Database.Database, cid: string): boolean {
  return (
    sqlite
      .prepare('SELECT 1 FROM sync_changes WHERE client_change_id = ? AND synced_at IS NOT NULL')
      .get(cid) !== undefined
  );
}

function readLocalUpdatedAt(sqlite: Database.Database, id: string): number | null {
  const row = sqlite.prepare('SELECT updated_at FROM notes WHERE id = ?').get(id) as
    | { updated_at: number }
    | undefined;
  return row ? row.updated_at : null;
}

function applyNoteCreate(
  sqlite: Database.Database,
  c: ServerChangeLike,
  body: Extract<NoteApplyPayload, { op: 'create' }>['body'],
  logger: RunSyncLogger,
): ApplyOutcome {
  // content_hash + device_id 全部由 apply 端派生（remote payload 不带 device，
  // 见 notes/index.ts:387 注释）。
  sqlite
    .prepare(
      `INSERT INTO notes (id, folder_id, trash_level, created_at, updated_at, content, content_hash, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         folder_id    = excluded.folder_id,
         trash_level  = excluded.trash_level,
         updated_at   = excluded.updated_at,
         content      = excluded.content,
         content_hash = excluded.content_hash,
         device_id    = excluded.device_id`,
    )
    .run(
      c.entityId,
      body.folder_id,
      body.trash_level,
      body.created_at_ms,
      body.updated_at_ms,
      body.content,
      contentHash(body.content),
      c.deviceId,
    );
  if (Array.isArray(body.tags) && body.tags.length > 0) {
    logger.info(
      `[sync] apply note ${c.entityId} create — tags field present in payload (size ${body.tags.length}), skipped (P5-a)`,
    );
  }
  return 'applied';
}

function applyNoteUpdate(
  sqlite: Database.Database,
  c: ServerChangeLike,
  body: Extract<NoteApplyPayload, { op: 'update' }>['body'],
  logger: RunSyncLogger,
): ApplyOutcome {
  const sets: string[] = ['updated_at = ?', 'device_id = ?'];
  const vals: unknown[] = [body.updated_at_ms, c.deviceId];
  if (body.content !== undefined) {
    sets.push('content = ?');
    vals.push(body.content);
    sets.push('content_hash = ?');
    vals.push(contentHash(body.content));
  }
  if (body.folder_id !== undefined) {
    sets.push('folder_id = ?');
    vals.push(body.folder_id);
  }
  vals.push(c.entityId);
  const r = sqlite
    .prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`)
    .run(...(vals as never[]));
  if (body.tags !== undefined) {
    const size = Array.isArray(body.tags) ? body.tags.length : 0;
    logger.info(
      `[sync] apply note ${c.entityId} update — tags field present in payload (size ${size}), skipped (P5-a)`,
    );
  }
  return r.changes > 0 ? 'applied' : 'skipped';
}

function applyNoteTrashOrRestore(
  sqlite: Database.Database,
  c: ServerChangeLike,
  body:
    | Extract<NoteApplyPayload, { op: 'trash' }>['body']
    | Extract<NoteApplyPayload, { op: 'restore' }>['body'],
): ApplyOutcome {
  const r = sqlite
    .prepare(
      `UPDATE notes
         SET trash_level    = ?,
             trashed_at     = ?,
             auto_delete_at = ?,
             updated_at     = ?,
             device_id      = ?
       WHERE id = ?`,
    )
    .run(
      body.trash_level,
      body.trashed_at_ms,
      body.auto_delete_at_ms ?? null,
      body.updated_at_ms,
      c.deviceId,
      c.entityId,
    );
  return r.changes > 0 ? 'applied' : 'skipped';
}

function applyNoteDelete(
  sqlite: Database.Database,
  c: ServerChangeLike,
  body: Extract<NoteApplyPayload, { op: 'delete' }>['body'],
  localTs: number,
  logger: RunSyncLogger,
): ApplyOutcome {
  if (localTs > body.updated_at_ms) {
    logger.info(
      `[sync] apply note ${c.entityId} delete — local newer (${localTs} > ${body.updated_at_ms}), skipped`,
    );
    return 'skipped';
  }
  const r = sqlite.prepare('DELETE FROM notes WHERE id = ?').run(c.entityId);
  return r.changes > 0 ? 'applied' : 'skipped';
}

function applyNoteChange(
  sqlite: Database.Database,
  c: ServerChangeLike,
  payload: NoteApplyPayload,
  logger: RunSyncLogger,
): ApplyOutcome {
  if (isSelfReplay(sqlite, c.clientChangeId)) return 'skipped';

  const localTsRaw = readLocalUpdatedAt(sqlite, c.entityId);
  const localExists = localTsRaw !== null;
  const localTs = localTsRaw ?? 0;
  const remoteTs = payload.body.updated_at_ms;

  if (payload.op === 'delete') {
    if (!localExists) return 'skipped'; // idempotent — already gone
    return applyNoteDelete(sqlite, c, payload.body, localTs, logger);
  }

  // update / trash / restore on missing local note → out-of-order, skip;
  // create on missing local falls through to INSERT.
  if (!localExists && payload.op !== 'create') {
    logger.info(
      `[sync] apply note ${c.entityId} ${payload.op} — local row missing, skipped (P5-a)`,
    );
    return 'skipped';
  }

  // LWW gate for ops touching an existing note (incl. create vs. dup id)
  if (localExists && localTs >= remoteTs) {
    logger.info(
      `[sync] apply note ${c.entityId} ${payload.op} — LWW skip (local=${localTs} >= remote=${remoteTs})`,
    );
    return 'skipped';
  }

  if (payload.op === 'create') return applyNoteCreate(sqlite, c, payload.body, logger);
  if (payload.op === 'update') return applyNoteUpdate(sqlite, c, payload.body, logger);
  return applyNoteTrashOrRestore(sqlite, c, payload.body);
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

// ─── per-pull-change router ─────────────────────────────────────────

function hasUpdatedAtMs(payload: unknown): payload is Record<string, unknown> {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'updated_at_ms' in payload
  );
}

function applyOneChange(
  sqlite: Database.Database,
  change: ServerChangeLike,
  logger: RunSyncLogger,
): ApplyOutcome {
  if (change.entityType !== 'note') {
    logger.info(
      `[sync] pull skip non-note entity type=${change.entityType} id=${change.entityId} seq=${change.serverSeq}`,
    );
    return 'skipped';
  }
  if (!hasUpdatedAtMs(change.payload)) {
    // metadata op (pin / reorder) — apply is out of P5-a scope
    logger.info(
      `[sync] pull skip note metadata op (no updated_at_ms) id=${change.entityId} op=${change.op} seq=${change.serverSeq}`,
    );
    return 'skipped';
  }
  // Validator throws NotePayloadInvalidError → rolls back the batch
  const parsed = parseNotePayload(change.op, change.payload);
  return applyNoteChange(sqlite, change, parsed, logger);
}

// ─── runSync ────────────────────────────────────────────────────────

const NOOP_LOGGER: RunSyncLogger = {
  info: () => {},
  warn: () => {},
};

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
  const { sqlite, client, workspaceId, serverUrl } = deps;
  const now = deps.nowMs ?? Date.now;
  const logger = deps.logger ?? NOOP_LOGGER;

  // ── Step 0: read cursor ────────────────────────────────────────
  const cursorRow = sqlite
    .prepare('SELECT pulled_seq FROM sync_cursor WHERE endpoint = ?')
    .get(serverUrl) as { pulled_seq: number } | undefined;
  const cursorBefore = cursorRow?.pulled_seq ?? 0;

  let cursor = cursorBefore;
  let pulledTotal = 0;
  let appliedTotal = 0;
  let skippedTotal = 0;

  // ── Step 1: pull loop ──────────────────────────────────────────
  // Each batch processed in a single sync transaction (better-sqlite3's
  // transactions are sync). Validator throws inside → batch rolls back,
  // outer await unwinds, cursor un-advanced.
  for (;;) {
    const pulled = await client.pullChanges(workspaceId, cursor);

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
      for (const change of pulled.changes) {
        const outcome = applyOneChange(sqlite, change, logger);
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

    const result = await client.pushChanges(workspaceId, localChanges);

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
  };
}

export { NotePayloadInvalidError };
