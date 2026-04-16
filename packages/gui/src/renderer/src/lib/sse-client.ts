/**
 * Tiny SSE client built on `fetch` + `ReadableStream`.
 *
 * Why not native `EventSource`: EventSource only supports GET requests
 * with no custom body, so it can't drive `POST /ai/chat`. The wire
 * format is the same though, so we re-implement just enough of it.
 *
 * Wire grammar (https://html.spec.whatwg.org/multipage/server-sent-events.html):
 *
 *   stream  := (event-block "\n")*
 *   event-block := (line "\n")+
 *   line    := "event: <name>" | "data: <payload>" | ":<comment>" | ""
 *
 * Two consecutive newlines terminate an event. A line starting with `:`
 * is a comment and is ignored. Multi-line `data:` are joined with `\n`.
 */

export interface SseStreamOptions {
  /** Endpoint to POST to. */
  url: string;
  /** JSON body — stringified internally. */
  body: unknown;
  /** Caller-controlled abort. When triggered, the function resolves cleanly. */
  signal?: AbortSignal;
  /** Called for every parsed event. Throwing here aborts the stream. */
  onEvent: (event: string, data: unknown) => void;
  /** Optional logger for malformed lines. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

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

/**
 * Open an SSE stream. Resolves when the server closes the stream OR the
 * caller aborts. Throws `SseHttpError` on non-2xx responses, or any error
 * thrown by `onEvent` (so the caller can log + show an error bubble).
 */
export async function streamSse(options: SseStreamOptions): Promise<void> {
  const warn = options.warn ?? ((msg) => console.warn('[sse-client]', msg));

  const response = await fetch(options.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await safeReadText(response);
    throw new SseHttpError(response.status, response.statusText, body);
  }
  if (!response.body) {
    // Some test environments hand back null bodies for empty 200s.
    return;
  }

  try {
    await pumpReader(response.body, options.signal, options.onEvent, warn);
  } catch (err) {
    // Aborts surface as DOMException; treat as clean exit.
    if (isAbortError(err) || options.signal?.aborted) return;
    throw err;
  }
}

/**
 * Read from `body` chunk-by-chunk, splitting on `\n\n` event boundaries
 * and dispatching each block. Releases the reader on the way out.
 */
async function pumpReader(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onEvent: (event: string, data: unknown) => void,
  warn: (msg: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      // Cooperative abort check — fetch's signal handling already aborts the
      // underlying request, but the await on read() may resolve with the
      // last chunk before propagating, so we re-check here too.
      if (signal?.aborted) return;

      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        dispatchBlock(block, onEvent, warn);
        sep = buffer.indexOf('\n\n');
      }
    }
    // Drain any final un-terminated block (servers SHOULD end with \n\n
    // but we shouldn't crash on a stray last event).
    if (buffer.trim()) dispatchBlock(buffer, onEvent, warn);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the reader is mid-read; safe to ignore.
    }
  }
}

// ─── Internals ─────────────────────────────────────────────────────────

function dispatchBlock(
  block: string,
  onEvent: (event: string, data: unknown) => void,
  warn: (msg: string) => void,
): void {
  let event = '';
  const dataLines: string[] = [];

  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    } else {
      warn(`unrecognised SSE line: ${line}`);
    }
  }

  if (!event) return; // No `event:` field → ignore (we always pair them server-side).

  const raw = dataLines.join('\n');
  let data: unknown = raw;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      // Server promised JSON; warn and pass the raw string so caller can decide.
      warn(`event ${event} had non-JSON data; passing through as string`);
    }
  }
  onEvent(event, data);
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
