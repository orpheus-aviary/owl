/**
 * Problem A / Phase 2B — refresh-on-401 gate.
 *
 * `maybeRecoverCloudSession` is the whole decision: whether a failed round is
 * worth retrying after refreshing the Layer-1 token. Tested directly rather
 * than through `runManualSync`, which would drag in the coalescer and a live db.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { DEFAULT_CONFIG, type Logger, type OwlConfig, SkybridgeAuthRequiredError } from '@owl/core';
import type { AppContext } from '../context.js';
import { maybeRecoverCloudSession } from './manual.js';

function silentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

function makeCtx(mode: 'local' | 'cloud'): AppContext {
  const config: OwlConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    daemon: { ...DEFAULT_CONFIG.daemon, mode },
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  return { config, logger: silentLogger() } as any;
}

/** The duck-typed shape the daemon recognises as a skybridge API error. */
function apiError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { name: 'ApiError', status });
}

function refresher(outcome: string, calls: { n: number }) {
  return async () => {
    calls.n += 1;
    return { outcome };
  };
}

let calls: { n: number };

beforeEach(() => {
  calls = { n: 0 };
});

describe('maybeRecoverCloudSession (Problem A / Phase 2B)', () => {
  it('retries after a successful refresh', async () => {
    const ok = await maybeRecoverCloudSession(
      makeCtx('cloud'),
      apiError(401),
      refresher('refreshed', calls),
    );
    assert.equal(ok, true);
    assert.equal(calls.n, 1);
  });

  it('does not retry when the refresh only failed transiently', async () => {
    const ok = await maybeRecoverCloudSession(
      makeCtx('cloud'),
      apiError(401),
      refresher('transient_failure', calls),
    );
    assert.equal(ok, false, 'the original 401 propagates; the recovery timer retries later');
  });

  it('does not retry once the server has declared the refresh token dead', async () => {
    const ok = await maybeRecoverCloudSession(
      makeCtx('cloud'),
      apiError(401),
      refresher('logged_out', calls),
    );
    assert.equal(ok, false);
  });

  // Desktop keeps its refresh token in the GUI keychain, so the daemon has
  // nothing to refresh with — that path belongs to Phase 2A.
  it('never refreshes on a local daemon', async () => {
    const ok = await maybeRecoverCloudSession(
      makeCtx('local'),
      apiError(401),
      refresher('refreshed', calls),
    );
    assert.equal(ok, false);
    assert.equal(calls.n, 0, 'no refresh attempted');
  });

  it('ignores failures that are not authentication failures', async () => {
    const ctx = makeCtx('cloud');
    for (const err of [apiError(500), new Error('socket hang up')]) {
      assert.equal(await maybeRecoverCloudSession(ctx, err, refresher('refreshed', calls)), false);
    }
    assert.equal(calls.n, 0);
  });

  it('treats a missing session as recoverable (credentials outlive it)', async () => {
    const ok = await maybeRecoverCloudSession(
      makeCtx('cloud'),
      new SkybridgeAuthRequiredError('skybridge session not installed'),
      refresher('refreshed', calls),
    );
    assert.equal(ok, true);
  });

  // A genuinely dead token would otherwise make every trigger (watcher, SSE,
  // scheduler) burn a refresh round-trip.
  it('cools down: a second 401 in the same window does not refresh again', async () => {
    const ctx = makeCtx('cloud');
    assert.equal(
      await maybeRecoverCloudSession(ctx, apiError(401), refresher('refreshed', calls)),
      true,
    );
    assert.equal(
      await maybeRecoverCloudSession(ctx, apiError(401), refresher('refreshed', calls)),
      false,
    );
    assert.equal(calls.n, 1, 'exactly one refresh inside the cooldown');
  });

  it('cooldown is per-context (dual-profile isolation)', async () => {
    const a = makeCtx('cloud');
    const b = makeCtx('cloud');
    await maybeRecoverCloudSession(a, apiError(401), refresher('refreshed', calls));
    const ok = await maybeRecoverCloudSession(b, apiError(401), refresher('refreshed', calls));
    assert.equal(ok, true);
    assert.equal(calls.n, 2);
  });
});
