import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@owl/core', async () => {
  const actual = await vi.importActual<typeof import('@owl/core')>('@owl/core');
  return { ...actual, probeStartupState: vi.fn() };
});

// Import AFTER vi.mock so the mocked probeStartupState is what precheck sees.
import { probeStartupState } from '@owl/core';
import { LATEST_KNOWN_VERSION } from '@owl/core';
import { runMigrationPrecheck } from './migration-precheck.js';

const mocked = vi.mocked(probeStartupState);

describe('runMigrationPrecheck — three-state mapping', () => {
  beforeEach(() => {
    mocked.mockReset();
  });

  // P1: file not present → normal
  it('P1: not-found probe → mode=normal', () => {
    mocked.mockReturnValue({ kind: 'not-found' });
    expect(runMigrationPrecheck('/tmp/a.db')).toEqual({ mode: 'normal' });
  });

  // P2: v=1 schemaEmpty=false → normal
  it('P2: v=1 schemaEmpty=false → mode=normal', () => {
    mocked.mockReturnValue({ kind: 'version', version: 1, schemaEmpty: false });
    expect(runMigrationPrecheck('/tmp/a.db')).toEqual({ mode: 'normal' });
  });

  // P3: v=0 schemaEmpty=true → normal (fresh db handled by createDatabase)
  it('P3: v=0 schemaEmpty=true → mode=normal', () => {
    mocked.mockReturnValue({ kind: 'version', version: 0, schemaEmpty: true });
    expect(runMigrationPrecheck('/tmp/a.db')).toEqual({ mode: 'normal' });
  });

  // P4: v=0 schemaEmpty=false → migrate-required (legacy pre-v0.3 db)
  it('P4: v=0 schemaEmpty=false → migrate-required', () => {
    mocked.mockReturnValue({ kind: 'version', version: 0, schemaEmpty: false });
    expect(runMigrationPrecheck('/tmp/a.db')).toEqual({
      mode: 'migrate-required',
      dbPath: '/tmp/a.db',
    });
  });

  // P5: future-version db → incompatible (quit only)
  it('P5: v > LATEST → incompatible', () => {
    mocked.mockReturnValue({ kind: 'version', version: 99, schemaEmpty: false });
    expect(runMigrationPrecheck('/tmp/a.db')).toEqual({
      mode: 'incompatible',
      dbPath: '/tmp/a.db',
      dbVersion: 99,
      maxSupported: LATEST_KNOWN_VERSION,
    });
  });
});
