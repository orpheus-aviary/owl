import { MainApp } from './MainApp';
import { MigrationDialog } from './pages/MigrationDialog';

/**
 * Top-level branch based on `window.owlAPI.startupMode`. The main process
 * decides the mode before the window is constructed (see main/window.ts
 * `additionalArguments`) so this is a synchronous, first-render decision.
 *
 * MigrationDialog intentionally sits OUTSIDE HashRouter — it's an app-wide
 * blocking UI, not a page. Once the dialog finishes and the daemon is up,
 * main-process destroys this window and creates a fresh one with no
 * `--startup-mode` arg; the new renderer picks MainApp.
 */
export function App() {
  const startupMode = window.owlAPI.startupMode;
  if (startupMode.mode !== 'normal') {
    return <MigrationDialog startupMode={startupMode} />;
  }
  return <MainApp />;
}
