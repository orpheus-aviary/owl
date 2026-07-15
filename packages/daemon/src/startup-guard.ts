/**
 * Phase A (slice A0) — daemon startup guards.
 *
 * A pure, fail-closed gate run once at boot (before `server.listen`, before
 * any side effect). It validates the new `[daemon]` fields and refuses to
 * start on any unsafe / incoherent deployment combination, so a misconfigured
 * cloud daemon never comes up half-secured.
 *
 * Design: `docs/plans/2026-06-12-phase-a-cloud-daemon-design.md` §3.3 (6 guards).
 * Kept side-effect-free (the resolved AI key is injected) so it unit-tests
 * without disk / network — `cli.ts` is the only place that touches the world.
 *
 * NOTE: this is config validation only. The actual auth / CORS / Host / session
 * machinery lands in A1–A5; A0 just makes the daemon refuse to boot when its
 * config can't be honoured safely. `mode='local'` defaults preserve today's
 * behaviour exactly (only the loopback-bind check applies, which already holds).
 */

import { type DaemonConfig, type OwlConfig, isHexProfileId, normalizeServerUrl } from '@owl/core';

export class DaemonStartupError extends Error {
  readonly code = 'DAEMON_STARTUP_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'DaemonStartupError';
  }
}

/** Loopback host names/addresses that may be bound without endpoint auth. */
const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

function isLoopbackBind(bind: string): boolean {
  return LOOPBACK_BINDS.has(bind);
}

/** Validate a URL-shaped field via core's `normalizeServerUrl` (http/https only). */
function assertUrl(field: string, value: string): void {
  try {
    normalizeServerUrl(value);
  } catch {
    throw new DaemonStartupError(
      `${field}: invalid URL ${JSON.stringify(value)} (expected http(s)://…)`,
    );
  }
}

/**
 * Validate a Host header value: `host[:port]`, IPv4, bracketed IPv6, or a
 * hostname. Deliberately NOT a URL parser — `allowed_hosts` holds Host values,
 * not URLs (design §3.3 ⑥).
 */
function assertHost(field: string, value: string): void {
  const ok = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(value);
  if (!ok) {
    throw new DaemonStartupError(
      `${field}: invalid host ${JSON.stringify(value)} (expected host[:port] / IP / localhost, not a URL)`,
    );
  }
}

export interface StartupGuardOptions {
  /**
   * The resolved LLM api_key (`resolveLlmConfig(config).api_key`), injected so
   * this stays pure. Used only by the cloud `off` + server-AI-key guard (⑤).
   */
  resolvedApiKey: string;
}

/**
 * ⑥ shape validation (both modes) — run first so a typo'd field reports clearly
 * rather than mis-tripping a policy guard below.
 */
function assertDaemonShape(d: DaemonConfig): void {
  if (d.mode !== 'local' && d.mode !== 'cloud') {
    throw new DaemonStartupError(
      `[daemon].mode must be 'local' or 'cloud' (got ${JSON.stringify(d.mode)})`,
    );
  }
  if (typeof d.bind !== 'string' || d.bind.length === 0) {
    throw new DaemonStartupError('[daemon].bind must be a non-empty string');
  }
  if (
    d.session_ttl_min !== undefined &&
    (typeof d.session_ttl_min !== 'number' ||
      !Number.isFinite(d.session_ttl_min) ||
      d.session_ttl_min <= 0)
  ) {
    throw new DaemonStartupError('[daemon].session_ttl_min must be a positive number (minutes)');
  }
}

/**
 * Cloud-only fail-closed guards: fixed skybridge URL (2), explicit account_lock
 * (①), no server-side AI key when switchable (⑤), a public host source (②), and
 * URL / host field validation (⑥). Only reached for `mode==='cloud'`.
 */
function assertCloudGuards(d: DaemonConfig, opts: StartupGuardOptions): void {
  // Guard 2 — cloud needs a fixed skybridge URL.
  if (!d.server_url || !d.server_url.trim()) {
    throw new DaemonStartupError(
      "mode='cloud' requires [daemon].server_url (the fixed skybridge URL)",
    );
  }
  assertUrl('[daemon].server_url', d.server_url);

  // Guard ① — account_lock must be explicit; absent → refuse (fail-closed).
  if (d.account_lock === undefined || d.account_lock === '') {
    throw new DaemonStartupError(
      "mode='cloud' requires [daemon].account_lock = '<profileId>' or 'off'. Bootstrap: run " +
        '`owl-server compute-owner --server-url <url> --email <email>` to print the owner profileId, or (only if no ' +
        "server-side AI key) set account_lock='off', log in once, and copy the 'account logged in: profileId=<x>' log line.",
    );
  }
  if (d.account_lock !== 'off' && !isHexProfileId(d.account_lock)) {
    throw new DaemonStartupError(
      `[daemon].account_lock must be 'off' or a 32-hex profileId (got ${JSON.stringify(d.account_lock)})`,
    );
  }

  // Guard ⑤ — switchable cloud must not hold a server-side AI key (burn risk).
  if (d.account_lock === 'off' && opts.resolvedApiKey.trim()) {
    throw new DaemonStartupError(
      "mode='cloud' + account_lock='off' must not hold a server-side AI key (a borrowing account could burn it). " +
        'Lock to an owner (account_lock=<profileId>) or remove the AI api_key.',
    );
  }

  // Guard ② — cloud needs a public host source (regardless of bind: the prod
  // path is cloud + loopback bind + reverse proxy, where a missing public_url
  // would let the daemon start but then block the proxy's Host header).
  const hasPublicUrl = !!d.public_url?.trim();
  const hasAllowedHosts = (d.allowed_hosts?.length ?? 0) > 0;
  if (!hasPublicUrl && !hasAllowedHosts) {
    throw new DaemonStartupError(
      "mode='cloud' requires [daemon].public_url or [daemon].allowed_hosts (otherwise the Host check blocks " +
        "reverse-proxied requests). For local simulation set public_url='http://127.0.0.1:<port>'.",
    );
  }

  assertCloudUrlFields(d);
}

/** ⑥ cloud URL / host field validation (public_url, allowed_origins[], allowed_hosts[]). */
function assertCloudUrlFields(d: DaemonConfig): void {
  if (d.public_url) assertUrl('[daemon].public_url', d.public_url);
  for (const origin of d.allowed_origins ?? []) assertUrl('[daemon].allowed_origins[]', origin);
  for (const host of d.allowed_hosts ?? []) assertHost('[daemon].allowed_hosts[]', host);
}

/**
 * Throw `DaemonStartupError` if the config can't be served safely. Returns
 * normally when the daemon may boot. `cli.ts` logs the message + exits(1).
 */
export function assertDaemonStartupSafe(config: OwlConfig, opts: StartupGuardOptions): void {
  const d = config.daemon;

  assertDaemonShape(d);

  // Guard 1 (red line) — a non-loopback bind without endpoint auth is forbidden.
  // local mode has no Layer-2 auth, so it may only bind loopback.
  if (!isLoopbackBind(d.bind) && d.mode === 'local') {
    throw new DaemonStartupError(
      `[daemon].bind=${JSON.stringify(d.bind)} (non-loopback) requires mode='cloud'; local mode must bind a loopback address`,
    );
  }

  if (d.mode === 'local') return; // local: nothing further (A6-前零行为变更)

  assertCloudGuards(d, opts);
}
