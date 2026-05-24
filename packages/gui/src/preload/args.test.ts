import { describe, expect, it } from 'vitest';
import { DEFAULT_DAEMON_PORT, daemonUrlFromArgv, parseDaemonPort, parseStartupMode } from './args';

describe('parseStartupMode', () => {
  it('returns normal when no --startup-mode= flag', () => {
    expect(parseStartupMode(['/path/to/electron', '--other-flag'])).toEqual({ mode: 'normal' });
  });

  it('parses migrate-required payload', () => {
    const argv = [`--startup-mode=${JSON.stringify({ mode: 'migrate-required', dbPath: '/x' })}`];
    expect(parseStartupMode(argv)).toEqual({ mode: 'migrate-required', dbPath: '/x' });
  });

  it('falls back to normal on malformed JSON (does not throw)', () => {
    expect(parseStartupMode(['--startup-mode={not json'])).toEqual({ mode: 'normal' });
  });
});

describe('parseDaemonPort (P5-c G1)', () => {
  it('returns DEFAULT_DAEMON_PORT when no --daemon-port= flag', () => {
    expect(parseDaemonPort([])).toBe(DEFAULT_DAEMON_PORT);
    expect(parseDaemonPort(['--other=1'])).toBe(DEFAULT_DAEMON_PORT);
  });

  it('parses --daemon-port=47011 into the integer 47011', () => {
    expect(parseDaemonPort(['--daemon-port=47011'])).toBe(47011);
  });

  it('finds the flag among many argv entries', () => {
    expect(
      parseDaemonPort(['/electron', '--startup-mode={}', '--daemon-port=50000', '--other']),
    ).toBe(50000);
  });

  it('falls back to default on NaN / out-of-range / negative values', () => {
    expect(parseDaemonPort(['--daemon-port=abc'])).toBe(DEFAULT_DAEMON_PORT);
    expect(parseDaemonPort(['--daemon-port=0'])).toBe(DEFAULT_DAEMON_PORT);
    expect(parseDaemonPort(['--daemon-port=-1'])).toBe(DEFAULT_DAEMON_PORT);
    expect(parseDaemonPort(['--daemon-port=99999'])).toBe(DEFAULT_DAEMON_PORT);
  });
});

describe('daemonUrlFromArgv', () => {
  it('composes http://127.0.0.1:<port> from argv', () => {
    expect(daemonUrlFromArgv(['--daemon-port=47011'])).toBe('http://127.0.0.1:47011');
  });

  it('uses default port when flag absent', () => {
    expect(daemonUrlFromArgv([])).toBe(`http://127.0.0.1:${DEFAULT_DAEMON_PORT}`);
  });
});
