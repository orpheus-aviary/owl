/**
 * P5-a Step 8 — `owl sync …` command family.
 *
 * Strictly daemon-mediated: every subcommand except `config show` hits a
 * daemon HTTP endpoint. Direct sqlite mode is rejected with USAGE_ERROR
 * because the engine lives in the daemon process (inflight-Promise dedupe
 * + shared sqlite handle); a second CLI-side connection would race for
 * the same write lock.
 *
 * `config show` reads `~/orpheus-aviary-nest/skybridge/skybridge_config.toml`
 * directly via core's `readSkybridgeConfig` and prints the parsed shape
 * with the token masked — debugging aid, no daemon round-trip.
 */

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import {
  type SkybridgeConfig,
  SkybridgeNotConfiguredError,
  SkybridgeServerUrlMissingError,
  readSkybridgeConfig,
} from '@owl/core';
import { resolveConfig } from '../lib/config.js';
import { detectDaemon } from '../lib/daemon-detect.js';
import { CliError, type DaemonFailBody, mapHttpError } from '../lib/errors.js';
import { type OutputStreams, writeError, writeResult } from '../lib/output.js';

// ─── Shared shape for invocation environments ─────────────────────────

export interface SyncCommandEnv {
  streams: OutputStreams;
  /** Override for tests; defaults to global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Override for tests; defaults to `readPasswordSilently`. Resolves the
   * password the user typed at the password prompt.
   */
  readPassword?: (prompt: string) => Promise<string>;
  /** Test override for the local skybridge_config.toml read. */
  readConfig?: typeof readSkybridgeConfig;
}

export interface SyncFlags {
  pretty?: boolean;
  direct?: boolean;
}

export interface SyncLoginFlags extends SyncFlags {
  email: string;
  /** P5-a passes `--server-url` to override; if absent, reuse on-disk config. */
  serverUrl?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface DaemonEnvelope<T> {
  success?: boolean;
  data?: T;
  error_code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

async function withDaemonHttp<T>(
  flags: SyncFlags,
  env: SyncCommandEnv,
  fn: (base: string, doFetch: typeof fetch) => Promise<T>,
): Promise<T> {
  if (flags.direct) {
    throw new CliError(
      'USAGE_ERROR',
      'sync commands require the daemon; --direct is not supported',
    );
  }
  const cfg = resolveConfig();
  const doFetch = env.fetch ?? fetch;
  const alive = await detectDaemon(cfg.daemonPort, { fetch: doFetch });
  if (!alive) {
    throw new CliError(
      'DAEMON_UNAVAILABLE',
      'daemon is not running; start it with `owl-daemon` first',
      { port: cfg.daemonPort },
    );
  }
  return fn(`http://127.0.0.1:${cfg.daemonPort}`, doFetch);
}

async function postOrThrow<T>(doFetch: typeof fetch, url: string, body?: unknown): Promise<T> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const envelope = (await res.json()) as DaemonEnvelope<T>;
  if (res.status >= 400 || envelope.success === false) {
    throw mapHttpError(res.status, envelope as DaemonFailBody);
  }
  // `success: true` always has data; the daemon never sends an empty body.
  return envelope.data as T;
}

async function getOrThrow<T>(doFetch: typeof fetch, url: string): Promise<T> {
  const res = await doFetch(url);
  const envelope = (await res.json()) as DaemonEnvelope<T>;
  if (res.status >= 400 || envelope.success === false) {
    throw mapHttpError(res.status, envelope as DaemonFailBody);
  }
  return envelope.data as T;
}

// ─── Password prompt (raw-mode readline, no echo) ─────────────────────

/**
 * Prompts the user for a password on stdin without echoing keystrokes.
 *
 * Implementation: a writable sink that swallows readline's terminal
 * echo + a normal readline interface with `terminal: true`. The prompt
 * itself is written manually to stdout so it stays visible. EOL handling
 * is left to readline.
 *
 * Tests inject `env.readPassword` to bypass stdin entirely.
 */
function readPasswordSilently(prompt: string): Promise<string> {
  const muted = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  process.stdout.write(prompt);
  const rl = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
  });
  return new Promise<string>((resolve, reject) => {
    rl.question('', (answer) => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    rl.once('close', () => {
      // If the readline closed without a question reply (Ctrl-D), reject
      // with USER_CANCELLED so the action wrapper exits cleanly.
      reject(new CliError('USER_CANCELLED', 'password prompt cancelled'));
    });
  });
}

// ─── Subcommands ──────────────────────────────────────────────────────

export async function runSyncRun(flags: SyncFlags, env: SyncCommandEnv): Promise<void> {
  const result = await withDaemonHttp(flags, env, async (base, doFetch) => {
    return postOrThrow<Record<string, unknown>>(doFetch, `${base}/sync/run`);
  });
  writeResult(result, { pretty: flags.pretty, streams: env.streams });
}

export async function runSyncStatus(flags: SyncFlags, env: SyncCommandEnv): Promise<void> {
  const result = await withDaemonHttp(flags, env, async (base, doFetch) => {
    return getOrThrow<Record<string, unknown>>(doFetch, `${base}/sync/status`);
  });
  writeResult(result, { pretty: flags.pretty, streams: env.streams });
}

export async function runSyncLogin(flags: SyncLoginFlags, env: SyncCommandEnv): Promise<void> {
  if (!flags.email) {
    throw new CliError('USAGE_ERROR', '--email is required');
  }
  // --direct refuses BEFORE prompting so we never read the user's
  // password into memory only to throw it away.
  if (flags.direct) {
    throw new CliError(
      'USAGE_ERROR',
      'sync commands require the daemon; --direct is not supported',
    );
  }
  const readPwd = env.readPassword ?? readPasswordSilently;
  const password = await readPwd(`Password for ${flags.email}: `);
  if (!password) {
    throw new CliError('USAGE_ERROR', 'password cannot be empty');
  }
  const result = await withDaemonHttp(flags, env, async (base, doFetch) => {
    return postOrThrow<Record<string, unknown>>(doFetch, `${base}/sync/login`, {
      email: flags.email,
      password,
      // `server_url` is optional; daemon falls back to existing config when omitted
      ...(flags.serverUrl ? { server_url: flags.serverUrl } : {}),
    });
  });
  writeResult(result, { pretty: flags.pretty, streams: env.streams });
}

// ─── `owl sync config show` ───────────────────────────────────────────

interface MaskedSkybridgeConfig {
  server: { url: string };
  auth?: { user_id: string; token: string; email: string };
  device?: SkybridgeConfig['device'];
  workspace?: SkybridgeConfig['workspace'];
}

function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function mask(config: SkybridgeConfig): MaskedSkybridgeConfig {
  return {
    server: config.server,
    auth: config.auth
      ? {
          user_id: config.auth.user_id,
          token: maskToken(config.auth.token),
          email: config.auth.email,
        }
      : undefined,
    device: config.device,
    workspace: config.workspace,
  };
}

export async function runSyncConfigShow(flags: SyncFlags, env: SyncCommandEnv): Promise<void> {
  if (flags.direct === false) {
    // `--direct` is irrelevant for config show; we don't reject it like
    // run/status/login. The flag may still be present from the global
    // option, and that's fine — local file read either way.
  }
  const readCfg = env.readConfig ?? readSkybridgeConfig;
  try {
    const config = readCfg();
    writeResult(mask(config), { pretty: flags.pretty, streams: env.streams });
  } catch (err) {
    if (err instanceof SkybridgeNotConfiguredError) {
      throw new CliError(
        'SKYBRIDGE_NOT_CONFIGURED',
        `skybridge config not found at ${err.path} — run \`owl sync login\` first`,
        { path: err.path },
      );
    }
    if (err instanceof SkybridgeServerUrlMissingError) {
      throw new CliError('SKYBRIDGE_SERVER_URL_MISSING', err.message, { path: err.path });
    }
    throw err;
  }
}

// ─── (test-only) writeError re-export so the index.ts handler can be
//     exercised without import gymnastics in suites that bypass the
//     top-level catch.
export { writeError };
