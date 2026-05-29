/**
 * P5-c §6.27 — verify that the default pino redact paths exported from
 * `logger/index.ts` actually mask the structured fields we care about.
 *
 * We don't construct `createLogger` directly (it spawns a `pino-roll`
 * worker thread, which is awkward to capture in a synchronous test).
 * Instead we build a sibling pino instance with the same `redact`
 * config and a `Writable` sink — this exercises the *exact* redact
 * config the two factories install.
 */

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import pino from 'pino';
import { DEFAULT_LOG_REDACT_PATHS } from './index.js';

function makeCapture(): { logger: pino.Logger; lines: () => string[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf-8'));
      cb();
    },
  });
  const logger = pino(
    {
      level: 'info',
      timestamp: false,
      redact: {
        paths: [...DEFAULT_LOG_REDACT_PATHS],
        censor: '[REDACTED]',
      },
    },
    sink,
  );
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((s) => s.length > 0),
  };
}

describe('logger default redact paths (P5-c §6.27)', () => {
  it('exports the expected paths (regression — daemon.log greppable list)', () => {
    assert.deepEqual(
      [...DEFAULT_LOG_REDACT_PATHS],
      [
        '*.token',
        '*.auth.token',
        '*.encrypted_token',
        '*.auth.encrypted_token',
        '*.profiles.*.encrypted_token',
        '*.profiles.*.auth.token',
        'authorization',
        'headers.authorization',
        'req.headers.authorization',
      ],
    );
  });

  it('masks top-level `*.token` matches (any single-level wildcard)', () => {
    const { logger, lines } = makeCapture();
    logger.info({ session: { token: 'tok_abc123secret' } }, 'login round-trip');
    const out = lines().join('\n');
    assert.ok(!out.includes('tok_abc123secret'), `token leaked: ${out}`);
    assert.ok(out.includes('[REDACTED]'));
  });

  it('masks `*.auth.token` nested under any owner', () => {
    const { logger, lines } = makeCapture();
    logger.info({ cfg: { auth: { token: 'tok_nested_secret', user_id: 'u' } } }, 'cfg read');
    const out = lines().join('\n');
    assert.ok(!out.includes('tok_nested_secret'));
    assert.ok(out.includes('"user_id":"u"'), 'sibling fields stay visible');
  });

  it('masks per-profile `*.profiles.*.encrypted_token` (P5-d Phase 12 schema)', () => {
    const { logger, lines } = makeCapture();
    logger.info(
      { cfg: { profiles: { p1: { encrypted_token: 'enc_secret_p1', email: 'a@b.c' } } } },
      'profile cfg',
    );
    const out = lines().join('\n');
    assert.ok(!out.includes('enc_secret_p1'), `encrypted_token leaked: ${out}`);
    assert.ok(out.includes('a@b.c'), 'sibling fields stay visible');
  });

  it('masks per-profile `*.profiles.*.auth.token` (P5-d Phase 12 schema)', () => {
    const { logger, lines } = makeCapture();
    logger.info(
      { cfg: { profiles: { p1: { auth: { token: 'tok_profile_secret' } } } } },
      'profile auth',
    );
    assert.ok(!lines().join('\n').includes('tok_profile_secret'));
  });

  it('masks top-level `authorization` header', () => {
    const { logger, lines } = makeCapture();
    logger.info({ authorization: 'Bearer eyJ.tok.sig' }, 'incoming');
    assert.ok(!lines().join('\n').includes('eyJ.tok.sig'));
  });

  it('masks `headers.authorization` and `req.headers.authorization` shapes', () => {
    const { logger, lines } = makeCapture();
    logger.info({ headers: { authorization: 'Bearer A1' } }, 'A');
    logger.info({ req: { headers: { authorization: 'Bearer B2' } } }, 'B');
    const out = lines().join('\n');
    assert.ok(!out.includes('A1'));
    assert.ok(!out.includes('B2'));
  });

  it('does NOT mask unrelated fields (no over-redaction)', () => {
    const { logger, lines } = makeCapture();
    logger.info({ user_id: 'u_42', kind: 'sync', endpoint: 'http://x' }, 'noise');
    const out = lines().join('\n');
    assert.ok(out.includes('u_42'));
    assert.ok(out.includes('"kind":"sync"'));
    assert.ok(out.includes('http://x'));
  });
});
