# P3.4 + P4 — 统一发 0.4.0（2026-05-08）

GUI `v0.4.0` (GitHub Release + `Owl-0.4.0-arm64.dmg`) 与 CLI `cli-v0.4.0` (`@orpheus-aviary/owl-cli@0.4.0` on npm) 独立渠道同日发布。

- **GUI Release**: https://github.com/orpheus-aviary/owl/releases/tag/v0.4.0
- **GUI SHA256**: `cc477a12e3b582f6fddda1e29548bf9d070bd723f1b33b15f13fca4b82ccb341`
- **CLI npm**: `npm i -g @orpheus-aviary/owl-cli`
- **Tag 策略**: `v* = GUI` / `cli-v* = CLI`，两者指向同一 commit `8f15179`，但渠道独立（沿用 0.3.0 的 P3.3 模式）
- **测试**: 600/600 (core 187 + cli 119 + daemon 138 + gui 156)

## 内容

### P3.4 UX 完善（已 ship 2026-05-05..07）

完整记录在 `PROCESS.md`，6 个子项：

| # | 子项 | 设计文档 |
|---|---|---|
| P3.4-a | 笔记排序模型（pinned + position，0002 forward migration runner 首验） | `docs/plans/2026-05-05-p3-4-a-sorting-model-design.md` |
| P3.4-b | 特殊笔记视觉区分（`#随记` 蓝 / `#待办` 粉） | `docs/plans/2026-05-05-p3-4-b-special-notes-visual-design.md` |
| P3.4-c | AI chat 笔记 ID pill 三形态覆盖 | `docs/plans/2026-05-05-p3-4-c-note-id-pill-design.md` |
| P3.4-d | TagBar Tab/Enter 区分补全 | `docs/plans/2026-05-06-p3-4-d-tagbar-tab-enter-design.md` |
| P3.4-e | 笔记 tab VSCode preview/pinned | `docs/plans/2026-05-07-p3-4-e-tab-preview-design.md` |
| P3.4-f | 聊天持久化 + ChatSidebar | `docs/plans/2026-05-07-p3-4-f-chat-persistence-design.md` |

### P4 skybridge Phase 1+2（2026-05-08）

| Phase | 入口 | Commit |
|---|---|---|
| Phase 1 — daemon 写入路径收敛 | `docs/plans/2026-05-08-p4-phase1-entry-convergence-design.md` | `39a7a1c` |
| Phase 2 — 本地 change log（schema v4） | `docs/plans/2026-05-08-p4-phase2-change-log-design.md` | `955692e` |

**Phase 1 净增**：`packages/core/src/conversations/`（从 daemon 抽出）+ `core.rescheduleRecurringReminder` + `scripts/check-core-convergence.sh` grep 守卫（接入 `just check`）。

**Phase 2 净增**：
- `0004_skybridge_tables.sql`（sync_changes / sync_cursor / conflict_record，`LATEST_KNOWN_VERSION = 4`）
- `packages/core/src/sync/changes.ts`（`emitSyncChange` + device_id auto-bootstrap）
- 6 个 mutation 加 `sqlite` 参数（createFolder/updateFolder/deleteFolder/permanentDeleteNote/batchPermanentDeleteNotes/setNotePinned），所有 14 个 mutation 路径在事务内 emit `sync_changes`
- `deleteFolder` 用 SELECT-before-UPDATE 5 步算法保证 reparent 子 folder 各自单独 emit 一行
- 18 项 emission 单测 + 1 项 atomicity（CAS 失败回滚 + sync_changes 不写）+ 6 项 emitSyncChange 自身单测
- 13 项 daemon HTTP smoke 通过

## 0.4.0 release blocker 修复

发布 npm 包前发现 `apps/cli/scripts/gen-publishable-manifest.mjs` 之前 hard-code 只 copy `0001_initial.sql`：

```js
for (const entry of ['0001_initial.sql']) {
  const srcFile = join(migrationsSrc, entry);
  if (existsSync(srcFile)) copyFileSync(srcFile, join(dest, entry));
}
```

意味着 `@orpheus-aviary/owl-cli@0.3.0` 在 `--direct` fresh install 路径上会调 `applyForwardMigrations(1, 3)` 然后炸在 "No migration file found for v2"。0.3.0 当时的 `npm i -g` smoke test 只跑 `--version` / `--help`（不开 db），所以这个 bug 静默上线。

修复（commit `8f15179`）：把循环换成 `readdirSync(migrationsSrc).filter(/^\d{4}_.+\.sql$/)`，自动覆盖未来所有 `NNNN_*.sql`。

潜在补救：0.3.0 的 npm 用户只要走 daemon HTTP 流（默认）就不受影响；只有用 `--direct` 跑 fresh install 的用户被波及，量应该极少。0.3.0 不专门起 0.3.1 修。

## 4 个 commit 交付

| Commit | 内容 |
|---|---|
| `39a7a1c` | `feat(skybridge): converge daemon writes to core` — Phase 1 |
| `955692e` | `feat(skybridge): emit sync_changes for every core mutation (P4 Phase 2)` |
| `cc6b6b5` | `docs(skybridge): mark P4 Phase 2 as shipped in PROCESS.md` |
| `8f15179` | `chore(release): bump gui and cli to 0.4.0` — 含 manifest migration bug 修复 |

## 未做（已录入 ROADMAP）

- skybridge **server**（Phase 3 = 0.5.0 主菜）
- skybridge **sync engine**（Phase 4，后台 push/pull/定时/网络恢复触发）
- 多设备语义激活、conflict UI（Phase 5）
- payload 形态最终化（Phase 3 server 接入时 lock）
- CI workflows codify（沿用 P3.3 时遗留）
- Windows / Linux 构建 + codesign / notarize
