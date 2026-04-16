import type { FastifyReply } from 'fastify';

/**
 * Server-Sent Events helpers. We bypass Fastify's `reply.send` because once
 * we've written headers manually, Fastify treats subsequent helper calls as
 * a programming error. All writes go through `reply.raw` (the underlying
 * Node `http.ServerResponse`) so the stream stays open for the agent loop.
 *
 * Wire format:
 *   event: <name>
 *   data: <JSON>
 *   <blank line>
 *
 * Multi-line `data` is serialized as a single JSON line; clients use the
 * `event` name to pick which agent event handler to fire.
 */

/** Begin an SSE response — write status + headers, mark Fastify as hijacked. */
export function initSse(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush headers immediately so the client knows the stream is live even
  // if the first event is delayed (e.g. while the LLM is connecting).
  reply.raw.flushHeaders?.();
}

/** Emit one event. `data` is JSON-stringified and emitted on a single line. */
export function sendSseEvent(reply: FastifyReply, event: string, data: unknown): void {
  if (reply.raw.writableEnded) return;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  reply.raw.write(`event: ${event}\ndata: ${payload}\n\n`);
}

/** Close the SSE stream cleanly. Safe to call more than once. */
export function endSse(reply: FastifyReply): void {
  if (!reply.raw.writableEnded) reply.raw.end();
}
