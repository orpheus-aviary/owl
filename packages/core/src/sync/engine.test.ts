/**
 * Unit suite for `runSync` (P5-a Step 5).
 *
 * Hits sqlite via `createDatabase({ dbPath: ':memory:' })`; the client is
 * a hand-rolled `FakeSkybridgeClient` that lets each test queue exact
 * pull / push responses. No network, no skybridge package import.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import { emitSyncChange } from './changes.js';
import {
  type LocalChangeLike,
  type PullResultLike,
  type PushResultLike,
  type RunSyncLogger,
  type ServerChangeLike,
  SkybridgeProtocolError,
  runSync,
} from './engine.js';

// ─── helpers ─────────────────────────────────────────────────────────

const WORKSPACE_ID = 'ws-1';
const SERVER_URL = 'http://127.0.0.1:18443';
const REMOTE_DEVICE = 'dev-remote';

interface SyncChangeRow {
  local_seq: number;
  device_id: string;
  entity_type: string;
  entity_id: string;
  op: string;
  payload: string;
  created_at: number;
  client_change_id: string;
  server_seq: number | null;
  synced_at: number | null;
}

interface SyncCursorRow {
  endpoint: string;
  pulled_seq: number;
  pushed_seq: number;
  updated_at: number;
}

interface NoteRow {
  id: string;
  folder_id: string | null;
  trash_level: number;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
  auto_delete_at: number | null;
  content: string;
  content_hash: string | null;
  device_id: string | null;
}

function clearAllTables(sqlite: Database.Database): void {
  sqlite.prepare('DELETE FROM notes').run();
  sqlite.prepare('DELETE FROM sync_changes').run();
  sqlite.prepare('DELETE FROM sync_cursor').run();
  sqlite.prepare('DELETE FROM local_metadata').run();
}

function readChanges(sqlite: Database.Database): SyncChangeRow[] {
  return sqlite.prepare('SELECT * FROM sync_changes ORDER BY local_seq').all() as SyncChangeRow[];
}

function readCursor(sqlite: Database.Database, endpoint: string): SyncCursorRow | undefined {
  return sqlite.prepare('SELECT * FROM sync_cursor WHERE endpoint = ?').get(endpoint) as
    | SyncCursorRow
    | undefined;
}

function readNote(sqlite: Database.Database, id: string): NoteRow | undefined {
  return sqlite.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
}

function seedNote(
  sqlite: Database.Database,
  id: string,
  fields: {
    content?: string;
    folderId?: string | null;
    trashLevel?: number;
    createdAt?: number;
    updatedAt?: number;
    deviceId?: string | null;
  } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO notes
         (id, folder_id, trash_level, created_at, updated_at, content, content_hash, device_id, local_device_uuid)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      fields.folderId ?? null,
      fields.trashLevel ?? 0,
      fields.createdAt ?? 1_000,
      fields.updatedAt ?? 1_000,
      fields.content ?? 'seed',
      fields.deviceId ?? 'dev-local',
      'dev-local',
    );
}

function makeNoteChange(input: {
  serverSeq: number;
  cid?: string;
  deviceId?: string;
  entityId: string;
  op: 'create' | 'update' | 'trash' | 'restore' | 'delete' | 'pin' | string;
  payload: Record<string, unknown>;
}): ServerChangeLike {
  return {
    serverSeq: input.serverSeq,
    clientChangeId: input.cid ?? `cid-${input.serverSeq}`,
    deviceId: input.deviceId ?? REMOTE_DEVICE,
    entityType: 'note',
    entityId: input.entityId,
    op: input.op,
    payload: input.payload,
  };
}

// ─── Fake client ─────────────────────────────────────────────────────

class FakeSkybridgeClient {
  pullQueue: (PullResultLike | Error)[] = [];
  pushQueue: (PushResultLike | Error)[] = [];
  pullCalls: { workspaceId: string; sinceServerSeq: number }[] = [];
  pushCalls: { workspaceId: string; changes: LocalChangeLike[] }[] = [];

  enqueuePull(result: PullResultLike | Error): void {
    this.pullQueue.push(result);
  }
  enqueuePush(result: PushResultLike | Error): void {
    this.pushQueue.push(result);
  }

  async pullChanges(workspaceId: string, sinceServerSeq: number): Promise<PullResultLike> {
    this.pullCalls.push({ workspaceId, sinceServerSeq });
    const next = this.pullQueue.shift();
    if (!next) return { changes: [], hasMore: false };
    if (next instanceof Error) throw next;
    return next;
  }

  async pushChanges(workspaceId: string, changes: LocalChangeLike[]): Promise<PushResultLike> {
    this.pushCalls.push({ workspaceId, changes });
    const next = this.pushQueue.shift();
    if (!next) return { accepted: [], duplicates: [] };
    if (next instanceof Error) throw next;
    return next;
  }
}

function fakeNow(): number {
  return 9_000_000;
}

function collectingLogger(): RunSyncLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    },
    warn: (...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    },
  };
}

// ─── shared DB lifecycle ─────────────────────────────────────────────

let sqlite: Database.Database;

before(() => {
  const result = createDatabase({ dbPath: ':memory:' });
  sqlite = result.sqlite;
});

beforeEach(() => {
  clearAllTables(sqlite);
  // emitSyncChange autobootstraps device_uuid; pre-set it for determinism
  sqlite
    .prepare("INSERT INTO local_metadata (key, value) VALUES ('device_uuid', 'dev-local')")
    .run();
});

after(() => {
  sqlite.close();
});

// ─── noop / cursor upsert ────────────────────────────────────────────

describe('runSync — empty', () => {
  it('empty outbox + empty pull → all zeros, no cursor row written', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({ changes: [], hasMore: false });

    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.deepEqual(result, {
      pulledTotal: 0,
      appliedTotal: 0,
      skippedTotal: 0,
      pushedTotal: 0,
      duplicatesTotal: 0,
      serverSeqHigh: 0,
      cursorBefore: 0,
      cursorAfter: 0,
    });
    // pull was attempted exactly once with cursor=0
    assert.equal(client.pullCalls.length, 1);
    assert.equal(client.pullCalls[0]?.sinceServerSeq, 0);
    // push call skipped because outbox empty
    assert.equal(client.pushCalls.length, 0);
    // No pull writes, no push writes, no cursor row
    assert.equal(readCursor(sqlite, SERVER_URL), undefined);
  });
});

describe('runSync — first run upsert', () => {
  it('first sync that pulls 1 note inserts new sync_cursor row', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 7,
          entityId: 'n-new',
          op: 'create',
          payload: {
            content: 'hi',
            folder_id: null,
            trash_level: 0,
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
            tags: [],
          },
        }),
      ],
      hasMore: false,
    });

    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.cursorBefore, 0);
    assert.equal(result.cursorAfter, 7);
    const row = readCursor(sqlite, SERVER_URL);
    assert.ok(row, 'cursor row inserted');
    assert.equal(row.pulled_seq, 7);
    assert.equal(row.pushed_seq, 0);
    assert.equal(row.updated_at, fakeNow());
  });
});

// ─── protocol guard ──────────────────────────────────────────────────

describe('runSync — protocol guard', () => {
  it('empty changes + hasMore=true → SkybridgeProtocolError, cursor unchanged', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({ changes: [], hasMore: true });

    await assert.rejects(
      runSync({
        sqlite,
        client,
        workspaceId: WORKSPACE_ID,
        serverUrl: SERVER_URL,
        nowMs: fakeNow,
      }),
      (err: unknown) => err instanceof SkybridgeProtocolError,
    );
    assert.equal(readCursor(sqlite, SERVER_URL), undefined);
  });
});

// ─── push path ───────────────────────────────────────────────────────

describe('runSync — push', () => {
  it('1 pending push → backfill server_seq + synced_at + pushed_seq cursor', async () => {
    const cid = emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: 'n-1',
      op: 'create',
      payload: { content: 'x', updated_at_ms: 1_000 },
      nowMs: 1_000,
    });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({ changes: [], hasMore: false });
    client.enqueuePush({
      accepted: [{ clientChangeId: cid, serverSeq: 42 }],
      duplicates: [],
    });

    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.pushedTotal, 1);
    assert.equal(result.duplicatesTotal, 0);
    assert.equal(result.serverSeqHigh, 42);
    const row = readChanges(sqlite)[0];
    assert.equal(row?.server_seq, 42);
    assert.equal(row?.synced_at, fakeNow());
    const cursor = readCursor(sqlite, SERVER_URL);
    assert.equal(cursor?.pushed_seq, 42);
    // Outbox payload shape forwarded as object (not string)
    const sent = client.pushCalls[0]?.changes[0];
    assert.equal(sent?.clientChangeId, cid);
    assert.equal(typeof sent?.payload, 'object');
    assert.equal((sent?.payload as { content: string }).content, 'x');
    assert.equal(sent?.attachmentRefs, null);
  });

  it('push network failure → outbox row stays pending, cursor not written', async () => {
    emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: 'n-1',
      op: 'create',
      payload: { content: 'x', updated_at_ms: 1_000 },
      nowMs: 1_000,
    });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({ changes: [], hasMore: false });
    client.enqueuePush(new Error('ECONNREFUSED'));

    await assert.rejects(
      runSync({
        sqlite,
        client,
        workspaceId: WORKSPACE_ID,
        serverUrl: SERVER_URL,
        nowMs: fakeNow,
      }),
      /ECONNREFUSED/,
    );
    const row = readChanges(sqlite)[0];
    assert.equal(row?.server_seq, null);
    assert.equal(row?.synced_at, null);
    assert.equal(readCursor(sqlite, SERVER_URL), undefined);
  });

  it('server returns duplicates → also backfills synced_at', async () => {
    const cid = emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: 'n-1',
      op: 'create',
      payload: { content: 'x', updated_at_ms: 1_000 },
      nowMs: 1_000,
    });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({ changes: [], hasMore: false });
    client.enqueuePush({
      accepted: [],
      duplicates: [{ clientChangeId: cid, serverSeq: 99 }],
    });

    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.pushedTotal, 0);
    assert.equal(result.duplicatesTotal, 1);
    assert.equal(result.serverSeqHigh, 99);
    const row = readChanges(sqlite)[0];
    assert.equal(row?.server_seq, 99);
    assert.equal(row?.synced_at, fakeNow());
  });
});

// ─── pull apply (create) ─────────────────────────────────────────────

describe('runSync — pull apply note create', () => {
  it('pulled note creates land in notes table with derived hash + remote device_id', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-a',
          op: 'create',
          payload: {
            content: 'alpha',
            folder_id: null,
            trash_level: 0,
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
            tags: [],
          },
        }),
        makeNoteChange({
          serverSeq: 2,
          entityId: 'n-b',
          op: 'create',
          payload: {
            content: 'beta',
            folder_id: null,
            trash_level: 0,
            created_at_ms: 2_000,
            updated_at_ms: 2_000,
            tags: [],
          },
        }),
      ],
      hasMore: false,
    });

    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.pulledTotal, 2);
    assert.equal(result.appliedTotal, 2);
    assert.equal(result.skippedTotal, 0);
    assert.equal(result.cursorAfter, 2);

    const a = readNote(sqlite, 'n-a');
    assert.equal(a?.content, 'alpha');
    assert.equal(a?.device_id, REMOTE_DEVICE);
    // content_hash is sha256(alpha)
    assert.equal(a?.content_hash?.length, 64);

    const b = readNote(sqlite, 'n-b');
    assert.equal(b?.content, 'beta');
  });

  it('tags field in create payload → skipped + log line', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-tag',
          op: 'create',
          payload: {
            content: 'with-tag',
            folder_id: null,
            trash_level: 0,
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
            tags: [{ tag_type: 'hashtag', tag_value: 'foo' }],
          },
        }),
      ],
      hasMore: false,
    });

    const logger = collectingLogger();
    await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
      logger,
    });
    const nt = sqlite
      .prepare('SELECT count(*) AS n FROM note_tags WHERE note_id = ?')
      .get('n-tag') as { n: number };
    assert.equal(nt.n, 0, 'tags table not touched in P5-a');
    assert.ok(
      logger.lines.some((l) => l.includes('skipped (P5-a)') && l.includes('n-tag')),
      `expected skipped(P5-a) log, got: ${logger.lines.join('\n')}`,
    );
  });
});

// ─── pull apply (update / trash / restore / delete + LWW) ────────────

describe('runSync — pull apply note update / LWW', () => {
  it('update applies when remote.updated_at_ms > local.updated_at, hash re-derived', async () => {
    seedNote(sqlite, 'n-u', { content: 'old', updatedAt: 1_000 });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-u',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'new' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 1);
    const row = readNote(sqlite, 'n-u');
    assert.equal(row?.content, 'new');
    assert.equal(row?.updated_at, 2_000);
    assert.equal(row?.device_id, REMOTE_DEVICE);
    assert.ok(row?.content_hash && row.content_hash.length === 64);
  });

  it('update skipped when remote.updated_at_ms < local.updated_at (LWW loser)', async () => {
    seedNote(sqlite, 'n-u', { content: 'fresh', updatedAt: 5_000 });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-u',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'stale' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 0);
    assert.equal(result.skippedTotal, 1);
    assert.equal(readNote(sqlite, 'n-u')?.content, 'fresh');
  });

  it('update skipped when remote.updated_at_ms == local.updated_at (tie → local wins)', async () => {
    seedNote(sqlite, 'n-u', { content: 'tie', updatedAt: 3_000 });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-u',
          op: 'update',
          payload: { updated_at_ms: 3_000, content: 'other' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 0);
    assert.equal(result.skippedTotal, 1);
    assert.equal(readNote(sqlite, 'n-u')?.content, 'tie');
  });

  it('update on missing local note → skipped (out-of-order), cursor still advances', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 4,
          entityId: 'n-missing',
          op: 'update',
          payload: { updated_at_ms: 5_000, content: 'x' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 0);
    assert.equal(result.skippedTotal, 1);
    assert.equal(result.cursorAfter, 4);
    assert.equal(readNote(sqlite, 'n-missing'), undefined);
  });

  it('trash applies LWW + writes trashed_at / auto_delete_at', async () => {
    seedNote(sqlite, 'n-t', { updatedAt: 1_000 });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-t',
          op: 'trash',
          payload: {
            updated_at_ms: 2_000,
            trash_level: 1,
            trashed_at_ms: 2_000,
            auto_delete_at_ms: null,
          },
        }),
      ],
      hasMore: false,
    });
    await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    const row = readNote(sqlite, 'n-t');
    assert.equal(row?.trash_level, 1);
    assert.equal(row?.trashed_at, 2_000);
    assert.equal(row?.auto_delete_at, null);
  });

  it('restore clears auto_delete_at and lifts trash_level back', async () => {
    seedNote(sqlite, 'n-r', { updatedAt: 1_000, trashLevel: 2 });
    sqlite
      .prepare('UPDATE notes SET trashed_at = 1500, auto_delete_at = 9999 WHERE id = ?')
      .run('n-r');
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-r',
          op: 'restore',
          payload: {
            updated_at_ms: 3_000,
            trash_level: 0,
            trashed_at_ms: null,
            auto_delete_at_ms: null,
          },
        }),
      ],
      hasMore: false,
    });
    await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    const row = readNote(sqlite, 'n-r');
    assert.equal(row?.trash_level, 0);
    assert.equal(row?.trashed_at, null);
    assert.equal(row?.auto_delete_at, null);
  });

  it('delete on local note older than remote → removed', async () => {
    seedNote(sqlite, 'n-d', { updatedAt: 1_000 });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-d',
          op: 'delete',
          payload: { updated_at_ms: 2_000 },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 1);
    assert.equal(readNote(sqlite, 'n-d'), undefined);
  });

  it('delete on local note newer than remote → skipped', async () => {
    seedNote(sqlite, 'n-d', { updatedAt: 5_000 });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-d',
          op: 'delete',
          payload: { updated_at_ms: 2_000 },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 0);
    assert.equal(result.skippedTotal, 1);
    assert.ok(readNote(sqlite, 'n-d'));
  });

  it('delete on missing local note → idempotent skip', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-gone',
          op: 'delete',
          payload: { updated_at_ms: 2_000 },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 0);
    assert.equal(result.skippedTotal, 1);
    assert.equal(result.cursorAfter, 1);
  });
});

// ─── self-replay skip ────────────────────────────────────────────────

describe('runSync — self-replay skip', () => {
  it('pull cid matching own synced outbox row → skip apply, advance cursor', async () => {
    // simulate: A pushed n-self → server ack → outbox row synced. Now pull
    // returns the same cid (server echo).
    const cid = emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: 'n-self',
      op: 'create',
      payload: { content: 'self', updated_at_ms: 1_000 },
      nowMs: 1_000,
    });
    sqlite
      .prepare(
        'UPDATE sync_changes SET server_seq = 5, synced_at = 1500 WHERE client_change_id = ?',
      )
      .run(cid);

    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 5,
          cid,
          entityId: 'n-self',
          op: 'create',
          payload: {
            content: 'remote-echo',
            folder_id: null,
            trash_level: 0,
            created_at_ms: 1_000,
            updated_at_ms: 9_999,
            tags: [],
          },
        }),
      ],
      hasMore: false,
    });

    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 0);
    assert.equal(result.skippedTotal, 1);
    assert.equal(result.cursorAfter, 5);
    // Local note was never touched — entry doesn't exist
    assert.equal(readNote(sqlite, 'n-self'), undefined);
  });
});

// ─── non-note + metadata skip ────────────────────────────────────────

describe('runSync — pull skip non-note + metadata ops', () => {
  it('non-note entity is skipped but cursor advances past it', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        {
          serverSeq: 11,
          clientChangeId: 'cid-f',
          deviceId: REMOTE_DEVICE,
          entityType: 'folder',
          entityId: 'f-1',
          op: 'create',
          payload: { name: 'whatever' },
        },
      ],
      hasMore: false,
    });
    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.skippedTotal, 1);
    assert.equal(result.cursorAfter, 11);
    const folderCount = sqlite.prepare('SELECT count(*) AS n FROM folders').get() as { n: number };
    assert.equal(folderCount.n, 0);
  });

  it('note pin op (payload without updated_at_ms) skipped + cursor advances', async () => {
    seedNote(sqlite, 'n-p', { updatedAt: 1_000 });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 3,
          entityId: 'n-p',
          op: 'pin',
          payload: { pinned_at_ms: 5_000 },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.skippedTotal, 1);
    assert.equal(result.cursorAfter, 3);
    // Local pinned_at must NOT be set by P5-a apply
    const row = sqlite.prepare('SELECT pinned_at FROM notes WHERE id = ?').get('n-p') as {
      pinned_at: number | null;
    };
    assert.equal(row.pinned_at, null);
  });
});

// ─── validator failure rolls back batch ──────────────────────────────

describe('runSync — pull validator failure', () => {
  it('invalid payload throws and rolls back whole batch — cursor untouched', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-good',
          op: 'create',
          payload: {
            content: 'good',
            folder_id: null,
            trash_level: 0,
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
            tags: [],
          },
        }),
        // missing content → validator throws
        makeNoteChange({
          serverSeq: 2,
          entityId: 'n-bad',
          op: 'create',
          payload: {
            folder_id: null,
            trash_level: 0,
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
            tags: [],
          },
        }),
      ],
      hasMore: false,
    });

    await assert.rejects(
      runSync({
        sqlite,
        client,
        workspaceId: WORKSPACE_ID,
        serverUrl: SERVER_URL,
        nowMs: fakeNow,
      }),
      /content/,
    );
    // n-good must NOT be visible (whole batch rolled back)
    assert.equal(readNote(sqlite, 'n-good'), undefined);
    assert.equal(readCursor(sqlite, SERVER_URL), undefined);
  });
});

// ─── multi-batch drain ───────────────────────────────────────────────

describe('runSync — multi-batch pull', () => {
  it('drains hasMore=true → false; final cursor = max server_seq', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-b1',
          op: 'create',
          payload: {
            content: 'b1',
            folder_id: null,
            trash_level: 0,
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
            tags: [],
          },
        }),
      ],
      hasMore: true,
    });
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 2,
          entityId: 'n-b2',
          op: 'create',
          payload: {
            content: 'b2',
            folder_id: null,
            trash_level: 0,
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
            tags: [],
          },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.pulledTotal, 2);
    assert.equal(result.appliedTotal, 2);
    assert.equal(result.cursorAfter, 2);
    // 2nd pull call used cursor advanced from batch 1
    assert.equal(client.pullCalls.length, 2);
    assert.equal(client.pullCalls[0]?.sinceServerSeq, 0);
    assert.equal(client.pullCalls[1]?.sinceServerSeq, 1);
  });
});

// ─── cursor upsert vs update on second run ───────────────────────────

describe('runSync — second-run cursor update', () => {
  it('second sync updates existing cursor row (not duplicate insert)', async () => {
    // First sync
    {
      const client = new FakeSkybridgeClient();
      client.enqueuePull({
        changes: [
          makeNoteChange({
            serverSeq: 1,
            entityId: 'n-1',
            op: 'create',
            payload: {
              content: 'a',
              folder_id: null,
              trash_level: 0,
              created_at_ms: 1_000,
              updated_at_ms: 1_000,
              tags: [],
            },
          }),
        ],
        hasMore: false,
      });
      await runSync({
        sqlite,
        client,
        workspaceId: WORKSPACE_ID,
        serverUrl: SERVER_URL,
        nowMs: fakeNow,
      });
    }

    // Second sync
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 9,
          entityId: 'n-2',
          op: 'create',
          payload: {
            content: 'b',
            folder_id: null,
            trash_level: 0,
            created_at_ms: 2_000,
            updated_at_ms: 2_000,
            tags: [],
          },
        }),
      ],
      hasMore: false,
    });
    await runSync({
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    const cursor = readCursor(sqlite, SERVER_URL);
    assert.equal(cursor?.pulled_seq, 9);
    const allCursors = sqlite.prepare('SELECT count(*) AS n FROM sync_cursor').get() as {
      n: number;
    };
    assert.equal(allCursors.n, 1);
  });
});
