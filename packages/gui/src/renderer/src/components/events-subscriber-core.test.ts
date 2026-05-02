import { describe, expect, it, vi } from 'vitest';
import { handleDaemonEvent } from './events-subscriber-core';

function makeHandlers() {
  return {
    openNoteById: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn(),
  };
}

describe('handleDaemonEvent', () => {
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
