import type { SyncStatusSnapshot } from '@/lib/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_STATUS_MIN_DISPLAY_MS, useSyncStatus } from './sync-status';

function snap(
  state: SyncStatusSnapshot['state'],
  extra: Partial<SyncStatusSnapshot> = {},
): SyncStatusSnapshot {
  return {
    state,
    server_url: 'https://skybridge.example',
    device_id: 'dev-1',
    workspace_id: 'ws-1',
    pending_count: 0,
    pulled_seq: 0,
    pushed_seq: 0,
    last_sync_at: null,
    last_error: null,
    ...extra,
  };
}

function resetStore(): void {
  useSyncStatus.setState({
    snapshot: null,
    minDisplayUntilMs: 0,
    pendingTimer: null,
    pendingSnapshot: null,
  });
}

describe('useSyncStatus minimum-display timing (P5-c G3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
  });
  afterEach(() => {
    // clear any pending setTimeout (cancelled via clearPending in real flow,
    // but tests may bail before the deferred transition fires).
    const { pendingTimer } = useSyncStatus.getState();
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    vi.useRealTimers();
  });

  it('fast path: idle landing < 400 ms after syncing is deferred until the deadline', () => {
    const { setSnapshot } = useSyncStatus.getState();
    setSnapshot(snap('syncing'));
    expect(useSyncStatus.getState().snapshot?.state).toBe('syncing');

    // 100 ms later — well inside the window — idle arrives.
    vi.advanceTimersByTime(100);
    setSnapshot(snap('idle', { last_sync_at: 12345 }));

    // Visible state is still `syncing`; the idle update sits in pendingSnapshot.
    expect(useSyncStatus.getState().snapshot?.state).toBe('syncing');
    expect(useSyncStatus.getState().pendingSnapshot?.state).toBe('idle');

    // Cross the 400 ms threshold — timer fires, idle snapshot applies.
    vi.advanceTimersByTime(SYNC_STATUS_MIN_DISPLAY_MS - 100);
    expect(useSyncStatus.getState().snapshot?.state).toBe('idle');
    expect(useSyncStatus.getState().snapshot?.last_sync_at).toBe(12345);
    expect(useSyncStatus.getState().pendingTimer).toBe(null);
    expect(useSyncStatus.getState().pendingSnapshot).toBe(null);
  });

  it('slow path: idle landing past 400 ms after syncing applies immediately', () => {
    const { setSnapshot } = useSyncStatus.getState();
    setSnapshot(snap('syncing'));
    vi.advanceTimersByTime(SYNC_STATUS_MIN_DISPLAY_MS + 50);
    setSnapshot(snap('idle'));
    expect(useSyncStatus.getState().snapshot?.state).toBe('idle');
    expect(useSyncStatus.getState().pendingTimer).toBe(null);
  });

  it('multiple non-syncing updates inside the window — latest wins, deadline not re-extended', () => {
    const { setSnapshot } = useSyncStatus.getState();
    setSnapshot(snap('syncing'));

    vi.advanceTimersByTime(100);
    setSnapshot(snap('error', { last_error: 'first' }));
    vi.advanceTimersByTime(100);
    setSnapshot(snap('idle', { last_sync_at: 999 }));

    // Visible: still `syncing`. pendingSnapshot: the latest (idle).
    expect(useSyncStatus.getState().snapshot?.state).toBe('syncing');
    expect(useSyncStatus.getState().pendingSnapshot?.state).toBe('idle');

    // Cross original 400 ms deadline (we've moved 200 ms in, need 200 more).
    vi.advanceTimersByTime(200);
    expect(useSyncStatus.getState().snapshot?.state).toBe('idle');
    expect(useSyncStatus.getState().snapshot?.last_sync_at).toBe(999);
  });

  it('syncing → syncing inside the window clears the pending transition and refreshes deadline', () => {
    const { setSnapshot } = useSyncStatus.getState();
    setSnapshot(snap('syncing'));

    vi.advanceTimersByTime(100);
    setSnapshot(snap('idle')); // queued for the 400 ms deadline
    expect(useSyncStatus.getState().pendingSnapshot?.state).toBe('idle');

    // Re-enter syncing — pending must be dropped, deadline reset to now + 400.
    setSnapshot(snap('syncing'));
    expect(useSyncStatus.getState().snapshot?.state).toBe('syncing');
    expect(useSyncStatus.getState().pendingSnapshot).toBe(null);
    expect(useSyncStatus.getState().pendingTimer).toBe(null);

    // The original 100 + 300 = 400 ms point should NOT flip us to idle.
    vi.advanceTimersByTime(300);
    expect(useSyncStatus.getState().snapshot?.state).toBe('syncing');
  });

  it('cold-start idle (no prior syncing) applies immediately without deferral', () => {
    const { setSnapshot } = useSyncStatus.getState();
    setSnapshot(snap('idle'));
    expect(useSyncStatus.getState().snapshot?.state).toBe('idle');
    expect(useSyncStatus.getState().pendingTimer).toBe(null);
  });
});
