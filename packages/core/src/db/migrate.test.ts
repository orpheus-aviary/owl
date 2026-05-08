import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import {
  DestructiveForwardMigrationError,
  IncompatibleDbError,
  LATEST_KNOWN_VERSION,
  MigrationBusyError,
  MigrationRequiredError,
  SchemaMismatchError,
  SourceDbCorruptionError,
  createDatabase,
  migrateLegacyDb,
} from '../index.js';
import {
  applyForwardMigrations,
  assertNotDestructive,
  readInitialSql,
  resolveMigrationFile,
} from './migrate.js';

/**
 * Build a pre-v0.3 legacy database by hand: the DDL below matches what a
 * real v0.2 user has on disk (notes.auto_delete_at was an ALTER TABLE
 * addition, so it sits at the end of the column list).
 */
function seedLegacyV02Db(dbPath: string, opts: { withAutoDeleteAt?: boolean } = {}): void {
  const withAutoDeleteAt = opts.withAutoDeleteAt ?? true;
  const sqlite = new BetterSqlite3(dbPath);
  const statements = [
    'CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT)',
    'CREATE TABLE notes (id TEXT PRIMARY KEY, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL, trash_level INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER, device_id TEXT, content_hash TEXT, content TEXT NOT NULL)',
    'CREATE TABLE tags (id TEXT PRIMARY KEY, tag_type TEXT NOT NULL, tag_value TEXT, UNIQUE(tag_type, tag_value))',
    'CREATE TABLE note_tags (note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id), PRIMARY KEY(note_id, tag_id))',
    'CREATE TABLE local_metadata (key TEXT PRIMARY KEY, value TEXT)',
    "CREATE TABLE reminder_status (note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id), fire_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', fired_at INTEGER, PRIMARY KEY(note_id, tag_id))",
  ];
  for (const s of statements) sqlite.prepare(s).run();
  if (withAutoDeleteAt) {
    sqlite.prepare('ALTER TABLE notes ADD COLUMN auto_delete_at INTEGER').run();
  }
  sqlite.close();
}

/** Add a richer test fixture on top of the bare schema. */
function seedRichLegacyData(dbPath: string): void {
  const sqlite = new BetterSqlite3(dbPath);
  sqlite.pragma('foreign_keys = ON');
  sqlite
    .prepare(
      'INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, device_id) VALUES (?, ?, NULL, 0, ?, ?, NULL)',
    )
    .run('f1', 'Inbox', 1700000000000, 1700000000000);

  sqlite
    .prepare("INSERT INTO tags (id, tag_type, tag_value) VALUES (?, '#', ?)")
    .run('tag-hash', 'important');
  sqlite
    .prepare("INSERT INTO tags (id, tag_type, tag_value) VALUES (?, '/time:', ?)")
    .run('tag-time', '2026-01-01 09:00:00');
  sqlite
    .prepare("INSERT INTO tags (id, tag_type, tag_value) VALUES (?, '/alarm:', ?)")
    .run('tag-alarm', '2026-05-01');

  sqlite
    .prepare(
      'INSERT INTO notes (id, folder_id, trash_level, created_at, updated_at, trashed_at, device_id, content_hash, content, auto_delete_at) VALUES (?, ?, 0, ?, ?, NULL, NULL, NULL, ?, NULL)',
    )
    .run('note-1', 'f1', 1700000000000, 1700000000000, 'hello world searchable');
  sqlite
    .prepare(
      'INSERT INTO notes (id, folder_id, trash_level, created_at, updated_at, trashed_at, device_id, content_hash, content, auto_delete_at) VALUES (?, NULL, 0, ?, ?, NULL, NULL, NULL, ?, NULL)',
    )
    .run('note-2', 1700000000000, 1700000000000, 'second note with distinctword');

  const link = sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)');
  link.run('note-1', 'tag-hash');
  link.run('note-1', 'tag-time');
  link.run('note-2', 'tag-hash');
  sqlite.close();
}

function countBackupFiles(dir: string, dbName: string): number {
  return readdirSync(dir).filter((f) => f.startsWith(`${dbName}.v0.2-backup-`)).length;
}

describe('migrate — createDatabase dispatch', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-migrate-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // T1: empty file (missing on disk) → 0001 applied, user_version stamped
  it('T1: initializes empty db to LATEST_KNOWN_VERSION', () => {
    const dbPath = join(tmp, 't1.db');
    const { sqlite } = createDatabase({ dbPath });
    try {
      const v = sqlite.pragma('user_version', { simple: true }) as number;
      assert.equal(v, LATEST_KNOWN_VERSION);

      const tables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((r) => (r as { name: string }).name);
      for (const t of [
        'folders',
        'notes',
        'tags',
        'note_tags',
        'local_metadata',
        'reminder_status',
      ]) {
        assert.ok(tables.includes(t), `missing table ${t}`);
      }
      const hasFts = sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes_fts'")
        .get();
      assert.ok(hasFts);
    } finally {
      sqlite.close();
    }
  });

  // T2: reopen an already-initialized db → no change, user_version stays 1
  it('T2: reopens v=LATEST db without re-running 0001', () => {
    const dbPath = join(tmp, 't2.db');
    {
      const { sqlite } = createDatabase({ dbPath });
      sqlite.close();
    }
    {
      const { sqlite } = createDatabase({ dbPath });
      try {
        const v = sqlite.pragma('user_version', { simple: true }) as number;
        assert.equal(v, LATEST_KNOWN_VERSION);
      } finally {
        sqlite.close();
      }
    }
  });

  // T3: v=0 + non-empty schema → MigrationRequiredError
  it('T3: throws MigrationRequiredError on pre-v0.3 legacy db', () => {
    const dbPath = join(tmp, 't3.db');
    seedLegacyV02Db(dbPath);

    assert.throws(
      () => createDatabase({ dbPath }),
      (err: unknown) => {
        assert.ok(err instanceof MigrationRequiredError, 'wrong error type');
        assert.equal(err.dbPath, dbPath);
        assert.equal(err.currentVersion, 0);
        return true;
      },
    );
  });

  // T4: v > LATEST_KNOWN_VERSION → IncompatibleDbError
  it('T4: throws IncompatibleDbError on future-version db', () => {
    const dbPath = join(tmp, 't4.db');
    {
      const sqlite = new BetterSqlite3(dbPath);
      sqlite.prepare('CREATE TABLE dummy (x INTEGER)').run();
      sqlite.pragma(`user_version = ${LATEST_KNOWN_VERSION + 1}`);
      sqlite.close();
    }

    assert.throws(
      () => createDatabase({ dbPath }),
      (err: unknown) => {
        assert.ok(err instanceof IncompatibleDbError, 'wrong error type');
        assert.equal(err.dbVersion, LATEST_KNOWN_VERSION + 1);
        assert.equal(err.maxSupported, LATEST_KNOWN_VERSION);
        return true;
      },
    );
  });
});

describe('migrate — migrateLegacyDb happy path', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-migrate-happy-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // T5: rebuild happy path — verify count, backup, user_version, row contents,
  // FTS content + tag MATCH, clean-up of intermediate files.
  it('T5: rebuilds a legacy db end to end', async () => {
    const dbPath = join(tmp, 't5.db');
    seedLegacyV02Db(dbPath);
    seedRichLegacyData(dbPath);

    const result = await migrateLegacyDb(dbPath);

    assert.equal(result.notesCount, 2);
    assert.ok(result.elapsedMs >= 0);
    assert.ok(existsSync(result.backupPath), 'backup file should exist');
    assert.ok(!result.alreadyMigrated);

    // No leftover intermediate files
    assert.ok(!existsSync(`${dbPath}.new`), '.new should be cleaned');
    assert.ok(!existsSync(`${dbPath}.old-pre-v0.3`), '.old-pre-v0.3 should be cleaned');
    assert.ok(!existsSync(`${dbPath}.migrate.lock`), '.migrate.lock should be cleaned');

    // Open the new db and verify schema + contents
    const { sqlite } = createDatabase({ dbPath });
    try {
      assert.equal(sqlite.pragma('user_version', { simple: true }) as number, LATEST_KNOWN_VERSION);
      assert.equal((sqlite.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n, 2);
      assert.equal(
        (sqlite.prepare('SELECT count(*) AS n FROM folders').get() as { n: number }).n,
        1,
      );
      assert.equal((sqlite.prepare('SELECT count(*) AS n FROM tags').get() as { n: number }).n, 3);
      assert.equal(
        (sqlite.prepare('SELECT count(*) AS n FROM note_tags').get() as { n: number }).n,
        3,
      );

      // FTS content MATCH
      const contentHit = sqlite
        .prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'hello'")
        .all();
      assert.equal(contentHit.length, 1, 'FTS content match should find note-1');

      // FTS tag MATCH — only # tags are in tags_text
      const tagHit = sqlite
        .prepare("SELECT rowid FROM notes_fts WHERE tags_text MATCH 'important'")
        .all();
      assert.equal(tagHit.length, 2, 'both notes have the # tag');

      // /time: and /alarm: tags MUST NOT appear in tags_text (only # tags)
      const timeHit = sqlite
        .prepare("SELECT rowid FROM notes_fts WHERE tags_text MATCH '2026'")
        .all();
      assert.equal(timeHit.length, 0, '/time: and /alarm: values must not leak into tags_text');
    } finally {
      sqlite.close();
    }
  });

  // T10: source db lacking notes.auto_delete_at — rebuild fills with NULL
  it('T10: tolerates legacy schema without notes.auto_delete_at', async () => {
    const dbPath = join(tmp, 't10.db');
    seedLegacyV02Db(dbPath, { withAutoDeleteAt: false });

    // Drop in a single note (without auto_delete_at column)
    const seed = new BetterSqlite3(dbPath);
    seed
      .prepare(
        'INSERT INTO notes (id, trash_level, created_at, updated_at, content) VALUES (?, 0, ?, ?, ?)',
      )
      .run('n1', 1700000000000, 1700000000000, 'content');
    seed.close();

    const result = await migrateLegacyDb(dbPath);
    assert.equal(result.notesCount, 1);

    const { sqlite } = createDatabase({ dbPath });
    try {
      const row = sqlite.prepare('SELECT auto_delete_at FROM notes WHERE id = ?').get('n1') as {
        auto_delete_at: number | null;
      };
      assert.equal(row.auto_delete_at, null);
    } finally {
      sqlite.close();
    }
  });

  // T15: idempotent — calling on an already-migrated db returns alreadyMigrated
  // and produces no extra backup
  it('T15: is idempotent on already-migrated db (no extra backup, no extra work)', async () => {
    const dbPath = join(tmp, 't15.db');
    seedLegacyV02Db(dbPath);
    seedRichLegacyData(dbPath);

    const first = await migrateLegacyDb(dbPath);
    assert.ok(!first.alreadyMigrated);
    const backupCountAfterFirst = countBackupFiles(tmp, 't15.db');
    assert.equal(backupCountAfterFirst, 1);

    const second = await migrateLegacyDb(dbPath);
    assert.equal(second.alreadyMigrated, true);
    assert.equal(second.notesCount, 2);
    assert.equal(countBackupFiles(tmp, 't15.db'), 1, 'no new backup should be created');

    // Artifacts still clean
    assert.ok(!existsSync(`${dbPath}.new`));
    assert.ok(!existsSync(`${dbPath}.old-pre-v0.3`));
    assert.ok(!existsSync(`${dbPath}.migrate.lock`));
  });

  // T16: onProgress emits 4 phases in strict order during happy path rebuild
  it('T16: emits backup → copy → fts-rebuild → swap in order', async () => {
    const dbPath = join(tmp, 't16.db');
    seedLegacyV02Db(dbPath);
    seedRichLegacyData(dbPath);

    const phases: string[] = [];
    const result = await migrateLegacyDb(dbPath, {
      onProgress: (phase) => phases.push(phase),
    });

    assert.ok(!result.alreadyMigrated);
    assert.deepStrictEqual(phases, ['backup', 'copy', 'fts-rebuild', 'swap']);
  });

  // T17: alreadyMigrated short-circuit emits no phases
  it('T17: already-migrated short-circuit does not emit phases', async () => {
    const dbPath = join(tmp, 't17.db');
    seedLegacyV02Db(dbPath);
    seedRichLegacyData(dbPath);

    // First run migrates; don't observe phases here.
    await migrateLegacyDb(dbPath);

    // Second run should short-circuit to alreadyMigrated and skip emits.
    const phases: string[] = [];
    const result = await migrateLegacyDb(dbPath, {
      onProgress: (phase) => phases.push(phase),
    });
    assert.equal(result.alreadyMigrated, true);
    assert.deepStrictEqual(phases, []);
  });
});

describe('migrate — lock layers and error paths', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-migrate-errs-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // T7: daemon.pid present + process alive (use our own pid) → daemon_alive
  it('T7: refuses migration when daemon.pid points to a live process', async () => {
    const subdir = mkdtempSync(join(tmp, 't7-'));
    const dbPath = join(subdir, 'owl.db');
    seedLegacyV02Db(dbPath);
    seedRichLegacyData(dbPath);

    const pidPath = join(subdir, 'daemon.pid');
    writeFileSync(pidPath, String(process.pid));

    try {
      await assertRejects(
        () => migrateLegacyDb(dbPath),
        (err: unknown) => {
          assert.ok(err instanceof MigrationBusyError);
          assert.equal(err.reason, 'daemon_alive');
          return true;
        },
      );
    } finally {
      if (existsSync(pidPath)) rmSync(pidPath);
    }
  });

  // T8: pre-existing .migrate.lock → lock_file
  it('T8: refuses migration when migrate.lock already exists', async () => {
    const subdir = mkdtempSync(join(tmp, 't8-'));
    const dbPath = join(subdir, 'owl.db');
    seedLegacyV02Db(dbPath);
    seedRichLegacyData(dbPath);

    const lockPath = `${dbPath}.migrate.lock`;
    writeFileSync(lockPath, '99999');

    await assertRejects(
      () => migrateLegacyDb(dbPath),
      (err: unknown) => {
        assert.ok(err instanceof MigrationBusyError);
        assert.equal(err.reason, 'lock_file');
        return true;
      },
    );

    // Lock file was pre-existing; our code must not delete it on EEXIST path.
    assert.ok(existsSync(lockPath), 'pre-existing lock file should be preserved');
    rmSync(lockPath);
  });

  // T9: external connection holding SHARED lock blocks EXCLUSIVE upgrade
  it('T9: throws exclusive_lock_busy when another connection holds the db', async () => {
    const subdir = mkdtempSync(join(tmp, 't9-'));
    const dbPath = join(subdir, 'owl.db');
    seedLegacyV02Db(dbPath);
    seedRichLegacyData(dbPath);

    // Bring up an outside connection and grab a write transaction so the
    // source is genuinely locked (WAL: a reader alone doesn't stop a SHARED →
    // EXCLUSIVE upgrade; an active BEGIN EXCLUSIVE does).
    const outside = new BetterSqlite3(dbPath);
    try {
      outside.pragma('journal_mode = WAL');
      outside.exec('BEGIN EXCLUSIVE');
      outside.prepare('SELECT count(*) FROM sqlite_master').get();

      await assertRejects(
        () => migrateLegacyDb(dbPath),
        (err: unknown) => {
          assert.ok(
            err instanceof MigrationBusyError,
            `expected MigrationBusyError, got ${err instanceof Error ? err.message : String(err)}`,
          );
          assert.equal(
            (err as MigrationBusyError).reason,
            'exclusive_lock_busy',
            `wrong reason: ${(err as MigrationBusyError).reason}`,
          );
          return true;
        },
      );
    } finally {
      try {
        outside.exec('ROLLBACK');
      } catch {
        /* best-effort */
      }
      outside.close();
    }
  });

  // T11: source db has an orphaned FK → SourceDbCorruptionError + hard asserts
  it('T11: pre-flights main.foreign_key_check and refuses corrupt source', async () => {
    const subdir = mkdtempSync(join(tmp, 't11-'));
    const dbPath = join(subdir, 'owl.db');
    seedLegacyV02Db(dbPath);
    seedRichLegacyData(dbPath);

    // Break FK: note_tags row pointing at a non-existent note. Turn FK off
    // so the planting INSERT itself doesn't fail (better-sqlite3 enables FK
    // by default); the migration runner still catches the orphan via
    // PRAGMA main.foreign_key_check.
    const poisoner = new BetterSqlite3(dbPath);
    poisoner.pragma('foreign_keys = OFF');
    poisoner
      .prepare("INSERT INTO tags (id, tag_type, tag_value) VALUES ('orphan-tag', '#', 'orphan')")
      .run();
    poisoner
      .prepare("INSERT INTO note_tags (note_id, tag_id) VALUES ('does-not-exist', 'orphan-tag')")
      .run();
    poisoner.close();

    await assertRejects(
      () => migrateLegacyDb(dbPath),
      (err: unknown) => {
        assert.ok(err instanceof SourceDbCorruptionError);
        assert.ok(err.violations >= 1);
        return true;
      },
    );

    // Hard asserts — intermediate artefacts cleaned, backup NOT created
    // (FK check fires before backup).
    assert.ok(!existsSync(`${dbPath}.new`));
    assert.ok(!existsSync(`${dbPath}.migrate.lock`));
    assert.ok(!existsSync(`${dbPath}.old-pre-v0.3`));
    assert.equal(readdirSync(subdir).filter((f) => f.includes('v0.2-backup-')).length, 0);

    // Source db is intact
    const src = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const v = src.pragma('user_version', { simple: true }) as number;
      assert.equal(v, 0);
      const n = (src.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n;
      assert.equal(n, 2);
    } finally {
      src.close();
    }
  });

  // T13: Phase B failure after backup — hard asserts + retry path
  it('T13: rolls back cleanly when COPY violates dest constraints', async () => {
    const subdir = mkdtempSync(join(tmp, 't13-'));
    const dbPath = join(subdir, 'owl.db');

    // Custom seed: relaxed tags schema without NOT NULL on tag_type so we can
    // plant a row that fails the dest (0001) CHECK.
    const relaxed = new BetterSqlite3(dbPath);
    relaxed
      .prepare(
        'CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT)',
      )
      .run();
    relaxed
      .prepare(
        'CREATE TABLE notes (id TEXT PRIMARY KEY, folder_id TEXT, trash_level INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER, device_id TEXT, content_hash TEXT, content TEXT NOT NULL, auto_delete_at INTEGER)',
      )
      .run();
    relaxed.prepare('CREATE TABLE tags (id TEXT PRIMARY KEY, tag_type TEXT, tag_value TEXT)').run();
    relaxed
      .prepare(
        'CREATE TABLE note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY(note_id, tag_id))',
      )
      .run();
    relaxed.prepare('CREATE TABLE local_metadata (key TEXT PRIMARY KEY, value TEXT)').run();
    relaxed
      .prepare(
        "CREATE TABLE reminder_status (note_id TEXT NOT NULL, tag_id TEXT NOT NULL, fire_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', fired_at INTEGER, PRIMARY KEY(note_id, tag_id))",
      )
      .run();
    relaxed
      .prepare(
        'INSERT INTO notes (id, trash_level, created_at, updated_at, content) VALUES (?, 0, ?, ?, ?)',
      )
      .run('n1', 1700000000000, 1700000000000, 'content');
    // Bad row: NULL tag_type — source allows it, dest schema says NOT NULL.
    relaxed
      .prepare('INSERT INTO tags (id, tag_type, tag_value) VALUES (?, NULL, ?)')
      .run('bad-tag', 'oops');
    relaxed.close();

    await assertRejects(
      () => migrateLegacyDb(dbPath),
      (err: unknown) => err instanceof Error,
    );

    // Hard asserts — everything cleaned except backup (kept for debugging).
    assert.ok(!existsSync(`${dbPath}.new`), '.new leftover');
    assert.ok(!existsSync(`${dbPath}.migrate.lock`), '.migrate.lock leftover');
    assert.ok(!existsSync(`${dbPath}.old-pre-v0.3`), '.old-pre-v0.3 leftover');
    const backupsAfter = readdirSync(subdir).filter((f) => f.includes('v0.2-backup-'));
    assert.equal(backupsAfter.length, 1, 'backup should be retained for diagnostics');

    // Source db still intact
    const src = new BetterSqlite3(dbPath, { readonly: true });
    try {
      assert.equal(src.pragma('user_version', { simple: true }) as number, 0);
      assert.equal((src.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n, 1);
    } finally {
      src.close();
    }

    // Retry after fixing source — should succeed with a fresh backup.
    const fix = new BetterSqlite3(dbPath);
    fix.prepare("DELETE FROM tags WHERE id = 'bad-tag'").run();
    fix.close();

    // Sleep 2 ms so the new backup ts differs from the first.
    await new Promise((r) => setTimeout(r, 2));
    const retry = await migrateLegacyDb(dbPath);
    assert.equal(retry.notesCount, 1);
    assert.ok(!retry.alreadyMigrated);
    const backupsFinal = readdirSync(subdir).filter((f) => f.includes('v0.2-backup-'));
    assert.equal(backupsFinal.length, 2, 'retry should emit a distinct backup file');
  });

  // T14: source missing a required column → SchemaMismatchError (pre-backup)
  it('T14: rejects source missing required column', async () => {
    const subdir = mkdtempSync(join(tmp, 't14-'));
    const dbPath = join(subdir, 'owl.db');

    // Build a source where notes table lacks `content` entirely.
    const db = new BetterSqlite3(dbPath);
    db.prepare(
      'CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT)',
    ).run();
    // Missing `content` column on purpose
    db.prepare(
      'CREATE TABLE notes (id TEXT PRIMARY KEY, folder_id TEXT, trash_level INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER, device_id TEXT, content_hash TEXT)',
    ).run();
    db.prepare(
      'CREATE TABLE tags (id TEXT PRIMARY KEY, tag_type TEXT NOT NULL, tag_value TEXT)',
    ).run();
    db.prepare(
      'CREATE TABLE note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY(note_id, tag_id))',
    ).run();
    db.prepare('CREATE TABLE local_metadata (key TEXT PRIMARY KEY, value TEXT)').run();
    db.prepare(
      "CREATE TABLE reminder_status (note_id TEXT NOT NULL, tag_id TEXT NOT NULL, fire_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', fired_at INTEGER, PRIMARY KEY(note_id, tag_id))",
    ).run();
    db.close();

    await assertRejects(
      () => migrateLegacyDb(dbPath),
      (err: unknown) => {
        assert.ok(err instanceof SchemaMismatchError);
        assert.match(err.details, /notes/);
        assert.match(err.details, /content/);
        return true;
      },
    );

    // Backup NOT created — column check runs before the backup step.
    assert.equal(readdirSync(subdir).filter((f) => f.includes('v0.2-backup-')).length, 0);
    assert.ok(!existsSync(`${dbPath}.new`));
    assert.ok(!existsSync(`${dbPath}.migrate.lock`));
    assert.ok(!existsSync(`${dbPath}.old-pre-v0.3`));
  });
});

/**
 * Minimal async assertRejects helper. `node:assert` has `rejects` but no
 * combined predicate-on-error form that preserves a useful failure message.
 */
async function assertRejects(
  fn: () => Promise<unknown>,
  predicate: (err: unknown) => boolean,
): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(predicate(err), 'error did not match predicate');
  }
  assert.ok(threw, 'expected promise to reject');
}

describe('migrate — FTS rebuild integrity and Phase C rollback', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-migrate-fts-swap-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // T12: no duplicate postings — docsize row count must equal notes count.
  // If delete-all had been skipped, each rowid would have TWO postings (one
  // from the INSERT trigger with empty tags_text, one from set-based rebuild
  // with real tags_text).
  it('T12: each note has exactly one FTS posting after rebuild', async () => {
    const dbPath = join(tmp, 't12.db');
    seedLegacyV02Db(dbPath);
    seedRichLegacyData(dbPath);

    const result = await migrateLegacyDb(dbPath);
    assert.equal(result.notesCount, 2);

    const { sqlite } = createDatabase({ dbPath });
    try {
      const docsize = sqlite.prepare('SELECT count(*) AS n FROM notes_fts_docsize').get() as {
        n: number;
      };
      assert.equal(docsize.n, 2, 'one docsize row per note; higher = duplicate posting');

      const perRowid = sqlite
        .prepare('SELECT id, count(*) AS c FROM notes_fts_docsize GROUP BY id ORDER BY id')
        .all() as Array<{ id: number; c: number }>;
      for (const row of perRowid) {
        assert.equal(row.c, 1, `rowid ${row.id} has ${row.c} postings (expected 1)`);
      }

      // Sanity: tag search still returns 2 notes (both carry #important).
      const tagHit = sqlite
        .prepare("SELECT count(*) AS n FROM notes_fts WHERE tags_text MATCH 'important'")
        .get() as { n: number };
      assert.equal(tagHit.n, 2);
    } finally {
      sqlite.close();
    }
  });

  // T6: Phase C rename fails — original db restored / safe, intermediate
  // artefacts cleaned, backup retained. We trigger the failure by planting a
  // non-empty directory at the pre-swap path so `renameSync(dbPath,
  // preSwapPath)` fails with EISDIR/ENOTEMPTY. The specific failure point is
  // Phase C step 9a rather than 9c, but the cleanup invariants exercised are
  // the same — Phase C's try/catch either rolls the rename back or leaves
  // dbPath untouched, and the outer finally removes `.new` and the lock.
  it('T6: Phase C rename failure leaves source db intact and cleans up', async () => {
    const dbPath = join(tmp, 't6.db');
    seedLegacyV02Db(dbPath);
    seedRichLegacyData(dbPath);

    // Plant obstacle: non-empty directory where step 9a wants to write.
    const preSwapPath = `${dbPath}.old-pre-v0.3`;
    mkdirSync(preSwapPath);
    writeFileSync(join(preSwapPath, 'garbage'), 'obstacle');

    await assertRejects(
      () => migrateLegacyDb(dbPath),
      (err: unknown) => err instanceof Error,
    );

    // Hard asserts
    assert.ok(!existsSync(`${dbPath}.new`), '.new leftover');
    assert.ok(!existsSync(`${dbPath}.migrate.lock`), '.migrate.lock leftover');
    const backups = readdirSync(tmp).filter((f) => f.startsWith('t6.db.v0.2-backup-'));
    assert.equal(backups.length, 1, 'backup should be retained for diagnostics');

    // Source db intact: still legacy (user_version=0), 2 notes.
    const src = new BetterSqlite3(dbPath, { readonly: true });
    try {
      assert.equal(src.pragma('user_version', { simple: true }) as number, 0);
      assert.equal((src.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n, 2);
    } finally {
      src.close();
    }

    // Remove the obstacle and retry — should migrate cleanly.
    rmSync(preSwapPath, { recursive: true, force: true });
    const retry = await migrateLegacyDb(dbPath);
    assert.equal(retry.notesCount, 2);
    assert.ok(!retry.alreadyMigrated);
  });
});

describe('migrate — applyForwardMigrations (P3.4-a)', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-fwdmigrate-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Regression防线 for the "new DB forgets forward migrations" bug fixed in
   * §3.1 of the P3.4-a design. Before the fix, applyInitialSchema stamped
   * LATEST_KNOWN_VERSION directly, so bumping LATEST=2 would leave fresh
   * installs with 0001-only schema but user_version=2.
   */
  it('F1: applyInitialSchema on fresh db → user_version=LATEST AND all forward columns present', () => {
    const dbPath = join(tmp, 'f1.db');
    const { sqlite } = createDatabase({ dbPath });
    try {
      const v = sqlite.pragma('user_version', { simple: true }) as number;
      assert.equal(v, LATEST_KNOWN_VERSION);
      const noteCols = (sqlite.pragma('table_info(notes)') as { name: string }[]).map(
        (c) => c.name,
      );
      assert.ok(noteCols.includes('pinned_at'), 'pinned_at column must exist');
      assert.ok(noteCols.includes('position'), 'position column must exist');
      const idx = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notes_folder_position'",
        )
        .get();
      assert.ok(idx, 'idx_notes_folder_position index must exist');
      // 0004 (P4 Phase 2) skybridge tables
      const skybridgeTables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_changes','sync_cursor','conflict_record')",
        )
        .all() as { name: string }[];
      assert.equal(
        skybridgeTables.length,
        3,
        '0004 must create sync_changes / sync_cursor / conflict_record',
      );
    } finally {
      sqlite.close();
    }
  });

  it('F2: v=1 db opened by createDatabase → forward migrations applied up to LATEST', () => {
    const dbPath = join(tmp, 'f2.db');
    // Seed a clean v=1 db: apply 0001 only (via readInitialSql, not applyInitialSchema),
    // stamp user_version=1. This is exactly how a 0.3.0 user's db looks on disk.
    {
      const sqlite = new BetterSqlite3(dbPath);
      try {
        sqlite.exec(readInitialSql());
        sqlite.pragma('user_version = 1');
      } finally {
        sqlite.close();
      }
    }
    const { sqlite } = createDatabase({ dbPath });
    try {
      assert.equal(sqlite.pragma('user_version', { simple: true }) as number, LATEST_KNOWN_VERSION);
      const noteCols = (sqlite.pragma('table_info(notes)') as { name: string }[]).map(
        (c) => c.name,
      );
      assert.ok(noteCols.includes('pinned_at'));
      assert.ok(noteCols.includes('position'));
    } finally {
      sqlite.close();
    }
  });

  it('F3: applyForwardMigrations(N, N) is a no-op on current db', () => {
    const dbPath = join(tmp, 'f3.db');
    const { sqlite } = createDatabase({ dbPath });
    try {
      const beforeCols = (sqlite.pragma('table_info(notes)') as { name: string }[]).length;
      applyForwardMigrations(sqlite, LATEST_KNOWN_VERSION, LATEST_KNOWN_VERSION);
      const afterCols = (sqlite.pragma('table_info(notes)') as { name: string }[]).length;
      assert.equal(beforeCols, afterCols);
      assert.equal(sqlite.pragma('user_version', { simple: true }) as number, LATEST_KNOWN_VERSION);
    } finally {
      sqlite.close();
    }
  });

  it('F4: partial forward migration persists earlier successes on later failure', () => {
    const dbPath = join(tmp, 'f4.db');
    // Seed a real v=1 db (0001 applied, stamped 1)
    {
      const sqlite = new BetterSqlite3(dbPath);
      try {
        sqlite.exec(readInitialSql());
        sqlite.pragma('user_version = 1');
      } finally {
        sqlite.close();
      }
    }
    // Walk 1→LATEST+1: v=2 + v=3 exist and apply cleanly; v=LATEST+1 file
    // missing → throws. Partial progress is preserved, user_version stays
    // at LATEST. Target = LATEST+1 so the "file missing" premise stays
    // true as we ship more migrations.
    const missing = LATEST_KNOWN_VERSION + 1;
    const sqlite = new BetterSqlite3(dbPath);
    try {
      assert.throws(
        () => applyForwardMigrations(sqlite, 1, missing),
        new RegExp(`No migration file found for v${missing}`),
      );
      assert.equal(sqlite.pragma('user_version', { simple: true }) as number, LATEST_KNOWN_VERSION);
      const noteCols = (sqlite.pragma('table_info(notes)') as { name: string }[]).map(
        (c) => c.name,
      );
      assert.ok(noteCols.includes('pinned_at'));
      const AI_TABLE_QUERY =
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%'";
      const aiTables = sqlite.prepare(AI_TABLE_QUERY).all() as { name: string }[];
      assert.equal(aiTables.length, 2, 'ai_conversations + ai_messages created by 0003');
      // 0004 (P4 Phase 2) — must have run because LATEST_KNOWN_VERSION is at
      // least 4 and partial-progress preserves all earlier successes.
      const skyTables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_changes','sync_cursor','conflict_record')",
        )
        .all() as { name: string }[];
      assert.equal(
        skyTables.length,
        3,
        'sync_changes + sync_cursor + conflict_record created by 0004',
      );
    } finally {
      sqlite.close();
    }
  });

  it('F5: v > LATEST → createDatabase throws IncompatibleDbError', () => {
    const dbPath = join(tmp, 'f5.db');
    {
      const { sqlite } = createDatabase({ dbPath });
      sqlite.pragma('user_version = 99');
      sqlite.close();
    }
    assert.throws(
      () => createDatabase({ dbPath }),
      (err: Error) => err instanceof IncompatibleDbError,
    );
  });

  it('F6: resolveMigrationFile locates existing + rejects missing', () => {
    assert.ok(resolveMigrationFile(1).endsWith('0001_initial.sql'));
    assert.ok(resolveMigrationFile(2).endsWith('0002_sorting.sql'));
    assert.throws(() => resolveMigrationFile(99), /No migration file/);
  });

  it('F7: assertNotDestructive passes on 0002 but throws on marked fixture', () => {
    // Real 0002 has no marker
    assertNotDestructive(
      '-- 0002_sorting.sql\nALTER TABLE notes ADD COLUMN pinned_at INTEGER;',
      2,
      '/fake/0002_sorting.sql',
    );
    // Marked fixture raises
    const marked =
      '-- 0099_foo.sql\n-- requires_confirmation: true\nALTER TABLE x ADD COLUMN y INTEGER;';
    assert.throws(
      () => assertNotDestructive(marked, 99, '/fake/0099_foo.sql'),
      (err: Error) => err instanceof DestructiveForwardMigrationError,
    );
  });

  it('F8: rebuild path (migrateLegacyDb) ends at user_version=LATEST with forward columns', async () => {
    const dbPath = join(tmp, 'f8.db');
    seedLegacyV02Db(dbPath);

    const result = await migrateLegacyDb(dbPath);
    assert.ok(!result.alreadyMigrated);

    const sqlite = new BetterSqlite3(dbPath);
    try {
      assert.equal(sqlite.pragma('user_version', { simple: true }) as number, LATEST_KNOWN_VERSION);
      const noteCols = (sqlite.pragma('table_info(notes)') as { name: string }[]).map(
        (c) => c.name,
      );
      assert.ok(noteCols.includes('pinned_at'));
      assert.ok(noteCols.includes('position'));
    } finally {
      sqlite.close();
    }
  });
});
