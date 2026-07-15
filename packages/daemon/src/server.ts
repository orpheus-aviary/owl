import cors from '@fastify/cors';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { corsOriginDelegate, isHostAllowed } from './access-guard.js';
import {
  type Session,
  bearerToken,
  ensureSessionStore,
  isAuthExempt,
  isLocalPublicPath,
  timingSafeEqualStr,
} from './auth.js';
import type { AppContext } from './context.js';
import { fail } from './response.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerAuthRoutes } from './routes/auth.js';
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
import { registerWebHost, resolveWebRoot } from './web-host.js';

/** HTTP methods the profile-switch gate quiesces during a db swap. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes that initiate a switch must not be counted as in-flight mutations —
 * `switchProfile` drains tracked mutations before swapping, so tracking the
 * switch-initiating request would deadlock it against itself (P5-d Phase 15).
 * They still get a 503 if a switch is already running (the isSwitching check
 * below runs first).
 *
 * Phase A A4 — `POST /auth/login` joins this set: the cloud self-login chain
 * runs `switchToProfileId` → `switchProfile` in-handler (first login / return
 * visit / off-mode account swap), so tracking the login request would deadlock
 * the drain against the very request driving it.
 */
const SWITCH_INITIATING_PATHS = new Set(['/sync/switch', '/auth/login']);

/**
 * A6 local-mode gate: every request except the public allowlist (GET /status)
 * must carry the local token (closes cross-site simple-POST CSRF + the
 * null-origin GET read leak). Returns `true` (and has sent a 401) when the
 * request is blocked; `false` when it may proceed. Shared by the auth preHandler
 * and the not-found handler.
 */
function checkLocalToken(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): boolean {
  if (isLocalPublicPath(req.method, req.url)) return false;
  const token = bearerToken(req.headers.authorization);
  if (token && ctx.localToken && timingSafeEqualStr(token, ctx.localToken)) return false;
  fail(reply, 401, 'local token required', 'LOCAL_TOKEN_REQUIRED');
  return true;
}

/**
 * A2 cloud-mode gate: every request outside the public allowlist / static shell
 * (B4) must carry a valid Layer-2 bearer session. Returns `true` (sent 401) when
 * blocked; `false` when it may proceed (and sets `req.session` for downstream
 * owner-gating on success).
 */
function checkCloudSession(
  ctx: AppContext,
  sessionStore: ReturnType<typeof ensureSessionStore>,
  req: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (isAuthExempt(ctx.config, req.method, req.url)) return false;
  const token = bearerToken(req.headers.authorization);
  const session = token ? sessionStore.verify(token) : null;
  if (!session) {
    fail(
      reply,
      401,
      token ? 'invalid or expired session' : 'session required',
      token ? 'SESSION_INVALID' : 'SESSION_REQUIRED',
    );
    return true;
  }
  (req as { session?: Session }).session = session;
  return false;
}

export function buildServer(ctx: AppContext) {
  // A6 fail-closed — a local daemon MUST carry a local token (boot.ts generates
  // it; buildTestServer sets one). Missing it would silently reopen the CSRF
  // hole, so refuse to build the server rather than gate on an absent secret.
  if (ctx.config.daemon.mode === 'local' && !ctx.localToken) {
    throw new Error('local daemon requires ctx.localToken to be set (A6 fail-closed)');
  }

  const app = Fastify({
    logger: false, // We use our own pino logger
    // Phase A A4 — only read X-Forwarded-For (and thus base req.ip on it) when
    // the operator has put a trusted reverse proxy in front (cloud deploys).
    // The /auth/login per-IP throttle keys off req.ip; without a proxy it would
    // be the loopback address and meaningless. Defaults off (desktop unchanged).
    trustProxy: ctx.config.daemon.trust_proxy === true,
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

  // Phase A A2 — Layer-2 endpoint auth. In cloud mode every request outside the
  // public allowlist must carry a valid bearer session token (minted by
  // POST /auth/login in A4); in local mode this is a no-op (A6-前桌面零变更).
  // Runs after the Host check, before the switch-gate so unauthenticated
  // requests are never tracked as in-flight mutations. Sets req.session for
  // downstream owner-gating (A4/A5).
  const sessionStore = ensureSessionStore(ctx);
  app.addHook('preHandler', async (req, reply) => {
    const blocked =
      ctx.config.daemon.mode === 'local'
        ? checkLocalToken(ctx, req, reply)
        : checkCloudSession(ctx, sessionStore, req, reply);
    return blocked ? reply : undefined;
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

  // A6 — an unregistered path must not skip the local auth gate: gate first
  // (401 without a valid token), then a plain 404. Self-contained so the
  // behaviour holds regardless of whether Fastify runs the global preHandler
  // for the not-found route.
  app.setNotFoundHandler((req, reply) => {
    if (ctx.config.daemon.mode === 'local' && checkLocalToken(ctx, req, reply)) return reply;
    fail(reply, 404, 'not found', 'NOT_FOUND');
    return reply;
  });

  // Register routes
  registerNoteRoutes(app, ctx);
  registerFolderRoutes(app, ctx);
  registerTagRoutes(app, ctx);
  registerTodoRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerAiRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerEventsRoutes(app, ctx);
  registerSyncRoutes(app, ctx);
  registerConflictsRoutes(app, ctx);

  // B4 — same-origin web hosting, A6 — cloud-only. The web client is a cloud
  // concept (browser=cloud): it authenticates with a Layer-2 session, whereas a
  // local daemon's token gate would 401 every API call a browser makes. So a
  // local daemon never hosts a shell; only cloud registers the operator's
  // [daemon].web_root (or `ctx.embeddedWebRoot`, the owl-server bundle).
  // Registered AFTER the API routes so specific routes win; the shell is public
  // (the cloud auth gate bypasses non-API GET/HEAD). `cli.ts`/`boot()` has
  // already fail-fast-validated the path.
  const webRoot =
    ctx.config.daemon.mode === 'cloud'
      ? (resolveWebRoot(ctx.config) ?? ctx.embeddedWebRoot)
      : undefined;
  if (webRoot) registerWebHost(app, webRoot);

  return app;
}
