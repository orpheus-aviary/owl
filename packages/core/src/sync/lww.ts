// LWW primitives + shared apply types for the sync engine. Split out of
// engine.ts so it and apply.ts each stay under the 800-line limit. Pure leaf:
// reads local rows via raw sqlite and depends on neither engine.ts nor apply.ts
// (so there's no import cycle — both of those import from here).

import type Database from 'better-sqlite3';
import type { ParsedTag } from '../tags/parser.js';
import type { NoteTag } from './payloads/note.js';

export type ApplyOutcome = 'applied' | 'skipped';

/** True when `cid` is our own already-synced write echoed back by the server (skip). */
export function isSelfReplay(sqlite: Database.Database, cid: string): boolean {
  return (
    sqlite
      .prepare('SELECT 1 FROM sync_changes WHERE client_change_id = ? AND synced_at IS NOT NULL')
      .get(cid) !== undefined
  );
}

// ─── W3 three-tuple LWW key (updated_at_ms, lww_counter, device_id) ──────

export interface LwwKey {
  ms: number;
  counter: number;
  deviceId: string;
}

/** Total order over (ms, counter, deviceId): <0 means a<b, 0 equal, >0 a>b. */
export function cmpLww(a: LwwKey, b: LwwKey): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return 0;
}

export function readLocalNoteLwwKey(sqlite: Database.Database, id: string): LwwKey | null {
  const row = sqlite
    .prepare('SELECT updated_at, lww_counter, device_id FROM notes WHERE id = ?')
    .get(id) as { updated_at: number; lww_counter: number; device_id: string | null } | undefined;
  // device_id is nullable → '' so the tuple stays totally ordered; the wire's
  // remote deviceId is always non-empty, so '' sorts a NULL-device local row first.
  return row
    ? { ms: row.updated_at, counter: row.lww_counter, deviceId: row.device_id ?? '' }
    : null;
}

export function readLocalFolderLwwKey(sqlite: Database.Database, id: string): LwwKey | null {
  const row = sqlite
    .prepare('SELECT updated_at, lww_counter, device_id FROM folders WHERE id = ?')
    .get(id) as { updated_at: number; lww_counter: number; device_id: string | null } | undefined;
  return row
    ? { ms: row.updated_at, counter: row.lww_counter, deviceId: row.device_id ?? '' }
    : null;
}

/**
 * P5-c §6.16: detection-time snapshot of the losing local note. Read just the
 * fields we want to render in the GUI "副本" panel.
 */
export function readLocalNoteSnapshot(
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
export function payloadTagsToParsed(tags: readonly NoteTag[]): ParsedTag[] {
  return tags.map((t) => ({ tagType: t.tag_type, tagValue: t.tag_value ?? '' }));
}
