import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Logger, SkybridgeConfig } from '@owl/core';
import { SkybridgeNotConfiguredError } from '@owl/core';
import type { AppContext } from '../context.js';
import {
  ensureBackgroundHandles,
  startSseBridgeIfBootstrapped,
  stopBackgroundHandles,
} from './bridge-lifecycle.js';
import type { SkybridgeSession } from './session.js';
import type { SseBridge } from './sse-bridge.js';

// ─── Test doubles ────────────────────────────────────────────────────

function silentLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      lines.push(`${level} ${msg ?? ''} ${JSON.stringify(obj)}`);
    };
  return {
    lines,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
  } as Logger & { lines: string[] };
}

function fullyBootstrappedConfig(): SkybridgeConfig {
  return {
    server: { url: 'http://localhost:48080' },
    auth: { user_id: 'u1', token: 't1', email: 'j@test' },
    device: { id: 'dev-1', name: 'mac', app_version: 'owl 0.5.0-dev', client_version: '0.1.0' },
    workspace: { id: 'ws-1', slug: 'owl/default' },
  };
}

function fakeSession(): SkybridgeSession {
  return {
    realClient: {} as never,
    module: {} as never,
    config: fullyBootstrappedConfig(),
    workspaceId: 'ws-1',
    deviceId: 'dev-1',
    serverUrl: 'http://localhost:48080',
  };
}

interface FakeBridge extends SseBridge {
  startCalls: number;
  stopCalls: number;
  triggerReconnectCalls: number;
}

function makeFakeBridge(): FakeBridge {
  const b = {
    startCalls: 0,
    stopCalls: 0,
    triggerReconnectCalls: 0,
    start() {
      this.startCalls += 1;
    },
    stop() {
      this.stopCalls += 1;
    },
    triggerReconnect() {
      this.triggerReconnectCalls += 1;
    },
  };
  return b;
}

const fakeCtx = {} as AppContext;

// ─── Tests ───────────────────────────────────────────────────────────

describe('startSseBridgeIfBootstrapped', () => {
  it('starts the bridge when config is fully bootstrapped', async () => {
    const bridge = makeFakeBridge();
    const logger = silentLogger();

    const handle = await startSseBridgeIfBootstrapped(fakeCtx, logger, {
      readSkybridgeConfig: () => fullyBootstrappedConfig(),
      ensureSkybridgeSession: async () => fakeSession(),
      createSseBridge: () => bridge,
    });

    assert.ok(handle, 'expected a handle');
    assert.equal(bridge.startCalls, 1);
    assert.equal(bridge.stopCalls, 0);
    assert.ok(logger.lines.some((l) => l.includes('sse-bridge started')));
  });

  it('returns null when skybridge is not configured (file missing)', async () => {
    const bridge = makeFakeBridge();
    const logger = silentLogger();

    const handle = await startSseBridgeIfBootstrapped(fakeCtx, logger, {
      readSkybridgeConfig: () => {
        throw new SkybridgeNotConfiguredError('/test/skybridge_config.toml');
      },
      ensureSkybridgeSession: async () => {
        throw new Error('should not be called');
      },
      createSseBridge: () => {
        throw new Error('should not be called');
      },
    });

    assert.equal(handle, null);
    assert.equal(bridge.startCalls, 0);
    assert.ok(
      logger.lines.some((l) => l.startsWith('info') && l.includes('skybridge not configured')),
    );
  });

  it('returns null when config has [server] but no [auth] (login not done)', async () => {
    const bridge = makeFakeBridge();
    const logger = silentLogger();

    const handle = await startSseBridgeIfBootstrapped(fakeCtx, logger, {
      readSkybridgeConfig: () => ({
        server: { url: 'http://localhost:48080' },
        // no auth / device / workspace
      }),
      ensureSkybridgeSession: async () => {
        throw new Error('should not be called');
      },
      createSseBridge: () => bridge,
    });

    assert.equal(handle, null);
    assert.equal(bridge.startCalls, 0);
    assert.ok(
      logger.lines.some((l) => l.startsWith('info') && l.includes('skybridge config incomplete')),
    );
  });

  it('returns null when [auth] is present but [device] is missing (sync run not done)', async () => {
    // This is the half-bootstrapped case: user did `owl sync login` (writes
    // [auth]) but hasn't run a manual sync yet (lazy registerDevice +
    // ensureWorkspace haven't fired). We deliberately do NOT call
    // ensureSession here because that would do network registration at boot.
    const bridge = makeFakeBridge();
    const logger = silentLogger();
    let sessionCalls = 0;

    const handle = await startSseBridgeIfBootstrapped(fakeCtx, logger, {
      readSkybridgeConfig: () => ({
        server: { url: 'http://localhost:48080' },
        auth: { user_id: 'u1', token: 't1', email: 'j@test' },
        // device + workspace still missing
      }),
      ensureSkybridgeSession: async () => {
        sessionCalls += 1;
        throw new Error('should not be called');
      },
      createSseBridge: () => bridge,
    });

    assert.equal(handle, null);
    assert.equal(sessionCalls, 0, 'ensureSession must not run network calls at boot');
    assert.equal(bridge.startCalls, 0);
  });

  it('returns null and logs warn when ensureSkybridgeSession throws', async () => {
    const bridge = makeFakeBridge();
    const logger = silentLogger();

    const handle = await startSseBridgeIfBootstrapped(fakeCtx, logger, {
      readSkybridgeConfig: () => fullyBootstrappedConfig(),
      ensureSkybridgeSession: async () => {
        throw new Error('module not found');
      },
      createSseBridge: () => bridge,
    });

    assert.equal(handle, null);
    assert.equal(bridge.startCalls, 0);
    assert.ok(
      logger.lines.some(
        (l) => l.startsWith('warn') && l.includes('skybridge session bootstrap failed'),
      ),
    );
  });

  it('handle.stop() forwards to bridge.stop()', async () => {
    const bridge = makeFakeBridge();
    const logger = silentLogger();

    const handle = await startSseBridgeIfBootstrapped(fakeCtx, logger, {
      readSkybridgeConfig: () => fullyBootstrappedConfig(),
      ensureSkybridgeSession: async () => fakeSession(),
      createSseBridge: () => bridge,
    });

    assert.ok(handle);
    handle.stop();
    assert.equal(bridge.stopCalls, 1);

    // Idempotent for the caller: a second stop() can be called safely
    // (forwards to bridge.stop() which is itself idempotent — sse-bridge
    // already guards via the `stopped` flag).
    handle.stop();
    assert.equal(bridge.stopCalls, 2);
  });

  it('returns null and logs warn when bridge.start() itself throws', async () => {
    const logger = silentLogger();
    const throwingBridge: SseBridge = {
      start() {
        throw new Error('subscribe blew up before bridge could install its own catch');
      },
      stop() {
        // no-op
      },
      triggerReconnect() {
        // no-op; throwing bridge never reaches the backoff state
      },
    };

    const handle = await startSseBridgeIfBootstrapped(fakeCtx, logger, {
      readSkybridgeConfig: () => fullyBootstrappedConfig(),
      ensureSkybridgeSession: async () => fakeSession(),
      createSseBridge: () => throwingBridge,
    });

    assert.equal(handle, null);
    assert.ok(
      logger.lines.some((l) => l.startsWith('warn') && l.includes('sse-bridge start threw')),
    );
  });

  // P5-c Step 10: probe lifecycle composition.
  it('composes health-probe with the bridge — onErrorHook→probe.start, onOpenHook→probe.stop', async () => {
    const bridge = makeFakeBridge();
    const logger = silentLogger();
    const probeCalls: string[] = [];
    let capturedHooks: { onErrorHook?: () => void; onOpenHook?: () => void } = {};

    const handle = await startSseBridgeIfBootstrapped(fakeCtx, logger, {
      readSkybridgeConfig: () => fullyBootstrappedConfig(),
      ensureSkybridgeSession: async () => fakeSession(),
      createSseBridge: (opts) => {
        capturedHooks = { onErrorHook: opts.onErrorHook, onOpenHook: opts.onOpenHook };
        return bridge;
      },
      createHealthProbe: () => ({
        start: () => probeCalls.push('start'),
        stop: () => probeCalls.push('stop'),
      }),
    });
    assert.ok(handle);

    // Trigger the hooks the bridge would have called from onError / onOpen.
    capturedHooks.onErrorHook?.();
    capturedHooks.onErrorHook?.(); // start() idempotent in real probe; multiple calls allowed
    capturedHooks.onOpenHook?.();
    assert.deepEqual(probeCalls, ['start', 'start', 'stop']);

    handle.stop();
    // handle.stop should also stop the probe (belt + suspenders for cli.ts
    // shutdown after a crashed session leaves the probe alive).
    assert.deepEqual(probeCalls.at(-1), 'stop');
  });

  it('probe onRecover → bridge.triggerReconnect (full feedback loop)', async () => {
    const bridge = makeFakeBridge();
    const logger = silentLogger();
    const captured: { onRecover: (() => void) | null } = { onRecover: null };

    const handle = await startSseBridgeIfBootstrapped(fakeCtx, logger, {
      readSkybridgeConfig: () => fullyBootstrappedConfig(),
      ensureSkybridgeSession: async () => fakeSession(),
      createSseBridge: () => bridge,
      createHealthProbe: (opts) => {
        captured.onRecover = opts.onRecover;
        return { start: () => {}, stop: () => {} };
      },
    });
    assert.ok(handle);
    assert.ok(captured.onRecover, 'probe captured onRecover callback from lifecycle');

    captured.onRecover?.();
    assert.equal(bridge.triggerReconnectCalls, 1, 'probe success forces bridge reconnect');
  });
});

// P5-c §2.2-bis mid-session lifecycle.
describe('ensureBackgroundHandles', () => {
  function emptyCtx(): AppContext {
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    return { sseBridge: null, syncScheduler: null } as any;
  }

  it('starts both bridge + scheduler from a clean ctx', async () => {
    const ctx = emptyCtx();
    const bridge = makeFakeBridge();
    let schedulerStartCalls = 0;
    let schedulerStopCalls = 0;

    await ensureBackgroundHandles(ctx, silentLogger(), {
      readSkybridgeConfig: () => fullyBootstrappedConfig(),
      ensureSkybridgeSession: async () => fakeSession(),
      createSseBridge: () => bridge,
      createHealthProbe: () => ({ start: () => {}, stop: () => {} }),
      createSyncScheduler: () => {
        schedulerStartCalls += 1;
        return {
          stop: () => {
            schedulerStopCalls += 1;
          },
        };
      },
    });

    assert.ok(ctx.sseBridge, 'bridge handle attached to ctx');
    assert.ok(ctx.syncScheduler, 'scheduler handle attached to ctx');
    assert.equal(schedulerStartCalls, 1);
    // sanity: stop handles tear both down
    stopBackgroundHandles(ctx);
    assert.equal(schedulerStopCalls, 1);
    assert.equal(bridge.stopCalls, 1);
    assert.equal(ctx.sseBridge, null);
    assert.equal(ctx.syncScheduler, null);
  });

  it('idempotent — second call does NOT start a second bridge or scheduler', async () => {
    const ctx = emptyCtx();
    let bridgeFactoryCalls = 0;
    let schedulerFactoryCalls = 0;
    const deps = {
      readSkybridgeConfig: () => fullyBootstrappedConfig(),
      ensureSkybridgeSession: async () => fakeSession(),
      createSseBridge: () => {
        bridgeFactoryCalls += 1;
        return makeFakeBridge();
      },
      createHealthProbe: () => ({ start: () => {}, stop: () => {} }),
      createSyncScheduler: () => {
        schedulerFactoryCalls += 1;
        return { stop: () => {} };
      },
    };

    await ensureBackgroundHandles(ctx, silentLogger(), deps);
    await ensureBackgroundHandles(ctx, silentLogger(), deps);
    await ensureBackgroundHandles(ctx, silentLogger(), deps);

    assert.equal(bridgeFactoryCalls, 1, 'bridge only constructed once');
    assert.equal(schedulerFactoryCalls, 1, 'scheduler only constructed once');
  });

  it('mid-session start: boot left ctx.sseBridge=null (incomplete toml), later call attaches bridge', async () => {
    const ctx = emptyCtx();
    const logger = silentLogger();
    let configResolver: () => SkybridgeConfig = () => {
      // simulate incomplete toml on boot
      throw new SkybridgeNotConfiguredError('/tmp/sb.toml');
    };
    const bridge = makeFakeBridge();
    const deps = {
      readSkybridgeConfig: () => configResolver(),
      ensureSkybridgeSession: async () => fakeSession(),
      createSseBridge: () => bridge,
      createHealthProbe: () => ({ start: () => {}, stop: () => {} }),
      createSyncScheduler: () => ({ stop: () => {} }),
    };

    // Boot path — toml incomplete; bridge stays null but scheduler still wired.
    await ensureBackgroundHandles(ctx, logger, deps);
    assert.equal(ctx.sseBridge, null, 'bridge skipped on incomplete toml');
    assert.ok(ctx.syncScheduler, 'scheduler still attached');
    assert.equal(bridge.startCalls, 0);

    // Simulate user running `owl sync login` + `owl sync run`: toml is now fully
    // bootstrapped. doRunManualSync calls ensureBackgroundHandles again.
    configResolver = () => fullyBootstrappedConfig();
    await ensureBackgroundHandles(ctx, logger, deps);

    assert.ok(ctx.sseBridge, 'bridge attached on mid-session retry');
    assert.equal(bridge.startCalls, 1);
  });

  it('stopBackgroundHandles tolerates a ctx whose fields are already null', () => {
    const ctx = emptyCtx();
    assert.doesNotThrow(() => stopBackgroundHandles(ctx));
  });
});
