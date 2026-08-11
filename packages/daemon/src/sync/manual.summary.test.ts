/**
 * 0.6.3 V2 — the round-summary log.
 *
 * One `sync round done` line per successful coalescer round, carrying every
 * number `runSync` returns. This is the line whose absence let the V1 cursor
 * bug (`cursor_before: 0` on every single round) hide for three weeks behind
 * 20k per-change lines a day — so it gets a test that pins both halves:
 * the summary is at info, and the per-change lines are not.
 *
 * Driven through `runManualSync` (not the HTTP route) so the coalescer and
 * the trigger plumbing are exercised too. Background handles are pre-seeded
 * with stubs, which makes `ensureBackgroundHandles` a no-op — otherwise this
 * test would leave a 1s outbox-watcher interval running.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type Logger,
  type OwlConfig,
  createDatabase,
  emitSyncChange,
} from '@owl/core';
import type { AppContext } from '../context.js';
import { runManualSync } from './manual.js';
import { evictSyncStatusBroadcaster } from './status-broadcaster.js';

interface LogLine {
  obj: Record<string, unknown>;
  msg: string;
}

interface CapturingLogger extends Logger {
  info_: LogLine[];
  debug_: LogLine[];
}

function capturingLogger(): CapturingLogger {
  const info_: LogLine[] = [];
  const debug_: LogLine[] = [];
  const push = (sink: LogLine[]) => (a: unknown, b?: unknown) => {
    if (typeof a === 'object' && a !== null) {
      sink.push({ obj: a as Record<string, unknown>, msg: String(b ?? '') });
    } else {
      sink.push({ obj: {}, msg: String(a) });
    }
  };
  return {
    info_,
    debug_,
    info: push(info_),
    debug: push(debug_),
    warn: () => {},
    error: () => {},
  } as unknown as CapturingLogger;
}

const SERVER_URL = 'http://127.0.0.1:18443';
const WORKSPACE_ID = 'ws-1';

interface FakeChange {
  serverSeq: number;
  clientChangeId: string;
  deviceId: string;
  entityType: string;
  entityId: string;
  op: string;
  payload: unknown;
}

function noteCreate(serverSeq: number, id: string, updatedAtMs = 1_000): FakeChange {
  return {
    serverSeq,
    clientChangeId: `cid-remote-${serverSeq}`,
    deviceId: 'dev-remote',
    entityType: 'note',
    entityId: id,
    op: 'create',
    payload: {
      id,
      content: `remote ${id}`,
      folder_id: null,
      trash_level: 0,
      created_at_ms: 1_000,
      updated_at_ms: updatedAtMs,
      tags: [],
    },
  };
}

let ctx: AppContext;
let logger: CapturingLogger;
let pulls: FakeChange[];
let pushAccepted: { clientChangeId: string; serverSeq: number }[];

beforeEach(() => {
  const { db, sqlite } = createDatabase({ dbPath: ':memory:' });
  // createDatabase already seeds a random device_uuid; pin it for determinism.
  sqlite
    .prepare(
      `INSERT INTO local_metadata (key, value) VALUES ('device_uuid', 'dev-local')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run();
  logger = capturingLogger();
  pulls = [];
  pushAccepted = [];

  const config: OwlConfig = structuredClone(DEFAULT_CONFIG);
  const noopHandle = { stop: () => {} };

  ctx = {
    db,
    sqlite,
    config,
    logger,
    deviceId: 'dev-local',
    scheduler: { reload: () => {} },
    eventsBus: { emit: () => {} },
    // Pre-seeded so ensureBackgroundHandles short-circuits (see file header).
    sseBridge: noopHandle,
    syncScheduler: noopHandle,
    outboxWatcher: noopHandle,
    skybridgeSession: {
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      deviceId: 'dev-local',
      realClient: {
        pullChanges: async () => ({
          changes: pulls,
          hasMore: false,
          latestSeq: pulls.at(-1)?.serverSeq ?? 0,
          serverTime: 1_000,
        }),
        pushChanges: async () => ({
          accepted: pushAccepted,
          duplicates: [],
          serverTime: 1_000,
        }),
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for one code path
  } as any;
  evictSyncStatusBroadcaster(ctx);
});

function summaries(): LogLine[] {
  return logger.info_.filter((l) => l.msg === 'sync round done');
}

describe('sync round summary (0.6.3 V2)', () => {
  it('logs exactly one summary per successful round, with every number', async () => {
    pulls = [noteCreate(7, 'n-remote')];

    await runManualSync(ctx, 'sse');

    assert.equal(summaries().length, 1, 'one summary per round');
    const { obj } = summaries()[0]!;
    assert.deepEqual(obj.triggers, ['sse']);
    assert.equal(obj.kind, 'sync');
    // Every field runSync returns must be present — the whole point is that
    // a reader can diagnose a round without correlating other lines.
    for (const key of [
      'cursor_before',
      'cursor_after',
      'pulled',
      'applied',
      'skipped',
      'pushed',
      'duplicates',
      'server_seq_high',
      'conflicts',
    ]) {
      assert.equal(typeof obj[key], 'number', `${key} present and numeric`);
    }
    assert.equal(obj.cursor_before, 0);
    assert.equal(obj.cursor_after, 7);
    assert.equal(obj.pulled, 1);
    assert.equal(obj.applied, 1);
  });

  // The V1 regression, stated in log terms: a round that follows a push must
  // not restart from 0. Cheap to assert here and reads as the symptom the
  // soak actually showed.
  it('a second round resumes from the first round cursor', async () => {
    pulls = [noteCreate(7, 'n-remote')];
    await runManualSync(ctx, 'manual');

    const cid = emitSyncChange(ctx.sqlite, {
      entityType: 'note',
      entityId: 'n-local',
      op: 'create',
      payload: { content: 'local', updated_at_ms: 2_000 },
      nowMs: 2_000,
    });
    pulls = [];
    pushAccepted = [{ clientChangeId: cid, serverSeq: 42 }];
    await runManualSync(ctx, 'outbox');

    const [first, second] = summaries();
    assert.equal(first?.obj.cursor_after, 7);
    assert.equal(second?.obj.cursor_before, 7, 'push round did not reset the pull cursor');
    assert.equal(second?.obj.pushed, 1);
    assert.deepEqual(second?.obj.triggers, ['outbox']);
  });

  // A successful apply logs nothing; only skips do. Use an LWW skip — the
  // exact line that made up 20710 of one soak day's log entries.
  it('per-change lines go to debug, never info', async () => {
    pulls = [
      noteCreate(7, 'n-remote', 5_000),
      {
        ...noteCreate(8, 'n-remote', 1_000),
        op: 'update',
        clientChangeId: 'cid-remote-8',
      },
    ];

    await runManualSync(ctx, 'scheduler');

    const summary = summaries()[0]!;
    assert.equal(summary.obj.applied, 1);
    assert.equal(summary.obj.skipped, 1, 'the stale update lost LWW');

    const infoPerChange = logger.info_.filter((l) => l.msg.startsWith('[sync] '));
    assert.equal(infoPerChange.length, 0, 'no per-change line at info');
    const debugSkip = logger.debug_.filter((l) => l.msg.includes('LWW skip'));
    assert.equal(debugSkip.length, 1, 'per-change line still emitted, at debug');
  });

  it('an empty round still produces a summary', async () => {
    await runManualSync(ctx, 'scheduler');

    assert.equal(summaries().length, 1);
    const { obj } = summaries()[0]!;
    assert.equal(obj.pulled, 0);
    assert.equal(obj.pushed, 0);
    assert.deepEqual(obj.triggers, ['scheduler']);
  });
});
