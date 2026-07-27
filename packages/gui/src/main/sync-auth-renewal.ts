// Proactive token renewal (Phase 15b). The SOLE owner of the renewal timer
// singletons (`refreshTimer` / `currentExpiresAt` / `currentRefreshAt`) — split
// out of sync-auth.ts so those stay in exactly one module. The orchestrator
// reads the expiry via `getCurrentExpiresAt()` and (re)arms / cancels via
// `scheduleRefresh` / `clearRefreshTimer`. `refreshSession` routes through the
// shared switch queue, so a refresh never interleaves with a profile switch.
//
// 0.1.4 access tokens are short-lived; GUI main keeps the daemon's session alive
// by refreshing slightly before `expiresAt` (we own the refresh token in the
// keychain — the daemon never sees it). The daemon never has to learn about
// renewal: we just re-POST /sync/session with a fresh access token.
//
// ── 0.6.2 W3 ────────────────────────────────────────────────────────────────
//
// Three changes, all in service of「过期也能自愈」:
//
//   1. `refreshSessionUnlocked` returns a DISCRIMINATED result instead of
//      swallowing every failure. The old code caught dead and transient alike
//      and just `return`ed, so no caller could implement "dead → wipe the
//      credentials and tell the user".
//   2. The next renewal is scheduled BEFORE `/sync/session` is posted. When the
//      daemon is momentarily unreachable the old order killed the renewal timer
//      outright (and threw into a bare `void refreshSession()` — an unhandled
//      rejection), turning a 5-second daemon restart into "no more renewals
//      until the app restarts".
//   3. The refresh lead time is clamped to half the token's TTL. With a fixed
//      60s margin and a 1s floor, any TTL <= 60s scheduled a refresh every
//      second — a self-inflicted refresh storm on short-TTL servers.
//      `maybeRefreshNow` reads the SAME computed `refreshAt`, so the timer and
//      the focus/resume trigger can't disagree.

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

/** Upper bound on how early we refresh; the real lead is min(this, ttl/2). */
const REFRESH_MARGIN_MS = 60_000;
const REFRESH_MIN_DELAY_MS = 1_000; // never schedule a zero/negative timeout
const REFRESH_RETRY_MS = 30_000; // back off after a transient (network) failure
// setTimeout's 32-bit signed-int ceiling (~24.8 days). A larger delay clamps to
// 1ms and fires immediately, so a long-lived token's renewal must be chunked.
const MAX_TIMER_MS = 2_147_483_647;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Expiry of the currently-installed access token, or null when none. */
let currentExpiresAt: number | null = null;
/** When we intend to refresh — `expiresAt - lead`. Shared with `maybeRefreshNow`. */
let currentRefreshAt: number | null = null;

/**
 * Outcome of one refresh attempt. Every branch is actionable by the caller:
 *
 *   refreshed              — new access token installed in the daemon.
 *   refreshed_not_installed— credentials ARE persisted and the next renewal IS
 *                            scheduled; only `POST /sync/session` failed. The
 *                            caller retries the install with the token returned
 *                            here — it must not refresh again (that would burn
 *                            a rotation) and must not treat this as fatal.
 *   dead                   — the server rejected the refresh token itself.
 *                            Terminal: wipe credentials, ask for a login.
 *   transient              — network / 5xx. Retry later.
 *   no_credentials         — nothing stored to refresh with.
 */
export type RefreshResult =
  | { outcome: 'refreshed'; token: string; expiresAt?: number }
  | { outcome: 'refreshed_not_installed'; token: string; error: unknown }
  | { outcome: 'dead'; error: unknown }
  | { outcome: 'transient'; error: unknown }
  | { outcome: 'no_credentials' };

/** Notified with the result of every timer-driven refresh. Wired in `index.ts`. */
type RefreshResultHandler = (result: RefreshResult) => void;
let onRefreshResult: RefreshResultHandler | null = null;

/**
 * Register the recovery module's dispatcher (0.6.2 W3). Kept as an injected
 * hook rather than a direct import so this module stays a leaf of the recovery
 * module, not a cycle with it.
 */
export function setRefreshResultHandler(handler: RefreshResultHandler | null): void {
  onRefreshResult = handler;
}

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
 * reschedules the next renewal.
 *
 * Routed through the switch queue so a refresh can never interleave with a
 * profile switch: `refreshSessionUnlocked` re-reads config at its top, so under
 * the queue it always targets whatever profile is active *now*, never a stale
 * one captured before a switch (layer B, Phase 21).
 */
export function refreshSession(): Promise<RefreshResult> {
  return runSwitchExclusive(refreshSessionUnlocked);
}

/**
 * The refresh itself, WITHOUT taking the switch queue. The queue is
 * non-reentrant, so a caller that already holds it (`sync-auth-recovery.ts`)
 * must use this entry point — going through `refreshSession` would deadlock.
 */
export async function refreshSessionUnlocked(): Promise<RefreshResult> {
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
    return { outcome: 'no_credentials' };
  }

  let rotated: ApiRefreshResult;
  try {
    rotated = await skybridgeRefresh(cfg.server.url, refreshTok);
  } catch (err) {
    if (isRefreshDead(err)) {
      clearRefreshTimer(); // refresh token gone → user must log in again
      return { outcome: 'dead', error: err };
    }
    scheduleRefreshIn(REFRESH_RETRY_MS); // transient → back off + retry
    return { outcome: 'transient', error: err };
  }

  // Persist + re-arm BEFORE talking to the daemon: the rotation already
  // happened server-side, so losing it here would strand the account.
  persistRotated(rotated);
  scheduleRefresh(rotated.expiresAt);
  try {
    await postSyncSession({
      token: rotated.token,
      user_id: cfg.auth.user_id,
      email: cfg.auth.email,
      server_url: cfg.server.url,
      device: cfg.device,
      workspace: { id: cfg.workspace.id, slug: cfg.workspace.slug },
    });
  } catch (err) {
    return { outcome: 'refreshed_not_installed', token: rotated.token, error: err };
  }
  return { outcome: 'refreshed', token: rotated.token, expiresAt: rotated.expiresAt };
}

/**
 * Renew now if the installed access token is at/near expiry. Wired to
 * `powerMonitor` resume + window focus in the main entry, so a machine that
 * slept past a scheduled timer recovers as soon as the user comes back.
 */
export async function maybeRefreshNow(): Promise<void> {
  if (currentRefreshAt === null) return; // no renewable session
  if (Date.now() < currentRefreshAt) return; // still fresh
  const result = await refreshSession();
  onRefreshResult?.(result);
}

/** Cancel any pending renewal (logout / dead refresh / no session). */
export function clearRefreshTimer(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  currentExpiresAt = null;
  currentRefreshAt = null;
}

export function scheduleRefresh(expiresAt?: number): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  currentExpiresAt = expiresAt ?? null;
  if (expiresAt === undefined) {
    currentRefreshAt = null;
    return;
  }
  const now = Date.now();
  // Lead time can never exceed half the remaining life, so a short-TTL token
  // refreshes once around its midpoint instead of once per second.
  const ttl = Math.max(0, expiresAt - now);
  const lead = Math.min(REFRESH_MARGIN_MS, ttl / 2);
  currentRefreshAt = expiresAt - lead;
  scheduleRefreshIn(Math.max(REFRESH_MIN_DELAY_MS, currentRefreshAt - now));
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
      // Never let this reject: the timer callback has no caller to catch it.
      void refreshSession().then(
        (result) => onRefreshResult?.(result),
        (err: unknown) => onRefreshResult?.({ outcome: 'transient', error: err }),
      );
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
