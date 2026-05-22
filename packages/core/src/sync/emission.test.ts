import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import {
  type ConversationMessageRow,
  appendConversationMessages,
  deleteConversation,
} from '../conversations/index.js';
import { createDatabase } from '../db/index.js';
import type { OwlDatabase } from '../db/index.js';
import { createFolder, deleteFolder, reorderFolders, updateFolder } from '../folders/index.js';
import { VersionMismatchError } from '../notes/errors.js';
import {
  batchPermanentDeleteNotes,
  createNote,
  deleteNote,
  permanentDeleteNote,
  reorderNotesInFolder,
  restoreNote,
  setNotePinned,
  updateNote,
} from '../notes/index.js';

interface SyncChangeRow {
  local_seq: number;
  device_id: string;
  entity_type: string;
  entity_id: string;
  op: string;
  payload: string;
  created_at: number;
}

function readChanges(sqlite: Database.Database): SyncChangeRow[] {
  return sqlite.prepare('SELECT * FROM sync_changes ORDER BY local_seq').all() as SyncChangeRow[];
}

function clearAll(sqlite: Database.Database): void {
  sqlite.prepare('DELETE FROM sync_changes').run();
  sqlite.prepare('DELETE FROM ai_messages').run();
  sqlite.prepare('DELETE FROM ai_conversations').run();
  sqlite.prepare('DELETE FROM note_tags').run();
  sqlite.prepare('DELETE FROM tags').run();
  sqlite.prepare('DELETE FROM notes').run();
  sqlite.prepare('DELETE FROM folders').run();
}

function lastChange(sqlite: Database.Database): SyncChangeRow {
  const rows = readChanges(sqlite);
  return rows[rows.length - 1];
}

describe('sync_changes emission — notes', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    clearAll(sqlite);
  });

  after(() => {
    sqlite.close();
  });

  it('createNote emits note/create with full payload', () => {
    const note = createNote(db, sqlite, {
      content: 'hello',
      folderId: null,
      tags: [{ tagType: '#', tagValue: 'x' }],
    });
    const row = lastChange(sqlite);
    assert.equal(row.entity_type, 'note');
    assert.equal(row.entity_id, note.id);
    assert.equal(row.op, 'create');
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    assert.equal(p.content, 'hello');
    assert.equal(p.folder_id, null);
    assert.equal(p.trash_level, 0);
    assert.ok(typeof p.created_at_ms === 'number');
    assert.ok(typeof p.updated_at_ms === 'number');
    assert.deepEqual(p.tags, [{ tag_type: '#', tag_value: 'x' }]);
    // device_id and content_hash are NOT in payload (derived)
    assert.equal(p.device_id, undefined);
    assert.equal(p.content_hash, undefined);
    // pinned_at_ms / position are NOT in payload (always NULL on create)
    assert.equal(p.pinned_at_ms, undefined);
    assert.equal(p.position, undefined);
  });

  it('updateNote emits note/update with sparse payload', () => {
    const note = createNote(db, sqlite, { content: 'orig' });
    clearAll(sqlite);
    // re-seed the same note row so subsequent calls see it
    sqlite
      .prepare(
        `INSERT INTO notes (id, content, folder_id, trash_level, created_at, updated_at, content_hash, local_device_uuid)
         VALUES (?, ?, NULL, 0, ?, ?, '', 'test-dev')`,
      )
      .run(note.id, 'orig', Date.now(), Date.now());

    updateNote(db, sqlite, note.id, { content: 'changed' });
    const row = lastChange(sqlite);
    assert.equal(row.op, 'update');
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    assert.equal(p.content, 'changed');
    assert.equal(p.folder_id, undefined, 'folder_id not in update payload when not changed');
    assert.equal(p.tags, undefined, 'tags not in update payload when not changed');
    assert.ok(typeof p.updated_at_ms === 'number');
  });

  it('deleteNote emits note/trash', () => {
    const note = createNote(db, sqlite, { content: 'doomed' });
    clearAll(sqlite);
    sqlite
      .prepare(
        `INSERT INTO notes (id, content, folder_id, trash_level, created_at, updated_at, content_hash, local_device_uuid)
         VALUES (?, ?, NULL, 0, ?, ?, '', 'test-dev')`,
      )
      .run(note.id, 'doomed', Date.now(), Date.now());

    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 });
    const row = lastChange(sqlite);
    assert.equal(row.op, 'trash');
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    assert.equal(p.trash_level, 1);
    assert.ok(typeof p.trashed_at_ms === 'number');
    assert.equal(p.auto_delete_at_ms, null, 'level 1 has no deadline');
  });

  it('deleteNote level 1 → 2 stamps auto_delete_at_ms', () => {
    const note = createNote(db, sqlite, { content: 'doomed-2' });
    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 }); // → level 1
    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 }); // → level 2
    const row = lastChange(sqlite);
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    assert.equal(p.trash_level, 2);
    assert.ok(typeof p.auto_delete_at_ms === 'number');
  });

  it('restoreNote emits note/restore', () => {
    const note = createNote(db, sqlite, { content: 'phoenix' });
    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 });
    restoreNote(db, sqlite, note.id);
    const row = lastChange(sqlite);
    assert.equal(row.op, 'restore');
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    assert.equal(p.trash_level, 0);
    assert.equal(p.trashed_at_ms, null, 'fully restored has no trashed_at');
    assert.equal(p.auto_delete_at_ms, null);
  });

  it('permanentDeleteNote emits note/delete with updated_at_ms payload (P5-a Step 0b)', () => {
    const before = Date.now();
    const note = createNote(db, sqlite, { content: 'gone' });
    permanentDeleteNote(db, sqlite, note.id);
    const after = Date.now();
    const row = lastChange(sqlite);
    assert.equal(row.op, 'delete');
    assert.equal(row.entity_id, note.id);
    const payload = JSON.parse(row.payload) as { updated_at_ms: number };
    assert.equal(typeof payload.updated_at_ms, 'number');
    assert.ok(
      payload.updated_at_ms >= before && payload.updated_at_ms <= after,
      `updated_at_ms ${payload.updated_at_ms} outside [${before}, ${after}]`,
    );
    // Confirm no stray fields slipped in
    assert.deepEqual(Object.keys(payload).sort(), ['updated_at_ms']);
  });

  it('batchPermanentDeleteNotes emits one delete per id', () => {
    const a = createNote(db, sqlite, { content: 'a' });
    const b = createNote(db, sqlite, { content: 'b' });
    clearAll(sqlite);
    sqlite
      .prepare(
        `INSERT INTO notes (id, content, folder_id, trash_level, created_at, updated_at, content_hash, local_device_uuid)
         VALUES (?, ?, NULL, 0, ?, ?, '', 'test-dev'), (?, ?, NULL, 0, ?, ?, '', 'test-dev')`,
      )
      .run(a.id, 'a', Date.now(), Date.now(), b.id, 'b', Date.now(), Date.now());

    const count = batchPermanentDeleteNotes(db, sqlite, [a.id, b.id]);
    assert.equal(count, 2);
    const rows = readChanges(sqlite);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => ({ op: r.op, id: r.entity_id })).sort((x, y) => x.id.localeCompare(y.id)),
      [
        { op: 'delete', id: a.id },
        { op: 'delete', id: b.id },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
  });

  it('setNotePinned(true) then setNotePinned(false) emits two pin rows', () => {
    const note = createNote(db, sqlite, { content: 'pinme' });
    clearAll(sqlite);
    sqlite
      .prepare(
        `INSERT INTO notes (id, content, folder_id, trash_level, created_at, updated_at, content_hash, local_device_uuid)
         VALUES (?, ?, NULL, 0, ?, ?, '', 'test-dev')`,
      )
      .run(note.id, 'pinme', Date.now(), Date.now());

    setNotePinned(db, sqlite, note.id, true);
    setNotePinned(db, sqlite, note.id, false);
    const rows = readChanges(sqlite);
    assert.equal(rows.length, 2);
    const p1 = JSON.parse(rows[0].payload) as Record<string, unknown>;
    const p2 = JSON.parse(rows[1].payload) as Record<string, unknown>;
    assert.equal(rows[0].op, 'pin');
    assert.ok(typeof p1.pinned_at_ms === 'number');
    assert.equal(rows[1].op, 'pin');
    assert.equal(p2.pinned_at_ms, null);
  });

  it('reorderNotesInFolder emits one update per note with position', () => {
    const a = createNote(db, sqlite, { content: 'a' });
    const b = createNote(db, sqlite, { content: 'b' });
    const c = createNote(db, sqlite, { content: 'c' });
    clearAll(sqlite);
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO notes (id, content, folder_id, trash_level, created_at, updated_at, content_hash, local_device_uuid)
         VALUES (?, ?, NULL, 0, ?, ?, '', 'test-dev'), (?, ?, NULL, 0, ?, ?, '', 'test-dev'), (?, ?, NULL, 0, ?, ?, '', 'test-dev')`,
      )
      .run(a.id, 'a', now, now, b.id, 'b', now, now, c.id, 'c', now, now);

    reorderNotesInFolder(db, sqlite, null, [c.id, a.id, b.id]);

    const rows = readChanges(sqlite);
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.entity_type, 'note');
      assert.equal(r.op, 'update');
    }
    const positions = new Map(
      rows.map((r) => [r.entity_id, JSON.parse(r.payload).position as number]),
    );
    assert.equal(positions.get(c.id), 1000);
    assert.equal(positions.get(a.id), 2000);
    assert.equal(positions.get(b.id), 3000);
  });

  it('atomicity: updateNote CAS failure leaves NO sync_changes row', () => {
    const note = createNote(db, sqlite, { content: 'orig' });
    const before = readChanges(sqlite).length;

    assert.throws(
      () => updateNote(db, sqlite, note.id, { content: 'x' }, { expectedUpdatedAt: 1 }),
      (err: Error) => err instanceof VersionMismatchError,
    );

    const after = readChanges(sqlite).length;
    assert.equal(after, before, 'no new sync_changes after CAS failure');
  });
});

describe('sync_changes emission — folders', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    clearAll(sqlite);
  });

  after(() => {
    sqlite.close();
  });

  it('createFolder emits folder/create', () => {
    const f = createFolder(db, sqlite, { name: 'Work' });
    const row = lastChange(sqlite);
    assert.equal(row.entity_type, 'folder');
    assert.equal(row.entity_id, f.id);
    assert.equal(row.op, 'create');
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    assert.equal(p.name, 'Work');
    assert.equal(p.parent_id, null);
    assert.equal(p.position, 0);
    assert.ok(typeof p.created_at_ms === 'number');
    assert.equal(p.device_id, undefined, 'device_id not in payload');
  });

  it('updateFolder emits folder/update with sparse payload', () => {
    const f = createFolder(db, sqlite, { name: 'X' });
    clearAll(sqlite);
    sqlite
      .prepare(
        'INSERT INTO folders (id, name, position, created_at, updated_at, local_device_uuid) VALUES (?, ?, 0, ?, ?, ?)',
      )
      .run(f.id, 'X', Date.now(), Date.now(), 'test-dev');

    updateFolder(db, sqlite, f.id, { name: 'Y' });
    const row = lastChange(sqlite);
    assert.equal(row.op, 'update');
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    assert.equal(p.name, 'Y');
    assert.equal(p.parent_id, undefined);
    assert.equal(p.position, undefined);
  });

  it('deleteFolder emits one update per child + one delete for self', () => {
    const root = createFolder(db, sqlite, { name: 'Root' });
    const mid = createFolder(db, sqlite, { name: 'Mid', parentId: root.id });
    const c1 = createFolder(db, sqlite, { name: 'C1', parentId: mid.id });
    const c2 = createFolder(db, sqlite, { name: 'C2', parentId: mid.id });
    clearAll(sqlite);
    const now = Date.now();
    const dev = 'test-dev';
    sqlite
      .prepare(
        'INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, local_device_uuid) VALUES (?, ?, NULL, 0, ?, ?, ?), (?, ?, ?, 0, ?, ?, ?), (?, ?, ?, 0, ?, ?, ?), (?, ?, ?, 0, ?, ?, ?)',
      )
      .run(
        root.id,
        'Root',
        now,
        now,
        dev,
        mid.id,
        'Mid',
        root.id,
        now,
        now,
        dev,
        c1.id,
        'C1',
        mid.id,
        now,
        now,
        dev,
        c2.id,
        'C2',
        mid.id,
        now,
        now,
        dev,
      );

    deleteFolder(db, sqlite, mid.id);

    const rows = readChanges(sqlite);
    // 2 child updates + 1 self delete
    assert.equal(rows.length, 3);
    const updates = rows.filter((r) => r.op === 'update');
    const deletes = rows.filter((r) => r.op === 'delete');
    assert.equal(updates.length, 2);
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].entity_id, mid.id);
    for (const u of updates) {
      const p = JSON.parse(u.payload) as Record<string, unknown>;
      assert.equal(p.parent_id, root.id, 'children re-parented to grandparent');
      assert.ok(typeof p.updated_at_ms === 'number');
    }
    const childIds = updates.map((u) => u.entity_id).sort();
    assert.deepEqual(childIds, [c1.id, c2.id].sort());
  });

  it('reorderFolders emits one update per row', () => {
    const a = createFolder(db, sqlite, { name: 'A' });
    const b = createFolder(db, sqlite, { name: 'B' });
    // Wipe sync_changes only (keep folders so reorderFolders can hit them)
    sqlite.prepare('DELETE FROM sync_changes').run();

    reorderFolders(db, sqlite, [
      { id: a.id, parentId: null, position: 100 },
      { id: b.id, parentId: null, position: 200 },
    ]);

    const rows = readChanges(sqlite);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.entity_type, 'folder');
      assert.equal(r.op, 'update');
    }
  });
});

describe('sync_changes emission — conversations', () => {
  let sqlite: Database.Database;

  function userMsg(content: string): ConversationMessageRow {
    return {
      role: 'user',
      content,
      tool_calls: null,
      tool_call_id: null,
      is_error: null,
      reasoning_content: null,
      reasoning_signature: null,
    };
  }

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    clearAll(sqlite);
  });

  after(() => {
    sqlite.close();
  });

  it('appendConversationMessages first call emits append with title + created_at_ms', () => {
    appendConversationMessages(sqlite, 'conv-A', [userMsg('hello world')], 1_000_000);
    const row = lastChange(sqlite);
    assert.equal(row.entity_type, 'conversation');
    assert.equal(row.entity_id, 'conv-A');
    assert.equal(row.op, 'append');
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    assert.equal(p.applied_at_ms, 1_000_000);
    assert.equal(p.title, 'hello world');
    assert.equal(p.created_at_ms, 1_000_000);
    assert.ok(Array.isArray(p.messages));
  });

  it('appendConversationMessages subsequent call omits title + created_at_ms', () => {
    appendConversationMessages(sqlite, 'conv-B', [userMsg('first')], 1_000);
    appendConversationMessages(sqlite, 'conv-B', [userMsg('second')], 2_000);
    const rows = readChanges(sqlite);
    assert.equal(rows.length, 2);
    const p2 = JSON.parse(rows[1].payload) as Record<string, unknown>;
    assert.equal(p2.applied_at_ms, 2_000);
    assert.equal(p2.title, undefined, 'title only on first emit');
    assert.equal(p2.created_at_ms, undefined, 'created_at_ms only on first emit');
  });

  it('deleteConversation emits conversation/delete with empty payload', () => {
    appendConversationMessages(sqlite, 'conv-C', [userMsg('x')], 100);
    clearAll(sqlite);
    sqlite
      .prepare(
        'INSERT INTO ai_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('conv-C', 't', 100, 100);

    deleteConversation(sqlite, 'conv-C');
    const row = lastChange(sqlite);
    assert.equal(row.entity_type, 'conversation');
    assert.equal(row.entity_id, 'conv-C');
    assert.equal(row.op, 'delete');
    assert.equal(row.payload, '{}');
  });

  it('deleteConversation on non-existent id emits NOTHING', () => {
    deleteConversation(sqlite, 'no-such-id');
    assert.equal(readChanges(sqlite).length, 0);
  });
});
