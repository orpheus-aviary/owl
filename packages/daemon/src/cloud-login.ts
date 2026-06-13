/**
 * Phase A (slice A3b) — cloud daemon self-login chain.
 *
 * A cloud daemon has no GUI main, so it must run the skybridge login chain
 * itself (the GUI's `sync-auth.ts:loginAndOpenSession`, ported in-process):
 * skybridge login → two-branch device/workspace resolution → switch onto the
 * profile db → install the Layer-1 session → cache credentials in RAM →
 * schedule proactive refresh. Triggered by `POST /auth/login` (A4); A3 builds
 * the machinery + unit-tests it with a mock SDK.
 *
 * Faithful to the GUI chain (design §9 #5/#6):
 *   - two branches: return-visit (db exists → switch first, reuse the persisted
 *     device, else register) vs first-login (register → ensure → switch);
 *   - multi-device: a second login to the SAME account just rotates the Layer-1
 *     token + rebinds, no re-switch (design §2.2);
 *   - a process-level login mutex serialises concurrent logins/refreshes;
 *   - failure compensation: best-effort remote logout + roll the daemon back to
 *     the local db + drop partial state.
 *
 * Credentials are RAM-only (`CredentialStore`); refresh rotates the token and
 * REBINDS the realClient (design §2.3 — only mutating the stored string would
 * leave sync/SSE on a stale token that breaks at expiry).
 *
 * NOTE: the `account_lock='off'` "don't preempt an account with live sessions"
 * release rule (§5.3) and the HTTP route land in A4; A3's lock check only
 * enforces the locked-owner case.
 */

import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  OWL_APP_VERSION,
  type OwlConfig,
  computeProfileId,
  paths,
  readSkybridgeDeviceId,
} from '@owl/core';
import type { AppContext } from './context.js';
import { type CloudCredentials, CredentialStore } from './credential-store.js';
import { ensureBackgroundHandles, stopBackgroundHandles } from './sync/bridge-lifecycle.js';
import { switchToProfileId } from './sync/profile-switch.js';
import {
  type InstallSessionInput,
  type RealSkybridgeClient,
  type SkybridgeAuthContext,
  type SkybridgeClientModule,
  installSkybridgeSession,
  loadSkybridgeClient,
} from './sync/session.js';

// ─── Errors ──────────────────────────────────────────────────────────

/** The server didn't return a `server_id` → older than skybridge 0.1.4 (R5). */
export class SkybridgeServerTooOldError extends Error {
  readonly code = 'SKYBRIDGE_SERVER_TOO_OLD';
  constructor() {
    super('this server is too old — owl needs a skybridge 0.1.4+ server (no server_id returned)');
    this.name = 'SkybridgeServerTooOldError';
  }
}

/** The login account is not this locked instance's owner (account_lock). */
export class AccountLockedError extends Error {
  readonly code = 'ACCOUNT_LOCKED';
  constructor() {
    super('this instance is locked to another account (account_lock); use your own instance');
    this.name = 'AccountLockedError';
  }
}

// ─── Login mutex (per-ctx; isolates the dual-profile e2e) ─────────────

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(NOOP, NOOP);
    return result;
  }
}
const NOOP = (): void => {};
const mutexes = new WeakMap<AppContext, Mutex>();
function loginMutex(ctx: AppContext): Mutex {
  let m = mutexes.get(ctx);
  if (!m) {
    m = new Mutex();
    mutexes.set(ctx, m);
  }
  return m;
}

// ─── Public API ──────────────────────────────────────────────────────

export interface CloudLoginInput {
  email: string;
  password: string;
}

export interface CloudLoginResult {
  profileId: string;
  userId: string;
  email: string;
  serverUrl: string;
  deviceId: string;
  workspaceId: string;
}

export interface CloudLoginDeps {
  /** SDK module loader (mocked in tests). Defaults to the real dynamic import. */
  loadClient?: () => Promise<SkybridgeClientModule>;
  /** Clock for refresh scheduling (tests). Defaults to `Date.now`. */
  now?: () => number;
}

interface ResolvedDeps {
  loadClient: () => Promise<SkybridgeClientModule>;
  now: () => number;
}

function resolveDeps(deps: CloudLoginDeps): ResolvedDeps {
  return { loadClient: deps.loadClient ?? loadSkybridgeClient, now: deps.now ?? Date.now };
}

/** Lazily create + cache the RAM credential store on ctx. */
export function ensureCredentialStore(ctx: AppContext): CredentialStore {
  if (!ctx.credentialStore) ctx.credentialStore = new CredentialStore();
  return ctx.credentialStore;
}

/**
 * Run the cloud self-login chain for `email`/`password`, binding Layer-1 and
 * returning the resolved identity (A4 mints a Layer-2 session from it).
 * Serialised through the per-ctx login mutex.
 */
export function cloudLogin(
  ctx: AppContext,
  input: CloudLoginInput,
  deps: CloudLoginDeps = {},
): Promise<CloudLoginResult> {
  const d = resolveDeps(deps);
  return loginMutex(ctx).run(() => cloudLoginImpl(ctx, input, d));
}

// ─── Implementation ──────────────────────────────────────────────────

interface DeviceSection {
  id: string;
  name: string;
  app_version: string;
  client_version: string;
}

async function cloudLoginImpl(
  ctx: AppContext,
  input: CloudLoginInput,
  deps: ResolvedDeps,
): Promise<CloudLoginResult> {
  const store = ensureCredentialStore(ctx);
  const serverUrl = ctx.config.daemon.server_url;
  if (!serverUrl) {
    // A0 startup guard guarantees this in cloud mode; defensive.
    throw new Error('cloud login requires [daemon].server_url');
  }

  const sb = await deps.loadClient();
  const auth = await sb.login(serverUrl, input.email, input.password);
  if (!auth.serverId) throw new SkybridgeServerTooOldError();
  const profileId = computeProfileId(auth.serverId, auth.user.id);
  assertAccountAllowed(ctx.config, profileId);

  const authContext: SkybridgeAuthContext = {
    serverUrl: auth.serverUrl,
    token: auth.token,
    user: auth.user,
  };

  // Multi-device: already bound to this same account → rotate the Layer-1
  // token + rebind, don't re-switch / re-register (design §2.2).
  const current = store.get();
  if (current && current.profileId === profileId) {
    store.rotate({ token: auth.token, refreshToken: auth.refreshToken, expiresAt: auth.expiresAt });
    await rebindSession(ctx, installInputFrom(current, auth.token), sb);
    scheduleRefresh(ctx, auth.expiresAt, deps);
    return resultFrom(store.get() as CloudCredentials);
  }

  let switched = false;
  try {
    let device: DeviceSection;
    let workspace: { id: string; slug?: string };

    if (existsSync(paths.profileDbPath(profileId))) {
      // Return visit — switch first, reuse the persisted device (else register).
      await switchToProfileId(ctx, profileId, ctx.logger);
      switched = true;
      const remembered = readSkybridgeDeviceId(ctx.sqlite);
      device = remembered ? synthDevice(sb, remembered) : await registerNewDevice(sb, authContext);
      workspace = await ensureOwlWorkspace(sb, authContext, device.id);
    } else {
      // First login — register + ensure remotely, then switch (creates empty db).
      device = await registerNewDevice(sb, authContext);
      workspace = await ensureOwlWorkspace(sb, authContext, device.id);
      await switchToProfileId(ctx, profileId, ctx.logger);
      switched = true;
    }

    await rebindSession(
      ctx,
      {
        token: auth.token,
        user_id: auth.user.id,
        email: auth.user.email,
        server_url: auth.serverUrl,
        device,
        workspace: { id: workspace.id, slug: workspace.slug },
      },
      sb,
    );

    store.set({
      serverUrl: auth.serverUrl,
      serverId: auth.serverId,
      userId: auth.user.id,
      email: auth.user.email,
      profileId,
      deviceId: device.id,
      workspaceId: workspace.id,
      token: auth.token,
      refreshToken: auth.refreshToken,
      expiresAt: auth.expiresAt,
    });
    scheduleRefresh(ctx, auth.expiresAt, deps);
    ctx.logger.info(
      { kind: 'cloud-login', profile_id: profileId, device_id: device.id },
      `account logged in: profileId=${profileId}`,
    );
    return {
      profileId,
      userId: auth.user.id,
      email: auth.user.email,
      serverUrl: auth.serverUrl,
      deviceId: device.id,
      workspaceId: workspace.id,
    };
  } catch (err) {
    // Compensation: revoke the freshly-minted token + return the daemon to a
    // safe baseline (local db) + drop partial state. Never throws from here.
    await bestEffortRemoteLogout(sb, authContext);
    if (switched) {
      try {
        await switchToProfileId(ctx, 'local', ctx.logger);
      } catch {
        // best-effort rollback
      }
    }
    teardownCloudSession(ctx);
    throw err;
  }
}

/** §5.1 — a locked instance rejects any account other than its owner. */
function assertAccountAllowed(config: OwlConfig, profileId: string): void {
  const lock = config.daemon.account_lock;
  if (lock && lock !== 'off' && lock !== profileId) throw new AccountLockedError();
}

/** stop → null → install (with the injected SDK) → ensure: the replace dance. */
async function rebindSession(
  ctx: AppContext,
  input: InstallSessionInput,
  sb: SkybridgeClientModule,
): Promise<void> {
  stopBackgroundHandles(ctx);
  ctx.skybridgeSession = null;
  await installSkybridgeSession(ctx, input, sb);
  await ensureBackgroundHandles(ctx, ctx.logger);
}

/** Full Layer-1 teardown — drops creds + session + all Layer-2 + refresh timer. */
export function teardownCloudSession(ctx: AppContext): void {
  clearRefreshTimer(ctx);
  stopBackgroundHandles(ctx);
  ctx.skybridgeSession = null;
  ctx.credentialStore?.clear();
  ctx.sessionStore?.revokeAll();
}

async function registerNewDevice(
  sb: SkybridgeClientModule,
  authContext: SkybridgeAuthContext,
): Promise<DeviceSection> {
  const seed = sb.createSkybridgeClient({ authContext });
  const device = await seed.registerDevice({
    name: defaultDeviceName(),
    appVersion: `owl ${OWL_APP_VERSION}`,
    clientVersion: sb.CLIENT_VERSION,
  });
  return {
    id: device.id,
    name: device.name,
    app_version: `owl ${OWL_APP_VERSION}`,
    client_version: sb.CLIENT_VERSION,
  };
}

/** Reuse a remembered device id (return-visit) — synthesise its display meta. */
function synthDevice(sb: SkybridgeClientModule, deviceId: string): DeviceSection {
  return {
    id: deviceId,
    name: defaultDeviceName(),
    app_version: `owl ${OWL_APP_VERSION}`,
    client_version: sb.CLIENT_VERSION,
  };
}

async function ensureOwlWorkspace(
  sb: SkybridgeClientModule,
  authContext: SkybridgeAuthContext,
  deviceId: string,
): Promise<{ id: string; slug?: string }> {
  const client = sb.createSkybridgeClient({ authContext, deviceId });
  return client.ensureWorkspace('owl', 'default');
}

async function bestEffortRemoteLogout(
  sb: SkybridgeClientModule,
  authContext: SkybridgeAuthContext,
): Promise<void> {
  try {
    await (sb.createSkybridgeClient({ authContext }) as RealSkybridgeClient).logout();
  } catch {
    // best-effort — the token will expire on its own if revoke fails
  }
}

function installInputFrom(c: CloudCredentials, token: string): InstallSessionInput {
  return {
    token,
    user_id: c.userId,
    email: c.email,
    server_url: c.serverUrl,
    device: { id: c.deviceId, name: defaultDeviceName() },
    workspace: { id: c.workspaceId },
  };
}

function resultFrom(c: CloudCredentials): CloudLoginResult {
  return {
    profileId: c.profileId,
    userId: c.userId,
    email: c.email,
    serverUrl: c.serverUrl,
    deviceId: c.deviceId,
    workspaceId: c.workspaceId,
  };
}

function defaultDeviceName(): string {
  return `owl-cloud@${hostname()}`;
}

// ─── Proactive refresh ───────────────────────────────────────────────

const REFRESH_LEAD_MS = 60_000; // refresh ~1min before expiry
const MAX_TIMEOUT_MS = 2_147_483_647; // 2^31 - 1 (setTimeout 32-bit ceiling)

/**
 * (Re)arm the refresh timer for the given access-token expiry. No-op when the
 * server reported no expiry (relies on re-login). Re-arms itself for delays
 * beyond the 32-bit ceiling so a far-future expiry can't overflow to 1ms.
 */
export function scheduleRefresh(
  ctx: AppContext,
  expiresAt: number | undefined,
  deps: CloudLoginDeps = {},
): void {
  clearRefreshTimer(ctx);
  if (!expiresAt) return;
  const d = resolveDeps(deps);
  const delay = Math.max(0, expiresAt - d.now() - REFRESH_LEAD_MS);
  if (delay > MAX_TIMEOUT_MS) {
    ctx.refreshTimer = setTimeout(() => scheduleRefresh(ctx, expiresAt, deps), MAX_TIMEOUT_MS);
  } else {
    ctx.refreshTimer = setTimeout(() => {
      void refreshCloudSession(ctx, deps);
    }, delay);
  }
  ctx.refreshTimer.unref?.();
}

export function clearRefreshTimer(ctx: AppContext): void {
  if (ctx.refreshTimer) {
    clearTimeout(ctx.refreshTimer);
    ctx.refreshTimer = null;
  }
}

/**
 * Refresh the Layer-1 access token and REBIND the session (rebuild the
 * realClient with the fresh token; design §2.3). On a hard refresh failure
 * (REFRESH_INVALID / REPLAYED) tear the cloud session down so the owner
 * re-logs-in. Serialised through the login mutex.
 */
export function refreshCloudSession(ctx: AppContext, deps: CloudLoginDeps = {}): Promise<void> {
  const d = resolveDeps(deps);
  return loginMutex(ctx).run(() => refreshImpl(ctx, d));
}

async function refreshImpl(ctx: AppContext, deps: ResolvedDeps): Promise<void> {
  const store = ctx.credentialStore;
  const creds = store?.get();
  if (!store || !creds?.refreshToken) return; // nothing to refresh
  const sb = await deps.loadClient();
  let next: { token: string; refreshToken?: string; expiresAt?: number };
  try {
    next = await sb.refresh(creds.serverUrl, creds.refreshToken);
  } catch (err) {
    ctx.logger.warn(
      { kind: 'cloud-refresh', err: err instanceof Error ? err.message : String(err) },
      'token refresh failed; Layer-1 needs re-login',
    );
    teardownCloudSession(ctx);
    return;
  }
  store.rotate({ token: next.token, refreshToken: next.refreshToken, expiresAt: next.expiresAt });
  const refreshed = store.get() as CloudCredentials;
  await rebindSession(ctx, installInputFrom(refreshed, refreshed.token), sb);
  scheduleRefresh(ctx, next.expiresAt, deps);
}
