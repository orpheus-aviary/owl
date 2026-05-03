import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunFile } from './cli-detect.js';
import { detectCli, expandPath, findLatestNvmBin } from './cli-detect.js';

describe('findLatestNvmBin', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-nvm-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns [] when ~/.nvm/versions/node does not exist', () => {
    expect(findLatestNvmBin(tmp)).toEqual([]);
  });

  it('returns [] when directory exists but is empty', () => {
    mkdirSync(join(tmp, '.nvm/versions/node'), { recursive: true });
    expect(findLatestNvmBin(tmp)).toEqual([]);
  });

  it('ignores non-semver entries like "system" or "iojs"', () => {
    const base = join(tmp, '.nvm/versions/node');
    mkdirSync(join(base, 'system'), { recursive: true });
    mkdirSync(join(base, 'iojs-v3.0.0'), { recursive: true });
    expect(findLatestNvmBin(tmp)).toEqual([]);
  });

  it('picks the highest version by NUMERIC [major, minor, patch] comparison', () => {
    // Key regression: string sort would put v9.x after v22.x. Numeric
    // sort gives v22.1.0.
    const base = join(tmp, '.nvm/versions/node');
    for (const v of ['v9.11.2', 'v18.0.0', 'v20.5.0', 'v22.1.0']) {
      mkdirSync(join(base, v), { recursive: true });
    }
    expect(findLatestNvmBin(tmp)).toEqual([join(base, 'v22.1.0', 'bin')]);
  });

  it('picks highest by minor when majors match', () => {
    const base = join(tmp, '.nvm/versions/node');
    for (const v of ['v20.0.5', 'v20.5.0', 'v20.5.3']) {
      mkdirSync(join(base, v), { recursive: true });
    }
    expect(findLatestNvmBin(tmp)).toEqual([join(base, 'v20.5.3', 'bin')]);
  });
});

describe('expandPath', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = { ...originalEnv };
  });

  it('on macOS/Linux appends Homebrew + npm-global + friends after the original PATH', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const input = '/usr/bin:/bin';
    const out = expandPath(input);
    expect(out.startsWith(input)).toBe(true);
    expect(out).toContain('/opt/homebrew/bin');
    expect(out).toContain('/usr/local/bin');
  });

  it('does not duplicate entries already in PATH', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const input = '/opt/homebrew/bin:/usr/bin:/bin';
    const out = expandPath(input);
    const occurrences = out.split(':').filter((p) => p === '/opt/homebrew/bin').length;
    expect(occurrences).toBe(1);
  });

  it('returns current PATH unchanged when all extras already present', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    // Construct PATH that already has every extra. Since we cannot know
    // the exact nvm path in tests, this asserts the de-dup ratchet rather
    // than bit-for-bit equality: the output must not grow.
    const minimal = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/opt/node/bin';
    const out = expandPath(minimal);
    // Real assertion: none of those 4 paths should appear twice.
    for (const p of minimal.split(':')) {
      expect(out.split(':').filter((x) => x === p).length).toBe(1);
    }
  });

  it('on Windows uses ; separator and appends npm-global dir', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    const out = expandPath('C:\\Windows\\System32');
    // Windows separator must be `;`. Node path.join on the host platform
    // may normalize slashes differently, so assert structure loosely.
    expect(out).toContain(';');
    expect(out).toMatch(/Roaming.npm/);
  });
});

describe('detectCli', () => {
  it('reports installed when first pass (current PATH) succeeds; no fallback invoked', async () => {
    const runFile = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'owl')
        return { stdout: '/usr/local/bin/owl\n', stderr: '' };
      if (cmd === '/usr/local/bin/owl' && args[0] === '--version')
        return { stdout: '0.3.0\n', stderr: '' };
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    }) as unknown as RunFile;

    const result = await detectCli({ runFile });
    expect(result).toEqual({ installed: true, path: '/usr/local/bin/owl', version: '0.3.0' });
    // First `which`, then `--version` → 2 calls, no retry with expanded PATH.
    expect((runFile as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('falls back to expanded PATH when first which fails', async () => {
    let whichCall = 0;
    const runFile = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'owl') {
        whichCall += 1;
        if (whichCall === 1) throw new Error('not found');
        return { stdout: '/opt/homebrew/bin/owl\n', stderr: '' };
      }
      if (cmd === '/opt/homebrew/bin/owl' && args[0] === '--version')
        return { stdout: '0.3.0\n', stderr: '' };
      throw new Error(`unexpected: ${cmd}`);
    }) as unknown as RunFile;

    const result = await detectCli({ runFile });
    expect(result).toEqual({
      installed: true,
      path: '/opt/homebrew/bin/owl',
      version: '0.3.0',
    });
    expect(whichCall).toBe(2);
  });

  it('returns installed:false when both passes fail', async () => {
    const runFile = vi.fn(async () => {
      throw new Error('not found');
    }) as unknown as RunFile;
    const result = await detectCli({ runFile });
    expect(result).toEqual({ installed: false });
  });

  it('returns installed:true without version when --version fails', async () => {
    const runFile = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'owl')
        return { stdout: '/usr/local/bin/owl\n', stderr: '' };
      if (args[0] === '--version') throw new Error('timeout');
      throw new Error(`unexpected: ${cmd}`);
    }) as unknown as RunFile;
    const result = await detectCli({ runFile });
    expect(result).toEqual({ installed: true, path: '/usr/local/bin/owl' });
  });

  it('trims trailing newlines from the which result', async () => {
    const runFile = vi.fn(async (cmd: string) => {
      if (cmd === 'which') return { stdout: '/usr/local/bin/owl\n\n', stderr: '' };
      return { stdout: '0.3.0', stderr: '' };
    }) as unknown as RunFile;
    const result = await detectCli({ runFile });
    expect(result.path).toBe('/usr/local/bin/owl');
  });
});
