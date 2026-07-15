import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { paths } from '@owl/core';
import { generateLocalToken, publishLocalToken, removeLocalTokenFile } from './local-token.js';

describe('local-token (A6)', () => {
  const original = process.env.OWL_NEST_DIR;
  let nest: string;

  beforeEach(() => {
    nest = mkdtempSync(join(tmpdir(), 'owl-daemon-token-'));
    process.env.OWL_NEST_DIR = nest;
    mkdirSync(paths.owlDir(), { recursive: true });
  });

  afterEach(() => {
    if (original === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined stringifies it in process.env
      delete process.env.OWL_NEST_DIR;
    } else {
      process.env.OWL_NEST_DIR = original;
    }
    rmSync(nest, { recursive: true, force: true });
  });

  it('generateLocalToken returns a fresh url-safe token without touching disk', () => {
    const a = generateLocalToken();
    const b = generateLocalToken();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
    assert.ok(a.length >= 40);
    assert.equal(existsSync(paths.localTokenPath()), false);
  });

  it('publishLocalToken writes the token 0600 and leaves no temp file', () => {
    publishLocalToken('tok-abc');
    const p = paths.localTokenPath();
    assert.equal(readFileSync(p, 'utf8'), 'tok-abc');
    assert.equal(statSync(p).mode & 0o777, 0o600);
    const leftovers = readdirSync(paths.owlDir()).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('publishLocalToken atomically overwrites an existing token, staying 0600', () => {
    publishLocalToken('first');
    publishLocalToken('second');
    assert.equal(readFileSync(paths.localTokenPath(), 'utf8'), 'second');
    assert.equal(statSync(paths.localTokenPath()).mode & 0o777, 0o600);
  });

  it('removeLocalTokenFile deletes an existing file', () => {
    publishLocalToken('x');
    removeLocalTokenFile();
    assert.equal(existsSync(paths.localTokenPath()), false);
  });

  it('removeLocalTokenFile ignores a missing file (ENOENT)', () => {
    assert.doesNotThrow(() => removeLocalTokenFile());
  });
});
