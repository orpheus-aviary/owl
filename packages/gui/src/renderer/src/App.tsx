import { MainApp } from './MainApp';
import { WebAuthGate } from './components/WebAuthGate';
import { useWebUnloadGuard } from './hooks/useWebUnloadGuard';
import { MigrationDialog } from './pages/MigrationDialog';
import { getPlatform } from './platform';

/**
 * Top-level branch based on the host's `startupMode`. The main process
 * decides the mode before the window is constructed (see main/window.ts
 * `additionalArguments`) so this is a synchronous, first-render decision.
 *
 * MigrationDialog intentionally sits OUTSIDE HashRouter — it's an app-wide
 * blocking UI, not a page. Once the dialog finishes and the daemon is up,
 * main-process destroys this window and creates a fresh one with no
 * `--startup-mode` arg; the new renderer picks MainApp.
 *
 * Phase B (B1): the web host (`requiresAuth`) gates on a login screen until a
 * cloud session exists. Electron's `requiresAuth` is false, so the desktop
 * renders straight into MainApp — unchanged.
 */
export function App() {
  const platform = getPlatform();
  // Web-only unsaved-work guard. Mounted here (the session root) so it outlives
  // the WebAuthGate ↔ MainApp swap on 401 / token expiry; no-op on Electron.
  useWebUnloadGuard();
  const startupMode = platform.startupMode;
  if (startupMode.mode !== 'normal') {
    return <MigrationDialog startupMode={startupMode} />;
  }
  if (platform.requiresAuth) {
    return <WebAuthGate />;
  }
  return <MainApp />;
}
