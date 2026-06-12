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
 */

import type Database from 'better-sqlite3';
import type { OwlDatabase } from '../db/index.js';
import { contentHash } from '../notes/hash.js';
import { syncNoteTags } from '../notes/tags.js';
import { syncReminders } from '../reminders/index.js';
import type { ParsedTag } from '../tags/parser.js';
import { readLocalDeviceUuid } from './changes.js';
import { recordConflict } from './conflicts.js';
import { observeRemoteLwwKey, setServerTimeOffset } from './hlc.js';
import {
  type ConversationApplyPayload,
  ConversationPayloadInvalidError,
  parseConversationPayload,
} from './payloads/conversation.js';
import {
  type FolderApplyPayload,
  FolderPayloadInvalidError,
  parseFolderPayload,
} from './payloads/folder.js';
import {
  type NoteApplyPayload,
  NotePayloadInvalidError,
  type NoteTag,
  parseNotePayload,
} from './payloads/note.js';
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

export interface RunSyncLogger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
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
 * LWW (W3): the key is the three-tuple `(updated_at_ms, lww_counter,
 * device_id)`. Remote wins iff it strictly outranks local under `cmpLww`;
 * a full tie (same ms+counter+device) keeps local (idempotent / self-replay
 * safety). Delete is a special case: it removes the row unless local is
 * strictly newer.
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

// ─── W3 three-tuple LWW key (updated_at_ms, lww_counter, device_id) ──────

interface LwwKey {
  ms: number;
  counter: number;
  deviceId: string;
}

/** Total order over (ms, counter, deviceId): <0 means a<b, 0 equal, >0 a>b. */
function cmpLww(a: LwwKey, b: LwwKey): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return 0;
}

/**
 * Remote LWW key from a ServerChange + its parsed body. `lww_counter` is
 * absent on pre-W3 / 0.1.3-era payloads → 0 (degrades to ms + deviceId).
 * `deviceId` comes from the wire (always a non-empty string).
 */
function remoteLwwKey(
  c: ServerChangeLike,
  body: { updated_at_ms: number; lww_counter?: number },
): LwwKey {
  return { ms: body.updated_at_ms, counter: body.lww_counter ?? 0, deviceId: c.deviceId };
}

function readLocalNoteLwwKey(sqlite: Database.Database, id: string): LwwKey | null {
  const row = sqlite
    .prepare('SELECT updated_at, lww_counter, device_id FROM notes WHERE id = ?')
    .get(id) as { updated_at: number; lww_counter: number; device_id: string | null } | undefined;
  // device_id is nullable → '' so the tuple stays totally ordered; the wire's
  // remote deviceId is always non-empty, so '' sorts a NULL-device local row first.
  return row
    ? { ms: row.updated_at, counter: row.lww_counter, deviceId: row.device_id ?? '' }
    : null;
}

/**
 * P5-c §6.16: detection-time snapshot of the losing local note. Read just the
 * fields we want to render in the GUI "副本" panel.
 */
function readLocalNoteSnapshot(
  sqlite: Database.Database,
  id: string,
): { content: string; updated_at_ms: number } | null {
  const row = sqlite.prepare('SELECT content, updated_at FROM notes WHERE id = ?').get(id) as
    | { content: string; updated_at: number }
    | undefined;
  return row ? { content: row.content, updated_at_ms: row.updated_at } : null;
}

/**
 * P5-c §6.19: counts conflict_record rows written by a runSync batch.
 * Threaded through applyOneChange → applyNoteChange so runSync can return
 * `conflictsRecorded` without re-querying sqlite.
 */
export interface ConflictSink {
  count: number;
  /** Override `Date.now()` for deterministic tests. */
  nowMs?: () => number;
}

/**
 * Map a payload `NoteTag[]` (snake_case wire shape, P5-b validated against
 * the parser.ts enum) into the `ParsedTag[]` shape `syncNoteTags` consumes.
 * `tag_value: null` collapses to `''` to satisfy ParsedTag's non-null
 * field; downstream `notes_fts.tags_text` already filters by tag_type so
 * empty values for `/alarm` etc. don't pollute search.
 */
function payloadTagsToParsed(tags: readonly NoteTag[]): ParsedTag[] {
  return tags.map((t) => ({ tagType: t.tag_type, tagValue: t.tag_value ?? '' }));
}

function applyNoteCreate(
  db: OwlDatabase,
  sqlite: Database.Database,
  c: ServerChangeLike,
  body: Extract<NoteApplyPayload, { op: 'create' }>['body'],
): ApplyOutcome {
  // content_hash + device_id 全部由 apply 端派生（remote payload 不带 device，
  // 见 notes/index.ts:387 注释）。
  // P5-b: local_device_uuid 永远绑本机；device_id 写 ServerChange.deviceId（远端来源）。
  const localUuid = readLocalDeviceUuid(sqlite);
  sqlite
    .prepare(
      `INSERT INTO notes (id, folder_id, trash_level, created_at, updated_at,
                          content, content_hash, device_id, local_device_uuid, lww_counter)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         folder_id         = excluded.folder_id,
         trash_level       = excluded.trash_level,
         updated_at        = excluded.updated_at,
         content           = excluded.content,
         content_hash      = excluded.content_hash,
         device_id         = excluded.device_id,
         local_device_uuid = excluded.local_device_uuid,
         lww_counter       = excluded.lww_counter`,
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
      localUuid,
      body.lww_counter ?? 0,
    );
  // P5-b §5.3: tags / FTS / reminder_status apply for real now.
  syncNoteTags(db, sqlite, c.entityId, payloadTagsToParsed(body.tags));
  syncReminders(db, sqlite, c.entityId);
  return 'applied';
}

function applyNoteUpdate(
  db: OwlDatabase,
  sqlite: Database.Database,
  c: ServerChangeLike,
  body: Extract<NoteApplyPayload, { op: 'update' }>['body'],
): ApplyOutcome {
  // P5-b: apply 行 local_device_uuid 永远绑本机；device_id 写远端来源。
  // W3: persist the remote lww_counter so a later local edit advances past it.
  const sets: string[] = [
    'updated_at = ?',
    'device_id = ?',
    'local_device_uuid = ?',
    'lww_counter = ?',
  ];
  const vals: unknown[] = [
    body.updated_at_ms,
    c.deviceId,
    readLocalDeviceUuid(sqlite),
    body.lww_counter ?? 0,
  ];
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
  // P5-b §5.3: sparse update — only touch tag relations when payload carries `tags`.
  if (body.tags !== undefined && r.changes > 0) {
    syncNoteTags(db, sqlite, c.entityId, payloadTagsToParsed(body.tags));
    syncReminders(db, sqlite, c.entityId);
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
             device_id      = ?,
             lww_counter    = ?
       WHERE id = ?`,
    )
    .run(
      body.trash_level,
      body.trashed_at_ms,
      body.auto_delete_at_ms ?? null,
      body.updated_at_ms,
      c.deviceId,
      body.lww_counter ?? 0,
      c.entityId,
    );
  return r.changes > 0 ? 'applied' : 'skipped';
}

function applyNoteDelete(
  sqlite: Database.Database,
  c: ServerChangeLike,
  localKey: LwwKey,
  remoteKey: LwwKey,
  logger: RunSyncLogger,
): ApplyOutcome {
  // Local strictly newer (three-tuple) → keep the row; tie or older → delete.
  if (cmpLww(localKey, remoteKey) > 0) {
    logger.info(
      `[sync] apply note ${c.entityId} delete — local newer (${localKey.ms}/${localKey.counter} > ${remoteKey.ms}/${remoteKey.counter}), skipped`,
    );
    return 'skipped';
  }
  const r = sqlite.prepare('DELETE FROM notes WHERE id = ?').run(c.entityId);
  return r.changes > 0 ? 'applied' : 'skipped';
}

/**
 * P5-c §6.16: detection hook. Caller guarantees `payload.op === 'update'`,
 * `localExists`, and `localTs < remoteTs` (LWW-loser local) — i.e. the call
 * site has already filtered out self-replay / missing-local / LWW-tie /
 * non-update ops. We only need to gate on "payload carries content" and
 * "content differs from local".
 */
function maybeRecordNoteConflict(
  sqlite: Database.Database,
  c: ServerChangeLike,
  body: Extract<NoteApplyPayload, { op: 'update' }>['body'],
  localTs: number,
  remoteTs: number,
  conflictSink: ConflictSink,
): void {
  if (body.content === undefined) return;
  const localSnap = readLocalNoteSnapshot(sqlite, c.entityId);
  if (!localSnap || localSnap.content === body.content) return;
  // P5-c follow-up #2: only "B actually edited X locally" counts as a
  // real conflict; a fresh bootstrap that replays remote history hits
  // this code path on every legacy update op (note already has
  // newer-arrival content from the create row) and shouldn't drown the
  // sidebar in 红点 noise. sync_changes only ever receives rows from
  // local mutations (engine apply does NOT touch the table), so its
  // presence is exactly the "did B touch X" signal we want.
  const hasLocalEdit = sqlite
    .prepare(
      `SELECT 1 FROM sync_changes
        WHERE entity_type = 'note' AND entity_id = ?
        LIMIT 1`,
    )
    .get(c.entityId) as { 1: number } | undefined;
  if (!hasLocalEdit) return;
  const now = conflictSink.nowMs ?? Date.now;
  recordConflict(sqlite, {
    entityType: 'note',
    entityId: c.entityId,
    losingSide: 'local',
    localPayload: localSnap,
    remotePayload: body,
    localUpdatedAtMs: localTs,
    remoteUpdatedAtMs: remoteTs,
    remoteSeq: c.serverSeq,
    nowMs: now(),
  });
  conflictSink.count += 1;
}

function applyNoteChange(
  db: OwlDatabase,
  sqlite: Database.Database,
  c: ServerChangeLike,
  payload: NoteApplyPayload,
  logger: RunSyncLogger,
  conflictSink?: ConflictSink,
): ApplyOutcome {
  if (isSelfReplay(sqlite, c.clientChangeId)) return 'skipped';

  const localKeyRaw = readLocalNoteLwwKey(sqlite, c.entityId);
  const localExists = localKeyRaw !== null;
  const localKey = localKeyRaw ?? { ms: 0, counter: 0, deviceId: '' };
  const remoteKey = remoteLwwKey(c, payload.body);

  if (payload.op === 'delete') {
    if (!localExists) return 'skipped'; // idempotent — already gone
    return applyNoteDelete(sqlite, c, localKey, remoteKey, logger);
  }

  // update / trash / restore on missing local note → out-of-order, skip;
  // create on missing local falls through to INSERT.
  if (!localExists && payload.op !== 'create') {
    logger.info(
      `[sync] apply note ${c.entityId} ${payload.op} — local row missing, skipped (P5-a)`,
    );
    return 'skipped';
  }

  // W3 three-tuple LWW gate: remote must strictly outrank local
  // (tie or older → skip; equal → idempotent self-replay safety).
  if (localExists && cmpLww(remoteKey, localKey) <= 0) {
    logger.info(
      `[sync] apply note ${c.entityId} ${payload.op} — LWW skip (local=${localKey.ms}/${localKey.counter} >= remote=${remoteKey.ms}/${remoteKey.counter})`,
    );
    return 'skipped';
  }

  // P5-c §6.16: conflict detection runs before applyNoteUpdate overwrites
  // the losing local row. Other ops (create / trash / restore) skip the hook.
  // conflict_record still stores bare ms (counter columns deferred, plan §4.1).
  if (conflictSink && payload.op === 'update' && localExists) {
    maybeRecordNoteConflict(sqlite, c, payload.body, localKey.ms, remoteKey.ms, conflictSink);
  }

  if (payload.op === 'create') return applyNoteCreate(db, sqlite, c, payload.body);
  if (payload.op === 'update') return applyNoteUpdate(db, sqlite, c, payload.body);
  return applyNoteTrashOrRestore(sqlite, c, payload.body);
}

// ─── folder apply (P5-b §4.4) ───────────────────────────────────────

function readLocalFolderLwwKey(sqlite: Database.Database, id: string): LwwKey | null {
  const row = sqlite
    .prepare('SELECT updated_at, lww_counter, device_id FROM folders WHERE id = ?')
    .get(id) as { updated_at: number; lww_counter: number; device_id: string | null } | undefined;
  return row
    ? { ms: row.updated_at, counter: row.lww_counter, deviceId: row.device_id ?? '' }
    : null;
}

function applyFolderCreate(
  sqlite: Database.Database,
  c: ServerChangeLike,
  body: Extract<FolderApplyPayload, { op: 'create' }>['body'],
): ApplyOutcome {
  const localUuid = readLocalDeviceUuid(sqlite);
  sqlite
    .prepare(
      `INSERT INTO folders (id, name, parent_id, position, created_at, updated_at,
                            device_id, local_device_uuid, lww_counter)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name              = excluded.name,
         parent_id         = excluded.parent_id,
         position          = excluded.position,
         updated_at        = excluded.updated_at,
         device_id         = excluded.device_id,
         local_device_uuid = excluded.local_device_uuid,
         lww_counter       = excluded.lww_counter`,
    )
    .run(
      c.entityId,
      body.name,
      body.parent_id,
      body.position,
      body.created_at_ms,
      body.updated_at_ms,
      c.deviceId,
      localUuid,
      body.lww_counter ?? 0,
    );
  return 'applied';
}

function applyFolderUpdate(
  sqlite: Database.Database,
  c: ServerChangeLike,
  body: Extract<FolderApplyPayload, { op: 'update' }>['body'],
): ApplyOutcome {
  // P5-b §4.4: sparse update — only touch the columns the caller asked to
  // change, otherwise an absent `parent_id` would clobber the existing
  // parent with NULL via an integer-style upsert.
  const sets: string[] = [
    'updated_at = ?',
    'device_id = ?',
    'local_device_uuid = ?',
    'lww_counter = ?',
  ];
  const vals: unknown[] = [
    body.updated_at_ms,
    c.deviceId,
    readLocalDeviceUuid(sqlite),
    body.lww_counter ?? 0,
  ];
  if (body.name !== undefined) {
    sets.push('name = ?');
    vals.push(body.name);
  }
  if (body.parent_id !== undefined) {
    sets.push('parent_id = ?');
    vals.push(body.parent_id);
  }
  if (body.position !== undefined) {
    sets.push('position = ?');
    vals.push(body.position);
  }
  vals.push(c.entityId);
  const r = sqlite
    .prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`)
    .run(...(vals as never[]));
  return r.changes > 0 ? 'applied' : 'skipped';
}

function applyFolderDelete(
  sqlite: Database.Database,
  c: ServerChangeLike,
  localKey: LwwKey,
  remoteKey: LwwKey,
  logger: RunSyncLogger,
): ApplyOutcome {
  if (cmpLww(localKey, remoteKey) > 0) {
    logger.info(
      `[sync] apply folder ${c.entityId} delete — local newer (${localKey.ms}/${localKey.counter} > ${remoteKey.ms}/${remoteKey.counter}), skipped`,
    );
    return 'skipped';
  }
  const r = sqlite.prepare('DELETE FROM folders WHERE id = ?').run(c.entityId);
  return r.changes > 0 ? 'applied' : 'skipped';
}

function applyFolderChange(
  sqlite: Database.Database,
  c: ServerChangeLike,
  payload: FolderApplyPayload,
  logger: RunSyncLogger,
): ApplyOutcome {
  if (isSelfReplay(sqlite, c.clientChangeId)) return 'skipped';

  const localKeyRaw = readLocalFolderLwwKey(sqlite, c.entityId);
  const localExists = localKeyRaw !== null;
  const localKey = localKeyRaw ?? { ms: 0, counter: 0, deviceId: '' };
  const remoteKey = remoteLwwKey(c, payload.body);

  if (payload.op === 'delete') {
    if (!localExists) return 'skipped';
    return applyFolderDelete(sqlite, c, localKey, remoteKey, logger);
  }

  if (!localExists && payload.op !== 'create') {
    logger.info(`[sync] apply folder ${c.entityId} ${payload.op} — local row missing, skipped`);
    return 'skipped';
  }

  if (localExists && cmpLww(remoteKey, localKey) <= 0) {
    logger.info(
      `[sync] apply folder ${c.entityId} ${payload.op} — LWW skip (local=${localKey.ms}/${localKey.counter} >= remote=${remoteKey.ms}/${remoteKey.counter})`,
    );
    return 'skipped';
  }

  if (payload.op === 'create') return applyFolderCreate(sqlite, c, payload.body);
  return applyFolderUpdate(sqlite, c, payload.body);
}

// ─── conversation apply (P5-b §4.6) ─────────────────────────────────

function applyConversationAppend(
  sqlite: Database.Database,
  c: ServerChangeLike,
  body: Extract<ConversationApplyPayload, { op: 'append' }>['body'],
): ApplyOutcome {
  // First append carries title + created_at_ms; subsequent appends don't.
  // ai_conversations: insert if missing, otherwise just bump updated_at.
  const existing = sqlite
    .prepare('SELECT 1 AS one FROM ai_conversations WHERE id = ?')
    .get(c.entityId) as { one: number } | undefined;
  if (!existing) {
    const title = body.title ?? '新对话';
    const createdAt = body.created_at_ms ?? body.applied_at_ms;
    sqlite
      .prepare(
        'INSERT INTO ai_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(c.entityId, title, createdAt, body.applied_at_ms);
  } else {
    sqlite
      .prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?')
      .run(body.applied_at_ms, c.entityId);
  }

  // Append the messages at the tail. seq continues from the local max so
  // mixed origins from multiple devices keep their server_seq ordering;
  // P5-b §4.6 explicitly does not deduplicate message rows.
  const seqRow = sqlite
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM ai_messages WHERE conversation_id = ?')
    .get(c.entityId) as { m: number };
  let seq = seqRow.m;
  const insert = sqlite.prepare(
    `INSERT INTO ai_messages
        (id, conversation_id, role, content, tool_calls, tool_call_id,
         is_error, reasoning_content, reasoning_signature, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of body.messages) {
    seq += 1;
    insert.run(
      cryptoRandomId(),
      c.entityId,
      m.role,
      m.content,
      m.tool_calls,
      m.tool_call_id,
      m.is_error,
      m.reasoning_content,
      m.reasoning_signature,
      body.applied_at_ms,
      seq,
    );
  }
  return 'applied';
}

function applyConversationDelete(sqlite: Database.Database, c: ServerChangeLike): ApplyOutcome {
  const r = sqlite.prepare('DELETE FROM ai_conversations WHERE id = ?').run(c.entityId);
  return r.changes > 0 ? 'applied' : 'skipped';
}

function applyConversationChange(
  sqlite: Database.Database,
  c: ServerChangeLike,
  payload: ConversationApplyPayload,
): ApplyOutcome {
  if (isSelfReplay(sqlite, c.clientChangeId)) return 'skipped';
  if (payload.op === 'delete') return applyConversationDelete(sqlite, c);
  return applyConversationAppend(sqlite, c, payload.body);
}

/**
 * Crypto-random 32-char hex id for `ai_messages.id`. Lazy import so the
 * core build doesn't pull node:crypto into bundlers that flag it.
 */
function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
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
  db: OwlDatabase,
  sqlite: Database.Database,
  change: ServerChangeLike,
  logger: RunSyncLogger,
  conflictSink?: ConflictSink,
): ApplyOutcome {
  switch (change.entityType) {
    case 'note':
      return applyOneNoteChange(db, sqlite, change, logger, conflictSink);
    case 'folder':
      return applyOneFolderChange(sqlite, change, logger);
    case 'conversation':
      // conversation/delete carries no updated_at_ms (intentionally — append-only
      // entity, ordering is by server_seq). conversation/append carries
      // `applied_at_ms` instead. Both are fine; we don't gate on updated_at_ms here.
      return applyOneConversationChange(sqlite, change);
    default:
      logger.info(
        `[sync] pull skip unknown entity type=${change.entityType} id=${change.entityId} seq=${change.serverSeq}`,
      );
      return 'skipped';
  }
}

function applyOneNoteChange(
  db: OwlDatabase,
  sqlite: Database.Database,
  change: ServerChangeLike,
  logger: RunSyncLogger,
  conflictSink?: ConflictSink,
): ApplyOutcome {
  if (!hasUpdatedAtMs(change.payload)) {
    // metadata op (pin / reorder) — apply is out of P5-b scope
    logger.info(
      `[sync] pull skip note metadata op (no updated_at_ms) id=${change.entityId} op=${change.op} seq=${change.serverSeq}`,
    );
    return 'skipped';
  }
  // Validator throws NotePayloadInvalidError → rolls back the batch
  const parsed = parseNotePayload(change.op, change.payload);
  // W3: advance local HLC past every validated remote stamp we observe, so
  // the next local write outranks it — whether this op applies or LWW-skips.
  observeRemoteLwwKey(sqlite, {
    ms: parsed.body.updated_at_ms,
    counter: parsed.body.lww_counter ?? 0,
  });
  return applyNoteChange(db, sqlite, change, parsed, logger, conflictSink);
}

function applyOneFolderChange(
  sqlite: Database.Database,
  change: ServerChangeLike,
  logger: RunSyncLogger,
): ApplyOutcome {
  if (!hasUpdatedAtMs(change.payload)) {
    // Folder reorder rows go through op='update' but don't include
    // updated_at_ms in some legacy paths; defensive skip mirrors note path.
    logger.info(
      `[sync] pull skip folder metadata op (no updated_at_ms) id=${change.entityId} op=${change.op} seq=${change.serverSeq}`,
    );
    return 'skipped';
  }
  // Validator throws FolderPayloadInvalidError → rolls back the batch
  const parsed = parseFolderPayload(change.op, change.payload);
  // W3: observe remote stamp to advance local HLC (see note path).
  observeRemoteLwwKey(sqlite, {
    ms: parsed.body.updated_at_ms,
    counter: parsed.body.lww_counter ?? 0,
  });
  return applyFolderChange(sqlite, change, parsed, logger);
}

function applyOneConversationChange(
  sqlite: Database.Database,
  change: ServerChangeLike,
): ApplyOutcome {
  // Validator throws ConversationPayloadInvalidError → rolls back the batch
  const parsed = parseConversationPayload(change.op, change.payload);
  return applyConversationChange(sqlite, change, parsed);
}

// ─── runSync ────────────────────────────────────────────────────────

const NOOP_LOGGER: RunSyncLogger = {
  info: () => {},
  warn: () => {},
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

export { ConversationPayloadInvalidError, FolderPayloadInvalidError, NotePayloadInvalidError };
