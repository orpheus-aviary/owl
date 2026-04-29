// Schema migration runner.
//
// Responsibilities:
//   - Own the baseline schema (0001_initial.sql) and future forward migrations
//     (0002_*.sql, 0003_*.sql, ...).
//   - Dispatch on PRAGMA user_version inside createDatabase() — see db/index.ts.
//   - Provide migrateLegacyDb() for the one-shot v0.2 -> v0.3 rebuild. This
//     function is transitional: 0.4.0 will delete it and assume all surviving
//     databases are at user_version >= 1.
//   - Export five structured error types so CLI / daemon / GUI can each render
//     appropriate UX without parsing message strings.
//
// ----- Relationship to @owl/daemon -----
// @owl/daemon depends on @owl/core for paths and createDatabase, so
// @owl/core cannot import from @owl/daemon without creating a cycle.
// probeDaemonPid() is therefore re-implemented here against a dbPath-derived
// pid location rather than importing daemon/pid.ts. The pid layout is by
// convention identical (dirname(dbPath)/daemon.pid === paths.pidPath()).
//
// ----- Forward migration skeleton status (0.4.0+) -----
// applyForwardMigrations() is a stub at 0.3.0 because there are no 0002+
// files yet. Before turning it on, the following decisions must be made
// (noted here so future-me / reviewers don't forget):
//   1. Per-file transaction wrapping: each *.sql should run inside its own
//      BEGIN/COMMIT so a mid-file failure rolls back cleanly and
//      user_version stays at the pre-file value.
//   2. user_version bookkeeping: the runner sets user_version = N after each
//      file succeeds. The .sql files themselves must NOT set user_version
//      (same convention as 0001_initial.sql).
//   3. Code migrations: if a future migration requires JS (content reparse /
//      backfill), extend the loader to also pick up NNNN_*.ts migration
//      modules with a default-exported function. Not implemented yet.
//   4. Destructive migrations: if any future migration is destructive (needs
//      user confirmation, like this one), the file header should carry a
//      `-- requires_confirmation: true` marker. Runner reads header, throws
//      MigrationRequiredError instead of silently applying.
//   5. Reuse the three-layer lock of migrateLegacyDb for destructive forward
//      migrations too — they have the same concurrency concerns.

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { backupDatabase } from './backup.js';

export const LATEST_KNOWN_VERSION = 1;

// ----- Errors ---------------------------------------------------------------

/**
 * Thrown when createDatabase sees user_version=0 on a non-empty database
 * (a pre-v0.3 legacy db that needs rebuild).
 */
export class MigrationRequiredError extends Error {
  readonly dbPath: string;
  readonly currentVersion: number;
  constructor(dbPath: string) {
    super(
      `Database at ${dbPath} requires migration to v${LATEST_KNOWN_VERSION}. Run \`just migrate\` or use the GUI migration prompt.`,
    );
    this.name = 'MigrationRequiredError';
    this.dbPath = dbPath;
    this.currentVersion = 0;
  }
}

/** user_version > LATEST_KNOWN_VERSION — the db was written by a newer build. */
export class IncompatibleDbError extends Error {
  readonly dbPath: string;
  readonly dbVersion: number;
  readonly maxSupported: number;
  constructor(dbPath: string, dbVersion: number) {
    super(
      `Database at ${dbPath} is at v${dbVersion}, but this build only supports up to v${LATEST_KNOWN_VERSION}. Please upgrade the application.`,
    );
    this.name = 'IncompatibleDbError';
    this.dbPath = dbPath;
    this.dbVersion = dbVersion;
    this.maxSupported = LATEST_KNOWN_VERSION;
  }
}

export type MigrationBusyReason =
  | 'daemon_alive'
  | 'lock_file'
  | 'exclusive_lock_busy'
  | 'checkpoint_busy'
  | 'begin_busy';

/** Another process is interacting with the db (daemon / parallel migrate / external sqlite tool). */
export class MigrationBusyError extends Error {
  readonly reason: MigrationBusyReason;
  constructor(reason: MigrationBusyReason, message: string) {
    super(message);
    this.name = 'MigrationBusyError';
    this.reason = reason;
  }
}

/** Source db has orphaned FK rows. Pre-flight check via main.foreign_key_check. */
export class SourceDbCorruptionError extends Error {
  readonly violations: number;
  constructor(violations: number) {
    super(`Source database has ${violations} foreign key violation(s); fix before migrating.`);
    this.name = 'SourceDbCorruptionError';
    this.violations = violations;
  }
}

/**
 * Source db schema doesn't match what the runner expects (e.g. a required
 * table/column is missing). Exception: notes.auto_delete_at being absent is
 * explicitly tolerated (the COPY projects NULL for it) — do NOT throw
 * SchemaMismatchError in that case.
 */
export class SchemaMismatchError extends Error {
  readonly dbPath: string;
  readonly details: string;
  constructor(dbPath: string, details: string) {
    super(`Schema mismatch at ${dbPath}: ${details}`);
    this.name = 'SchemaMismatchError';
    this.dbPath = dbPath;
    this.details = details;
  }
}

// ----- Public API ------------------------------------------------------------

export interface MigrateOptions {
  /**
   * Progress reporter reserved for the GUI MigrationDialog (P3.2-b). NOT
   * WIRED at 0.3.0 — accepting the parameter now so adding progress later
   * doesn't break any caller's signature. Implementations in 0.3.0 MUST NOT
   * call it; treat it as a sealed future hook.
   */
  onProgress?: (phase: 'backup' | 'copy' | 'fts-rebuild' | 'swap', pct?: number) => void;
}

export interface MigrateResult {
  backupPath: string;
  notesCount: number;
  elapsedMs: number;
  /** True if the db was already at LATEST_KNOWN_VERSION; nothing was done. */
  alreadyMigrated?: boolean;
}

// ----- SQL loading ----------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

export function readInitialSql(): string {
  return readFileSync(join(MIGRATIONS_DIR, '0001_initial.sql'), 'utf8');
}

// ----- Runner primitives ---------------------------------------------------

/** Apply 0001_initial.sql and stamp user_version = LATEST_KNOWN_VERSION. */
export function applyInitialSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(readInitialSql());
  sqlite.pragma(`user_version = ${LATEST_KNOWN_VERSION}`);
}

/**
 * Forward migration skeleton — walks 0002_*.sql, 0003_*.sql, ... in order and
 * applies files strictly greater than fromV up to and including toV.
 *
 * At 0.3.0 there are no files past 0001, so this function is effectively a
 * no-op. See file header for the TODO list that must be addressed before
 * enabling real forward migrations.
 */
export function applyForwardMigrations(
  _sqlite: BetterSqlite3.Database,
  _fromV: number,
  _toV: number,
): void {
  // Intentionally empty at 0.3.0. See header TODO list before implementing.
}

/** A database with no user tables (sqlite_* shadow tables are ignored). */
export function isSchemaEmpty(sqlite: BetterSqlite3.Database): boolean {
  const row = sqlite
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .get() as { n: number };
  return row.n === 0;
}

// ----- Daemon pid probing ---------------------------------------------------

/**
 * Read dirname(dbPath)/daemon.pid and return the pid iff the process is
 * actually alive. Stale pid files are removed.
 *
 * Duplicates daemon/pid.ts::readPid() by design — see file header on why
 * core can't import daemon.
 */
export function probeDaemonPid(dbPath: string): number | null {
  const pidPath = join(dirname(dbPath), 'daemon.pid');
  if (!existsSync(pidPath)) return null;
  const raw = readFileSync(pidPath, 'utf-8').trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    try {
      unlinkSync(pidPath);
    } catch {
      /* best-effort stale cleanup */
    }
    return null;
  }
}

// ----- Schema validation ----------------------------------------------------

/**
 * Minimum set of columns the source db must carry per table. `notes.auto_delete_at`
 * is intentionally excluded — absent column is tolerated (projected as NULL).
 */
const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  folders: ['id', 'name', 'parent_id', 'position', 'created_at', 'updated_at', 'device_id'],
  notes: [
    'id',
    'folder_id',
    'trash_level',
    'created_at',
    'updated_at',
    'trashed_at',
    'device_id',
    'content_hash',
    'content',
  ],
  tags: ['id', 'tag_type', 'tag_value'],
  note_tags: ['note_id', 'tag_id'],
  local_metadata: ['key', 'value'],
  reminder_status: ['note_id', 'tag_id', 'fire_at', 'status', 'fired_at'],
};

function verifyExpectedColumns(sqlite: BetterSqlite3.Database, dbPath: string): void {
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const info = sqlite.pragma(`table_info(${table})`) as { name: string }[];
    if (info.length === 0) {
      throw new SchemaMismatchError(dbPath, `table '${table}' is missing`);
    }
    const present = new Set(info.map((c) => c.name));
    for (const col of cols) {
      if (!present.has(col)) {
        throw new SchemaMismatchError(dbPath, `table '${table}' missing required column '${col}'`);
      }
    }
  }
}

// ----- migrateLegacyDb ------------------------------------------------------

/**
 * COPY template. `$AUTO` is replaced by either the column name or
 * `NULL AS auto_delete_at` depending on whether the source schema has it.
 * Statement order is FK-safe (parents before children).
 */
const COPY_TEMPLATE = [
  'INSERT INTO dest.folders (id, name, parent_id, position, created_at, updated_at, device_id) SELECT id, name, parent_id, position, created_at, updated_at, device_id FROM main.folders',
  'INSERT INTO dest.tags (id, tag_type, tag_value) SELECT id, tag_type, tag_value FROM main.tags',
  'INSERT INTO dest.notes (id, folder_id, trash_level, created_at, updated_at, trashed_at, device_id, content_hash, content, auto_delete_at) SELECT id, folder_id, trash_level, created_at, updated_at, trashed_at, device_id, content_hash, content, $AUTO FROM main.notes',
  'INSERT INTO dest.note_tags (note_id, tag_id) SELECT note_id, tag_id FROM main.note_tags',
  'INSERT INTO dest.reminder_status (note_id, tag_id, fire_at, status, fired_at) SELECT note_id, tag_id, fire_at, status, fired_at FROM main.reminder_status',
  'INSERT INTO dest.local_metadata (key, value) SELECT key, value FROM main.local_metadata',
];

const FTS_DELETE_ALL = "INSERT INTO dest.notes_fts(notes_fts) VALUES('delete-all')";
const FTS_REBUILD =
  "INSERT INTO dest.notes_fts(rowid, content, tags_text) SELECT n.rowid, n.content, COALESCE((SELECT GROUP_CONCAT(t.tag_value, ' ') FROM dest.note_tags nt JOIN dest.tags t ON nt.tag_id = t.id WHERE nt.note_id = n.id AND t.tag_type = '#'), '') FROM dest.notes n";

/**
 * One-shot rebuild of a legacy v0.2 database to v0.3 schema.
 *
 * On success `dbPath` is atomically replaced with the rebuilt file; the
 * pre-migration contents live on at `${dbPath}.v0.2-backup-<ms>` and are the
 * authoritative rollback source.
 *
 * Concurrency guards (three layers):
 *   L1 — probeDaemonPid — refuse if daemon is alive
 *   L2 — `${dbPath}.migrate.lock` created with O_EXCL — refuse on duplicate
 *   L3 — `locking_mode = EXCLUSIVE` + a trigger read on the old connection;
 *        holds a persistent file lock from acquisition through `old.close()`.
 *
 * Returns `{ alreadyMigrated: true }` as a cheap no-op when called on a db
 * that is already at LATEST_KNOWN_VERSION. Throws IncompatibleDbError if
 * user_version is higher than what this build knows about.
 */
export async function migrateLegacyDb(
  dbPath: string,
  _options?: MigrateOptions,
): Promise<MigrateResult> {
  // ----- Idempotency short-circuit ------------------------------------------
  // Reading user_version up-front lets us skip the rebuild entirely when the
  // db is already current. Kept intentionally light — full validation happens
  // later inside the locked section.
  if (existsSync(dbPath)) {
    const peek = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const v = peek.pragma('user_version', { simple: true }) as number;
      if (v > LATEST_KNOWN_VERSION) {
        throw new IncompatibleDbError(dbPath, v);
      }
      if (v === LATEST_KNOWN_VERSION) {
        const row = peek.prepare('SELECT count(*) AS n FROM notes').get() as { n: number };
        return {
          backupPath: '',
          notesCount: row.n,
          elapsedMs: 0,
          alreadyMigrated: true,
        };
      }
    } finally {
      peek.close();
    }
  }

  // ----- Layer 1 — daemon pid probe ----------------------------------------
  if (probeDaemonPid(dbPath) !== null) {
    throw new MigrationBusyError(
      'daemon_alive',
      'Owl daemon is running; stop it (or close the GUI) before migrating.',
    );
  }

  // ----- Layer 2 — file lock -----------------------------------------------
  const lockPath = `${dbPath}.migrate.lock`;
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, 'wx');
    writeSync(lockFd, String(process.pid));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MigrationBusyError(
        'lock_file',
        `Found ${lockPath} (another migration is in progress or crashed). Remove it and retry.`,
      );
    }
    throw e;
  }

  const newPath = `${dbPath}.new`;

  try {
    // ----- Phase A — initialise .new --------------------------------------
    if (existsSync(newPath)) unlinkSync(newPath);
    const init = new BetterSqlite3(newPath);
    try {
      init.pragma('journal_mode = DELETE');
      init.pragma('foreign_keys = ON');
      applyInitialSchema(init);
    } finally {
      init.close();
    }

    // ----- Phase B — lock old, ATTACH new AS dest, COPY --------------------
    const startedAt = Date.now();
    const old = new BetterSqlite3(dbPath);
    let txStarted = false;
    let attached = false;

    try {
      old.pragma('busy_timeout = 0');
      old.pragma('foreign_keys = ON');
      old.pragma('locking_mode = EXCLUSIVE');

      // Trigger lock acquisition — any read on old.db works; sqlite_master is cheap.
      try {
        old.prepare('SELECT count(*) FROM sqlite_master').get();
      } catch (e) {
        if ((e as { code?: string }).code === 'SQLITE_BUSY') {
          throw new MigrationBusyError(
            'exclusive_lock_busy',
            'Cannot acquire exclusive lock on source database; another process is holding it.',
          );
        }
        throw e;
      }

      // Column existence probe for auto_delete_at + required-column validation
      const noteCols = old.pragma('table_info(notes)') as { name: string }[];
      const hasAutoDeleteAt = noteCols.some((c) => c.name === 'auto_delete_at');
      verifyExpectedColumns(old, dbPath);

      // Source FK pre-check (authoritative). Needs schema-qualified pragma.
      const mainViolations = old.pragma('main.foreign_key_check') as unknown[];
      if (mainViolations.length > 0) {
        throw new SourceDbCorruptionError(mainViolations.length);
      }

      // WAL checkpoint — under locking_mode=EXCLUSIVE this never waits.
      const ckpt = old.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
      if (ckpt[0]?.busy !== 0) {
        throw new MigrationBusyError('checkpoint_busy', 'WAL checkpoint reports busy.');
      }

      // Online backup (consistent snapshot). ms-precision ts avoids same-second collision.
      const ts = Date.now();
      const backupPath = `${dbPath}.v0.2-backup-${ts}`;
      await backupDatabase(old, backupPath);

      // ATTACH must come before BEGIN (SQLite forbids ATTACH inside
      // EXCLUSIVE/IMMEDIATE transactions).
      old.prepare('ATTACH DATABASE ? AS dest').run(newPath);
      attached = true;

      try {
        old.exec('BEGIN');
      } catch (e) {
        if ((e as { code?: string }).code === 'SQLITE_BUSY') {
          throw new MigrationBusyError(
            'begin_busy',
            'BEGIN returned busy; locking_mode should have prevented this.',
          );
        }
        throw e;
      }
      txStarted = true;

      // Copy rows FK-safe. auto_delete_at is projected NULL when source lacks it.
      const autoProj = hasAutoDeleteAt ? 'auto_delete_at' : 'NULL';
      for (const stmt of COPY_TEMPLATE) {
        old.prepare(stmt.replace('$AUTO', autoProj)).run();
      }

      // Dest-side FK re-check (belt-and-suspenders). Schema-qualified pragma.
      const destViolations = old.pragma('dest.foreign_key_check') as unknown[];
      if (destViolations.length > 0) {
        throw new SourceDbCorruptionError(destViolations.length);
      }

      // FTS rebuild: wipe any posting left by the INSERT trigger, then set-based.
      old.prepare(FTS_DELETE_ALL).run();
      old.prepare(FTS_REBUILD).run();

      const notesCount = (
        old.prepare('SELECT count(*) AS n FROM dest.notes').get() as {
          n: number;
        }
      ).n;

      old.exec('COMMIT');
      txStarted = false;
      old.exec('DETACH DATABASE dest');
      attached = false;

      // ----- Phase C — atomic file swap ----------------------------------
      old.close();

      const preSwapPath = `${dbPath}.old-pre-v0.3`;
      try {
        renameSync(dbPath, preSwapPath);
        for (const suf of ['-wal', '-shm']) {
          try {
            unlinkSync(`${dbPath}${suf}`);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        }
        renameSync(newPath, dbPath);
      } catch (err) {
        if (existsSync(preSwapPath) && !existsSync(dbPath)) {
          renameSync(preSwapPath, dbPath);
        }
        throw err;
      }

      try {
        unlinkSync(preSwapPath);
      } catch {
        /* best-effort */
      }

      return { backupPath, notesCount, elapsedMs: Date.now() - startedAt };
    } catch (err) {
      if (txStarted) {
        try {
          old.exec('ROLLBACK');
        } catch {
          /* rollback best-effort */
        }
      }
      if (attached) {
        try {
          old.exec('DETACH DATABASE dest');
        } catch {
          /* detach best-effort */
        }
      }
      throw err;
    } finally {
      try {
        old.close();
      } catch {
        /* close best-effort — Phase C success path already closed it */
      }
    }
  } finally {
    try {
      closeSync(lockFd);
    } catch {
      /* close lock fd best-effort */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* unlink lock best-effort */
    }
    try {
      unlinkSync(newPath);
    } catch {
      /* newPath already renamed to dbPath on success path */
    }
  }
}
