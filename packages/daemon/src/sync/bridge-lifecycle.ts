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
import {
  type SkybridgeSession,
  ensureSkybridgeSession as defaultEnsureSkybridgeSession,
} from './session.js';
import { type SseBridge, createSseBridge as defaultCreateSseBridge } from './sse-bridge.js';

export interface BridgeHandle {
  /** Stop the underlying bridge. Idempotent; safe to call when bridge never started. */
  stop(): void;
}

export interface BridgeLifecycleDeps {
  readSkybridgeConfig?: () => SkybridgeConfig;
  ensureSkybridgeSession?: (ctx: AppContext) => Promise<SkybridgeSession>;
  createSseBridge?: typeof defaultCreateSseBridge;
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
      'skybridge config incomplete, skipping bridge (run `owl sync run` to finish bootstrap)',
    );
    return null;
  }

  let session: SkybridgeSession;
  try {
    session = await ensureSession(ctx);
  } catch (err) {
    logger.warn(
      { kind: 'sse-bridge', err: errorMessage(err) },
      'skybridge session bootstrap failed, skipping bridge',
    );
    return null;
  }

  const bridge: SseBridge = buildBridge({
    realClient: session.realClient,
    workspaceId: session.workspaceId,
    ctx,
    logger,
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
    return null;
  }

  logger.info({ kind: 'sse-bridge', workspaceId: session.workspaceId }, 'sse-bridge started');
  return { stop: () => bridge.stop() };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
