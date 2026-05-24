/**
 * P5-c Step 13 — conflict HTTP routes.
 *
 * Three endpoints, all backed by `@owl/core/sync/conflicts`:
 *   GET  /conflicts             — list unresolved rows (newest first)
 *   GET  /conflicts/count       — count(*) WHERE resolved_at IS NULL
 *   POST /conflicts/:id/ignore  — soft-delete (UPDATE resolved_at + resolution='ignored')
 *
 * The ignore route emits `conflicts:changed` after a successful soft-delete
 * so other open GUI windows refresh their sidebar count. The list/count
 * endpoints don't emit — they're pure reads.
 *
 * Conflict_record is detection-time local state (P5-c §6.15), never
 * synced to the server, so these routes never reach skybridge.
 */

import { countUnresolvedConflicts, ignoreConflict, listUnresolvedConflicts } from '@owl/core';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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
}
