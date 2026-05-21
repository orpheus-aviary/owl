/**
 * P5-a Step 8 — vitest suite for `owl sync …` commands.
 *
 * The CLI uses vitest while daemon / core use `node:test`. The mocking
 * style here mirrors the existing skill.test.ts: a `MemoryStream` for
 * stdout/stderr capture and a controllable `fetch` substitute.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../lib/errors.js';
import {
  type SyncCommandEnv,
  runSyncConfigShow,
  runSyncLogin,
  runSyncRun,
  runSyncStatus,
} from './sync.js';

// ─── Stream buffer ────────────────────────────────────────────────────

function buffer(): { stream: Writable; read(): string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
}

function setupEnv(): {
  env: SyncCommandEnv;
  stdout: ReturnType<typeof buffer>;
  stderr: ReturnType<typeof buffer>;
} {
  const stdout = buffer();
  const stderr = buffer();
  return {
    stdout,
    stderr,
    env: { streams: { stdout: stdout.stream, stderr: stderr.stream } },
  };
}

// ─── fake fetch helpers ───────────────────────────────────────────────

interface FetchExpectation {
  url: string | RegExp;
  method?: string;
  status: number;
  body: unknown;
}

function makeFetch(
  expects: FetchExpectation[],
): typeof fetch & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const next = expects[i++];
    if (!next) throw new Error(`fake fetch: unexpected call ${url}`);
    if (typeof next.url === 'string') {
      if (!url.endsWith(next.url)) {
        throw new Error(`fake fetch: expected ${next.url}, got ${url}`);
      }
    } else if (!next.url.test(url)) {
      throw new Error(`fake fetch: expected ${next.url}, got ${url}`);
    }
    if (next.method && init?.method !== next.method) {
      throw new Error(
        `fake fetch: expected ${next.method} ${next.url}, got ${init?.method ?? 'GET'}`,
      );
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch & { calls: { url: string; init?: RequestInit }[] };
  (fn as { calls: { url: string; init?: RequestInit }[] }).calls = calls;
  return fn;
}

// `withDaemonHttp` calls `resolveConfig()` which reads owl_config.toml.
// In CI we don't want to depend on the host machine; route OWL_NEST_DIR
// to a tmp dir each test.

let nestDir: string;
let originalNest: string | undefined;

beforeEach(async () => {
  originalNest = process.env.OWL_NEST_DIR;
  nestDir = await mkdtemp(join(tmpdir(), 'sync-cli-test-'));
  process.env.OWL_NEST_DIR = nestDir;
});

afterEach(async () => {
  if (originalNest === undefined) {
    // biome-ignore lint/performance/noDelete: assigning undefined stringifies it to "undefined" in process.env; delete is the only way to truly unset
    delete process.env.OWL_NEST_DIR;
  } else {
    process.env.OWL_NEST_DIR = originalNest;
  }
  await rm(nestDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── owl sync run ─────────────────────────────────────────────────────

describe('owl sync run', () => {
  it('--direct rejects with USAGE_ERROR before any fetch happens', async () => {
    const { env } = setupEnv();
    env.fetch = vi.fn(); // would throw if called
    await expect(runSyncRun({ direct: true }, env)).rejects.toMatchObject({
      code: 'USAGE_ERROR',
    });
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it('DAEMON_UNAVAILABLE when /status probe fails', async () => {
    const { env } = setupEnv();
    // Probe call returns connection refused — modelled as a thrown Error
    env.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(runSyncRun({}, env)).rejects.toMatchObject({
      code: 'DAEMON_UNAVAILABLE',
    });
  });

  it('happy path: probe ok → POST /sync/run → pretty-prints RunSyncResult', async () => {
    const { env, stdout } = setupEnv();
    const result = {
      pulledTotal: 0,
      appliedTotal: 0,
      skippedTotal: 0,
      pushedTotal: 1,
      duplicatesTotal: 0,
      serverSeqHigh: 42,
      cursorBefore: 0,
      cursorAfter: 0,
    };
    env.fetch = makeFetch([
      { url: '/status', status: 200, body: { success: true, data: { status: 'ok' } } },
      { url: '/sync/run', method: 'POST', status: 200, body: { success: true, data: result } },
    ]);
    await runSyncRun({ pretty: true }, env);
    expect(JSON.parse(stdout.read())).toEqual(result);
  });

  it('propagates SKYBRIDGE_NOT_CONFIGURED from daemon as a CliError with same code', async () => {
    const { env } = setupEnv();
    env.fetch = makeFetch([
      { url: '/status', status: 200, body: { success: true, data: { status: 'ok' } } },
      {
        url: '/sync/run',
        method: 'POST',
        status: 400,
        body: {
          success: false,
          error_code: 'SKYBRIDGE_NOT_CONFIGURED',
          message: 'skybridge config not found',
        },
      },
    ]);
    await expect(runSyncRun({}, env)).rejects.toMatchObject({
      code: 'SKYBRIDGE_NOT_CONFIGURED',
    });
  });

  it('propagates SKYBRIDGE_AUTH_REQUIRED (401) as a CliError', async () => {
    const { env } = setupEnv();
    env.fetch = makeFetch([
      { url: '/status', status: 200, body: { success: true, data: { status: 'ok' } } },
      {
        url: '/sync/run',
        method: 'POST',
        status: 401,
        body: {
          success: false,
          error_code: 'SKYBRIDGE_AUTH_REQUIRED',
          message: 'skybridge token rejected (401); re-run `owl sync login`',
        },
      },
    ]);
    await expect(runSyncRun({}, env)).rejects.toMatchObject({
      code: 'SKYBRIDGE_AUTH_REQUIRED',
    });
  });
});

// ─── owl sync status ──────────────────────────────────────────────────

describe('owl sync status', () => {
  it('--direct rejects', async () => {
    const { env } = setupEnv();
    env.fetch = vi.fn();
    await expect(runSyncStatus({ direct: true }, env)).rejects.toMatchObject({
      code: 'USAGE_ERROR',
    });
  });

  it('GETs /sync/status and prints the daemon payload', async () => {
    const { env, stdout } = setupEnv();
    const status = {
      configured: true,
      authenticated: true,
      server_url: 'http://127.0.0.1:18443',
      device_id: 'dev_1',
      workspace_id: 'ws_1',
      pending_count: 3,
      pulled_seq: 12,
      pushed_seq: 8,
      last_sync_at: 1234567,
    };
    env.fetch = makeFetch([
      { url: '/status', status: 200, body: { success: true, data: { status: 'ok' } } },
      {
        url: '/sync/status',
        method: undefined,
        status: 200,
        body: { success: true, data: status },
      },
    ]);
    await runSyncStatus({}, env);
    expect(JSON.parse(stdout.read())).toEqual(status);
  });
});

// ─── owl sync login ───────────────────────────────────────────────────

describe('owl sync login', () => {
  it('--direct rejects before prompting for password', async () => {
    const { env } = setupEnv();
    let prompted = false;
    env.readPassword = async () => {
      prompted = true;
      return 'pw';
    };
    env.fetch = vi.fn();
    await expect(runSyncLogin({ email: 'a@b', direct: true }, env)).rejects.toMatchObject({
      code: 'USAGE_ERROR',
    });
    expect(prompted).toBe(false);
  });

  it('empty password → USAGE_ERROR (no daemon call)', async () => {
    const { env } = setupEnv();
    env.readPassword = async () => '';
    env.fetch = vi.fn();
    await expect(runSyncLogin({ email: 'a@b' }, env)).rejects.toMatchObject({
      code: 'USAGE_ERROR',
    });
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it('POSTs /sync/login with {email, password, server_url} and writes the response', async () => {
    const { env, stdout } = setupEnv();
    env.readPassword = async () => 'longenoughpw';
    env.fetch = makeFetch([
      { url: '/status', status: 200, body: { success: true, data: { status: 'ok' } } },
      {
        url: '/sync/login',
        method: 'POST',
        status: 200,
        body: {
          success: true,
          data: {
            server_url: 'http://127.0.0.1:18443',
            email: 'jay@local',
            user_id: 'usr_1',
          },
        },
      },
    ]);
    await runSyncLogin({ email: 'jay@local', serverUrl: 'http://127.0.0.1:18443' }, env);
    const out = JSON.parse(stdout.read());
    expect(out.user_id).toBe('usr_1');
    expect(out.email).toBe('jay@local');

    const loginCall = (env.fetch as unknown as { calls: { url: string; init?: RequestInit }[] })
      .calls[1];
    const sent = JSON.parse(loginCall.init?.body as string);
    expect(sent).toEqual({
      email: 'jay@local',
      password: 'longenoughpw',
      server_url: 'http://127.0.0.1:18443',
    });
  });

  it('omits server_url from the body when not provided', async () => {
    const { env } = setupEnv();
    env.readPassword = async () => 'pw';
    env.fetch = makeFetch([
      { url: '/status', status: 200, body: { success: true, data: { status: 'ok' } } },
      {
        url: '/sync/login',
        method: 'POST',
        status: 200,
        body: { success: true, data: { server_url: 'http://x', email: 'a@b', user_id: 'u' } },
      },
    ]);
    await runSyncLogin({ email: 'a@b' }, env);
    const loginCall = (env.fetch as unknown as { calls: { url: string; init?: RequestInit }[] })
      .calls[1];
    const sent = JSON.parse(loginCall.init?.body as string);
    expect(sent.server_url).toBeUndefined();
  });
});

// ─── owl sync config show ─────────────────────────────────────────────

describe('owl sync config show', () => {
  it('reads local skybridge_config.toml and masks the token', async () => {
    // Write a config file inside the tmp nest dir
    const cfgDir = join(nestDir, 'skybridge');
    await rm(cfgDir, { recursive: true, force: true });
    await import('node:fs/promises').then(({ mkdir }) => mkdir(cfgDir, { recursive: true }));
    const tomlPath = join(cfgDir, 'skybridge_config.toml');
    await writeFile(
      tomlPath,
      `[server]
url = "http://127.0.0.1:18443"

[auth]
user_id = "usr_1"
token = "tok_abcdef0123456789xyz"
email = "jay@local"

[device]
id = "dev_1"
name = "macbook"
app_version = "owl 0.5.0-dev"
client_version = "0.1.0"
`,
      'utf8',
    );

    const { env, stdout } = setupEnv();
    await runSyncConfigShow({}, env);
    const out = JSON.parse(stdout.read());
    expect(out.server.url).toBe('http://127.0.0.1:18443');
    expect(out.auth.user_id).toBe('usr_1');
    expect(out.auth.token).toMatch(/^tok_…6789$|^tok_…\w{4}$/);
    expect(out.auth.token).not.toContain('abcdef');
    expect(out.device.id).toBe('dev_1');
  });

  it('throws SKYBRIDGE_NOT_CONFIGURED when the toml is absent', async () => {
    const { env } = setupEnv();
    await expect(runSyncConfigShow({}, env)).rejects.toMatchObject({
      code: 'SKYBRIDGE_NOT_CONFIGURED',
    });
  });
});

// ─── exit-code wiring sanity ──────────────────────────────────────────

describe('error → exit code mapping (lib/errors.ts)', () => {
  it('SKYBRIDGE_NOT_CONFIGURED is ENV (3), SKYBRIDGE_API_ERROR is FAILURE (1)', async () => {
    const { exitCodeFor } = await import('../lib/errors.js');
    const { EXIT_CODES } = await import('../lib/exit-codes.js');
    expect(exitCodeFor('SKYBRIDGE_NOT_CONFIGURED')).toBe(EXIT_CODES.ENV);
    expect(exitCodeFor('SKYBRIDGE_AUTH_REQUIRED')).toBe(EXIT_CODES.ENV);
    expect(exitCodeFor('SKYBRIDGE_SERVER_UNREACHABLE')).toBe(EXIT_CODES.FAILURE);
    expect(exitCodeFor('SKYBRIDGE_API_ERROR')).toBe(EXIT_CODES.FAILURE);
  });

  it('CliError carries the code through', () => {
    const err = new CliError('SKYBRIDGE_AUTH_REQUIRED', 'foo');
    expect(err.code).toBe('SKYBRIDGE_AUTH_REQUIRED');
  });
});
