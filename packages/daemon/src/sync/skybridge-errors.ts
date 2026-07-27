/**
 * Duck-typed classifiers for `@orpheus-aviary/skybridge-client` errors.
 *
 * The daemon never `import`s that module statically (it's an optional dep
 * loaded via a variable-specifier dynamic import so a clean checkout without
 * skybridge installed still passes `tsc -b`), so `instanceof ApiError` is not
 * available here. The client sets `name` on both error classes
 * (`ApiError` carries `code` + `status`, `NetworkError` wraps transport
 * failures), which is what these predicates key off.
 *
 * Extracted out of `manual.ts` (Problem A / Phase 2B): `cloud-login.ts` needs
 * the same classification, and `manual.ts` needs to call into `cloud-login.ts`
 * for the 401 → refresh path — importing each other directly would create a
 * cycle.
 */

/** Transport-level failure (TCP, abort, DNS, JSON parse) — always retryable. */
export function isNetworkError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'NetworkError' || name === 'FetchError';
}

/** A protocol-level error carrying an HTTP status. */
export function isApiError(err: unknown): err is { status: number; message: string } {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'ApiError' && typeof (err as { status?: unknown }).status === 'number';
}

/**
 * Refresh-token verdicts the server distinguishes. `/auth/refresh` answers
 * `REFRESH_INVALID` for a token that is unknown / expired / revoked by
 * logout or device-revoke, and `REFRESH_REPLAYED` when a rotated token is
 * presented again (the whole family gets nuked). Everything else — network
 * blips, 5xx, an unexpected 4xx — leaves the stored refresh token usable.
 */
const DEAD_REFRESH_CODES: ReadonlySet<string> = new Set(['REFRESH_INVALID', 'REFRESH_REPLAYED']);

/**
 * Is this refresh failure permanent (credentials must be dropped, the user
 * has to log in again) or transient (keep credentials, retry later)?
 *
 * Fails SAFE toward `transient`: only an explicit server verdict counts as
 * dead. Treating an unexpected error as permanent would drop the credential
 * store — on a cloud daemon that also kills every Layer-2 browser session —
 * and one network blip would look identical to a real logout.
 */
export function isRefreshTokenDead(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { name?: unknown }).name !== 'ApiError') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && DEAD_REFRESH_CODES.has(code);
}
