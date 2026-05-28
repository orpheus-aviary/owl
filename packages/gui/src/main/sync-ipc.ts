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

import { ApiError, NetworkError } from '@orpheus-aviary/skybridge-client';
import { type SkybridgeConfig, readSkybridgeConfig } from '@owl/core';
import { ipcMain, safeStorage } from 'electron';
import type { LoginAndOpenSessionInput } from '../shared/sync-auth-types.js';
import { syncErrorMessage } from '../shared/sync-error-message.js';
import type {
  SyncIpcReply,
  SyncStatusReply,
  SyncStatusResult,
} from '../shared/sync-status-types.js';
import { getDaemonUrl } from './daemon.js';
import { SafeStorageUnavailableError, loginAndOpenSession, logout } from './sync-auth.js';

export function registerSyncIpc(): void {
  ipcMain.handle('sync:login', async (_e, input: LoginAndOpenSessionInput) =>
    safe<void>(async () => {
      // Discard the summary on purpose: UI reads identity from sync:status
      // (the single display truth). Keeping the summary out of the IPC
      // shape means newly-added display fields only require one change.
      await loginAndOpenSession(input);
    }),
  );
  ipcMain.handle('sync:logout', async () => safe<void>(() => logout()));
  ipcMain.handle('sync:status', async () => safe<SyncStatusReply>(buildStatus));
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
