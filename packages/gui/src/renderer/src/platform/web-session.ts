// Phase B (B1) / 0.6 ④ — the web host's cloud Layer-2 session.
//
// Persistence (④, design D7): opt-in and TOKEN-ONLY. By default the bearer lives
// in memory only — a refresh drops it and forces re-login (the most XSS-resistant
// choice: an injected script can read live JS state but can't exfiltrate a token
// that never survives a reload). With「记住我」the token (and ONLY the token — never
// the identity) is written to `sessionStorage`; on the next load `probeWebSession`
// re-derives the full session from `GET /auth/session`. `sessionStorage` (not
// `localStorage`) so the token dies with the tab, not the browser profile.
//
// Module-level singleton so several readers share one source of truth: the
// transport's getAuthHeaders (bearer injection), the React auth gate
// (useSyncExternalStore), and the web adapter's sync methods.

import { type ApiResponse, request } from '@orpheus-aviary/owl-shared';

/** Identity returned by `POST /auth/login` / `GET /auth/session`. */
export interface WebIdentity {
  profile_id: string;
  user_id: string;
  email: string;
  server_url: string;
  device_id: string;
  workspace_id: string;
}

export interface WebSession {
  token: string;
  identity: WebIdentity;
  /** Layer-2 sliding expiry (epoch ms), from the login/session response. */
  expiresAt: number;
}

/** `GET /auth/session` payload — whoami: identity + expiry, but NO token (the
 *  client already holds it; on rehydration we pair it with the stored token). */
interface SessionData {
  expires_at: number;
  identity: WebIdentity;
}

const STORAGE_KEY = 'owl.web.token';

let current: WebSession | null = null;
/**
 * The bearer used ONLY during token rehydration, before the full session is
 * derived. `getWebToken` falls back to it so the probe's `GET /auth/session`
 * carries the stored token, but `getWebSession` stays null (there is no identity
 * yet) — so a probe 401 is judged by `SessionCoordinator`, not the global 401
 * hook (which compares against `getWebSession()?.token`).
 */
let probingToken: string | null = null;
/** Token-bound single-flight for `probeWebSession` (StrictMode / racing probes). */
let probeInflight: { token: string; promise: Promise<WebSession | null> } | null = null;
const listeners = new Set<() => void>();

/** The live session, or null when logged out / mid-probe. */
export function getWebSession(): WebSession | null {
  return current;
}

/** The bearer token for the transport: the live session's, or the probe token
 *  during rehydration. Read per-request. */
export function getWebToken(): string | null {
  return current?.token ?? probingToken;
}

/**
 * Publish a session (login / rehydration success). Clears any probe token and
 * makes sessionStorage strictly reflect this session's「记住我」choice: `persist`
 * writes the token (only), otherwise any stale persisted token is removed.
 * Always emits.
 */
export function setWebSession(session: WebSession, opts: { persist?: boolean } = {}): void {
  current = session;
  probingToken = null;
  try {
    if (opts.persist) sessionStorage.setItem(STORAGE_KEY, session.token);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode / disabled storage — the in-memory session still works.
  }
  emit();
}

/**
 * Clear the session (logout / 401 / bad stored token). UNCONDITIONALLY drops the
 * persisted token — even when the in-memory session is already empty — so a bad
 * token can't be re-probed forever. Emits only when a live session actually went
 * away (a probe-token-only clear has no `getWebSession` subscriber to notify).
 */
export function clearWebSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore — nothing to remove if storage is unavailable.
  }
  const hadSession = current !== null;
  current = null;
  probingToken = null;
  if (hadSession) emit();
}

/**
 * Rehydrate a session from a persisted token (④, design D8 — run by
 * `SessionCoordinator`). Returns the full session on success (the caller
 * publishes it via `activateWebSession`), or null when there is no stored token,
 * the probe 401s, or it was superseded. Token-bound single-flight so a racing
 * probe (StrictMode double-mount) collapses to one request and a stale probe
 * never overwrites a newer session.
 */
export function probeWebSession(): Promise<WebSession | null> {
  const token = getStoredToken();
  if (!token) return Promise.resolve(null);
  if (probeInflight && probeInflight.token === token) return probeInflight.promise;
  const promise = runProbe(token);
  probeInflight = { token, promise };
  void promise.finally(() => {
    // Clear by identity so a newer probe started after this settles is kept.
    if (probeInflight?.promise === promise) probeInflight = null;
  });
  return promise;
}

async function runProbe(token: string): Promise<WebSession | null> {
  probingToken = token; // the transport now attaches it as the bearer
  try {
    const res: ApiResponse<SessionData> = await request<SessionData>('GET', '/auth/session');
    // A newer probe / published session raced ahead while we awaited → discard.
    if (probingToken !== token) return null;
    const d = res.data;
    if (!d) {
      clearWebSession();
      return null;
    }
    return { token, identity: d.identity, expiresAt: d.expires_at };
  } catch {
    // 401 / network — drop the bad token and reveal the login screen. Guard the
    // clear so a probe superseded mid-flight doesn't wipe the newer session.
    if (probingToken === token) clearWebSession();
    return null;
  }
}

/** The persisted token, or null (missing / storage unavailable / read error). */
function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Subscribe to session changes (login / logout / expiry). Returns unsubscribe. */
export function subscribeWebSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}
