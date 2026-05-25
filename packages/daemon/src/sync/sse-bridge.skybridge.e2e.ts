import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Logger, createDatabase, ensureDeviceId } from '@owl/core';
import type { AppContext } from '../context.js';
import { EventsBus } from '../events/bus.js';
import { createSseBridge } from './sse-bridge.js';

/**
 * P5-c Step 8 — D11. End-to-end integration with the real
 * `@orpheus-aviary/skybridge-client@0.1.1` (installed by `just skybridge-install`):
 * a server-side graceful shutdown surfaces as `{ done: true }` on the
 * SSE reader, which the Step 7 fix in `packages/client/src/sse.ts:
 * pumpStream` now reports as `onError(NetworkError('SSE stream ended'))`.
 * The bridge picks that up via the standard onError path and schedules
 * a 2s reconnect.
 *
 * Prior to G2 the same close path returned silently, leaving the bridge
 * idle with no pending reconnect — the regression D11 guards against.
 *
 * Gated on filename `*.e2e.ts` (matches `test:e2e` glob in
 * packages/daemon/package.json) so this file is only picked up by
 * `just test-skybridge-e2e`. That recipe sets `SKYBRIDGE_E2E=1` and runs
 * AFTER `just skybridge-install` has put `@orpheus-aviary/skybridge-client` on disk;
 * the gate below is belt-and-suspenders.
 */

const gate = process.env.SKYBRIDGE_E2E === '1';

interface FakeScheduleEntry {
  cb: () => void;
  ms: number;
}

class FakeScheduler {
  pending: FakeScheduleEntry[] = [];
  schedule = (cb: () => void, ms: number): { cancel: () => void } => {
    const entry = { cb, ms };
    this.pending.push(entry);
    return {
      cancel: () => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
      },
    };
  };
}

function silentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

function makeCtx(): AppContext {
  const { db, sqlite } = createDatabase({ dbPath: ':memory:' });
  ensureDeviceId(db);
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  return { db, sqlite, eventsBus: new EventsBus() } as any;
}

describe(
  'createSseBridge — G2 integration with real @orpheus-aviary/skybridge-client (P5-c Step 8)',
  { skip: !gate },
  () => {
    it('done:true from a streaming response triggers onError → reconnect at 2s (D11)', async () => {
      // String-variable specifier so tsc on a clean checkout (no skybridge
      // installed via `just skybridge-install`) doesn't try to resolve the
      // module. Same pattern as packages/daemon/src/sync/session.ts:122.
      const spec: string = '@orpheus-aviary/skybridge-client';
      // biome-ignore lint/suspicious/noExplicitAny: gated import, runtime-only
      const mod = (await import(spec)) as any;
      const { createSkybridgeClient } = mod;

      // Mock fetch returns a 200 stream that closes immediately — no
      // events, no error, just `{ done: true }` on the very first read.
      // Mirrors a server SIGTERM graceful shutdown.
      const fetchImpl = (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
        // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      }) as any;

      const realClient = createSkybridgeClient({
        authContext: {
          serverUrl: 'https://mock.example',
          token: 't',
          getToken: () => 't',
          // biome-ignore lint/suspicious/noExplicitAny: minimal auth ctx stub
        } as any,
        deviceId: 'd-1',
        fetchImpl,
      });

      const sched = new FakeScheduler();
      const bridge = createSseBridge({
        // biome-ignore lint/suspicious/noExplicitAny: real client passes through
        realClient: realClient as any,
        workspaceId: 'ws-1',
        ctx: makeCtx(),
        logger: silentLogger(),
        schedule: sched.schedule,
        jitter: (b) => b,
      });

      bridge.start();
      // The client runs the SSE pump on a microtask; give it a real tick
      // for fetch → open → done:true → onError → bridge.schedule.
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(sched.pending.length, 1, 'reconnect scheduled after done:true');
      assert.equal(sched.pending[0]?.ms, 2_000, 'first reconnect at 2s backoff step');
      bridge.stop();
    });
  },
);
