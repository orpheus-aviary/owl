/**
 * Phase B4 — same-origin static hosting of the built web bundle (`apps/web`).
 *
 * When `[daemon].web_root` is set, serve the SPA shell + assets via
 * `@fastify/static` and stamp a strict CSP on every response. The shell is
 * public — the cloud auth gate (`server.ts`) only bearer-gates API prefixes.
 * The web app is a HashRouter, so the browser only ever requests `/` +
 * `/assets/*`; there is deliberately NO server-side SPA fallback.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { type OwlConfig, paths } from '@owl/core';
import type { FastifyInstance } from 'fastify';
import { DaemonStartupError } from './startup-guard.js';

/**
 * Resolve `[daemon].web_root` to an absolute directory, or `undefined` when
 * unset (no hosting). A relative path resolves against `paths.nestDir()` — NOT
 * the cwd — so it's stable regardless of where the daemon was launched.
 */
export function resolveWebRoot(config: OwlConfig): string | undefined {
  const webRoot = config.daemon.web_root;
  if (!webRoot) return undefined;
  return isAbsolute(webRoot) ? webRoot : resolve(paths.nestDir(), webRoot);
}

/**
 * Fail-fast: throw `DaemonStartupError` when `web_root` is set but unservable
 * (missing / not a directory / no `index.html`). `statSync` throws a plain fs
 * error on a missing path — which `cli.ts` would not recognise as a friendly
 * refusal — so funnel every failure through `DaemonStartupError`.
 */
export function assertWebRootValid(resolved: string | undefined): void {
  if (!resolved) return;
  let ok = false;
  try {
    ok = statSync(resolved).isDirectory() && existsSync(join(resolved, 'index.html'));
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new DaemonStartupError(
      `[daemon].web_root=${JSON.stringify(resolved)} must be a directory containing index.html`,
    );
  }
}

/** Strict same-origin CSP for the served web app (design §B4.5). */
const CSP = [
  "default-src 'self'",
  // Vite prod emits external bundles only — no inline scripts / eval.
  "script-src 'self'",
  // KaTeX emits inline `style=` attributes + React/Tailwind inline styles.
  "style-src 'self' 'unsafe-inline'",
  // External markdown images are intentionally blocked (anti-tracking + no
  // mixed content); add `https:` here if external images become a requirement.
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Register static hosting + security headers. `wildcard: false` is REQUIRED:
 * the default `true` registers a `GET /*` catch-all that would intercept
 * unmatched API GETs (e.g. `/notes/a/b/c`) and return a static 404 instead of
 * Fastify's default. With it off, static only serves files that exist and
 * everything else falls through unchanged — a missing `/assets/x.js` stays a
 * real 404 (correct MIME / cache behaviour) rather than the index.
 */
export function registerWebHost(app: FastifyInstance, webRoot: string): void {
  app.register(fastifyStatic, { root: webRoot, wildcard: false, index: 'index.html' });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });
}
