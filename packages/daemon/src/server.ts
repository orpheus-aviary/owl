import cors from '@fastify/cors';
import Fastify, { type FastifyError } from 'fastify';
import { corsOriginDelegate, isHostAllowed } from './access-guard.js';
import type { AppContext } from './context.js';
import { fail } from './response.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerConflictsRoutes } from './routes/conflicts.js';
import { registerEventsRoutes } from './routes/events.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerNoteRoutes } from './routes/notes.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerTagRoutes } from './routes/tags.js';
import { registerTodoRoutes } from './routes/todos.js';
import { ensureSwitchGate } from './sync/switch-gate.js';

/** HTTP methods the profile-switch gate quiesces during a db swap. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes that initiate a switch must not be counted as in-flight mutations —
 * `switchProfile` drains tracked mutations before swapping, so tracking the
 * switch-initiating request would deadlock it against itself (P5-d Phase 15).
 * They still get a 503 if a switch is already running (the isSwitching check
 * below runs first).
 */
const SWITCH_INITIATING_PATHS = new Set(['/sync/switch']);

export function buildServer(ctx: AppContext) {
  const app = Fastify({
    logger: false, // We use our own pino logger
  });

  // CORS (Phase A A1) — replace `origin: true` with a mode-aware allowlist:
  // local = Electron renderer (loopback / file://-null) + localhost browser +
  // CLI (no Origin); cloud = configured public_url + allowed_origins. See
  // access-guard.ts.
  app.register(cors, {
    origin: corsOriginDelegate(ctx.config),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Phase A A1 — Host header check (anti DNS-rebinding; CORS can't stop a
  // simple-request rebinding attack). Registered before the switch-gate so a
  // spoofed Host is rejected before any route work. Loopback is always allowed;
  // cloud additionally allows public_url / allowed_hosts. Preflight OPTIONS is
  // handled by @fastify/cors (onRequest) and never reaches this preHandler.
  app.addHook('preHandler', async (req, reply) => {
    if (!isHostAllowed(ctx.config, req.headers.host)) {
      fail(reply, 403, 'host not allowed', 'HOST_NOT_ALLOWED');
      return reply;
    }
  });

  // P5-d Phase 14 — profile-switch gate. While `switchProfile` swaps the db
  // (sub-second), reject mutating requests with 503 so nothing writes to a
  // sqlite handle that's about to close; otherwise count the request so the
  // switch can drain in-flight mutations before the swap. Must be registered
  // BEFORE the routes — Fastify only applies a hook to routes added after it.
  const switchGate = ensureSwitchGate(ctx);
  app.addHook('preHandler', async (req, reply) => {
    if (!MUTATING_METHODS.has(req.method)) return;
    if (switchGate.isSwitching()) {
      fail(reply, 503, 'profile switch in progress', 'SWITCH_IN_PROGRESS');
      return reply;
    }
    // Don't track the switch-initiating request — it would deadlock the drain.
    if (SWITCH_INITIATING_PATHS.has(req.url.split('?')[0])) return;
    (req as { switchRelease?: () => void }).switchRelease = switchGate.trackMutation();
  });
  app.addHook('onResponse', async (req) => {
    (req as { switchRelease?: () => void }).switchRelease?.();
  });

  // Fastify swallows route-handler throws as a generic 500 without
  // letting us see the stack. Mirror them into our logger so 500s leave
  // a breadcrumb in daemon.log (not just "Internal Server Error" in the
  // GUI console).
  app.setErrorHandler((err: FastifyError, req, reply) => {
    ctx.logger.error(
      {
        err,
        method: req.method,
        url: req.url,
        statusCode: err.statusCode ?? 500,
      },
      'unhandled route error',
    );
    if (reply.sent) return;
    reply.status(err.statusCode ?? 500).send({
      success: false,
      message: err.message || 'Internal Server Error',
      error_code: err.code ?? 'INTERNAL_ERROR',
    });
  });

  // Register routes
  registerNoteRoutes(app, ctx);
  registerFolderRoutes(app, ctx);
  registerTagRoutes(app, ctx);
  registerTodoRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerAiRoutes(app, ctx);
  registerSystemRoutes(app);
  registerEventsRoutes(app, ctx);
  registerSyncRoutes(app, ctx);
  registerConflictsRoutes(app, ctx);

  return app;
}
