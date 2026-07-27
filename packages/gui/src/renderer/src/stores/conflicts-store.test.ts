import type { ConflictRecord } from '@/lib/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConflictsStore } from './conflicts-store';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    getConflictCount: vi.fn(),
    listConflicts: vi.fn(),
  };
});

import { getConflictCount, listConflicts } from '@/lib/api';

function resetStore(): void {
  useConflictsStore.setState({ count: 0, list: [], loading: false, error: null });
}

function row(id: string, entityId: string): ConflictRecord {
  return {
    id,
    entity_type: 'note',
    entity_id: entityId,
    local_seq: null,
    remote_seq: null,
    detected_at: 100,
    resolved_at: null,
    resolution: null,
    losing_side: 'local',
    local_payload: '{}',
    remote_payload: '{}',
    local_updated_at_ms: 50,
    remote_updated_at_ms: 100,
    local_lww_counter: 0,
    remote_lww_counter: 0,
    local_device_id: null,
    remote_device_id: null,
  };
}

describe('useConflictsStore (P5-c §6.19 / §6.33)', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetStore();
  });

  it('refresh() pulls /conflicts/count and stores the value', async () => {
    vi.mocked(getConflictCount).mockResolvedValue({
      success: true,
      data: { count: 3 },
    });
    await useConflictsStore.getState().refresh();
    expect(useConflictsStore.getState().count).toBe(3);
    expect(useConflictsStore.getState().error).toBeNull();
  });

  it('refresh() captures fetch errors without throwing', async () => {
    vi.mocked(getConflictCount).mockRejectedValue(new Error('boom'));
    await useConflictsStore.getState().refresh();
    expect(useConflictsStore.getState().error).toBe('boom');
    expect(useConflictsStore.getState().count).toBe(0);
  });

  it('refreshList() populates list + toggles loading (does NOT touch count)', async () => {
    vi.mocked(listConflicts).mockResolvedValue({
      success: true,
      data: { conflicts: [row('cr-a', 'note-a'), row('cr-b', 'note-b')] },
    });
    // Seed a count that only refresh() should own — refreshList must leave it.
    useConflictsStore.setState({ count: 99 });
    const before = useConflictsStore.getState().loading;
    expect(before).toBe(false);

    const promise = useConflictsStore.getState().refreshList(50);
    expect(useConflictsStore.getState().loading).toBe(true);
    await promise;

    expect(useConflictsStore.getState().loading).toBe(false);
    expect(useConflictsStore.getState().list.length).toBe(2);
    // AC4: count is owned by refresh(); refreshList (capped at limit) must not
    // clobber it, or the sidebar 红点 under-reports when there are >limit rows.
    expect(useConflictsStore.getState().count).toBe(99);
    expect(vi.mocked(listConflicts)).toHaveBeenCalledWith(50);
  });

  it('refreshList() error path clears loading + stores error message', async () => {
    vi.mocked(listConflicts).mockRejectedValue(new Error('network down'));
    await useConflictsStore.getState().refreshList();
    expect(useConflictsStore.getState().loading).toBe(false);
    expect(useConflictsStore.getState().error).toBe('network down');
  });

  it('cold-start refresh() can be called repeatedly without leaking state', async () => {
    vi.mocked(getConflictCount).mockResolvedValueOnce({ success: true, data: { count: 5 } });
    await useConflictsStore.getState().refresh();
    expect(useConflictsStore.getState().count).toBe(5);

    vi.mocked(getConflictCount).mockResolvedValueOnce({ success: true, data: { count: 0 } });
    await useConflictsStore.getState().refresh();
    expect(useConflictsStore.getState().count).toBe(0);
  });
});
