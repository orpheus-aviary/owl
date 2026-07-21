import { getPlatform } from '@/platform';
import { getWebSession, subscribeWebSession } from '@/platform/web-session';
import { bootstrapSession } from '@/session/bootstrap';
import { activateSession, invalidateSession } from '@/session/session-actions';
import { useSessionEpoch } from '@/stores/session-epoch';
import { useEffect, useRef } from 'react';

/**
 * ③ 会话隔离原语 — owns the FIRST bootstrap of a session and drives session
 * transitions. Mounted once in `NormalSessionShell`, OUTSIDE the epoch-keyed
 * session root, so it survives every remount and stays the single owner of the
 * cold-start probe (`WebAuthGate` only renders login/MainApp off `getWebSession()`
 * — it never probes, so there is no "two owners double-activate" race).
 * Renders nothing.
 *
 * Desktop (`requiresAuth === false`): sole owner of cold start. `bootstrapSession(0)`
 * on mount — no epoch bump / reset, since the stores start empty (bumping would
 * loop "start → remount → start"). It calls `endBootstrap(0)` itself.
 *
 * Web (`requiresAuth === true`): ④ replaces the initial branch with the
 * token-rehydration probe (sessionStorage token → GET /auth/session →
 * activateWebSession) and folds the login/logout bridge into
 * `activateWebSession` + the transport 401 hook. Until then web-session lives in
 * memory only, so a fresh load has no token → reveal the login screen; a login
 * publishes a session → activate; a logout clears it → invalidate.
 */
export function SessionCoordinator(): null {
  const ranRef = useRef(false);

  useEffect(() => {
    // StrictMode double-mounts in dev — a ref (not a module-level flag) keeps
    // the once-guard per React root and test-isolated (survives HMR poorly if
    // module-scoped).
    if (ranRef.current) return;
    ranRef.current = true;

    if (!getPlatform().requiresAuth) {
      void bootstrapSession(0); // desktop cold start; ends its own bootstrap
      return;
    }
    // Web (③ interim): no persisted token to probe. A present session (e.g. a
    // dev harness) still bootstraps; otherwise reveal the login screen.
    if (getWebSession()) void bootstrapSession(0);
    else useSessionEpoch.getState().endBootstrap(0);
  }, []);

  // Web: activate on login, invalidate on logout. ④ subsumes this into
  // activateWebSession + the transport onUnauthorized hook.
  useEffect(() => {
    if (!getPlatform().requiresAuth) return;
    return subscribeWebSession(() => {
      if (getWebSession()) void activateSession();
      else invalidateSession();
    });
  }, []);

  return null;
}
