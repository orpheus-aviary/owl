// 0.6.2 W3 — automatic recovery from `auth_required`.
//
// The daemon can detect that sync is blocked on authentication, but it can't
// fix it: since P5-d Phase 10 the credentials live in GUI main's keychain and
// the daemon never reads toml. This module is the other half — it receives the
// reason (via IPC from the renderer, or by polling `/sync/status` on
// resume/focus) and does the one thing that reason calls for:
//
//   missing_session → re-install the STORED access token (`/sync/session`).
//                     No refresh: that token was never rejected, we simply
//                     never handed it to this daemon process. If it turns out
//                     to be dead, the next round 401s → `token_rejected`.
//   token_rejected  → refresh. Re-installing a rejected token is an infinite
//                     loop; only a new access token can help.
//   credentials_missing → nothing to do (terminal). The renderer doesn't even
//                     send it; this is the second line of defence.
//
// ── Three traps this module is shaped around ────────────────────────────────
//
// 1. The switch queue is NON-REENTRANT. Only the outermost caller may hold it,
//    so everything here calls the `*Unlocked` variants inside one
//    `runSwitchExclusive`, never `refreshSession()`.
// 2. External and internal entry points must be SEPARATE. `requestRecovery` is
//    rate-limited (the renderer can call it on every snapshot); the backoff
//    timer calls `runRecoveryAttempt` directly. Routing the 2s retry through
//    the 10s rate limit would swallow it — and since nothing re-arms the timer
//    after a swallowed attempt, recovery would stop permanently.
// 3. A profile switch invalidates in-flight recovery. The generation is
//    captured BEFORE entering the queue and re-checked after the lock is held:
//    a switch that got into the queue first would otherwise leave our recovery
//    reading the NEW profile's config and refreshing the wrong account.

import type { AuthReason } from '@orpheus-aviary/owl-shared';
import { clearSkybridgeAuth } from '@owl/core';
import { daemonAuthHeaders } from './daemon-auth.js';
import { getDaemonUrl } from './daemon.js';
import { decryptB64, safeReadConfig } from './sync-auth-crypto.js';
import {
  type RefreshResult,
  clearRefreshTimer,
  refreshSessionUnlocked,
} from './sync-auth-renewal.js';
import { postAuthUnrecoverable, postSyncSession } from './sync-auth-transport.js';
import { runSwitchExclusive } from './sync-switch-queue.js';

/** Minimum gap between two EXTERNAL recovery requests (renderer / focus). */
const EXTERNAL_THROTTLE_MS = 10_000;

/** Backoff for retrying a failed re-install / transient refresh. */
const RETRY_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000] as const;

let generation = 0;
/** Last external request time PER REASON — see `requestRecovery`. */
let lastExternalRequestAt = new Map<AuthReason, number>();
let inflight: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function log(msg: string, detail?: unknown): void {
  if (detail === undefined) console.log(`[sync-recovery] ${msg}`);
  else console.log(`[sync-recovery] ${msg}`, detail);
}

/**
 * Invalidate every in-flight and scheduled recovery. Called wherever the
 * orchestrator stops the renewal timer for a profile change (login / logout /
 * quick-switch / delete-local-copy): from that moment "the account we were
 * recovering" no longer exists.
 */
export function bumpRecoveryGeneration(): void {
  generation += 1;
  lastExternalRequestAt = new Map();
  inflight = null;
  clearRecoveryTimers();
}

export function clearRecoveryTimers(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryAttempt = 0;
}

/**
 * External entry point (renderer IPC / resume / focus). Rate-limited, since the
 * renderer may see the same `auth_required` from several sources at once.
 *
 * The limit is PER REASON, and that is not a detail. A single window routinely
 * carries an ESCALATION: the daemon restarts (`missing_session`) → we reinstall
 * the stored access token → the SSE subscribe is rejected (`token_rejected`),
 * all inside a second or two. With one shared timestamp the escalation was
 * dropped by the throttle — and since a dropped external request schedules
 * nothing, recovery stopped there and the app sat at「需登录」forever
 * (caught in the 0.6.2 real-device run). A repeat of the SAME reason is still
 * dropped: the first attempt either is in flight or already armed its backoff.
 */
export function requestRecovery(reason: AuthReason): void {
  const now = Date.now();
  const last = lastExternalRequestAt.get(reason);
  if (last !== undefined && now - last < EXTERNAL_THROTTLE_MS) return;
  lastExternalRequestAt.set(reason, now);
  void runRecoveryAttempt(reason, generation);
}

/**
 * Internal entry point — NOT rate-limited (see trap 2 above). Single-flight:
 * a second reason arriving mid-attempt joins the current one rather than
 * queueing a second refresh.
 */
export function runRecoveryAttempt(reason: AuthReason, gen: number): Promise<void> {
  if (gen !== generation) return Promise.resolve();
  if (inflight) return inflight;
  const p = attempt(reason, gen).finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}

async function attempt(reason: AuthReason, gen: number): Promise<void> {
  if (reason === 'credentials_missing') {
    log('credentials are gone — waiting for a manual login');
    return;
  }

  if (reason === 'missing_session') {
    const installed = await runSwitchExclusive(async () => {
      if (gen !== generation) return 'stale';
      return reinstallFromConfigUnlocked();
    });
    if (installed === 'stale') return;
    if (installed === 'installed') {
      clearRecoveryTimers();
      log('re-installed the stored session');
      return;
    }
    if (installed === 'no_credentials') {
      log('no stored access token to re-install');
      await postAuthUnrecoverable();
      return;
    }
    scheduleRetry('missing_session', gen);
    return;
  }

  const result = await runSwitchExclusive(async (): Promise<RefreshResult | 'stale'> => {
    if (gen !== generation) return 'stale';
    return refreshSessionUnlocked();
  });
  if (result === 'stale') return;
  await handleRefreshOutcome(result, gen);
}

/**
 * Dispatch a refresh result. Reached both from `attempt` and (via
 * `setRefreshResultHandler` in `index.ts`) from the renewal timer's own
 * refreshes, so a background renewal whose install failed lands in the same
 * retry loop instead of silently leaving the daemon on a stale session.
 */
async function handleRefreshOutcome(result: RefreshResult, gen: number): Promise<void> {
  if (gen !== generation) return;
  switch (result.outcome) {
    case 'refreshed':
      clearRecoveryTimers();
      log('refreshed the access token and re-installed the session');
      return;
    case 'refreshed_not_installed':
      // The rotation already succeeded and the next renewal is armed — only
      // the daemon hand-off failed. Retry just that, with the new token.
      log('refreshed, but the daemon rejected the install — retrying', result.error);
      scheduleRetry('missing_session', gen);
      return;
    case 'transient':
      log('refresh failed transiently — retrying', result.error);
      scheduleRetry('token_rejected', gen);
      return;
    case 'dead':
    case 'no_credentials':
      clearRefreshTimer();
      clearRecoveryTimers();
      clearSkybridgeAuth();
      await postAuthUnrecoverable();
      log('refresh token is dead — credentials cleared, manual login required');
      return;
  }
}

/** Handler shape for `setRefreshResultHandler` (timer-driven refreshes). */
export function onTimerRefreshResult(result: RefreshResult): void {
  void handleRefreshOutcome(result, generation);
}

/**
 * Resume / focus fallback: ask the daemon whether it is stuck on
 * `auth_required` and start recovery if so. The renderer normally forwards
 * this, but with every window closed there is nobody to forward it — and that
 * is exactly the state a machine wakes up in. Best-effort and silent.
 */
export async function recoverIfAuthRequired(): Promise<void> {
  let snapshot: { state?: string; auth_reason?: AuthReason | null } | null = null;
  try {
    const res = await fetch(`${getDaemonUrl()}/sync/status`, { headers: daemonAuthHeaders() });
    if (!res.ok) return;
    const body = (await res.json()) as {
      data?: { state?: string; auth_reason?: AuthReason | null };
    };
    snapshot = body.data ?? null;
  } catch {
    return; // daemon down — nothing to recover into
  }
  if (snapshot?.state !== 'auth_required') return;
  const reason = snapshot.auth_reason;
  if (!reason || reason === 'credentials_missing') return;
  requestRecovery(reason);
}

type ReinstallOutcome = 'installed' | 'failed' | 'no_credentials';

/**
 * Re-POST the stored access token to `/sync/session`, WITHOUT taking the switch
 * queue (the caller holds it). Deliberately does not refresh: `missing_session`
 * means nobody handed this daemon a session, not that the token is bad.
 */
export async function reinstallFromConfigUnlocked(): Promise<ReinstallOutcome> {
  const cfg = safeReadConfig();
  const token = decryptB64(cfg?.auth?.encrypted_token);
  if (!cfg?.auth?.user_id || !cfg.auth.email || !cfg.device?.id || !cfg.workspace?.id || !token) {
    return 'no_credentials';
  }
  try {
    await postSyncSession({
      token,
      user_id: cfg.auth.user_id,
      email: cfg.auth.email,
      server_url: cfg.server.url,
      device: cfg.device,
      workspace: { id: cfg.workspace.id, slug: cfg.workspace.slug },
    });
  } catch (err) {
    log('session re-install failed', err);
    return 'failed';
  }
  return 'installed';
}

function scheduleRetry(reason: AuthReason, gen: number): void {
  if (gen !== generation) return;
  if (retryTimer) clearTimeout(retryTimer);
  const delay = RETRY_BACKOFF_MS[Math.min(retryAttempt, RETRY_BACKOFF_MS.length - 1)];
  retryAttempt += 1;
  // The backoff sleeps OUTSIDE the switch queue — holding the queue across a
  // 60s wait would block every profile switch behind it.
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void runRecoveryAttempt(reason, gen);
  }, delay);
  retryTimer.unref?.();
}

/** Test-only: reset module state between cases. */
export function __resetRecoveryForTests(): void {
  generation = 0;
  lastExternalRequestAt = new Map();
  inflight = null;
  clearRecoveryTimers();
}
