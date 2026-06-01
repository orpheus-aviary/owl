/**
 * W3 (Phase 16c) — three-tuple LWW + offset behaviour in `runSync`.
 *
 * Complements engine.test.ts (which covers the pre-W3 ms-only paths) with the
 * cases W3 newly resolves: same-device same-ms ordering, cross-device same-ms
 * tiebreak, pre-W3 (no counter) compatibility, and serverTime → offset.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import {
  type PullResultLike,
  type PushResultLike,
  type ServerChangeLike,
  runSync,
} from './engine.js';
import { readServerTimeOffset } from './hlc.js';

const WORKSPACE_ID = 'ws-1';
const SERVER_URL = 'http://127.0.0.1:18443';

class FakeClient {
  pullQueue: PullResultLike[] = [];
  pushResult: PushResultLike = { accepted: [], duplicates: [] };
  async pullChanges(): Promise<PullResultLike> {
    return this.pullQueue.shift() ?? { changes: [], hasMore: false };
  }
  async pushChanges(): Promise<PushResultLike> {
    return this.pushResult;
  }
}

function seedNote(
  sqlite: Database.Database,
  id: string,
  fields: { content?: string; updatedAt?: number; counter?: number; deviceId?: string },
): void {
  sqlite
    .prepare(
      `INSERT INTO notes
         (id, folder_id, trash_level, created_at, updated_at, content, content_hash,
          device_id, local_device_uuid, lww_counter)
       VALUES (?, NULL, 0, ?, ?, ?, NULL, ?, 'dev-local-uuid', ?)`,
    )
    .run(
      id,
      fields.updatedAt ?? 1_000,
      fields.updatedAt ?? 1_000,
      fields.content ?? 'seed',
      fields.deviceId ?? 'dev-local',
      fields.counter ?? 0,
    );
}

function noteChange(input: {
  serverSeq: number;
  entityId: string;
  deviceId: string;
  content: string;
  updatedAtMs: number;
  lwwCounter?: number;
}): ServerChangeLike {
  const payload: Record<string, unknown> = {
    updated_at_ms: input.updatedAtMs,
    content: input.content,
  };
  if (input.lwwCounter !== undefined) payload.lww_counter = input.lwwCounter;
  return {
    serverSeq: input.serverSeq,
    clientChangeId: `cid-${input.serverSeq}`,
    deviceId: input.deviceId,
    entityType: 'note',
    entityId: input.entityId,
    op: 'update',
    payload,
  };
}

function readContent(sqlite: Database.Database, id: string): string | undefined {
  const row = sqlite.prepare('SELECT content FROM notes WHERE id = ?').get(id) as
    | { content: string }
    | undefined;
  return row?.content;
}

let sqlite: Database.Database;
// biome-ignore lint/suspicious/noExplicitAny: drizzle wrapper type irrelevant to tests
let db: any;

before(() => {
  const result = createDatabase({ dbPath: ':memory:' });
  sqlite = result.sqlite;
  db = result.db;
});

after(() => {
  sqlite.close();
});

beforeEach(() => {
  sqlite.prepare('DELETE FROM notes').run();
  sqlite.prepare('DELETE FROM sync_changes').run();
  sqlite.prepare('DELETE FROM sync_cursor').run();
  sqlite.prepare('DELETE FROM local_metadata').run();
  sqlite
    .prepare("INSERT INTO local_metadata (key, value) VALUES ('device_uuid', 'dev-local-uuid')")
    .run();
});

function run(client: FakeClient) {
  return runSync({
    db,
    sqlite,
    client,
    workspaceId: WORKSPACE_ID,
    serverUrl: SERVER_URL,
    nowMs: () => 40_000,
  });
}

describe('W3 LWW — same-device same-ms ordering', () => {
  it('two same-ms updates from one device both apply (counter breaks the tie)', async () => {
    // Regression: pre-W3 the second op tied on ms and was dropped by `>=`.
    seedNote(sqlite, 'n', { content: 'v0', updatedAt: 1_000, deviceId: 'dev-A' });
    const client = new FakeClient();
    client.pullQueue.push({
      changes: [
        noteChange({
          serverSeq: 1,
          entityId: 'n',
          deviceId: 'dev-A',
          content: 'v1',
          updatedAtMs: 2_000,
          lwwCounter: 0,
        }),
        noteChange({
          serverSeq: 2,
          entityId: 'n',
          deviceId: 'dev-A',
          content: 'v2',
          updatedAtMs: 2_000,
          lwwCounter: 1,
        }),
      ],
      hasMore: false,
    });
    const result = await run(client);
    assert.equal(result.appliedTotal, 2);
    assert.equal(readContent(sqlite, 'n'), 'v2');
  });
});

describe('W3 LWW — cross-device same (ms, counter) tiebreak by deviceId', () => {
  it('remote wins when its deviceId sorts after local', async () => {
    seedNote(sqlite, 'n', { content: 'local', updatedAt: 5_000, counter: 0, deviceId: 'dev-A' });
    const client = new FakeClient();
    client.pullQueue.push({
      changes: [
        noteChange({
          serverSeq: 1,
          entityId: 'n',
          deviceId: 'dev-Z',
          content: 'remote',
          updatedAtMs: 5_000,
          lwwCounter: 0,
        }),
      ],
      hasMore: false,
    });
    const result = await run(client);
    assert.equal(result.appliedTotal, 1);
    assert.equal(readContent(sqlite, 'n'), 'remote');
  });

  it('remote loses when its deviceId sorts before local — deterministic, not "latest"', async () => {
    seedNote(sqlite, 'n', { content: 'local', updatedAt: 5_000, counter: 0, deviceId: 'dev-M' });
    const client = new FakeClient();
    client.pullQueue.push({
      changes: [
        noteChange({
          serverSeq: 1,
          entityId: 'n',
          deviceId: 'dev-A',
          content: 'remote',
          updatedAtMs: 5_000,
          lwwCounter: 0,
        }),
      ],
      hasMore: false,
    });
    const result = await run(client);
    assert.equal(result.appliedTotal, 0);
    assert.equal(result.skippedTotal, 1);
    assert.equal(readContent(sqlite, 'n'), 'local');
  });
});

describe('W3 LWW — pre-W3 payloads (no lww_counter) stay compatible', () => {
  it('remote update without counter still applies on newer ms', async () => {
    seedNote(sqlite, 'n', { content: 'old', updatedAt: 1_000, deviceId: 'dev-A' });
    const client = new FakeClient();
    client.pullQueue.push({
      changes: [
        noteChange({
          serverSeq: 1,
          entityId: 'n',
          deviceId: 'dev-A',
          content: 'new',
          updatedAtMs: 2_000,
        }),
      ],
      hasMore: false,
    });
    const result = await run(client);
    assert.equal(result.appliedTotal, 1);
    assert.equal(readContent(sqlite, 'n'), 'new');
  });

  it('remote update without counter is skipped on older ms', async () => {
    seedNote(sqlite, 'n', { content: 'fresh', updatedAt: 5_000, deviceId: 'dev-A' });
    const client = new FakeClient();
    client.pullQueue.push({
      changes: [
        noteChange({
          serverSeq: 1,
          entityId: 'n',
          deviceId: 'dev-A',
          content: 'stale',
          updatedAtMs: 2_000,
        }),
      ],
      hasMore: false,
    });
    const result = await run(client);
    assert.equal(result.skippedTotal, 1);
    assert.equal(readContent(sqlite, 'n'), 'fresh');
  });
});

describe('W3 — serverTime lands the offset', () => {
  it('empty pull carrying serverTime still refreshes server_time_offset_ms', async () => {
    const client = new FakeClient();
    client.pullQueue.push({ changes: [], hasMore: false, serverTime: 100_000 });
    await run(client); // nowMs = 40_000
    assert.equal(readServerTimeOffset(sqlite), 60_000);
  });

  it('push response serverTime refreshes the offset', async () => {
    // outbox has one pending row → push runs; pull is empty without serverTime.
    sqlite
      .prepare(
        `INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at, client_change_id)
         VALUES ('dev-local-uuid', 'note', 'n', 'update', '{"updated_at_ms":1,"lww_counter":0}', 1, 'cid-x')`,
      )
      .run();
    const client = new FakeClient();
    client.pushResult = {
      accepted: [{ clientChangeId: 'cid-x', serverSeq: 1 }],
      duplicates: [],
      serverTime: 200_000,
    };
    await run(client); // nowMs = 40_000
    assert.equal(readServerTimeOffset(sqlite), 160_000);
  });
});
