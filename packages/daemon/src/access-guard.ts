/**
 * Phase A (slice A1) — cross-origin / DNS-rebinding hardening.
 *
 * Two orthogonal, mode-aware gates (design §4.1):
 *   - CORS origin allowlist (replaces the old `origin: true`) — controls who
 *     may READ responses cross-origin.
 *   - Host header check — CORS can't stop a simple-request DNS-rebinding attack
 *     (a page at attacker.com that resolves to 127.0.0.1 and sends a spoofed
 *     Host), so the Host value is validated separately.
 *
 * local mode (default — the shipped desktop): allow the Electron renderer
 * (dev → loopback http origin; prod `loadFile` → Origin `'null'`) + localhost
 * browsers + CLI (no Origin); Host must be loopback. This is STRICTLY better
 * than today's `origin: true`, but does NOT close cross-site simple-POST CSRF
 * — that needs the per-request token deferred to A6 (design §7 A6 / §10).
 *
 * cloud mode: allow only the configured public_url origin + allowed_origins;
 * Host must be loopback (same-machine / local sim) or public_url / allowed_hosts.
 *
 * Reads `config.daemon` live on each call — the [daemon] section is not
 * PATCH-able (`routes/config.ts` ALLOWED_SECTIONS), so it is stable post-boot.
 */

import type { OwlConfig } from '@owl/core';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Strip the optional `:port`, preserving a bracketed IPv6 literal (`[::1]`). */
export function hostnameFromHostHeader(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/** Normalise to `scheme://host[:port]`, or null when unparseable. */
function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** True when `origin` is an http(s) URL whose host is loopback. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return isLoopbackHostname(u.hostname);
  } catch {
    return false;
  }
}

/** CORS: may a page at `origin` read responses from this daemon? */
export function isOriginAllowed(config: OwlConfig, origin: string | undefined): boolean {
  if (!origin) return true; // no Origin header — CLI / same-origin / curl
  const d = config.daemon;
  if (d.mode === 'local') {
    // Electron prod loadFile → Origin 'null'; dev / localhost browser → loopback.
    // Allowing 'null' is the documented interim posture until A6's local token.
    return origin === 'null' || isLoopbackOrigin(origin);
  }
  const allowed = new Set<string>();
  const pub = d.public_url && originOf(d.public_url);
  if (pub) allowed.add(pub);
  for (const o of d.allowed_origins ?? []) {
    const norm = originOf(o);
    if (norm) allowed.add(norm);
  }
  const reqOrigin = originOf(origin);
  return reqOrigin !== null && allowed.has(reqOrigin);
}

/** Host header check (anti DNS-rebinding). Missing Host → reject. */
export function isHostAllowed(config: OwlConfig, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false; // HTTP/1.1 requires Host
  const hostname = hostnameFromHostHeader(hostHeader);
  if (isLoopbackHostname(hostname)) return true; // same-machine / local sim (both modes)
  const d = config.daemon;
  if (d.mode === 'local') return false; // local: loopback only
  const allowedHostnames = new Set<string>();
  const allowedFullHosts = new Set<string>();
  if (d.public_url) {
    try {
      allowedHostnames.add(new URL(d.public_url).hostname);
    } catch {
      // unparseable public_url is rejected by the A0 startup guard; ignore here.
    }
  }
  for (const h of d.allowed_hosts ?? []) {
    allowedFullHosts.add(h);
    allowedHostnames.add(hostnameFromHostHeader(h));
  }
  return allowedHostnames.has(hostname) || allowedFullHosts.has(hostHeader);
}

/** `@fastify/cors` `origin` delegate bound to the live config. */
export function corsOriginDelegate(
  config: OwlConfig,
): (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => void {
  return (origin, cb) => cb(null, isOriginAllowed(config, origin));
}
