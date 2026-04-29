import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { backupDatabase } from './backup.js';

describe('backupDatabase', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-backup-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('copies a consistent snapshot to targetPath', async () => {
    const src = join(tmp, 'src.db');
    const dst = join(tmp, 'dst.db');
    const sqlite = new BetterSqlite3(src);
    try {
      sqlite.prepare('CREATE TABLE t (x INTEGER)').run();
      sqlite.prepare('INSERT INTO t VALUES (?)').run(1);
      sqlite.prepare('INSERT INTO t VALUES (?)').run(2);

      await backupDatabase(sqlite, dst);

      assert.ok(existsSync(dst), 'backup file should exist');
      const size = statSync(dst).size;
      assert.ok(size > 0, 'backup file should be non-empty');
    } finally {
      sqlite.close();
    }

    const copy = new BetterSqlite3(dst, { readonly: true });
    try {
      const rows = copy.prepare('SELECT x FROM t ORDER BY x').all() as { x: number }[];
      assert.deepEqual(
        rows.map((r) => r.x),
        [1, 2],
      );
    } finally {
      copy.close();
    }
  });

  it('leaves source database intact after backup', async () => {
    const src = join(tmp, 'src2.db');
    const dst = join(tmp, 'dst2.db');
    const sqlite = new BetterSqlite3(src);
    try {
      sqlite.prepare('CREATE TABLE t (x INTEGER)').run();
      sqlite.prepare('INSERT INTO t VALUES (?)').run(42);

      await backupDatabase(sqlite, dst);

      // Source still works and is unchanged.
      const row = sqlite.prepare('SELECT x FROM t').get() as { x: number };
      assert.equal(row.x, 42);

      // Source should still be writable (no lock held).
      sqlite.prepare('INSERT INTO t VALUES (?)').run(99);
      const count = (sqlite.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n;
      assert.equal(count, 2);
    } finally {
      sqlite.close();
    }
  });
});
