/**
 * 0.6.2 W3 — the single place that turns an auth failure into a state.
 *
 * Every producer (manual sync's catch, `/sync/devices`, `/sync/revoke-device`,
 * the SSE bridge) calls this instead of `markError`, so the reason is decided
 * once and the "is this even an account?" question is asked once.
 *
 * A non-account profile must NOT silently return: the caller has usually
 * already called `markSyncing`, so returning without touching the snapshot
 * would strand the status bar at「同步中」forever. It gets a plain error
 * instead — accurate, and it can't be mistaken for a login prompt.
 */

import type { AppContext } from '../context.js';
import type { AuthReason } from '../events/types.js';
import { isAccountProfile } from './account-profile.js';
import { getSyncStatusBroadcaster } from './status-broadcaster.js';

export function signalAuthRequired(ctx: AppContext, reason: AuthReason, message: string): void {
  const broadcaster = getSyncStatusBroadcaster(ctx);
  if (!isAccountProfile(ctx)) {
    broadcaster.markError(message);
    return;
  }
  broadcaster.markAuthRequired(reason, message);
}
