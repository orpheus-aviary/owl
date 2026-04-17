import type { FastifyReply, FastifyRequest } from 'fastify';

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

/**
 * Begin an SSE response — write status + headers, mark Fastify as hijacked.
 *
 * `reply.hijack()` skips Fastify's onSend hook chain, which means the
 * `@fastify/cors` plugin's header injection never runs. We re-apply the
 * CORS echo inline here so browsers fetching `/ai/chat` from the GUI dev
 * server (port 5173) pass the preflight-less POST allow-origin check.
 */
export function initSse(reply: FastifyReply, req: FastifyRequest): void {
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  if (typeof origin === 'string' && origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers.Vary = 'Origin';
  }

  reply.hijack();
  reply.raw.writeHead(200, headers);
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
