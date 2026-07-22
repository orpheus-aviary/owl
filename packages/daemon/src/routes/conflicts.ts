/**
 * P5-c Step 13 — conflict HTTP routes.
 *
 * Endpoints, all backed by `@owl/core/sync/conflicts`:
 *   GET  /conflicts              — list unresolved rows (newest first)
 *   GET  /conflicts/count        — count(*) WHERE resolved_at IS NULL
 *   POST /conflicts/:id/ignore   — soft-delete (UPDATE resolved_at + resolution='ignored')
 *   POST /conflicts/:id/resolve  — W7 用本地覆盖 / 合并 (writes the note via CAS)
 *
 * The ignore/resolve routes emit `conflicts:changed` after a successful write
 * so other open GUI windows refresh their sidebar count. The list/count
 * endpoints don't emit — they're pure reads.
 *
 * Conflict_record is detection-time local state (P5-c §6.15), never
 * synced to the server, so these routes never reach skybridge.
 *
 * `resolve` does only pure request-shape validation here, then hands off to
 * core `resolveConflict` which owns the entire transaction (设计 §3.4) —
 * this route never opens its own so core/daemon can't double-count a rollback.
 */

import {
  AlreadyTrashedError,
  BadPayload,
  ConflictNotFound,
  NoteNotFound,
  type ResolveConflictArgs,
  UnsupportedEntity,
  VersionMismatchError,
  countUnresolvedConflicts,
  ignoreConflict,
  listUnresolvedConflicts,
  resolveConflict,
} from '@owl/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type ResolveBody = { strategy?: unknown; content?: unknown; expected_updated_at_ms?: unknown };

type ParsedResolveBody = { ok: true; args: ResolveConflictArgs } | { ok: false; message: string };

/**
 * Pure request-shape validation for `POST /conflicts/:id/resolve`. Everything
 * DB-shaped (missing conflict/note, stale CAS, trashed, unsupported entity) is
 * left to core's typed errors — this only rejects malformed request bodies with
 * a single `VALIDATION` code (设计 §3.4).
 */
function parseResolveBody(body: ResolveBody): ParsedResolveBody {
  const { strategy, content, expected_updated_at_ms } = body;
  if (strategy !== 'local' && strategy !== 'merged') {
    return { ok: false, message: "strategy must be 'local' or 'merged'" };
  }
  if (
    typeof expected_updated_at_ms !== 'number' ||
    !Number.isFinite(expected_updated_at_ms) ||
    !Number.isSafeInteger(expected_updated_at_ms) ||
    expected_updated_at_ms < 0
  ) {
    return { ok: false, message: 'expected_updated_at_ms must be a non-negative safe integer' };
  }
  if (strategy === 'merged') {
    if (typeof content !== 'string') {
      return { ok: false, message: "content (string) is required for strategy 'merged'" };
    }
    return { ok: true, args: { strategy, content, expectedUpdatedAtMs: expected_updated_at_ms } };
  }
  return { ok: true, args: { strategy, expectedUpdatedAtMs: expected_updated_at_ms } };
}

/**
 * Map a `resolveConflict` typed error to its HTTP response. Returns `true` when
 * handled; `false` for anything we don't own (caller rethrows).
 */
function sendResolveError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof ConflictNotFound) {
    fail(reply, 404, err.message, 'CONFLICT_NOT_FOUND');
    return true;
  }
  if (err instanceof NoteNotFound) {
    fail(reply, 404, err.message, 'NOTE_NOT_FOUND');
    return true;
  }
  if (err instanceof VersionMismatchError) {
    fail(reply, 409, err.message, 'VERSION_MISMATCH', {
      expected: err.expected,
      current: err.current,
    });
    return true;
  }
  if (err instanceof AlreadyTrashedError) {
    fail(reply, 409, err.message, 'ALREADY_TRASHED', {
      current_trash_level: err.currentTrashLevel,
    });
    return true;
  }
  if (err instanceof UnsupportedEntity) {
    fail(reply, 422, err.message, 'UNSUPPORTED_ENTITY');
    return true;
  }
  if (err instanceof BadPayload) {
    fail(reply, 422, err.message, 'BAD_PAYLOAD');
    return true;
  }
  return false;
}

export function registerConflictsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/conflicts', async (req, reply) => {
    const q = (req.query ?? {}) as { limit?: string };
    let limit = DEFAULT_LIMIT;
    if (q.limit !== undefined) {
      const parsed = Number(q.limit);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        fail(reply, 400, 'limit must be a positive number', 'USAGE_ERROR');
        return;
      }
      limit = Math.min(Math.floor(parsed), MAX_LIMIT);
    }
    const rows = listUnresolvedConflicts(ctx.sqlite, { limit });
    ok(reply, { conflicts: rows }, undefined, rows.length);
  });

  app.get('/conflicts/count', async (_req, reply) => {
    const count = countUnresolvedConflicts(ctx.sqlite);
    ok(reply, { count });
  });

  app.post<{ Params: { id: string } }>('/conflicts/:id/ignore', async (req, reply) => {
    const { id } = req.params;
    if (!id) {
      fail(reply, 400, 'conflict id required', 'USAGE_ERROR');
      return;
    }
    const changed = ignoreConflict(ctx.sqlite, id);
    if (!changed) {
      // Either the id doesn't exist or it's already resolved. Both are
      // soft 404s — GUI typically races a list refresh with a click, so
      // a tolerant response keeps the UX smooth.
      fail(reply, 404, `conflict ${id} not found or already resolved`, 'CONFLICT_NOT_FOUND');
      return;
    }
    ctx.eventsBus.emit({ type: 'conflicts:changed' });
    ok(reply, { id, ignored: true });
  });

  // POST /conflicts/:id/resolve — W7 manual resolution. Body:
  //   { strategy: 'local' | 'merged', content?, expected_updated_at_ms }
  // `expected_updated_at_ms` is always required (CAS baseline). `content` is
  // required (and any string, incl. empty) only for 'merged'. Pure shape
  // validation lives here; everything DB-shaped is core's typed errors.
  app.post<{ Params: { id: string }; Body: ResolveBody }>(
    '/conflicts/:id/resolve',
    async (req, reply) => {
      const { id } = req.params;
      if (!id) return fail(reply, 400, 'conflict id required', 'VALIDATION');

      const parsed = parseResolveBody(req.body ?? {});
      if (!parsed.ok) return fail(reply, 400, parsed.message, 'VALIDATION');

      try {
        const result = resolveConflict(ctx.db, ctx.sqlite, id, parsed.args);
        if (!result.resolved) {
          // Idempotent no-op (row already resolved). 200, no event.
          return ok(reply, { resolved: false, reason: result.reason });
        }
        ctx.scheduler.onNoteChanged(result.note.id);
        ctx.eventsBus.emit({ type: 'conflicts:changed' });
        ok(reply, { resolved: true, note: result.note }, 'Conflict resolved');
      } catch (err) {
        if (sendResolveError(reply, err)) return;
        throw err;
      }
    },
  );
}
