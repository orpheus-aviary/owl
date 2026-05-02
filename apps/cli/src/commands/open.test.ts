import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '../lib/config.js';
import { CliError } from '../lib/errors.js';
import { runOpen } from './open.js';

const PORT = 47010;

interface MockCall {
  url: string;
  method?: string;
  body?: unknown;
}

/**
 * Build a fetch mock that sequentially returns the given responses.
 *
 * `runOpen` calls fetch twice: once for `/status` (via detectDaemon) and
 * once for `/events/emit`. Tests that exercise both paths pass two
 * entries; tests where the daemon is "down" can opt into a throwing
 * first call via `rejectFirstWith`.
 */
function makeFetch(responses: Array<{ status?: number; body: unknown } | Error>): {
  fetch: typeof fetch;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  let i = 0;
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call: MockCall = { url: String(url), method: init?.method };
    if (init?.body) call.body = JSON.parse(init.body as string);
    calls.push(call);
    const next = responses[i++];
    if (next instanceof Error) throw next;
    if (!next) throw new Error(`mock fetch: no response queued for call ${calls.length}`);
    return {
      status: next.status ?? 200,
      ok: (next.status ?? 200) < 400,
      json: async () => next.body,
    } as Response;
  });
  return { fetch: fetchFn as unknown as typeof fetch, calls };
}

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

function setup() {
  const stdout = buffer();
  const stderr = buffer();
  const config = { daemonPort: PORT } as unknown as ResolvedConfig;
  return {
    stdout,
    stderr,
    streams: { stdout: stdout.stream, stderr: stderr.stream },
    config,
  };
}

describe('runOpen', () => {
  it('emits the event and writes JSON with subscribers count', async () => {
    const { fetch, calls } = makeFetch([
      { body: { success: true, data: { status: 'ok' } } },
      { body: { success: true, data: { subscribers: 1 } } },
    ]);
    const { stdout, stderr, streams, config } = setup();

    await runOpen('abc', {}, { config, streams, fetch });

    expect(calls[1]).toMatchObject({
      url: `http://127.0.0.1:${PORT}/events/emit`,
      method: 'POST',
      body: { type: 'open_note', note_id: 'abc' },
    });
    expect(JSON.parse(stdout.read())).toEqual({ opened: 'abc', subscribers: 1 });
    expect(stderr.read()).toBe('');
  });

  it('warns on stderr when subscribers=0 but still exits success', async () => {
    const { fetch } = makeFetch([
      { body: { success: true, data: { status: 'ok' } } },
      { body: { success: true, data: { subscribers: 0 } } },
    ]);
    const { stdout, stderr, streams, config } = setup();

    await runOpen('abc', {}, { config, streams, fetch });

    expect(JSON.parse(stdout.read())).toEqual({ opened: 'abc', subscribers: 0 });
    expect(stderr.read()).toMatch(/no GUI window is subscribed/);
  });

  it('throws DAEMON_UNAVAILABLE when detectDaemon reports dead', async () => {
    // First fetch (status probe) returns non-200 → detectDaemon = false.
    const { fetch, calls } = makeFetch([{ status: 500, body: { success: false } }]);
    const { streams, config } = setup();

    await expect(runOpen('abc', {}, { config, streams, fetch })).rejects.toMatchObject({
      code: 'DAEMON_UNAVAILABLE',
    });
    // Only the probe should have been attempted; no /events/emit call.
    expect(calls.length).toBe(1);
  });

  it('throws NOTE_NOT_FOUND with note_id detail when daemon returns 404', async () => {
    const { fetch } = makeFetch([
      { body: { success: true, data: { status: 'ok' } } },
      {
        status: 404,
        body: { success: false, error_code: 'NOTE_NOT_FOUND', message: 'note not found' },
      },
    ]);
    const { streams, config } = setup();

    await expect(runOpen('missing-id', {}, { config, streams, fetch })).rejects.toMatchObject({
      code: 'NOTE_NOT_FOUND',
    });
    try {
      await runOpen(
        'missing-id',
        {},
        {
          config,
          streams,
          fetch: makeFetch([
            { body: { success: true, data: { status: 'ok' } } },
            {
              status: 404,
              body: { success: false, error_code: 'NOTE_NOT_FOUND', message: 'note not found' },
            },
          ]).fetch,
        },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).details).toEqual({ note_id: 'missing-id' });
    }
  });

  it('wraps fetch network errors into DAEMON_UNAVAILABLE (race between probe and POST)', async () => {
    // Probe succeeds; POST throws (ECONNREFUSED-equivalent).
    const { fetch } = makeFetch([
      { body: { success: true, data: { status: 'ok' } } },
      new Error('ECONNREFUSED'),
    ]);
    const { streams, config } = setup();

    await expect(runOpen('abc', {}, { config, streams, fetch })).rejects.toMatchObject({
      code: 'DAEMON_UNAVAILABLE',
    });
  });
});
