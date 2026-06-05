import { isSwitchLockActive, readSwitchLock, resolveActiveProfileDbPath } from '@owl/core';
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
  /** Override fetch for tests. */
  fetch?: typeof fetch;
  /** Re-resolve the active profile db at open time (default: core). Test seam. */
  resolveDbPath?: () => string;
  /** Is a GUI profile switch in flight? (default: core lockfile). Test seam. */
  isSwitchInProgress?: () => boolean;
}

export interface ResolveBackendResult {
  backend: OwlBackend;
  mode: 'http' | 'direct';
  warnings: string[];
}

function defaultIsSwitchInProgress(): boolean {
  return isSwitchLockActive(readSwitchLock());
}

function assertNoActiveSwitch(isSwitching: () => boolean): void {
  if (isSwitching()) {
    throw new CliError(
      'SWITCH_IN_PROGRESS',
      'a profile switch is in progress in the owl GUI — retry shortly',
    );
  }
}

/**
 * Pick the db path for a direct open (W10).
 *
 * An explicit `--db <path>` names a specific file — an active-profile switch is
 * irrelevant to it, so it is NOT lock-gated (gating would falsely refuse opening
 * `local` / a non-active profile during an unrelated account switch).
 *
 * The default path is the active profile db. We re-resolve it FRESH here, inside
 * a lock bracket, rather than trusting the value `resolveConfig` resolved
 * eagerly (a switch can complete between that resolve and this open). The double
 * check catches a switch that starts while we read the toml.
 */
export function resolveDirectDbPath(input: ResolveBackendInput): string {
  if (input.db !== undefined) return input.db;
  const isSwitching = input.isSwitchInProgress ?? defaultIsSwitchInProgress;
  const resolveDbPath = input.resolveDbPath ?? resolveActiveProfileDbPath;
  assertNoActiveSwitch(isSwitching);
  const dbPath = resolveDbPath();
  assertNoActiveSwitch(isSwitching);
  return dbPath;
}

export async function resolveBackend(input: ResolveBackendInput): Promise<ResolveBackendResult> {
  const decision = decideMode(input);
  if (decision.mode === 'http') {
    return {
      backend: createHttpBackend({
        port: input.port,
        ...(input.fetch ? { fetch: input.fetch } : {}),
      }),
      mode: 'http',
      warnings: decision.warnings,
    };
  }
  const backend = await createDirectBackend({ dbPath: resolveDirectDbPath(input) });
  return { backend, mode: 'direct', warnings: decision.warnings };
}
