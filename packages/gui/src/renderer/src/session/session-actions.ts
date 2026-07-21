import { type WebSession, setWebSession } from '@/platform/web-session';
import { resetAllStores } from '@/stores/reset';
import { useSessionEpoch } from '@/stores/session-epoch';
import { bootstrapSession } from './bootstrap';

/**
 * ③ 会话生命周期动作 — the two ways a session ends, kept deliberately separate.
 * Collapsing them into one `resetSession` breaks web: a logout would either
 * never trigger a bootstrap or loop through 401 → reset → 401.
 *
 * `resetAllStores()` is the single owner of teardown cleanup (it aborts AI
 * streams + clears the note-id caches internally), so neither action repeats
 * that here.
 */

/** Reset the HashRouter back to the editor root so a new session never inherits
 *  the previous one's route. Set before the keyed session root remounts. */
function resetRouteToHome(): void {
  if (typeof window !== 'undefined') window.location.hash = '#/';
}

/**
 * Session went away with nothing to replace it (web logout / REST-or-SSE 401).
 * Bumps the epoch — invalidating every in-flight async write-back — and wipes
 * the stores, but does NOT bootstrap: the login screen shows instead (web) or
 * the caller brings up a new session separately.
 */
export function invalidateSession(): void {
  useSessionEpoch.getState().beginInvalidate();
  resetAllStores();
  resetRouteToHome();
}

/**
 * A new session is ready and should be brought up (desktop profile switch:
 * `onProfileSwitched` fired after main committed the daemon-side DB swap).
 * Atomically bumps the epoch + flips to `bootstrapping` (overlay covers the
 * reset→refill window), wipes the stores, then refills them for the new
 * session. The keyed session root remounts on the epoch change — dropping
 * component-local state and reconnecting SSE under the new profile.
 *
 * Web login / token rehydration go through `activateWebSession` (④) instead,
 * which additionally publishes the bearer before bootstrap.
 */
export async function activateSession(): Promise<void> {
  const gen = useSessionEpoch.getState().beginBootstrap();
  resetAllStores();
  resetRouteToHome();
  await bootstrapSession(gen);
}

/**
 * ④ web session UX — the SINGLE activation entry for the web host, shared by
 * login and token rehydration. Same shape as `activateSession` but with one
 * extra, ordering-critical step: it publishes the bearer BETWEEN the store reset
 * and the bootstrap, so `bootstrapSession`'s fetches already carry the new
 * token. Going through here (rather than a bare `setWebSession`) is what
 * guarantees the begin → reset → publish → bootstrap order — a direct
 * `setWebSession` from the adapter would bootstrap under the old/empty epoch or
 * skip the reset entirely.
 *
 * `persist` threads「记住我」through: login passes the checkbox value, rehydration
 * passes `true` (the token was already persisted — keep it).
 *
 * Unlike `activateSession`, this does NOT reset the route: web activation covers
 * rehydration-on-refresh, where the same account is reloading its CURRENT view
 * (e.g. `#/note/x`) — forcing it home would drop the deep link. A logout / 401
 * already routes home via `invalidateSession`, so a subsequent login starts
 * there anyway.
 */
export async function activateWebSession(
  session: WebSession,
  opts: { persist: boolean },
): Promise<void> {
  const gen = useSessionEpoch.getState().beginBootstrap();
  resetAllStores();
  setWebSession(session, { persist: opts.persist }); // publish bearer BEFORE bootstrap
  await bootstrapSession(gen);
}
