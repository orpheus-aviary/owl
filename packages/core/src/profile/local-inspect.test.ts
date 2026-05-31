/**
 * Unit suite for `profile/local-inspect.ts` (P5-d Phase 16, D10b/B2/B8).
 *
 * Per-test temp nest via `OWL_NEST_DIR`; never touches the real nest. Seeds
 * the local db (`owl/owl.db`) through the real `createNote` so triggers /
 * outbox rows behave exactly as in production.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { localProfileDbPath, owlDir, profileDbPath } from '../config/paths.js';
import { type OwlDatabase, createDatabase } from '../db/index.js';
import { createNote } from '../notes/index.js';
import { copyLocalProfileDbInto, inspectLocalProfile } from './local-inspect.js';

const originalNestDir = process.env.OWL_NEST_DIR;
let nest: string;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'owl-local-inspect-'));
  process.env.OWL_NEST_DIR = nest;
  mkdirSync(owlDir(), { recursive: true });
});

afterEach(() => {
  if (originalNestDir === undefined) {
    // biome-ignore lint/performance/noDelete: assigning undefined stringifies to "undefined"
    delete process.env.OWL_NEST_DIR;
  } else {
    process.env.OWL_NEST_DIR = originalNestDir;
  }
  rmSync(nest, { recursive: true, force: true });
});

/** Open (creating) the local db, run `fn`, close. */
function withLocalDb(fn: (db: OwlDatabase, sqlite: BetterSqlite3.Database) => void): void {
  const { db, sqlite } = createDatabase({ dbPath: localProfileDbPath() });
  try {
    fn(db, sqlite);
  } finally {
    sqlite.close();
  }
}

describe('inspectLocalProfile', () => {
  it('no local db file → zeros', () => {
    const r = inspectLocalProfile();
    assert.deepEqual(r, { noteCount: 0, hasSyncTraces: false });
  });

  it('counts notes (trash_level < 2), no sync traces on a pure-local db', () => {
    withLocalDb((db, sqlite) => {
      createNote(db, sqlite, { content: 'one' });
      createNote(db, sqlite, { content: 'two' });
      createNote(db, sqlite, { content: 'three' });
    });
    const r = inspectLocalProfile();
    assert.equal(r.noteCount, 3);
    // Fresh notes have a sync_changes row with synced_at IS NULL → not a trace.
    assert.equal(r.hasSyncTraces, false);
  });

  it('excludes permanently-trashed notes (trash_level = 2)', () => {
    withLocalDb((db, sqlite) => {
      const keep = createNote(db, sqlite, { content: 'keep' });
      const gone = createNote(db, sqlite, { content: 'gone' });
      sqlite.prepare('UPDATE notes SET trash_level = 2 WHERE id = ?').run(gone.id);
      assert.ok(keep.id);
    });
    assert.equal(inspectLocalProfile().noteCount, 1);
  });

  it('hasSyncTraces=true when local_metadata carries a skybridge id (orphan)', () => {
    withLocalDb((_db, sqlite) => {
      sqlite
        .prepare("INSERT INTO local_metadata (key, value) VALUES ('skybridge_device_id', 'dev-x')")
        .run();
    });
    assert.equal(inspectLocalProfile().hasSyncTraces, true);
  });

  it('hasSyncTraces=true when a change is already pushed (synced_at NOT NULL)', () => {
    withLocalDb((db, sqlite) => {
      const n = createNote(db, sqlite, { content: 'pushed' });
      sqlite.prepare('UPDATE sync_changes SET synced_at = 123 WHERE entity_id = ?').run(n.id);
    });
    assert.equal(inspectLocalProfile().hasSyncTraces, true);
  });
});

describe('copyLocalProfileDbInto', () => {
  it('whole-db copy: target gets the notes, local left untouched', async () => {
    withLocalDb((db, sqlite) => {
      createNote(db, sqlite, { content: 'a' });
      createNote(db, sqlite, { content: 'b' });
    });

    const target = profileDbPath('a'.repeat(32));
    mkdirSync(join(target, '..'), { recursive: true });
    await copyLocalProfileDbInto(target);

    assert.ok(existsSync(target));
    const copy = new BetterSqlite3(target, { readonly: true });
    try {
      const row = copy.prepare('SELECT count(*) AS n FROM notes').get() as { n: number };
      assert.equal(row.n, 2);
    } finally {
      copy.close();
    }
    // Source untouched.
    assert.equal(inspectLocalProfile().noteCount, 2);
  });
});
