import {
  IncompatibleDbError,
  LATEST_KNOWN_VERSION,
  MigrationBusyError,
  SchemaMismatchError,
  SourceDbCorruptionError,
} from '@owl/core';
import { describe, expect, it, vi } from 'vitest';

// migration-ipc imports electron; stub just what mapMigrationError touches
// (nothing) — but the import graph reaches `app` / `ipcMain`, so stub those.
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { mapMigrationError } from './migration-ipc.js';

describe('mapMigrationError — pure error → { reason, message }', () => {
  // E1: MigrationBusyError passes through reason + message verbatim
  it('E1: MigrationBusyError(daemon_alive) → reason=daemon_alive', () => {
    const err = new MigrationBusyError('daemon_alive', 'daemon running');
    expect(mapMigrationError(err)).toEqual({
      ok: false,
      reason: 'daemon_alive',
      message: 'daemon running',
    });
  });

  // E2: every reason comes through (use lock_file to differentiate from E1)
  it('E2: MigrationBusyError(lock_file) → reason=lock_file', () => {
    const err = new MigrationBusyError('lock_file', 'stale lock');
    expect(mapMigrationError(err)).toEqual({
      ok: false,
      reason: 'lock_file',
      message: 'stale lock',
    });
  });

  // E3: SourceDbCorruptionError → fixed reason, formatted message with count
  it('E3: SourceDbCorruptionError → source_db_corruption + violation count', () => {
    const err = new SourceDbCorruptionError(3);
    const mapped = mapMigrationError(err);
    expect(mapped.ok).toBe(false);
    expect(mapped.reason).toBe('source_db_corruption');
    expect(mapped.message).toContain('3');
    expect(mapped.message).toContain('原库未变动');
  });

  // E4: SchemaMismatchError — details propagated into Chinese copy
  it('E4: SchemaMismatchError → schema_mismatch + details text', () => {
    const err = new SchemaMismatchError(
      '/tmp/a.db',
      "table 'notes' missing required column 'content'",
    );
    const mapped = mapMigrationError(err);
    expect(mapped.ok).toBe(false);
    expect(mapped.reason).toBe('schema_mismatch');
    expect(mapped.message).toContain("missing required column 'content'");
  });

  // E5: IncompatibleDbError — version numbers rendered in Chinese copy.
  // Uses LATEST_KNOWN_VERSION so the assertion tracks schema bumps (P3.4-a: 1→2).
  it('E5: IncompatibleDbError → incompatible + v99 + max-supported text', () => {
    const err = new IncompatibleDbError('/tmp/a.db', 99);
    const mapped = mapMigrationError(err);
    expect(mapped.ok).toBe(false);
    expect(mapped.reason).toBe('incompatible');
    expect(mapped.message).toContain('v99');
    expect(mapped.message).toContain(`v${LATEST_KNOWN_VERSION}`);
  });

  // E6: generic Error falls through to `unknown` with the message preserved
  it('E6: plain Error → reason=unknown + original message', () => {
    expect(mapMigrationError(new Error('boom'))).toEqual({
      ok: false,
      reason: 'unknown',
      message: 'boom',
    });
  });

  // E7: non-Error throwable (string, number, etc.) stringified
  it('E7: non-Error throwable → reason=unknown + String(err)', () => {
    expect(mapMigrationError('plain string')).toEqual({
      ok: false,
      reason: 'unknown',
      message: 'plain string',
    });
  });
});
