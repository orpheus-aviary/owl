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
import { isRefreshTokenDead } from './sync/skybridge-errors.js';

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

/**
 * `account_lock='off'`: a different account tried to bind while the currently
 * bound account still has live client sessions (§5.3 — "Y never preempts a
 * live X"). The incumbent must fully log out (or its sessions must lapse)
 * first.
 */
export class AccountBusyError extends Error {
  readonly code = 'ACCOUNT_BUSY';
  constructor() {
    super('another account is in use on this instance; ask them to log out first');
    this.name = 'AccountBusyError';
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

/**
 * Bootstrap helper (A3c) — compute the owner profileId for `account_lock`
 * without standing up the daemon. One-shot login (for the user_id) + serverId,
 * then best-effort revoke the freshly-minted token. Powers `owl-server
 * compute-owner` (the §3.3 ① primary bootstrap path; works even with a
 * server-side AI key configured, since it never starts the service).
 */
export async function computeOwnerProfileId(
  input: { serverUrl: string; email: string; password: string },
  deps: Pick<CloudLoginDeps, 'loadClient'> = {},
): Promise<string> {
  const sb = await (deps.loadClient ?? loadSkybridgeClient)();
  const auth = await sb.login(input.serverUrl, input.email, input.password);
  if (!auth.serverId) throw new SkybridgeServerTooOldError();
  const profileId = computeProfileId(auth.serverId, auth.user.id);
  await bestEffortRemoteLogout(sb, {
    serverUrl: auth.serverUrl,
    token: auth.token,
    user: auth.user,
  });
  return profileId;
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

  // Reaching here means a DIFFERENT account is binding (only possible under
  // account_lock='off' — the locked-owner case is already rejected above).
  // §5.3 release rule: never preempt an incumbent that still has live clients.
  if (current && (ctx.sessionStore?.liveCount() ?? 0) > 0) {
    throw new AccountBusyError();
  }

  let switched = false;
  try {
    const { device, workspace } = await resolveBindingAndSwitch(
      ctx,
      sb,
      authContext,
      profileId,
      () => {
        switched = true;
      },
    );

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

    // Binding a new account: drop any lingering Layer-2 sessions from the prior
    // binding so a stale token can't reach the new account's data. No-op on a
    // first login (nothing minted yet); the gate above guarantees none are live.
    ctx.sessionStore?.revokeAll();

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
    await compensateFailedLogin(ctx, sb, authContext, switched);
    throw err;
  }
}

/**
 * Two-branch device/workspace resolution + switch onto the profile db (design
 * §2.2). Return-visit (db exists) switches first and reuses the persisted
 * device; first-login registers/ensures remotely then switches (creating an
 * empty db). Always ends switched onto `profileId` on success; may throw after
 * switching, so it signals the switch via `markSwitched` for the caller's
 * rollback.
 */
async function resolveBindingAndSwitch(
  ctx: AppContext,
  sb: SkybridgeClientModule,
  authContext: SkybridgeAuthContext,
  profileId: string,
  markSwitched: () => void,
): Promise<{ device: DeviceSection; workspace: { id: string; slug?: string } }> {
  if (existsSync(paths.profileDbPath(profileId))) {
    await switchToProfileId(ctx, profileId, ctx.logger);
    markSwitched();
    const remembered = readSkybridgeDeviceId(ctx.sqlite);
    const device = remembered
      ? synthDevice(sb, remembered)
      : await registerNewDevice(sb, authContext);
    const workspace = await ensureOwlWorkspace(sb, authContext, device.id);
    return { device, workspace };
  }
  const device = await registerNewDevice(sb, authContext);
  const workspace = await ensureOwlWorkspace(sb, authContext, device.id);
  await switchToProfileId(ctx, profileId, ctx.logger);
  markSwitched();
  return { device, workspace };
}

/**
 * Failure compensation (ported from sync-auth.ts:324): revoke the freshly-minted
 * token + return the daemon to a safe baseline (local db) + drop partial state.
 * Never throws.
 */
async function compensateFailedLogin(
  ctx: AppContext,
  sb: SkybridgeClientModule,
  authContext: SkybridgeAuthContext,
  switched: boolean,
): Promise<void> {
  await bestEffortRemoteLogout(sb, authContext);
  if (switched) {
    try {
      await switchToProfileId(ctx, 'local', ctx.logger);
    } catch {
      // best-effort rollback
    }
  }
  teardownCloudSession(ctx);
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
  recoveryAttempts.delete(ctx);
  stopBackgroundHandles(ctx);
  ctx.skybridgeSession = null;
  ctx.credentialStore?.clear();
  ctx.sessionStore?.revokeAll();
}

/**
 * "Log out all" (owner action, §5.3): revoke the skybridge token server-side
 * (best-effort) so it can't be replayed, then run the full Layer-1 teardown.
 * Distinct from a single-session logout, which only drops that client's Layer-2
 * token and leaves the account bound.
 */
export async function logoutAllCloudSessions(ctx: AppContext): Promise<void> {
  const client = ctx.skybridgeSession?.realClient;
  if (client) {
    try {
      await client.logout();
    } catch {
      // best-effort remote revoke — the token expires on its own if this fails
    }
  }
  teardownCloudSession(ctx);
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

// ─── Proactive refresh + recovery ────────────────────────────────────

/** Upper bound on how early we refresh; the real lead is min(this, ttl/2). */
const REFRESH_LEAD_MS = 60_000;
/** Never schedule a zero/negative timeout (0.6.2 W3 / D8). */
const REFRESH_MIN_DELAY_MS = 1_000;
const MAX_TIMEOUT_MS = 2_147_483_647; // 2^31 - 1 (setTimeout 32-bit ceiling)

/**
 * Retry ladder after a TRANSIENT refresh failure (Problem A / Phase 2B).
 * Without it a network blip during the renewal window would leave the daemon
 * with credentials it never retries: the proactive timer is one-shot, and the
 * sync triggers stay silent once the 401 path has dropped the session.
 */
const RECOVERY_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000];

/** Consecutive transient-failure count per ctx; reset on a successful refresh. */
const recoveryAttempts = new WeakMap<AppContext, number>();

/**
 * What a refresh attempt concluded. Callers need the distinction: a transient
 * failure must keep the credentials (and let the recovery timer retry), while
 * `logged_out` means the server has definitively rejected the refresh token and
 * the owner has to log in again.
 *
 * `error` carries the refresh failure itself — a caller that reached here from
 * a sync 401 has two different errors in hand and must not confuse them.
 */
export type RefreshOutcome = 'refreshed' | 'transient_failure' | 'logged_out' | 'no_credentials';

export interface RefreshResult {
  outcome: RefreshOutcome;
  error?: unknown;
}

/**
 * (Re)arm the refresh timer for the given access-token expiry. No-op when the
 * server reported no expiry (relies on re-login). Re-arms itself for delays
 * beyond the 32-bit ceiling so a far-future expiry can't overflow to 1ms.
 */
/**
 * 0.6.2 W3 (D8) — same clamp as the desktop renewal timer, for the same
 * reason: with a fixed 60s lead and a 0 floor, any TTL below 60s produced
 * `delay = 0`, i.e. a refresh every tick. The lead can never exceed half the
 * remaining life, and the delay never drops below 1s.
 */
export function computeRefreshDelayMs(expiresAt: number, now: number): number {
  const ttl = Math.max(0, expiresAt - now);
  const lead = Math.min(REFRESH_LEAD_MS, ttl / 2);
  return Math.max(REFRESH_MIN_DELAY_MS, expiresAt - lead - now);
}

export function scheduleRefresh(
  ctx: AppContext,
  expiresAt: number | undefined,
  deps: CloudLoginDeps = {},
): void {
  clearRefreshTimer(ctx);
  if (!expiresAt) return;
  const d = resolveDeps(deps);
  const delay = computeRefreshDelayMs(expiresAt, d.now());
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
 * Re-arm the refresh timer with the transient-failure backoff ladder. This is
 * the ONLY thing that brings a cloud daemon back after a network blip during
 * renewal, so it must not be skipped on any transient path.
 */
function scheduleRecovery(ctx: AppContext, deps: CloudLoginDeps): void {
  const attempt = recoveryAttempts.get(ctx) ?? 0;
  const delay = RECOVERY_BACKOFF_MS[Math.min(attempt, RECOVERY_BACKOFF_MS.length - 1)];
  recoveryAttempts.set(ctx, attempt + 1);
  clearRefreshTimer(ctx);
  ctx.refreshTimer = setTimeout(() => {
    void refreshCloudSession(ctx, deps);
  }, delay);
  ctx.refreshTimer.unref?.();
  ctx.logger.info(
    { kind: 'cloud-refresh', attempt: attempt + 1, delay_ms: delay },
    'cloud session recovery scheduled',
  );
}

/**
 * Refresh the Layer-1 access token and REBIND the session (rebuild the
 * realClient with the fresh token; design §2.3). Serialised through the login
 * mutex. NEVER throws — the proactive timer calls it fire-and-forget, and the
 * outcome is the return value.
 *
 * Failure handling is three-way (Problem A / Phase 2B). The pre-Problem-A code
 * tore the session down on ANY refresh error, so one flaky minute of network
 * dropped the RAM credentials AND revoked every Layer-2 browser session — the
 * cloud daemon appeared permanently logged out until someone re-logged in by
 * hand. Only an explicit server verdict counts as logged-out now.
 */
export function refreshCloudSession(
  ctx: AppContext,
  deps: CloudLoginDeps = {},
): Promise<RefreshResult> {
  const d = resolveDeps(deps);
  return loginMutex(ctx).run(() => refreshImpl(ctx, d, deps));
}

async function refreshImpl(
  ctx: AppContext,
  deps: ResolvedDeps,
  rawDeps: CloudLoginDeps,
): Promise<RefreshResult> {
  const store = ctx.credentialStore;
  const creds = store?.get();
  if (!store || !creds?.refreshToken) return { outcome: 'no_credentials' };

  let next: { token: string; refreshToken?: string; expiresAt?: number };
  let sb: SkybridgeClientModule;
  try {
    sb = await deps.loadClient();
    next = await sb.refresh(creds.serverUrl, creds.refreshToken);
  } catch (err) {
    if (isRefreshTokenDead(err)) {
      ctx.logger.warn(
        { kind: 'cloud-refresh', err: errorText(err) },
        'refresh token rejected by server; Layer-1 needs re-login',
      );
      teardownCloudSession(ctx);
      return { outcome: 'logged_out', error: err };
    }
    ctx.logger.warn(
      { kind: 'cloud-refresh', err: errorText(err) },
      'token refresh failed transiently; credentials kept, will retry',
    );
    scheduleRecovery(ctx, rawDeps);
    return { outcome: 'transient_failure', error: err };
  }

  store.rotate({ token: next.token, refreshToken: next.refreshToken, expiresAt: next.expiresAt });
  const refreshed = store.get() as CloudCredentials;
  try {
    // Rebinding restarts the background handles; the SSE bridge's own onOpen
    // catch-up covers whatever accumulated while we were unauthenticated, so
    // there is deliberately no extra sync round kicked off here.
    await rebindSession(ctx, installInputFrom(refreshed, refreshed.token), sb);
  } catch (err) {
    // The rotated token is already persisted in the store, so a retry re-reads
    // it; only the install leg failed. Treat as transient.
    ctx.logger.warn(
      { kind: 'cloud-refresh', err: errorText(err) },
      'session rebind after refresh failed; will retry',
    );
    scheduleRecovery(ctx, rawDeps);
    return { outcome: 'transient_failure', error: err };
  }
  recoveryAttempts.delete(ctx);
  scheduleRefresh(ctx, next.expiresAt, rawDeps);
  return { outcome: 'refreshed' };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
