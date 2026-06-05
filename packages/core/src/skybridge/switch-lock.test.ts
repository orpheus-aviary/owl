import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  SWITCH_LOCK_TTL_MS,
  type SwitchLock,
  isSwitchLockActive,
  newSwitchLockNonce,
  readSwitchLock,
  releaseSwitchLock,
  touchSwitchLock,
  writeSwitchLock,
} from './switch-lock.js';

describe('switch-lock (P5-d Phase 21, W10)', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switch-lock-test-'));
    lockPath = join(dir, 'profile-switch.lock');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('write → read round-trips a valid lock owned by this process', () => {
    const nonce = newSwitchLockNonce();
    writeSwitchLock(nonce, lockPath);
    const lock = readSwitchLock(lockPath);
    assert.ok(lock);
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.nonce, nonce);
    assert.equal(typeof lock.started_at, 'number');
  });

  it('reads null for a missing file', () => {
    assert.equal(readSwitchLock(lockPath), null);
  });

  it('reads null for torn / corrupt JSON', () => {
    writeFileSync(lockPath, '{"pid": 12', 'utf8'); // truncated mid-write
    assert.equal(readSwitchLock(lockPath), null);
  });

  it('reads null for shape-invalid JSON (empty object, bad pid, empty nonce)', () => {
    for (const bad of [
      '{}',
      JSON.stringify({ pid: 0, started_at: 1, nonce: 'n' }), // pid not > 0
      JSON.stringify({ pid: 1.5, started_at: 1, nonce: 'n' }), // pid not integer
      JSON.stringify({ pid: 1, started_at: -1, nonce: 'n' }), // started_at not > 0
      JSON.stringify({ pid: 1, started_at: 1, nonce: '' }), // empty nonce
      JSON.stringify({ pid: 1, started_at: 1 }), // missing nonce
    ]) {
      writeFileSync(lockPath, bad, 'utf8');
      assert.equal(readSwitchLock(lockPath), null, `should reject: ${bad}`);
    }
  });

  it('touch refreshes started_at only when the nonce matches', () => {
    const nonce = newSwitchLockNonce();
    writeSwitchLock(nonce, lockPath);
    const before = readSwitchLock(lockPath);
    assert.ok(before);
    // Backdate the stored timestamp, then touch with the right / wrong nonce.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, started_at: before.started_at - 10_000, nonce }),
      'utf8',
    );
    touchSwitchLock('not-the-owner', lockPath); // wrong owner → no-op
    assert.equal(readSwitchLock(lockPath)?.started_at, before.started_at - 10_000);
    touchSwitchLock(nonce, lockPath); // right owner → refreshed
    assert.ok((readSwitchLock(lockPath)?.started_at ?? 0) > before.started_at - 10_000);
  });

  it('release only deletes the lock when the nonce matches (owner token)', () => {
    const nonce = newSwitchLockNonce();
    writeSwitchLock(nonce, lockPath);
    releaseSwitchLock('someone-else', lockPath); // not the owner → kept
    assert.ok(readSwitchLock(lockPath));
    releaseSwitchLock(nonce, lockPath); // owner → removed
    assert.equal(readSwitchLock(lockPath), null);
  });

  it('release on a missing lock is a no-op (no throw)', () => {
    assert.doesNotThrow(() => releaseSwitchLock('x', lockPath));
  });

  it('isSwitchLockActive: null / dead pid / stale timestamp → inactive', () => {
    assert.equal(isSwitchLockActive(null), false);
    // A pid far above any real process table → not alive.
    const deadPid: SwitchLock = { pid: 2_147_483_646, started_at: Date.now(), nonce: 'n' };
    assert.equal(isSwitchLockActive(deadPid), false);
    // Alive pid but timestamp older than the TTL → stale.
    const stale: SwitchLock = {
      pid: process.pid,
      started_at: Date.now() - SWITCH_LOCK_TTL_MS - 1_000,
      nonce: 'n',
    };
    assert.equal(isSwitchLockActive(stale), false);
  });

  it('isSwitchLockActive: alive pid + fresh timestamp → active', () => {
    writeSwitchLock(newSwitchLockNonce(), lockPath);
    assert.equal(isSwitchLockActive(readSwitchLock(lockPath)), true);
  });
});
