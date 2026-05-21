# 开发进度

## 当前阶段：P5-a shipped (内部) — 单机双 profile 手动验收 2026-05-22 通过；不发版，下一步 P5-b

**P5-a 设计文档**（v6 锁定）：`docs/plans/2026-05-21-p5-a-skybridge-sync-engine-design.md`
**实施记录**：`docs/history/P5-a-shipped.md`

11-commit P5-a 切片（截至 2026-05-22）：

| Step | 仓 | Commit | 内容 |
|---|---|---|---|
| design | owl | `4f9b9ba` | P5-a design doc v6 |
| 0a | owl | `b384f2e` | `OWL_NEST_DIR` env override（profile B 隔离先决条件） |
| 0b | owl | `23fcf6e` | delete emit 加 `updated_at_ms`（LWW 锚点必需） |
| 1 | skybridge | `668b13b` | `tsconfig.build.json` 拆生产 build |
| 2 | skybridge | `8afc7d2` | 三 package gen-publishable-manifest + just pack-* |
| 3 | skybridge | `d127997` | README 加本地分发章节 |
| 4a | owl | `694d81b` | schema v5（sync_changes 加 cid/server_seq/synced_at + UNIQUE 索引 + v4 backfill） + emitSyncChange 返回 cid |
| 4b | owl | `3c8e09d` | `packages/core/src/sync/payloads/note.ts` apply-side validator + 28 测试 |
| 5 | owl | `f3d1fe3` | `packages/core/src/sync/engine.ts` — `runSync()` + 结构化接口 + LWW apply + cursor upsert + Fake client 23 测试 |
| 6 | owl | `34e398f` | `packages/core/src/skybridge/config.ts` — skybridge_config.toml read/write + 3 错误码 + 13 测试 |
| 7 | owl | `c73a2de` | daemon `sync/manual.ts` 非字面量 dynamic import + `routes/sync.ts` + `sync.e2e.ts` 双层 gate + 10 unit tests |
| 8 | owl | `77921ed` | CLI `owl sync run / status / login / config show` + 15 vitest tests + 7 个 SKYBRIDGE_* 错误码 |
| 9 | owl | `14ba0da` | 5 个本地 dev 脚本 + daemon `test:e2e` script |
| 10 | owl | `a327ce0` | justfile `[skybridge]` group + `just check` 链接入守卫 |
| 11 | owl | `8432fa8` | `docs/history/P5-a-shipped.md` 实施记录 |
| 12 | — | n/a | 单机双 profile 手动验收 8/8 通过（详见 `docs/history/P5-a-shipped.md` § 手动验收记录） |

测试基线：**owl 702/702**（core 264 + cli 134 + daemon 148 + gui 156），skybridge **78/78** vitest。

owl `main` 比 origin 多 11 commits（未 push）；skybridge `main` 多 3 commits（未 push）；本地**不发版**、不 npm publish、不 push tag。

### P5-a 验收过程中发现的 follow-ups（留 P5-b）

| 编号 | 现象 | 影响 | 备注 |
|---|---|---|---|
| F1 | dev-mode Electron 在 `@electron/rebuild` 后崩溃（`SIGKILL (Code Signature Invalid)`） | macOS Sequoia / 26 跑 `just dev` 后第一次启 GUI 失败 | 临时解：`codesign --force --deep --sign -` 所有 `.node` 文件 + `Electron.app`。长期：把这一步加进 `ensure-electron-abi` 后置钩子 |
| F2 | GUI dev 模式硬编码 `DAEMON_PORT = 47010` (`packages/gui/src/main/daemon.ts:6`) | 多 profile 测试时无法用非默认端口跑 GUI；只能把 profile A 配成 47010 | P5-b 加 `process.env.OWL_DAEMON_PORT` override，或读 `OWL_NEST_DIR/owl/owl_config.toml` |
| F3 | PATCH→sync 紧邻调用偶发 `pushedTotal=0`（pending 行在 DB 已 commit，sync 看不到） | 用户重试一次就好；可能是 inflight Promise 残留或事务可见性时序 | 需查 `runManualSync` inflight 重置 + better-sqlite3 隔离级别 |
| F4 | `notes.device_id` 两个命名空间（local_metadata 的 uuid vs skybridge `[device].id`） | 同一设备在本地行/远端行用不同 UUID，向用户呈现易混淆 | P5-b 统一为 skybridge-registered id，或者新增 `local_device_uuid` 字段拆开语义 |
| F5 | 编辑页面笔记预览栏不应显示创建/修改时间（P3.4-e tab preview UI 副作用） | 与 P5-a 无关，但顺手记录 | UI 调整，不影响 sync 引擎 |

### 下一阶段 P5-b（未排期）

- folder / conversation entity 的 apply 端
- tags + FTS5 同步（把 `syncNoteTags` 抽出来给 apply 复用，含 `notes_fts.tags_text` 维护）
- 后台触发（定时 / SSE / 网络恢复）
- 上述 F1–F4 follow-ups

## 历史：0.4.x 发版状态

P5-a 前的基线 **600/600 测试通过**（core 187 + cli 119 + daemon 138 + gui 156）。P3.4 + P4 Phase 1+2 全部 shipped，2026-05-08 发 0.4.0；2026-05-09 发 GUI 0.4.1 hotfix（修复 macOS Sequoia 上 dmg 安装后报"已损坏"，原因是 electron-builder `identity: null` 跳过了 bundle-level codesign，新增 `afterPack` 钩子做 ad-hoc 签名）：

- GUI 0.4.1 Release：https://github.com/orpheus-aviary/owl/releases/tag/v0.4.1（`Owl-0.4.1-arm64.dmg`，sha256 `be62243b...67e23b7`）
- GUI 0.4.0（已废）：https://github.com/orpheus-aviary/owl/releases/tag/v0.4.0
- CLI npm：`npm i -g @orpheus-aviary/owl-cli`（@0.4.0，hotfix 仅改 GUI 打包，CLI 不受影响）
- 实施细节：`docs/history/P3-4-P4-shipped.md`

## 整体路线

```
P3.4 UX 完善 ✅ + P4 skybridge Phase 1+2 ✅ → 0.4.0 发版完成
  → P5 skybridge Phase 3+4（server 首发 + 后台 sync，发 0.5.0）
  → P6 skybridge Phase 5（多设备 GA，发 1.0.0 候选）
  → P7 打包 / 发布自动化
  → P8 次要功能集
  └→ P3.5 可选 MCP server（任意时刻并行）
```

完整规划：`aviary/docs/ROADMAP.md`（跨仓路线）、`docs/plans/2026-04-20-p3-plan.md`（owl 历史 P3 规划，§8 已作废）。

**P8 非核心**（原 "P6 非核心"，届时再定 scope）：tray 图标 / 图片粘贴 / FIM 补全 / `append_memo` 语义 / AI banner option C / `[[` note-link / 编辑器正文 slash command / `owl doctor --recover` / CLI 别名 / `@owl/core` 公开发布 / 0.3.0 rebuild 代码移除。

## 历史归档

每个已 ship 阶段的实施细节都收在对应设计文档的 `## Implementation record` 段，或 `docs/history/` 下的专题 doc：

| 阶段 | 位置 |
|---|---|
| P0 / P1 基础搭建 | `docs/history/P0-P1-shipped.md` |
| P2 功能完善 | `docs/history/P2-shipped.md`（含 commit 表 + 设计文档引用） |
| P3.0.5 pre-release polish | `docs/history/P3-0-5-shipped.md` |
| P3.1 GUI 0.2.0 首发 | `docs/plans/2026-04-28-p3-1-gui-0.2.0-release-design.md` § Implementation record |
| P3.2-a migration runner | `docs/plans/2026-04-29-p3-2-a-migration-runner-design.md` § Implementation record |
| P3.2-b MigrationDialog | `docs/plans/2026-04-30-p3-2-b-migration-dialog-design.md` § Implementation record |
| P3.2-c CLI 核心 | `docs/plans/2026-05-02-p3-2-c-cli-core-design.md` § Implementation record |
| P3.2-d SSE 反向通道 | `docs/plans/2026-05-02-p3-2-d-events-channel-design.md` § Implementation record |
| P3.2.5 release polish | `docs/plans/2026-05-03-p3-2-5-design.md` § Implementation record |
| P3.3 0.3.0 发版 | `docs/history/P3-3-shipped.md` |
| P3.4 UX 完善 + P4 skybridge Phase 1+2 + 0.4.0 发版 + 0.4.1 hotfix | `docs/history/P3-4-P4-shipped.md` |

P2-8 / P2-9 手动测试清单分别在 `docs/plans/2026-04-17-p2-8-ai-page.md` 和 `docs/plans/2026-04-20-p2-9-resizable-panels.md` 的附录段。

## 关键参考

- 跨仓路线（skybridge 对接上下文）：`aviary/docs/ROADMAP.md`
- skybridge 架构框架：`aviary/docs/SKYBRIDGE_ARCH.md`
- owl P4 skybridge 对接计划：`docs/plans/2026-05-07-p4-skybridge-plan.md`（已 ship，docs/history 里有完整记录）
- 完整 COEDIT 计划：`docs/plans/COEDIT_PLAN.md`
- 聊天持久化设计（P3.4-f）：`docs/plans/2026-04-18-chat-persistence.md`
- P3 总规划（§8 已作废）：`docs/plans/2026-04-20-p3-plan.md`
