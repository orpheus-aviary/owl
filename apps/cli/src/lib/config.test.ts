import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { CliError } from './errors.js';

describe('resolveConfig', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('throws CONFIG_NOT_FOUND when --config path does not exist', () => {
    try {
      resolveConfig({ configPath: '/nonexistent/owl_config.toml' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('CONFIG_NOT_FOUND');
    }
  });

  it('loads from --config when file exists and exposes daemon port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owl-cli-config-'));
    created.push(dir);
    const cfgPath = join(dir, 'owl_config.toml');
    writeFileSync(cfgPath, '[daemon]\nport = 51234\n');
    const resolved = resolveConfig({ configPath: cfgPath });
    expect(resolved.configPath).toBe(cfgPath);
    expect(resolved.daemonPort).toBe(51234);
  });

  it('honors --db override for dbPath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owl-cli-config-'));
    created.push(dir);
    const cfgPath = join(dir, 'owl_config.toml');
    writeFileSync(cfgPath, '');
    const resolved = resolveConfig({ configPath: cfgPath, dbPath: '/tmp/custom.db' });
    expect(resolved.dbPath).toBe('/tmp/custom.db');
  });

  it('resolves the active profile db (legacy owl/owl.db fallback) when --db is absent', () => {
    // No skybridge config / active_profile → the resolver falls back to the
    // legacy owl/owl.db (Phase 12+ B3: default direct path = active profile db).
    const nest = mkdtempSync(join(tmpdir(), 'owl-cli-nest-'));
    created.push(nest);
    const prevNest = process.env.OWL_NEST_DIR;
    process.env.OWL_NEST_DIR = nest;
    try {
      mkdirSync(join(nest, 'owl'), { recursive: true });
      const cfgPath = join(nest, 'owl', 'owl_config.toml');
      writeFileSync(cfgPath, '');
      const resolved = resolveConfig({ configPath: cfgPath });
      expect(resolved.dbPath).toBe(join(nest, 'owl', 'owl.db'));
    } finally {
      if (prevNest === undefined) {
        // biome-ignore lint/performance/noDelete: must truly unset, not stringify "undefined"
        delete process.env.OWL_NEST_DIR;
      } else {
        process.env.OWL_NEST_DIR = prevNest;
      }
    }
  });
});
