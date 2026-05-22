/**
 * Apply-side runtime validator for conversation sync payloads (P5-b §4.5).
 *
 * Two ops — append / delete. Append carries the messages produced by one
 * agent-loop iteration; delete is empty. Title + created_at_ms are present
 * only on the very first append (when the conversation row is being
 * implicitly created server-side).
 *
 * No LWW here — conversations are append-only across devices. Caller §4.6
 * routes change-level dedup via cid; this validator only narrows shape.
 *
 * Field names mirror the emit forms in
 * packages/core/src/conversations/index.ts (append L77-91, delete L161-174).
 */

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** JSON-encoded tool_calls array; only non-null on assistant rows that issued tool calls. */
  tool_calls: string | null;
  /** Only non-null on role='tool' rows. */
  tool_call_id: string | null;
  /** 0/1; only on role='tool'; null otherwise. */
  is_error: number | null;
  reasoning_content: string | null;
  reasoning_signature: string | null;
}

export interface ConversationAppendPayload {
  messages: ConversationMessage[];
  applied_at_ms: number;
  /** Only present on the very first append, when server creates the conversation row. */
  title?: string;
  /** Only present on the very first append. */
  created_at_ms?: number;
}

export type ConversationDeletePayload = Record<string, never>;

export type ConversationApplyPayload =
  | { op: 'append'; body: ConversationAppendPayload }
  | { op: 'delete'; body: ConversationDeletePayload };

export class ConversationPayloadInvalidError extends Error {
  constructor(
    public readonly op: string,
    public readonly reason: string,
    public readonly raw: unknown,
  ) {
    super(`conversation payload invalid for op=${op}: ${reason}`);
    this.name = 'ConversationPayloadInvalidError';
  }
}

const CONVERSATION_APPLY_OPS = new Set(['append', 'delete'] as const);
const MESSAGE_ROLES = new Set(['user', 'assistant', 'tool'] as const);

// ─── narrow helpers ──────────────────────────────────────────────────────

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function fail(op: string, reason: string, raw: unknown): never {
  throw new ConversationPayloadInvalidError(op, reason, raw);
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

function parseMessage(raw: unknown, m: unknown, path: string): ConversationMessage {
  if (!isObject(m)) fail('append', `${path} must be an object`, raw);
  const role_raw = requireString('append', raw, m, 'role');
  if (!(MESSAGE_ROLES as ReadonlySet<string>).has(role_raw)) {
    fail(
      'append',
      `${path}.role must be user/assistant/tool, got ${JSON.stringify(role_raw)}`,
      raw,
    );
  }
  return {
    role: role_raw as ConversationMessage['role'],
    content: requireString('append', raw, m, 'content'),
    tool_calls: requireNullableString('append', raw, m, 'tool_calls'),
    tool_call_id: requireNullableString('append', raw, m, 'tool_call_id'),
    is_error: requireNullableNumber('append', raw, m, 'is_error'),
    reasoning_content: requireNullableString('append', raw, m, 'reasoning_content'),
    reasoning_signature: requireNullableString('append', raw, m, 'reasoning_signature'),
  };
}

// ─── per-op parsers ──────────────────────────────────────────────────────

function parseAppend(raw: unknown, obj: Record<string, unknown>): ConversationAppendPayload {
  const messages_raw = obj.messages;
  if (!Array.isArray(messages_raw)) {
    fail('append', 'messages must be an array', raw);
  }
  const messages = messages_raw.map((m, i) => parseMessage(raw, m, `messages[${i}]`));
  const out: ConversationAppendPayload = {
    messages,
    applied_at_ms: requireNumber('append', raw, obj, 'applied_at_ms'),
  };
  // title + created_at_ms only on first append; either both present or both absent.
  const hasTitle = 'title' in obj;
  const hasCreated = 'created_at_ms' in obj;
  if (hasTitle !== hasCreated) {
    fail('append', 'title and created_at_ms must both be present or both absent', raw);
  }
  if (hasTitle) {
    out.title = requireString('append', raw, obj, 'title');
    out.created_at_ms = requireNumber('append', raw, obj, 'created_at_ms');
  }
  return out;
}

function parseDelete(_raw: unknown, _obj: Record<string, unknown>): ConversationDeletePayload {
  return {};
}

// ─── public entry ────────────────────────────────────────────────────────

/**
 * Narrow + validate a raw conversation payload to its discriminated-union shape.
 *
 * Throws ConversationPayloadInvalidError if op is unknown, payload is not
 * an object, or any required field has the wrong type. Caller (runSync)
 * rolls back the entire pull batch on throw.
 */
export function parseConversationPayload(op: string, raw: unknown): ConversationApplyPayload {
  if (!(CONVERSATION_APPLY_OPS as ReadonlySet<string>).has(op)) {
    throw new ConversationPayloadInvalidError(op, 'op must be one of append / delete', raw);
  }
  if (!isObject(raw)) {
    throw new ConversationPayloadInvalidError(op, 'payload must be a JSON object', raw);
  }
  switch (op) {
    case 'append':
      return { op: 'append', body: parseAppend(raw, raw) };
    case 'delete':
      return { op: 'delete', body: parseDelete(raw, raw) };
    default:
      throw new ConversationPayloadInvalidError(op, 'unreachable', raw);
  }
}
