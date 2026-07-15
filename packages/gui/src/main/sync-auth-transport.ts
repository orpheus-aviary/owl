// Transport helpers for the sync-auth family: daemon HTTP (`/sync/*`), remote
// skybridge-SDK teardown, and workspace/device setup. Pure functions with no
// module state — split out of sync-auth.ts so the orchestrator stays focused on
// switch sequencing. Every daemon fetch carries `daemonAuthHeaders()` (A6 local
// token); dropping it would 401.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ApiError,
  type AuthContext,
  CLIENT_VERSION,
  NetworkError,
  type SkybridgeClient,
  createSkybridgeClient,
  refresh as skybridgeRefresh,
} from '@orpheus-aviary/skybridge-client';
import {
  LOCAL_PROFILE,
  OWL_APP_VERSION,
  type SkybridgeConfig,
  type SkybridgeDeviceSection,
  copyLocalProfileDbInto,
  inspectLocalProfile,
  paths,
  readProfileSection,
} from '@owl/core';
import { promptClaim } from './claim-prompt.js';
import { daemonAuthHeaders } from './daemon-auth.js';
import { getDaemonUrl } from './daemon.js';
import { decryptB64, defaultDeviceName } from './sync-auth-crypto.js';

/**
 * ensureWorkspace('owl','default') → the owl-shaped `{ id, slug }`. ApiWorkspace
 * exposes tool + name (not slug); synthesise "<tool>/<name>" so toml + daemon
 * stay in the pre-Phase-7 format. Reuses `client` when the caller already built
 * a device-bound one (avoids a second client).
 */
export async function ensureOwlWorkspace(
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
export async function maybeClaimLocalInto(
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
export function reuseDevice(profileId: string, deviceId: string): SkybridgeDeviceSection {
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

export async function registerNewDevice(auth: AuthContext): Promise<SkybridgeDeviceSection> {
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

export async function postSyncSession(payload: SyncSessionPayload): Promise<void> {
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
export async function postSyncSwitch(profileId: string): Promise<{ device_id: string | null }> {
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

export async function bestEffortSwitchLocal(): Promise<void> {
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
export async function postSyncSwitchStrict(profileId: string): Promise<void> {
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

export async function bestEffortRemoteLogout(auth: AuthContext): Promise<void> {
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
export async function bestEffortRevokeProfile(input: {
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
export async function remoteRevoke(cfg: SkybridgeConfig): Promise<void> {
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
