/**
 * P5-a Step 8 — `owl sync …` command family.
 *
 * `run` / `status` are strictly daemon-mediated (Direct sqlite mode is
 * rejected with USAGE_ERROR — the sync engine lives in the daemon process).
 *
 * `login` is **not** a CLI capability: per-profile login needs the GUI's
 * safeStorage to encrypt the token plus the GUI-main profile orchestration
 * (switch + device reuse + refresh flow), and the daemon deliberately can't
 * decrypt. The retired `/sync/login` route is gone; `owl sync login` now
 * surfaces a friendly "log in via the GUI" error.
 *
 * `config show` reads `~/orpheus-aviary-nest/skybridge/skybridge_config.toml`
 * directly via core's `readSkybridgeConfig` and prints the parsed shape
 * with the token masked — debugging aid, no daemon round-trip.
 */

import {
  type SkybridgeConfig,
  SkybridgeNotConfiguredError,
  SkybridgeServerUrlMissingError,
  readSkybridgeConfig,
} from '@owl/core';
import { resolveConfig } from '../lib/config.js';
import { daemonAuthHeaders } from '../lib/daemon-auth.js';
import { detectDaemon } from '../lib/daemon-detect.js';
import { CliError, type DaemonFailBody, mapHttpError } from '../lib/errors.js';
import { type OutputStreams, writeError, writeResult } from '../lib/output.js';

// ─── Shared shape for invocation environments ─────────────────────────

export interface SyncCommandEnv {
  streams: OutputStreams;
  /** Override for tests; defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Test override for the local skybridge_config.toml read. */
  readConfig?: typeof readSkybridgeConfig;
}

export interface SyncFlags {
  pretty?: boolean;
  direct?: boolean;
}

export interface SyncLoginFlags extends SyncFlags {
  /** Accepted but ignored — login is GUI-only (kept so old scripts get the
   *  friendly redirect, not an "unknown option" error). */
  email?: string;
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
    headers: {
      ...daemonAuthHeaders(),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
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
  const res = await doFetch(url, { headers: daemonAuthHeaders() });
  const envelope = (await res.json()) as DaemonEnvelope<T>;
  if (res.status >= 400 || envelope.success === false) {
    throw mapHttpError(res.status, envelope as DaemonFailBody);
  }
  return envelope.data as T;
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

// `owl sync login` is retired. Login is GUI-only: per-profile login needs the
// GUI's safeStorage to encrypt the token plus the GUI-main profile
// orchestration (switch / device reuse / refresh), and the daemon can't
// decrypt. `--email` / `--server-url` are still accepted (and ignored) so old
// scripts hit this redirect instead of an "unknown option" error.
export async function runSyncLogin(_flags: SyncLoginFlags, _env: SyncCommandEnv): Promise<void> {
  throw new CliError(
    'USAGE_ERROR',
    'login is not available from the CLI — log in via the owl GUI (Settings → Sync)',
  );
}

// ─── `owl sync config show` ───────────────────────────────────────────

interface MaskedSkybridgeConfig {
  server: { url: string };
  // P5-d Phase 7: schema now allows encrypted_token-only configs.
  // `token` is `string | undefined` here to surface that state in the
  // CLI's masked view.
  auth?: {
    user_id: string;
    token: string | undefined;
    email: string;
    encrypted_token?: string;
  };
  device?: SkybridgeConfig['device'];
  workspace?: SkybridgeConfig['workspace'];
}

function maskToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
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
          // P5-d Phase 7: surface the presence of the ciphertext without
          // dumping the value itself.
          encrypted_token: config.auth.encrypted_token ? '[ENCRYPTED]' : undefined,
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
        `skybridge config not found at ${err.path} — log in via the owl GUI (Settings → Sync)`,
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
