/**
 * P5-d Phase 7/15 — GUI main's sole owner of plaintext skybridge tokens and
 * the only writer of `skybridge_config.toml`.
 *
 * Phase 15 makes login per-profile (design §5.4.1, D11):
 *
 *   - `loginAndOpenSession(input)` —— user submits server URL + email +
 *      password from Settings. Runs from ANY active profile: logging in while
 *      already on an account ADDS the new account and switches to it (the prior
 *      account stays saved for password-free quick-switch, D2 — never revoked).
 *      We:
 *        1. POST /auth/login via the SDK (0.1.4 returns refreshToken +
 *           serverId; token only lives in local scope)
 *        2. require serverId (R5 — a 0.1.4 server); profileId =
 *           hash(server_id, user_id)
 *        3. POST /sync/switch → daemon swaps onto profiles/<id>/owl.db
 *           (created if first login) and returns the remembered
 *           skybridge_device_id (null on a fresh db)
 *        4. reuse that device (§5.3) or registerDevice; ensureWorkspace
 *        5. encrypt access + refresh tokens (safeStorage)
 *        6. POST /sync/session (installs on the switched db)
 *        7. writeProfileConfig([profiles.<id>], setActive) — encrypted_token
 *           + encrypted_refresh_token + device/workspace/server_id
 *      Unwind on any failure: best-effort remote logout + roll the daemon back
 *      to the PRIOR profile (it may have been another account, not just local);
 *      never write toml.
 *
 *   - `logout()` —— full logout (D2): remote-revoke (refresh-then-logout if
 *     the access token has expired) → switch the daemon back to local →
 *     clear the active profile's credentials (keeps device/workspace/server_id
 *     so a re-login reuses the device) → point active_profile at local.
 *
 *   - `restoreSessionOnStartup()` —— refresh-first (Phase 15b): mint a fresh
 *     short access token from the stored refresh token and install the session
 *     (daemon already booted into the active profile db via the resolver);
 *     falls back to a stored access token only for legacy refresh-less toml.
 *
 *   - proactive renewal (Phase 15b): a self-rescheduling timer refreshes ~1min
 *     before `expiresAt`; `maybeRefreshNow()` (wired to powerMonitor resume +
 *     window focus in the main entry) covers a machine that slept past it.
 *
 * `OWL_APP_VERSION` is imported from `@owl/core` so the daemon and GUI always
 * report the same app version through registerDevice.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import {
  ApiError,
  type ApiRefreshResult,
  type AuthContext,
  CLIENT_VERSION,
  NetworkError,
  type SkybridgeClient,
  createSkybridgeClient,
  login as skybridgeLogin,
  refresh as skybridgeRefresh,
} from '@orpheus-aviary/skybridge-client';
import {
  LOCAL_PROFILE,
  OWL_APP_VERSION,
  type ProfileConfigSection,
  ProfileDbMissingError,
  type SkybridgeConfig,
  type SkybridgeDeviceSection,
  clearProfileAuth,
  clearSkybridgeAuth,
  computeProfileId,
  copyLocalProfileDbInto,
  deleteProfileDb,
  inspectLocalProfile,
  newSwitchLockNonce,
  normalizeServerUrl,
  paths,
  readEffectiveActiveProfileId,
  readProfileSection,
  readSkybridgeConfig,
  releaseSwitchLock,
  removeProfile,
  setActiveProfile,
  touchSwitchLock,
  updateActiveProfileAuth,
  updateProfileAuth,
  writeProfileConfig,
  writeSwitchLock,
} from '@owl/core';
import { safeStorage } from 'electron';
import type { LoginAndOpenSessionInput } from '../shared/sync-auth-types.js';
import { promptClaim } from './claim-prompt.js';
import { daemonAuthHeaders } from './daemon-auth.js';
import { getDaemonUrl } from './daemon.js';

export interface SyncSessionSummary {
  server_url: string;
  user_id: string;
  email: string;
  device_id: string;
  workspace_id: string;
}

export class SafeStorageUnavailableError extends Error {
  readonly code = 'SAFE_STORAGE_UNAVAILABLE';
  constructor() {
    super('electron safeStorage is unavailable on this system; cannot encrypt skybridge token');
    this.name = 'SafeStorageUnavailableError';
  }
}

/** The server didn't return a `server_id` → it's older than 0.1.4 (R5). */
export class SkybridgeServerTooOldError extends Error {
  readonly code = 'SKYBRIDGE_SERVER_TOO_OLD';
  constructor() {
    super('this server is too old — owl needs a skybridge 0.1.4+ server (no server_id returned)');
    this.name = 'SkybridgeServerTooOldError';
  }
}

/**
 * P5-d Phase 17 (W4) — a saved profile can't be quick-switched without a
 * password (no usable refresh token / incomplete stored section). The renderer
 * maps this to "请在设置中重新登录".
 */
export class QuickSwitchNeedsLoginError extends Error {
  readonly code = 'QUICK_SWITCH_NEEDS_LOGIN';
  constructor() {
    super('this account needs a password re-login (no usable refresh token)');
    this.name = 'QuickSwitchNeedsLoginError';
  }
}

// ─── proactive token renewal (Phase 15b) ────────────────────────────
//
// 0.1.4 access tokens are short-lived; GUI main keeps the daemon's session
// alive by refreshing slightly before `expiresAt` (we own the refresh token
// in the keychain — the daemon never sees it). The daemon never has to learn
// about renewal: we just re-POST /sync/session with a fresh access token.

const REFRESH_MARGIN_MS = 60_000; // refresh this long before expiry
const REFRESH_MIN_DELAY_MS = 1_000; // never schedule a zero/negative timeout
const REFRESH_RETRY_MS = 30_000; // back off after a transient (network) failure
// setTimeout's 32-bit signed-int ceiling (~24.8 days). A larger delay clamps to
// 1ms and fires immediately, so a long-lived token's renewal must be chunked.
const MAX_TIMER_MS = 2_147_483_647;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Expiry of the currently-installed access token, or null when none. */
let currentExpiresAt: number | null = null;

// ─── profile-switch serialization (Phase 21, layer B) ───────────────
//
// Every top-level op that swaps the daemon's active profile or (re)installs a
// session — login / logout / quick-switch / delete-local-copy / refresh /
// startup-restore — runs through one in-process queue. Two interleaving would
// race the same toml `active_profile` + /sync/session install; a stray refresh
// landing mid-switch could write the prior account's token into the switched-to
// profile. Each body re-reads config, so serialization alone pins every op to
// one consistent active profile. This is the GUI-internal partner of the
// cross-process switch lockfile (Phase 21c) and the daemon's switch-gate.
//
// NON-REENTRANT: a wrapped function must never call another wrapped function
// (it would deadlock waiting on the queue tail it's holding). Verified: the six
// wrapped entries only call private helpers, never each other.

let switchQueue: Promise<unknown> = Promise.resolve();

export function runSwitchExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = switchQueue.then(() => fn());
  // Swallow rejections on the queue tail so one failed op doesn't poison the
  // next; the caller still observes the real rejection via the returned promise.
  switchQueue = run.catch(() => undefined);
  return run;
}

/** Test-only: reset the serialization queue between cases. */
export function __resetSwitchQueueForTests(): void {
  switchQueue = Promise.resolve();
}

// ─── cross-process switch lockfile (Phase 21, layer C / W10) ─────────
//
// Held ONLY across a switch's critical section — the window where the daemon's
// active db and toml `active_profile` can disagree (first /sync/switch → toml
// write, plus the unwind's rollback swap). Pre-switch work (remote login,
// device register, the claim prompt) stays OUTSIDE so an idle user never pins
// the lock. We heartbeat the timestamp so a genuinely slow switch never looks
// stale to a CLI reader; the interval is unref'd so it can't keep the app alive.

const SWITCH_LOCK_HEARTBEAT_MS = 10_000;

/** Acquire the cross-process switch lockfile + heartbeat it; returns a release fn. */
function acquireSwitchLockFile(): () => void {
  const nonce = newSwitchLockNonce();
  writeSwitchLock(nonce);
  const heartbeat = setInterval(() => touchSwitchLock(nonce), SWITCH_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    releaseSwitchLock(nonce);
  };
}

export function loginAndOpenSession(input: LoginAndOpenSessionInput): Promise<SyncSessionSummary> {
  return runSwitchExclusive(() => loginAndOpenSessionImpl(input));
}

async function loginAndOpenSessionImpl(
  input: LoginAndOpenSessionInput,
): Promise<SyncSessionSummary> {
  // safeStorage is process-wide; check once up-front instead of doing the
  // whole login round-trip just to fail at encryption.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new SafeStorageUnavailableError();
  }

  // The profile the daemon is currently on (resolver gate, not raw active, so
  // a ghost is never a rollback destination, ⑤). A successful login switches
  // away from it; any failure restores it — to the PRIOR account, not blindly
  // to local, since we may be adding an account while already on one.
  const prior = readEffectiveActiveProfileId();

  // Step 1 — remote login. auth.token is plaintext, scoped to this fn. A bad
  // password throws HERE, before we touch the daemon or the renewal timer, so
  // the prior account's session keeps auto-renewing untouched.
  const auth = await skybridgeLogin(input.serverUrl, input.email, input.password);

  // Step 2 — require a 0.1.4 server: server_id anchors the profile id (D11/R5).
  // No silent fallback to a url-keyed id.
  if (!auth.serverId) {
    await bestEffortRemoteLogout(auth);
    throw new SkybridgeServerTooOldError();
  }
  const profileId = computeProfileId(auth.serverId, auth.user.id);

  // Now that login succeeded and we're committing to touch the daemon: capture
  // the prior token's expiry, then stop its renewal timer so no stray refresh
  // of the prior account fires into the target's db during the switch window.
  const priorExpiresAt = currentExpiresAt;
  clearRefreshTimer();
  let switched = false;
  // Acquired lazily right before the first /sync/switch (NOT around the claim
  // prompt above it), released in `finally` — covers the toml write + unwind.
  let releaseLock: (() => void) | null = null;
  try {
    // Steps 3–4 split on whether this machine already holds a copy of the
    // account (Phase 16, B9). A first login is the only time a local→account
    // claim is possible, and the claim copy must land on the target db
    // BEFORE the daemon switches onto it — so for a first login we register
    // the device + ensure the workspace (remote-only, daemon db untouched)
    // up front, decide the claim, then switch.
    let device: SkybridgeDeviceSection;
    let workspace: { id: string; slug: string };

    if (existsSync(paths.profileDbPath(profileId))) {
      // Return visit — switch first, reuse the remembered device (§5.3). No
      // claim: the account already has a local copy here.
      releaseLock = acquireSwitchLockFile();
      const { device_id: existingDeviceId } = await postSyncSwitch(profileId);
      switched = true; // daemon is on the target now (Phase 14: throw = abort)
      device = existingDeviceId
        ? reuseDevice(profileId, existingDeviceId)
        : await registerNewDevice(auth);
      workspace = await ensureOwlWorkspace(auth, device.id);
    } else {
      // First login to this account on this machine.
      device = await registerNewDevice(auth);
      const client = createSkybridgeClient({ authContext: auth, deviceId: device.id });
      workspace = await ensureOwlWorkspace(auth, device.id, client);
      // Claim is the ONLY local→account on-ramp (§5.5, D-add-3): offer it only
      // when adding FROM local. Adding an account while on another account
      // never merges the local db.
      if (prior === LOCAL_PROFILE) {
        await maybeClaimLocalInto(client, workspace.id, profileId, auth.user.email);
      }
      releaseLock = acquireSwitchLockFile(); // after the claim prompt, before the swap
      await postSyncSwitch(profileId); // opens the claimed copy, or creates empty
      switched = true;
    }

    // Step 5 — encrypt access (+ refresh) before any HTTP / disk write, so a
    // keychain failure surfaces before the token travels and the toml never
    // holds plaintext.
    const encryptedToken = safeStorage.encryptString(auth.token).toString('base64');
    const encryptedRefresh = auth.refreshToken
      ? safeStorage.encryptString(auth.refreshToken).toString('base64')
      : undefined;

    // Step 6 — install the session on the (already-switched) profile db.
    await postSyncSession({
      token: auth.token,
      user_id: auth.user.id,
      email: auth.user.email,
      server_url: auth.serverUrl,
      device,
      workspace,
    });

    // Step 7 — persist [profiles.<id>] + active_profile (GUI main is the sole
    // toml writer; the daemon never writes toml). The profile db now exists
    // (step 3), so setActive passes its existence guard.
    const section: ProfileConfigSection = {
      server_id: auth.serverId,
      server_url: normalizeServerUrl(auth.serverUrl),
      user_id: auth.user.id,
      email: auth.user.email,
      encrypted_token: encryptedToken,
      device,
      workspace,
    };
    if (encryptedRefresh) section.encrypted_refresh_token = encryptedRefresh;
    writeProfileConfig(profileId, section, { setActive: true });

    scheduleRefresh(auth.expiresAt);

    return {
      server_url: auth.serverUrl,
      user_id: auth.user.id,
      email: auth.user.email,
      device_id: device.id,
      workspace_id: workspace.id,
    };
  } catch (err) {
    // Unwind: revoke the freshly-issued token, and return the daemon to the
    // PRIOR profile — precise rollback if we'd already switched onto the target,
    // else just restore the prior account's renewal timer (the daemon never
    // moved). From local this rolls back to local (equivalent to the old
    // bestEffortSwitchLocal). Never write toml — persisted state is unchanged.
    await bestEffortRemoteLogout(auth);
    if (switched) await rollbackToPrior(prior, priorExpiresAt);
    else reschedulePrior(prior, priorExpiresAt);
    throw err;
  } finally {
    releaseLock?.();
  }
  // auth.token falls out of scope here.
}

export function logout(): Promise<void> {
  return runSwitchExclusive(logoutImpl);
}

async function logoutImpl(): Promise<void> {
  // Stop renewing immediately — no timer should fire mid-logout.
  clearRefreshTimer();

  const cfg = safeReadConfig();

  // 1. Full logout (D2): revoke the refresh-token family server-side. If the
  //    stored access token has expired, refresh once to mint a fresh access
  //    and revoke with that — otherwise the family would survive locally-only.
  if (cfg?.auth) {
    await remoteRevoke(cfg);
  }

  // Critical section: the daemon swap → toml write window (remoteRevoke above
  // doesn't move the daemon, so it stays outside the lock).
  const releaseLock = acquireSwitchLockFile();
  try {
    // 2. Return the daemon to local — switchProfile clears its in-memory
    //    session as part of the swap. Survives a daemon that's already down.
    await bestEffortSwitchLocal();

    // 3. Clear the active profile's credentials (keeps device/workspace/server_id
    //    so a re-login reuses the device, §5.3) and repoint active_profile at
    //    local. We do NOT clearSyncIdentity (that would drop the db's remembered
    //    skybridge_device_id) and do NOT remove the [profiles.<id>] section
    //    (deleting the local copy is a separate destructive action, Phase 17).
    clearSkybridgeAuth();
    setActiveProfile(LOCAL_PROFILE);
  } finally {
    releaseLock();
  }
}

/**
 * P5-d Phase 17 (W4) — password-free quick switch to a saved profile (or back
 * to local). The headliner of Phase 17; it generalises `restoreSessionOnStartup`'s
 * refresh path to "switch onto any specific profile", with the timer / rotation /
 * rollback boundaries the three review rounds nailed down:
 *
 *   - ① stop the prior profile's renewal timer on entry (after the no-op
 *     check), so a stray `refreshSession` can't install the prior account's
 *     session into the target's db during the switch window. `priorExpiresAt`
 *     is captured so any failure path can restore it.
 *   - ② persist the rotated ciphertext to the *target* profile (by id) BEFORE
 *     the daemon switches — a switch/install failure then leaves the target
 *     re-switchable instead of dead (its old refresh token is already gone).
 *   - ⑤ all active/prior decisions use the *effective* active id (resolver
 *     gate), never the raw `active_profile`, so a ghost can't be the target or
 *     a rollback destination.
 *   - ⑥ the whole account branch is one catch: an early failure (no db / bad
 *     section / dead refresh / persist write) reschedules the prior timer; a
 *     post-switch failure rolls the daemon back to prior.
 *   - ⑩ a main-side `existsSync` gate (before refresh) refuses a section whose
 *     db is missing — `/sync/switch` would otherwise mkdir + create an empty db.
 *
 * Switching to `local` is "step away" (D2): keep the prior account's tokens,
 * never revoke — re-entry is password-free. A full logout (revoke) stays the
 * Settings `logout()` action.
 */
export function switchToProfile(targetId: string): Promise<void> {
  return runSwitchExclusive(() => switchToProfileImpl(targetId));
}

async function switchToProfileImpl(targetId: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new SafeStorageUnavailableError();

  const prior = readEffectiveActiveProfileId();
  if (targetId === prior) return; // already here — leave the timer alone

  const priorExpiresAt = currentExpiresAt; // capture before clear (rollback/reschedule)
  clearRefreshTimer();

  if (targetId === LOCAL_PROFILE) {
    const releaseLock = acquireSwitchLockFile();
    try {
      await postSyncSwitch(LOCAL_PROFILE); // daemon opens owl/owl.db + clears session
      setActiveProfile(LOCAL_PROFILE); // keep [profiles.<prior>] (tokens stay)
    } catch (err) {
      reschedulePrior(prior, priorExpiresAt);
      throw err;
    } finally {
      releaseLock();
    }
    return; // local has no renewal — leave the timer stopped
  }

  // Account target — refresh-first + persist-first; whole branch in one catch.
  let switched = false;
  // Acquired after planQuickSwitch (a remote refresh that doesn't move the
  // daemon), right before the swap; released in `finally`.
  let releaseLock: (() => void) | null = null;
  try {
    // ⑩ main-side hard gate (authoritative, before refresh): never let a
    // db-less section reach /sync/switch and get revived into an empty db.
    if (!existsSync(paths.profileDbPath(targetId))) {
      throw new ProfileDbMissingError(targetId);
    }
    const plan = await planQuickSwitch(targetId); // refresh + persist-first
    releaseLock = acquireSwitchLockFile();
    await postSyncSwitch(targetId); // Phase 14: throw = abort, daemon stays on prior
    switched = true;
    await installSessionFor(targetId, plan); // session + setActive + reschedule
  } catch (err) {
    if (switched) await rollbackToPrior(prior, priorExpiresAt);
    else reschedulePrior(prior, priorExpiresAt);
    throw err;
  } finally {
    releaseLock?.();
  }
}

/** What `planQuickSwitch` resolves to: a rotated token + session-ready fields. */
interface SwitchPlan {
  rotated: ApiRefreshResult;
  sessionBase: {
    user_id: string;
    email: string;
    server_url: string;
    device: SkybridgeDeviceSection;
    workspace: { id: string; slug: string };
  };
}

/**
 * Refresh a stored profile's access token and persist the rotated ciphertext to
 * THAT profile's section by id (②, before any daemon switch). Throws
 * `QuickSwitchNeedsLoginError` when the section is incomplete / has no refresh
 * token; a dead refresh token clears the section's creds (so Settings shows
 * "needs re-login") and rethrows.
 */
async function planQuickSwitch(profileId: string): Promise<SwitchPlan> {
  const section = readProfileSection(profileId);
  const device = section?.device;
  const workspace = section?.workspace;
  if (
    !section?.user_id ||
    !section.email ||
    !section.server_url ||
    !device?.id ||
    !device.name ||
    !workspace?.id
  ) {
    throw new QuickSwitchNeedsLoginError();
  }
  const refreshTok = decryptB64(section.encrypted_refresh_token);
  if (!refreshTok) throw new QuickSwitchNeedsLoginError();

  let rotated: ApiRefreshResult;
  try {
    rotated = await skybridgeRefresh(section.server_url, refreshTok);
  } catch (err) {
    if (isRefreshDead(err)) clearProfileAuth(profileId); // mark "needs re-login"
    throw err;
  }
  // ② persist-first — store the rotated ciphertext on the TARGET section by id
  // (it isn't active yet, so updateActiveProfileAuth can't reach it).
  updateProfileAuth(profileId, {
    encrypted_token: safeStorage.encryptString(rotated.token).toString('base64'),
    encrypted_refresh_token: safeStorage.encryptString(rotated.refreshToken).toString('base64'),
  });
  return {
    rotated,
    sessionBase: {
      user_id: section.user_id,
      email: section.email,
      server_url: section.server_url,
      device,
      workspace: { id: workspace.id, slug: workspace.slug },
    },
  };
}

/** Install a planned session on the (already-switched) profile db + activate it. */
async function installSessionFor(profileId: string, plan: SwitchPlan): Promise<void> {
  await postSyncSession({ token: plan.rotated.token, ...plan.sessionBase });
  setActiveProfile(profileId); // db exists (we switched onto it) → passes the gate
  scheduleRefresh(plan.rotated.expiresAt);
}

/**
 * Restore the prior profile's renewal timer after a switch that never moved the
 * daemon. local has no renewal; a null expiry means there was nothing to
 * restore — never pass null to `scheduleRefresh` (`null - Date.now()` is NaN).
 */
function reschedulePrior(prior: string, priorExpiresAt: number | null): void {
  if (prior === LOCAL_PROFILE || priorExpiresAt === null) return;
  scheduleRefresh(priorExpiresAt);
}

/**
 * Best-effort precise rollback to the prior profile after a post-switch failure
 * (daemon is on the target but the session install failed). Puts the daemon +
 * session + timer back; on a deeper failure, at least restores the prior timer.
 */
async function rollbackToPrior(prior: string, priorExpiresAt: number | null): Promise<void> {
  if (prior === LOCAL_PROFILE) {
    try {
      await postSyncSwitch(LOCAL_PROFILE);
      setActiveProfile(LOCAL_PROFILE);
    } catch {
      // best-effort — daemon may be down; toml/next boot wins
    }
    clearRefreshTimer();
    return;
  }
  try {
    await postSyncSwitch(prior);
    const plan = await planQuickSwitch(prior); // prior creds untouched → still valid
    await installSessionFor(prior, plan);
  } catch {
    reschedulePrior(prior, priorExpiresAt); // a later tick / focus recovers
  }
}

/**
 * P5-d Phase 17 (delete-local-copy) — destructive: remove an account's local
 * copy on THIS machine (its db files + toml section) and clean it up remotely
 * (revoke device + token family). Two paths:
 *
 *   - active profile → release the daemon's db handle FIRST (④): a successful
 *     `postSyncSwitchStrict(local)` is required, or the daemon must be
 *     definitively unreachable (NetworkError → no handle held). An HTTP failure
 *     ABORTS the delete and restores the renewal timer — never delete a db the
 *     daemon might still have open.
 *   - non-active profile → no daemon move; the db isn't open here.
 *
 * Remote teardown is best-effort (device-first / logout-last, refresh-only ok).
 * Returns `{ wasActive }` so the IPC layer reloads the renderer only when the
 * deletion changed the active profile.
 */
export function deleteProfileLocalCopy(targetId: string): Promise<{ wasActive: boolean }> {
  return runSwitchExclusive(() => deleteProfileLocalCopyImpl(targetId));
}

async function deleteProfileLocalCopyImpl(targetId: string): Promise<{ wasActive: boolean }> {
  // Read the stored creds before anything clears them — needed for remote cleanup.
  const section = readProfileSection(targetId);
  const wasActive = readEffectiveActiveProfileId() === targetId;

  if (wasActive) {
    const activeExpiresAt = currentExpiresAt;
    clearRefreshTimer();
    // Critical section: the daemon swap → toml write. The remote revoke + db
    // delete below run after the daemon is consistently on local (no divergence).
    const releaseLock = acquireSwitchLockFile();
    try {
      try {
        await postSyncSwitchStrict(LOCAL_PROFILE); // ④ hard handle release
      } catch (err) {
        if (!(err instanceof NetworkError)) {
          // daemon up but the switch failed → it may still hold the db → abort.
          if (activeExpiresAt !== null) scheduleRefresh(activeExpiresAt);
          throw err;
        }
        // NetworkError → daemon unreachable → no handle held → safe to continue.
      }
      setActiveProfile(LOCAL_PROFILE);
    } finally {
      releaseLock();
    }
  }

  if (section) {
    await bestEffortRevokeProfile({
      serverUrl: section.server_url,
      user: { id: section.user_id ?? '', email: section.email ?? '', displayName: null },
      encryptedAccess: section.encrypted_token,
      encryptedRefresh: section.encrypted_refresh_token,
      deviceId: section.device?.id,
    });
  }
  deleteProfileDb(targetId);
  removeProfile(targetId);
  return { wasActive };
}

export function restoreSessionOnStartup(): Promise<SyncSessionSummary | null> {
  return runSwitchExclusive(restoreSessionOnStartupImpl);
}

async function restoreSessionOnStartupImpl(): Promise<SyncSessionSummary | null> {
  const cfg = safeReadConfig();
  if (!cfg?.auth?.user_id || !cfg.auth.email) return null;
  if (!cfg.device?.id || !cfg.device.name) return null;
  if (!cfg.workspace?.id) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;

  // The daemon already booted into the active profile db (resolver), so we
  // only install the session — no switch needed.
  const summary: SyncSessionSummary = {
    server_url: cfg.server.url,
    user_id: cfg.auth.user_id,
    email: cfg.auth.email,
    device_id: cfg.device.id,
    workspace_id: cfg.workspace.id,
  };
  const sessionBase = {
    user_id: cfg.auth.user_id,
    email: cfg.auth.email,
    server_url: cfg.server.url,
    device: cfg.device,
    workspace: { id: cfg.workspace.id, slug: cfg.workspace.slug },
  };

  // Refresh-first: 0.1.4 access tokens are short-lived, so mint a fresh one
  // from the stored refresh token and start the renewal timer.
  const refreshTok = decryptB64(cfg.auth.encrypted_refresh_token);
  if (refreshTok) {
    let rotated: ApiRefreshResult;
    try {
      rotated = await skybridgeRefresh(cfg.server.url, refreshTok);
    } catch (err) {
      // Dead refresh token → drop the stale creds so the user gets a clean
      // re-login (the device memory in the db is kept). Network / unknown →
      // stay offline but keep the token; a focus/resume retries.
      if (isRefreshDead(err)) clearSkybridgeAuth();
      return null;
    }
    persistRotated(rotated);
    await postSyncSession({ token: rotated.token, ...sessionBase });
    scheduleRefresh(rotated.expiresAt);
    return summary;
  }

  // Legacy access path — encrypted_token only, no refresh token (predates D2).
  // No renewal timer (we can't refresh); the session lives until the token
  // expires, then the user re-logs in.
  const token = decryptB64(cfg.auth.encrypted_token);
  if (!token) return null;
  await postSyncSession({ token, ...sessionBase });
  return summary;
}

/**
 * Refresh the access token now and re-install the session (daemon stays on the
 * active profile db — no switch). Rotates the stored refresh token and
 * reschedules the next renewal. Shared by the timer and the resume/focus
 * triggers. A dead refresh token stops renewal (user re-logs in); a transient
 * network failure backs off and retries.
 */
// Routed through the switch queue so a refresh can never interleave with a
// profile switch: `refreshSessionImpl` re-reads config at its top, so under the
// queue it always targets whatever profile is active *now*, never a stale one
// captured before a switch (layer B, Phase 21).
function refreshSession(): Promise<void> {
  return runSwitchExclusive(refreshSessionImpl);
}

async function refreshSessionImpl(): Promise<void> {
  const cfg = safeReadConfig();
  const refreshTok = decryptB64(cfg?.auth?.encrypted_refresh_token);
  if (
    !cfg?.auth?.user_id ||
    !cfg.auth.email ||
    !cfg.device?.id ||
    !cfg.workspace?.id ||
    !refreshTok
  ) {
    clearRefreshTimer();
    return;
  }

  let rotated: ApiRefreshResult;
  try {
    rotated = await skybridgeRefresh(cfg.server.url, refreshTok);
  } catch (err) {
    if (isRefreshDead(err)) {
      clearRefreshTimer(); // refresh token gone → user must log in again
      return;
    }
    scheduleRefreshIn(REFRESH_RETRY_MS); // transient → back off + retry
    return;
  }

  persistRotated(rotated);
  await postSyncSession({
    token: rotated.token,
    user_id: cfg.auth.user_id,
    email: cfg.auth.email,
    server_url: cfg.server.url,
    device: cfg.device,
    workspace: { id: cfg.workspace.id, slug: cfg.workspace.slug },
  });
  scheduleRefresh(rotated.expiresAt);
}

/**
 * Renew now if the installed access token is at/near expiry. Wired to
 * `powerMonitor` resume + window focus in the main entry, so a machine that
 * slept past a scheduled timer recovers as soon as the user comes back.
 */
export async function maybeRefreshNow(): Promise<void> {
  if (currentExpiresAt === null) return; // no renewable session
  if (Date.now() < currentExpiresAt - REFRESH_MARGIN_MS) return; // still fresh
  await refreshSession();
}

/** Cancel any pending renewal (logout / dead refresh / no session). */
export function clearRefreshTimer(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  currentExpiresAt = null;
}

function scheduleRefresh(expiresAt?: number): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  currentExpiresAt = expiresAt ?? null;
  if (expiresAt === undefined) return;
  const delay = Math.max(REFRESH_MIN_DELAY_MS, expiresAt - Date.now() - REFRESH_MARGIN_MS);
  scheduleRefreshIn(delay);
}

function scheduleRefreshIn(delayMs: number): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  // setTimeout's delay is a 32-bit signed int; a larger value silently clamps
  // to 1ms and fires immediately. Access tokens are long-lived (the server's
  // default TTL is 30 days), so `expiresAt - now - margin` routinely exceeds
  // this ceiling. When it does, sleep the max, then re-evaluate the remaining
  // delay against `currentExpiresAt` and re-arm — instead of refreshing in a
  // tight 1ms loop.
  if (delayMs > MAX_TIMER_MS) {
    refreshTimer = setTimeout(() => {
      if (currentExpiresAt !== null) scheduleRefresh(currentExpiresAt);
    }, MAX_TIMER_MS);
  } else {
    refreshTimer = setTimeout(() => {
      void refreshSession();
    }, delayMs);
  }
  // Don't keep the process alive just for the renewal timer.
  refreshTimer.unref?.();
}

function persistRotated(rotated: ApiRefreshResult): void {
  updateActiveProfileAuth({
    encrypted_token: safeStorage.encryptString(rotated.token).toString('base64'),
    encrypted_refresh_token: safeStorage.encryptString(rotated.refreshToken).toString('base64'),
  });
}

function isRefreshDead(err: unknown): boolean {
  return (
    err instanceof ApiError && (err.code === 'REFRESH_INVALID' || err.code === 'REFRESH_REPLAYED')
  );
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * ensureWorkspace('owl','default') → the owl-shaped `{ id, slug }`. ApiWorkspace
 * exposes tool + name (not slug); synthesise "<tool>/<name>" so toml + daemon
 * stay in the pre-Phase-7 format. Reuses `client` when the caller already built
 * a device-bound one (avoids a second client).
 */
async function ensureOwlWorkspace(
  auth: AuthContext,
  deviceId: string,
  client?: SkybridgeClient,
): Promise<{ id: string; slug: string }> {
  const c = client ?? createSkybridgeClient({ authContext: auth, deviceId });
  const ws = await c.ensureWorkspace('owl', 'default');
  return { id: ws.id, slug: `${ws.tool}/${ws.name}` };
}

/**
 * Phase 16 (D10b): on a first login to an *empty* account that has local
 * notes, ask the user to merge (whole-db claim) or stay independent. On
 * "merge" copy `owl/owl.db` → the target profile db BEFORE the switch (B9),
 * so `switchProfile` opens the claimed copy. No-op for a non-empty account
 * (pure pull, never merges local) or an empty local. Account sync never
 * writes the local db (D10b invariant).
 */
async function maybeClaimLocalInto(
  client: SkybridgeClient,
  workspaceId: string,
  profileId: string,
  email: string,
): Promise<void> {
  if (!(await isAccountEmpty(client, workspaceId))) return;
  const local = inspectLocalProfile();
  if (local.noteCount === 0) return;
  const choice = await promptClaim({
    email,
    localCount: local.noteCount,
    hasSyncTraces: local.hasSyncTraces,
  });
  if (choice !== 'merge') return;
  const target = paths.profileDbPath(profileId);
  mkdirSync(dirname(target), { recursive: true });
  await copyLocalProfileDbInto(target);
}

/** An account is empty when its change-log has nothing (latestSeq 0, no rows). */
async function isAccountEmpty(client: SkybridgeClient, workspaceId: string): Promise<boolean> {
  const res = await client.pullChanges(workspaceId, 0, 1);
  return res.latestSeq === 0 && res.changes.length === 0;
}

/** Reuse a remembered device: read its stored meta, else synth (§5.3). */
function reuseDevice(profileId: string, deviceId: string): SkybridgeDeviceSection {
  const stored = readProfileSection(profileId)?.device;
  if (stored) return stored;
  // No stored section (e.g. db remembered the id but toml was cleared) → synth.
  // The name is display-only and hostname-deterministic, so it stays stable.
  return {
    id: deviceId,
    name: defaultDeviceName(),
    app_version: `owl ${OWL_APP_VERSION}`,
    client_version: CLIENT_VERSION,
  };
}

async function registerNewDevice(auth: AuthContext): Promise<SkybridgeDeviceSection> {
  const seed = createSkybridgeClient({ authContext: auth });
  const device = await seed.registerDevice({
    name: defaultDeviceName(),
    appVersion: `owl ${OWL_APP_VERSION}`,
    clientVersion: CLIENT_VERSION,
  });
  return {
    id: device.id,
    name: device.name,
    app_version: `owl ${OWL_APP_VERSION}`,
    client_version: CLIENT_VERSION,
  };
}

interface SyncSessionPayload {
  token: string;
  user_id: string;
  email: string;
  server_url: string;
  device: { id: string; name: string; app_version?: string; client_version?: string };
  workspace: { id: string; slug?: string };
}

async function postSyncSession(payload: SyncSessionPayload): Promise<void> {
  const res = await fetch(`${getDaemonUrl()}/sync/session`, {
    method: 'POST',
    headers: { ...daemonAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`daemon /sync/session returned HTTP ${res.status}`);
  }
}

/** Switch the daemon onto a profile db; returns the remembered device id. */
async function postSyncSwitch(profileId: string): Promise<{ device_id: string | null }> {
  const res = await fetch(`${getDaemonUrl()}/sync/switch`, {
    method: 'POST',
    headers: { ...daemonAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_id: profileId }),
  });
  if (!res.ok) {
    throw new Error(`daemon /sync/switch returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: { device_id?: string | null } };
  return { device_id: body.data?.device_id ?? null };
}

async function bestEffortSwitchLocal(): Promise<void> {
  try {
    await postSyncSwitch(LOCAL_PROFILE);
  } catch {
    // best-effort — daemon may be down; the toml's active_profile (set to
    // local by the caller on logout) wins on the next boot.
  }
}

/**
 * P5-d Phase 17 (delete-local-copy) — switch the daemon onto a profile, but
 * surface failures the active-delete handle-release gate needs to tell apart:
 * a non-2xx throws a plain Error (daemon is up but the switch failed → it may
 * still hold the db handle → the caller MUST abort the delete), while a bare
 * fetch failure is wrapped as NetworkError (daemon unreachable → no handle held
 * → safe to continue). Unlike `bestEffortSwitchLocal`, it never swallows.
 */
async function postSyncSwitchStrict(profileId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${getDaemonUrl()}/sync/switch`, {
      method: 'POST',
      headers: { ...daemonAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId }),
    });
  } catch (err) {
    throw new NetworkError(
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err : undefined,
    );
  }
  if (!res.ok) throw new Error(`daemon /sync/switch returned HTTP ${res.status}`);
}

async function bestEffortRemoteLogout(auth: AuthContext): Promise<void> {
  try {
    const client = createSkybridgeClient({ authContext: auth });
    await client.logout();
  } catch {
    // best-effort; server may be unreachable or token already revoked
  }
}

/**
 * P5-d Phase 17 — best-effort remote teardown for a profile, shared by full
 * logout and delete-local-copy. **device-first, logout-last** (③): `logout()`
 * kills the token family, after which the same token 401s, so a device revoke
 * must precede it (the skybridge SDK smoke test verifies this). Obtains a usable
 * access token from the stored one, refreshing once on a missing / expired
 * access — refresh-only profiles work too (⑨). Every step is swallowed; the
 * caller's local cleanup proceeds regardless.
 */
async function bestEffortRevokeProfile(input: {
  serverUrl: string;
  user: { id: string; email: string; displayName: null };
  encryptedAccess?: string;
  encryptedRefresh?: string;
  deviceId?: string;
}): Promise<void> {
  const { serverUrl, user, deviceId } = input;
  const refreshTok = decryptB64(input.encryptedRefresh);
  let access = decryptB64(input.encryptedAccess);

  const makeClient = (token: string) =>
    createSkybridgeClient({ authContext: { serverUrl, token, user } });

  // Run an authenticated action, refreshing once on a missing / expired access.
  // `access` is updated to the refreshed token so a later action reuses it.
  const withAccess = async (action: (client: SkybridgeClient) => Promise<void>): Promise<void> => {
    if (access) {
      try {
        await action(makeClient(access));
        return;
      } catch (err) {
        if (!isTokenExpired(err)) return; // network / already-dead → best-effort
        // expired → refresh below
      }
    }
    if (!refreshTok) return;
    try {
      access = (await skybridgeRefresh(serverUrl, refreshTok)).token;
    } catch {
      return; // dead / network refresh → give up the remote step
    }
    try {
      await action(makeClient(access));
    } catch {
      // best-effort
    }
  };

  if (deviceId) await withAccess((c) => c.revokeDevice(deviceId)); // ③ device-first
  await withAccess((c) => c.logout()); // logout-last (revokes the family)
}

/**
 * Revoke the refresh-token family server-side for a full logout (D2). Keeps the
 * device row (so a re-login reuses it, §5.3) → no deviceId, logout only.
 */
async function remoteRevoke(cfg: SkybridgeConfig): Promise<void> {
  if (!cfg.auth) return;
  await bestEffortRevokeProfile({
    serverUrl: cfg.server.url,
    user: { id: cfg.auth.user_id, email: cfg.auth.email, displayName: null },
    encryptedAccess: cfg.auth.encrypted_token,
    encryptedRefresh: cfg.auth.encrypted_refresh_token,
  });
}

function isTokenExpired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'TOKEN_EXPIRED';
}

/** Decrypt a base64 safeStorage ciphertext, or null on any failure. */
function decryptB64(ciphertext?: string): string | null {
  if (!ciphertext || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  } catch {
    return null;
  }
}

function defaultDeviceName(): string {
  const host = hostname();
  return host ? `${host} (owl)` : 'owl device';
}

function safeReadConfig(): SkybridgeConfig | null {
  try {
    return readSkybridgeConfig();
  } catch {
    return null;
  }
}
