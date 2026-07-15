import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readLocalToken } from './local-token.js';
import { localTokenPath, owlDir } from './paths.js';

describe('readLocalToken (A6)', () => {
  const original = process.env.OWL_NEST_DIR;
  let nest: string;

  beforeEach(() => {
    nest = mkdtempSync(join(tmpdir(), 'owl-localtoken-'));
    process.env.OWL_NEST_DIR = nest;
    mkdirSync(owlDir(), { recursive: true });
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

  it('returns null when the file is absent', () => {
    assert.equal(readLocalToken(), null);
  });

  it('reads and trims the token', () => {
    writeFileSync(localTokenPath(), '  abc123-token\n', 'utf8');
    assert.equal(readLocalToken(), 'abc123-token');
  });

  it('treats an empty / whitespace-only file as null', () => {
    writeFileSync(localTokenPath(), '   \n', 'utf8');
    assert.equal(readLocalToken(), null);
  });
});
