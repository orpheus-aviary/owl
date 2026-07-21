import { afterEach, describe, expect, it } from 'vitest';
import { currentGen, isStale, useSessionEpoch } from './session-epoch';

function resetEpoch(): void {
  useSessionEpoch.setState({ epoch: 0, phase: 'bootstrapping' });
}

afterEach(resetEpoch);

describe('session-epoch transitions', () => {
  it('starts at epoch 0 / bootstrapping (cold-start covered by the overlay)', () => {
    resetEpoch();
    expect(useSessionEpoch.getState().epoch).toBe(0);
    expect(useSessionEpoch.getState().phase).toBe('bootstrapping');
  });

  it('beginInvalidate bumps epoch and stays active (no bootstrap follows)', () => {
    resetEpoch();
    useSessionEpoch.getState().endBootstrap(0); // → active
    const next = useSessionEpoch.getState().beginInvalidate();
    expect(next).toBe(1);
    expect(useSessionEpoch.getState().epoch).toBe(1);
    expect(useSessionEpoch.getState().phase).toBe('active');
  });

  it('beginBootstrap atomically bumps epoch AND flips to bootstrapping', () => {
    resetEpoch();
    useSessionEpoch.getState().endBootstrap(0);
    expect(useSessionEpoch.getState().phase).toBe('active');
    const gen = useSessionEpoch.getState().beginBootstrap();
    expect(gen).toBe(1);
    expect(useSessionEpoch.getState().epoch).toBe(1);
    expect(useSessionEpoch.getState().phase).toBe('bootstrapping');
  });

  it('endBootstrap only flips to active when gen is still current', () => {
    resetEpoch();
    const gen = useSessionEpoch.getState().beginBootstrap(); // 1, bootstrapping
    // A newer begin supersedes it — the stale endBootstrap must NOT close the
    // newer session's overlay.
    const newer = useSessionEpoch.getState().beginBootstrap(); // 2, bootstrapping
    useSessionEpoch.getState().endBootstrap(gen); // stale
    expect(useSessionEpoch.getState().phase).toBe('bootstrapping');
    useSessionEpoch.getState().endBootstrap(newer); // current
    expect(useSessionEpoch.getState().phase).toBe('active');
  });
});

describe('generation guard helpers', () => {
  it('isStale reflects epoch movement', () => {
    resetEpoch();
    const gen = currentGen();
    expect(isStale(gen)).toBe(false);
    useSessionEpoch.getState().beginBootstrap();
    expect(isStale(gen)).toBe(true);
  });
});
