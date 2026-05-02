import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/errors.js';
import { decideMode } from './resolve.js';

describe('decideMode — reads', () => {
  it('picks http when daemon alive', () => {
    const d = decideMode({ isWrite: false, daemonAlive: true });
    expect(d.mode).toBe('http');
    expect(d.warnings).toEqual([]);
  });

  it('picks direct silently when daemon down', () => {
    const d = decideMode({ isWrite: false, daemonAlive: false });
    expect(d.mode).toBe('direct');
    expect(d.warnings).toEqual([]);
  });

  it('--direct forces direct for reads (daemon alive tolerated)', () => {
    const d = decideMode({ isWrite: false, daemonAlive: true, direct: true });
    expect(d.mode).toBe('direct');
    expect(d.warnings).toEqual([]);
  });

  it('--db forces direct for reads', () => {
    const d = decideMode({ isWrite: false, daemonAlive: true, db: '/tmp/other.db' });
    expect(d.mode).toBe('direct');
  });
});

describe('decideMode — writes', () => {
  it('default + daemon alive → http', () => {
    const d = decideMode({ isWrite: true, daemonAlive: true });
    expect(d.mode).toBe('http');
    expect(d.warnings).toEqual([]);
  });

  it('default + daemon down → direct with stderr warning', () => {
    const d = decideMode({ isWrite: true, daemonAlive: false });
    expect(d.mode).toBe('direct');
    expect(d.warnings).toEqual([expect.stringMatching(/daemon not running/i)]);
  });

  it('--direct + daemon alive WITHOUT --force → throws DAEMON_RUNNING_BLOCKED', () => {
    try {
      decideMode({ isWrite: true, daemonAlive: true, direct: true });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('DAEMON_RUNNING_BLOCKED');
    }
  });

  it('--direct + --force + daemon alive → direct with warning', () => {
    const d = decideMode({ isWrite: true, daemonAlive: true, direct: true, force: true });
    expect(d.mode).toBe('direct');
    expect(d.warnings.some((w) => /force/i.test(w))).toBe(true);
  });

  it('--db + daemon alive WITHOUT --force → throws DAEMON_RUNNING_BLOCKED', () => {
    expect(() => decideMode({ isWrite: true, daemonAlive: true, db: '/tmp/x.db' })).toThrow(
      CliError,
    );
  });

  it('--db + --force + daemon alive → direct', () => {
    const d = decideMode({ isWrite: true, daemonAlive: true, db: '/tmp/x.db', force: true });
    expect(d.mode).toBe('direct');
  });

  it('--direct + daemon down → direct (silent)', () => {
    const d = decideMode({ isWrite: true, daemonAlive: false, direct: true });
    expect(d.mode).toBe('direct');
    expect(d.warnings).toEqual([]);
  });
});
