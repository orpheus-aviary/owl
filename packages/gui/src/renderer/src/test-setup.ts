// Vitest renderer-project setup. Keeps window.owlAPI present for every test
// file — individual tests can overwrite specific fields (startupMode,
// migration.start return value, etc.) inside their own beforeEach.

import { configureTransport } from '@orpheus-aviary/owl-shared';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// The shared API client reads its base URL from the configured transport.
// Tests don't run main.tsx, so wire it here to the legacy default so any test
// asserting on the full request URL keeps matching `http://127.0.0.1:47010`.
configureTransport({ baseUrl: () => 'http://127.0.0.1:47010' });

// @testing-library/react@16 does NOT auto-cleanup under vitest. Without
// this, mounted DOMs from previous tests stack up and getByRole trips on
// duplicates.
afterEach(() => {
  cleanup();
});

type OwlAPI = typeof window.owlAPI;

function defaultOwlAPI(): OwlAPI {
  return {
    daemonUrl: 'http://127.0.0.1:47010',
    startupMode: { mode: 'normal' },
    migration: {
      start: vi.fn(),
      onProgress: vi.fn(() => () => {}),
      onDaemonFailed: vi.fn(() => () => {}),
      done: vi.fn(),
      quit: vi.fn(),
    },
    cli: {
      detect: vi.fn(() => Promise.resolve({ installed: false })),
    },
    shortcut: {
      setGlobal: vi.fn(() => Promise.resolve()),
    },
    quit: {
      onCheckUnsaved: vi.fn(() => () => {}),
      respond: vi.fn(),
    },
    sync: {
      login: vi.fn(() => Promise.resolve({ ok: true, data: undefined } as const)),
      logout: vi.fn(() => Promise.resolve({ ok: true, data: undefined } as const)),
      status: vi.fn(() =>
        Promise.resolve({
          ok: true,
          data: { session: null, snapshot: null },
        } as const),
      ),
      devices: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          data: { devices: [] },
        }),
      ),
      revokeDevice: vi.fn(() => Promise.resolve({ ok: true as const, data: { revoked: true } })),
      run: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          data: {
            pulledTotal: 0,
            appliedTotal: 0,
            skippedTotal: 0,
            pushedTotal: 0,
            duplicatesTotal: 0,
            serverSeqHigh: 0,
            cursorBefore: 0,
            cursorAfter: 0,
            conflictsRecorded: 0,
          },
        }),
      ),
      profiles: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          data: {
            active: 'local',
            profiles: [
              {
                id: 'local',
                email: null,
                server_url: null,
                is_active: true,
                can_quick_switch: false,
                db_missing: false,
              },
            ],
          },
        }),
      ),
      switchProfile: vi.fn(() => Promise.resolve({ ok: true, data: undefined } as const)),
      deleteProfile: vi.fn(() =>
        Promise.resolve({ ok: true as const, data: { wasActive: false } }),
      ),
      onProfileSwitched: vi.fn(() => () => {}),
      onClaimPrompt: vi.fn(() => () => {}),
      respondClaim: vi.fn(),
    },
  };
}

Object.defineProperty(window, 'owlAPI', {
  value: defaultOwlAPI(),
  writable: true,
  configurable: true,
});
