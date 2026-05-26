/**
 * P5-d Phase 7 (§3.7.4) — atomic file write for GUI main's toml writes.
 *
 * Why GUI main owns this and not core: per design Q1, the "GUI main is
 * the only toml writer" boundary should not be blurred. Putting the
 * helper in `@owl/core` would implicitly invite daemon back into the
 * write path, which is exactly what Phase 7 is closing off.
 *
 * Three pieces, deliberately small:
 *
 *   - `atomicWriteFile(filePath, content, options?)`
 *       1. write `<filePath>.tmp` with mode 0600
 *       2. `fsync` the tmp fd so contents reach the disk before rename
 *       3. `rename` is atomic on POSIX; either the new content lands
 *          fully or it doesn't (no half-written final file)
 *       4. on Windows, chmod is a no-op (Node silently ignores it) and
 *          rename is best-effort atomic — good enough for our threat model
 *
 *   - `cleanupStaleTmp(filePath)` — call at startup. If a previous run
 *     crashed between fsync and rename, a `.tmp` may linger. Sync delete
 *     so the very next `atomicWriteFile` doesn't trip over it.
 *
 *   - `tmpPathFor(filePath)` — the rule used by both writer + cleanup,
 *     exported so tests can verify the exact sidecar location.
 *
 * **Caller serializes.** This helper takes a `string`; sync-auth.ts (or
 * whichever caller) does the smol-toml `stringify(...)` itself, which
 * keeps the helper independent of the toml schema (and Phase 9 free to
 * delete plaintext `token` from the schema without touching this file).
 *
 * **`.tmp` content is whatever the caller passed in.** If you pass
 * plaintext, the `.tmp` carries plaintext for the duration of the write.
 * Callers writing secrets MUST encrypt the value before handing it to
 * this helper — per design §3.7.4 "`.tmp` 内容也加密(绝不在 .tmp 阶段
 * 写明文 token)".
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

export interface AtomicWriteOptions {
  /** Unix file mode. Default 0o600 (owner-only read/write). */
  mode?: number;
  /** Override the tmp suffix. Default `.tmp`. Mostly for tests. */
  tmpSuffix?: string;
}

export function tmpPathFor(filePath: string, suffix = '.tmp'): string {
  return `${filePath}${suffix}`;
}

/**
 * Atomically replace `filePath` with `content`. Throws on any failure;
 * caller decides whether to surface a UI error or silently retry. On
 * throw, the original file at `filePath` is untouched — the tmp sidecar
 * is the only thing that may exist in a partially-written state.
 */
export function atomicWriteFile(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): void {
  const mode = options.mode ?? 0o600;
  const tmp = tmpPathFor(filePath, options.tmpSuffix);

  // writeFileSync supports a mode option, so we don't need a separate
  // chmod. On Windows, Node accepts the mode and ignores the unix bits.
  writeFileSync(tmp, content, { mode });

  // fsync the file's contents so the rename below points at fully-
  // flushed bytes. Without this, a power-loss between writeFileSync and
  // the rename could land an empty (but renamed) final file.
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tmp, filePath);
}

/**
 * Delete a stale `.tmp` sidecar if it exists. Safe to call when the
 * sidecar is absent — no-op. Use at startup, BEFORE the first
 * `atomicWriteFile` of the same path, so a crash from a previous run
 * doesn't leak ciphertext / plaintext into the new process's view.
 */
export function cleanupStaleTmp(filePath: string, suffix = '.tmp'): void {
  const tmp = tmpPathFor(filePath, suffix);
  if (existsSync(tmp)) {
    unlinkSync(tmp);
  }
}
