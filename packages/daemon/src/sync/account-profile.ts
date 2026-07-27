/**
 * 0.6.2 W3 — "is the database this daemon has open an ACCOUNT profile?"
 *
 * The question matters because `auth_required` is a statement about an account.
 * A purely local workspace can never need a login, so telling its user「需登录」
 * would be a lie; an account profile that merely lost its credentials must say
 * so even though nothing can be recovered automatically:
 *
 *   whether to show「需登录」  ← profile identity   (this module)
 *   whether we can self-heal   ← credentials       (`syncRecoveryCapability`)
 *
 * Wiping the stored credentials (GUI main's job) only removes the tokens —
 * profile / device / workspace / server_id all stay in toml (core
 * `skybridge/config.ts`), so "no credentials" is NOT the same as "local-only
 * mode".
 *
 * The judgement deliberately uses **the db the daemon actually has open** plus
 * **whether that db was ever bound to an account**, never toml's
 * `active_profile`: during a switch the two disagree for a window.
 */

import { resolve } from 'node:path';
import { paths } from '@owl/core';
import type { AppContext } from '../context.js';

/**
 * better-sqlite3 reports an in-memory db as the literal `':memory:'` (not an
 * empty string), and daemon unit tests run on exactly that. Anything that isn't
 * a real absolute file is treated as "not an account".
 */
function isRealDbPath(name: string): boolean {
  return name.length > 0 && name !== ':memory:' && resolve(name) === name;
}

function hasAccountBinding(ctx: AppContext): boolean {
  const row = ctx.sqlite
    .prepare("SELECT 1 FROM local_metadata WHERE key = 'skybridge_workspace_id' LIMIT 1")
    .get();
  return row !== undefined;
}

/**
 * True when the open database belongs to a skybridge account.
 *
 * cloud: the daemon owns its own binding in RAM (credential store) and installs
 * the session itself, so either one proves it.
 *
 * local: the db must be a real file, must NOT be the local (account-less)
 * profile db — D10b keeps `owl/owl.db` out of account sync entirely — and must
 * carry a skybridge workspace id. The path check also rejects a legacy account
 * db sitting at the local path; the workspace check rejects daemon unit-test
 * scratch dbs, which is why those keep their historic `idle` initial state.
 */
export function isAccountProfile(ctx: AppContext): boolean {
  if (ctx.config.daemon.mode === 'cloud') {
    return ctx.credentialStore?.get() != null || ctx.skybridgeSession != null;
  }
  const dbPath = ctx.sqlite.name;
  if (!isRealDbPath(dbPath)) return false;
  if (dbPath === resolve(paths.localProfileDbPath())) return false;
  return hasAccountBinding(ctx);
}
