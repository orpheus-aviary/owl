// Pull-side apply: writes one validated ServerChange to local sqlite. Split out
// of engine.ts so it and lww.ts each stay under the 800-line limit. `runSync`
// (engine.ts) calls the single entry point `applyOneChange`.
//
// These functions bypass createNote / updateNote etc. deliberately — those
// would emit a new sync_changes row and create an echo loop. They write
// directly to the tables via raw better-sqlite3.
//
// LWW (W3): the key is the three-tuple `(updated_at_ms, lww_counter, device_id)`.
// Remote wins iff it strictly outranks local under `cmpLww`; a full tie keeps
// local (idempotent / self-replay safety). Delete removes the row unless local
// is strictly newer.

import type Database from 'better-sqlite3';
import type { OwlDatabase } from '../db/index.js';
import { contentHash } from '../notes/hash.js';
import { syncNoteTags } from '../notes/tags.js';
import { syncReminders } from '../reminders/index.js';
import { readLocalDeviceUuid } from './changes.js';
import { recordConflict } from './conflicts.js';
import type { RunSyncLogger, ServerChangeLike } from './engine.js';
import { observeRemoteLwwKey } from './hlc.js';
import {
  type ApplyOutcome,
  type ConflictSink,
  type LwwKey,
  cmpLww,
  isSelfReplay,
  payloadTagsToParsed,
  readLocalFolderLwwKey,
  readLocalNoteLwwKey,
  readLocalNoteSnapshot,
} from './lww.js';
import {
  type ConversationApplyPayload,
  parseConversationPayload,
} from './payloads/conversation.js';
import { type FolderApplyPayload, parseFolderPayload } from './payloads/folder.js';
import { type NoteApplyPayload, parseNotePayload } from './payloads/note.js';

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

// ─── note apply (raw SQL, never re-enters mutation funcs) ───────────

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

// ─── per-pull-change router ─────────────────────────────────────────

function hasUpdatedAtMs(payload: unknown): payload is Record<string, unknown> {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'updated_at_ms' in payload
  );
}

export function applyOneChange(
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
