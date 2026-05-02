import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  IncompatibleDbError,
  LATEST_KNOWN_VERSION,
  type MigratePhase,
  migrateLegacyDb,
  probeStartupState,
} from '@owl/core';
import { detectDaemon } from '../lib/daemon-detect.js';
import { CliError } from '../lib/errors.js';
import type { OutputStreams } from '../lib/output.js';
import { writeProgress, writeResult } from '../lib/output.js';

export interface MigrateFlags {
  yes?: boolean;
  db?: string;
  progress?: boolean;
  pretty?: boolean;
}

export interface MigrateDeps {
  dbPath: string;
  daemonPort: number;
  pidPath: string;
  streams: OutputStreams;
  isTty?: boolean;
  readInput?: () => Promise<string>;
}

function pidAlive(pidPath: string): boolean {
  if (!existsSync(pidPath)) return false;
  try {
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function confirmPrompt(dbPath: string, backupHint: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = await rl.question(`将迁移 ${dbPath}（备份到 ${backupHint}），继续？ [y/N] `);
    return /^(y|yes)$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

export async function runMigrate(flags: MigrateFlags, deps: MigrateDeps): Promise<void> {
  const start = Date.now();
  const probe = probeStartupState(deps.dbPath);

  if (probe.kind === 'not-found') {
    throw new CliError('DATA_DIR_MISSING', `db file not found: ${deps.dbPath}`, {
      db_path: deps.dbPath,
    });
  }
  if (probe.version === LATEST_KNOWN_VERSION && !probe.schemaEmpty) {
    writeResult(
      { success: true, already_migrated: true },
      { pretty: flags.pretty, streams: deps.streams },
    );
    return;
  }
  if (probe.version > LATEST_KNOWN_VERSION) {
    throw new CliError(
      'INCOMPATIBLE_DB',
      `db ${deps.dbPath} is version ${probe.version} but this CLI only supports up to ${LATEST_KNOWN_VERSION}`,
      { db_path: deps.dbPath, user_version: probe.version },
    );
  }

  // §4.5 three-layer daemon lock
  if (await detectDaemon(deps.daemonPort)) {
    throw new CliError('MIGRATION_BUSY', 'daemon HTTP /status is alive; stop it before migrating', {
      reason: 'daemon-http-alive',
    });
  }
  if (pidAlive(deps.pidPath)) {
    throw new CliError('MIGRATION_BUSY', 'daemon pid file points at a live process', {
      reason: 'daemon-pid-alive',
      pid_path: deps.pidPath,
    });
  }

  const isTty = deps.isTty ?? Boolean(process.stdin.isTTY);
  if (!flags.yes) {
    if (!isTty) {
      throw new CliError('USAGE_ERROR', '--yes is required when stdin is not a TTY');
    }
    const proceed = await (deps.readInput
      ? deps.readInput().then((v) => /^(y|yes)$/i.test(v.trim()))
      : confirmPrompt(deps.dbPath, `${deps.dbPath}.v0.2-backup-<ts>`));
    if (!proceed) {
      throw new CliError('USER_CANCELLED', 'migration cancelled by user');
    }
  }

  try {
    const result = await migrateLegacyDb(deps.dbPath, {
      onProgress: (phase: MigratePhase) => {
        if (flags.progress !== false) {
          writeProgress({ phase, ts: Date.now() }, { streams: deps.streams });
        }
      },
    });
    writeResult(
      {
        success: true,
        from: 0,
        to: LATEST_KNOWN_VERSION,
        backup_path: result.backupPath,
        elapsed_ms: Date.now() - start,
      },
      { pretty: flags.pretty, streams: deps.streams },
    );
  } catch (err) {
    if (err instanceof IncompatibleDbError) {
      throw new CliError('INCOMPATIBLE_DB', err.message, {
        db_path: deps.dbPath,
      });
    }
    throw err;
  }
}
