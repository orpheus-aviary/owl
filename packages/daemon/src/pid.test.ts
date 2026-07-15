import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { paths } from '@owl/core';
import { DaemonAlreadyRunningError, acquireDaemonLock, readPid, removePid } from './pid.js';

// A PID far above macOS's wrap range (~99999) / typical Linux pid_max — no
// process can hold it, so process.kill(pid, 0) reports ESRCH ("dead").
const DEAD_PID = 999999;

describe('acquireDaemonLock (A6 atomic lock)', () => {
  const original = process.env.OWL_NEST_DIR;
  let nest: string;

  beforeEach(() => {
    nest = mkdtempSync(join(tmpdir(), 'owl-pidlock-'));
    process.env.OWL_NEST_DIR = nest;
    mkdirSync(paths.owlDir(), { recursive: true });
  });

  afterEach(() => {
    removePid();
    if (original === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined stringifies it in process.env
      delete process.env.OWL_NEST_DIR;
    } else {
      process.env.OWL_NEST_DIR = original;
    }
    rmSync(nest, { recursive: true, force: true });
  });

  it('writes our pid on a fresh acquire', () => {
    acquireDaemonLock();
    assert.equal(readFileSync(paths.pidPath(), 'utf8').trim(), String(process.pid));
  });

  it('throws DaemonAlreadyRunningError when a live daemon holds the lock', () => {
    acquireDaemonLock(); // our own (live) pid now owns it
    assert.throws(() => acquireDaemonLock(), DaemonAlreadyRunningError);
  });

  it('reclaims a stale lock (dead pid) and acquires', () => {
    writeFileSync(paths.pidPath(), String(DEAD_PID), 'utf8');
    assert.doesNotThrow(() => acquireDaemonLock());
    assert.equal(readPid(), process.pid);
  });
});
