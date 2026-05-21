# P5-a — 单机 sync engine + 手动同步链路

> 2026-05-22 收尾。**还未发版**（0.5.0 留给 P5-b 多 batch / 后台触发 / 多设备验收之后再发）。

## 一句话

owl daemon 现在能跑 `runSync(deps)` 单轮 pull→push 与本地 `@skybridge/server` 对话，note 五个 content op（create / update / trash / restore / delete）按 LWW 在 apply 端落库，单 profile 自我 echo 跳过；CLI 暴露 `owl sync run / status / login / config show`；全部代码在 `tsc -b` 干净 checkout 上能编译（`@skybridge/*` **不**进 git committed 状态）。

## 测试基线

**702/702 测试通过**：
- `@owl/core`: 264（P4 后 228 → P5-a 264，新增 36 个 sync engine + config + apply 测试）
- `@owl/cli`: 134（P3.3 后 119 → P5-a 134，新增 15 个 `owl sync` 测试）
- `@owl/daemon`: 148（P4 后 138 → P5-a 148，新增 10 个 sync route 测试）
- `@owl/gui`: 156（不变）

`just check` 干净：biome + tsc + core-convergence + **新增** skybridge-not-committed 守卫。

## 11 个 commit

| Step | Commit | 内容 |
|---|---|---|
| design | `4f9b9ba` | P5-a 设计文档 v6 |
| 0a | `b384f2e` | `OWL_NEST_DIR` env override（profile B 隔离前置） |
| 0b | `23fcf6e` | `permanentDeleteNote` / batch emit 加 `updated_at_ms`（LWW 锚点） |
| 4a | `694d81b` | schema v5（`sync_changes` 加 `client_change_id` / `server_seq` / `synced_at` + UNIQUE 索引 + v4 backfill） + `emitSyncChange` 返回 cid |
| 4b | `3c8e09d` | `packages/core/src/sync/payloads/note.ts` apply-side validator + 28 测试 |
| 5 | `f3d1fe3` | `packages/core/src/sync/engine.ts` — `runSync()` + 结构化 `SkybridgeClientLike` 接口 + LWW apply + `upsertSyncCursor` + 23 Fake-client 测试 |
| 6 | `34e398f` | `packages/core/src/skybridge/config.ts` — `skybridge_config.toml` read/write + 三错误码 + 13 测试 |
| 7 | `c73a2de` | daemon `sync/manual.ts` 非字面量 dynamic import + `routes/sync.ts` + `sync.e2e.ts` 双层 gate + 10 unit tests |
| 8 | `77921ed` | CLI `owl sync run / status / login / config show` + 15 vitest tests + 7 个 SKYBRIDGE_* 错误码 |
| 9 | `14ba0da` | 5 个本地 dev 脚本（`skybridge-overrides.mjs` install/uninstall / `check-skybridge-not-committed.sh` guard / `skybridge-sync-once.sh` / `dev-skybridge.sh` / `read-daemon-port.mjs`） |
| 10 | `a327ce0` | justfile `[skybridge]` group + `just check` 链接入守卫 |

跨仓 skybridge 端配套（不在此仓的 commit 里）：

| Step | 仓 | Commit | 内容 |
|---|---|---|---|
| 1 | skybridge | `668b13b` | `tsconfig.build.json` 拆生产 build |
| 2 | skybridge | `8afc7d2` | 三 package gen-publishable-manifest + just pack-* |
| 3 | skybridge | `d127997` | README 加本地分发章节 |

## 关键不变量（已落地、有测试 / 守卫保护）

1. **core 零 `@skybridge/*` 依赖** — `packages/core/src/sync/engine.ts` 只导出结构化接口 `SkybridgeClientLike` 等，没有任何 `import '@skybridge/...'`。
2. **daemon 字面量解析为零** — `packages/daemon/src/sync/manual.ts` 和 `sync.e2e.ts` 都用 `const spec: string = '@skybridge/...'; await import(spec)`；TS 看见 `import(string)` 跳过 module resolution，干净 checkout 一样 `tsc -b` 过。
3. **e2e 套件不会被默认 test glob 抓到** — 文件名 `sync.e2e.ts`（无 `.test.`），`pnpm test` 走 `dist/**/*.test.js` 不匹配；外加 `{ skip: !process.env.SKYBRIDGE_E2E }` 双保险。
4. **committed manifests 永不写 `@skybridge/*`** — `scripts/check-skybridge-not-committed.sh` 接入 `just check`；root / daemon / cli 三个 package.json 都被扫描。本地 `just skybridge-install` 临时 patch，提交前必须 `just skybridge-uninstall`。
5. **self-replay 不会回环** — `applyNoteChange` 先看 `sync_changes WHERE client_change_id = ? AND synced_at IS NOT NULL`，命中即 skip。
6. **LWW 平局本地赢** — `localTs >= remoteTs` 直接跳过；delete 例外（`localTs > remoteTs` 才跳过，等号情况下远端有效）。
7. **cursor upsert** — `sync_cursor` 用 `INSERT … ON CONFLICT DO UPDATE`，首次 sync 写入新行，后续 update；pull 阶段只动 `pulled_seq`，push 阶段只动 `pushed_seq`，`COALESCE` 兜底 NULL。
8. **validator 失败整 batch 回滚** — pull batch 在单事务里跑；validator throw 不前进 cursor。
9. **non-note + note metadata op 跳过 + cursor 推进** — folder / conversation 整类跳过；note 中 `pin` / reorder（无 `updated_at_ms`）跳过 apply 但 cursor 正常推进，避免堵塞。
10. **inflight Promise dedupe** — daemon 模块级 `let inFlight: Promise<RunSyncResult> | null`，并发 `POST /sync/run` 共享同一轮。
11. **401 → 自动清 [auth]** — `manual.ts` 看到 `ApiError.status === 401` 调 `clearSkybridgeAuth(cfgPath)`，下轮 sync 直接 `SKYBRIDGE_AUTH_REQUIRED`，不会无限重放死 token。

## P5-a 故意不做的事（留 P5-b / P5-c / P6）

- **tags apply** — `notes.tags` 关系 + FTS5 `tags_text` 联动非平凡，需要把 `syncNoteTags` 抽出来给 apply 复用，留 P5-b。Apply 路径检测到 payload 含 `tags` 写日志 `[sync] apply note X create/update — tags field present in payload (size N), skipped (P5-a)` 便于 P5-b backfill grep。
- **pin / reorder apply** — 同上，metadata op 留 P5-b。
- **后台触发** — 定时同步、网络恢复、SSE event-driven，全部 Phase 4。
- **多设备验收** — Phase 5。P5-a 验收范围严格限定**单机双 profile**（design §13），双机 / 远程 server 留 P5-c。
- **conflict UI** — Phase 5。
- **keychain 集成** — token 现在明文 chmod 600，留 P5-c。
- **发版** — 0.5.0 留给完整后台 sync + 多设备验收之后。

## 怎么跑（开发者）

```bash
# 1. skybridge 仓产 tarball
cd ../skybridge
just pack-all

# 2. owl 仓 install（patch 本地 manifests，禁止 commit）
cd ../owl
just skybridge-install

# 3. 起 skybridge server + owl daemon + GUI（前台）
just dev-skybridge

# 在另一终端：
just skybridge-sync-once

# 4. 调试完恢复
just skybridge-uninstall

# 这一步必须做，否则 `just check` 会 fail：
just check
```

## 手动验收记录（2026-05-22）

design §13 单机双 profile 流程，8 步全过：

| # | 验证 | 结果 |
|---|---|---|
| 1 | profile A login → `[server]+[auth]` 写入 toml | ok |
| 2 | GUI 在 profile A 创建 2 条 note → 8 行 `sync_changes` pending（含 special notes seed + GUI 自动 update） | ok |
| 3 | profile A 首次 sync → `pushedTotal=8 / pulledTotal=0 / serverSeqHigh=8` | ok |
| 4 | profile A 第二次 sync（self-replay） → `pulledTotal=8 / appliedTotal=0 / skippedTotal=8 / cursorAfter=8`，cid 命中本地 synced 行全跳过 | ok |
| 5 | profile B login → B 的 toml 写入 | ok |
| 6 | profile B 首次 sync → `pulledTotal=8 / appliedTotal=8`，B 的 `notes` 表出现 A 的 4 条记录（2 special + 2 user） | ok |
| 7 | profile B PATCH 测试笔记 1 + sync → `pushedTotal=1 / serverSeqHigh=9`（注：首次调用 sync 偶发 `pushedTotal=0`，重试一次成功，记录为 F3） | ok（重试后） |
| 8 | profile A pull B 的 edit → `pulledTotal=1 / appliedTotal=1 / cursorAfter=9`，content 落库，GUI Cmd+R 刷新可见 | ok |

验收过程中暴露了 5 个 follow-up（未阻断 P5-a，留 P5-b）：

| 编号 | 现象 | 触发条件 | 处置方向 |
|---|---|---|---|
| **F1** | dev-mode Electron 启动崩 `SIGKILL (Code Signature Invalid)` | macOS Sequoia/26 跑 `just dev` / `just dev-fast`，特别是刚跑过 `ensure-electron-abi`（`@electron/rebuild` 重新编了 native module） | 临时解：手动 `codesign --force --deep --sign -` 所有 `.node` 文件 + `Electron.app`。长期：在 `ensure-electron-abi` 后追加 ad-hoc 重签所有 native 产物的步骤 |
| **F2** | GUI 渲染进程硬编码 `DAEMON_PORT = 47010`（`packages/gui/src/main/daemon.ts:6`） | 测试要双 profile 时只能让其中一个 profile 占用 47010；用 `OWL_NEST_DIR` 换 nest 但端口不能换 | 让 GUI 读 `OWL_NEST_DIR/owl/owl_config.toml` 解析 daemon.port，或加 `OWL_GUI_DAEMON_PORT` env override |
| **F3** | PATCH→sync 紧邻调用时第一次 sync `pushedTotal=0`，重试即正常 | mutation commit 后立即 POST /sync/run | inflight Promise 残留？或 better-sqlite3 事务可见性（WAL）？需复现 + 单测覆盖 |
| **F4** | `notes.device_id` 有两个 UUID 命名空间 | local 写：`local_metadata.device_uuid`（emit & 直接 mutation）；apply 写：skybridge `[device].id`（来自 ServerChange.deviceId） | P5-b：apply 端继续用 skybridge id，但向用户展示时映射回友好名（device.name） |
| **F5** | 编辑页面笔记预览栏显示创建/修改时间（不该显示） | 与 sync 无关，P3.4-e tab preview 副作用 | UI 调整，独立 commit |

清场流程已验证通过：`just skybridge-uninstall` → `just check` 全绿，guard 不再报错。

## 设计文档 & 后续

- 设计文档：`docs/plans/2026-05-21-p5-a-skybridge-sync-engine-design.md`（v6 锁定）
- 跨仓架构：`aviary/docs/SKYBRIDGE_ARCH.md`
- skybridge 仓配套：`skybridge/PROCESS.md`

下一步 **P5-b**（folder/conversation apply + tags + FTS apply / 后台触发 / F1–F4 修复）→ **P5-c**（双机 / 远程 server 验收 + keychain）→ 完整 0.5.0 发版（design doc §14 路线）。
