import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotePayloadInvalidError, parseNotePayload } from './note.js';

// Sample payload shapes that mirror the actual emit forms in
// packages/core/src/notes/index.ts (see refs 145 / 389 / 465 / 521 / 546).

describe('parseNotePayload — create (5 fields + tags)', () => {
  it('accepts a complete create payload', () => {
    const raw = {
      content: 'hello',
      folder_id: 'fld-1',
      trash_level: 0,
      created_at_ms: 1_700_000_000_000,
      updated_at_ms: 1_700_000_000_000,
      tags: [
        { tag_type: '#', tag_value: 'important' },
        { tag_type: '/time', tag_value: '2026-01-01' },
      ],
    };
    const parsed = parseNotePayload('create', raw);
    assert.equal(parsed.op, 'create');
    if (parsed.op !== 'create') throw new Error('narrowing failed');
    assert.equal(parsed.body.content, 'hello');
    assert.equal(parsed.body.folder_id, 'fld-1');
    assert.equal(parsed.body.tags.length, 2);
    assert.equal(parsed.body.tags[0]?.tag_type, '#');
  });

  it('accepts folder_id: null (unfiled note)', () => {
    const parsed = parseNotePayload('create', {
      content: 'x',
      folder_id: null,
      trash_level: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
      tags: [],
    });
    if (parsed.op !== 'create') throw new Error('narrowing failed');
    assert.equal(parsed.body.folder_id, null);
  });

  it('accepts tag_value: null', () => {
    const parsed = parseNotePayload('create', {
      content: 'x',
      folder_id: null,
      trash_level: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
      tags: [{ tag_type: '#', tag_value: null }],
    });
    if (parsed.op !== 'create') throw new Error('narrowing failed');
    assert.equal(parsed.body.tags[0]?.tag_value, null);
  });

  it('rejects missing content', () => {
    assert.throws(
      () =>
        parseNotePayload('create', {
          folder_id: null,
          trash_level: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
          tags: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof NotePayloadInvalidError);
        assert.equal(err.op, 'create');
        assert.match(err.reason, /content must be a string/);
        return true;
      },
    );
  });

  it('rejects missing updated_at_ms', () => {
    assert.throws(
      () =>
        parseNotePayload('create', {
          content: 'x',
          folder_id: null,
          trash_level: 0,
          created_at_ms: 1,
          tags: [],
        }),
      /updated_at_ms must be a finite number/,
    );
  });

  it('rejects wrong type on trash_level (string instead of number)', () => {
    assert.throws(
      () =>
        parseNotePayload('create', {
          content: 'x',
          folder_id: null,
          trash_level: '0',
          created_at_ms: 1,
          updated_at_ms: 1,
          tags: [],
        }),
      /trash_level must be a finite number/,
    );
  });

  it('rejects non-finite updated_at_ms (NaN / Infinity)', () => {
    assert.throws(
      () =>
        parseNotePayload('create', {
          content: 'x',
          folder_id: null,
          trash_level: 0,
          created_at_ms: 1,
          updated_at_ms: Number.NaN,
          tags: [],
        }),
      /updated_at_ms must be a finite number/,
    );
  });

  it('rejects tags as non-array', () => {
    assert.throws(
      () =>
        parseNotePayload('create', {
          content: 'x',
          folder_id: null,
          trash_level: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
          tags: 'not-an-array',
        }),
      /tags must be an array/,
    );
  });

  it('rejects tag with missing tag_type', () => {
    assert.throws(
      () =>
        parseNotePayload('create', {
          content: 'x',
          folder_id: null,
          trash_level: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
          tags: [{ tag_value: 'foo' }],
        }),
      /tag_type must be a string/,
    );
  });

  it('rejects tag_type not in TAG_TYPES (P5-b §4.2)', () => {
    assert.throws(
      () =>
        parseNotePayload('create', {
          content: 'x',
          folder_id: null,
          trash_level: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
          tags: [{ tag_type: '@todo', tag_value: 'bogus' }],
        }),
      /tag_type "@todo" not in TAG_TYPES/,
    );
  });

  it('accepts each TAG_TYPES enum value', () => {
    const ok = ['#', '/time', '/alarm', '/daily', '/weekly', '/monthly', '/yearly'] as const;
    for (const tt of ok) {
      const parsed = parseNotePayload('create', {
        content: 'x',
        folder_id: null,
        trash_level: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        tags: [{ tag_type: tt, tag_value: 'v' }],
      });
      if (parsed.op !== 'create') throw new Error('narrowing failed');
      assert.equal(parsed.body.tags[0]?.tag_type, tt);
    }
  });
});

describe('parseNotePayload — update (sparse)', () => {
  it('accepts a payload with only updated_at_ms (full sparse)', () => {
    const parsed = parseNotePayload('update', { updated_at_ms: 1_000 });
    if (parsed.op !== 'update') throw new Error('narrowing failed');
    assert.equal(parsed.body.updated_at_ms, 1_000);
    assert.equal(parsed.body.content, undefined);
    assert.equal(parsed.body.folder_id, undefined);
    assert.equal(parsed.body.tags, undefined);
  });

  it('accepts content + folder_id sparse update', () => {
    const parsed = parseNotePayload('update', {
      updated_at_ms: 1_000,
      content: 'new',
      folder_id: 'fld-2',
    });
    if (parsed.op !== 'update') throw new Error('narrowing failed');
    assert.equal(parsed.body.content, 'new');
    assert.equal(parsed.body.folder_id, 'fld-2');
  });

  it('accepts folder_id: null (move to unfiled)', () => {
    const parsed = parseNotePayload('update', { updated_at_ms: 1, folder_id: null });
    if (parsed.op !== 'update') throw new Error('narrowing failed');
    assert.equal(parsed.body.folder_id, null);
  });

  it('rejects missing updated_at_ms', () => {
    assert.throws(
      () => parseNotePayload('update', { content: 'x' }),
      /updated_at_ms must be a finite number/,
    );
  });

  it('rejects wrong type on optional content (number instead of string)', () => {
    assert.throws(
      () => parseNotePayload('update', { updated_at_ms: 1, content: 42 }),
      /content must be a string/,
    );
  });
});

describe('parseNotePayload — trash / restore', () => {
  it('trash: accepts complete payload', () => {
    const parsed = parseNotePayload('trash', {
      updated_at_ms: 1_000,
      trash_level: 1,
      trashed_at_ms: 1_000,
      auto_delete_at_ms: null,
    });
    if (parsed.op !== 'trash') throw new Error('narrowing failed');
    assert.equal(parsed.body.trash_level, 1);
    assert.equal(parsed.body.auto_delete_at_ms, null);
  });

  it('trash: accepts numeric auto_delete_at_ms (level 2)', () => {
    const parsed = parseNotePayload('trash', {
      updated_at_ms: 1_000,
      trash_level: 2,
      trashed_at_ms: 1_000,
      auto_delete_at_ms: 1_700_000_000_000,
    });
    if (parsed.op !== 'trash') throw new Error('narrowing failed');
    assert.equal(parsed.body.auto_delete_at_ms, 1_700_000_000_000);
  });

  it('trash: rejects missing trashed_at_ms', () => {
    assert.throws(
      () =>
        parseNotePayload('trash', {
          updated_at_ms: 1,
          trash_level: 1,
          auto_delete_at_ms: null,
        }),
      /trashed_at_ms must be a finite number/,
    );
  });

  it('restore: accepts payload with auto_delete_at_ms = null', () => {
    const parsed = parseNotePayload('restore', {
      updated_at_ms: 1_000,
      trash_level: 0,
      trashed_at_ms: null,
      auto_delete_at_ms: null,
    });
    if (parsed.op !== 'restore') throw new Error('narrowing failed');
    assert.equal(parsed.body.trash_level, 0);
    assert.equal(parsed.body.trashed_at_ms, null);
    assert.equal(parsed.body.auto_delete_at_ms, null);
  });

  it('restore: rejects non-null auto_delete_at_ms', () => {
    assert.throws(
      () =>
        parseNotePayload('restore', {
          updated_at_ms: 1,
          trash_level: 0,
          trashed_at_ms: null,
          auto_delete_at_ms: 1_700_000_000_000,
        }),
      /auto_delete_at_ms must be null on restore/,
    );
  });

  it('restore: accepts numeric trashed_at_ms (mid-trash restore)', () => {
    const parsed = parseNotePayload('restore', {
      updated_at_ms: 1_000,
      trash_level: 1,
      trashed_at_ms: 900,
      auto_delete_at_ms: null,
    });
    if (parsed.op !== 'restore') throw new Error('narrowing failed');
    assert.equal(parsed.body.trashed_at_ms, 900);
  });
});

describe('parseNotePayload — delete (Step 0b minimal shape)', () => {
  it('accepts payload with just updated_at_ms', () => {
    const parsed = parseNotePayload('delete', { updated_at_ms: 1_700_000_000_000 });
    if (parsed.op !== 'delete') throw new Error('narrowing failed');
    assert.equal(parsed.body.updated_at_ms, 1_700_000_000_000);
  });

  it('rejects missing updated_at_ms (pre-Step-0b shape {})', () => {
    assert.throws(() => parseNotePayload('delete', {}), /updated_at_ms must be a finite number/);
  });
});

describe('parseNotePayload — op gate', () => {
  it('rejects pin op (caller must screen it out)', () => {
    assert.throws(
      () => parseNotePayload('pin', { pinned_at_ms: 1_000 }),
      (err: unknown) => {
        assert.ok(err instanceof NotePayloadInvalidError);
        assert.match(err.reason, /caller should screen out pin/);
        return true;
      },
    );
  });

  it('rejects unknown op', () => {
    assert.throws(
      () => parseNotePayload('archive', { updated_at_ms: 1 }),
      /op must be one of create \/ update \/ trash \/ restore \/ delete/,
    );
  });

  it('rejects non-object payload (string)', () => {
    assert.throws(
      () => parseNotePayload('create', 'not an object'),
      /payload must be a JSON object/,
    );
  });

  it('rejects non-object payload (array)', () => {
    assert.throws(() => parseNotePayload('create', [1, 2, 3]), /payload must be a JSON object/);
  });

  it('rejects non-object payload (null)', () => {
    assert.throws(() => parseNotePayload('create', null), /payload must be a JSON object/);
  });
});

describe('NotePayloadInvalidError shape', () => {
  it('exposes op, reason, and raw for downstream logging', () => {
    try {
      parseNotePayload('create', { content: 42 });
      throw new Error('should have thrown');
    } catch (err) {
      assert.ok(err instanceof NotePayloadInvalidError);
      assert.equal(err.op, 'create');
      assert.match(err.reason, /content must be a string/);
      assert.deepEqual(err.raw, { content: 42 });
      assert.equal(err.name, 'NotePayloadInvalidError');
    }
  });
});
