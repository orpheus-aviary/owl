import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partial-mock the API: keep the real module (many stores import from it) but
// stub the endpoints bootstrap + the guarded fetches touch, so no real fetch
// escapes and each test controls the timing/shape.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    getConfig: vi.fn(async () => ({ success: true as const })),
    listFolders: vi.fn(async () => ({ success: true as const, data: [] })),
    listNotes: vi.fn(async () => ({ success: true as const, data: [], total: 0 })),
    getConflictCount: vi.fn(async () => ({ success: true as const, data: { count: 0 } })),
    getSyncStatus: vi.fn(async () => ({ success: true as const })),
  };
});

import * as api from '@/lib/api';
import { useNoteStore } from '@/stores/note-store';
import { useSessionEpoch } from '@/stores/session-epoch';
import { activateSession, invalidateSession } from './session-actions';

const listNotes = vi.mocked(api.listNotes);
const getConfig = vi.mocked(api.getConfig);

function noteRow(id: string) {
  return { id, content: `# ${id}` } as unknown as NonNullable<
    Awaited<ReturnType<typeof api.listNotes>>['data']
  >[number];
}

beforeEach(() => {
  vi.clearAllMocks();
  listNotes.mockResolvedValue({ success: true, data: [], total: 0 });
  getConfig.mockResolvedValue({ success: true });
  useSessionEpoch.setState({ epoch: 0, phase: 'active' });
  useNoteStore.getState().reset();
});

afterEach(() => {
  useSessionEpoch.setState({ epoch: 0, phase: 'bootstrapping' });
});

describe('invalidateSession', () => {
  it('bumps epoch, stays active, wipes stores, and runs NO bootstrap', () => {
    useNoteStore.setState({ notes: [noteRow('old')], total: 1 });
    invalidateSession();

    expect(useSessionEpoch.getState().epoch).toBe(1);
    expect(useSessionEpoch.getState().phase).toBe('active');
    expect(useNoteStore.getState().notes).toEqual([]);
    // No cold-start fetches on a pure invalidate (login screen shows instead).
    expect(getConfig).not.toHaveBeenCalled();
    expect(listNotes).not.toHaveBeenCalled();
  });
});

describe('activateSession', () => {
  it('bumps epoch → bootstrapping, resets stores, refills them, then goes active', async () => {
    // Seed the previous session's data + queue the new session's list.
    useNoteStore.setState({ notes: [noteRow('old')], total: 1 });
    listNotes.mockResolvedValue({ success: true, data: [noteRow('fresh')], total: 1 });

    const p = activateSession();
    // Synchronously after beginBootstrap: epoch bumped, overlay up.
    expect(useSessionEpoch.getState().epoch).toBe(1);
    expect(useSessionEpoch.getState().phase).toBe('bootstrapping');

    await p;
    // Bootstrap ran (config + list) and the store carries the NEW session's
    // data, not the seeded old row → proves reset-then-refill.
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(useNoteStore.getState().notes).toEqual([noteRow('fresh')]);
    // Overlay closes once bootstrap for the current gen finishes.
    expect(useSessionEpoch.getState().phase).toBe('active');
  });

  it('a bootstrap superseded mid-flight never closes the newer overlay', async () => {
    // bootstrap issues two listNotes (note list + folder panel) — collect both
    // resolvers so the whole allSettled can complete.
    const resolvers: Array<(v: Awaited<ReturnType<typeof api.listNotes>>) => void> = [];
    listNotes.mockImplementation(
      () =>
        new Promise((r) => {
          resolvers.push(r);
        }),
    );

    const first = activateSession(); // gen 1, hangs on listNotes
    expect(useSessionEpoch.getState().epoch).toBe(1);

    // A newer switch supersedes it before the first finishes.
    useSessionEpoch.getState().beginBootstrap(); // gen 2, bootstrapping
    for (const r of resolvers) r({ success: true, data: [], total: 0 });
    await first;

    // The stale (gen 1) bootstrap's endBootstrap must NOT flip gen 2 to active.
    expect(useSessionEpoch.getState().epoch).toBe(2);
    expect(useSessionEpoch.getState().phase).toBe('bootstrapping');
  });
});

describe('generation guard on a store fetch', () => {
  it('a fetch that resolves after a session switch writes nothing', async () => {
    let releaseList: (v: Awaited<ReturnType<typeof api.listNotes>>) => void = () => {};
    listNotes.mockImplementation(
      () =>
        new Promise((r) => {
          releaseList = r;
        }),
    );

    // Start a fetch in the current session, then switch sessions while it's in
    // flight, then let it resolve with the OLD session's (non-empty) data.
    const fetching = useNoteStore.getState().fetchNotes();
    useSessionEpoch.getState().beginBootstrap(); // session moved on
    releaseList({ success: true, data: [noteRow('stale')], total: 1 });
    await fetching;

    // The stale result was dropped — the new session's empty list stands.
    expect(useNoteStore.getState().notes).toEqual([]);
    expect(useNoteStore.getState().total).toBe(0);
  });
});
