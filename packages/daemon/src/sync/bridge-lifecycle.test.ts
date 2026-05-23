import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Logger, SkybridgeConfig } from '@owl/core';
import { SkybridgeNotConfiguredError } from '@owl/core';
import type { AppContext } from '../context.js';
import { startSseBridgeIfBootstrapped } from './bridge-lifecycle.js';
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
}

function makeFakeBridge(): FakeBridge {
  const b = {
    startCalls: 0,
    stopCalls: 0,
    start() {
      this.startCalls += 1;
    },
    stop() {
      this.stopCalls += 1;
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
});
