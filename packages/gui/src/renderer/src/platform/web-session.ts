// Phase B (B1) — the web host's cloud Layer-2 session, held in memory only.
//
// Design ⭐2: the bearer token is NEVER persisted. A page refresh drops it and
// forces re-login — the most XSS-resistant choice (an injected script can read
// live JS state but can't exfiltrate a token that survives reloads). A future
// "记住我" option may opt into sessionStorage explicitly.
//
// Module-level singleton so three readers share one source of truth: the
// transport's getAuthHeaders (bearer injection), the React auth gate
// (useSyncExternalStore), and the web adapter's sync methods.

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

let current: WebSession | null = null;
const listeners = new Set<() => void>();

/** The live session, or null when logged out. Stable reference between changes. */
export function getWebSession(): WebSession | null {
  return current;
}

/** The bearer token, or null. Read per-request by the transport. */
export function getWebToken(): string | null {
  return current?.token ?? null;
}

export function setWebSession(session: WebSession): void {
  current = session;
  emit();
}

/** Clear the session (logout / 401). No-op when already cleared. */
export function clearWebSession(): void {
  if (current === null) return;
  current = null;
  emit();
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
