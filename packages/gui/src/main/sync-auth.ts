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

import { existsSync } from 'node:fs';
import {
  type ApiRefreshResult,
  NetworkError,
  createSkybridgeClient,
  login as skybridgeLogin,
  refresh as skybridgeRefresh,
} from '@orpheus-aviary/skybridge-client';
import {
  LOCAL_PROFILE,
  type ProfileConfigSection,
  ProfileDbMissingError,
  type SkybridgeDeviceSection,
  clearProfileAuth,
  clearSkybridgeAuth,
  computeProfileId,
  deleteProfileDb,
  newSwitchLockNonce,
  normalizeServerUrl,
  paths,
  readEffectiveActiveProfileId,
  readProfileSection,
  releaseSwitchLock,
  removeProfile,
  setActiveProfile,
  touchSwitchLock,
  updateProfileAuth,
  writeProfileConfig,
  writeSwitchLock,
} from '@owl/core';
import { safeStorage } from 'electron';
import type { LoginAndOpenSessionInput } from '../shared/sync-auth-types.js';
import {
  QuickSwitchNeedsLoginError,
  SafeStorageUnavailableError,
  SkybridgeServerTooOldError,
  type SyncSessionSummary,
  decryptB64,
  safeReadConfig,
} from './sync-auth-crypto.js';
import { bumpRecoveryGeneration } from './sync-auth-recovery.js';
import {
  clearRefreshTimer,
  getCurrentExpiresAt,
  isRefreshDead,
  persistRotated,
  scheduleRefresh,
} from './sync-auth-renewal.js';
import {
  bestEffortRemoteLogout,
  bestEffortRevokeProfile,
  bestEffortSwitchLocal,
  ensureOwlWorkspace,
  maybeClaimLocalInto,
  postAuthUnrecoverable,
  postSyncSession,
  postSyncSwitch,
  postSyncSwitchStrict,
  registerNewDevice,
  remoteRevoke,
  reuseDevice,
} from './sync-auth-transport.js';
import { runSwitchExclusive } from './sync-switch-queue.js';

// Re-export the public surface that moved to sibling modules so the two runtime
// consumers (sync-ipc.ts, index.ts) + the test import path stay unchanged.
export {
  QuickSwitchNeedsLoginError,
  SafeStorageUnavailableError,
  SkybridgeServerTooOldError,
  type SyncSessionSummary,
} from './sync-auth-crypto.js';
export { clearRefreshTimer, maybeRefreshNow } from './sync-auth-renewal.js';
export { __resetSwitchQueueForTests, runSwitchExclusive } from './sync-switch-queue.js';

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
  const priorExpiresAt = getCurrentExpiresAt();
  clearRefreshTimer();
  // 0.6.2 W3 — invalidate any in-flight / scheduled auth recovery: it belongs
  // to the account we are leaving, and letting it land after the switch would
  // refresh (or re-install) the wrong profile.
  bumpRecoveryGeneration();
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
  bumpRecoveryGeneration(); // W3: and no recovery should resurrect the session

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

  const priorExpiresAt = getCurrentExpiresAt(); // capture before clear (rollback/reschedule)
  clearRefreshTimer();
  bumpRecoveryGeneration(); // W3: drop recovery aimed at the profile we leave

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
    const activeExpiresAt = getCurrentExpiresAt();
    clearRefreshTimer();
    bumpRecoveryGeneration(); // W3: the profile is about to stop existing
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
      // 0.6.2 W3: also tell the daemon, or it keeps reporting whatever it had
      // (and the UI keeps promising an automatic recovery that can't happen).
      if (isRefreshDead(err)) {
        clearSkybridgeAuth();
        await postAuthUnrecoverable();
      }
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
