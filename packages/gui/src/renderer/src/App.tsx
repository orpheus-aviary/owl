import { MainApp } from './MainApp';
import { BootstrapOverlay } from './components/BootstrapOverlay';
import { SessionCoordinator } from './components/SessionCoordinator';
import { WebAuthGate } from './components/WebAuthGate';
import { useWebUnloadGuard } from './hooks/useWebUnloadGuard';
import { MigrationDialog } from './pages/MigrationDialog';
import { getPlatform } from './platform';
import { useSessionEpoch } from './stores/session-epoch';

/**
 * Top-level branch based on the host's `startupMode`. The main process
 * decides the mode before the window is constructed (see main/window.ts
 * `additionalArguments`) so this is a synchronous, first-render decision.
 *
 * MigrationDialog intentionally sits OUTSIDE the session shell — it's an
 * app-wide blocking UI, not a page, and must NOT get the SessionCoordinator /
 * BootstrapOverlay (the overlay would permanently cover it, and the coordinator
 * would probe a daemon that isn't up yet). Once the dialog finishes and the
 * daemon is up, main-process destroys this window and creates a fresh one with
 * no `--startup-mode` arg; the new renderer picks the normal session shell.
 *
 * ③ 会话隔离原语 — for `mode: 'normal'` we render `NormalSessionShell`:
 * `SessionCoordinator` + `BootstrapOverlay` sit OUTSIDE the `key={epoch}`
 * session root, so a profile switch (`activateSession`) / web login remounts
 * only the session root (dropping component state + old SSE) while the
 * coordinator/overlay persist across the swap — no `location.reload()`.
 */
export function App() {
  const platform = getPlatform();
  // Web-only unsaved-work guard. Mounted here (above the session root) so it
  // outlives the WebAuthGate ↔ MainApp swap on 401 / token expiry; no-op on
  // Electron.
  useWebUnloadGuard();
  const startupMode = platform.startupMode;
  if (startupMode.mode !== 'normal') {
    return <MigrationDialog startupMode={startupMode} />;
  }
  return <NormalSessionShell requiresAuth={platform.requiresAuth} />;
}

function NormalSessionShell({ requiresAuth }: { requiresAuth: boolean }) {
  const epoch = useSessionEpoch((s) => s.epoch);
  return (
    <>
      <SessionCoordinator />
      <BootstrapOverlay />
      <SessionRoot key={epoch} requiresAuth={requiresAuth} />
    </>
  );
}

/**
 * The epoch-keyed session root: everything that must be torn down and rebuilt
 * on a session switch — the router, the SSE subscription (both inside MainApp),
 * and all component-local state. Web wraps it in the login gate; Electron
 * renders MainApp directly (`requiresAuth === false`).
 */
function SessionRoot({ requiresAuth }: { requiresAuth: boolean }) {
  if (requiresAuth) return <WebAuthGate />;
  return <MainApp />;
}
