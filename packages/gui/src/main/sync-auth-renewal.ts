// Proactive token renewal (Phase 15b). The SOLE owner of the renewal timer
// singletons (`refreshTimer` / `currentExpiresAt`) — split out of sync-auth.ts
// so those stay in exactly one module. The orchestrator reads the expiry via
// `getCurrentExpiresAt()` and (re)arms / cancels via `scheduleRefresh` /
// `clearRefreshTimer`. `refreshSession` routes through the shared switch queue,
// so a refresh never interleaves with a profile switch.
//
// 0.1.4 access tokens are short-lived; GUI main keeps the daemon's session alive
// by refreshing slightly before `expiresAt` (we own the refresh token in the
// keychain — the daemon never sees it). The daemon never has to learn about
// renewal: we just re-POST /sync/session with a fresh access token.

import {
  ApiError,
  type ApiRefreshResult,
  refresh as skybridgeRefresh,
} from '@orpheus-aviary/skybridge-client';
import { updateActiveProfileAuth } from '@owl/core';
import { safeStorage } from 'electron';
import { decryptB64, safeReadConfig } from './sync-auth-crypto.js';
import { postSyncSession } from './sync-auth-transport.js';
import { runSwitchExclusive } from './sync-switch-queue.js';

const REFRESH_MARGIN_MS = 60_000; // refresh this long before expiry
const REFRESH_MIN_DELAY_MS = 1_000; // never schedule a zero/negative timeout
const REFRESH_RETRY_MS = 30_000; // back off after a transient (network) failure
// setTimeout's 32-bit signed-int ceiling (~24.8 days). A larger delay clamps to
// 1ms and fires immediately, so a long-lived token's renewal must be chunked.
const MAX_TIMER_MS = 2_147_483_647;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Expiry of the currently-installed access token, or null when none. */
let currentExpiresAt: number | null = null;

/**
 * Expiry (Unix ms) of the currently-installed access token, or null when none.
 * The orchestrator captures this before a switch so a failure path can restore
 * the prior account's timer (never the raw `let` — the module owns mutation).
 */
export function getCurrentExpiresAt(): number | null {
  return currentExpiresAt;
}

/**
 * Refresh the access token now and re-install the session (daemon stays on the
 * active profile db — no switch). Rotates the stored refresh token and
 * reschedules the next renewal. Shared by the timer and the resume/focus
 * triggers. A dead refresh token stops renewal (user re-logs in); a transient
 * network failure backs off and retries.
 *
 * Routed through the switch queue so a refresh can never interleave with a
 * profile switch: `refreshSessionImpl` re-reads config at its top, so under the
 * queue it always targets whatever profile is active *now*, never a stale one
 * captured before a switch (layer B, Phase 21).
 */
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

export function scheduleRefresh(expiresAt?: number): void {
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

export function persistRotated(rotated: ApiRefreshResult): void {
  updateActiveProfileAuth({
    encrypted_token: safeStorage.encryptString(rotated.token).toString('base64'),
    encrypted_refresh_token: safeStorage.encryptString(rotated.refreshToken).toString('base64'),
  });
}

export function isRefreshDead(err: unknown): boolean {
  return (
    err instanceof ApiError && (err.code === 'REFRESH_INVALID' || err.code === 'REFRESH_REPLAYED')
  );
}
