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
  upsertSyncCursor,
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
  sqlite.prepare('DELETE FROM conflict_record').run();
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

/**
 * Conflict detection gates on a *pending* (unsynced) `sync_changes` row —
 * "B changed this entity since its last sync and A's edit is about to clobber
 * that unpushed change". Tests that want to exercise the conflict-record path
 * seed a pending outbox row (`synced_at IS NULL`). An already-synced row does
 * NOT count (that's a fast-forward, not a conflict) — see
 * `markSyncedLocalEdit` + the false-positive regression test.
 */
function markLocalEdit(sqlite: Database.Database, id: string, cid: string): void {
  sqlite
    .prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at,
          client_change_id, server_seq, synced_at)
       VALUES ('dev-local', 'note', ?, 'update', '{}', 500, ?, NULL, NULL)`,
    )
    .run(id, cid);
}

/**
 * A local edit that was ALREADY pushed (synced). Represents "B created/edited X
 * in the past, all synced" — the common steady-state. An incoming remote edit
 * to such a note is a normal fast-forward and must NOT record a conflict.
 */
function markSyncedLocalEdit(sqlite: Database.Database, id: string, cid: string): void {
  sqlite
    .prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at,
          client_change_id, server_seq, synced_at)
       VALUES ('dev-local', 'note', ?, 'update', '{}', 500, ?, 1, 600)`,
    )
    .run(id, cid);
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
    // Per-change lines moved to debug in 0.6.3 V2; collect them all the same
    // so the existing "was this skip logged" assertions keep their meaning.
    debug: (...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    },
  };
}

// ─── shared DB lifecycle ─────────────────────────────────────────────

let sqlite: Database.Database;
// biome-ignore lint/suspicious/noExplicitAny: drizzle wrapper type irrelevant to tests
let db: any;

before(() => {
  const result = createDatabase({ dbPath: ':memory:' });
  sqlite = result.sqlite;
  db = result.db;
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
      db,
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
      conflictsRecorded: 0,
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
      db,
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
        db,
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
      db,
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
        db,
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
      db,
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
      db,
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

  it('tags field in create payload → applied to note_tags + FTS (P5-b §5.3)', async () => {
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
            tags: [{ tag_type: '#', tag_value: 'foo' }],
          },
        }),
      ],
      hasMore: false,
    });

    await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    const nt = sqlite
      .prepare('SELECT count(*) AS n FROM note_tags WHERE note_id = ?')
      .get('n-tag') as { n: number };
    assert.equal(nt.n, 1, 'tag association written');

    const fts = sqlite
      .prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'foo'")
      .all() as Array<{ rowid: number }>;
    assert.equal(fts.length, 1, 'FTS tags_text updated');
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
      db,
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
      db,
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

  it('update skipped on a fully-equal LWW key (same ms+counter+device → idempotent skip)', async () => {
    // W3: equal updated_at_ms no longer auto-skips — the three-tuple
    // (ms, counter, deviceId) decides. A genuine tie (identical device) is a
    // self-replay-shaped no-op and still skips. Cross-device same-ms is
    // covered by the deviceId-tiebreak case in hlc-engine.test.ts.
    seedNote(sqlite, 'n-u', { content: 'tie', updatedAt: 3_000, deviceId: 'dev-local' });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-u',
          op: 'update',
          deviceId: 'dev-local',
          payload: { updated_at_ms: 3_000, content: 'other' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
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
      db,
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
      db,
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
      db,
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
      db,
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
      db,
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
      db,
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
      db,
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
      db,
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

  // 0.6.3 V4 replaced the old "pin op must be skipped" expectation — see the
  // dedicated suite below. What stays true here is that an *unrecognised*
  // metadata shape is still skipped and still advances the cursor.
  it('note metadata op with an unrecognised payload shape is skipped + cursor advances', async () => {
    seedNote(sqlite, 'n-p', { updatedAt: 1_000 });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 3,
          entityId: 'n-p',
          op: 'pin',
          // pin carries `pinned_at_ms`; this is some future/foreign shape
          payload: { pinned_by: 'someone' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.skippedTotal, 1);
    assert.equal(result.cursorAfter, 3);
    const row = sqlite.prepare('SELECT pinned_at FROM notes WHERE id = ?').get('n-p') as {
      pinned_at: number | null;
    };
    assert.equal(row.pinned_at, null);
  });
});

// ─── 0.6.3 V4: note metadata ops cross devices ───────────────────────

describe('runSync — note metadata ops (0.6.3 V4)', () => {
  interface MetaRow {
    pinned_at: number | null;
    position: number | null;
    updated_at: number;
    lww_counter: number;
    device_id: string | null;
  }

  function readMeta(id: string): MetaRow {
    return sqlite
      .prepare(
        'SELECT pinned_at, position, updated_at, lww_counter, device_id FROM notes WHERE id = ?',
      )
      .get(id) as MetaRow;
  }

  function readHlc(): { ms: string | null; counter: string | null } {
    const get = (key: string): string | null =>
      (
        sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(key) as
          | { value: string | null }
          | undefined
      )?.value ?? null;
    return { ms: get('hlc_last_ms'), counter: get('hlc_last_counter') };
  }

  async function pullOne(change: ServerChangeLike): Promise<number> {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({ changes: [change], hasMore: false });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    return result.appliedTotal;
  }

  it('pin applies to notes.pinned_at without disturbing the LWW columns', async () => {
    seedNote(sqlite, 'n-p', { updatedAt: 1_000, deviceId: 'dev-local' });
    const before = readMeta('n-p');
    const hlcBefore = readHlc();

    const applied = await pullOne(
      makeNoteChange({
        serverSeq: 3,
        entityId: 'n-p',
        op: 'pin',
        payload: { pinned_at_ms: 5_000 },
      }),
    );

    assert.equal(applied, 1);
    const after = readMeta('n-p');
    assert.equal(after.pinned_at, 5_000);
    // A pin is metadata: it must not look like an edit to anyone downstream.
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.lww_counter, before.lww_counter);
    assert.equal(after.device_id, before.device_id);
    // …and it must not advance this device's HLC.
    assert.deepEqual(readHlc(), hlcBefore);
    // …and it must not queue anything for push (no echo loop).
    assert.equal(readChanges(sqlite).length, 0);
  });

  it('unpin (pinned_at_ms: null) clears the column', async () => {
    seedNote(sqlite, 'n-u', { updatedAt: 1_000 });
    sqlite.prepare('UPDATE notes SET pinned_at = 5000 WHERE id = ?').run('n-u');

    const applied = await pullOne(
      makeNoteChange({ serverSeq: 4, entityId: 'n-u', op: 'pin', payload: { pinned_at_ms: null } }),
    );

    assert.equal(applied, 1);
    assert.equal(readMeta('n-u').pinned_at, null);
  });

  it('reorder applies to notes.position', async () => {
    seedNote(sqlite, 'n-r', { updatedAt: 1_000 });
    const before = readMeta('n-r');

    const applied = await pullOne(
      makeNoteChange({ serverSeq: 5, entityId: 'n-r', op: 'update', payload: { position: 2_000 } }),
    );

    assert.equal(applied, 1);
    const after = readMeta('n-r');
    assert.equal(after.position, 2_000);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(readChanges(sqlite).length, 0);
  });

  it('metadata op for a note that does not exist locally is a no-op skip', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 6,
          entityId: 'n-absent',
          op: 'pin',
          payload: { pinned_at_ms: 5_000 },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 0);
    assert.equal(result.skippedTotal, 1);
    assert.equal(result.cursorAfter, 6, 'cursor still advances past it');
  });

  it('rejects malformed metadata payloads instead of guessing', async () => {
    seedNote(sqlite, 'n-bad', { updatedAt: 1_000 });
    for (const [i, payload] of [
      { pinned_at_ms: Number.NaN },
      { pinned_at_ms: 5_000, extra: 1 },
      { position: Number.POSITIVE_INFINITY },
      {},
    ].entries()) {
      const applied = await pullOne(
        makeNoteChange({
          serverSeq: 100 + i,
          entityId: 'n-bad',
          op: 'pin',
          payload: payload as Record<string, unknown>,
        }),
      );
      assert.equal(applied, 0, `payload ${JSON.stringify(payload)} must not apply`);
    }
    assert.equal(readMeta('n-bad').pinned_at, null);
  });

  // The invariant from apply.ts: a device must apply the echo of its OWN
  // metadata op, or it strands itself on the value it pulled mid-round.
  it('applies its own echo — pull-old, push-new, echo converges', async () => {
    seedNote(sqlite, 'n-e', { updatedAt: 1_000 });
    // A already moved the note locally and has not pushed yet.
    sqlite.prepare('UPDATE notes SET position = 3000 WHERE id = ?').run('n-e');
    const cid = emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: 'n-e',
      op: 'update',
      payload: { position: 3_000 },
      nowMs: 2_000,
    });

    // Round 1: pulls B's older ordering first, then pushes A's.
    const client1 = new FakeSkybridgeClient();
    client1.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 7,
          entityId: 'n-e',
          op: 'update',
          payload: { position: 1_000 },
        }),
      ],
      hasMore: false,
    });
    client1.enqueuePush({ accepted: [{ clientChangeId: cid, serverSeq: 8 }], duplicates: [] });
    const r1 = await runSync({
      db,
      sqlite,
      client: client1,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(r1.pushedTotal, 1);
    assert.equal(readMeta('n-e').position, 1_000, 'B ordering landed mid-round');
    // Precondition that gives the next assertion its teeth: the pushed row is
    // now a synced outbox row, so `isSelfReplay` WOULD match the echo below.
    // If the metadata branch ever moves under that check, round 2 goes to
    // 'skipped' and this test fails — which is the whole point.
    const pushedRow = readChanges(sqlite).find((r) => r.client_change_id === cid);
    assert.ok(pushedRow?.synced_at, 'echo cid is a synced outbox row');

    // Round 2: A pulls its own change back. Skipping it as a self-replay
    // would leave A on 1000 while the server and B are on 3000.
    const client2 = new FakeSkybridgeClient();
    client2.enqueuePull({
      changes: [
        {
          serverSeq: 8,
          clientChangeId: cid,
          deviceId: 'dev-local',
          entityType: 'note',
          entityId: 'n-e',
          op: 'update',
          payload: { position: 3_000 },
        },
      ],
      hasMore: false,
    });
    await runSync({
      db,
      sqlite,
      client: client2,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(
      readMeta('n-e').position,
      3_000,
      'own echo must be applied, not self-replay-skipped',
    );
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
        db,
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
      db,
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
        db,
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
      db,
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

// ─── 0.6.3 V1: the two cursors must not zero each other ──────────────
//
// Regression for the bug that made every push reset `pulled_seq` to 0 (and
// every pull reset `pushed_seq`), so the next round re-pulled the entire
// change log. The pre-0.6.3 suite only ever exercised one direction at a
// time on a fresh db, which is exactly why it never showed up.
// See docs/plans/2026-08-11-0.6.3-plan.md §2.

describe('upsertSyncCursor — column independence', () => {
  it('push-only write preserves pulled_seq', () => {
    upsertSyncCursor(sqlite, SERVER_URL, { pulledSeq: 1002, nowMs: 1 });
    upsertSyncCursor(sqlite, SERVER_URL, { pushedSeq: 1011, nowMs: 2 });

    const row = readCursor(sqlite, SERVER_URL);
    assert.equal(row?.pulled_seq, 1002);
    assert.equal(row?.pushed_seq, 1011);
    assert.equal(row?.updated_at, 2);
  });

  it('pull-only write preserves pushed_seq', () => {
    upsertSyncCursor(sqlite, SERVER_URL, { pushedSeq: 42, nowMs: 1 });
    upsertSyncCursor(sqlite, SERVER_URL, { pulledSeq: 7, nowMs: 2 });

    const row = readCursor(sqlite, SERVER_URL);
    assert.equal(row?.pushed_seq, 42);
    assert.equal(row?.pulled_seq, 7);
  });

  it('first write inserts, absent column defaults to 0', () => {
    upsertSyncCursor(sqlite, SERVER_URL, { pushedSeq: 5, nowMs: 3 });

    const row = readCursor(sqlite, SERVER_URL);
    assert.equal(row?.pulled_seq, 0);
    assert.equal(row?.pushed_seq, 5);
  });

  it('both columns in one call', () => {
    upsertSyncCursor(sqlite, SERVER_URL, { pulledSeq: 3, pushedSeq: 4, nowMs: 1 });
    upsertSyncCursor(sqlite, SERVER_URL, { pulledSeq: 30, pushedSeq: 40, nowMs: 2 });

    const row = readCursor(sqlite, SERVER_URL);
    assert.equal(row?.pulled_seq, 30);
    assert.equal(row?.pushed_seq, 40);
  });

  // 0 is a real value, not "not supplied" — this is why the fix reads the
  // bound parameters instead of `NULLIF(excluded.x, 0)`.
  it('an explicit 0 is written, not treated as a sentinel', () => {
    upsertSyncCursor(sqlite, SERVER_URL, { pulledSeq: 1002, pushedSeq: 7, nowMs: 1 });
    upsertSyncCursor(sqlite, SERVER_URL, { pulledSeq: 0, nowMs: 2 });

    const row = readCursor(sqlite, SERVER_URL);
    assert.equal(row?.pulled_seq, 0, 'explicit 0 must overwrite');
    assert.equal(row?.pushed_seq, 7, 'the other column still survives');
  });
});

describe('runSync — cursor survives across round directions', () => {
  it('pull round then push round → pulled_seq is not reset', async () => {
    {
      const client = new FakeSkybridgeClient();
      client.enqueuePull({
        changes: [
          makeNoteChange({
            serverSeq: 7,
            entityId: 'n-pull',
            op: 'create',
            payload: {
              id: 'n-pull',
              content: 'from remote',
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
        db,
        sqlite,
        client,
        workspaceId: WORKSPACE_ID,
        serverUrl: SERVER_URL,
        nowMs: fakeNow,
      });
      assert.equal(readCursor(sqlite, SERVER_URL)?.pulled_seq, 7);
    }

    // A local mutation → this round pulls nothing and only pushes.
    const cid = emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: 'n-local',
      op: 'create',
      payload: { content: 'local', updated_at_ms: 2_000 },
      nowMs: 2_000,
    });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({ changes: [], hasMore: false });
    client.enqueuePush({
      accepted: [{ clientChangeId: cid, serverSeq: 42 }],
      duplicates: [],
    });

    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    // The pull half of this round must have started from 7, not from 0.
    assert.equal(result.cursorBefore, 7);
    const row = readCursor(sqlite, SERVER_URL);
    assert.equal(row?.pulled_seq, 7, 'push must not zero the pull cursor');
    assert.equal(row?.pushed_seq, 42);
  });

  it('push round then pull round → pushed_seq is not reset', async () => {
    {
      const cid = emitSyncChange(sqlite, {
        entityType: 'note',
        entityId: 'n-local',
        op: 'create',
        payload: { content: 'local', updated_at_ms: 1_000 },
        nowMs: 1_000,
      });
      const client = new FakeSkybridgeClient();
      client.enqueuePull({ changes: [], hasMore: false });
      client.enqueuePush({
        accepted: [{ clientChangeId: cid, serverSeq: 42 }],
        duplicates: [],
      });
      await runSync({
        db,
        sqlite,
        client,
        workspaceId: WORKSPACE_ID,
        serverUrl: SERVER_URL,
        nowMs: fakeNow,
      });
      assert.equal(readCursor(sqlite, SERVER_URL)?.pushed_seq, 42);
    }

    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 50,
          entityId: 'n-pull',
          op: 'create',
          payload: {
            id: 'n-pull',
            content: 'from remote',
            folder_id: null,
            trash_level: 0,
            created_at_ms: 3_000,
            updated_at_ms: 3_000,
            tags: [],
          },
        }),
      ],
      hasMore: false,
    });
    await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    const row = readCursor(sqlite, SERVER_URL);
    assert.equal(row?.pushed_seq, 42, 'pull must not zero the push cursor');
    assert.equal(row?.pulled_seq, 50);
  });
});

// ─── P5-b §4.4: folder apply ─────────────────────────────────────────

interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  position: number;
  updated_at: number;
  device_id: string | null;
  local_device_uuid: string;
}

function readFolder(sqlite: Database.Database, id: string): FolderRow | undefined {
  return sqlite.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
}

function makeFolderChange(input: {
  serverSeq: number;
  cid?: string;
  deviceId?: string;
  entityId: string;
  op: 'create' | 'update' | 'delete' | string;
  payload: Record<string, unknown>;
}): ServerChangeLike {
  return {
    serverSeq: input.serverSeq,
    clientChangeId: input.cid ?? `cid-${input.serverSeq}`,
    deviceId: input.deviceId ?? REMOTE_DEVICE,
    entityType: 'folder',
    entityId: input.entityId,
    op: input.op,
    payload: input.payload,
  };
}

describe('runSync — pull apply folder (P5-b §4.4)', () => {
  it('create inserts folder with remote device_id + local local_device_uuid', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeFolderChange({
          serverSeq: 1,
          entityId: 'f-a',
          op: 'create',
          payload: {
            name: 'Inbox',
            parent_id: null,
            position: 0,
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
          },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 1);
    const row = readFolder(sqlite, 'f-a');
    assert.ok(row, 'folder row inserted');
    assert.equal(row.name, 'Inbox');
    assert.equal(row.device_id, REMOTE_DEVICE);
    assert.equal(row.local_device_uuid, 'dev-local');
  });

  it('update sparse — preserves parent_id when not in payload', async () => {
    // seed
    sqlite
      .prepare(
        'INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, local_device_uuid) VALUES (?, ?, ?, 0, 0, 100, ?)',
      )
      .run('f-p', 'Parent', null, 'dev-local');
    sqlite
      .prepare(
        'INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, local_device_uuid) VALUES (?, ?, ?, 0, 0, 100, ?)',
      )
      .run('f-c', 'Child', 'f-p', 'dev-local');

    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeFolderChange({
          serverSeq: 1,
          entityId: 'f-c',
          op: 'update',
          payload: { updated_at_ms: 200, name: 'Renamed' },
        }),
      ],
      hasMore: false,
    });
    await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    const row = readFolder(sqlite, 'f-c');
    assert.equal(row?.name, 'Renamed');
    assert.equal(row?.parent_id, 'f-p', 'parent_id preserved across sparse update');
  });

  it('delete with older local → deleted', async () => {
    sqlite
      .prepare(
        'INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, local_device_uuid) VALUES (?, ?, ?, 0, 0, 100, ?)',
      )
      .run('f-d', 'Doomed', null, 'dev-local');

    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeFolderChange({
          serverSeq: 1,
          entityId: 'f-d',
          op: 'delete',
          payload: { updated_at_ms: 200 },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 1);
    assert.equal(readFolder(sqlite, 'f-d'), undefined);
  });

  it('delete with newer local → skipped', async () => {
    sqlite
      .prepare(
        'INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, local_device_uuid) VALUES (?, ?, ?, 0, 0, 500, ?)',
      )
      .run('f-keep', 'Keep', null, 'dev-local');

    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeFolderChange({
          serverSeq: 1,
          entityId: 'f-keep',
          op: 'delete',
          payload: { updated_at_ms: 200 },
        }),
      ],
      hasMore: false,
    });
    const logger = collectingLogger();
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
      logger,
    });
    assert.equal(result.appliedTotal, 0);
    assert.equal(result.skippedTotal, 1);
    assert.ok(readFolder(sqlite, 'f-keep'), 'row preserved');
    assert.ok(
      logger.lines.some((l) => l.includes('apply folder f-keep delete') && l.includes('skipped')),
      `expected delete-skip log, got: ${logger.lines.join('\n')}`,
    );
  });

  it('LWW fully-equal key (same ms+counter+device) → idempotent skip', async () => {
    // W3: equal ms alone no longer skips; a true tie needs identical
    // (ms, counter, deviceId). Cross-device same-ms is deviceId-decided
    // (covered in hlc-engine.test.ts).
    sqlite
      .prepare(
        'INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, device_id, local_device_uuid) VALUES (?, ?, ?, 0, 0, 1000, ?, ?)',
      )
      .run('f-t', 'Local', null, 'dev-local', 'dev-local');

    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeFolderChange({
          serverSeq: 1,
          entityId: 'f-t',
          op: 'update',
          deviceId: 'dev-local',
          payload: { updated_at_ms: 1000, name: 'Remote' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.skippedTotal, 1);
    assert.equal(readFolder(sqlite, 'f-t')?.name, 'Local');
  });
});

// ─── P5-b §4.6: conversation apply ───────────────────────────────────

interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  seq: number;
}

function makeConvoChange(input: {
  serverSeq: number;
  cid?: string;
  deviceId?: string;
  entityId: string;
  op: 'append' | 'delete' | string;
  payload: Record<string, unknown>;
}): ServerChangeLike {
  return {
    serverSeq: input.serverSeq,
    clientChangeId: input.cid ?? `cid-${input.serverSeq}`,
    deviceId: input.deviceId ?? REMOTE_DEVICE,
    entityType: 'conversation',
    entityId: input.entityId,
    op: input.op,
    payload: input.payload,
  };
}

const baseMsg = {
  tool_calls: null,
  tool_call_id: null,
  is_error: null,
  reasoning_content: null,
  reasoning_signature: null,
};

describe('runSync — pull apply conversation (P5-b §4.6)', () => {
  it('first append creates conversation + appends messages', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeConvoChange({
          serverSeq: 1,
          entityId: 'conv-1',
          op: 'append',
          payload: {
            messages: [
              { role: 'user', content: 'hi', ...baseMsg },
              { role: 'assistant', content: 'hello', ...baseMsg },
            ],
            applied_at_ms: 5_000,
            title: 'Greeting',
            created_at_ms: 4_000,
          },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 1);
    const convo = sqlite.prepare('SELECT * FROM ai_conversations WHERE id = ?').get('conv-1') as
      | ConversationRow
      | undefined;
    assert.ok(convo);
    assert.equal(convo.title, 'Greeting');
    assert.equal(convo.created_at, 4_000);
    assert.equal(convo.updated_at, 5_000);

    const msgs = sqlite
      .prepare('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY seq')
      .all('conv-1') as MessageRow[];
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]?.role, 'user');
    assert.equal(msgs[0]?.seq, 1);
    assert.equal(msgs[1]?.role, 'assistant');
    assert.equal(msgs[1]?.seq, 2);
  });

  it('subsequent append continues seq from local max', async () => {
    // first append
    const c1 = new FakeSkybridgeClient();
    c1.enqueuePull({
      changes: [
        makeConvoChange({
          serverSeq: 1,
          entityId: 'conv-x',
          op: 'append',
          payload: {
            messages: [{ role: 'user', content: 'a', ...baseMsg }],
            applied_at_ms: 1_000,
            title: 'T',
            created_at_ms: 0,
          },
        }),
      ],
      hasMore: false,
    });
    await runSync({
      db,
      sqlite,
      client: c1,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    // second append (no title)
    const c2 = new FakeSkybridgeClient();
    c2.enqueuePull({
      changes: [
        makeConvoChange({
          serverSeq: 2,
          entityId: 'conv-x',
          op: 'append',
          payload: {
            messages: [
              { role: 'assistant', content: 'b', ...baseMsg },
              { role: 'user', content: 'c', ...baseMsg },
            ],
            applied_at_ms: 2_000,
          },
        }),
      ],
      hasMore: false,
    });
    await runSync({
      db,
      sqlite,
      client: c2,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    const msgs = sqlite
      .prepare('SELECT seq, role, content FROM ai_messages WHERE conversation_id = ? ORDER BY seq')
      .all('conv-x') as Array<{ seq: number; role: string; content: string }>;
    assert.equal(msgs.length, 3);
    assert.deepEqual(
      msgs.map((m) => m.seq),
      [1, 2, 3],
    );
    assert.equal(msgs[2]?.content, 'c');

    const convo = sqlite
      .prepare('SELECT title, updated_at FROM ai_conversations WHERE id = ?')
      .get('conv-x') as { title: string; updated_at: number };
    assert.equal(convo.title, 'T', 'title preserved on subsequent append');
    assert.equal(convo.updated_at, 2_000);
  });

  it('delete cascades messages via FK', async () => {
    // seed via append
    const c1 = new FakeSkybridgeClient();
    c1.enqueuePull({
      changes: [
        makeConvoChange({
          serverSeq: 1,
          entityId: 'conv-d',
          op: 'append',
          payload: {
            messages: [{ role: 'user', content: 'a', ...baseMsg }],
            applied_at_ms: 1_000,
            title: 'T',
            created_at_ms: 0,
          },
        }),
      ],
      hasMore: false,
    });
    await runSync({
      db,
      sqlite,
      client: c1,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    const c2 = new FakeSkybridgeClient();
    c2.enqueuePull({
      changes: [
        makeConvoChange({
          serverSeq: 2,
          entityId: 'conv-d',
          op: 'delete',
          payload: {},
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client: c2,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 1);

    const convo = sqlite.prepare('SELECT 1 FROM ai_conversations WHERE id = ?').get('conv-d');
    assert.equal(convo, undefined);
    const msgs = sqlite
      .prepare('SELECT count(*) AS n FROM ai_messages WHERE conversation_id = ?')
      .get('conv-d') as { n: number };
    assert.equal(msgs.n, 0, 'FK cascade clears messages');
  });
});

// ─── router (unknown entity type) ────────────────────────────────────

describe('runSync — router (P5-b §4.7)', () => {
  it('unknown entity_type → skipped + log + cursor advances', async () => {
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        {
          serverSeq: 1,
          clientChangeId: 'cid-unk',
          deviceId: REMOTE_DEVICE,
          entityType: 'tag',
          entityId: 't-1',
          op: 'create',
          payload: { updated_at_ms: 1_000 },
        },
      ],
      hasMore: false,
    });
    const logger = collectingLogger();
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
      logger,
    });
    assert.equal(result.skippedTotal, 1);
    assert.equal(result.cursorAfter, 1);
    assert.ok(
      logger.lines.some((l) => l.includes('unknown entity') && l.includes('type=tag')),
      `expected unknown-entity log, got: ${logger.lines.join('\n')}`,
    );
  });
});

describe('runSync — conflict detection (P5-c §6.16)', () => {
  function readConflicts(): Array<{
    entity_id: string;
    losing_side: string;
    local_payload: string;
    remote_payload: string;
    local_updated_at_ms: number;
    remote_updated_at_ms: number;
    local_lww_counter: number | null;
    remote_lww_counter: number | null;
    local_device_id: string | null;
    remote_device_id: string | null;
    remote_seq: number;
  }> {
    return sqlite
      .prepare(
        `SELECT entity_id, losing_side, local_payload, remote_payload,
                local_updated_at_ms, remote_updated_at_ms,
                local_lww_counter, remote_lww_counter,
                local_device_id, remote_device_id, remote_seq
           FROM conflict_record ORDER BY detected_at`,
      )
      .all() as ReturnType<typeof readConflicts>;
  }

  it('records conflict when remote update wins LWW AND content differs', async () => {
    seedNote(sqlite, 'n-c', { content: 'local copy', updatedAt: 1_000 });
    markLocalEdit(sqlite, 'n-c', 'cid-local-edit');
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 7,
          entityId: 'n-c',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'remote copy' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.appliedTotal, 1);
    assert.equal(result.conflictsRecorded, 1);

    const rows = readConflicts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entity_id, 'n-c');
    assert.equal(rows[0].losing_side, 'local');
    assert.equal(rows[0].local_updated_at_ms, 1_000);
    assert.equal(rows[0].remote_updated_at_ms, 2_000);
    assert.equal(rows[0].remote_seq, 7);
    assert.deepEqual(JSON.parse(rows[0].local_payload), {
      content: 'local copy',
      updated_at_ms: 1_000,
    });
    assert.deepEqual(JSON.parse(rows[0].remote_payload), {
      content: 'remote copy',
      updated_at_ms: 2_000,
    });

    // Local row overwritten with remote content (LWW apply still happens).
    assert.equal(readNote(sqlite, 'n-c')?.content, 'remote copy');
  });

  // ── 0011 (0.6.2 W1): the row records the whole LWW three-tuple, so the
  // conflicts page can explain the outcome even when the ms values tie.

  it('same ms, remote counter wins → both counters recorded', async () => {
    seedNote(sqlite, 'n-c', { content: 'local copy', updatedAt: 2_000 });
    sqlite.prepare('UPDATE notes SET lww_counter = 1 WHERE id = ?').run('n-c');
    markLocalEdit(sqlite, 'n-c', 'cid-local-edit');
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 8,
          entityId: 'n-c',
          op: 'update',
          payload: { updated_at_ms: 2_000, lww_counter: 2, content: 'remote copy' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.conflictsRecorded, 1);
    const [row] = readConflicts();
    assert.equal(row.local_updated_at_ms, 2_000);
    assert.equal(row.remote_updated_at_ms, 2_000);
    assert.equal(row.local_lww_counter, 1);
    assert.equal(row.remote_lww_counter, 2);
  });

  it('same ms + same counter, device_id breaks the tie → both device ids recorded', async () => {
    // 'dev-remote' > 'dev-local' lexicographically, so remote wins on the third
    // dimension alone — the only thing that explains the outcome is device_id.
    seedNote(sqlite, 'n-c', { content: 'local copy', updatedAt: 2_000, deviceId: 'dev-local' });
    sqlite.prepare('UPDATE notes SET lww_counter = 3 WHERE id = ?').run('n-c');
    markLocalEdit(sqlite, 'n-c', 'cid-local-edit');
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 9,
          entityId: 'n-c',
          op: 'update',
          payload: { updated_at_ms: 2_000, lww_counter: 3, content: 'remote copy' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.conflictsRecorded, 1);
    const [row] = readConflicts();
    assert.equal(row.local_lww_counter, 3);
    assert.equal(row.remote_lww_counter, 3);
    assert.equal(row.local_device_id, 'dev-local');
    assert.equal(row.remote_device_id, REMOTE_DEVICE);
    assert.equal(readNote(sqlite, 'n-c')?.content, 'remote copy');
  });

  it('a NULL local device_id is stored as NULL, not the empty-string placeholder', async () => {
    seedNote(sqlite, 'n-c', { content: 'local copy', updatedAt: 1_000 });
    // seedNote defaults device_id to 'dev-local'; a genuinely device-less row
    // (pre-0006 note that was never re-stamped) is what lww.ts reads as ''.
    sqlite.prepare('UPDATE notes SET device_id = NULL WHERE id = ?').run('n-c');
    markLocalEdit(sqlite, 'n-c', 'cid-local-edit');
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 10,
          entityId: 'n-c',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'remote copy' },
        }),
      ],
      hasMore: false,
    });
    await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    const [row] = readConflicts();
    assert.equal(row.local_device_id, null);
    assert.equal(row.remote_device_id, REMOTE_DEVICE);
  });

  it('no conflict when content matches (LWW apply without conflict_record write)', async () => {
    seedNote(sqlite, 'n-c', { content: 'same text', updatedAt: 1_000 });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 3,
          entityId: 'n-c',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'same text' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.appliedTotal, 1);
    assert.equal(result.conflictsRecorded, 0);
    assert.equal(readConflicts().length, 0);
  });

  it('no conflict on LWW-loser pull (remote older → skipped, no detection)', async () => {
    seedNote(sqlite, 'n-c', { content: 'fresh local', updatedAt: 5_000 });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-c',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'stale remote' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.appliedTotal, 0);
    assert.equal(result.skippedTotal, 1);
    assert.equal(result.conflictsRecorded, 0);
    assert.equal(readConflicts().length, 0);
  });

  it('no conflict on update payload without content (sparse update — touch only)', async () => {
    seedNote(sqlite, 'n-c', { content: 'untouched', updatedAt: 1_000 });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-c',
          op: 'update',
          payload: { updated_at_ms: 2_000 },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.appliedTotal, 1);
    assert.equal(result.conflictsRecorded, 0);
    assert.equal(readConflicts().length, 0);
  });

  it('no conflict on create / trash / restore / delete ops', async () => {
    seedNote(sqlite, 'n-tr', {
      content: 'before trash',
      updatedAt: 1_000,
      trashLevel: 0,
    });
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        // create on fresh id — no local row to lose
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-new',
          op: 'create',
          payload: {
            updated_at_ms: 2_000,
            created_at_ms: 1_500,
            content: 'fresh remote',
            folder_id: null,
            trash_level: 0,
            tags: [],
          },
        }),
        // trash on existing local note
        makeNoteChange({
          serverSeq: 2,
          entityId: 'n-tr',
          op: 'trash',
          payload: {
            updated_at_ms: 3_000,
            trash_level: 1,
            trashed_at_ms: 3_000,
            auto_delete_at_ms: null,
          },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.conflictsRecorded, 0);
    assert.equal(readConflicts().length, 0);
  });

  it('multi-note batch: only updates with content diff bump conflictsRecorded', async () => {
    seedNote(sqlite, 'n-a', { content: 'A-local', updatedAt: 1_000 });
    seedNote(sqlite, 'n-b', { content: 'B-local', updatedAt: 1_000 });
    seedNote(sqlite, 'n-c', { content: 'C-local', updatedAt: 1_000 });
    markLocalEdit(sqlite, 'n-a', 'cid-local-a');
    markLocalEdit(sqlite, 'n-b', 'cid-local-b');
    markLocalEdit(sqlite, 'n-c', 'cid-local-c');
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 1,
          entityId: 'n-a',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'A-remote' },
        }),
        makeNoteChange({
          serverSeq: 2,
          entityId: 'n-b',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'B-local' }, // same content
        }),
        makeNoteChange({
          serverSeq: 3,
          entityId: 'n-c',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'C-remote' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.appliedTotal, 3);
    assert.equal(result.conflictsRecorded, 2);
    const ids = readConflicts()
      .map((r) => r.entity_id)
      .sort();
    assert.deepEqual(ids, ['n-a', 'n-c']);
  });

  it('bootstrap replay: local note with no sync_changes row never records conflict', async () => {
    // Mirrors P5-c follow-up #2: B is a fresh nest that just received
    // A's `create` op (so notes row exists locally) and then A's older
    // `update` arrives in the same pull stream. LWW says remote loses
    // (older), but engine.ts:430 would have short-circuited there. The
    // tricky case is when remote *wins* LWW during pure replay — e.g.
    // create + update both arrive, the update has newer ts than the
    // create payload. Without the sync_changes gate, the update would
    // record a conflict against the just-installed create snapshot.
    seedNote(sqlite, 'n-bootstrap', { content: 'create-snap', updatedAt: 1_000 });
    // NOTE: no markLocalEdit — B never touched this entity locally.
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 11,
          entityId: 'n-bootstrap',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'later-history' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.appliedTotal, 1, 'apply still proceeds — LWW write happens');
    assert.equal(result.conflictsRecorded, 0, 'no conflict row — pure replay');
    assert.equal(readConflicts().length, 0);
    assert.equal(readNote(sqlite, 'n-bootstrap')?.content, 'later-history');
  });

  it('fast-forward: already-synced local edit does NOT record a conflict', async () => {
    // Regression for the "手动同步后另一边一定冲突" false positive. B created /
    // edited X and pushed it (synced row, no pending edit). A then edits X and
    // pushes; B pulls A's newer edit. This is a clean fast-forward — B has no
    // unpushed change to lose — so NO conflict must be recorded even though B
    // has a (synced) sync_changes row for X and the content differs.
    seedNote(sqlite, 'n-ff', { content: 'B-old-synced', updatedAt: 1_000 });
    markSyncedLocalEdit(sqlite, 'n-ff', 'cid-synced');
    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        makeNoteChange({
          serverSeq: 9,
          entityId: 'n-ff',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'A-newer' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });

    assert.equal(result.appliedTotal, 1, 'LWW apply still happens');
    assert.equal(result.conflictsRecorded, 0, 'fast-forward must not conflict');
    assert.equal(readConflicts().length, 0);
    assert.equal(readNote(sqlite, 'n-ff')?.content, 'A-newer');
  });

  it('self-replay does not trigger conflict detection (cid matches synced outbox)', async () => {
    // Seed a previously-pushed local update: outbox row with cid 'cid-self' synced.
    seedNote(sqlite, 'n-c', { content: 'local copy', updatedAt: 1_000 });
    sqlite
      .prepare(
        `INSERT INTO sync_changes
           (device_id, entity_type, entity_id, op, payload, created_at,
            client_change_id, server_seq, synced_at)
         VALUES ('dev-local', 'note', 'n-c', 'update', '{}', 500, 'cid-self', 42, 600)`,
      )
      .run();

    const client = new FakeSkybridgeClient();
    client.enqueuePull({
      changes: [
        // Same cid coming back from server — must be treated as self-replay,
        // not a conflict candidate, even though content differs.
        makeNoteChange({
          serverSeq: 42,
          cid: 'cid-self',
          entityId: 'n-c',
          op: 'update',
          payload: { updated_at_ms: 2_000, content: 'remote ghost' },
        }),
      ],
      hasMore: false,
    });
    const result = await runSync({
      db,
      sqlite,
      client,
      workspaceId: WORKSPACE_ID,
      serverUrl: SERVER_URL,
      nowMs: fakeNow,
    });
    assert.equal(result.conflictsRecorded, 0);
    assert.equal(readConflicts().length, 0);
    // Local row untouched.
    assert.equal(readNote(sqlite, 'n-c')?.content, 'local copy');
  });
});
