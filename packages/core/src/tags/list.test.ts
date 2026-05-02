import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import type { OwlDatabase } from '../db/index.js';
import type { NoteWithTags } from '../notes/index.js';
import { createNote, deleteNote } from '../notes/index.js';
import { listHashtagTags } from './list.js';

describe('listHashtagTags', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;
  let n3: NoteWithTags;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;

    // Seed: hashtags with different counts + one /time tag that must NOT appear
    createNote(db, sqlite, {
      content: 'n1',
      tags: [
        { tagType: '#', tagValue: 'alpha' },
        { tagType: '#', tagValue: 'beta' },
        { tagType: '/time', tagValue: '2026-05-02T00:00:00' },
      ],
    });
    createNote(db, sqlite, {
      content: 'n2',
      tags: [{ tagType: '#', tagValue: 'alpha' }],
    });
    n3 = createNote(db, sqlite, {
      content: 'n3',
      tags: [
        { tagType: '#', tagValue: 'alpha' },
        { tagType: '#', tagValue: 'gamma' },
      ],
    });
  });

  it('returns only hashtag-type tags, sorted alphabetically without count by default', () => {
    const result = listHashtagTags(db, sqlite);
    assert.deepEqual(
      result.map((t) => t.value),
      ['alpha', 'beta', 'gamma'],
    );
    for (const t of result) assert.equal(t.count, undefined);
  });

  it('returns counts sorted desc when frequent=true', () => {
    const result = listHashtagTags(db, sqlite, { frequent: true });
    assert.equal(result.length, 3);
    assert.equal(result[0].value, 'alpha');
    assert.equal(result[0].count, 3);
    assert.equal(result[1].count, 1);
    assert.equal(result[2].count, 1);
  });

  it('filters trashed notes out of frequent counts and drops zero-count tags', () => {
    // Trash n3 → gamma (only on n3) should disappear; alpha drops from 3 → 2
    deleteNote(db, sqlite, n3.id, { autoDeleteDays: 30 });
    const result = listHashtagTags(db, sqlite, { frequent: true });
    assert.equal(
      result.find((r) => r.value === 'gamma'),
      undefined,
    );
    const alphaRow = result.find((r) => r.value === 'alpha');
    assert.ok(alphaRow);
    assert.equal(alphaRow.count, 2);
  });

  it('honors limit when frequent=true', () => {
    const result = listHashtagTags(db, sqlite, { frequent: true, limit: 1 });
    assert.equal(result.length, 1);
  });
});
