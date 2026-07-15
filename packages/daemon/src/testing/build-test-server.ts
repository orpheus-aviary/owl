/**
 * Phase A (A6) — test harness for building a daemon server with the local-mode
 * auth gate satisfied automatically.
 *
 * `buildTestServer(ctx)` is a drop-in for `buildServer(ctx)`: it returns the
 * same Fastify app, so existing `app.inject(...)` call sites keep working. What
 * it adds, in LOCAL mode only:
 *   1. sets a fixed `ctx.localToken` (so the fail-closed `buildServer` assertion
 *      added in S8 passes without every test hand-wiring a token), and
 *   2. patches `app.inject` to attach `Authorization: Bearer <token>` by
 *      default — so ordinary local API tests pass the S8 gate untouched.
 *
 * Boundary tests that must send NO or a WRONG token (e.g. "local GET / without a
 * token → 401") call `app.injectRaw(...)`, the un-patched original. The caller's
 * own `headers` win over the injected default, so a test can also override the
 * bearer inline.
 *
 * In CLOUD mode nothing is patched: cloud tests mint their own Layer-2 session
 * bearer and assert their own 401 semantics, so a local-token default would
 * only get in the way.
 */

import type { AppContext } from '../context.js';
import { buildServer } from '../server.js';

/** Fixed local token used by harness-built local servers. */
export const TEST_LOCAL_TOKEN = 'test-local-token-0123456789abcdef0123456789';

type BaseApp = ReturnType<typeof buildServer>;
export type TestApp = BaseApp & { injectRaw: BaseApp['inject'] };

export function buildTestServer(ctx: AppContext): TestApp {
  const isLocal = ctx.config.daemon.mode === 'local';
  if (isLocal && ctx.localToken === undefined) ctx.localToken = TEST_LOCAL_TOKEN;

  const app = buildServer(ctx) as TestApp;
  // Keep the raw inject for boundary/status/cloud cases.
  app.injectRaw = app.inject.bind(app);

  if (isLocal && ctx.localToken) {
    const raw = app.injectRaw;
    const token = ctx.localToken;
    // Only the object form is wrapped (every daemon test uses `inject({...})`).
    // Caller headers win, so authorization can still be overridden per call.
    app.inject = ((opts: { headers?: Record<string, unknown> }) =>
      raw({
        ...opts,
        headers: { authorization: `Bearer ${token}`, ...opts?.headers },
      })) as BaseApp['inject'];
  }

  return app;
}
