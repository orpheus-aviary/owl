/**
 * Apply-side runtime validator for note sync payloads (P5-a Step 4b).
 *
 * Five content ops only — create / update / trash / restore / delete.
 * `pin` and reorder-shape `update` payloads MUST be screened out by the
 * caller before invoking `parseNotePayload`; they don't carry
 * `updated_at_ms` (metadata ops don't touch notes.updated_at) and would
 * be rejected here. The caller's §3.1 rule:
 *
 *   if (entity_type !== 'note')          → skip + log
 *   if (!('updated_at_ms' in payload))   → skip + log  (metadata op)
 *   else                                  → parseNotePayload(op, payload)
 *
 * No third-party schema lib. Hand-written narrow functions keep the core
 * package's dep surface small and let validation errors carry op-specific
 * context.
 *
 * Field names mirror the actual emit payloads in
 * `packages/core/src/notes/index.ts` — see design doc §3.3 / §6.4.
 */

import { TAG_TYPES, type TagType } from '../../tags/parser.js';

export interface NoteTag {
  /** P5-b §4.2: collapse to the parser's enum so apply path can call syncNoteTags directly. */
  tag_type: TagType;
  tag_value: string | null;
}

export interface NoteCreatePayload {
  content: string;
  folder_id: string | null;
  trash_level: number;
  created_at_ms: number;
  updated_at_ms: number;
  tags: NoteTag[];
  /** W3 (Phase 16c): per-device LWW counter. Absent on pre-W3 / 0.1.3-era payloads. */
  lww_counter?: number;
}

/** Sparse post-state: only the fields that actually changed appear. */
export interface NoteUpdatePayload {
  updated_at_ms: number;
  content?: string;
  folder_id?: string | null;
  tags?: NoteTag[];
  lww_counter?: number;
}

export interface NoteTrashPayload {
  updated_at_ms: number;
  trash_level: number;
  trashed_at_ms: number;
  auto_delete_at_ms: number | null;
  lww_counter?: number;
}

export interface NoteRestorePayload {
  updated_at_ms: number;
  trash_level: number;
  trashed_at_ms: number | null;
  /** Restore always clears auto_delete_at; null is the only legal value. */
  auto_delete_at_ms: null;
  lww_counter?: number;
}

export interface NoteDeletePayload {
  updated_at_ms: number;
  lww_counter?: number;
}

export type NoteApplyPayload =
  | { op: 'create'; body: NoteCreatePayload }
  | { op: 'update'; body: NoteUpdatePayload }
  | { op: 'trash'; body: NoteTrashPayload }
  | { op: 'restore'; body: NoteRestorePayload }
  | { op: 'delete'; body: NoteDeletePayload };

export class NotePayloadInvalidError extends Error {
  constructor(
    public readonly op: string,
    public readonly reason: string,
    public readonly raw: unknown,
  ) {
    super(`note payload invalid for op=${op}: ${reason}`);
    this.name = 'NotePayloadInvalidError';
  }
}

const NOTE_APPLY_OPS = new Set(['create', 'update', 'trash', 'restore', 'delete'] as const);

// ─── narrow helpers ──────────────────────────────────────────────────────

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function fail(op: string, reason: string, raw: unknown): never {
  throw new NotePayloadInvalidError(op, reason, raw);
}

function requireNumber(
  op: string,
  raw: unknown,
  obj: Record<string, unknown>,
  key: string,
): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(op, `${key} must be a finite number, got ${typeof v}`, raw);
  }
  return v;
}

function requireString(
  op: string,
  raw: unknown,
  obj: Record<string, unknown>,
  key: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string') fail(op, `${key} must be a string, got ${typeof v}`, raw);
  return v;
}

function requireNullableString(
  op: string,
  raw: unknown,
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  if (v === null) return null;
  if (typeof v !== 'string') {
    fail(op, `${key} must be a string or null, got ${typeof v}`, raw);
  }
  return v;
}

function requireNullableNumber(
  op: string,
  raw: unknown,
  obj: Record<string, unknown>,
  key: string,
): number | null {
  const v = obj[key];
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(op, `${key} must be a finite number or null, got ${typeof v}`, raw);
  }
  return v;
}

/**
 * W3 (Phase 16c): sparse numeric field. Returns `undefined` when the key is
 * absent (pre-W3 payloads); throws when present but not a finite number, so a
 * round-trip never silently drops `lww_counter`.
 */
function optionalNumber(
  op: string,
  raw: unknown,
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  if (!(key in obj)) return undefined;
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(op, `${key} must be a finite number when present, got ${typeof v}`, raw);
  }
  return v;
}

function requireTagsArray(
  op: string,
  raw: unknown,
  obj: Record<string, unknown>,
  key: string,
): NoteTag[] {
  const v = obj[key];
  if (!Array.isArray(v)) fail(op, `${key} must be an array of tags`, raw);
  return v.map((t, i) => parseTag(op, raw, t, `${key}[${i}]`));
}

function parseTag(op: string, raw: unknown, t: unknown, path: string): NoteTag {
  if (!isObject(t)) fail(op, `${path} must be an object`, raw);
  const tag_type_raw = requireString(op, raw, t, 'tag_type');
  if (!(TAG_TYPES as readonly string[]).includes(tag_type_raw)) {
    fail(op, `${path}.tag_type ${JSON.stringify(tag_type_raw)} not in TAG_TYPES`, raw);
  }
  const tag_value = requireNullableString(op, raw, t, 'tag_value');
  return { tag_type: tag_type_raw as TagType, tag_value };
}

// ─── per-op parsers ──────────────────────────────────────────────────────

function parseCreate(raw: unknown, obj: Record<string, unknown>): NoteCreatePayload {
  return {
    content: requireString('create', raw, obj, 'content'),
    folder_id: requireNullableString('create', raw, obj, 'folder_id'),
    trash_level: requireNumber('create', raw, obj, 'trash_level'),
    created_at_ms: requireNumber('create', raw, obj, 'created_at_ms'),
    updated_at_ms: requireNumber('create', raw, obj, 'updated_at_ms'),
    tags: requireTagsArray('create', raw, obj, 'tags'),
    lww_counter: optionalNumber('create', raw, obj, 'lww_counter'),
  };
}

function parseUpdate(raw: unknown, obj: Record<string, unknown>): NoteUpdatePayload {
  // updated_at_ms is required; everything else is sparse — verify type only if present.
  const out: NoteUpdatePayload = {
    updated_at_ms: requireNumber('update', raw, obj, 'updated_at_ms'),
  };
  if ('content' in obj) out.content = requireString('update', raw, obj, 'content');
  if ('folder_id' in obj) out.folder_id = requireNullableString('update', raw, obj, 'folder_id');
  if ('tags' in obj) out.tags = requireTagsArray('update', raw, obj, 'tags');
  if ('lww_counter' in obj) out.lww_counter = optionalNumber('update', raw, obj, 'lww_counter');
  return out;
}

function parseTrash(raw: unknown, obj: Record<string, unknown>): NoteTrashPayload {
  return {
    updated_at_ms: requireNumber('trash', raw, obj, 'updated_at_ms'),
    trash_level: requireNumber('trash', raw, obj, 'trash_level'),
    trashed_at_ms: requireNumber('trash', raw, obj, 'trashed_at_ms'),
    auto_delete_at_ms: requireNullableNumber('trash', raw, obj, 'auto_delete_at_ms'),
    lww_counter: optionalNumber('trash', raw, obj, 'lww_counter'),
  };
}

function parseRestore(raw: unknown, obj: Record<string, unknown>): NoteRestorePayload {
  const auto_delete_at_ms = requireNullableNumber('restore', raw, obj, 'auto_delete_at_ms');
  if (auto_delete_at_ms !== null) {
    fail('restore', 'auto_delete_at_ms must be null on restore', raw);
  }
  return {
    updated_at_ms: requireNumber('restore', raw, obj, 'updated_at_ms'),
    trash_level: requireNumber('restore', raw, obj, 'trash_level'),
    trashed_at_ms: requireNullableNumber('restore', raw, obj, 'trashed_at_ms'),
    auto_delete_at_ms: null,
    lww_counter: optionalNumber('restore', raw, obj, 'lww_counter'),
  };
}

function parseDelete(raw: unknown, obj: Record<string, unknown>): NoteDeletePayload {
  // delete carries only updated_at_ms (Step 0b shape) + optional W3 lww_counter.
  return {
    updated_at_ms: requireNumber('delete', raw, obj, 'updated_at_ms'),
    lww_counter: optionalNumber('delete', raw, obj, 'lww_counter'),
  };
}

// ─── public entry ────────────────────────────────────────────────────────

/**
 * Narrow + validate a raw note payload to its discriminated-union shape.
 *
 * Throws `NotePayloadInvalidError` if:
 *  - op is not one of the 5 content ops (pin / reorder must be screened
 *    out by the caller per §3.1)
 *  - payload is not an object
 *  - any required field is missing or has the wrong type
 *  - restore.auto_delete_at_ms is not null
 *
 * Caller (runSync) handles the throw: roll back the entire pull batch,
 * leave cursor un-advanced, surface the error.
 */
export function parseNotePayload(op: string, raw: unknown): NoteApplyPayload {
  if (!(NOTE_APPLY_OPS as ReadonlySet<string>).has(op)) {
    throw new NotePayloadInvalidError(
      op,
      'op must be one of create / update / trash / restore / delete (caller should screen out pin / reorder)',
      raw,
    );
  }
  if (!isObject(raw)) {
    throw new NotePayloadInvalidError(op, 'payload must be a JSON object', raw);
  }
  switch (op) {
    case 'create':
      return { op: 'create', body: parseCreate(raw, raw) };
    case 'update':
      return { op: 'update', body: parseUpdate(raw, raw) };
    case 'trash':
      return { op: 'trash', body: parseTrash(raw, raw) };
    case 'restore':
      return { op: 'restore', body: parseRestore(raw, raw) };
    case 'delete':
      return { op: 'delete', body: parseDelete(raw, raw) };
    default:
      // Unreachable thanks to NOTE_APPLY_OPS gate above; the switch's
      // exhaustiveness check is what makes TS happy.
      throw new NotePayloadInvalidError(op, 'unreachable', raw);
  }
}
