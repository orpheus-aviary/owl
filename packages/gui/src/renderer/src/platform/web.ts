// Web host adapter — used when there is no preload (`window.owlAPI` absent).
//
// Phase B (B1) wires the session ops to the cloud daemon over HTTP, reusing the
// shared transport (so the bearer + 401 hook configured in the web entry apply
// here too). Profile management + IPC-push subscriptions stay absent — a
// browser session maps to exactly one cloud daemon = one account.

import { activateWebSession, invalidateSession } from '@/session/session-actions';
import type { SyncStatusResult } from '@orpheus-aviary/owl-shared';
import { ApiError, request } from '@orpheus-aviary/owl-shared';
import type { PlatformAdapter, SyncCapability } from './types';
import { clearWebSession, getWebSession } from './web-session';

/** Daemon `/auth/login` success payload. */
interface LoginData {
  session_token: string;
  expires_at: number;
  identity: {
    profile_id: string;
    user_id: string;
    email: string;
    server_url: string;
    device_id: string;
    workspace_id: string;
  };
}

/** Daemon `/sync/devices` payload — SDK camelCase, mapped to snake_case below. */
interface RawDevice {
  id: string;
  name: string;
  platform: string | null;
  appVersion: string | null;
  clientVersion: string | null;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

/** Map a thrown transport error to a user-ready message. */
function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return '无法连接到服务器';
}

const webSync: SyncCapability = {
  async login(input) {
    try {
      // serverUrl is fixed by the cloud daemon's config (anti-SSRF); the web
      // form carries it only for shape parity, so only email/password go up.
      const res = await request<LoginData>('POST', '/auth/login', {
        email: input.email,
        password: input.password,
      });
      const d = res.data;
      if (!d) return { ok: false, message: '登录响应异常' };
      // ④: activate through the single web entry (begin → reset → publish bearer
      // → bootstrap), NOT a bare setWebSession — so a re-login after a logout
      // fully re-bootstraps the (freshly-reset) stores. `remember` opts the token
      // into sessionStorage persistence (default off).
      await activateWebSession(
        { token: d.session_token, identity: d.identity, expiresAt: d.expires_at },
        { persist: input.remember ?? false },
      );
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, message: errMessage(err) };
    }
  },

  async logout() {
    try {
      await request('POST', '/auth/logout', {});
    } catch {
      // Even if the remote revoke fails (network / already-expired), drop the
      // local session so the gate returns to the login screen.
    }
    // ④: clear the (possibly persisted) token AND invalidate the session
    // generation so every store resets — the auth gate then shows login.
    clearWebSession();
    invalidateSession();
    return { ok: true, data: undefined };
  },

  async status() {
    const identity = getWebSession()?.identity ?? null;
    const sessionView = identity
      ? {
          email: identity.email,
          server_url: identity.server_url,
          workspace_id: identity.workspace_id,
          workspace_slug: null,
          device_id: identity.device_id,
          device_name: '',
        }
      : null;
    try {
      const res = await request<SyncStatusResult>('GET', '/sync/status');
      return { ok: true, data: { session: sessionView, snapshot: res.data ?? null } };
    } catch (err) {
      // Identity still renders from the in-memory session even when the
      // snapshot fetch fails (mirrors GUI main's buildStatus fallback).
      if (err instanceof ApiError) {
        return { ok: true, data: { session: sessionView, snapshot: null } };
      }
      return { ok: false, message: errMessage(err) };
    }
  },

  async run() {
    try {
      const res = await request<RunResult>('POST', '/sync/run', {});
      if (!res.data) return { ok: false, message: '同步响应异常' };
      return { ok: true, data: res.data };
    } catch (err) {
      return { ok: false, message: errMessage(err) };
    }
  },

  async devices() {
    try {
      const res = await request<{ devices: RawDevice[] }>('GET', '/sync/devices');
      const currentDeviceId = getWebSession()?.identity.device_id ?? null;
      const devices = (res.data?.devices ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        app_version: d.appVersion,
        client_version: d.clientVersion,
        created_at: d.createdAt,
        last_seen_at: d.lastSeenAt,
        revoked_at: d.revokedAt,
        is_current: currentDeviceId !== null && d.id === currentDeviceId,
      }));
      return { ok: true, data: { devices } };
    } catch (err) {
      return { ok: false, message: errMessage(err) };
    }
  },

  async revokeDevice(deviceId) {
    try {
      const res = await request<{ revoked: boolean }>('POST', '/sync/revoke-device', {
        device_id: deviceId,
      });
      return { ok: true, data: { revoked: res.data?.revoked ?? false } };
    } catch (err) {
      return { ok: false, message: errMessage(err) };
    }
  },
  // profiles / switchProfile / deleteProfile / onProfileSwitched /
  // onClaimPrompt / respondClaim — Electron-local, intentionally absent.
};

/** Mirror of `RunSyncResult` (gui/src/shared) — avoids dragging core in. */
interface RunResult {
  pulledTotal: number;
  appliedTotal: number;
  skippedTotal: number;
  pushedTotal: number;
  duplicatesTotal: number;
  serverSeqHigh: number;
  cursorBefore: number;
  cursorAfter: number;
  conflictsRecorded: number;
}

export const webAdapter: PlatformAdapter = {
  startupMode: { mode: 'normal' },
  requiresAuth: true,
  remoteClient: true,
  daemonBaseUrl: () => '',
  sync: webSync,
  // migration / cli / shortcut / quit — Electron-only, intentionally absent.
};
