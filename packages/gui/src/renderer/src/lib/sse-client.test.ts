import { describe, expect, it, vi } from 'vitest';
import { SseHttpError, streamSse } from './sse-client';

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
      url: '/ai/chat',
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
      url: '/ai/chat',
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
      url: '/x',
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
      url: '/x',
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
      url: '/x',
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
    await expect(streamSse({ url: '/x', body: {}, onEvent: () => {} })).rejects.toBeInstanceOf(
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
      url: '/x',
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
      url: '/x',
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
      url: '/x',
      body: {},
      warn,
      onEvent: (e, d) => events.push([e, d]),
    });
    expect(events).toEqual([['ok', 1]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrecognised'));
    vi.unstubAllGlobals();
  });
});
