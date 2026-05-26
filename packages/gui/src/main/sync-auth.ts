/**
 * P5-d Phase 7 — GUI main's sole owner of plaintext skybridge tokens.
 *
 * Three flows:
 *
 *   - `loginAndOpenSession(input)` —— user submits server URL + email +
 *      password from Settings. We:
 *        1. POST /auth/login via the SDK (token only lives in local scope)
 *        2. registerDevice + ensureWorkspace
 *        3. safeStorage.encryptString(token) → base64
 *        4. POST 127.0.0.1:<daemon>/sync/session with the plaintext token
 *           (localhost only; daemon never persists it)
 *        5. atomic write skybridge_config.toml with [auth].encrypted_token
 *           (NEVER [auth].token — plaintext stays in memory only)
 *      Order matters: §3.1.2 "失败 unwind ... 不写 toml" — any failure
 *      between login and the atomic-write triggers best-effort remote
 *      /auth/logout and leaves the on-disk toml untouched.
 *
 *   - `logout()` —— Settings logout button:
 *        1. read existing toml, decrypt encrypted_token locally
 *        2. best-effort remote /auth/logout
 *        3. POST 127.0.0.1:<daemon>/sync/logout-local (clears daemon
 *           in-memory session + sqlite identity rows)
 *        4. atomic write toml clearing [auth] + [device] + [workspace],
 *           preserving [server].url for the next login default
 *
 *   - `restoreSessionOnStartup()` —— GUI main entry post-daemon-ready:
 *        Read toml [auth].encrypted_token; decrypt locally; POST
 *        /sync/session. Returns null when no session is restorable.
 *        **Deliberately refuses to fallback to plaintext [auth].token** —
 *        per user ruling on Q2/§3.2.1: the new GUI startup path only
 *        trusts encrypted_token. Legacy plaintext toml still works via
 *        the daemon's own toml-bootstrap path (session.ts requireAuth);
 *        we just don't promote it through GUI restore.
 *
 * `OWL_APP_VERSION` is mirrored from `packages/daemon/src/sync/session.ts`
 * — bump together when bumping owl version. Refactoring it to a shared
 * constant lives in commit (h) cleanup if needed.
 */

import { hostname } from 'node:os';
import {
  type AuthContext,
  CLIENT_VERSION,
  createSkybridgeClient,
  login as skybridgeLogin,
} from '@orpheus-aviary/skybridge-client';
import { type SkybridgeConfig, readSkybridgeConfig, skybridgeConfigPath } from '@owl/core';
import { safeStorage } from 'electron';
import { stringify } from 'smol-toml';
import { atomicWriteFile, cleanupStaleTmp } from './atomic-write.js';
import { getDaemonUrl } from './daemon.js';

const OWL_APP_VERSION = '0.5.0-dev';

export interface LoginAndOpenSessionInput {
  serverUrl: string;
  email: string;
  password: string;
}

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

export async function loginAndOpenSession(
  input: LoginAndOpenSessionInput,
): Promise<SyncSessionSummary> {
  // safeStorage is a process-wide module; checking once up-front avoids
  // doing the entire login round-trip just to fail at encryption.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new SafeStorageUnavailableError();
  }

  // Step 1: remote login — auth.token is plaintext, scoped to this fn.
  const auth = await skybridgeLogin(input.serverUrl, input.email, input.password);

  try {
    // Step 2: registerDevice + ensureWorkspace.
    const seed = createSkybridgeClient({ authContext: auth });
    const device = await seed.registerDevice({
      name: defaultDeviceName(),
      appVersion: `owl ${OWL_APP_VERSION}`,
      clientVersion: CLIENT_VERSION,
    });
    const deviceMeta = {
      id: device.id,
      name: device.name,
      app_version: `owl ${OWL_APP_VERSION}`,
      client_version: CLIENT_VERSION,
    };
    const withDevice = createSkybridgeClient({ authContext: auth, deviceId: device.id });
    const ws = await withDevice.ensureWorkspace('owl', 'default');
    // ApiWorkspace exposes tool + name, not slug; we synthesise the
    // owl-shaped slug here so toml + daemon stay in sync with the
    // pre-Phase-7 format ("<tool>/<name>").
    const workspaceMeta = { id: ws.id, slug: `${ws.tool}/${ws.name}` };

    // Step 3: encrypt token into ciphertext while still in this scope.
    // We do the encryption BEFORE the daemon POST so the `.tmp` write in
    // step 5 never has to hold plaintext, and so we surface
    // encryption failures (e.g. keychain locked) before sending the
    // token over HTTP.
    const ciphertext = safeStorage.encryptString(auth.token).toString('base64');

    // Step 4: hand the plaintext token to daemon over localhost. This
    // is intentionally BEFORE the atomic-write — per design §3.1.2
    // "失败 unwind ... 不写 toml": if /sync/session fails (network,
    // daemon down, bad payload), we unwind via remote /auth/logout and
    // leave the existing on-disk toml untouched. Putting the toml
    // write first would leave a token-bearing toml on disk pointing at
    // a daemon that never accepted the session.
    await postSyncSession({
      token: auth.token,
      user_id: auth.user.id,
      email: auth.user.email,
      server_url: auth.serverUrl,
      device: deviceMeta,
      workspace: workspaceMeta,
    });

    // Step 5: atomic-write toml. Daemon already has the session in
    // memory; this persists the encrypted handle for next startup's
    // restoreSessionOnStartup.
    const cfg: SkybridgeConfig = {
      server: { url: auth.serverUrl },
      auth: {
        user_id: auth.user.id,
        email: auth.user.email,
        encrypted_token: ciphertext,
      },
      device: deviceMeta,
      workspace: workspaceMeta,
    };
    const cfgPath = skybridgeConfigPath();
    cleanupStaleTmp(cfgPath);
    atomicWriteFile(cfgPath, stringify(serializableConfig(cfg)));

    return {
      server_url: auth.serverUrl,
      user_id: auth.user.id,
      email: auth.user.email,
      device_id: device.id,
      workspace_id: ws.id,
    };
  } catch (err) {
    // Unwind: try to revoke the freshly-issued token so it doesn't sit
    // valid on the server. Do NOT write toml — caller's state is the
    // pre-login one (or whatever was there before).
    await bestEffortRemoteLogout(auth);
    throw err;
  }
  // auth.token falls out of scope here.
}

export async function logout(): Promise<void> {
  const cfg = safeReadConfig();

  // 1. Best-effort remote logout — decrypt token locally for one HTTP
  //    call, never re-persisted, never logged.
  if (cfg?.auth?.encrypted_token && safeStorage.isEncryptionAvailable()) {
    let token: string | null = null;
    try {
      token = safeStorage.decryptString(Buffer.from(cfg.auth.encrypted_token, 'base64'));
    } catch {
      token = null;
    }
    if (token) {
      await bestEffortRemoteLogout({
        serverUrl: cfg.server.url,
        token,
        // ApiUser requires `displayName`. We don't carry it on the toml
        // (non-essential display field); pass null — server doesn't
        // need it for /auth/logout.
        user: { id: cfg.auth.user_id, email: cfg.auth.email, displayName: null },
      });
    }
  }

  // 2. Daemon teardown — clears ctx.skybridgeSession + clearSyncIdentity
  //    on sqlite. Survives a daemon that's already down.
  try {
    await fetch(`${getDaemonUrl()}/sync/logout-local`, { method: 'POST' });
  } catch {
    // best-effort
  }

  // 3. Atomic clear of [auth] + [device] + [workspace]. [server].url
  //    survives so the next login form pre-fills.
  if (cfg) {
    const cleared: SkybridgeConfig = { server: cfg.server };
    const cfgPath = skybridgeConfigPath();
    cleanupStaleTmp(cfgPath);
    atomicWriteFile(cfgPath, stringify(serializableConfig(cleared)));
  }
}

export async function restoreSessionOnStartup(): Promise<SyncSessionSummary | null> {
  const cfg = safeReadConfig();
  if (!cfg) return null;

  // The new path is encrypted-only. Legacy plaintext [auth].token still
  // works via the daemon's own bootstrap (session.ts requireAuth); we
  // refuse to promote it through GUI startup so plaintext never travels
  // through the keychain code path.
  if (!cfg.auth?.encrypted_token) return null;
  if (!cfg.auth.user_id || !cfg.auth.email) return null;
  if (!cfg.device?.id || !cfg.device.name) return null;
  if (!cfg.workspace?.id) return null;

  if (!safeStorage.isEncryptionAvailable()) return null;

  let token: string;
  try {
    token = safeStorage.decryptString(Buffer.from(cfg.auth.encrypted_token, 'base64'));
  } catch {
    // Most commonly: keychain entry the OS can't unlock (different
    // login keychain, profile migration, etc.). Caller treats null as
    // "no session restored"; user will see the unauthenticated state
    // and can re-login from Settings.
    return null;
  }

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

async function bestEffortRemoteLogout(auth: AuthContext): Promise<void> {
  try {
    const client = createSkybridgeClient({ authContext: auth });
    await client.logout();
  } catch {
    // best-effort; server may be unreachable or token already revoked
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

/**
 * `smol-toml` drops `undefined`-valued keys, but it also rejects keys
 * whose value is literally `undefined` at the top level of the object.
 * Build the serialisable object by only including sections that are
 * defined, matching the writer contract from `writeSkybridgeConfig`.
 */
function serializableConfig(cfg: SkybridgeConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { server: cfg.server };
  if (cfg.auth) out.auth = cfg.auth;
  if (cfg.device) out.device = cfg.device;
  if (cfg.workspace) out.workspace = cfg.workspace;
  return out;
}
