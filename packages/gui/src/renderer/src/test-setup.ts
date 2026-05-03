// Vitest renderer-project setup. Keeps window.owlAPI present for every test
// file — individual tests can overwrite specific fields (startupMode,
// migration.start return value, etc.) inside their own beforeEach.

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

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
    quit: {
      onCheckUnsaved: vi.fn(() => () => {}),
      respond: vi.fn(),
    },
  };
}

Object.defineProperty(window, 'owlAPI', {
  value: defaultOwlAPI(),
  writable: true,
  configurable: true,
});
