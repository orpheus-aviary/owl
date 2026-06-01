/**
 * P5-d Phase 8 — renderer ↔ main IPC bridge for skybridge sync.
 *
 * Three handlers, all returning `SyncIpcReply<T>`:
 *   - `sync:login`   →  delegates to `loginAndOpenSession` (sync-auth.ts).
 *                       Success reply is `{ ok: true, data: undefined }` —
 *                       the resolved session summary is intentionally
 *                       discarded. The renderer re-fetches `sync:status`
 *                       afterwards so identity display has a single source
 *                       of truth (see `shared/sync-status-types.ts`).
 *   - `sync:logout`  →  delegates to `logout`; same void shape.
 *   - `sync:status`  →  combines toml-derived identity (gated by the same
 *                       safeStorage availability + decrypt-probe used by
 *                       `restoreSessionOnStartup`) with the daemon's
 *                       `GET /sync/status` snapshot.
 *
 * All type owners (`SyncIpcReply` / `SyncStatusReply` /
 * `SyncStatusResult` / `LoginAndOpenSessionInput`) live in
 * `../shared/`. Renderer can't import main; main reads shared.
 */

import { type ApiDevice, ApiError, NetworkError } from '@orpheus-aviary/skybridge-client';
import {
  LOCAL_PROFILE,
  ProfileDbMissingError,
  type SkybridgeConfig,
  listProfiles,
  readEffectiveActiveProfileId,
  readSkybridgeConfig,
} from '@owl/core';
import { BrowserWindow, ipcMain, safeStorage } from 'electron';
import type { LoginAndOpenSessionInput } from '../shared/sync-auth-types.js';
import type { SyncDevicesReply } from '../shared/sync-devices-types.js';
import { syncErrorMessage } from '../shared/sync-error-message.js';
import type { ProfileSummary, SyncProfilesReply } from '../shared/sync-profiles-types.js';
import type { RunSyncResult } from '../shared/sync-run-types.js';
import type {
  SyncIpcReply,
  SyncStatusReply,
  SyncStatusResult,
} from '../shared/sync-status-types.js';
import { getDaemonUrl } from './daemon.js';
import {
  QuickSwitchNeedsLoginError,
  SafeStorageUnavailableError,
  deleteProfileLocalCopy,
  loginAndOpenSession,
  logout,
  switchToProfile,
} from './sync-auth.js';

export function registerSyncIpc(): void {
  ipcMain.handle('sync:login', async (_e, input: LoginAndOpenSessionInput) => {
    // Discard the summary on purpose: UI reads identity from sync:status
    // (the single display truth). Keeping the summary out of the IPC
    // shape means newly-added display fields only require one change.
    const reply = await safe<void>(async () => {
      await loginAndOpenSession(input);
    });
    if (reply.ok) notifyProfileSwitched();
    return reply;
  });
  ipcMain.handle('sync:logout', async () => {
    const reply = await safe<void>(() => logout());
    if (reply.ok) notifyProfileSwitched();
    return reply;
  });
  ipcMain.handle('sync:status', async () => safe<SyncStatusReply>(buildStatus));
  ipcMain.handle('sync:devices', async () => safe<SyncDevicesReply>(buildDevices));
  ipcMain.handle('sync:revoke-device', async (_e, deviceId: string) =>
    safe<{ revoked: boolean }>(() => revokeDevice(deviceId)),
  );
  ipcMain.handle('sync:run', async () => safe<RunSyncResult>(runSyncNow));
  // P5-d Phase 17 (W4) — saved-profile list (pure toml read, no daemon round
  // trip) + password-free quick switch (fires profile:switched on success so
  // the renderer reloads, exactly like login/logout).
  ipcMain.handle('sync:profiles', async () => safe<SyncProfilesReply>(async () => buildProfiles()));
  ipcMain.handle('sync:switch-profile', async (_e, id: string) => {
    const reply = await safe<void>(() => switchToProfile(id));
    if (reply.ok) notifyProfileSwitched();
    return reply;
  });
  // P5-d Phase 17 (delete-local-copy) — destructive remove of an account's
  // local copy. Reloads the renderer only when the deleted profile was active
  // (the daemon switched to local); deleting a non-active profile leaves the
  // current view intact (the Settings list re-fetches on its own).
  ipcMain.handle('sync:delete-profile', async (_e, id: string) => {
    const reply = await safe<{ wasActive: boolean }>(() => deleteProfileLocalCopy(id));
    if (reply.ok && reply.data.wasActive) notifyProfileSwitched();
    return reply;
  });
}

// P5-d Phase 17 (W4) — assemble the quick-switch list from the toml alone:
// every `[profiles.<id>]` account plus a synthetic `local` entry, with the
// EFFECTIVE active id marked (a ghost section whose db is gone never resolves
// active, ⑤). A profile is quick-switchable only when it has a refresh token,
// its db exists, and it isn't already active (⑦).
function buildProfiles(): SyncProfilesReply {
  const active = readEffectiveActiveProfileId();
  const accounts: ProfileSummary[] = listProfiles().map((p) => ({
    id: p.id,
    email: p.email ?? null,
    server_url: p.server_url.length > 0 ? p.server_url : null,
    is_active: active === p.id,
    can_quick_switch: p.hasRefreshToken && p.dbExists && active !== p.id,
    db_missing: !p.dbExists,
  }));
  const local: ProfileSummary = {
    id: LOCAL_PROFILE,
    email: null,
    server_url: null,
    is_active: active === LOCAL_PROFILE,
    can_quick_switch: active !== LOCAL_PROFILE,
    db_missing: false,
  };
  return { active, profiles: [local, ...accounts] };
}

// P5-d Phase 17 (W8) — drive one manual pull/push round from the status
// popover's「手动同步」action. No profile change → does NOT fire
// `profile:switched`. Like buildDevices, this has no fallback: a bare fetch
// failure is wrapped as the SDK's NetworkError so `safe<T>()` renders the
// Chinese「无法连接到本地后台服务」, and a non-2xx surfaces the daemon's
// already-Chinese envelope.message (manual.ts messageForError) verbatim.
async function runSyncNow(): Promise<RunSyncResult> {
  let res: Response;
  try {
    res = await fetch(`${getDaemonUrl()}/sync/run`, { method: 'POST' });
  } catch (err) {
    throw new NetworkError(
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err : undefined,
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `daemon /sync/run returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: RunSyncResult };
  if (!body.data) throw new Error('daemon /sync/run returned no data');
  return body.data;
}

/**
 * P5-d Phase 16 (B7, design §5.4.4) — a profile switch committed (login /
 * logout). Tell the renderer to do a controlled full reload so no editor tab /
 * AI conversation cache / conflict list / sync-status timer from the previous
 * profile bleeds into the new one. We fire on the next macrotask (`setImmediate`)
 * so the triggering `sync:login`/`sync:logout` invoke reply has fully returned
 * before the window tears down — the renderer additionally defers a tick before
 * `location.reload()` (double safety against racing the in-flight reply).
 */
function notifyProfileSwitched(): void {
  setImmediate(() => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('profile:switched');
    }
  });
}

async function buildStatus(): Promise<SyncStatusReply> {
  const cfg = safeReadConfig();
  const session = extractSession(cfg);

  let snapshot: SyncStatusResult | null = null;
  try {
    const res = await fetch(`${getDaemonUrl()}/sync/status`);
    if (res.ok) {
      const body = (await res.json()) as { data?: SyncStatusResult };
      snapshot = body.data ?? null;
    }
  } catch {
    // daemon down or unreachable — snapshot stays null; toml-derived
    // session can still render so the user knows who they are even
    // when the daemon hasn't come back yet.
  }
  return { session, snapshot };
}

function extractSession(cfg: SkybridgeConfig | null): SyncStatusReply['session'] {
  if (!cfg) return null;
  // Refuse plaintext-only legacy toml — the encrypted path is what
  // restoreSessionOnStartup trusts, and Settings should mirror that.
  const auth = cfg.auth;
  if (!auth?.encrypted_token) return null;
  const encryptedToken = auth.encrypted_token;
  const device = cfg.device;
  const workspace = cfg.workspace;
  const server = cfg.server;
  if (!auth.user_id || !auth.email) return null;
  if (!device?.id || !device.name) return null;
  if (!workspace?.id) return null;
  // Mirror the gate from sync-auth.ts:225, 229 — otherwise Settings can
  // claim "logged in" while the next cold start's restore silently
  // returns null (keychain locked / cross-OS migration / corrupted
  // ciphertext). The single, user-visible truth has to come from the
  // same probe restore uses.
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    safeStorage.decryptString(Buffer.from(encryptedToken, 'base64'));
  } catch {
    return null;
  }
  return {
    email: auth.email,
    server_url: server.url,
    // toml stores slug as '' when absent; normalise to null so renderer
    // can `?? workspace_id` fallback cleanly.
    workspace_slug: workspace.slug.length > 0 ? workspace.slug : null,
    workspace_id: workspace.id,
    device_id: device.id,
    device_name: device.name,
  };
}

// P5-d Phase 10 — `sync:devices` handler. Fetches the daemon's
// /sync/devices, computes `is_current` against the toml `[device].id`
// (single display truth comes from the toml probe, same as buildStatus).
//
// Unlike buildStatus (which swallows fetch failures into `snapshot: null`
// because identity can still render from toml), buildDevices has no
// fallback — it must surface error so the UI can render「重试」. Bare
// fetch failures in Node throw plain Error / TypeError, so we explicitly
// wrap them as the SDK's NetworkError to route through the existing
// `safe<T>()` NetworkError branch (Chinese「无法连接到本地后台服务」).
async function buildDevices(): Promise<SyncDevicesReply> {
  const cfg = safeReadConfig();
  const currentDeviceId = cfg?.device?.id ?? null;

  let res: Response;
  try {
    res = await fetch(`${getDaemonUrl()}/sync/devices`);
  } catch (err) {
    throw new NetworkError(
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err : undefined,
    );
  }
  if (!res.ok) {
    // Daemon envelope.message is already Chinese (manual.ts
    // messageForError after translateSkybridgeError). Surface it through
    // `safe<T>()`'s unknown branch which renders `detail` verbatim.
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `daemon /sync/devices returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: { devices: ApiDevice[] } };
  const apiDevices = body.data?.devices ?? [];
  return {
    devices: apiDevices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      app_version: d.appVersion,
      client_version: d.clientVersion,
      created_at: d.createdAt,
      last_seen_at: d.lastSeenAt,
      is_current: currentDeviceId !== null && d.id === currentDeviceId,
    })),
  };
}

// P5-d Phase 17 (W9) — revoke a device via the daemon. Same error shape as
// buildDevices: a bare fetch failure → NetworkError (Chinese「无法连接…」), a
// non-2xx surfaces the daemon's already-Chinese envelope.message. GUI only
// calls this for a non-current device (the current one is removed via logout),
// so there's no local session teardown on success.
async function revokeDevice(deviceId: string): Promise<{ revoked: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${getDaemonUrl()}/sync/revoke-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId }),
    });
  } catch (err) {
    throw new NetworkError(
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err : undefined,
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `daemon /sync/revoke-device returned HTTP ${res.status}`);
  }
  return { revoked: true };
}

async function safe<T>(fn: () => Promise<T>): Promise<SyncIpcReply<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: false, message: syncErrorMessage({ kind: 'api', code: err.code }) };
    }
    if (err instanceof NetworkError) {
      return { ok: false, message: syncErrorMessage({ kind: 'network' }) };
    }
    if (err instanceof SafeStorageUnavailableError) {
      return { ok: false, message: syncErrorMessage({ kind: 'safe_storage_unavailable' }) };
    }
    // P5-d Phase 17 (W4) — a saved profile that can't be quick-switched (dead /
    // missing refresh token, or its local copy is gone). The popover gates most
    // of these out, but this is the authoritative main-side guard.
    if (err instanceof QuickSwitchNeedsLoginError || err instanceof ProfileDbMissingError) {
      return { ok: false, message: '该账号无法免密切换，请前往「设置 → 同步」重新登录' };
    }
    return {
      ok: false,
      message: syncErrorMessage({
        kind: 'unknown',
        detail: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

function safeReadConfig(): SkybridgeConfig | null {
  try {
    return readSkybridgeConfig();
  } catch {
    return null;
  }
}
