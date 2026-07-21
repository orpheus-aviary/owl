// HTTP transport for the owl daemon REST API. Host-agnostic: the front-end
// injects how to resolve the daemon base URL and (Phase A) what auth headers
// to attach, via `configureTransport`. The client code never knows whether it
// is talking to a local Electron-spawned daemon, a localhost browser daemon,
// or a cloud daemon.

import type { ApiResponse } from './types.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    public errorCode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface TransportConfig {
  /** Resolve the daemon base URL. `''` = same-origin relative (web default). */
  baseUrl: () => string;
  /**
   * Extra headers to attach to every request. Step 0 default is an empty map
   * (no auth); Phase A injects the session bearer + any non-simple CSRF header
   * here, covering all callers through one seam.
   */
  getAuthHeaders: () => Record<string, string>;
  /**
   * Phase B (B1) / 0.6 ④ — invoked when a request comes back 401, carrying the
   * bare bearer token THIS request actually used (`usedToken`, `null` when no
   * bearer was attached). The web host wires this to clear its in-memory session
   * so the auth gate falls back to login — but only when `usedToken` matches the
   * currently-active session, so a late 401 from a request issued under a
   * now-replaced session can't tear down the new one. Host-agnostic: the
   * Electron host leaves it unset, so the hook stays a no-op there.
   */
  onUnauthorized?: (info: UnauthorizedInfo) => void;
}

/** Payload handed to `onUnauthorized` — see {@link TransportConfig.onUnauthorized}. */
export interface UnauthorizedInfo {
  /** The bare bearer (no `Bearer ` prefix) the 401'd request carried, or null. */
  readonly usedToken: string | null;
}

const config: TransportConfig = {
  baseUrl: () => '',
  getAuthHeaders: () => ({}),
};

/**
 * Wire the transport to its host. Call once at front-end startup (and in test
 * setup). Unset fields keep their defaults — `getAuthHeaders` stays the empty
 * map until Phase A supplies one.
 */
export function configureTransport(opts: {
  baseUrl: () => string;
  getAuthHeaders?: () => Record<string, string>;
  onUnauthorized?: (info: UnauthorizedInfo) => void;
}): void {
  config.baseUrl = opts.baseUrl;
  if (opts.getAuthHeaders) config.getAuthHeaders = opts.getAuthHeaders;
  if (opts.onUnauthorized) config.onUnauthorized = opts.onUnauthorized;
}

/**
 * Resolve the daemon base URL. Exported so SSE callers can compose endpoint
 * URLs without re-implementing the lookup.
 */
export function baseUrl(): string {
  return config.baseUrl();
}

/**
 * The host-supplied headers to attach to every request (REST + SSE). Step 0
 * default is empty; Phase A supplies the session bearer / CSRF header through
 * `configureTransport`, covering REST, POST `/ai/chat`, and the `/events`
 * subscription in one place.
 */
export function authHeaders(): Record<string, string> {
  return config.getAuthHeaders();
}

/** Return the body on success, or throw ApiError (firing the 401 hook first). */
function unwrap<T>(res: Response, json: ApiResponse<T>, usedToken: string | null): ApiResponse<T> {
  if (json.success) return json;
  if (res.status === 401) config.onUnauthorized?.({ usedToken });
  throw new ApiError(res.status, json.error_code, json.message ?? 'Unknown error');
}

/** The bare bearer from the outgoing headers, so a 401 reports the token used. */
function bareToken(headers: Record<string, string>): string | null {
  const auth = headers.Authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  retries = 2,
): Promise<ApiResponse<T>> {
  const url = `${baseUrl()}${path}`;
  const headers: Record<string, string> = { ...config.getAuthHeaders() };
  const usedToken = bareToken(headers);
  const init: RequestInit = { method };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (Object.keys(headers).length > 0) init.headers = headers;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      return unwrap(res, (await res.json()) as ApiResponse<T>, usedToken);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (attempt === retries) throw err;
      // Wait before retry (daemon might be restarting)
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error('Unreachable');
}
