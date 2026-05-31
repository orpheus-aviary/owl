/**
 * P5-b Step 10a — daemon-boot wiring for the SSE bridge.
 *
 * The bridge module exists since Step 7 but nothing calls `.start()` at
 * daemon startup, so without this helper the GUI status indicator never
 * leaves the boot-time `idle` snapshot and remote pushes have to wait for
 * a manual `owl sync run` to land. This module owns the small boot-time
 * decision tree: read config, decide whether to start, hand back a
 * shutdown-safe handle.
 *
 * Boot-time policy: ONLY auto-start when toml already carries auth +
 * device + workspace. Lazy `registerDevice` / `ensureWorkspace` are
 * skipped here because they need network, and a daemon boot that hangs
 * on a slow / offline skybridge server would block the operator from
 * editing notes locally — sync is opt-in, daemon is not. The first
 * `owl sync run` after `owl sync login` performs the lazy bootstrap as
 * usual; the bridge starts on the next daemon boot. (Re-syncing the
 * bridge mid-session on first successful manual sync is left for P5-c —
 * keeps this step small and out of the manual.ts call path.)
 *
 * Failure modes are all silent + logged:
 *  - no config / not configured → log info, return null
 *  - config incomplete (missing auth/device/workspace) → log info, null
 *  - skybridge module not installed → log warn, null
 *  - any other ensureSession error → log warn, null
 * The bridge itself handles network errors via its own backoff loop, so
 * once started we never need to "restart on transient failure" here.
 *
 * Deps are injected so the test suite can stub `readSkybridgeConfig` /
 * `ensureSkybridgeSession` / `createSseBridge` without touching the real
 * skybridge package or the filesystem.
 */

import type { Logger } from '@owl/core';
import { type SkybridgeConfig, readSkybridgeConfig as defaultReadSkybridgeConfig } from '@owl/core';
import type { AppContext } from '../context.js';
import { type HealthProbe, createHealthProbe as defaultCreateHealthProbe } from './health-probe.js';
import {
  type SyncSchedulerHandle,
  createSyncScheduler as defaultCreateSyncScheduler,
} from './scheduler.js';
import {
  type SkybridgeSession,
  ensureSkybridgeSession as defaultEnsureSkybridgeSession,
} from './session.js';
import { type SseBridge, createSseBridge as defaultCreateSseBridge } from './sse-bridge.js';

export interface BridgeHandle {
  /** Stop the underlying bridge AND its health probe. Idempotent. */
  stop(): void;
}

export interface BridgeLifecycleDeps {
  readSkybridgeConfig?: () => SkybridgeConfig;
  ensureSkybridgeSession?: (ctx: AppContext) => Promise<SkybridgeSession>;
  createSseBridge?: typeof defaultCreateSseBridge;
  /** Override health-probe factory for tests. P5-c Step 10. */
  createHealthProbe?: typeof defaultCreateHealthProbe;
}

/**
 * Attempt to start the SSE bridge for `ctx`. Returns a handle the caller
 * must `.stop()` during shutdown, or `null` if no bridge was started.
 * Never throws — sync is opt-in and must not break daemon boot.
 */
export async function startSseBridgeIfBootstrapped(
  ctx: AppContext,
  logger: Logger,
  deps: BridgeLifecycleDeps = {},
): Promise<BridgeHandle | null> {
  const readConfig = deps.readSkybridgeConfig ?? defaultReadSkybridgeConfig;
  const ensureSession = deps.ensureSkybridgeSession ?? defaultEnsureSkybridgeSession;
  const buildBridge = deps.createSseBridge ?? defaultCreateSseBridge;
  const buildHealthProbe = deps.createHealthProbe ?? defaultCreateHealthProbe;

  // P5-d Phase 6 — if `/sync/session` has already populated the cache,
  // honor it without going to toml. This is the GUI-main → HTTP path that
  // works even when toml only carries `encrypted_token` (Phase 7), since
  // daemon never decrypts.
  let session: SkybridgeSession;
  if (ctx.skybridgeSession) {
    session = ctx.skybridgeSession;
  } else {
    let config: SkybridgeConfig;
    try {
      config = readConfig();
    } catch {
      logger.info({ kind: 'sse-bridge' }, 'skybridge not configured, skipping bridge');
      return null;
    }

    // Demand fully-bootstrapped config so ensureSession is a no-network call.
    // Missing device.id / workspace.id would trigger registerDevice /
    // ensureWorkspace inside ensureSession, which we don't want at boot.
    if (!config.auth?.token || !config.device?.id || !config.workspace?.id) {
      logger.info(
        {
          kind: 'sse-bridge',
          hasAuth: Boolean(config.auth?.token),
          hasDevice: Boolean(config.device?.id),
          hasWorkspace: Boolean(config.workspace?.id),
        },
        'skybridge config incomplete, skipping bridge (awaiting /sync/session)',
      );
      return null;
    }

    try {
      session = await ensureSession(ctx);
    } catch (err) {
      logger.warn(
        { kind: 'sse-bridge', err: errorMessage(err) },
        'skybridge session bootstrap failed, skipping bridge',
      );
      return null;
    }
  }

  // P5-c Step 10: compose bridge + health probe. The cycle (probe needs
  // bridge.triggerReconnect; bridge needs probe.start/stop) is broken with
  // a forward `let probe` that gets assigned before the bridge could
  // possibly emit an event (start() is called synchronously below).
  let probe: HealthProbe | null = null;
  const bridge: SseBridge = buildBridge({
    realClient: session.realClient,
    workspaceId: session.workspaceId,
    ctx,
    logger,
    onErrorHook: () => probe?.start(),
    onOpenHook: () => probe?.stop(),
  });
  probe = buildHealthProbe({
    serverUrl: session.serverUrl,
    logger,
    onRecover: () => bridge.triggerReconnect(),
  });

  try {
    bridge.start();
  } catch (err) {
    // createSseBridge.start() catches its own subscribe failures and
    // schedules reconnect, so this branch is defensive — if a future
    // refactor lets a throw escape, we still don't take the daemon down.
    logger.warn(
      { kind: 'sse-bridge', err: errorMessage(err) },
      'sse-bridge start threw, bridge will NOT retry from here',
    );
    probe.stop();
    return null;
  }

  logger.info({ kind: 'sse-bridge', workspaceId: session.workspaceId }, 'sse-bridge started');
  return {
    stop: () => {
      bridge.stop();
      probe?.stop();
    },
  };
}

/**
 * P5-c §2.2-bis — idempotent boot-and-mid-session lifecycle entry point
 * for the SSE bridge + sync scheduler. Called from two places:
 *
 *   1. `cli.ts` post-listen, exactly once at daemon boot.
 *   2. `manual.ts:doRunManualSync` after `ensureSkybridgeSession`
 *      succeeds. This is what covers the "daemon booted with incomplete
 *      toml; user just ran `owl sync login` + `owl sync run`" path —
 *      without it, the bridge would only come up on the next daemon
 *      restart (P5-b deferred this lifecycle to P5-c by design).
 *
 * Idempotency invariants:
 *   - `ctx.sseBridge` truthy  → skip bridge start (already wired)
 *   - `ctx.sseBridge` null/undefined → attempt; field stays null when
 *     toml is still incomplete (covered by `startSseBridgeIfBootstrapped`
 *     internally returning null). Next call retries — cheap, just a
 *     file read + cached-session lookup.
 *   - `ctx.syncScheduler` truthy → skip scheduler start
 *   - `ctx.syncScheduler` null/undefined → create one (no-ops internally
 *     when interval_min <= 0).
 *
 * Reverse transition (toml goes from complete → incomplete, e.g. user
 * deletes / logs out): P5-c §1.4 explicitly defers this to P5-d when
 * logout flow gets designed end-to-end. This function never tears
 * existing handles down.
 *
 * Never throws — sync is opt-in and must not break boot / mutation flow.
 */
export interface EnsureBackgroundDeps extends BridgeLifecycleDeps {
  createSyncScheduler?: typeof defaultCreateSyncScheduler;
}

export async function ensureBackgroundHandles(
  ctx: AppContext,
  logger: Logger,
  deps: EnsureBackgroundDeps = {},
): Promise<void> {
  // P5-d Phase 14 — epoch guard against a profile switch racing this call.
  // A switch mutates `ctx` in place and swaps the db; because we `await`
  // before writing `ctx.sseBridge`, a bootstrap that entered before the
  // switch could otherwise re-attach a stale (old-session) bridge afterwards.
  // Bail entirely while switching, and re-check the generation across the
  // await: if a switch ran, stop the now-stale handle. The stop is
  // synchronous (subscribeEvents returns sync; onOpen is a later network
  // macrotask), so the subscription is cancelled before onOpen →
  // runManualSync can fire. The switch's own restart calls this from outside
  // the lock (switching=false, generation already bumped).
  const gate = ctx.switchGate;
  if (gate?.isSwitching()) return;
  const epoch = gate?.generation() ?? 0;
  const stale = (): boolean => Boolean(gate?.isSwitching()) || (gate?.generation() ?? 0) !== epoch;

  const buildScheduler = deps.createSyncScheduler ?? defaultCreateSyncScheduler;

  if (!ctx.sseBridge) {
    const handle = await startSseBridgeIfBootstrapped(ctx, logger, deps);
    if (stale()) {
      handle?.stop();
      return;
    }
    ctx.sseBridge = handle;
  }

  if (!ctx.syncScheduler) {
    if (stale()) return;
    ctx.syncScheduler = buildScheduler({ ctx, logger });
  }
}

/**
 * Tear-down helper for cli.ts shutdown. Stops whatever is currently on
 * ctx; idempotent (`stop()` itself is idempotent in both handles).
 */
export function stopBackgroundHandles(ctx: AppContext): void {
  ctx.sseBridge?.stop();
  ctx.syncScheduler?.stop();
  ctx.sseBridge = null;
  ctx.syncScheduler = null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-export for type-only convenience to other modules that thread the
// scheduler handle around.
export type { SyncSchedulerHandle };
