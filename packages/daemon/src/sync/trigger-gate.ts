/**
 * Problem A / Phase 1 — shared gate for the background sync triggers.
 *
 * Two questions that look similar and must NOT be conflated:
 *
 *   syncTriggerReady()      — can a sync round succeed RIGHT NOW?
 *   syncRecoveryCapability() — do we hold credentials that could get us back?
 *
 * Only the first one may gate a trigger. Gating on "we have credentials"
 * instead is what produced the 163 consecutive `sync scheduler tick rejected`
 * lines in the 2026-07-23 log: after a 401 the session is dropped but the
 * credentials are still around, so every tick kept starting a round that could
 * not possibly authenticate.
 *
 * `ctx.skybridgeSession` is the whole answer to the first question in BOTH
 * daemon modes. Since P5-d Phase 10 `ensureSkybridgeSession` never reads toml
 * and never bootstraps — the only way a session exists is
 * `installSkybridgeSession` (POST /sync/session from GUI main, or the cloud
 * self-login chain). A plaintext `auth.token` in toml is a legacy field the
 * daemon deliberately does not honour.
 */

import { type SkybridgeAuthSection, readSkybridgeConfig } from '@owl/core';
import type { AppContext } from '../context.js';

/**
 * True when a sync round can actually authenticate. The background triggers
 * (outbox watcher, scheduler) must check this before calling `runManualSync`,
 * and stay silent when it is false — the failure is expected, not newsworthy.
 */
export function syncTriggerReady(ctx: AppContext): boolean {
  return ctx.skybridgeSession != null;
}

/**
 * Which recovery routes are available, given what we have on hand.
 *
 * Deliberately two independent booleans rather than one "can recover" flag:
 * the two failure reasons need different capabilities. A session that was
 * never installed can be restored from a stored access token alone (legacy
 * refresh-less profiles predating D2 are still supported). A token the server
 * has REJECTED cannot — re-installing the same string just gets rejected
 * again, so that path needs a refresh token.
 *
 * Never throws: an unreadable / absent config just means no capability.
 */
export interface SyncRecoveryCapability {
  /** A stored access credential exists → re-installing the session may work. */
  canReinstall: boolean;
  /** A refresh credential exists → a rejected access token can be replaced. */
  canRefresh: boolean;
}

const NO_CAPABILITY: SyncRecoveryCapability = { canReinstall: false, canRefresh: false };

export function syncRecoveryCapability(ctx: AppContext): SyncRecoveryCapability {
  if (ctx.config.daemon.mode === 'cloud') {
    const creds = ctx.credentialStore?.get();
    if (!creds) return NO_CAPABILITY;
    return { canReinstall: Boolean(creds.token), canRefresh: Boolean(creds.refreshToken) };
  }

  let auth: SkybridgeAuthSection | undefined;
  try {
    auth = readSkybridgeConfig().auth;
  } catch {
    return NO_CAPABILITY; // not configured / unreadable
  }
  if (!auth) return NO_CAPABILITY;
  return {
    canReinstall: Boolean(auth.encrypted_token ?? auth.token),
    canRefresh: Boolean(auth.encrypted_refresh_token),
  };
}
