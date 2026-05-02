import type { ResolvedConfig } from '../lib/config.js';
import { detectDaemon } from '../lib/daemon-detect.js';
import { CliError } from '../lib/errors.js';
import type { OutputStreams } from '../lib/output.js';
import { writeResult } from '../lib/output.js';

export interface OpenFlags {
  pretty?: boolean;
}

export interface OpenContext {
  config: ResolvedConfig;
  streams: OutputStreams;
  /** Test seam — production passes undefined and uses the global fetch. */
  fetch?: typeof fetch;
}

interface EmitEnvelope {
  success?: boolean;
  data?: { subscribers: number };
  error_code?: string;
  message?: string;
}

/**
 * POST /events/emit and parse the envelope. The daemon can disappear
 * between probe and POST (kill, Cmd+Q, crash), so we turn transport /
 * parse errors into structured CliErrors rather than letting them
 * bubble as UNKNOWN.
 */
async function emitOpenNote(
  port: number,
  noteId: string,
  doFetch: typeof fetch,
): Promise<EmitEnvelope & { _status: number }> {
  let res: Response;
  try {
    res = await doFetch(`http://127.0.0.1:${port}/events/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'open_note', note_id: noteId }),
    });
  } catch (err) {
    throw new CliError(
      'DAEMON_UNAVAILABLE',
      `daemon stopped responding during /events/emit: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let envelope: EmitEnvelope;
  try {
    envelope = (await res.json()) as EmitEnvelope;
  } catch (err) {
    throw new CliError(
      'HTTP_ERROR',
      `/events/emit returned non-JSON body (${res.status}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { ...envelope, _status: res.status };
}

/**
 * `owl open <id>` — ask the daemon to push an `open_note` event to every
 * live GUI subscriber.
 *
 * Intentionally **HTTP-only**: this command is a pure GUI-targeted
 * action, so a running daemon is required regardless of `--direct` /
 * `--db` (those flags exist globally for CRUD commands but are silently
 * ignored here — see command registration in `index.ts`).
 *
 * Subscriber count = 0 is NOT an error: the daemon may be up with no
 * GUI window attached. We print a stderr warning and still exit 0 so
 * scripts can keep rolling.
 */
export async function runOpen(noteId: string, flags: OpenFlags, ctx: OpenContext): Promise<void> {
  const port = ctx.config.daemonPort;
  const alive = await detectDaemon(port, ctx.fetch ? { fetch: ctx.fetch } : {});
  if (!alive) {
    throw new CliError(
      'DAEMON_UNAVAILABLE',
      'owl open requires a running GUI (daemon not reachable). Start the GUI and try again.',
    );
  }

  const envelope = await emitOpenNote(port, noteId, ctx.fetch ?? fetch);

  if (envelope._status === 404 || envelope.error_code === 'NOTE_NOT_FOUND') {
    throw new CliError('NOTE_NOT_FOUND', envelope.message ?? 'note not found', {
      note_id: noteId,
    });
  }
  if (!envelope.success || !envelope.data) {
    throw new CliError(
      'HTTP_ERROR',
      envelope.message ?? `/events/emit failed (${envelope._status})`,
    );
  }

  const subscribers = envelope.data.subscribers;
  if (subscribers === 0) {
    ctx.streams.stderr.write(
      'warning: daemon is running but no GUI window is subscribed — note was not displayed\n',
    );
  }

  writeResult(
    { opened: noteId, subscribers },
    { streams: ctx.streams, pretty: flags.pretty ?? false },
  );
}
