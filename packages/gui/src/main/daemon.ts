import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { LOCAL_AUTH_VERSION } from '@orpheus-aviary/owl-shared';

/**
 * Daemon port resolution: `OWL_DAEMON_PORT` env override → 47010 default.
 *
 * The daemon itself reads `daemon.port` from `owl_config.toml`. Multi-profile
 * local tests (e.g. P5-a single-machine two-profile sync) need the GUI to
 * follow a non-default port, hence the env override. The variable is read
 * once at module load — `electron-vite dev` and packaged launches both honor
 * envs set by `just`, the daemon spawn script, or a parent shell.
 */
function resolveDaemonPort(): number {
  const raw = process.env.OWL_DAEMON_PORT;
  if (!raw) return 47010;
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.warn(`Invalid OWL_DAEMON_PORT=${raw}, falling back to 47010`);
    return 47010;
  }
  return port;
}

const DAEMON_PORT = resolveDaemonPort();
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

// ESM context — recreate CommonJS-style resolver bound to this module.
const esmRequire = createRequire(import.meta.url);

/**
 * The pid of the daemon THIS GUI spawned AND verified as its own via
 * `/status.pid` (A6). Null when we reused an external daemon or never spawned
 * one successfully. It is the ONLY pid `stopDaemonGracefully` ever signals — the
 * pid FILE is not trusted for identity (it can be stale / reused / another GUI's).
 */
let ownedDaemonPid: number | null = null;

/** Parsed `GET /status` snapshot (A6 — carries mode + local capability). */
export interface DaemonStatus {
  mode?: 'local' | 'cloud';
  /** Present only for a local daemon (used to prove identity before we signal it). */
  pid?: number;
  /** Present only for a local daemon; absent on a pre-A6 daemon. */
  localAuthVersion?: number;
}

export type DaemonReadiness =
  | { state: 'ready' }
  /** Reachable, but not a compatible A6 local daemon (stale pre-A6 / wrong mode). */
  | { state: 'incompatible'; pid?: number }
  /** Could not spawn a daemon, or it never became reachable. */
  | { state: 'failed' };

/** Probe `GET /status`; returns the parsed snapshot or null if unreachable. */
export async function probeDaemonStatus(): Promise<DaemonStatus | null> {
  try {
    const res = await fetch(`${DAEMON_URL}/status`);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { mode?: 'local' | 'cloud'; pid?: number; local_auth_version?: number };
    };
    const d = body.data ?? {};
    return { mode: d.mode, pid: d.pid, localAuthVersion: d.local_auth_version };
  } catch {
    return null;
  }
}

/** Simple reachability probe (kept for callers that only need up/down). */
export async function checkDaemon(): Promise<boolean> {
  return (await probeDaemonStatus()) !== null;
}

/**
 * True when a reachable daemon is a compatible A6 local daemon — local mode and
 * advertising a local_auth_version at least ours (so it enforces the token
 * gate). A pre-A6 daemon lacks the field → incompatible.
 */
export function isCompatibleLocalDaemon(status: DaemonStatus): boolean {
  return status.mode === 'local' && (status.localAuthVersion ?? 0) >= LOCAL_AUTH_VERSION;
}

/** Pure: map a probe snapshot to readiness (ownership handled by the caller). */
export function classifyReadiness(status: DaemonStatus): DaemonReadiness {
  return isCompatibleLocalDaemon(status)
    ? { state: 'ready' }
    : { state: 'incompatible', pid: status.pid };
}

/**
 * Build the env we hand to the daemon child process.
 *
 * P5-d Phase 7 — GUI main MUST pass `OWL_GUI_PARENT_PID=<pid>` so the
 * daemon's parent-pid probe (packages/daemon/src/sync/parent-probe.ts)
 * can tear down sync state if GUI crashes / is force-quit.
 *
 * What we deliberately do NOT do here:
 *   - inject `OWL_DAEMON_TOKEN`, `OWL_DAEMON_DEV_TOKEN`, or any other
 *     token-bearing env. ChildProcess env is copied at spawn and cannot
 *     be reliably revoked — the daemon publishes its A6 local token to a
 *     0600 file after it starts listening instead.
 *
 * Exported for direct unit testing (the rest of `spawnDaemon` touches
 * `process.execPath` + the actual `spawn` call, which would force the
 * test to mock `child_process`).
 */
export function buildSpawnEnv(parentEnv: NodeJS.ProcessEnv, parentPid: number): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    ELECTRON_RUN_AS_NODE: '1',
    OWL_GUI_PARENT_PID: String(parentPid),
  };
}

/**
 * Spawn daemon process using Electron-as-Node (ELECTRON_RUN_AS_NODE=1).
 * Packaged app doesn't have a standalone `node` binary; run the Electron
 * binary in node mode instead. Returns the child so the caller can verify
 * `/status.pid === child.pid` before claiming ownership, or null on failure.
 */
function spawnDaemon(): ChildProcess | null {
  let cliPath: string;
  try {
    cliPath = esmRequire.resolve('@owl/daemon/cli');
  } catch (err) {
    console.error('Failed to resolve @owl/daemon/cli:', err);
    return null;
  }

  try {
    const child = spawn(process.execPath, [cliPath, 'daemon'], {
      env: buildSpawnEnv(process.env, process.pid),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return child;
  } catch (err) {
    console.error('Failed to spawn daemon process:', err);
    return null;
  }
}

/** Poll /status until it responds or timeout; returns the snapshot or null. */
async function waitForStatus({ timeoutMs }: { timeoutMs: number }): Promise<DaemonStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await probeDaemonStatus();
    if (status) return status;
    await sleep(500);
  }
  return null;
}

/**
 * Ensure a compatible local daemon is reachable, spawning one if needed.
 *
 * Returns a tri-state (A6):
 *   - `ready`        — a compatible A6 local daemon is up (reused or freshly spawned).
 *   - `incompatible` — a daemon answers but isn't a compatible local daemon
 *                      (e.g. a stale pre-A6 daemon still holding the port after an
 *                      upgrade). `pid` is set iff it advertised one (provable identity).
 *   - `failed`       — spawn failed, or the spawned daemon never became reachable.
 *
 * We only claim ownership (→ Cmd+Q stops it) when the daemon that answers is the
 * very child we spawned, proven by `/status.pid === child.pid`. An external
 * daemon that won the port while our child died is never owned or signalled.
 */
export async function ensureDaemonRunning(): Promise<DaemonReadiness> {
  const existing = await probeDaemonStatus();
  if (existing) return classifyReadiness(existing); // reused — never owned by us

  const child = spawnDaemon();
  if (!child) return { state: 'failed' };

  const status = await waitForStatus({ timeoutMs: 10_000 });
  if (!status) {
    console.error('Daemon spawn returned but /status never responded');
    return { state: 'failed' };
  }

  const readiness = classifyReadiness(status);
  if (readiness.state === 'ready' && child.pid !== undefined && status.pid === child.pid) {
    ownedDaemonPid = status.pid;
  }
  return readiness;
}

/** Get the daemon API base URL. */
export function getDaemonUrl(): string {
  return DAEMON_URL;
}

/**
 * Get the resolved daemon port (env override or 47010 default). Exposed
 * for P5-c G1 so window.ts can hand it to preload via additionalArguments.
 */
export function getDaemonPort(): number {
  return DAEMON_PORT;
}

/**
 * Stop the daemon IF this GUI owns it (spawned + `/status.pid`-verified).
 * Never touches a daemon we didn't start or couldn't prove is ours.
 */
export async function stopDaemonGracefully(): Promise<void> {
  if (ownedDaemonPid === null) return;
  await stopPid(ownedDaemonPid);
  ownedDaemonPid = null;
}

/**
 * Stop a specific daemon pid (the `/status`-provable incompatible daemon), on
 * explicit user confirmation only. Returns true once the process is gone.
 */
export async function stopDaemonByPid(pid: number): Promise<boolean> {
  await stopPid(pid);
  return !processAlive(pid);
}

/** SIGTERM → poll → 3s timeout → SIGKILL a pid. */
async function stopPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already gone — nothing to stop.
    return;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await sleep(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process died between the timeout and the kill — fine.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
