// Schema migration runner.
//
// Responsibilities:
//   - Own the baseline schema (0001_initial.sql) and future forward migrations
//     (0002_*.sql, 0003_*.sql, ...).
//   - Dispatch on PRAGMA user_version inside createDatabase() — see db/index.ts.
//   - Provide migrateLegacyDb() for the one-shot v0.2 -> v0.3 rebuild. This
//     function is transitional: 0.4.0 will delete it and assume all surviving
//     databases are at user_version >= 1.
//   - Export structured error types so CLI / daemon / GUI can each render
//     appropriate UX without parsing message strings.
//
// ----- Relationship to @owl/daemon -----
// @owl/daemon depends on @owl/core for paths and createDatabase, so
// @owl/core cannot import from @owl/daemon without creating a cycle.
// probeDaemonPid() is therefore re-implemented here against a dbPath-derived
// pid location rather than importing daemon/pid.ts. The pid layout is by
// convention identical (dirname(dbPath)/daemon.pid === paths.pidPath()).
//
// ----- Forward migration runner (P3.4-a: first real use) -----
// applyForwardMigrations() walks migrations/NNNN_*.sql files strictly greater
// than fromV up to toV, wrapping each in its own transaction and stamping
// user_version = N on success. The five decisions flagged in v0.3.0:
//   1. ✅ Per-file transaction (BEGIN / COMMIT / ROLLBACK per file)
//   2. ✅ user_version bookkeeping is the runner's job, not the .sql file's
//   3. ⏭  Code migrations (NNNN_*.ts modules) — not implemented; add when needed
//   4. ✅ Destructive marker (`-- requires_confirmation: true` in file header)
//        raises DestructiveForwardMigrationError so callers can branch
//   5. ⏭  Three-layer lock reuse — only needed for destructive migrations;
//        0002_sorting.sql is pure ALTER TABLE ADD COLUMN, no lock reuse

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { backupDatabase } from './backup.js';

export const LATEST_KNOWN_VERSION = 4;

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

/**
 * A forward migration SQL file failed mid-apply. The enclosing transaction has
 * already been rolled back; user_version stays at the pre-file value.
 */
export class ForwardMigrationError extends Error {
  readonly version: number;
  constructor(version: number, cause: unknown) {
    super(
      `Forward migration to v${version} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'ForwardMigrationError';
    this.version = version;
    // Chain the original cause for test + diagnostics
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * A forward migration file carries the `-- requires_confirmation: true`
 * marker, meaning it must not be applied silently. Callers decide UX
 * (GUI modal, CLI prompt, etc.).
 *
 * Distinct from MigrationRequiredError — that one is specifically for legacy
 * v0.2 rebuild (constructor takes dbPath). This one carries the migration
 * version + file so UX can say exactly which migration needs confirmation.
 */
export class DestructiveForwardMigrationError extends Error {
  readonly version: number;
  readonly filePath: string;
  constructor(version: number, filePath: string) {
    super(
      `Forward migration to v${version} (${filePath}) is marked destructive and requires explicit confirmation.`,
    );
    this.name = 'DestructiveForwardMigrationError';
    this.version = version;
    this.filePath = filePath;
  }
}

// ----- Public API ------------------------------------------------------------

export type MigratePhase = 'backup' | 'copy' | 'fts-rebuild' | 'swap';

export interface MigrateOptions {
  /**
   * Progress reporter for the GUI MigrationDialog. Emitted at 4 phase
   * boundaries in order: 'backup' -> 'copy' -> 'fts-rebuild' -> 'swap'.
   * Every call is best-effort; exceptions thrown by the callback are
   * swallowed so renderer-side IPC drops don't abort migration. The
   * runtime yields (setImmediate) after each emit to let the IPC queue
   * flush to the renderer (better-sqlite3 is synchronous).
   *
   * alreadyMigrated short-circuit does NOT emit any phase.
   */
  onProgress?: (phase: MigratePhase) => void;
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

/**
 * Fresh-install path: apply 0001_initial.sql, stamp user_version = 1, then
 * walk every subsequent migration up to LATEST_KNOWN_VERSION. This keeps new
 * installs and upgraded installs on a single code path — both end up running
 * the exact same forward migrations, so a bug in 0002+ is impossible to hide
 * behind "works for new users, breaks for upgraders".
 */
export function applyInitialSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(readInitialSql());
  sqlite.pragma('user_version = 1');
  if (LATEST_KNOWN_VERSION > 1) {
    applyForwardMigrations(sqlite, 1, LATEST_KNOWN_VERSION);
  }
}

/**
 * Locate the SQL file for user_version = N. Matches `NNNN_*.sql` with N
 * zero-padded to 4 digits. Throws if missing or ambiguous (>1 match).
 */
export function resolveMigrationFile(version: number): string {
  const prefix = String(version).padStart(4, '0');
  const matches = readdirSync(MIGRATIONS_DIR).filter(
    (name) => name.startsWith(`${prefix}_`) && name.endsWith('.sql'),
  );
  if (matches.length === 0) {
    throw new Error(`No migration file found for v${version} (looked for ${prefix}_*.sql)`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous migration files for v${version}: ${matches.join(', ')}`);
  }
  return join(MIGRATIONS_DIR, matches[0]);
}

/**
 * Inspect the first ~40 lines of a migration SQL file for a destructive
 * marker. Non-destructive migrations are applied silently by the runner;
 * destructive ones need explicit caller confirmation.
 *
 * Marker syntax (comment-only, anchored):
 *   -- requires_confirmation: true
 *
 * Only lines beginning with `--` are scanned — the marker must live in the
 * file header, not inside DDL.
 */
export function assertNotDestructive(sql: string, version: number, filePath: string): void {
  const header = sql.split('\n', 40).join('\n');
  if (/^\s*--\s*requires_confirmation:\s*true\s*$/im.test(header)) {
    throw new DestructiveForwardMigrationError(version, filePath);
  }
}

/**
 * Walk NNNN_*.sql files strictly greater than fromV up to and including toV,
 * applying each inside its own transaction. On success, stamps user_version
 * after each file so a mid-chain failure leaves the db at the last successful
 * version (not fromV, not toV).
 *
 * Caller contract: fromV must equal the current PRAGMA user_version. The
 * runner does not re-check — createDatabase() / applyInitialSchema() are
 * responsible for establishing that invariant.
 */
export function applyForwardMigrations(
  sqlite: BetterSqlite3.Database,
  fromV: number,
  toV: number,
): void {
  for (let v = fromV + 1; v <= toV; v++) {
    const filePath = resolveMigrationFile(v);
    const sql = readFileSync(filePath, 'utf8');
    assertNotDestructive(sql, v, filePath);

    sqlite.exec('BEGIN');
    try {
      sqlite.exec(sql);
      sqlite.pragma(`user_version = ${v}`);
      sqlite.exec('COMMIT');
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK');
      } catch {
        /* rollback best-effort — primary error is more informative */
      }
      throw new ForwardMigrationError(v, err);
    }
  }
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

// ----- Progress emit --------------------------------------------------------

/**
 * Best-effort emit to the GUI MigrationDialog. Exceptions thrown by the
 * callback are swallowed (IPC drops shouldn't abort migration). `setImmediate`
 * yield flushes the IPC queue — better-sqlite3 is synchronous, without the
 * yield the 4 phases would arrive batched at the renderer after swap.
 */
async function emitPhase(opts: MigrateOptions | undefined, phase: MigratePhase): Promise<void> {
  try {
    opts?.onProgress?.(phase);
  } catch {
    /* best-effort: renderer-side exception must not abort migration */
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
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
  options?: MigrateOptions,
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
      await emitPhase(options, 'backup');
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
      await emitPhase(options, 'copy');
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
      await emitPhase(options, 'fts-rebuild');
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
      await emitPhase(options, 'swap');

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
