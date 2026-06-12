/**
 * P5-d Phase 6 — dev/test cold-start session bootstrap.
 *
 * Daemon's production startup is intentionally unauthenticated: tokens
 * only enter the process via `POST /sync/session` from GUI main. ChildProcess
 * `env` is copied at spawn and cannot be reliably revoked, so leaking a
 * token through env is the path we're closing off.
 *
 * For local dev / test loops we still need a way to seed a session at
 * boot without standing up a full GUI main. The compromise is a strict
 * **double-env gate**:
 *
 *   OWL_DAEMON_DEV_TOKEN=<plaintext token>
 *   OWL_ALLOW_INSECURE_DEV_TOKEN=1
 *
 * Both must be present together. Only one set → ignored (return null;
 * partial seeding is almost always a misconfiguration, not a request).
 *
 * `NODE_ENV=production` → hard reject even when both vars are set. A
 * packaged GUI launching daemon goes through the production path, so a
 * stray dev env on the user's machine cannot install a session.
 *
 * The other identity fields (server_url, user_id, email, device,
 * workspace) come from the existing `skybridge_config.toml` — same
 * shape the retired /sync/login wrote. Until Phase 7 switches toml to
 * `encrypted_token`, the toml still carries plaintext token; the env
 * override exists for dev workflows where the toml is intentionally
 * tokenless (or pre-Phase-7 / post-retirement of /sync/login).
 *
 * Env vars are `delete`-d from `process.env` immediately after a
 * successful read so subsequent reads (including child processes
 * spawned later in the same daemon process) cannot see them. This is
 * best-effort: env was already copied into any ChildProcess spawned
 * earlier, but the daemon never spawns children with token-bearing env
 * so the surface is limited to in-process reads.
 */

import { readSkybridgeConfig as defaultReadSkybridgeConfig } from '@owl/core';
import type { SkybridgeConfig } from '@owl/core';
import type { InstallSessionInput } from './session.js';

export class DevTokenInProductionError extends Error {
  readonly code = 'DEV_TOKEN_IN_PRODUCTION';
  constructor() {
    super(
      'OWL_DAEMON_DEV_TOKEN + OWL_ALLOW_INSECURE_DEV_TOKEN are forbidden when NODE_ENV=production',
    );
    this.name = 'DevTokenInProductionError';
  }
}

export interface DevBootstrapDeps {
  /** Override process.env for testing. */
  env?: NodeJS.ProcessEnv;
  /** Override the env-delete side effect for testing. */
  deleteEnv?: (env: NodeJS.ProcessEnv, key: string) => void;
  /** Override toml read for testing. */
  readSkybridgeConfig?: () => SkybridgeConfig;
}

export interface DevBootstrapResult {
  /** Reason the env was ignored, when result.input is null. */
  reason: 'no-env' | 'partial-env' | 'toml-incomplete' | 'accepted';
  input: InstallSessionInput | null;
}

/**
 * Returns an `InstallSessionInput` assembled from the dev env + existing
 * toml, or null with a `reason` tag explaining why. Throws
 * `DevTokenInProductionError` when production + both env vars are set.
 *
 * Side effect: deletes `OWL_DAEMON_DEV_TOKEN` + `OWL_ALLOW_INSECURE_DEV_TOKEN`
 * from `process.env` *only* when `reason === 'accepted'`. Partial / prod-
 * reject paths leave env intact so the operator can debug.
 */
export function tryConsumeDevSession(deps: DevBootstrapDeps = {}): DevBootstrapResult {
  const env = deps.env ?? process.env;
  const del =
    deps.deleteEnv ??
    ((e: NodeJS.ProcessEnv, key: string): void => {
      // `delete` (not `e[key] = undefined`, which coerces to the string
      // "undefined") is the only correct way to remove an env var. noDelete is
      // disabled for this file in biome.json.
      delete e[key];
    });
  const readConfig = deps.readSkybridgeConfig ?? defaultReadSkybridgeConfig;

  const token = env.OWL_DAEMON_DEV_TOKEN;
  const allow = env.OWL_ALLOW_INSECURE_DEV_TOKEN;

  // Both must be present together. Neither set → quietly noop (the
  // intended production-style cold start).
  if (!token && !allow) {
    return { reason: 'no-env', input: null };
  }
  // Exactly one of the pair set → ignore; almost always misconfiguration.
  if (!token || allow !== '1') {
    return { reason: 'partial-env', input: null };
  }

  // Hard reject in production builds even when both vars are set. A
  // packaged GUI launches daemon with NODE_ENV=production; a stray dev
  // env on the operator's machine must never install a session there.
  if (env.NODE_ENV === 'production') {
    throw new DevTokenInProductionError();
  }

  let cfg: SkybridgeConfig;
  try {
    cfg = readConfig();
  } catch {
    return { reason: 'toml-incomplete', input: null };
  }

  // The env supplies only the token. Everything else (server_url,
  // user_id, email, device, workspace) has to come from a pre-seeded
  // toml. Bail with reason='toml-incomplete' so the daemon falls back
  // to its unauthenticated startup path.
  if (!cfg.auth?.user_id || !cfg.auth.email) {
    return { reason: 'toml-incomplete', input: null };
  }
  if (!cfg.device?.id || !cfg.device.name) {
    return { reason: 'toml-incomplete', input: null };
  }
  if (!cfg.workspace?.id) {
    return { reason: 'toml-incomplete', input: null };
  }

  const input: InstallSessionInput = {
    token,
    user_id: cfg.auth.user_id,
    email: cfg.auth.email,
    server_url: cfg.server.url,
    device: {
      id: cfg.device.id,
      name: cfg.device.name,
      app_version: cfg.device.app_version,
      client_version: cfg.device.client_version,
    },
    workspace: { id: cfg.workspace.id, slug: cfg.workspace.slug },
  };

  // Best-effort scrub. The env was already copied into any ChildProcess
  // spawned earlier in this process tree; daemon does not spawn
  // children with token-bearing env so the practical surface is limited
  // to in-process reads after this point.
  del(env, 'OWL_DAEMON_DEV_TOKEN');
  del(env, 'OWL_ALLOW_INSECURE_DEV_TOKEN');

  return { reason: 'accepted', input };
}
