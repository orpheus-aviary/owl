/**
 * P5-d Phase 12 — profile identity helpers (blocker B6).
 *
 * A profile = (server_url, user_id). `profileId` is a deterministic hash so
 * logging into the same account always lands on the same local copy
 * (design §5.1). Pure functions; consumed at login (Phase 15) to compute the
 * id and at storage layout time (Phase 13). Landed + tested in Phase 12.
 */

import { createHash } from 'node:crypto';

/** Thrown when a server URL can't be parsed or isn't http/https. */
export class InvalidServerUrlError extends Error {
  constructor(readonly input: string) {
    super(`Invalid server URL: ${input}`);
    this.name = 'InvalidServerUrlError';
  }
}

/**
 * Canonicalize a server URL so trivially-different spellings of the same
 * endpoint map to one profile (design §5.1, Phase 12 pinned rules):
 *  - parse with WHATWG `URL`; reject non-parseable / non-http(s) input
 *  - lowercase scheme + host (URL parser does this)
 *  - default port stripped (http:80 / https:443), explicit non-default kept
 *  - path: strip trailing slash(es), keep a non-root prefix (reverse-proxy
 *    base paths like `/owl-sync`); root `/` → ''
 *  - query + hash dropped
 *
 * Examples:
 *  - `HTTP://Example.COM:8443/`  → `http://example.com:8443`
 *  - `https://x:443/api/?q=1#h`  → `https://x/api`
 */
export function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidServerUrlError(input);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidServerUrlError(input);
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Deterministic profile id = first 32 hex chars (128-bit) of
 * `sha256(normalizeServerUrl(serverUrl) + "\n" + userId)`.
 *
 * `userId` is an opaque server-issued id, used verbatim. The 32-hex width is
 * a persisted directory name + `active_profile` value — frozen once any
 * profile exists on disk (changing it would orphan existing profiles).
 */
export function computeProfileId(serverUrl: string, userId: string): string {
  const canonical = `${normalizeServerUrl(serverUrl)}\n${userId}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
