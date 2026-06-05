import { type ResolveBackendInput, resolveBackend } from '../backend/resolve.js';
import type { OwlBackend } from '../backend/types.js';
import type { ResolvedConfig } from './config.js';
import { resolveConfig } from './config.js';
import { detectDaemon } from './daemon-detect.js';
import type { OutputStreams } from './output.js';
import { writeProgress } from './output.js';

/** Global options shared across all commands, coming from commander. */
export interface GlobalOptions {
  json?: boolean;
  pretty?: boolean;
  human?: boolean;
  ndjson?: boolean;
  idOnly?: boolean;
  field?: string;
  raw?: boolean;
  progress?: boolean;
  direct?: boolean;
  force?: boolean;
  overwrite?: boolean;
  config?: string;
  db?: string;
}

export interface CommandContext {
  backend: OwlBackend;
  mode: 'http' | 'direct';
  config: ResolvedConfig;
  streams: OutputStreams;
  opts: GlobalOptions;
}

export interface BuildContextInput {
  opts: GlobalOptions;
  isWrite: boolean;
  streams?: OutputStreams;
  fetch?: typeof fetch;
}

/**
 * Resolve everything a command action needs:
 *   - parse `owl_config.toml`
 *   - probe daemon liveness (200ms timeout)
 *   - pick HTTP or Direct backend per §4.1 rules
 *   - emit any mode-decision warnings to stderr
 *
 * Commands just call this once at the top of their action, use the
 * `backend`, and `await context.backend.close()` in a finally block.
 */
export async function buildContext(input: BuildContextInput): Promise<CommandContext> {
  const streams: OutputStreams = input.streams ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const config = resolveConfig({
    ...(input.opts.config !== undefined ? { configPath: input.opts.config } : {}),
    ...(input.opts.db !== undefined ? { dbPath: input.opts.db } : {}),
  });
  const daemonAlive = await detectDaemon(
    config.daemonPort,
    input.fetch ? { fetch: input.fetch } : {},
  );
  const resolveInput: ResolveBackendInput = {
    isWrite: input.isWrite,
    daemonAlive,
    ...(input.opts.direct !== undefined ? { direct: input.opts.direct } : {}),
    ...(input.opts.force !== undefined ? { force: input.opts.force } : {}),
    ...(input.opts.db !== undefined ? { db: input.opts.db } : {}),
    port: config.daemonPort,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
  const { backend, mode, warnings } = await resolveBackend(resolveInput);
  if (input.opts.progress !== false) {
    for (const warning of warnings) writeProgress({ warning }, { streams });
  }
  return { backend, mode, config, streams, opts: input.opts };
}
