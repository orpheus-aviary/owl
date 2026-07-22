/**
 * P5-c §2.4 — `conflict_record` helper.
 *
 * Open-dispatch over `entity_type`: A-phase only emits `'note'`, but the
 * helper accepts arbitrary entity types so B/C阶段加 folder / conversation
 * 不需要 migration（设计 §6.15）。
 *
 * `losing_side` 当前固定 `'local'` —— A-phase 只在 LWW 输方=本地 + content !=
 * 时才记一行（设计 §6.16）。
 *
 * `ignoreConflict` 是软删（设计 §6.17）：UPDATE SET resolved_at + resolution,
 * **不 DELETE**。前向兼容 B-phase「已解决历史」需求。
 *
 * 调用方契约：所有写入都假设外层已经在 `sqlite.transaction(...)` 里，与 apply
 * 路径同 batch 提交。读路径不要事务（GUI 的 /conflicts list / count 请求）。
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { OwlDatabase } from '../db/index.js';
import { type NoteWithTags, updateNote } from '../notes/index.js';

export type ConflictLosingSide = 'local' | 'remote';

/**
 * How a `conflict_record` row was closed:
 *   - `ignored` — user dismissed the loser without touching the note (W7 未做前的唯一值)
 *   - `local`   — user overwrote the note with the local (losing) copy
 *   - `merged`  — user hand-merged in the ConflictMergeDialog
 */
export type ConflictResolution = 'ignored' | 'local' | 'merged';

export interface ConflictRecord {
  id: string;
  entity_type: string;
  entity_id: string;
  local_seq: number | null;
  remote_seq: number | null;
  detected_at: number;
  resolved_at: number | null;
  resolution: string | null;
  losing_side: string | null;
  local_payload: string | null;
  remote_payload: string | null;
  local_updated_at_ms: number | null;
  remote_updated_at_ms: number | null;
}

export interface RecordConflictArgs {
  entityType: string;
  entityId: string;
  losingSide: ConflictLosingSide;
  localPayload: unknown;
  remotePayload: unknown;
  localUpdatedAtMs: number;
  remoteUpdatedAtMs: number;
  /** Override row id. Default `randomUUID()`. */
  id?: string;
  /** Override detected_at (Unix ms). Default `Date.now()`. */
  nowMs?: number;
  /** Optional sync_changes.local_seq cross-ref. */
  localSeq?: number | null;
  /** Optional server pull batch high-water mark. */
  remoteSeq?: number | null;
}

/**
 * Insert one conflict row. Returns the assigned id.
 *
 * Caller invariants (P5-c §6.16):
 *   - only call from `applyNoteChange` when op==='update' &&
 *     localTs < remoteTs && content differs;
 *   - never from create / delete / trash / restore / folder / conversation;
 *   - never from self-replay / LWW-skip / out-of-order paths.
 */
export function recordConflict(sqlite: Database.Database, args: RecordConflictArgs): string {
  const id = args.id ?? randomUUID();
  const detectedAt = args.nowMs ?? Date.now();
  sqlite
    .prepare(
      `INSERT INTO conflict_record
         (id, entity_type, entity_id, local_seq, remote_seq, detected_at,
          resolved_at, resolution,
          losing_side, local_payload, remote_payload,
          local_updated_at_ms, remote_updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.entityType,
      args.entityId,
      args.localSeq ?? null,
      args.remoteSeq ?? null,
      detectedAt,
      args.losingSide,
      JSON.stringify(args.localPayload),
      JSON.stringify(args.remotePayload),
      args.localUpdatedAtMs,
      args.remoteUpdatedAtMs,
    );
  return id;
}

/**
 * List unresolved conflict rows in detection order (newest first). Bounded
 * by `limit` so GUI list pages don't fetch unbounded history.
 */
export function listUnresolvedConflicts(
  sqlite: Database.Database,
  opts: { limit?: number } = {},
): ConflictRecord[] {
  const limit = opts.limit ?? 50;
  return sqlite
    .prepare(
      `SELECT id, entity_type, entity_id, local_seq, remote_seq,
              detected_at, resolved_at, resolution,
              losing_side, local_payload, remote_payload,
              local_updated_at_ms, remote_updated_at_ms
         FROM conflict_record
        WHERE resolved_at IS NULL
        ORDER BY detected_at DESC
        LIMIT ?`,
    )
    .all(limit) as ConflictRecord[];
}

/**
 * Count of unresolved conflict rows. Uses `idx_conflict_unresolved` partial
 * index for sidebar 红点 (cheap even with long history).
 */
export function countUnresolvedConflicts(sqlite: Database.Database): number {
  const row = sqlite
    .prepare('SELECT count(*) AS n FROM conflict_record WHERE resolved_at IS NULL')
    .get() as { n: number };
  return row.n;
}

/**
 * Soft-delete a conflict: stamp resolved_at + resolution='ignored'. The row
 * is **never DELETE**ed (设计 §6.17). Returns true iff a previously-unresolved
 * row was flipped (idempotent: second ignore is a no-op false).
 */
export function ignoreConflict(
  sqlite: Database.Database,
  id: string,
  opts: { nowMs?: number } = {},
): boolean {
  const nowMs = opts.nowMs ?? Date.now();
  const r = sqlite
    .prepare(
      `UPDATE conflict_record
          SET resolved_at = ?, resolution = 'ignored'
        WHERE id = ? AND resolved_at IS NULL`,
    )
    .run(nowMs, id);
  return r.changes > 0;
}

// ── W7: manual conflict resolution (用本地覆盖 / 合并) ──────────────────
//
// `resolveConflict` closes an unresolved row by writing the note through the
// normal `updateNote` CAS path (so it emits `sync_changes` and gets a fresh
// LWW stamp that wins network-wide). The daemon does pure request-shape
// validation, then calls this; core owns the whole transaction so daemon and
// core never double-count a rollback (设计 §3.4).

/** Thrown when the target `conflict_record` id does not exist → daemon 404. */
export class ConflictNotFound extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`conflict ${id} not found`);
    this.name = 'ConflictNotFound';
    this.id = id;
  }
}

/** Thrown when the conflict's `entity_id` note no longer exists → daemon 404. */
export class NoteNotFound extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`note ${id} not found`);
    this.name = 'NoteNotFound';
    this.id = id;
  }
}

/**
 * Thrown when the conflict row is not a note (folder/conversation etc.) →
 * daemon 422. Guards future entity types from being resolved through the
 * note-only write path.
 */
export class UnsupportedEntity extends Error {
  readonly entityType: string;
  constructor(entityType: string) {
    super(`conflict resolution not supported for entity_type '${entityType}'`);
    this.name = 'UnsupportedEntity';
    this.entityType = entityType;
  }
}

/**
 * Thrown when a stored `local_payload` can't yield a usable string content for
 * the `local` strategy (missing / not JSON / content not a string) → daemon 422.
 */
export class BadPayload extends Error {
  readonly id: string;
  constructor(id: string, detail: string) {
    super(`conflict ${id} has bad payload: ${detail}`);
    this.name = 'BadPayload';
    this.id = id;
  }
}

/**
 * W7 resolve arguments. `expectedUpdatedAtMs` is always required (CAS baseline,
 * D10) — even 用本地覆盖 must take the current note `updated_at` first so it
 * refuses to blind-write a note edited after the conflict was detected.
 */
export type ResolveConflictArgs =
  | { strategy: 'local'; expectedUpdatedAtMs: number; nowMs?: number }
  | { strategy: 'merged'; content: string; expectedUpdatedAtMs: number; nowMs?: number };

/**
 * Result of `resolveConflict`:
 *   - `{ resolved: true, note }`   — note written, row stamped resolved
 *   - `{ resolved: false, reason }` — row was already resolved (idempotent no-op)
 * Every other outcome (missing conflict/note, stale CAS, trashed, unsupported
 * entity, bad payload) throws a typed error the daemon maps to 404/409/422.
 */
export type ResolveConflictResult =
  | { resolved: true; note: NoteWithTags }
  | { resolved: false; reason: 'already_resolved' };

/**
 * Validate the conflict entity + pin the final note content *before*
 * preemption (so the content source can't be lost). Asserts `entity_type`
 * unconditionally so a future folder/conversation conflict can't sneak through
 * `merged` and have its `entity_id` treated as a note id. Throws
 * `UnsupportedEntity` / `BadPayload`.
 */
function pickResolvedContent(row: ConflictRecord, args: ResolveConflictArgs): string {
  if (row.entity_type !== 'note') throw new UnsupportedEntity(row.entity_type);
  if (args.strategy === 'merged') return args.content; // already string-validated by daemon (empty ok)

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.local_payload ?? 'null');
  } catch {
    throw new BadPayload(row.id, 'local_payload is not valid JSON');
  }
  const content = (parsed as { content?: unknown } | null)?.content;
  if (typeof content !== 'string')
    throw new BadPayload(row.id, 'local_payload.content is not a string');
  return content;
}

/**
 * Manually resolve one conflict. Core owns the entire outer transaction
 * (`.immediate()` write lock so the SELECT→UPDATE preemption can't lose a race
 * to `SQLITE_BUSY_SNAPSHOT` — 设计 §3.4 P2-b). Order is critical: preempt the
 * row *before* writing the note so that any write failure rolls back the
 * preemption too (better-sqlite3 unwinds the inner `updateNote` SAVEPOINT and
 * the outer transaction together on throw).
 */
export function resolveConflict(
  db: OwlDatabase,
  sqlite: Database.Database,
  id: string,
  args: ResolveConflictArgs,
): ResolveConflictResult {
  const nowMs = args.nowMs ?? Date.now();
  const run = sqlite.transaction((): ResolveConflictResult => {
    // 1. Load the row. Missing → 404; already resolved → idempotent no-op
    //    (nothing written yet, so committing this empty tx is correct).
    const row = sqlite.prepare('SELECT * FROM conflict_record WHERE id = ?').get(id) as
      | ConflictRecord
      | undefined;
    if (!row) throw new ConflictNotFound(id);
    if (row.resolved_at !== null) return { resolved: false, reason: 'already_resolved' };

    // 2. Validate entity + pin the final content before preemption.
    const finalContent = pickResolvedContent(row, args);

    // 3. Atomic preemption BEFORE writing the note. `changes === 0` means a
    //    concurrent resolve slipped in between step 1's SELECT and here →
    //    idempotent no-op (still nothing written).
    const preempt = sqlite
      .prepare(
        `UPDATE conflict_record
            SET resolved_at = ?, resolution = ?
          WHERE id = ? AND resolved_at IS NULL`,
      )
      .run(nowMs, args.strategy, id);
    if (preempt.changes === 0) return { resolved: false, reason: 'already_resolved' };

    // 4. Write the note (CAS + reject trashed). Any failure throws out of the
    //    transaction so better-sqlite3 rolls back the preemption too —
    //    otherwise the row would be marked resolved with the note unchanged.
    const updated = updateNote(
      db,
      sqlite,
      row.entity_id,
      { content: finalContent },
      { expectedUpdatedAt: args.expectedUpdatedAtMs, rejectIfTrashed: true },
    );
    if (updated === null) throw new NoteNotFound(row.entity_id);

    return { resolved: true, note: updated };
  });
  return run.immediate();
}
