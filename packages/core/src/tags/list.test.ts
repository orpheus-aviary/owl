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
    const result = listHashtagTags(sqlite);
    assert.deepEqual(
      result.map((t) => t.value),
      ['alpha', 'beta', 'gamma'],
    );
    for (const t of result) assert.equal(t.count, undefined);
  });

  it('returns counts sorted desc when frequent=true', () => {
    const result = listHashtagTags(sqlite, { frequent: true });
    assert.equal(result.length, 3);
    assert.equal(result[0].value, 'alpha');
    assert.equal(result[0].count, 3);
    assert.equal(result[1].count, 1);
    assert.equal(result[2].count, 1);
  });

  it('filters trashed notes out of frequent counts and drops zero-count tags', () => {
    // Trash n3 → gamma (only on n3) should disappear; alpha drops from 3 → 2
    deleteNote(db, sqlite, n3.id, { autoDeleteDays: 30 });
    const result = listHashtagTags(sqlite, { frequent: true });
    assert.equal(
      result.find((r) => r.value === 'gamma'),
      undefined,
    );
    const alphaRow = result.find((r) => r.value === 'alpha');
    assert.ok(alphaRow);
    assert.equal(alphaRow.count, 2);
  });

  it('honors limit when frequent=true', () => {
    const result = listHashtagTags(sqlite, { frequent: true, limit: 1 });
    assert.equal(result.length, 1);
  });
});

// P5-c G6: default branch (no `frequent`) must also drop 0-note orphan tags.
// Previously the default branch did a raw `SELECT FROM tags WHERE tag_type='#'`
// which returned every tag row even if every note carrying that tag had been
// trashed / permanently deleted, polluting autocomplete with stale labels.
describe('listHashtagTags default branch drops 0-note tags (P5-c G6)', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  it('hides a tag when all notes carrying it are trashed', () => {
    const note = createNote(db, sqlite, {
      content: 'only-carrier-of-alpha',
      tags: [{ tagType: '#', tagValue: 'alpha' }],
    });
    let result = listHashtagTags(sqlite);
    assert.ok(
      result.some((t) => t.value === 'alpha'),
      'alpha visible while note is in trash_level 0',
    );

    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 });
    result = listHashtagTags(sqlite);
    assert.equal(
      result.find((t) => t.value === 'alpha'),
      undefined,
      'alpha dropped after the only carrying note is trashed',
    );
  });

  it('keeps a tag visible when at least one non-trashed note still carries it', () => {
    const keeper = createNote(db, sqlite, {
      content: 'keeper',
      tags: [{ tagType: '#', tagValue: 'beta' }],
    });
    const trashed = createNote(db, sqlite, {
      content: 'trashed',
      tags: [{ tagType: '#', tagValue: 'beta' }],
    });
    deleteNote(db, sqlite, trashed.id, { autoDeleteDays: 30 });
    const result = listHashtagTags(sqlite);
    assert.ok(
      result.some((t) => t.value === 'beta'),
      'beta still visible because keeper is not trashed',
    );
    // cleanup so later runs don't collide
    deleteNote(db, sqlite, keeper.id, { autoDeleteDays: 30 });
  });

  it('does not return /time or /alarm tags', () => {
    createNote(db, sqlite, {
      content: 'has-only-time-tag',
      tags: [{ tagType: '/time', tagValue: '2099-01-01T00:00:00' }],
    });
    const result = listHashtagTags(sqlite);
    assert.equal(
      result.find((t) => t.value === '2099-01-01T00:00:00'),
      undefined,
      'tag_type filter still in effect on the new JOIN-based query',
    );
  });
});
