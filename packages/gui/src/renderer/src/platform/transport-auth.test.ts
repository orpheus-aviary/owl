import { ApiError, configureTransport, request } from '@orpheus-aviary/owl-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ④ (§5.3) — drives the REAL shared transport to lock the `onUnauthorized`
 * contract both 401 handlers depend on: a 401 must report the BARE bearer the
 * request actually carried (`usedToken`), so the web host can distinguish a 401
 * for the currently-active session from a stale one issued under a replaced
 * session. `configureTransport` is a module singleton; vitest isolates modules
 * per file, so this file's config never leaks into other suites.
 */
describe('transport onUnauthorized({ usedToken })', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function reply401(): Response {
    return new Response(
      JSON.stringify({ success: false, error_code: 'SESSION_INVALID', message: 'no' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('passes the bare bearer the request used', async () => {
    const seen: Array<string | null> = [];
    configureTransport({
      baseUrl: () => '',
      getAuthHeaders: () => ({ Authorization: 'Bearer tok-A' }),
      onUnauthorized: ({ usedToken }) => seen.push(usedToken),
    });
    globalThis.fetch = vi.fn(async () => reply401()) as unknown as typeof fetch;

    await expect(request('GET', '/x')).rejects.toBeInstanceOf(ApiError);
    // Bare token — not the "Bearer …" header — so it compares equal to a stored token.
    expect(seen).toEqual(['tok-A']);
  });

  it('reports null when no bearer was attached', async () => {
    const seen: Array<string | null> = [];
    configureTransport({
      baseUrl: () => '',
      getAuthHeaders: () => ({}),
      onUnauthorized: ({ usedToken }) => seen.push(usedToken),
    });
    globalThis.fetch = vi.fn(async () => reply401()) as unknown as typeof fetch;

    await expect(request('GET', '/x')).rejects.toBeInstanceOf(ApiError);
    expect(seen).toEqual([null]);
  });
});
