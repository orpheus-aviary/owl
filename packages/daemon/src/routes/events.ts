import { getNote } from '@owl/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { endSse, initSse, sendSseEvent } from '../ai/sse.js';
import type { Session } from '../auth.js';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';

const KEEPALIVE_MS = 15_000;

/**
 * Register GET /events (SSE subscription) and POST /events/emit
 * (broadcast entry point).
 *
 * Shutdown handling is the subtle bit: `GET /events` is an infinite
 * stream with a hijacked reply, so the handler never returns on its
 * own. Fastify's `onClose` hook runs AFTER in-flight requests drain,
 * which would hang `server.close()` forever. We register a local
 * `preClose` hook that walks `liveReplies` and ends each stream;
 * Fastify then drains cleanly and `onClose` can run `bus.close()`.
 *
 * Deliberately NOT using `forceCloseConnections: true` — that would
 * also kill in-flight CRUD requests on other routes.
 */
export function registerEventsRoutes(app: FastifyInstance, ctx: AppContext) {
  const liveReplies = new Set<FastifyReply>();

  app.get('/events', async (req, reply) => {
    initSse(reply, req);
    sendSseEvent(reply, 'hello', { type: 'hello', server_time: Date.now() });
    liveReplies.add(reply);

    const unsubscribe = ctx.eventsBus.subscribe((event) => {
      if (reply.raw.writableEnded) return;
      sendSseEvent(reply, event.type, event);
    });

    const keepalive = setInterval(() => {
      if (reply.raw.writableEnded) {
        clearInterval(keepalive);
        return;
      }
      // SSE comment line — keeps intermediaries from idling the socket.
      reply.raw.write(':\n\n');
    }, KEEPALIVE_MS);

    // Phase A A2 — in cloud mode the stream is bound to a Layer-2 session;
    // revoking/expiring it (logout, idle TTL) must actively end the stream
    // (the auth preHandler only runs at connect time). `offTeardown` unregisters
    // on natural socket close so a later revoke doesn't double-fire. The `done`
    // guard makes cleanup idempotent across socket-close + teardown.
    let done = false;
    let offTeardown: (() => void) | undefined;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearInterval(keepalive);
      unsubscribe();
      liveReplies.delete(reply);
      offTeardown?.();
      endSse(reply);
    };

    req.raw.socket.on('close', cleanup);

    const session = (req as { session?: Session }).session;
    if (session && ctx.sessionStore) {
      offTeardown = ctx.sessionStore.onTeardown(session.token, cleanup);
    }
    // Do not return / await — hijack means fastify won't wait for this
    // handler. Stream lives until socket close OR preClose below.
  });

  app.addHook('preClose', async () => {
    for (const reply of liveReplies) {
      try {
        endSse(reply);
      } catch {
        // best-effort; socket 'close' listener will still fire
      }
    }
    liveReplies.clear();
  });

  app.post('/events/emit', async (req, reply) => {
    // Guard against bodyless POSTs — `req.body` would be undefined and
    // `body.type` would 500. Mirrors routes/ai.ts and routes/notes.ts.
    const body = (req.body ?? {}) as { type?: unknown; note_id?: unknown };

    if (body.type !== 'open_note') {
      return fail(reply, 400, 'unknown event type', 'BAD_REQUEST');
    }
    if (typeof body.note_id !== 'string' || !body.note_id) {
      return fail(reply, 400, 'note_id required', 'BAD_REQUEST');
    }

    const note = getNote(ctx.db, body.note_id);
    if (!note) {
      return fail(reply, 404, 'note not found', 'NOTE_NOT_FOUND');
    }
    if (note.trashLevel > 0) {
      return fail(reply, 404, 'note is in trash', 'NOTE_NOT_FOUND');
    }

    const subscribers = ctx.eventsBus.emit({
      type: 'open_note',
      note_id: body.note_id,
    });
    return ok(reply, { subscribers });
  });
}
