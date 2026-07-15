/**
 * Parsers for `additionalArguments` injected into preload via
 * BrowserWindow `webPreferences.additionalArguments`. Pulled out of
 * preload/index.ts so they can be unit tested in vitest without an
 * electron contextBridge context.
 */

export type StartupMode =
  | { mode: 'normal' }
  | { mode: 'migrate-required'; dbPath: string }
  | { mode: 'incompatible'; dbPath: string; dbVersion: number; maxSupported: number };

export const DEFAULT_DAEMON_PORT = 47010;

/**
 * Parse `--startup-mode=<json>`. Malformed JSON falls through to 'normal'
 * instead of throwing — a preload-script crash would strand the user in
 * a blank renderer.
 */
export function parseStartupMode(argv: readonly string[]): StartupMode {
  const prefix = '--startup-mode=';
  const arg = argv.find((a) => a.startsWith(prefix));
  if (!arg) return { mode: 'normal' };
  try {
    return JSON.parse(arg.slice(prefix.length)) as StartupMode;
  } catch {
    return { mode: 'normal' };
  }
}

/**
 * Parse `--daemon-port=<port>` (P5-c G1). Main sends the port it used
 * for the daemon spawn so renderer / preload don't have to know about
 * `OWL_DAEMON_PORT` env. Fallback to 47010 on missing / malformed value
 * so the renderer never sees `undefined` (existing behavior keeps that
 * URL hard-coded; we're just unwinding the hard-code one layer).
 */
export function parseDaemonPort(argv: readonly string[]): number {
  const prefix = '--daemon-port=';
  const arg = argv.find((a) => a.startsWith(prefix));
  if (!arg) return DEFAULT_DAEMON_PORT;
  const value = Number.parseInt(arg.slice(prefix.length), 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) return DEFAULT_DAEMON_PORT;
  return value;
}

export function daemonUrlFromArgv(argv: readonly string[]): string {
  return `http://127.0.0.1:${parseDaemonPort(argv)}`;
}

/**
 * Parse `--daemon-token-path=<path>` (Phase A A6). Main forwards the absolute
 * path to the daemon's 0600 local-token file (the PATH is not secret — the
 * token stays in the file). Preload reads the file to serve
 * `window.owlAPI.getDaemonToken()`. Missing → undefined (no token available).
 */
export function parseDaemonTokenPath(argv: readonly string[]): string | undefined {
  const prefix = '--daemon-token-path=';
  const arg = argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}
