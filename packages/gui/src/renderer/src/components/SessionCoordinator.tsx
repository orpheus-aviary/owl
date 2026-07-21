import { getPlatform } from '@/platform';
import { probeWebSession } from '@/platform/web-session';
import { bootstrapSession } from '@/session/bootstrap';
import { activateWebSession } from '@/session/session-actions';
import { useSessionEpoch } from '@/stores/session-epoch';
import { useEffect, useRef } from 'react';

/**
 * ③ 会话隔离原语 / ④ web session UX — owns the FIRST bootstrap of a session.
 * Mounted once in `NormalSessionShell`, OUTSIDE the epoch-keyed session root, so
 * it survives every remount and stays the single owner of the cold-start probe
 * (`WebAuthGate` only renders login/MainApp off `getWebSession()` — it never
 * probes, so there is no "two owners double-activate" race). Renders nothing.
 *
 * Desktop (`requiresAuth === false`): sole owner of cold start. `bootstrapSession(0)`
 * on mount — no epoch bump / reset, since the stores start empty (bumping would
 * loop "start → remount → start"). It calls `endBootstrap(0)` itself.
 *
 * Web (`requiresAuth === true`, ④): rehydrate a persisted「记住我」token —
 * `probeWebSession` reads sessionStorage, whoamis `GET /auth/session`, and on
 * success we `activateWebSession` (publish bearer + bootstrap under a bumped
 * epoch). No token / bad token / 401 → drop the overlay to reveal login. The
 * initial phase is `bootstrapping`, so `BootstrapOverlay` covers the whole probe
 * — no login-screen flicker. Login / logout / 401 no longer route through here:
 * the web adapter calls `activateWebSession` / `invalidateSession` directly and
 * the transport's `onUnauthorized` hook handles 401s.
 */
export function SessionCoordinator(): null {
  const ranRef = useRef(false);

  useEffect(() => {
    // StrictMode double-mounts in dev — a ref (not a module-level flag) keeps
    // the once-guard per React root and test-isolated (module scope survives
    // HMR / multiple roots poorly).
    if (ranRef.current) return;
    ranRef.current = true;

    if (!getPlatform().requiresAuth) {
      void bootstrapSession(0); // desktop cold start; ends its own bootstrap
      return;
    }
    void rehydrateWebSession();
  }, []);

  return null;
}

/**
 * Web cold start: bring up a persisted session, or fall through to the login
 * screen. The `finally` is the overlay's guaranteed exit for every no-session
 * terminal state (no token / bad token / probe 401) — a successful activation
 * already bumped the epoch to 1, so its `endBootstrap(0)` is a gen-guarded
 * no-op (the activation's own bootstrap owns `endBootstrap(1)`).
 */
async function rehydrateWebSession(): Promise<void> {
  try {
    const session = await probeWebSession();
    if (session) await activateWebSession(session, { persist: true });
  } finally {
    useSessionEpoch.getState().endBootstrap(0);
  }
}
