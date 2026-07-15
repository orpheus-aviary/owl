import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElectronAdapter } from './electron';

describe('electron adapter — getDaemonToken (A6)', () => {
  const original = window.owlAPI.getDaemonToken;
  afterEach(() => {
    window.owlAPI.getDaemonToken = original;
  });

  it('reads window.owlAPI.getDaemonToken() fresh on each call (rotation)', () => {
    const getDaemonToken = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('tok-1')
      .mockReturnValueOnce('tok-2');
    window.owlAPI.getDaemonToken = getDaemonToken;

    const adapter = createElectronAdapter();
    // A cached value would return 'tok-1' twice; a live passthrough sees the
    // rotated token on the second read.
    expect(adapter.getDaemonToken?.()).toBe('tok-1');
    expect(adapter.getDaemonToken?.()).toBe('tok-2');
    expect(getDaemonToken).toHaveBeenCalledTimes(2);
  });

  it('passes through null when no token is available', () => {
    window.owlAPI.getDaemonToken = () => null;
    expect(createElectronAdapter().getDaemonToken?.()).toBeNull();
  });
});
