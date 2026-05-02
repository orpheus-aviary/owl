import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AlreadyTrashedError, VersionMismatchError } from './errors.js';

describe('VersionMismatchError', () => {
  it('carries expected + current + id', () => {
    const err = new VersionMismatchError('abc', 1000, 2000);
    assert.equal(err.name, 'VersionMismatchError');
    assert.equal(err.id, 'abc');
    assert.equal(err.expected, 1000);
    assert.equal(err.current, 2000);
    assert.match(err.message, /abc/);
    assert.ok(err instanceof Error);
  });
});

describe('AlreadyTrashedError', () => {
  it('carries id + currentTrashLevel', () => {
    const err = new AlreadyTrashedError('xyz', 1);
    assert.equal(err.name, 'AlreadyTrashedError');
    assert.equal(err.id, 'xyz');
    assert.equal(err.currentTrashLevel, 1);
    assert.match(err.message, /xyz/);
    assert.ok(err instanceof Error);
  });
});
