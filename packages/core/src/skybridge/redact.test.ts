import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactToken } from './redact.js';

describe('redactToken (P5-c §6.27)', () => {
  it('keeps prefix + suffix visible on a real-shaped token', () => {
    const tok = 'tok_abcdefghijklmnopqrstuvwxyz_xyz9';
    const out = redactToken(tok);
    assert.match(out, /^tok_…xyz9$/);
  });

  it('fully redacts strings shorter than prefix+suffix+2 (no leakage)', () => {
    assert.equal(redactToken('abc'), '[REDACTED]');
    assert.equal(redactToken('abcd1234'), '[REDACTED]'); // exactly 8 = 4+4 → still fully masked
    assert.equal(redactToken('abcd12345'), '[REDACTED]'); // 9 = 4+4+1 — one short
  });

  it('returns [REDACTED] for null / undefined / empty / non-string', () => {
    assert.equal(redactToken(undefined), '[REDACTED]');
    assert.equal(redactToken(null), '[REDACTED]');
    assert.equal(redactToken(''), '[REDACTED]');
    assert.equal(redactToken(12345), '[REDACTED]');
    assert.equal(redactToken({ token: 'x' }), '[REDACTED]');
  });

  it('respects custom prefix/suffix budgets', () => {
    const tok = 'tok_01234567890123456789';
    assert.equal(redactToken(tok, { prefix: 2, suffix: 2 }), 'to…89');
    assert.equal(redactToken(tok, { prefix: 6, suffix: 0 }), 'tok_01…');
    assert.equal(redactToken(tok, { prefix: 0, suffix: 6 }), '…456789');
  });

  it('rejects negative budgets', () => {
    assert.throws(() => redactToken('abcdef', { prefix: -1 }), /non-negative/);
    assert.throws(() => redactToken('abcdef', { suffix: -1 }), /non-negative/);
  });

  it('is idempotent over its own output (calling twice never regenerates a token)', () => {
    const tok = 'tok_abcdefghijklmnop';
    const once = redactToken(tok);
    const twice = redactToken(once);
    // Second call sees a 9-char string that includes "…"; either it
    // collapses to [REDACTED] (short input) or stays the same.
    assert.ok(
      twice === '[REDACTED]' || twice === once,
      `idempotency violated: once=${once} twice=${twice}`,
    );
    assert.ok(!twice.includes('abcdefghij'), 'must never re-expose the masked middle');
  });
});
