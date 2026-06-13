/**
 * Phase A (A4) — cloud Layer-2 auth endpoints.
 *
 *   POST /auth/login   (public) — run the cloud self-login chain (cloud-login.ts),
 *                       mint a Layer-2 session token, return it + identity.
 *                       Brute-force throttled (login-throttle.ts). Password is
 *                       never logged (check-session-body-not-logged guard).
 *   POST /auth/logout  (session) — `{all?}`: default revokes just this client's
 *                       session (Layer-1 stays); `all` remote-revokes the
 *                       skybridge token + full Layer-1 teardown (§5.3).
 *   GET  /auth/session (session) — whoami: identity + sliding expiry.
 *
 * cloud-only — a local daemon has no Layer-2 concept, so these 404 there. In
 * cloud mode the auth preHandler (server.ts) already allowlists POST /auth/login
 * and requires a bearer for logout/session.
 *
 * Design: `docs/plans/2026-06-12-phase-a-cloud-daemon-design.md` §4.3 / §5.3.
 */

import { SkybridgeAuthRequiredError } from '@owl/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Session, ensureSessionStore } from '../auth.js';
import {
  AccountBusyError,
  AccountLockedError,
  type CloudLoginDeps,
  SkybridgeServerTooOldError,
  cloudLogin,
  logoutAllCloudSessions,
} from '../cloud-login.js';
import type { AppContext } from '../context.js';
import { LoginThrottle, type ThrottleKeys } from '../login-throttle.js';
import { fail, ok } from '../response.js';
import {
  codeForError,
  messageForError,
  statusForError,
  translateSkybridgeError,
} from '../sync/manual.js';

interface PublicIdentity {
  profile_id: string;
  user_id: string;
  email: string;
  server_url: string;
  device_id: string;
  workspace_id: string;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // One throttle per server instance (RAM-only). Keyed by email + a global
  // bucket; per-IP only added when trust_proxy makes req.ip trustworthy.
  const throttle = new LoginThrottle();

  app.post('/auth/login', async (req, reply) => {
    if (notCloud(ctx, reply)) return;
    const creds = readCredentials(req.body, reply);
    if (!creds) return;
    const keys = throttleKeys(ctx, req, creds.email);
    if (enforceThrottle(throttle, keys, reply)) return;

    const deps: CloudLoginDeps = ctx.skybridgeLoader ? { loadClient: ctx.skybridgeLoader } : {};
    try {
      const result = await cloudLogin(ctx, creds, deps);
      throttle.recordSuccess(keys);
      const session = ensureSessionStore(ctx).mint(result.profileId);
      ok(reply, {
        session_token: session.token,
        expires_at: session.expiresAt,
        identity: {
          profile_id: result.profileId,
          user_id: result.userId,
          email: result.email,
          server_url: result.serverUrl,
          device_id: result.deviceId,
          workspace_id: result.workspaceId,
        } satisfies PublicIdentity,
      });
    } catch (err) {
      const mapped = mapLoginError(err);
      if (mapped.countAsFailure) throttle.recordFailure(keys);
      fail(reply, mapped.status, mapped.message, mapped.code);
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    if (notCloud(ctx, reply)) return;
    const session = sessionOf(req);
    if (!session) {
      // preHandler enforces this in cloud mode; defensive.
      fail(reply, 401, 'session required', 'SESSION_REQUIRED');
      return;
    }
    const all = (req.body as { all?: unknown } | undefined)?.all === true;
    if (all) {
      await logoutAllCloudSessions(ctx);
      ctx.logger.info({ kind: 'auth', op: 'logout-all' }, 'logged out all sessions');
      ok(reply, { logged_out_all: true });
      return;
    }
    ensureSessionStore(ctx).revoke(session.token);
    ctx.logger.info({ kind: 'auth', op: 'logout' }, 'session logged out');
    ok(reply, { logged_out: true });
  });

  app.get('/auth/session', async (req, reply) => {
    if (notCloud(ctx, reply)) return;
    const session = sessionOf(req);
    if (!session) {
      fail(reply, 401, 'session required', 'SESSION_REQUIRED');
      return;
    }
    const creds = ctx.credentialStore?.get();
    if (!creds) {
      // Layer-1 was torn down out from under this session — treat it as stale.
      ensureSessionStore(ctx).revoke(session.token);
      fail(reply, 401, 'invalid or expired session', 'SESSION_INVALID');
      return;
    }
    ok(reply, {
      expires_at: session.expiresAt,
      identity: {
        profile_id: creds.profileId,
        user_id: creds.userId,
        email: creds.email,
        server_url: creds.serverUrl,
        device_id: creds.deviceId,
        workspace_id: creds.workspaceId,
      } satisfies PublicIdentity,
    });
  });
}

/** Validate the login body; replies 400 + returns null on a missing field. */
function readCredentials(
  rawBody: unknown,
  reply: FastifyReply,
): { email: string; password: string } | null {
  const body = (rawBody ?? {}) as { email?: unknown; password?: unknown };
  if (typeof body.email !== 'string' || body.email.length === 0) {
    fail(reply, 400, 'missing required field: email', 'USAGE_ERROR');
    return null;
  }
  if (typeof body.password !== 'string' || body.password.length === 0) {
    fail(reply, 400, 'missing required field: password', 'USAGE_ERROR');
    return null;
  }
  return { email: body.email, password: body.password };
}

/** Replies 429 (+ Retry-After) and returns true when the key is throttled. */
function enforceThrottle(
  throttle: LoginThrottle,
  keys: ThrottleKeys,
  reply: FastifyReply,
): boolean {
  const retryAfterMs = throttle.retryAfterMs(keys);
  if (retryAfterMs <= 0) return false;
  reply.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  fail(reply, 429, 'too many login attempts; try again later', 'LOGIN_THROTTLED', {
    retry_after_ms: retryAfterMs,
  });
  return true;
}

/** 404 the /auth/* surface on a local daemon (no Layer-2 concept there). */
function notCloud(ctx: AppContext, reply: FastifyReply): boolean {
  if (ctx.config.daemon.mode !== 'cloud') {
    fail(reply, 404, 'not found', 'NOT_FOUND');
    return true;
  }
  return false;
}

function sessionOf(req: FastifyRequest): Session | undefined {
  return (req as { session?: Session }).session;
}

function throttleKeys(ctx: AppContext, req: FastifyRequest, email: string): ThrottleKeys {
  const keys: ThrottleKeys = { email: email.toLowerCase() };
  // req.ip only reflects X-Forwarded-For when Fastify trustProxy is on, which
  // buildServer ties to [daemon].trust_proxy. Otherwise it's the loopback proxy
  // and per-IP keying would be meaningless (design §4.3).
  if (ctx.config.daemon.trust_proxy === true) keys.ip = req.ip;
  return keys;
}

interface MappedLoginError {
  status: number;
  code: string;
  message: string;
  /** Whether this counts toward the brute-force throttle (credential probes only). */
  countAsFailure: boolean;
}

function mapLoginError(err: unknown): MappedLoginError {
  // Wrong instance — the password may even be correct, but it's still a probe.
  if (err instanceof AccountLockedError) {
    return { status: 403, code: err.code, message: err.message, countAsFailure: true };
  }
  // Transient (the rightful user just needs the incumbent to log out) — don't
  // penalise.
  if (err instanceof AccountBusyError) {
    return { status: 409, code: err.code, message: err.message, countAsFailure: false };
  }
  if (err instanceof SkybridgeServerTooOldError) {
    return { status: 409, code: err.code, message: err.message, countAsFailure: false };
  }
  const translated = translateSkybridgeError(err);
  // skybridge returns 401 for bad credentials — surface a login-specific code
  // and count it against the throttle.
  if (translated instanceof SkybridgeAuthRequiredError) {
    return {
      status: 401,
      code: 'INVALID_CREDENTIALS',
      message: 'invalid email or password',
      countAsFailure: true,
    };
  }
  // Infra/transient (server unreachable, 5xx) — surface as-is, don't throttle.
  return {
    status: statusForError(translated),
    code: codeForError(translated),
    message: messageForError(translated),
    countAsFailure: false,
  };
}
