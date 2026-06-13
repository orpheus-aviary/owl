/**
 * Phase A (A4) — login throttle unit tests. Uses an injected clock so window
 * sliding / lockout / recovery are deterministic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LoginThrottle, type ThrottleLimits } from './login-throttle.js';

const LIMITS: ThrottleLimits = {
  windowMs: 1000,
  maxPerEmail: 3,
  maxGlobal: 5,
  maxPerIp: 2,
};

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('LoginThrottle', () => {
  it('allows up to maxPerEmail failures, then locks the email out', () => {
    const clock = fakeClock();
    const th = new LoginThrottle(LIMITS, clock.now);
    const keys = { email: 'a@test' };
    for (let i = 0; i < 3; i++) {
      assert.equal(th.retryAfterMs(keys), 0, `attempt ${i} should be allowed`);
      th.recordFailure(keys);
    }
    assert.ok(th.retryAfterMs(keys) > 0, 'fourth attempt is throttled');
  });

  it('slides the window — old failures expire and free slots', () => {
    const clock = fakeClock();
    const th = new LoginThrottle(LIMITS, clock.now);
    const keys = { email: 'a@test' };
    for (let i = 0; i < 3; i++) th.recordFailure(keys);
    assert.ok(th.retryAfterMs(keys) > 0);
    clock.advance(1001); // whole window elapses
    assert.equal(th.retryAfterMs(keys), 0, 'window expired → allowed again');
  });

  it('recordSuccess clears the email bucket', () => {
    const clock = fakeClock();
    const th = new LoginThrottle(LIMITS, clock.now);
    const keys = { email: 'a@test' };
    for (let i = 0; i < 3; i++) th.recordFailure(keys);
    assert.ok(th.retryAfterMs(keys) > 0);
    th.recordSuccess(keys);
    assert.equal(th.retryAfterMs(keys), 0, 'success resets the lockout');
  });

  it('per-email lockout does not affect a different email', () => {
    const clock = fakeClock();
    const th = new LoginThrottle(LIMITS, clock.now);
    for (let i = 0; i < 3; i++) th.recordFailure({ email: 'a@test' });
    assert.ok(th.retryAfterMs({ email: 'a@test' }) > 0);
    assert.equal(th.retryAfterMs({ email: 'b@test' }), 0);
  });

  it('the global bucket locks out even across distinct emails', () => {
    const clock = fakeClock();
    const th = new LoginThrottle(LIMITS, clock.now);
    // 5 distinct emails, one failure each → hits maxGlobal (none hit per-email).
    for (let i = 0; i < 5; i++) th.recordFailure({ email: `u${i}@test` });
    assert.ok(th.retryAfterMs({ email: 'fresh@test' }) > 0, 'global cap reached');
  });

  it('keys per-IP only when an ip is supplied', () => {
    const clock = fakeClock();
    const th = new LoginThrottle(LIMITS, clock.now);
    // maxPerIp is 2; two failures from the same ip (distinct emails) → locked
    // for that ip regardless of which email logs in next from it.
    th.recordFailure({ email: 'a@test', ip: '1.2.3.4' });
    th.recordFailure({ email: 'b@test', ip: '1.2.3.4' });
    assert.ok(th.retryAfterMs({ email: 'c@test', ip: '1.2.3.4' }) > 0, 'ip locked');
    assert.equal(th.retryAfterMs({ email: 'c@test', ip: '9.9.9.9' }), 0, 'other ip free');
    assert.equal(th.retryAfterMs({ email: 'c@test' }), 0, 'no ip key → ip bucket skipped');
  });

  it('retryAfterMs reports the time until the oldest hit leaves the window', () => {
    const clock = fakeClock();
    const th = new LoginThrottle(LIMITS, clock.now);
    const keys = { email: 'a@test' };
    for (let i = 0; i < 3; i++) th.recordFailure(keys); // all at t=0
    clock.advance(400);
    assert.equal(th.retryAfterMs(keys), 600, '0 + 1000 - 400');
  });
});
