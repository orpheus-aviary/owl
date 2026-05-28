/**
 * P5-d Phase 10 — `ensureSkybridgeSession` post-retirement behaviour.
 *
 * After Phase 10 retired daemon's plaintext bootstrap, this function
 * no longer reads toml, no longer calls registerDevice / ensureWorkspace,
 * no longer writes the on-disk config. It either returns the cached
 * `ctx.skybridgeSession` or throws `SkybridgeAuthRequiredError`.
 *
 * We don't spy on readSkybridgeConfig / writeSkybridgeConfig — those
 * are statically imported from @owl/core and node:test doesn't mock
 * easily. Instead we lean on two checks:
 *   - point OWL_NEST_DIR at an empty tmp dir so any toml read would
 *     surface as SkybridgeNotConfiguredError, not AuthRequired —
 *     proves the function doesn't read toml on the missing-session path
 *   - the bash guard `daemon-no-toml-write` (Phase 10) blocks any
 *     writeSkybridgeConfig / clearSkybridgeAuth call from daemon source
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SkybridgeAuthRequiredError } from '@owl/core';
import type { AppContext } from '../context.js';
import { ensureSkybridgeSession } from './session.js';
import type { SkybridgeSession } from './session.js';

function fakeSession(): SkybridgeSession {
  // Minimal stub — ensureSkybridgeSession only checks identity equality
  // against ctx.skybridgeSession, never touches the fields.
  return {
    realClient: {} as SkybridgeSession['realClient'],
    module: {} as SkybridgeSession['module'],
    config: { server: { url: 'http://srv' } } as SkybridgeSession['config'],
    workspaceId: 'ws-A',
    deviceId: 'dev-A',
    serverUrl: 'http://srv',
  };
}

describe('ensureSkybridgeSession (P5-d Phase 10 — retired bootstrap)', () => {
  let nestDir: string;
  let priorEnv: string | undefined;
  let ctx: AppContext;

  before(() => {
    // Empty nest dir → any toml read attempt would throw, proving the
    // function does not read toml on the no-session path.
    nestDir = mkdtempSync(join(tmpdir(), 'ensure-session-empty-'));
    priorEnv = process.env.OWL_NEST_DIR;
    process.env.OWL_NEST_DIR = nestDir;
    ctx = { skybridgeSession: null } as unknown as AppContext;
  });

  after(() => {
    if (priorEnv === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined stringifies to "undefined"
      delete process.env.OWL_NEST_DIR;
    } else {
      process.env.OWL_NEST_DIR = priorEnv;
    }
    rmSync(nestDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    ctx.skybridgeSession = null;
  });

  it('returns the cached session when ctx.skybridgeSession is set', async () => {
    const session = fakeSession();
    ctx.skybridgeSession = session;
    const got = await ensureSkybridgeSession(ctx);
    assert.equal(got, session, 'returns the same reference');
  });

  it('throws SkybridgeAuthRequiredError when no session installed', async () => {
    await assert.rejects(
      ensureSkybridgeSession(ctx),
      (err: unknown) => err instanceof SkybridgeAuthRequiredError,
      'must throw SkybridgeAuthRequiredError on missing session',
    );
  });

  it('no-session throw works even with an empty nest dir (no toml read)', async () => {
    // If ensureSkybridgeSession still tried to read toml, the empty
    // nest dir would surface as SkybridgeNotConfiguredError. Asserting
    // AuthRequired proves the toml path is not exercised.
    let caught: unknown = null;
    try {
      await ensureSkybridgeSession(ctx);
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof SkybridgeAuthRequiredError,
      `expected SkybridgeAuthRequiredError, got ${caught}`,
    );
  });

  it('a second call with the same cached session is idempotent (no extra work)', async () => {
    const session = fakeSession();
    ctx.skybridgeSession = session;
    const a = await ensureSkybridgeSession(ctx);
    const b = await ensureSkybridgeSession(ctx);
    assert.equal(a, b, 'same reference on repeat call');
    assert.equal(ctx.skybridgeSession, session, 'ctx is not mutated');
  });
});
