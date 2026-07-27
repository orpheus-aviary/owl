import { getSyncStatus } from '@/lib/api';
import type { SyncStatusResult, SyncStatusSnapshot } from '@/lib/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_STATUS_MIN_DISPLAY_MS, useSyncStatus } from './sync-status';

vi.mock('@/lib/api', () => ({ getSyncStatus: vi.fn() }));

// 0.6.2 W3 — the store asks the host to recover from `auth_required`; the web
// adapter has no such capability, so it is an optional platform member.
const requestRecovery = vi.hoisted(() => vi.fn());
vi.mock('@/platform', () => ({
  getPlatform: () => ({ sync: { requestRecovery } }),
}));

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
    auth_reason: null,
    ...extra,
  };
}

function resetStore(): void {
  useSyncStatus.setState({
    snapshot: null,
    probeStatus: 'pending',
    minDisplayUntilMs: 0,
    pendingTimer: null,
    pendingSnapshot: null,
  });
}

function okResult(over: Partial<SyncStatusResult> = {}) {
  return {
    success: true as const,
    data: {
      configured: true,
      authenticated: true,
      server_url: 'https://skybridge.example',
      device_id: 'dev-1',
      workspace_id: 'ws-1',
      pending_count: 0,
      pulled_seq: 0,
      pushed_seq: 0,
      last_sync_at: null,
      state: 'idle' as const,
      auth_reason: null,
      last_error: null,
      ...over,
    },
  };
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

describe('useSyncStatus probe status (①)', () => {
  const mockGet = vi.mocked(getSyncStatus);

  beforeEach(() => {
    mockGet.mockReset();
    resetStore();
  });

  it('fetch success → probeStatus ok + snapshot applied (state overlaid as idle)', async () => {
    mockGet.mockResolvedValue(okResult({ server_url: 'https://srv' }));
    await useSyncStatus.getState().fetch();
    expect(useSyncStatus.getState().probeStatus).toBe('ok');
    expect(useSyncStatus.getState().snapshot?.server_url).toBe('https://srv');
    expect(useSyncStatus.getState().snapshot?.state).toBe('idle');
  });

  it('fetch throw (daemon down) → probeStatus unreachable, snapshot left null', async () => {
    mockGet.mockRejectedValue(new Error('ECONNREFUSED'));
    await useSyncStatus.getState().fetch();
    expect(useSyncStatus.getState().probeStatus).toBe('unreachable');
    expect(useSyncStatus.getState().snapshot).toBe(null);
  });

  it('fetch that reaches an unconfigured daemon (no data) is still ok', async () => {
    // A 200 with no snapshot body still means the daemon is reachable.
    mockGet.mockResolvedValue({ success: true });
    await useSyncStatus.getState().fetch();
    expect(useSyncStatus.getState().probeStatus).toBe('ok');
    expect(useSyncStatus.getState().snapshot).toBe(null);
  });

  it('setSnapshot (SSE frame arriving) implies probeStatus ok', () => {
    useSyncStatus.setState({ probeStatus: 'unreachable' });
    useSyncStatus.getState().setSnapshot(snap('idle'));
    expect(useSyncStatus.getState().probeStatus).toBe('ok');
  });

  it('concurrent fetch() calls collapse to a single in-flight GET (single-flight)', async () => {
    let resolveGet: (v: ReturnType<typeof okResult>) => void = () => {};
    mockGet.mockImplementation(
      () =>
        new Promise((r) => {
          resolveGet = r;
        }),
    );

    const p1 = useSyncStatus.getState().fetch();
    const p2 = useSyncStatus.getState().fetch();
    // Both callers share the one in-flight promise; only one GET was issued.
    expect(p1).toBe(p2);
    expect(mockGet).toHaveBeenCalledTimes(1);

    resolveGet(okResult());
    await Promise.all([p1, p2]);
    expect(mockGet).toHaveBeenCalledTimes(1);

    // After it settles the guard clears — a fresh fetch issues a new GET.
    mockGet.mockResolvedValue(okResult());
    await useSyncStatus.getState().fetch();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});

// ─── 0.6.2 W3: commitSnapshot is the single funnel ───────────────────

describe('commitSnapshot (0.6.2 W3)', () => {
  const mockGet = vi.mocked(getSyncStatus);

  beforeEach(() => {
    mockGet.mockReset();
    resetStore();
    requestRecovery.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops an auth_required snapshot with no reason', () => {
    useSyncStatus.getState().setSnapshot(snap('auth_required'));
    expect(useSyncStatus.getState().snapshot).toBe(null);
    expect(requestRecovery).not.toHaveBeenCalled();
  });

  it('drops a non-auth snapshot that carries a reason', () => {
    useSyncStatus.getState().setSnapshot(snap('idle', { auth_reason: 'token_rejected' }));
    expect(useSyncStatus.getState().snapshot).toBe(null);
  });

  it('entering auth_required over SSE asks the host to recover', () => {
    useSyncStatus.getState().setSnapshot(snap('idle'));
    useSyncStatus.getState().setSnapshot(snap('auth_required', { auth_reason: 'token_rejected' }));
    expect(requestRecovery).toHaveBeenCalledTimes(1);
    expect(requestRecovery).toHaveBeenCalledWith('token_rejected');
  });

  it('the cold-start GET path goes through it too (the state is no longer faked)', async () => {
    mockGet.mockResolvedValue(okResult({ state: 'auth_required', auth_reason: 'missing_session' }));
    await useSyncStatus.getState().fetch();
    expect(useSyncStatus.getState().snapshot?.state).toBe('auth_required');
    expect(requestRecovery).toHaveBeenCalledWith('missing_session');
  });

  it('staying in the same reason does not re-trigger recovery', () => {
    const s = useSyncStatus.getState();
    s.setSnapshot(snap('auth_required', { auth_reason: 'token_rejected' }));
    s.setSnapshot(snap('auth_required', { auth_reason: 'token_rejected', pending_count: 3 }));
    expect(requestRecovery).toHaveBeenCalledTimes(1);
  });

  it('an escalated reason triggers again', () => {
    const s = useSyncStatus.getState();
    s.setSnapshot(snap('auth_required', { auth_reason: 'missing_session' }));
    s.setSnapshot(snap('auth_required', { auth_reason: 'token_rejected' }));
    expect(requestRecovery).toHaveBeenCalledTimes(2);
  });

  it('credentials_missing never triggers recovery (terminal)', () => {
    useSyncStatus
      .getState()
      .setSnapshot(snap('auth_required', { auth_reason: 'credentials_missing' }));
    expect(useSyncStatus.getState().snapshot?.auth_reason).toBe('credentials_missing');
    expect(requestRecovery).not.toHaveBeenCalled();
  });

  it('the deferred (min-display) path also commits through it', async () => {
    vi.useFakeTimers();
    try {
      const s = useSyncStatus.getState();
      s.setSnapshot(snap('syncing'));
      s.setSnapshot(snap('auth_required', { auth_reason: 'token_rejected' }));
      // Still inside the min-display window → queued, not applied yet.
      expect(useSyncStatus.getState().snapshot?.state).toBe('syncing');
      expect(requestRecovery).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SYNC_STATUS_MIN_DISPLAY_MS);
      expect(useSyncStatus.getState().snapshot?.state).toBe('auth_required');
      expect(requestRecovery).toHaveBeenCalledWith('token_rejected');
    } finally {
      vi.useRealTimers();
    }
  });
});
