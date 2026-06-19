// The daemon's HTTP API path prefixes — the single source of truth for the
// "is this request an API call, or a static/SPA asset?" split. Consumed by:
//   - the daemon's cloud auth gate (API paths require a bearer; everything else
//     is the public web shell) and its route-coverage test, and
//   - apps/web's Vite dev proxy (forwards exactly these prefixes to the daemon).
//
// Kept a pure constant + pure function (no fetch / DOM) so the daemon can import
// it via the `./api-paths` subpath export without pulling in the HTTP client.
// When a new top-level API route group is added, add its prefix here — the
// daemon's route-coverage test fails until every registered route is covered.

export const API_PREFIXES = [
  '/ai',
  '/api',
  '/auth',
  '/config',
  '/conflicts',
  '/events',
  '/folders',
  '/llm',
  '/notes',
  '/parse-tag',
  '/reminders',
  '/status',
  '/sync',
  '/tags',
  '/todos',
] as const;

/** Whether `url`'s path is a daemon API call (vs a static / SPA asset). */
export function isApiPath(url: string): boolean {
  const path = url.split('?')[0];
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
