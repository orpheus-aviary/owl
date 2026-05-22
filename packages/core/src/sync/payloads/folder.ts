/**
 * Apply-side runtime validator for folder sync payloads (P5-b §4.2).
 *
 * Three ops — create / update / delete. All carry `updated_at_ms` so the
 * apply path can run LWW comparison against local folders.updated_at
 * (folder/delete gained updated_at_ms in P5-b §4.3, mirroring P5-a Step 0b
 * for note/delete).
 *
 * Caller's §4.2 gate:
 *
 *   if (entity_type !== 'folder')        → handled by router
 *   if (!('updated_at_ms' in payload))   → skip + log  (defensive; emit shouldn't drop it)
 *   else                                  → parseFolderPayload(op, payload)
 *
 * Field names mirror the emit forms in packages/core/src/folders/index.ts.
 */

export interface FolderCreatePayload {
  name: string;
  parent_id: string | null;
  position: number;
  created_at_ms: number;
  updated_at_ms: number;
}

/** Sparse post-state: only the columns the caller asked to write. */
export interface FolderUpdatePayload {
  updated_at_ms: number;
  name?: string;
  parent_id?: string | null;
  position?: number;
}

export interface FolderDeletePayload {
  updated_at_ms: number;
}

export type FolderApplyPayload =
  | { op: 'create'; body: FolderCreatePayload }
  | { op: 'update'; body: FolderUpdatePayload }
  | { op: 'delete'; body: FolderDeletePayload };

export class FolderPayloadInvalidError extends Error {
  constructor(
    public readonly op: string,
    public readonly reason: string,
    public readonly raw: unknown,
  ) {
    super(`folder payload invalid for op=${op}: ${reason}`);
    this.name = 'FolderPayloadInvalidError';
  }
}

const FOLDER_APPLY_OPS = new Set(['create', 'update', 'delete'] as const);

// ─── narrow helpers ──────────────────────────────────────────────────────

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function fail(op: string, reason: string, raw: unknown): never {
  throw new FolderPayloadInvalidError(op, reason, raw);
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

// ─── per-op parsers ──────────────────────────────────────────────────────

function parseCreate(raw: unknown, obj: Record<string, unknown>): FolderCreatePayload {
  return {
    name: requireString('create', raw, obj, 'name'),
    parent_id: requireNullableString('create', raw, obj, 'parent_id'),
    position: requireNumber('create', raw, obj, 'position'),
    created_at_ms: requireNumber('create', raw, obj, 'created_at_ms'),
    updated_at_ms: requireNumber('create', raw, obj, 'updated_at_ms'),
  };
}

function parseUpdate(raw: unknown, obj: Record<string, unknown>): FolderUpdatePayload {
  const out: FolderUpdatePayload = {
    updated_at_ms: requireNumber('update', raw, obj, 'updated_at_ms'),
  };
  if ('name' in obj) out.name = requireString('update', raw, obj, 'name');
  if ('parent_id' in obj) out.parent_id = requireNullableString('update', raw, obj, 'parent_id');
  if ('position' in obj) out.position = requireNumber('update', raw, obj, 'position');
  return out;
}

function parseDelete(raw: unknown, obj: Record<string, unknown>): FolderDeletePayload {
  return { updated_at_ms: requireNumber('delete', raw, obj, 'updated_at_ms') };
}

// ─── public entry ────────────────────────────────────────────────────────

/**
 * Narrow + validate a raw folder payload to its discriminated-union shape.
 *
 * Throws FolderPayloadInvalidError if op is unknown, payload is not an
 * object, or any required field has the wrong type. Caller (runSync) rolls
 * back the entire pull batch on throw.
 */
export function parseFolderPayload(op: string, raw: unknown): FolderApplyPayload {
  if (!(FOLDER_APPLY_OPS as ReadonlySet<string>).has(op)) {
    throw new FolderPayloadInvalidError(op, 'op must be one of create / update / delete', raw);
  }
  if (!isObject(raw)) {
    throw new FolderPayloadInvalidError(op, 'payload must be a JSON object', raw);
  }
  switch (op) {
    case 'create':
      return { op: 'create', body: parseCreate(raw, raw) };
    case 'update':
      return { op: 'update', body: parseUpdate(raw, raw) };
    case 'delete':
      return { op: 'delete', body: parseDelete(raw, raw) };
    default:
      throw new FolderPayloadInvalidError(op, 'unreachable', raw);
  }
}
