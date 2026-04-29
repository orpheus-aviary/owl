// Pure mapping: @owl/core's probeStartupState → GUI's three-state StartupMode.
//
// Kept separate from window.ts / index.ts so:
//   1. @owl/gui doesn't import better-sqlite3 (@owl/core owns the probe).
//   2. Tests can vi.mock('@owl/core') and exercise each branch without
//      touching native bindings.

import { LATEST_KNOWN_VERSION, probeStartupState } from '@owl/core';

export type StartupMode =
  | { mode: 'normal' }
  | { mode: 'migrate-required'; dbPath: string }
  | { mode: 'incompatible'; dbPath: string; dbVersion: number; maxSupported: number };

/**
 * Look at the db on disk and decide which UI the GUI should mount:
 *   - not-found or v=LATEST or v=0+empty → 'normal' (daemon + main app)
 *   - v > LATEST → 'incompatible' (MigrationDialog error screen, quit only)
 *   - v=0 + non-empty → 'migrate-required' (MigrationDialog confirm screen)
 */
export function runMigrationPrecheck(dbPath: string): StartupMode {
  const probe = probeStartupState(dbPath);

  if (probe.kind === 'not-found') {
    return { mode: 'normal' };
  }

  if (probe.version > LATEST_KNOWN_VERSION) {
    return {
      mode: 'incompatible',
      dbPath,
      dbVersion: probe.version,
      maxSupported: LATEST_KNOWN_VERSION,
    };
  }

  if (probe.version === 0 && !probe.schemaEmpty) {
    return { mode: 'migrate-required', dbPath };
  }

  return { mode: 'normal' };
}
