/**
 * P5-d Phase 7 — buildSpawnEnv unit tests.
 *
 * The rest of `daemon.ts` is wrapped around `child_process.spawn` and an
 * Electron-as-Node code path, so we cover only the env construction that
 * carries the v3 §3.7.3 invariants:
 *
 *   - OWL_GUI_PARENT_PID is set, formatted as a decimal string
 *   - ELECTRON_RUN_AS_NODE=1 (lets the packaged Electron binary act as Node)
 *   - parent env passes through (HOME / PATH / proxy / API keys)
 *   - we never inject a token-bearing env in the spawn helper itself
 */

import { describe, expect, it } from 'vitest';
import { buildSpawnEnv } from './daemon.js';

describe('buildSpawnEnv (P5-d Phase 7)', () => {
  it('attaches OWL_GUI_PARENT_PID as a decimal string', () => {
    const env = buildSpawnEnv({}, 12345);
    expect(env.OWL_GUI_PARENT_PID).toBe('12345');
  });

  it('sets ELECTRON_RUN_AS_NODE=1 so the Electron binary runs as Node', () => {
    const env = buildSpawnEnv({}, 1);
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('passes through HOME / PATH / proxy from the parent env', () => {
    const env = buildSpawnEnv(
      { HOME: '/Users/test', PATH: '/usr/local/bin', HTTPS_PROXY: 'http://proxy:8080' },
      1,
    );
    expect(env.HOME).toBe('/Users/test');
    expect(env.PATH).toBe('/usr/local/bin');
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
  });

  // The spawn helper MUST NOT introduce any OWL_DAEMON_TOKEN / dev-token
  // env on its own. If the operator's shell already has them set, that's
  // out of scope (and the daemon's tryConsumeDevSession panics under
  // NODE_ENV=production). This is a regression guard: if a future PR adds
  // a token injection here, this test should flag it.
  it('does not synthesise any OWL_DAEMON_TOKEN / OWL_DAEMON_DEV_TOKEN', () => {
    const env = buildSpawnEnv({}, 1);
    expect(env.OWL_DAEMON_TOKEN).toBeUndefined();
    expect(env.OWL_DAEMON_DEV_TOKEN).toBeUndefined();
    expect(env.OWL_ALLOW_INSECURE_DEV_TOKEN).toBeUndefined();
  });

  it('parent env tokens propagate (caller-controlled, not our responsibility to strip)', () => {
    // Stripping would silently mask a real misconfiguration; the daemon
    // is the authoritative gate (panics on NODE_ENV=production + dev token).
    const env = buildSpawnEnv(
      {
        OWL_DAEMON_DEV_TOKEN: 'tk-from-shell',
        OWL_ALLOW_INSECURE_DEV_TOKEN: '1',
      },
      1,
    );
    expect(env.OWL_DAEMON_DEV_TOKEN).toBe('tk-from-shell');
    expect(env.OWL_ALLOW_INSECURE_DEV_TOKEN).toBe('1');
  });
});
