import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/** Simulates `npm i -g`: invokes the bundled CLI via a symlink to dist/index.js.
 *  argv[1] = symlink path, import.meta.url = realpath → exercises the entry
 *  guard and version-read logic. Regressions here mean `owl --version` prints
 *  nothing after a global install (see P3.3 ship notes). */

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..');
const distEntry = join(cliRoot, 'dist', 'index.js');
const workspacePkg = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')) as {
  version: string;
};

describe('CLI bin smoke (spawned through a symlink)', () => {
  let symlinkPath: string;

  beforeAll(() => {
    if (!existsSync(distEntry)) {
      throw new Error(
        'dist/index.js missing — run `pnpm -F @owl/cli build` before `just test`. ' +
          'This test exercises the bundled artifact that ships to npm.',
      );
    }
    symlinkPath = join(tmpdir(), `owl-bin-smoke-${process.pid}-${Date.now()}.js`);
    try {
      rmSync(symlinkPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    symlinkSync(distEntry, symlinkPath);
  });

  it('`owl --version` via symlink prints workspace version', () => {
    const r = spawnSync(process.execPath, [symlinkPath, '--version'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(workspacePkg.version);
  });

  it('`owl --help` via symlink emits the usage banner', () => {
    const r = spawnSync(process.execPath, [symlinkPath, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: owl');
    expect(r.stdout).toContain('Owl CLI');
  });
});
