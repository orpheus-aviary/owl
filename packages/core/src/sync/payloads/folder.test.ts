import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FolderPayloadInvalidError, parseFolderPayload } from './folder.js';

describe('parseFolderPayload — create', () => {
  it('accepts a complete create payload', () => {
    const parsed = parseFolderPayload('create', {
      name: 'Inbox',
      parent_id: null,
      position: 0,
      created_at_ms: 1_700_000_000_000,
      updated_at_ms: 1_700_000_000_000,
    });
    assert.equal(parsed.op, 'create');
    if (parsed.op !== 'create') throw new Error('narrowing failed');
    assert.equal(parsed.body.name, 'Inbox');
    assert.equal(parsed.body.parent_id, null);
    assert.equal(parsed.body.position, 0);
  });

  it('accepts parent_id as string', () => {
    const parsed = parseFolderPayload('create', {
      name: 'Child',
      parent_id: 'parent-1',
      position: 1,
      created_at_ms: 1,
      updated_at_ms: 1,
    });
    if (parsed.op !== 'create') throw new Error('narrowing failed');
    assert.equal(parsed.body.parent_id, 'parent-1');
  });

  it('rejects missing name', () => {
    assert.throws(
      () =>
        parseFolderPayload('create', {
          parent_id: null,
          position: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
        }),
      /name must be a string/,
    );
  });

  it('rejects parent_id of wrong type', () => {
    assert.throws(
      () =>
        parseFolderPayload('create', {
          name: 'x',
          parent_id: 123,
          position: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
        }),
      /parent_id must be a string or null/,
    );
  });
});

describe('parseFolderPayload — update (sparse)', () => {
  it('accepts a payload with only updated_at_ms', () => {
    const parsed = parseFolderPayload('update', { updated_at_ms: 1_000 });
    if (parsed.op !== 'update') throw new Error('narrowing failed');
    assert.equal(parsed.body.updated_at_ms, 1_000);
    assert.equal(parsed.body.name, undefined);
    assert.equal(parsed.body.parent_id, undefined);
    assert.equal(parsed.body.position, undefined);
  });

  it('accepts a name-only update', () => {
    const parsed = parseFolderPayload('update', { updated_at_ms: 2, name: 'Renamed' });
    if (parsed.op !== 'update') throw new Error('narrowing failed');
    assert.equal(parsed.body.name, 'Renamed');
    assert.equal(parsed.body.parent_id, undefined);
  });

  it('distinguishes "field absent" from "field = null"', () => {
    const parsed = parseFolderPayload('update', { updated_at_ms: 2, parent_id: null });
    if (parsed.op !== 'update') throw new Error('narrowing failed');
    assert.equal(parsed.body.parent_id, null);
    assert.ok(!('name' in parsed.body));
  });

  it('rejects update without updated_at_ms', () => {
    assert.throws(
      () => parseFolderPayload('update', { name: 'x' }),
      /updated_at_ms must be a finite number/,
    );
  });
});

describe('parseFolderPayload — delete (P5-b §4.3)', () => {
  it('accepts the minimal {updated_at_ms} shape', () => {
    const parsed = parseFolderPayload('delete', { updated_at_ms: 5_000 });
    if (parsed.op !== 'delete') throw new Error('narrowing failed');
    assert.equal(parsed.body.updated_at_ms, 5_000);
  });

  it('rejects an empty payload (old P5-a shape would now fail)', () => {
    assert.throws(() => parseFolderPayload('delete', {}), /updated_at_ms must be a finite number/);
  });
});

describe('parseFolderPayload — op gate', () => {
  it('rejects unknown op', () => {
    assert.throws(
      () => parseFolderPayload('reorder', { updated_at_ms: 1 }),
      /op must be one of create \/ update \/ delete/,
    );
  });

  it('rejects non-object payload', () => {
    assert.throws(() => parseFolderPayload('create', null), /payload must be a JSON object/);
  });
});

describe('FolderPayloadInvalidError shape', () => {
  it('carries op + reason + raw', () => {
    try {
      parseFolderPayload('create', { name: 1 });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof FolderPayloadInvalidError);
      assert.equal(err.op, 'create');
      assert.match(err.reason, /name/);
    }
  });
});
