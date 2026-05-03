import child_process from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Use execFile (not exec) throughout: no shell, no injection surface.
// Every call site passes an argv array; `target` / `binary` are fixed
// strings controlled by this file, not user input.
const runFile = promisify(child_process.execFile);

/**
 * Result of probing the user's shell PATH for the `owl` CLI binary.
 * Returned by the `cli:detect` IPC handler and consumed by the
 * Settings → 高级 → CLI 工具 card in the renderer.
 */
export interface CliDetectResult {
  installed: boolean;
  path?: string;
  version?: string;
}

/** How long we allow each `which` / `--version` subprocess to run. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Parse a `vMAJOR.MINOR.PATCH` nvm version dir into a comparable tuple.
 * Returns null for directories that don't look like a semver (e.g. the
 * `iojs` or `system` shims nvm sometimes keeps).
 */
function parseNvmVersion(name: string): [number, number, number] | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(name);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Find the most recent nvm-managed node's bin directory, compared by
 * numeric [major, minor, patch] so `v9.x` doesn't sort after `v22.x`.
 * Returns [] when nvm isn't installed, the directory is empty, or no
 * entry parses as semver.
 */
export function findLatestNvmBin(home: string): string[] {
  const base = join(home, '.nvm', 'versions', 'node');
  if (!existsSync(base)) return [];
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  let best: { name: string; key: [number, number, number] } | null = null;
  for (const name of entries) {
    const key = parseNvmVersion(name);
    if (!key) continue;
    if (
      !best ||
      key[0] > best.key[0] ||
      (key[0] === best.key[0] && key[1] > best.key[1]) ||
      (key[0] === best.key[0] && key[1] === best.key[1] && key[2] > best.key[2])
    ) {
      best = { name, key };
    }
  }
  return best ? [join(base, best.name, 'bin')] : [];
}

/**
 * Extend `current` PATH with common user-scoped install locations that
 * Electron misses when launched from Finder / dock / Spotlight (where
 * PATH is limited to /usr/bin:/bin:/usr/sbin:/sbin).
 *
 * - De-dupes against entries already in `current`, preserving user order
 * - Puts the original PATH first so explicitly-set directories win
 * - Platform-aware: Windows uses `;` separator and a smaller extras set
 */
export function expandPath(current: string): string {
  const home = homedir();
  const isWin = process.platform === 'win32';
  const extras = isWin
    ? [
        join(process.env.APPDATA ?? '', 'npm'),
        join(process.env.LOCALAPPDATA ?? '', 'Programs', 'nodejs'),
      ].filter(Boolean)
    : [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        join(home, '.npm-global/bin'),
        join(home, '.volta/bin'),
        join(home, '.asdf/shims'),
        join(home, '.cargo/bin'),
        '/usr/local/opt/node/bin',
        ...findLatestNvmBin(home),
      ];
  const sep = isWin ? ';' : ':';
  const existing = new Set(current.split(sep).filter(Boolean));
  const added = extras.filter((p) => p && !existing.has(p));
  if (added.length === 0) return current;
  return [current, ...added].filter(Boolean).join(sep);
}

async function tryWhich(
  runFileFn: RunFile,
  cmd: string,
  target: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await runFileFn(cmd, [target], {
      env: { ...process.env, PATH: path },
      timeout: PROBE_TIMEOUT_MS,
    });
    // `which` prints one path per match; take the first non-empty line.
    const first = stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
}

async function tryVersion(
  runFileFn: RunFile,
  binary: string,
  path: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await runFileFn(binary, ['--version'], {
      env: { ...process.env, PATH: path },
      timeout: PROBE_TIMEOUT_MS,
    });
    const v = stdout.trim().split('\n')[0]?.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Injectable subprocess runner; tests replace the default with a mock. */
export type RunFile = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Probe the user's environment for the `owl` CLI. Tries the current PATH
 * first, then expands to common user-scoped install locations so that
 * Finder-launched Electron doesn't false-negative on Homebrew / nvm /
 * npm-global installs.
 *
 * `deps.runFile` defaults to the promisified `child_process.execFile`,
 * which uses no shell and cannot inject commands — argv is passed as an
 * array of fixed strings controlled by this file.
 */
export async function detectCli(deps: { runFile?: RunFile } = {}): Promise<CliDetectResult> {
  const runFileFn = deps.runFile ?? runFile;
  const whichCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  const originalPath = process.env.PATH ?? '';
  const expanded = expandPath(originalPath);

  // Pass 1: user's real PATH.
  let found = await tryWhich(runFileFn, whichCmd, 'owl', originalPath);
  let pathUsed = originalPath;

  // Pass 2: expanded PATH if we expanded (skip when no-op).
  if (!found && expanded !== originalPath) {
    found = await tryWhich(runFileFn, whichCmd, 'owl', expanded);
    if (found) pathUsed = expanded;
  }

  if (!found) return { installed: false };

  const version = await tryVersion(runFileFn, found, pathUsed);
  return version ? { installed: true, path: found, version } : { installed: true, path: found };
}
