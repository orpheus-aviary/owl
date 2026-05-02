import { CliError } from '../lib/errors.js';
import { createDirectBackend } from './direct.js';
import { createHttpBackend } from './http.js';
import type { OwlBackend } from './types.js';

export interface ModeFlags {
  direct?: boolean;
  force?: boolean;
  db?: string;
}

export interface DecideModeInput extends ModeFlags {
  isWrite: boolean;
  daemonAlive: boolean;
}

export interface DecideModeResult {
  mode: 'http' | 'direct';
  /** Non-fatal warnings to emit to stderr before executing. */
  warnings: string[];
}

/**
 * Pure decision function for backend mode. Throws `DAEMON_RUNNING_BLOCKED`
 * when the caller tries to write via direct (`--direct` or `--db`) while
 * a daemon is alive and no `--force` is given. See design §4.1.
 */
export function decideMode(input: DecideModeInput): DecideModeResult {
  const hasDirectIntent = input.direct === true || input.db !== undefined;

  // Reads are always permissive.
  if (!input.isWrite) {
    return { mode: hasDirectIntent || !input.daemonAlive ? 'direct' : 'http', warnings: [] };
  }

  // Writes:
  if (!input.daemonAlive) {
    if (hasDirectIntent) return { mode: 'direct', warnings: [] };
    return {
      mode: 'direct',
      warnings: ['daemon not running; writing direct to sqlite'],
    };
  }

  // daemon alive:
  if (!hasDirectIntent) {
    return { mode: 'http', warnings: [] };
  }
  if (!input.force) {
    throw new CliError(
      'DAEMON_RUNNING_BLOCKED',
      'daemon is running; direct write refused (use --force to override)',
    );
  }
  return {
    mode: 'direct',
    warnings: [
      'WARNING: --force enabled direct write while daemon is running. Data may race against the daemon.',
    ],
  };
}

export interface ResolveBackendInput extends DecideModeInput {
  /** Daemon HTTP port, for the http backend. */
  port: number;
  /** SQLite db path, for the direct backend. */
  dbPath: string;
  /** Override fetch for tests. */
  fetch?: typeof fetch;
}

export interface ResolveBackendResult {
  backend: OwlBackend;
  mode: 'http' | 'direct';
  warnings: string[];
}

export async function resolveBackend(input: ResolveBackendInput): Promise<ResolveBackendResult> {
  const decision = decideMode(input);
  const backend =
    decision.mode === 'http'
      ? createHttpBackend({ port: input.port, ...(input.fetch ? { fetch: input.fetch } : {}) })
      : await createDirectBackend({ dbPath: input.dbPath });
  return { backend, mode: decision.mode, warnings: decision.warnings };
}
