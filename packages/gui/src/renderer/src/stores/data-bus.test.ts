import { describe, expect, it } from 'vitest';
import { useDataBus } from './data-bus';

describe('data-bus', () => {
  it('bumpNotes increments noteVersion exactly once per call', () => {
    const before = useDataBus.getState().noteVersion;
    useDataBus.getState().bumpNotes();
    expect(useDataBus.getState().noteVersion).toBe(before + 1);
    useDataBus.getState().bumpNotes();
    expect(useDataBus.getState().noteVersion).toBe(before + 2);
  });

  it('bumpFolders increments folderVersion independently of noteVersion', () => {
    const beforeNote = useDataBus.getState().noteVersion;
    const beforeFolder = useDataBus.getState().folderVersion;
    useDataBus.getState().bumpFolders();
    expect(useDataBus.getState().folderVersion).toBe(beforeFolder + 1);
    expect(useDataBus.getState().noteVersion).toBe(beforeNote);
  });

  it('subscribe fires when version changes', () => {
    const calls: number[] = [];
    const unsubscribe = useDataBus.subscribe((state, prev) => {
      if (state.noteVersion !== prev.noteVersion) calls.push(state.noteVersion);
    });
    useDataBus.getState().bumpNotes();
    useDataBus.getState().bumpFolders(); // unrelated, should not fire
    useDataBus.getState().bumpNotes();
    unsubscribe();
    expect(calls.length).toBe(2);
    expect(calls[1]).toBe(calls[0] + 1);
  });

  it('bumpConflicts increments conflictVersion independently (P5-c §6.19)', () => {
    const beforeNote = useDataBus.getState().noteVersion;
    const beforeFolder = useDataBus.getState().folderVersion;
    const beforeConflict = useDataBus.getState().conflictVersion;
    useDataBus.getState().bumpConflicts();
    expect(useDataBus.getState().conflictVersion).toBe(beforeConflict + 1);
    expect(useDataBus.getState().noteVersion).toBe(beforeNote);
    expect(useDataBus.getState().folderVersion).toBe(beforeFolder);
  });
});
