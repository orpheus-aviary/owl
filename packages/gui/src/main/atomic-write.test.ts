/**
 * P5-d Phase 7 — atomic-write.ts unit tests.
 *
 * Uses real fs in a per-test tmp dir so the fsync + rename path is
 * exercised end-to-end. Crash injection mocks the rename step via
 * dependency-free direct manipulation — we write content to `<path>.tmp`,
 * then verify cleanupStaleTmp removes it without touching the final file.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteFile, cleanupStaleTmp, tmpPathFor } from './atomic-write.js';

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
  cfgPath = join(dir, 'test.toml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteFile (P5-d Phase 7)', () => {
  it('writes the final file with the exact content', () => {
    atomicWriteFile(cfgPath, 'hello = "world"\n');
    expect(readFileSync(cfgPath, 'utf-8')).toBe('hello = "world"\n');
  });

  it('removes the .tmp sidecar after rename', () => {
    atomicWriteFile(cfgPath, 'a = 1\n');
    expect(existsSync(tmpPathFor(cfgPath))).toBe(false);
    expect(existsSync(cfgPath)).toBe(true);
  });

  it('replaces an existing file with new content', () => {
    writeFileSync(cfgPath, 'old\n');
    atomicWriteFile(cfgPath, 'new\n');
    expect(readFileSync(cfgPath, 'utf-8')).toBe('new\n');
  });

  it('writes the final file with mode 0600 (POSIX)', () => {
    // chmod is a no-op on Windows — skip the bit-level assertion there.
    if (process.platform === 'win32') return;
    atomicWriteFile(cfgPath, 'x\n');
    const mode = statSync(cfgPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('honors a custom mode option', () => {
    if (process.platform === 'win32') return;
    atomicWriteFile(cfgPath, 'x\n', { mode: 0o644 });
    const mode = statSync(cfgPath).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  it('honors a custom tmpSuffix', () => {
    // We can't observe the tmp file mid-write since the call is synchronous,
    // but we CAN verify the helper exposes the same suffix rule it uses.
    expect(tmpPathFor(cfgPath, '.tmp.gui')).toBe(`${cfgPath}.tmp.gui`);
    atomicWriteFile(cfgPath, 'x\n', { tmpSuffix: '.tmp.gui' });
    expect(existsSync(`${cfgPath}.tmp.gui`)).toBe(false);
    expect(existsSync(cfgPath)).toBe(true);
  });
});

describe('cleanupStaleTmp (P5-d Phase 7)', () => {
  it('removes a stale .tmp left from a previous crash', () => {
    // Simulate: previous run wrote .tmp but crashed before rename.
    const tmp = tmpPathFor(cfgPath);
    writeFileSync(tmp, 'half-written\n');
    expect(existsSync(tmp)).toBe(true);

    cleanupStaleTmp(cfgPath);
    expect(existsSync(tmp)).toBe(false);
  });

  it('leaves the final file untouched even when a stale .tmp existed', () => {
    writeFileSync(cfgPath, 'final\n');
    writeFileSync(tmpPathFor(cfgPath), 'crashed\n');

    cleanupStaleTmp(cfgPath);
    expect(readFileSync(cfgPath, 'utf-8')).toBe('final\n');
  });

  it('is a no-op when no .tmp sidecar exists', () => {
    // Should not throw.
    expect(() => cleanupStaleTmp(cfgPath)).not.toThrow();
  });

  it('honors a custom tmpSuffix matching the writer', () => {
    writeFileSync(`${cfgPath}.tmp.gui`, 'crashed\n');
    cleanupStaleTmp(cfgPath, '.tmp.gui');
    expect(existsSync(`${cfgPath}.tmp.gui`)).toBe(false);
  });
});

// P5-d Phase 7 — explicit crash-injection scenario from §3.7.4.
describe('crash injection: stale .tmp from previous run (§3.7.4)', () => {
  it('startup cleanup removes .tmp; new atomicWriteFile produces a clean file', () => {
    // Step 1: previous run crashed between fsync and rename.
    writeFileSync(cfgPath, 'committed-from-previous-run\n');
    writeFileSync(tmpPathFor(cfgPath), 'lingering-after-crash\n');

    // Step 2: new GUI startup.
    cleanupStaleTmp(cfgPath);
    expect(existsSync(tmpPathFor(cfgPath))).toBe(false);
    expect(readFileSync(cfgPath, 'utf-8')).toBe('committed-from-previous-run\n');

    // Step 3: new write completes normally.
    atomicWriteFile(cfgPath, 'fresh-after-cleanup\n');
    expect(existsSync(tmpPathFor(cfgPath))).toBe(false);
    expect(readFileSync(cfgPath, 'utf-8')).toBe('fresh-after-cleanup\n');
  });
});
