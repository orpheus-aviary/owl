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

export type ConflictLosingSide = 'local' | 'remote';

export type ConflictResolution = 'ignored';

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
