/**
 * P5-a Step 7 — sync HTTP routes.
 *
 * Three endpoints, all delegating to `sync/manual.ts`:
 *   POST /sync/run    — one manual pull/push round, returns RunSyncResult
 *   GET  /sync/status — config + cursor + pending snapshot
 *   POST /sync/login  — write skybridge_config.toml [server]+[auth]
 *
 * Error translation comes from `manual.ts` (`statusForError` /
 * `codeForError`) so the §5.4 error_code matrix lives in one place.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';
import {
  codeForError,
  messageForError,
  readSyncStatus,
  runManualLogin,
  runManualSync,
  statusForError,
} from '../sync/manual.js';

export function registerSyncRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/sync/run', async (_req, reply) => {
    try {
      const result = await runManualSync(ctx);
      ok(reply, result);
    } catch (err) {
      fail(reply, statusForError(err), messageForError(err), codeForError(err));
    }
  });

  app.get('/sync/status', async (_req, reply) => {
    try {
      ok(reply, readSyncStatus(ctx));
    } catch (err) {
      fail(reply, statusForError(err), messageForError(err), codeForError(err));
    }
  });

  app.post('/sync/login', async (req, reply) => {
    const body = (req.body ?? {}) as {
      email?: string;
      password?: string;
      server_url?: string;
    };
    if (!body.email || !body.password) {
      fail(reply, 400, 'email and password required', 'USAGE_ERROR');
      return;
    }
    try {
      const result = await runManualLogin(ctx, body.email, body.password, body.server_url);
      ok(reply, result);
    } catch (err) {
      fail(reply, statusForError(err), messageForError(err), codeForError(err));
    }
  });
}
