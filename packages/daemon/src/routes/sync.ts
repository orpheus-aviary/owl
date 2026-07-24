/**
 * P5-a Step 7 — sync HTTP routes.
 *
 * Endpoints:
 *   POST /sync/run          — one manual pull/push round, returns RunSyncResult
 *   GET  /sync/status       — config + cursor + pending snapshot
 *   POST /sync/session      — P5-d Phase 6: install session from explicit body
 *                              with replace semantics (stop → clear → install →
 *                              restart background handles). 127.0.0.1 only.
 *                              Handler MUST NOT log req.body / token.
 *   POST /sync/logout-local — P5-d Phase 6: tear down background handles +
 *                              clear ctx.skybridgeSession + clearSyncIdentity
 *                              on sqlite. Does NOT touch toml or sync_cursor
 *                              (GUI main owns toml; cursor isolation is keyed
 *                              by syncEndpointKey, see v3 §3.6.2).
 *
 * Retired in P5-d Phase 6:
 *   POST /sync/login — daemon never writes toml; GUI main is the sole writer
 *                       via the Phase 7 keychain path. Until that ships, dev
 *                       drivers seed credentials directly via /sync/session.
 *
 * Error translation comes from `manual.ts` (`statusForError` /
 * `codeForError`) so the §5.4 error_code matrix lives in one place.
 */

import {
  LOCAL_PROFILE,
  SkybridgeAuthRequiredError,
  clearSyncIdentity,
  isHexProfileId,
  readSkybridgeDeviceId,
} from '@owl/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';
import { ensureBackgroundHandles, stopBackgroundHandles } from '../sync/bridge-lifecycle.js';
import {
  codeForError,
  messageForError,
  readSyncStatus,
  runManualSync,
  statusForError,
  translateSkybridgeError,
} from '../sync/manual.js';
import { switchToProfileId } from '../sync/profile-switch.js';
import {
  type InstallSessionInput,
  installSkybridgeSession,
  invalidateSkybridgeSession,
} from '../sync/session.js';
import { evictSyncStatusBroadcaster } from '../sync/status-broadcaster.js';

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

  // P5-d Phase 10 — list devices under the current skybridge user.
  // Read-only; revoke endpoint absent in skybridge ^0.1.3 (recipe for
  // Phase 10.5+).
  //
  // Does NOT call ensureSkybridgeSession() — directly reads
  // ctx.skybridgeSession. After Phase 10 commit 3, lazy bootstrap is
  // gone; reading the cache here keeps the path symmetric with the
  // future state.
  //
  // SDK ApiError(401) / NetworkError must go through translateSkybridgeError
  // before status/code helpers — those helpers only recognise daemon's
  // own error classes; raw SDK errors would otherwise fall to
  // 500 / SKYBRIDGE_SYNC_FAILED.
  //
  // When the translated error is SkybridgeAuthRequiredError (either our
  // self-thrown "no session installed" or a translated SDK 401), the
  // in-memory ctx.skybridgeSession is invalidated. doRunManualSync does
  // the same in manual.ts:258; /sync/devices does it locally because it
  // never goes through doRunManualSync.
  app.get('/sync/devices', async (_req, reply) => {
    try {
      const session = ctx.skybridgeSession;
      if (!session) {
        throw new SkybridgeAuthRequiredError('skybridge session not installed; 请在设置中登录');
      }
      const devices = await session.realClient.listDevices();
      ok(reply, { devices });
    } catch (err) {
      const translated = translateSkybridgeError(err);
      if (translated instanceof SkybridgeAuthRequiredError) {
        invalidateSkybridgeSession(ctx);
      }
      fail(
        reply,
        statusForError(translated),
        messageForError(translated),
        codeForError(translated),
      );
    }
  });

  // P5-d Phase 17 (W9) — revoke a device under the current skybridge user.
  // Models /sync/devices exactly: reads ctx.skybridgeSession directly (no lazy
  // bootstrap), translates raw SDK errors before the status/code helpers, and
  // invalidates the in-memory session on a translated 401. GUI main only ever
  // calls this for a NON-current device (the current device is removed via
  // logout), so a successful revoke needs no local session teardown.
  app.post('/sync/revoke-device', async (req, reply) => {
    const deviceId = (req.body as { device_id?: unknown } | undefined)?.device_id;
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      fail(reply, 400, 'missing required field: device_id', 'USAGE_ERROR');
      return;
    }
    try {
      const session = ctx.skybridgeSession;
      if (!session) {
        throw new SkybridgeAuthRequiredError('skybridge session not installed; 请在设置中登录');
      }
      await session.realClient.revokeDevice(deviceId);
      ok(reply, { revoked: true });
    } catch (err) {
      const translated = translateSkybridgeError(err);
      if (translated instanceof SkybridgeAuthRequiredError) {
        invalidateSkybridgeSession(ctx);
      }
      fail(
        reply,
        statusForError(translated),
        messageForError(translated),
        codeForError(translated),
      );
    }
  });

  // P5-d Phase 15 — switch the daemon onto a profile's db (live login flip /
  // logout-to-local). `profile_id` is `local` (→ owl/owl.db) or a 32-hex
  // profile (→ profiles/<id>/owl.db). Returns the target db's stored
  // skybridge_device_id (null for a fresh db) so GUI main can reuse the
  // device (§5.3) instead of registering a new one.
  //
  // This route is EXEMPT from the switch gate's mutation tracking (server.ts):
  // switchProfile drains tracked mutations before swapping, so counting the
  // switch-initiating request would deadlock it against itself. A second
  // /sync/switch arriving mid-switch still gets a 503 (the gate's isSwitching
  // check runs first).
  app.post('/sync/switch', async (req, reply) => {
    if (cloudForbidden(ctx, reply)) return;
    const profileId = (req.body as { profile_id?: unknown } | undefined)?.profile_id;
    if (typeof profileId !== 'string' || profileId.length === 0) {
      fail(reply, 400, 'missing required field: profile_id', 'USAGE_ERROR');
      return;
    }
    if (profileId !== LOCAL_PROFILE && !isHexProfileId(profileId)) {
      fail(reply, 400, `invalid profile_id: ${JSON.stringify(profileId)}`, 'USAGE_ERROR');
      return;
    }
    try {
      // profileDbPathFor (inside switchToProfileId) maps local → owl/owl.db, a
      // hex id → profiles/<id>/owl.db (mkdir'ing its dir — a first login has
      // none yet and createDatabase won't mkdir).
      const { warnings } = await switchToProfileId(ctx, profileId, ctx.logger);
      const deviceId = readSkybridgeDeviceId(ctx.sqlite);
      ctx.logger.info(
        {
          kind: 'sync-session',
          op: 'switch',
          profile_id: profileId,
          device_id: deviceId,
          warnings: warnings.length,
        },
        'profile switched',
      );
      ok(reply, { device_id: deviceId, warnings });
    } catch (err) {
      fail(reply, statusForError(err), messageForError(err), codeForError(err));
    }
  });

  // P5-d Phase 6 — install session via HTTP. Do NOT log req.body or any
  // token-bearing field here; only a redacted summary at the end.
  app.post('/sync/session', async (req, reply) => {
    if (cloudForbidden(ctx, reply)) return;
    const raw = (req.body ?? {}) as Partial<InstallSessionInput>;
    const validation = validateSessionBody(raw);
    if (!validation.ok) {
      fail(reply, 400, validation.message, 'USAGE_ERROR');
      return;
    }
    const input = validation.input;
    try {
      stopBackgroundHandles(ctx);
      ctx.skybridgeSession = null;
      const session = await installSkybridgeSession(ctx, input);
      // Drop the cached broadcaster so the snapshot `createSseBridge` seeds
      // below reflects the just-installed binding, not a stale one from a
      // prior session (mirrors the profile-switch eviction).
      evictSyncStatusBroadcaster(ctx);
      await ensureBackgroundHandles(ctx, ctx.logger);
      ctx.logger.info(
        {
          kind: 'sync-session',
          op: 'replace',
          user_id: session.config.auth?.user_id ?? null,
          workspace_id: session.workspaceId,
          device_id: session.deviceId,
        },
        'sync session installed',
      );
      ok(reply, {
        user_id: session.config.auth?.user_id ?? null,
        email: session.config.auth?.email ?? null,
        server_url: session.serverUrl,
        device_id: session.deviceId,
        workspace_id: session.workspaceId,
      });
    } catch (err) {
      fail(reply, statusForError(err), messageForError(err), codeForError(err));
    }
  });

  // P5-d Phase 6 — tear down daemon-side session state. Caller (GUI main)
  // is responsible for remote /auth/logout + toml rewrite. We never touch
  // sync_cursor — cross-workspace cursor isolation is keyed by
  // syncEndpointKey(serverUrl, workspaceId) so a same-workspace re-login
  // resumes from the same `pulled_seq`.
  app.post('/sync/logout-local', async (_req, reply) => {
    if (cloudForbidden(ctx, reply)) return;
    try {
      stopBackgroundHandles(ctx);
      ctx.skybridgeSession = null;
      clearSyncIdentity(ctx.sqlite);
      ctx.logger.info({ kind: 'sync-session', op: 'logout-local' }, 'sync session cleared');
      ok(reply, { cleared: true });
    } catch (err) {
      fail(reply, statusForError(err), messageForError(err), codeForError(err));
    }
  });
}

/**
 * Phase A (A4, §4.3 ③) — the GUI-main plumbing endpoints (`/sync/session`,
 * `/sync/switch`, `/sync/logout-local`) install/switch/release the Layer-1
 * binding directly, bypassing account_lock + the cloud lifecycle. A cloud
 * daemon owns its own binding via `/auth/login` + `/auth/logout`, so these are
 * disabled there — 404 even for an authenticated client (the A2 bearer gate
 * only stops unauthenticated callers). local mode keeps them (GUI main owns the
 * binding). Returns true when it has already replied.
 */
function cloudForbidden(ctx: AppContext, reply: FastifyReply): boolean {
  if (ctx.config.daemon.mode === 'cloud') {
    fail(reply, 404, 'not available in cloud mode', 'NOT_FOUND');
    return true;
  }
  return false;
}

type SessionValidationOk = { ok: true; input: InstallSessionInput };
type SessionValidationErr = { ok: false; message: string };

function validateSessionBody(
  raw: Partial<InstallSessionInput>,
): SessionValidationOk | SessionValidationErr {
  const missing: string[] = [];
  if (!raw.token) missing.push('token');
  if (!raw.user_id) missing.push('user_id');
  if (!raw.email) missing.push('email');
  if (!raw.server_url) missing.push('server_url');
  if (!raw.device?.id) missing.push('device.id');
  if (!raw.device?.name) missing.push('device.name');
  if (!raw.workspace?.id) missing.push('workspace.id');
  if (missing.length > 0) {
    return { ok: false, message: `missing required field(s): ${missing.join(', ')}` };
  }
  // After the missing-field guard, the non-null assertions are safe.
  const input: InstallSessionInput = {
    token: raw.token as string,
    user_id: raw.user_id as string,
    email: raw.email as string,
    server_url: raw.server_url as string,
    device: {
      id: (raw.device as { id: string }).id,
      name: (raw.device as { name: string }).name,
      app_version: raw.device?.app_version,
      client_version: raw.device?.client_version,
    },
    workspace: {
      id: (raw.workspace as { id: string }).id,
      slug: raw.workspace?.slug,
    },
  };
  return { ok: true, input };
}
