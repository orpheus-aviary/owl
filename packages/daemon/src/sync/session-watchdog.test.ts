/**
 * 0.6.3 V3 — cloud session watchdog.
 *
 * Two of these cases exist because the first draft of the plan got them
 * wrong, and both mistakes would have produced a watchdog that stays silent
 * in exactly the situation it was written for:
 *
 *   - "credentials OR session" as the health signal → after a 401 the
 *     credentials survive and the session doesn't, so a rejected-token daemon
 *     would look healthy forever;
 *   - stopping it from `stopBackgroundHandles` → `teardownCloudSession` calls
 *     that and never restarts, so the alarm dies the moment the session is
 *     permanently gone.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, type Logger, type OwlConfig } from '@owl/core';
import { teardownCloudSession } from '../cloud-login.js';
import type { AppContext } from '../context.js';
import { startSessionWatchdog } from './session-watchdog.js';

interface Recorded {
  level: 'info' | 'warn';
  obj: Record<string, unknown>;
  msg: string;
}

function recordingLogger(sink: Recorded[]): Logger {
  const push =
    (level: 'info' | 'warn') =>
    (a: unknown, b?: unknown): void => {
      sink.push({
        level,
        obj: typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : {},
        msg: String(b ?? (typeof a === 'string' ? a : '')),
      });
    };
  return {
    info: push('info'),
    warn: push('warn'),
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
}

/** Manual clock + timer so a 70-minute scenario runs instantly. */
function harness(mode: 'local' | 'cloud' = 'cloud') {
  const logs: Recorded[] = [];
  const config: OwlConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    daemon: { ...DEFAULT_CONFIG.daemon, mode },
  };
  const ctx = {
    config,
    logger: recordingLogger(logs),
    skybridgeSession: null,
    // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub
  } as any as AppContext;

  let clock = 1_000_000;
  let tick: (() => void) | null = null;
  let cleared = 0;

  const handle = startSessionWatchdog(ctx, ctx.logger, {
    now: () => clock,
    setInterval: ((fn: () => void) => {
      tick = fn;
      return { unref: () => {} } as unknown as NodeJS.Timeout;
      // biome-ignore lint/suspicious/noExplicitAny: fake timer shape
    }) as any,
    clearInterval: (() => {
      cleared += 1;
      // biome-ignore lint/suspicious/noExplicitAny: fake timer shape
    }) as any,
  });

  return {
    ctx,
    logs,
    handle,
    clearedCount: () => cleared,
    /** Advance the clock by `minutes` and fire one poll. */
    advance(minutes: number): void {
      clock += minutes * 60_000;
      tick?.();
    },
    warnings: (): Recorded[] => logs.filter((l) => l.level === 'warn'),
    installSession(): void {
      // biome-ignore lint/suspicious/noExplicitAny: stub session
      ctx.skybridgeSession = { serverUrl: 'http://x', workspaceId: 'w' } as any;
    },
    dropSession(): void {
      ctx.skybridgeSession = null;
    },
  };
}

describe('startSessionWatchdog', () => {
  it('does not run on a local daemon', () => {
    const h = harness('local');
    assert.equal(h.handle, null);
  });

  it('stays quiet during the grace period, then reports once', () => {
    const h = harness();
    h.advance(5);
    assert.equal(h.warnings().length, 0, 'still inside the 10 minute grace period');

    h.advance(6); // 11 minutes total
    assert.equal(h.warnings().length, 1);
    const w = h.warnings()[0]!;
    assert.equal(w.obj.kind, 'session-watchdog');
    assert.equal(w.obj.reason, 'no_session');
    assert.equal(w.obj.minutes, 11);
  });

  it('repeats hourly, not every poll', () => {
    const h = harness();
    h.advance(11);
    assert.equal(h.warnings().length, 1);
    h.advance(20);
    h.advance(20);
    assert.equal(h.warnings().length, 1, 'still inside the hour');
    h.advance(25); // 76 minutes total, > 1h since the first report
    assert.equal(h.warnings().length, 2);
  });

  it('clears when a session arrives and logs the recovery', () => {
    const h = harness();
    h.advance(11);
    assert.equal(h.warnings().length, 1);

    h.installSession();
    h.advance(1);
    assert.equal(h.warnings().length, 1, 'no further complaints');
    assert.ok(
      h.logs.some((l) => l.level === 'info' && l.msg.includes('sync resumed')),
      'recovery is logged',
    );

    // A second outage gets its own full grace period.
    h.dropSession();
    h.advance(1);
    h.advance(5);
    assert.equal(h.warnings().length, 1, 'new gap re-arms the 10 minute clock');
    h.advance(6);
    assert.equal(h.warnings().length, 2);
  });

  // The reason the health check is `syncTriggerReady` and not "do we hold
  // credentials": after a 401 the credentials are still there.
  it('reports when credentials exist but the session was rejected', () => {
    const h = harness();
    // biome-ignore lint/suspicious/noExplicitAny: stub credential store
    (h.ctx as any).credentialStore = { get: () => ({ token: 't' }) };
    h.ctx.skybridgeSession = null;

    h.advance(11);
    assert.equal(h.warnings().length, 1, 'credentials must not count as healthy');
  });

  // The reason it is not part of stopBackgroundHandles.
  it('survives teardownCloudSession and keeps reporting', () => {
    const h = harness();
    h.installSession();
    h.advance(1);

    teardownCloudSession(h.ctx);
    assert.equal(h.ctx.skybridgeSession, null, 'teardown dropped the session');

    h.advance(1);
    h.advance(11);
    assert.ok(h.warnings().length >= 1, 'watchdog still alive after a full teardown');
  });

  it('stop() cancels the timer and silences further polls', () => {
    const h = harness();
    h.handle?.stop();
    assert.equal(h.clearedCount(), 1);
    h.advance(30);
    assert.equal(h.warnings().length, 0);
    h.handle?.stop();
    assert.equal(h.clearedCount(), 1, 'stop is idempotent');
  });
});
