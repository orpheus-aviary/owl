import { configureTransport } from '@orpheus-aviary/owl-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type SseDisconnect,
  SseHttpError,
  parseSseBlock,
  streamSse,
  subscribeSse,
} from './sse-client';

/**
 * Build a Response whose body streams the given chunks. Each chunk is
 * encoded as UTF-8 and pushed individually so the parser sees real chunk
 * boundaries (which is what exercises the partial-chunk buffering logic).
 */
function makeStreamingResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, init);
}

describe('streamSse', () => {
  it('parses a single complete event', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeStreamingResponse(['event: hello\ndata: {"x":1}\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const events: Array<[string, unknown]> = [];
    await streamSse({
      path: '/ai/chat',
      body: { message: 'hi' },
      onEvent: (e, d) => events.push([e, d]),
    });

    expect(events).toEqual([['hello', { x: 1 }]]);
    vi.unstubAllGlobals();
  });

  it('reassembles events split across chunk boundaries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeStreamingResponse([
          'event: pa',
          'rt\ndata: ',
          '"hello"',
          '\n\nevent: second\ndata: 2\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const events: Array<[string, unknown]> = [];
    await streamSse({
      path: '/ai/chat',
      body: {},
      onEvent: (e, d) => events.push([e, d]),
    });

    expect(events).toEqual([
      ['part', 'hello'],
      ['second', 2],
    ]);
    vi.unstubAllGlobals();
  });

  it('joins multi-line data fields with newline', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          makeStreamingResponse(['event: multiline\ndata: line1\ndata: line2\n\n']),
        ),
    );
    const events: Array<[string, unknown]> = [];
    await streamSse({
      path: '/x',
      body: {},
      onEvent: (e, d) => events.push([e, d]),
    });
    // Multi-line data isn't valid JSON → comes through as raw string with `\n`.
    expect(events).toEqual([['multiline', 'line1\nline2']]);
    vi.unstubAllGlobals();
  });

  it('ignores comment lines and blank events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeStreamingResponse([
          ':keepalive\n\n', // comment-only block, should be a no-op
          'event: real\ndata: 1\n\n',
        ]),
      ),
    );
    const events: Array<[string, unknown]> = [];
    await streamSse({
      path: '/x',
      body: {},
      onEvent: (e, d) => events.push([e, d]),
    });
    expect(events).toEqual([['real', 1]]);
    vi.unstubAllGlobals();
  });

  it('drains a final un-terminated block', async () => {
    // Server forgot the trailing \n\n — we should still surface the event.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeStreamingResponse(['event: tail\ndata: "x"'])),
    );
    const events: Array<[string, unknown]> = [];
    await streamSse({
      path: '/x',
      body: {},
      onEvent: (e, d) => events.push([e, d]),
    });
    expect(events).toEqual([['tail', 'x']]);
    vi.unstubAllGlobals();
  });

  it('throws SseHttpError on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('LLM not configured', { status: 400, statusText: 'Bad Request' }),
        ),
    );
    await expect(streamSse({ path: '/x', body: {}, onEvent: () => {} })).rejects.toBeInstanceOf(
      SseHttpError,
    );
    vi.unstubAllGlobals();
  });

  it('exits cleanly when the caller aborts mid-stream', async () => {
    const controller = new AbortController();
    // Stream that yields a chunk, waits, then would yield more.
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('event: first\ndata: 1\n\n'));
        // Give the consumer a tick to dispatch + abort.
        await new Promise((r) => setTimeout(r, 5));
        controller.abort();
        // After abort, fetch should have torn down the underlying body, but
        // for our mock we just close cleanly so nothing throws.
        c.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));

    const events: Array<[string, unknown]> = [];
    await streamSse({
      path: '/x',
      body: {},
      signal: controller.signal,
      onEvent: (e, d) => {
        events.push([e, d]);
      },
    });

    expect(events).toEqual([['first', 1]]);
    vi.unstubAllGlobals();
  });

  it('skips events with no `event:` field', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(makeStreamingResponse(['data: orphan\n\nevent: kept\ndata: 1\n\n'])),
    );
    const events: Array<[string, unknown]> = [];
    await streamSse({
      path: '/x',
      body: {},
      onEvent: (e, d) => events.push([e, d]),
    });
    expect(events).toEqual([['kept', 1]]);
    vi.unstubAllGlobals();
  });

  it('warns on unrecognised lines but keeps parsing', async () => {
    const warn = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeStreamingResponse(['event: ok\nweird: nope\ndata: 1\n\n'])),
    );
    const events: Array<[string, unknown]> = [];
    await streamSse({
      path: '/x',
      body: {},
      warn,
      onEvent: (e, d) => events.push([e, d]),
    });
    expect(events).toEqual([['ok', 1]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrecognised'));
    vi.unstubAllGlobals();
  });
});

describe('parseSseBlock', () => {
  it('parses an event + single data line', () => {
    expect(parseSseBlock('event: x\ndata: hi')).toEqual({ event: 'x', data: 'hi' });
  });

  it('returns null when there is no event field', () => {
    expect(parseSseBlock('data: orphan')).toBeNull();
  });

  it('joins multi-line data with newline and skips comments', () => {
    expect(parseSseBlock(':keepalive\nevent: m\ndata: a\ndata: b')).toEqual({
      event: 'm',
      data: 'a\nb',
    });
  });

  it('warns on unrecognised lines', () => {
    const warn = vi.fn();
    parseSseBlock('event: ok\nweird: nope\ndata: 1', warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrecognised'));
  });
});

describe('subscribeSse', () => {
  it('delivers RAW data strings and reconnects after the stream closes', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(makeStreamingResponse(['event: a\ndata: 1\n\n']));
      if (calls === 2) return Promise.resolve(makeStreamingResponse(['event: b\ndata: 2\n\n']));
      // 3rd connect: stop the loop, hand back an already-drained stream.
      controller.abort();
      return Promise.resolve(makeStreamingResponse([]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const events: Array<[string, string]> = [];
    subscribeSse({
      path: '/events',
      signal: controller.signal,
      backoffMs: [0],
      onEvent: (e, d) => events.push([e, d]),
    });

    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2));
    // RAW strings — NOT JSON-parsed (handleDaemonEvent parses downstream).
    expect(events).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
    vi.unstubAllGlobals();
  });

  it('stops on abort without reconnecting', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(makeStreamingResponse(['event: a\ndata: 1\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const events: Array<[string, string]> = [];
    subscribeSse({
      path: '/events',
      signal: controller.signal,
      backoffMs: [1000],
      onEvent: (e, d) => events.push([e, d]),
    });

    await vi.waitFor(() => expect(events).toEqual([['a', '1']]));
    controller.abort();
    await new Promise((r) => setTimeout(r, 20));
    // Loop was sleeping out the backoff when aborted → no second connect.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('fires onDisconnect with the error and retries on a non-2xx connection', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response('boom', { status: 500, statusText: 'Server Error' }));
      }
      controller.abort();
      return Promise.resolve(makeStreamingResponse([]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const disconnects: SseDisconnect[] = [];
    subscribeSse({
      path: '/events',
      signal: controller.signal,
      backoffMs: [0],
      onEvent: () => {},
      onDisconnect: (i) => disconnects.push(i),
      warn: () => {},
    });

    await vi.waitFor(() => expect(disconnects.length).toBeGreaterThanOrEqual(1));
    expect(disconnects[0].clean).toBe(false);
    expect(disconnects[0].error).toBeInstanceOf(SseHttpError);
    vi.unstubAllGlobals();
  });
});

// ① — the exactly-once disconnect contract that ① (status re-probe) and ④ (web
// 401 deactivation) both hang off. Fires once per connection lifecycle end,
// EXCEPT on abort; carries the bearer token THIS attempt actually used.
describe('subscribeSse onDisconnect (①)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    configureTransport({ baseUrl: () => '', getAuthHeaders: () => ({}) });
  });

  /** Drive until the first onDisconnect, aborting there to stop reconnecting. */
  function runUntilDisconnect(
    fetchImpl: () => Promise<unknown>,
    authHeaders: () => Record<string, string> = () => ({}),
  ): Promise<SseDisconnect> {
    configureTransport({ baseUrl: () => '', getAuthHeaders: authHeaders });
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const controller = new AbortController();
    return new Promise<SseDisconnect>((resolve) => {
      subscribeSse({
        path: '/events',
        signal: controller.signal,
        backoffMs: [0],
        warn: () => {},
        onEvent: () => {},
        onDisconnect: (info) => {
          controller.abort();
          resolve(info);
        },
      });
    });
  }

  it('clean EOF: stream ends → { clean: true, error: null }', async () => {
    const info = await runUntilDisconnect(async () =>
      makeStreamingResponse(['event: hello\ndata: \n\n']),
    );
    expect(info.clean).toBe(true);
    expect(info.error).toBe(null);
  });

  it('no body: ok response with null body → { clean: true, error: null }', async () => {
    const info = await runUntilDisconnect(async () => new Response(null, { status: 200 }));
    expect(info.clean).toBe(true);
    expect(info.error).toBe(null);
  });

  it('thrown error: non-2xx → { clean: false, error: SseHttpError }', async () => {
    const info = await runUntilDisconnect(
      async () => new Response('boom', { status: 500, statusText: 'Server Error' }),
    );
    expect(info.clean).toBe(false);
    expect(info.error).toBeInstanceOf(SseHttpError);
    expect((info.error as SseHttpError).status).toBe(500);
  });

  it('abort mid-connection → onDisconnect NEVER fires', async () => {
    configureTransport({ baseUrl: () => '', getAuthHeaders: () => ({}) });
    // A fetch that stays pending until the signal aborts, then rejects like the
    // real platform does — so recovery hinges on `signal.aborted`, not on the
    // error shape (a DOMException is not `instanceof Error`).
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    );
    const controller = new AbortController();
    const onDisconnect = vi.fn();
    subscribeSse({
      path: '/events',
      signal: controller.signal,
      backoffMs: [0],
      warn: () => {},
      onEvent: () => {},
      onDisconnect,
    });
    await Promise.resolve(); // let the loop reach the pending fetch
    controller.abort();
    await new Promise((r) => setTimeout(r, 5));
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('captures the bearer token used for THIS attempt (strips "Bearer ")', async () => {
    const info = await runUntilDisconnect(
      async () => new Response(null, { status: 200 }),
      () => ({ Authorization: 'Bearer tok-abc' }),
    );
    expect(info.usedToken).toBe('tok-abc');
  });

  it('usedToken is null when no Authorization header is configured', async () => {
    const info = await runUntilDisconnect(async () => new Response(null, { status: 200 }));
    expect(info.usedToken).toBe(null);
  });
});
