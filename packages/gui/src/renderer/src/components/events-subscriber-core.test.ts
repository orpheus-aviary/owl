import type { SyncStatusSnapshot } from '@/lib/api';
import { describe, expect, it, vi } from 'vitest';
import { handleDaemonEvent } from './events-subscriber-core';

function makeHandlers() {
  return {
    openNoteById: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn(),
    setSyncStatus: vi.fn(),
  };
}

function makeSnapshot(overrides: Partial<SyncStatusSnapshot> = {}): SyncStatusSnapshot {
  return {
    state: 'idle',
    server_url: 'http://localhost:48080',
    device_id: 'dev-1',
    workspace_id: 'ws-1',
    pending_count: 0,
    pulled_seq: 5,
    pushed_seq: 5,
    last_sync_at: 1_700_000_000_000,
    last_error: null,
    ...overrides,
  };
}

describe('handleDaemonEvent — open_note', () => {
  it('opens the note and navigates to / on a well-formed open_note', async () => {
    const handlers = makeHandlers();
    await handleDaemonEvent(
      'open_note',
      JSON.stringify({ type: 'open_note', note_id: 'abc' }),
      handlers,
    );
    expect(handlers.openNoteById).toHaveBeenCalledWith('abc');
    expect(handlers.navigate).toHaveBeenCalledWith('/');
  });

  it('ignores unknown event names', async () => {
    const handlers = makeHandlers();
    await handleDaemonEvent('config_changed', JSON.stringify({ note_id: 'abc' }), handlers);
    expect(handlers.openNoteById).not.toHaveBeenCalled();
    expect(handlers.navigate).not.toHaveBeenCalled();
    expect(handlers.setSyncStatus).not.toHaveBeenCalled();
  });

  it('warns and returns on malformed JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = makeHandlers();
    await handleDaemonEvent('open_note', '{not json', handlers);
    expect(handlers.openNoteById).not.toHaveBeenCalled();
    expect(handlers.navigate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns and returns when note_id is missing or non-string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = makeHandlers();

    await handleDaemonEvent('open_note', JSON.stringify({}), handlers);
    await handleDaemonEvent('open_note', JSON.stringify({ note_id: 42 }), handlers);
    await handleDaemonEvent('open_note', JSON.stringify({ note_id: '' }), handlers);

    expect(handlers.openNoteById).not.toHaveBeenCalled();
    expect(handlers.navigate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('swallows openNoteById rejections with a warn (no unhandled rejection)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = {
      openNoteById: vi.fn().mockRejectedValue(new Error('boom')),
      navigate: vi.fn(),
      setSyncStatus: vi.fn(),
    };

    await expect(
      handleDaemonEvent(
        'open_note',
        JSON.stringify({ type: 'open_note', note_id: 'abc' }),
        handlers,
      ),
    ).resolves.toBeUndefined();

    expect(handlers.openNoteById).toHaveBeenCalled();
    // navigate not called when the fetch failed — avoids flashing an
    // empty editor tab when the note can't be loaded.
    expect(handlers.navigate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('handleDaemonEvent — sync:status_changed', () => {
  it('forwards a well-formed snapshot to setSyncStatus', async () => {
    const handlers = makeHandlers();
    const snapshot = makeSnapshot({ state: 'syncing' });
    await handleDaemonEvent(
      'sync:status_changed',
      JSON.stringify({ type: 'sync:status_changed', status: snapshot }),
      handlers,
    );
    expect(handlers.setSyncStatus).toHaveBeenCalledWith(snapshot);
  });

  it('accepts all four known states', async () => {
    const handlers = makeHandlers();
    for (const state of ['idle', 'syncing', 'error', 'offline'] as const) {
      const snapshot = makeSnapshot({ state });
      await handleDaemonEvent(
        'sync:status_changed',
        JSON.stringify({ status: snapshot }),
        handlers,
      );
    }
    expect(handlers.setSyncStatus).toHaveBeenCalledTimes(4);
  });

  it('warns and returns on malformed JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = makeHandlers();
    await handleDaemonEvent('sync:status_changed', '{not json', handlers);
    expect(handlers.setSyncStatus).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns when status is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = makeHandlers();
    await handleDaemonEvent('sync:status_changed', JSON.stringify({}), handlers);
    expect(handlers.setSyncStatus).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns and drops unknown state values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = makeHandlers();
    await handleDaemonEvent(
      'sync:status_changed',
      JSON.stringify({ status: { ...makeSnapshot(), state: 'mystery' } }),
      handlers,
    );
    expect(handlers.setSyncStatus).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
