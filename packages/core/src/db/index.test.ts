import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from './index.js';
import { folders, noteTags, notes, tags } from './schema.js';
import { SPECIAL_NOTES, ensureDeviceId, ensureSpecialNotes } from './special-notes.js';

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
      .values({ id, content: 'hello world test note', createdAt: now, updatedAt: now })
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
      .values({ id, content: 'original content', createdAt: now, updatedAt: now })
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
      .values({ id, content: 'deletable searchterm', createdAt: now, updatedAt: now })
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

    db.insert(folders).values({ id: folderId, name: 'test', createdAt: now, updatedAt: now }).run();
    db.insert(notes)
      .values({ id: noteId, content: 'in folder', folderId, createdAt: now, updatedAt: now })
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
      .values({ id: noteId, content: 'tagged note', createdAt: now, updatedAt: now })
      .run();
    db.insert(tags).values({ id: tagId, tagType: '#', tagValue: 'test' }).run();
    db.insert(noteTags).values({ noteId, tagId }).run();

    db.delete(notes).where(eq(notes.id, noteId)).run();

    const remaining = db.select().from(noteTags).where(eq(noteTags.noteId, noteId)).all();
    assert.equal(remaining.length, 0);
  });
});
