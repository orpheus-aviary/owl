/**
 * Probe the local daemon's HTTP `/status` endpoint.
 *
 * Returns `true` only when the request completes within the timeout and
 * the response body carries `success: true` — anything else (non-200,
 * malformed JSON, connection refused, timeout) is treated as "not
 * running". Port is read from owl_config.toml `[daemon].port` (default
 * 47010) — never hardcoded at the call site.
 */
export async function detectDaemon(
  port: number,
  env: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = env.timeoutMs ?? 200;
  const doFetch = env.fetch ?? fetch;
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { success?: unknown };
    return body?.success === true;
  } catch {
    return false;
  }
}
