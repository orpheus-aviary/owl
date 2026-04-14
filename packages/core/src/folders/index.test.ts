import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import type { OwlDatabase } from '../db/index.js';
import { createNote, listNotes } from '../notes/index.js';
import {
  createFolder,
  deleteFolder,
  getFolder,
  getFolderSubtreeIds,
  listFolders,
  reorderFolders,
  updateFolder,
} from './index.js';

describe('folders CRUD', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  after(() => {
    sqlite.close();
  });

  it('creates a root folder with auto-incremented position', () => {
    const a = createFolder(db, { name: 'Work' });
    const b = createFolder(db, { name: 'Personal' });
    assert.equal(a.parentId, null);
    assert.equal(a.position, 0);
    assert.equal(b.position, 1);
  });

  it('creates child folders and lists them', () => {
    const parent = createFolder(db, { name: 'Projects' });
    const c1 = createFolder(db, { name: 'Owl', parentId: parent.id });
    const c2 = createFolder(db, { name: 'Lark', parentId: parent.id });
    assert.equal(c1.parentId, parent.id);
    assert.equal(c1.position, 0);
    assert.equal(c2.position, 1);

    const all = listFolders(db);
    assert.ok(all.some((f) => f.id === parent.id));
    assert.ok(all.some((f) => f.id === c1.id));
  });

  it('updates folder name', () => {
    const f = createFolder(db, { name: 'Old' });
    const updated = updateFolder(db, f.id, { name: 'New' });
    assert.equal(updated?.name, 'New');
  });

  it('refuses to move folder into itself or its descendants', () => {
    const p = createFolder(db, { name: 'P' });
    const c = createFolder(db, { name: 'C', parentId: p.id });
    const gc = createFolder(db, { name: 'GC', parentId: c.id });
    assert.throws(() => updateFolder(db, p.id, { parentId: p.id }));
    assert.throws(() => updateFolder(db, p.id, { parentId: c.id }));
    assert.throws(() => updateFolder(db, p.id, { parentId: gc.id }));
  });

  it('deleteFolder promotes children to grandparent', () => {
    const root = createFolder(db, { name: 'Root' });
    const mid = createFolder(db, { name: 'Mid', parentId: root.id });
    const leaf = createFolder(db, { name: 'Leaf', parentId: mid.id });

    const deleted = deleteFolder(db, mid.id);
    assert.equal(deleted, true);
    const reloaded = getFolder(db, leaf.id);
    assert.equal(reloaded?.parentId, root.id);
  });

  it('deleteFolder resets note folder_id to null', () => {
    const f = createFolder(db, { name: 'Temp' });
    const note = createNote(db, sqlite, { content: 'tagged', folderId: f.id });
    deleteFolder(db, f.id);
    const result = listNotes(db, sqlite, { folderId: null });
    assert.ok(result.items.some((n) => n.id === note.id));
  });

  it('reorderFolders updates positions and parent in one transaction', () => {
    const a = createFolder(db, { name: 'A' });
    const b = createFolder(db, { name: 'B' });
    const count = reorderFolders(db, sqlite, [
      { id: a.id, parentId: null, position: 10 },
      { id: b.id, parentId: null, position: 11 },
    ]);
    assert.equal(count, 2);
    assert.equal(getFolder(db, a.id)?.position, 10);
    assert.equal(getFolder(db, b.id)?.position, 11);
  });

  it('getFolderSubtreeIds returns self + all descendants', () => {
    const r = createFolder(db, { name: 'R' });
    const c1 = createFolder(db, { name: 'C1', parentId: r.id });
    const c2 = createFolder(db, { name: 'C2', parentId: r.id });
    const gc = createFolder(db, { name: 'GC', parentId: c1.id });
    const ids = new Set(getFolderSubtreeIds(sqlite, r.id));
    assert.ok(ids.has(r.id));
    assert.ok(ids.has(c1.id));
    assert.ok(ids.has(c2.id));
    assert.ok(ids.has(gc.id));
  });
});

describe('listNotes with include_descendants', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  after(() => {
    sqlite.close();
  });

  it('default true: folder query returns notes from descendants', () => {
    const parent = createFolder(db, { name: 'Parent' });
    const child = createFolder(db, { name: 'Child', parentId: parent.id });

    createNote(db, sqlite, { content: 'in parent', folderId: parent.id });
    createNote(db, sqlite, { content: 'in child', folderId: child.id });

    const res = listNotes(db, sqlite, { folderId: parent.id });
    assert.equal(res.total, 2);
  });

  it('includeDescendants=false: exact folder match only', () => {
    const parent = createFolder(db, { name: 'P2' });
    const child = createFolder(db, { name: 'C2', parentId: parent.id });

    createNote(db, sqlite, { content: 'p', folderId: parent.id });
    createNote(db, sqlite, { content: 'c', folderId: child.id });

    const res = listNotes(db, sqlite, { folderId: parent.id, includeDescendants: false });
    assert.equal(res.total, 1);
    assert.equal(res.items[0].content, 'p');
  });

  it('folderId=null still matches only unfiled notes', () => {
    createNote(db, sqlite, { content: 'unfiled' });
    const res = listNotes(db, sqlite, { folderId: null });
    assert.ok(res.items.some((n) => n.content === 'unfiled'));
    assert.ok(res.items.every((n) => n.folderId === null));
  });
});
