#!/usr/bin/env node
// scripts/migrate.mjs — interactive TTY migration entry point.
//
// Run via `just migrate` (or `node packages/core/scripts/migrate.mjs` for a
// one-off). Imports from dist/, so `pnpm --filter @owl/core build` must have
// been run first — the justfile target handles that.

import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import { loadConfig, migrateLegacyDb, paths } from '../dist/index.js';

loadConfig();
const dbPath = paths.dbPath();

const rl = readline.createInterface({ input, output });
const ans = await rl.question(
  `将迁移 ${dbPath}\n  - 创建备份（.v0.2-backup-<ts>）\n  - checkpoint 后原子替换\n继续？(y/N) `,
);
rl.close();

if (ans.trim().toLowerCase() !== 'y') {
  console.log('已取消');
  process.exit(0);
}

try {
  const { backupPath, notesCount, elapsedMs, alreadyMigrated } = await migrateLegacyDb(dbPath);
  if (alreadyMigrated) {
    console.log(`✓ 数据库已是最新版本（${notesCount} 条笔记），无需迁移`);
    process.exit(0);
  }
  console.log(`✓ 迁移完成：${notesCount} 条笔记，耗时 ${elapsedMs}ms`);
  console.log(`  备份：${backupPath}`);
  console.log(
    `  如需回滚：cp "${backupPath}" "${dbPath}" && rm -f "${dbPath}-wal" "${dbPath}-shm"`,
  );
} catch (err) {
  console.error(`✗ 迁移失败：${err.message}`);
  if (err.name === 'MigrationBusyError') {
    console.error(`  原因：${err.reason}`);
  }
  if (err.name === 'SourceDbCorruptionError') {
    console.error(`  源库检测到 ${err.violations} 条孤立 FK 引用 — 需要先修复源库`);
  }
  if (err.name === 'SchemaMismatchError') {
    console.error(`  源库 schema 不符合预期：${err.details}`);
  }
  if (err.name === 'IncompatibleDbError') {
    console.error(`  数据库版本 v${err.dbVersion} 高于本应用支持上限 v${err.maxSupported}`);
  }
  process.exit(1);
}
