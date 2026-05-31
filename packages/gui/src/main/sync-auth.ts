/**
 * P5-d Phase 7/15 — GUI main's sole owner of plaintext skybridge tokens and
 * the only writer of `skybridge_config.toml`.
 *
 * Phase 15 makes login per-profile (design §5.4.1, D11):
 *
 *   - `loginAndOpenSession(input)` —— user submits server URL + email +
 *      password from Settings. We:
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
 *      Unwind on any failure: best-effort remote logout + return the daemon
 *      to local; never write toml.
 *
 *   - `logout()` —— full logout (D2): remote-revoke (refresh-then-logout if
 *     the access token has expired) → switch the daemon back to local →
 *     clear the active profile's credentials (keeps device/workspace/server_id
 *     so a re-login reuses the device) → point active_profile at local.
 *
 *   - `restoreSessionOnStartup()` —— reads the active profile's
 *     encrypted_token and installs the session (daemon already booted into
 *     the active profile db via the resolver). Refresh-first restore +
 *     proactive renewal land in Phase 15b.
 *
 * `OWL_APP_VERSION` is imported from `@owl/core` so the daemon and GUI always
 * report the same app version through registerDevice.
 */

import { hostname } from 'node:os';
import {
  ApiError,
  type AuthContext,
  CLIENT_VERSION,
  createSkybridgeClient,
  login as skybridgeLogin,
  refresh as skybridgeRefresh,
} from '@orpheus-aviary/skybridge-client';
import {
  LOCAL_PROFILE,
  OWL_APP_VERSION,
  type ProfileConfigSection,
  type SkybridgeConfig,
  type SkybridgeDeviceSection,
  clearSkybridgeAuth,
  computeProfileId,
  normalizeServerUrl,
  readProfileSection,
  readSkybridgeConfig,
  setActiveProfile,
  writeProfileConfig,
} from '@owl/core';
import { safeStorage } from 'electron';
import type { LoginAndOpenSessionInput } from '../shared/sync-auth-types.js';
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

export async function loginAndOpenSession(
  input: LoginAndOpenSessionInput,
): Promise<SyncSessionSummary> {
  // safeStorage is process-wide; check once up-front instead of doing the
  // whole login round-trip just to fail at encryption.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new SafeStorageUnavailableError();
  }

  // Step 1 — remote login. auth.token is plaintext, scoped to this fn.
  const auth = await skybridgeLogin(input.serverUrl, input.email, input.password);

  // Step 2 — require a 0.1.4 server: server_id anchors the profile id (D11/R5).
  // No silent fallback to a url-keyed id.
  if (!auth.serverId) {
    await bestEffortRemoteLogout(auth);
    throw new SkybridgeServerTooOldError();
  }
  const profileId = computeProfileId(auth.serverId, auth.user.id);

  try {
    // Step 3 — switch the daemon onto this profile's db (created if first
    // login). Returns the remembered device id (null on a fresh db).
    const { device_id: existingDeviceId } = await postSyncSwitch(profileId);

    // Step 4 — reuse the remembered device (§5.3) or register a new one.
    const device = existingDeviceId
      ? reuseDevice(profileId, existingDeviceId)
      : await registerNewDevice(auth);
    const withDevice = createSkybridgeClient({ authContext: auth, deviceId: device.id });
    const ws = await withDevice.ensureWorkspace('owl', 'default');
    // ApiWorkspace exposes tool + name, not slug; synthesise the owl-shaped
    // "<tool>/<name>" slug so toml + daemon stay in the pre-Phase-7 format.
    const workspace = { id: ws.id, slug: `${ws.tool}/${ws.name}` };

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

    return {
      server_url: auth.serverUrl,
      user_id: auth.user.id,
      email: auth.user.email,
      device_id: device.id,
      workspace_id: ws.id,
    };
  } catch (err) {
    // Unwind: revoke the freshly-issued token, and return the daemon to local
    // (15a rolls back to local; precise rollback to the prior profile is
    // Phase 17). Never write toml — the caller's persisted state is unchanged.
    await bestEffortRemoteLogout(auth);
    await bestEffortSwitchLocal();
    throw err;
  }
  // auth.token falls out of scope here.
}

export async function logout(): Promise<void> {
  const cfg = safeReadConfig();

  // 1. Full logout (D2): revoke the refresh-token family server-side. If the
  //    stored access token has expired, refresh once to mint a fresh access
  //    and revoke with that — otherwise the family would survive locally-only.
  if (cfg?.auth) {
    await remoteRevoke(cfg);
  }

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
}

export async function restoreSessionOnStartup(): Promise<SyncSessionSummary | null> {
  const cfg = safeReadConfig();
  if (!cfg) return null;

  // Encrypted-only — legacy plaintext [auth].token is never promoted through
  // GUI startup (plaintext stays out of the keychain code path).
  if (!cfg.auth?.encrypted_token) return null;
  if (!cfg.auth.user_id || !cfg.auth.email) return null;
  if (!cfg.device?.id || !cfg.device.name) return null;
  if (!cfg.workspace?.id) return null;

  if (!safeStorage.isEncryptionAvailable()) return null;

  let token: string;
  try {
    token = safeStorage.decryptString(Buffer.from(cfg.auth.encrypted_token, 'base64'));
  } catch {
    // Keychain entry the OS can't unlock (different login keychain, profile
    // migration, etc.). Caller treats null as "no session restored"; the user
    // sees the unauthenticated state and can re-login from Settings.
    return null;
  }

  // The daemon already booted into the active profile db (resolver), so this
  // only installs the session — no switch needed. (Refresh-first restore +
  // proactive renewal arrive in Phase 15b.)
  await postSyncSession({
    token,
    user_id: cfg.auth.user_id,
    email: cfg.auth.email,
    server_url: cfg.server.url,
    device: cfg.device,
    workspace: { id: cfg.workspace.id, slug: cfg.workspace.slug },
  });

  return {
    server_url: cfg.server.url,
    user_id: cfg.auth.user_id,
    email: cfg.auth.email,
    device_id: cfg.device.id,
    workspace_id: cfg.workspace.id,
  };
  // token falls out of scope here.
}

// ─── helpers ─────────────────────────────────────────────────────────

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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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

async function bestEffortRemoteLogout(auth: AuthContext): Promise<void> {
  try {
    const client = createSkybridgeClient({ authContext: auth });
    await client.logout();
  } catch {
    // best-effort; server may be unreachable or token already revoked
  }
}

/**
 * Revoke the refresh-token family server-side for a full logout (D2). Tries
 * the stored access token first; if it has expired, refreshes once to mint a
 * fresh access token and revokes with that. Network failures are tolerated
 * (best-effort — local cleanup proceeds regardless, since the user is logging
 * out); only TOKEN_EXPIRED routes to the refresh path.
 */
async function remoteRevoke(cfg: SkybridgeConfig): Promise<void> {
  if (!cfg.auth) return;
  const serverUrl = cfg.server.url;
  const user = { id: cfg.auth.user_id, email: cfg.auth.email, displayName: null };

  const access = decryptB64(cfg.auth.encrypted_token);
  if (access) {
    try {
      await createSkybridgeClient({ authContext: { serverUrl, token: access, user } }).logout();
      return; // access logout revokes the family
    } catch (err) {
      // Not expired (network / already-revoked / other) → best-effort, stop.
      if (!isTokenExpired(err)) return;
      // Expired → fall through to the refresh path.
    }
  }

  const refreshToken = decryptB64(cfg.auth.encrypted_refresh_token);
  if (!refreshToken) return;
  try {
    const rotated = await skybridgeRefresh(serverUrl, refreshToken);
    await createSkybridgeClient({
      authContext: { serverUrl, token: rotated.token, user },
    }).logout();
  } catch {
    // REFRESH_INVALID / REFRESH_REPLAYED → family already dead; network →
    // best-effort. Either way, local cleanup proceeds.
  }
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
