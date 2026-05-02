import { describe, expect, it } from 'vitest';
import type { CliNote } from '../backend/types.js';
import { buildPreview, deriveTitle, serializeNote, serializeSearchItem } from './serialize.js';

describe('deriveTitle', () => {
  it('returns first non-empty line trimmed', () => {
    expect(deriveTitle('  \n  hello world  \nsecond line')).toBe('hello world');
  });
  it('returns empty string for whitespace-only content', () => {
    expect(deriveTitle('   \n\n')).toBe('');
  });
});

describe('buildPreview', () => {
  it('collapses whitespace and truncates at 200 chars by default', () => {
    const long = 'abcdefghij '.repeat(30);
    const preview = buildPreview(long);
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(preview).not.toMatch(/\s{2,}/);
  });

  it('returns short content unchanged', () => {
    expect(buildPreview('hi there')).toBe('hi there');
  });
});

const BASE_NOTE: CliNote = {
  id: 'n1',
  content: 'Hello\n\nbody',
  folderId: null,
  trashLevel: 0,
  createdAt: 1000,
  updatedAt: 2000,
  trashedAt: null,
  autoDeleteAt: null,
  contentHash: 'sha256:abc',
  tags: [
    { id: 't1', tagType: '#', tagValue: 'foo' },
    { id: 't2', tagType: '/time', tagValue: '2026-05-02T00:00:00' },
  ],
};

describe('serializeNote', () => {
  it('emits snake_case + ms timestamps + derived title + sigil-prefixed tags', () => {
    const out = serializeNote(BASE_NOTE);
    expect(out).toEqual({
      id: 'n1',
      content: 'Hello\n\nbody',
      title: 'Hello',
      folder_id: null,
      tags: ['#foo', '/time:2026-05-02T00:00:00'],
      trash_level: 0,
      created_at: 1000,
      updated_at: 2000,
      trashed_at: null,
      auto_delete_at: null,
      content_hash: 'sha256:abc',
    });
  });
});

describe('serializeSearchItem', () => {
  it('builds preview from content + includes ms updated_at', () => {
    const out = serializeSearchItem(BASE_NOTE);
    expect(out.id).toBe('n1');
    expect(out.title).toBe('Hello');
    expect(out.preview).toBe('Hello body');
    expect(out.updated_at).toBe(2000);
    expect(out.tags).toEqual(['#foo', '/time:2026-05-02T00:00:00']);
  });
});
