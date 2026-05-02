import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDirectBackend } from './direct.js';
import type { OwlBackend } from './types.js';

describe('DirectBackend', () => {
  let backend: OwlBackend;

  beforeEach(async () => {
    backend = await createDirectBackend({ dbPath: ':memory:' });
  });
  afterEach(async () => {
    await backend.close();
  });

  it('createNote + getNote round-trip with ms timestamps', async () => {
    const created = await backend.createNote({ content: 'hello', tags: ['#greet'] });
    expect(created.id).toBeTruthy();
    expect(typeof created.updatedAt).toBe('number');
    expect(created.tags.map((t) => t.tagValue)).toEqual(['greet']);

    const got = await backend.getNote(created.id);
    expect(got?.content).toBe('hello');
  });

  it('listNotes paginates', async () => {
    for (let i = 0; i < 3; i++) await backend.createNote({ content: `n${i}` });
    const result = await backend.listNotes({ limit: 2, page: 1 });
    expect(result.items.length).toBe(2);
    expect(result.total).toBeGreaterThanOrEqual(3);
  });

  it('updateNote PATCH with expectedUpdatedAt mismatch throws VERSION_MISMATCH CliError', async () => {
    const note = await backend.createNote({ content: 'cas' });
    await expect(
      backend.updateNote(`n-missing-or-${note.id}`, { content: 'x' }, { expectedUpdatedAt: 1 }),
    ).resolves.toBeNull();
    // Actual CAS test:
    await expect(
      backend.updateNote(note.id, { content: 'x' }, { expectedUpdatedAt: note.updatedAt - 1 }),
    ).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
  });

  it('replaceNote writes all three fields', async () => {
    const note = await backend.createNote({ content: 'orig', tags: ['#old'] });
    const replaced = await backend.replaceNote(note.id, {
      content: 'new',
      folderId: null,
      tags: ['#brandnew'],
    });
    expect(replaced?.content).toBe('new');
    expect(replaced?.tags.map((t) => t.tagValue)).toEqual(['brandnew']);
  });

  it('deleteNote returns note with trashLevel=1, null auto_delete_at (level 1)', async () => {
    const note = await backend.createNote({ content: 'del-me' });
    const deleted = await backend.deleteNote(note.id, { rejectIfTrashed: false });
    expect(deleted?.trashLevel).toBe(1);
    expect(deleted?.autoDeleteAt).toBeNull();
  });

  it('deleteNote with rejectIfTrashed=true on trashed note throws ALREADY_TRASHED', async () => {
    const note = await backend.createNote({ content: 'x' });
    await backend.deleteNote(note.id);
    await expect(backend.deleteNote(note.id, { rejectIfTrashed: true })).rejects.toMatchObject({
      code: 'ALREADY_TRASHED',
    });
  });

  it('restoreNote returns note with trashLevel=0', async () => {
    const note = await backend.createNote({ content: 'r' });
    await backend.deleteNote(note.id);
    const restored = await backend.restoreNote(note.id);
    expect(restored?.trashLevel).toBe(0);
  });

  it('listHashtagTags frequent=true returns counts', async () => {
    await backend.createNote({ content: 'x', tags: ['#alpha'] });
    await backend.createNote({ content: 'y', tags: ['#alpha', '#beta'] });
    const result = await backend.listHashtagTags({ frequent: true });
    const alpha = result.find((r) => r.value === 'alpha');
    expect(alpha?.count).toBe(2);
  });

  it('listFolders returns empty array on fresh db', async () => {
    expect(await backend.listFolders()).toEqual([]);
  });
});
