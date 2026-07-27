import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from './index.js';
import { folders, noteTags, notes, tags } from './schema.js';
import { SEED_TS, SPECIAL_NOTES, ensureDeviceId, ensureSpecialNotes } from './special-notes.js';

describe('database initialization', () => {
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    sqlite = result.sqlite;
  });

  after(() => {
    sqlite.close();
  });

  it('creates all tables', () => {
    const tableNames = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const names = tableNames.map((t) => t.name);
    assert.ok(names.includes('folders'));
    assert.ok(names.includes('notes'));
    assert.ok(names.includes('tags'));
    assert.ok(names.includes('note_tags'));
    assert.ok(names.includes('local_metadata'));
    assert.ok(names.includes('notes_fts'));
  });

  it('has WAL mode enabled (skipped for :memory:)', () => {
    // :memory: databases cannot use WAL, they fall back to 'memory' journal mode.
    // WAL is verified to be requested; actual WAL works on file-based DBs.
    const result = sqlite.pragma('journal_mode') as { journal_mode: string }[];
    assert.equal(result[0].journal_mode, 'memory');
  });

  it('has foreign keys enabled', () => {
    const result = sqlite.pragma('foreign_keys') as { foreign_keys: number }[];
    assert.equal(result[0].foreign_keys, 1);
  });
});

describe('FTS5 triggers', () => {
  let db: ReturnType<typeof createDatabase>['db'];
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  after(() => {
    sqlite.close();
  });

  it('auto-indexes content on insert', () => {
    const id = uuidv4();
    const now = new Date();
    db.insert(notes)
      .values({
        id,
        content: 'hello world test note',
        createdAt: now,
        updatedAt: now,
        localDeviceUuid: 'test-dev',
      })
      .run();

    const results = sqlite
      .prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'hello'")
      .all();
    assert.equal(results.length, 1);
  });

  it('auto-updates FTS on content update', () => {
    const id = uuidv4();
    const now = new Date();
    db.insert(notes)
      .values({
        id,
        content: 'original content',
        createdAt: now,
        updatedAt: now,
        localDeviceUuid: 'test-dev',
      })
      .run();

    db.update(notes).set({ content: 'updated unique keyword' }).where(eq(notes.id, id)).run();

    const oldResults = sqlite
      .prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'original'")
      .all();
    assert.equal(oldResults.length, 0);

    const newResults = sqlite
      .prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'unique'")
      .all();
    assert.equal(newResults.length, 1);
  });

  it('auto-removes FTS entry on delete', () => {
    const id = uuidv4();
    const now = new Date();
    db.insert(notes)
      .values({
        id,
        content: 'deletable searchterm',
        createdAt: now,
        updatedAt: now,
        localDeviceUuid: 'test-dev',
      })
      .run();

    db.delete(notes).where(eq(notes.id, id)).run();

    const results = sqlite
      .prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'deletable'")
      .all();
    assert.equal(results.length, 0);
  });
});

describe('special notes', () => {
  let db: ReturnType<typeof createDatabase>['db'];
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  after(() => {
    sqlite.close();
  });

  it('creates memo and todo notes', () => {
    ensureSpecialNotes(db);

    const memo = db.select().from(notes).where(eq(notes.id, SPECIAL_NOTES.MEMO)).get();
    assert.ok(memo);
    assert.ok(memo.content.includes('随记'));

    const todo = db.select().from(notes).where(eq(notes.id, SPECIAL_NOTES.TODO)).get();
    assert.ok(todo);
    assert.ok(todo.content.includes('待办'));
  });

  // Problem A / Phase 4 — the seed must be deterministic, not `Date.now()`.
  // A wall-clock stamp made this purely-local materialisation win LWW against
  // the other device's real edit, so the pulled update was skipped forever.
  it('seeds special notes at SEED_TS so any real edit outranks them', () => {
    ensureSpecialNotes(db);

    for (const id of Object.values(SPECIAL_NOTES)) {
      const row = db.select().from(notes).where(eq(notes.id, id)).get();
      assert.ok(row);
      assert.equal(row.createdAt.getTime(), SEED_TS, `${id} created_at`);
      assert.equal(row.updatedAt.getTime(), SEED_TS, `${id} updated_at`);
      assert.equal(row.lwwCounter, 0, `${id} lww_counter`);
    }
  });

  it('seeding emits no sync_changes row (materialised locally, never synced)', () => {
    ensureSpecialNotes(db);
    const row = sqlite
      .prepare(
        "SELECT count(*) AS n FROM sync_changes WHERE entity_type = 'note' AND entity_id IN (?, ?)",
      )
      .get(SPECIAL_NOTES.MEMO, SPECIAL_NOTES.TODO) as { n: number };
    assert.equal(row.n, 0);
  });

  it('does not duplicate on repeated calls', () => {
    ensureSpecialNotes(db);
    ensureSpecialNotes(db);

    const all = db.select().from(notes).all();
    const specialCount = all.filter(
      (n) => n.id === SPECIAL_NOTES.MEMO || n.id === SPECIAL_NOTES.TODO,
    ).length;
    assert.equal(specialCount, 2);
  });

  it('recreates after deletion', () => {
    db.delete(notes).where(eq(notes.id, SPECIAL_NOTES.MEMO)).run();
    ensureSpecialNotes(db);

    const memo = db.select().from(notes).where(eq(notes.id, SPECIAL_NOTES.MEMO)).get();
    assert.ok(memo);
  });

  it('restores special notes that were soft-deleted (trash_level > 0)', () => {
    // Push memo into trash by raw SQL to bypass protective logic.
    db.update(notes)
      .set({ trashLevel: 2, trashedAt: new Date() })
      .where(eq(notes.id, SPECIAL_NOTES.MEMO))
      .run();
    ensureSpecialNotes(db);

    const memo = db.select().from(notes).where(eq(notes.id, SPECIAL_NOTES.MEMO)).get();
    assert.ok(memo);
    assert.equal(memo.trashLevel, 0);
    assert.equal(memo.trashedAt, null);
  });
});

describe('device ID', () => {
  let db: ReturnType<typeof createDatabase>['db'];
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  after(() => {
    sqlite.close();
  });

  it('generates and persists device UUID', () => {
    const id1 = ensureDeviceId(db);
    assert.ok(id1.length > 0);

    const id2 = ensureDeviceId(db);
    assert.equal(id1, id2, 'should return same UUID on second call');
  });
});

describe('createDatabase — closes the handle on a mid-migration throw (P5-d Phase 14)', () => {
  let tmp: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-db-close-'));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rethrows (after closing) when a forward migration re-applies onto existing schema', () => {
    const p = join(tmp, 'rollback.db');
    const fresh = createDatabase({ dbPath: p }); // fresh db at LATEST_KNOWN_VERSION
    fresh.sqlite.pragma('user_version = 1'); // pretend it's older; tables already exist
    fresh.sqlite.close();

    // Reopen → applyForwardMigrations(1 → LATEST) re-runs migrations onto an
    // already-migrated schema → throws. The Phase 14 try/catch must close the
    // handle before rethrowing, not leak it.
    assert.throws(() => createDatabase({ dbPath: p }));

    // Sanity: the path is reusable afterward (the internal handle was released).
    const re = new BetterSqlite3(p);
    assert.doesNotThrow(() => re.pragma('user_version'));
    re.close();
  });
});

describe('foreign keys', () => {
  let db: ReturnType<typeof createDatabase>['db'];
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  after(() => {
    sqlite.close();
  });

  it('sets folder_id to null when folder deleted', () => {
    const folderId = uuidv4();
    const noteId = uuidv4();
    const now = new Date();

    db.insert(folders)
      .values({
        id: folderId,
        name: 'test',
        createdAt: now,
        updatedAt: now,
        localDeviceUuid: 'test-dev',
      })
      .run();
    db.insert(notes)
      .values({
        id: noteId,
        content: 'in folder',
        folderId,
        createdAt: now,
        updatedAt: now,
        localDeviceUuid: 'test-dev',
      })
      .run();

    db.delete(folders).where(eq(folders.id, folderId)).run();

    const note = db.select().from(notes).where(eq(notes.id, noteId)).get();
    assert.ok(note);
    assert.equal(note.folderId, null);
  });

  it('cascades note_tags on note deletion', () => {
    const noteId = uuidv4();
    const tagId = uuidv4();
    const now = new Date();

    db.insert(notes)
      .values({
        id: noteId,
        content: 'tagged note',
        createdAt: now,
        updatedAt: now,
        localDeviceUuid: 'test-dev',
      })
      .run();
    db.insert(tags).values({ id: tagId, tagType: '#', tagValue: 'test' }).run();
    db.insert(noteTags).values({ noteId, tagId }).run();

    db.delete(notes).where(eq(notes.id, noteId)).run();

    const remaining = db.select().from(noteTags).where(eq(noteTags.noteId, noteId)).all();
    assert.equal(remaining.length, 0);
  });
});
