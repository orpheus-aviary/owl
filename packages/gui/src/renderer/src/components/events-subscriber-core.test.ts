import type { SyncStatusSnapshot } from '@/lib/api';
import { describe, expect, it, vi } from 'vitest';
import { EVENT_TYPES, handleDaemonEvent } from './events-subscriber-core';

function makeHandlers() {
  return {
    openNote: vi.fn().mockResolvedValue('opened'),
    setSyncStatus: vi.fn(),
    refreshConflicts: vi.fn().mockResolvedValue(undefined),
    bumpConflicts: vi.fn(),
    onConnected: vi.fn(),
    onRemoteChanges: vi.fn(),
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
  it('opens the note via the injected opener on a well-formed open_note', async () => {
    const handlers = makeHandlers();
    await handleDaemonEvent(
      'open_note',
      JSON.stringify({ type: 'open_note', note_id: 'abc' }),
      handlers,
    );
    expect(handlers.openNote).toHaveBeenCalledWith({ noteId: 'abc' });
  });

  it('ignores unknown event names', async () => {
    const handlers = makeHandlers();
    await handleDaemonEvent('config_changed', JSON.stringify({ note_id: 'abc' }), handlers);
    expect(handlers.openNote).not.toHaveBeenCalled();
    expect(handlers.setSyncStatus).not.toHaveBeenCalled();
    expect(handlers.onConnected).not.toHaveBeenCalled();
  });

  it('warns and returns on malformed JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = makeHandlers();
    await handleDaemonEvent('open_note', '{not json', handlers);
    expect(handlers.openNote).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns and returns when note_id is missing or non-string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = makeHandlers();

    await handleDaemonEvent('open_note', JSON.stringify({}), handlers);
    await handleDaemonEvent('open_note', JSON.stringify({ note_id: 42 }), handlers);
    await handleDaemonEvent('open_note', JSON.stringify({ note_id: '' }), handlers);

    expect(handlers.openNote).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('swallows opener rejections with a warn (no unhandled rejection)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = {
      ...makeHandlers(),
      openNote: vi.fn().mockRejectedValue(new Error('boom')),
    };

    await expect(
      handleDaemonEvent(
        'open_note',
        JSON.stringify({ type: 'open_note', note_id: 'abc' }),
        handlers,
      ),
    ).resolves.toBeUndefined();

    expect(handlers.openNote).toHaveBeenCalled();
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

describe('handleDaemonEvent — conflicts:changed (P5-c §6.19)', () => {
  it('calls refreshConflicts() then bumpConflicts()', async () => {
    const handlers = makeHandlers();
    await handleDaemonEvent(
      'conflicts:changed',
      JSON.stringify({ type: 'conflicts:changed' }),
      handlers,
    );
    expect(handlers.refreshConflicts).toHaveBeenCalledTimes(1);
    expect(handlers.bumpConflicts).toHaveBeenCalledTimes(1);
  });

  it('ignores rawData payload (event is payload-free)', async () => {
    const handlers = makeHandlers();
    await handleDaemonEvent('conflicts:changed', 'not-json-at-all', handlers);
    expect(handlers.refreshConflicts).toHaveBeenCalledTimes(1);
    expect(handlers.bumpConflicts).toHaveBeenCalledTimes(1);
  });

  it('still bumps even if refresh fails (refresh swallows its own errors)', async () => {
    const handlers = {
      ...makeHandlers(),
      refreshConflicts: vi.fn().mockResolvedValue(undefined),
    };
    await handleDaemonEvent('conflicts:changed', '{}', handlers);
    expect(handlers.bumpConflicts).toHaveBeenCalledTimes(1);
  });
});

describe('handleDaemonEvent — hello (① connection re-probe)', () => {
  it('calls onConnected() on a hello frame (and nothing else)', async () => {
    const handlers = makeHandlers();
    await handleDaemonEvent('hello', '', handlers);
    expect(handlers.onConnected).toHaveBeenCalledTimes(1);
    expect(handlers.setSyncStatus).not.toHaveBeenCalled();
    expect(handlers.openNote).not.toHaveBeenCalled();
  });

  it('ignores the hello payload (connection signal, not a business event)', async () => {
    const handlers = makeHandlers();
    await handleDaemonEvent('hello', 'anything-here', handlers);
    expect(handlers.onConnected).toHaveBeenCalledTimes(1);
  });

  it('is NOT a member of EVENT_TYPES (not in the OwlEvent union)', () => {
    expect([...EVENT_TYPES]).not.toContain('hello');
  });
});

describe('handleDaemonEvent — notes:changed (Problem A / Phase 1b)', () => {
  it('pokes the remote-changes handler', async () => {
    const handlers = makeHandlers();
    await handleDaemonEvent('notes:changed', JSON.stringify({ type: 'notes:changed' }), handlers);
    expect(handlers.onRemoteChanges).toHaveBeenCalledTimes(1);
  });

  // Payload-free by contract, so an empty / junk body must still poke rather
  // than being dropped as malformed — the receiver re-reads from the daemon.
  it('ignores the payload entirely', async () => {
    const handlers = makeHandlers();
    await handleDaemonEvent('notes:changed', '', handlers);
    expect(handlers.onRemoteChanges).toHaveBeenCalledTimes(1);
  });

  it('does not fire on other events', async () => {
    const handlers = makeHandlers();
    await handleDaemonEvent('conflicts:changed', '{}', handlers);
    expect(handlers.onRemoteChanges).not.toHaveBeenCalled();
  });
});

describe('EVENT_TYPES is the source of truth (P5-c §6.30)', () => {
  it('lists every event handled by handleDaemonEvent', () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      ['conflicts:changed', 'notes:changed', 'open_note', 'sync:status_changed'].sort(),
    );
  });
});
