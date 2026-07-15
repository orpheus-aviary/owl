import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@owl/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daemonAuthHeaders, getLocalTokenPath } from './daemon-auth.js';

describe('daemonAuthHeaders (main, A6)', () => {
  const original = process.env.OWL_NEST_DIR;
  let nest: string;

  beforeEach(() => {
    nest = mkdtempSync(join(tmpdir(), 'owl-main-auth-'));
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

  it('returns empty headers when the token file is absent', () => {
    expect(daemonAuthHeaders()).toEqual({});
  });

  it('returns a bearer header when the token file exists', () => {
    writeFileSync(paths.localTokenPath(), 'main-tok\n', 'utf8');
    expect(daemonAuthHeaders()).toEqual({ Authorization: 'Bearer main-tok' });
  });

  it('getLocalTokenPath points at the nest token file', () => {
    expect(getLocalTokenPath()).toBe(paths.localTokenPath());
  });
});
