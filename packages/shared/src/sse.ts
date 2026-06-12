// Server-Sent Events for the owl daemon, host-agnostic (routes through the
// configured transport: base URL + auth headers).
//
// Two shapes share one low-level frame parser:
//   - `streamSse`  — POST (e.g. `/ai/chat`), single-shot, JSON-parses `data`
//     into `unknown` (the AI dispatcher consumes parsed payloads).
//   - `subscribeSse` — GET (e.g. `/events`), auto-reconnecting, delivers the
//     RAW `data` string (the renderer's `handleDaemonEvent` parses it itself).
//
// Wire grammar (https://html.spec.whatwg.org/multipage/server-sent-events.html):
//   event-block := (line "\n")+ ; two newlines terminate a block; `:` comment.

import { authHeaders, baseUrl } from './transport.js';

export class SseHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
  ) {
    super(`SSE request failed: ${status} ${statusText}`);
    this.name = 'SseHttpError';
  }
}

export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/**
 * Parse one event block into its event name + raw (un-decoded) data string.
 * Multi-line `data:` fields are joined with `\n`; `:`-comments and blank lines
 * are skipped; a block with no `event:` field yields `null`. Pure + exported
 * so the framing logic is unit-testable without a stream.
 */
export function parseSseBlock(block: string, warn?: (msg: string) => void): SseFrame | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    } else {
      warn?.(`unrecognised SSE line: ${line}`);
    }
  }
  if (!event) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * Read an SSE body stream chunk-by-chunk, splitting on `\n\n` boundaries and
 * invoking `onFrame` with each parsed (raw-data) frame. Resolves when the
 * stream ends or the caller aborts. Releases the reader on the way out.
 */
async function readFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onFrame: (frame: SseFrame) => void,
  warn: (msg: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const frame = parseSseBlock(buffer.slice(0, sep), warn);
        buffer = buffer.slice(sep + 2);
        if (frame) onFrame(frame);
        sep = buffer.indexOf('\n\n');
      }
    }
    // Drain a final un-terminated block (servers SHOULD end with \n\n).
    if (buffer.trim()) {
      const frame = parseSseBlock(buffer, warn);
      if (frame) onFrame(frame);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the reader is mid-read; safe to ignore.
    }
  }
}

// ─── POST stream (e.g. /ai/chat) — parses data to unknown ───────────────

export interface StreamSseOptions {
  /** Path appended to the configured base URL. */
  path: string;
  /** JSON body — stringified internally. */
  body: unknown;
  /** Caller-controlled abort. When triggered, the function resolves cleanly. */
  signal?: AbortSignal;
  /** Called for every parsed event. Throwing here aborts the stream. */
  onEvent: (event: string, data: unknown) => void;
  /** Optional logger for malformed lines. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

/**
 * Open a POST SSE stream. Resolves when the server closes the stream OR the
 * caller aborts. Throws `SseHttpError` on non-2xx, or anything thrown by
 * `onEvent`. `data` is JSON-parsed into `unknown` (falls back to the raw
 * string for non-JSON, e.g. multi-line data).
 */
export async function streamSse(options: StreamSseOptions): Promise<void> {
  const warn = options.warn ?? ((msg) => console.warn('[sse-client]', msg));

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${options.path}`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (err) {
    // Abort before / mid headers — resolve cleanly.
    if (isAbortError(err) || options.signal?.aborted) return;
    throw err;
  }

  if (!response.ok) {
    throw new SseHttpError(response.status, response.statusText, await safeReadText(response));
  }
  if (!response.body) return;

  try {
    await readFrames(
      response.body,
      options.signal,
      (frame) => {
        let data: unknown = frame.data;
        if (frame.data) {
          try {
            data = JSON.parse(frame.data);
          } catch {
            warn(`event ${frame.event} had non-JSON data; passing through as string`);
          }
        }
        options.onEvent(frame.event, data);
      },
      warn,
    );
  } catch (err) {
    if (isAbortError(err) || options.signal?.aborted) return;
    throw err;
  }
}

// ─── GET subscription (e.g. /events) — raw data, auto-reconnect ──────────

export interface SubscribeSseOptions {
  /** Path appended to the configured base URL. */
  path: string;
  /** Required — aborting it tears down the subscription (no manual reconnect). */
  signal: AbortSignal;
  /** Called for every event with the RAW `data` string (caller parses). */
  onEvent: (event: string, rawData: string) => void;
  /** Optional logger for malformed lines / connection errors. */
  warn?: (msg: string) => void;
  /** Called once per failed/closed connection, before the backoff wait. */
  onError?: (err: unknown) => void;
  /** Backoff schedule (ms) per consecutive failed attempt; reset on connect. */
  backoffMs?: readonly number[];
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000] as const;

/**
 * Subscribe to a GET SSE endpoint with automatic reconnect. Replaces native
 * `EventSource` so the request can carry auth headers (Phase A). Reconnects on
 * any close/error with exponential backoff (reset on a successful connect) and
 * stops only when `signal` aborts. Fire-and-forget: the loop owns its own
 * lifecycle.
 */
export function subscribeSse(options: SubscribeSseOptions): void {
  const warn = options.warn ?? ((msg) => console.warn('[sse-subscribe]', msg));
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const { signal } = options;
  let attempt = 0;

  const connectOnce = async (): Promise<void> => {
    const response = await fetch(`${baseUrl()}${options.path}`, {
      method: 'GET',
      headers: { ...authHeaders(), Accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok) {
      throw new SseHttpError(response.status, response.statusText, await safeReadText(response));
    }
    if (!response.body) return; // nothing to read → treat as a closed connection
    attempt = 0; // connected — reset backoff
    await readFrames(
      response.body,
      signal,
      (frame) => options.onEvent(frame.event, frame.data),
      warn,
    );
  };

  const loop = async (): Promise<void> => {
    while (!signal.aborted) {
      try {
        await connectOnce();
      } catch (err) {
        if (isAbortError(err) || signal.aborted) return;
        options.onError?.(err);
        warn(`subscribe ${options.path} error: ${String(err)}`);
      }
      if (signal.aborted) return;
      const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
      attempt++;
      await sleep(delay, signal);
    }
  };

  void loop();
}

// ─── Internals ──────────────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')
  );
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
