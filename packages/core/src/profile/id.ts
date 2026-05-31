/**
 * P5-d Phase 12/15 — profile identity helpers (blocker B6 / D11).
 *
 * A profile = (server_id, user_id). `profileId` is a deterministic hash so
 * logging into the same account always lands on the same local copy
 * (design §5.1). Pure functions; consumed at login (Phase 15) to compute the
 * id and at storage layout time (Phase 13).
 *
 * Phase 15 (D11): the anchor is **server_id** — a long random identity minted
 * by the skybridge server (0.1.4 `login`/`/server-info`), persisted server-side
 * and migratable. The server's url is *not* part of the id, so moving the
 * deployment / changing the url keeps the same profile. `normalizeServerUrl`
 * stays for url storage / dedup / display only (no longer feeds the id).
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
 * `sha256(serverId + "\n" + userId)` (D11).
 *
 * Both `serverId` and `userId` are opaque server-issued ids, used verbatim
 * (no normalization — the server owns their canonical form). The 32-hex width
 * is a persisted directory name + `active_profile` value — frozen once any
 * profile exists on disk (changing it would orphan existing profiles).
 */
export function computeProfileId(serverId: string, userId: string): string {
  const canonical = `${serverId}\n${userId}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
