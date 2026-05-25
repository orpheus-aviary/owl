# 开发进度

## 当前阶段：P5-c shipped (内部) — 自动化 + 手动 M1-M8 + 3 个 follow-up bug 全过 2026-05-25；不发版，下一步 P5-d 完工后才 0.5.0

**P5-c 设计文档**：`docs/plans/2026-05-24-p5-c-plan.md`（v5 锁定）
**手动 M1-M8 checklist**：`docs/plans/2026-05-24-p5-c-manual-checklist.md`
**M1-M8 暴露的 3 个 bug 闭环**：`docs/plans/2026-05-25-p5-c-manual-bugs.md`
**实施记录**：`docs/history/P5-c-shipped.md`

测试基线：**core 392 / cli 134 / daemon 219 / gui 207 = 952/952 干净 checkout**，**965/965** 含 `SKYBRIDGE_E2E=1` gated dual e2e（13/13）。`just check` 5 个守卫全过。

owl `main` 比 origin 多 35 commits（未 push）：P5-c 主线 15 + bugs.md 1 + M2 fix 1 + ABI chore 1 + #3 fix 1 + #2 fix 1 + bugs.md update 1 + lint 1。aviary +5、skybridge +6 也未 push。

**0.5.0 时机**：仍按原口径等 P5-d（safeStorage keychain + 真实双机 soak + logout 流程）完工再发；本次 manual M1-M8 暴露的 3 个 fix 直接进 P5-c 主线，不切 P5-c.5。

---

## 历史：P5-b shipped (内部) — 自动化 D1-D10 + 手动 D11/D11b 验收 2026-05-24 通过

**P5-b 设计文档**（v5 锁定）：`docs/plans/2026-05-22-p5-b-multi-entity-realtime-design.md`
**D11/D11b 手动 checklist**：`docs/plans/2026-05-24-p5-b-d11-d12-manual-checklist.md`
**实施记录**：`docs/history/P5-b-shipped.md`

### P5-b 切片（10 commit 主线 + 3 仓 docs 收尾）

| Step | 仓 | Commit | 内容 |
|---|---|---|---|
| 1+2 | owl | `d70b8fc` | schema v6 `0006_device_id_split.sql`（ADD COLUMN `local_device_uuid` + NOT NULL trigger，不重建表）+ mutation 写两列；F4 device_id 双命名空间分手 |
| 3 | owl | `9505910` | `deleteFolder` emit payload 加 `updated_at_ms`（LWW 锚点对齐 note/delete） |
| 4 | owl | `79c47fd` | 抽 `syncNoteTags` → `notes/tags.ts` 给 apply 路径复用 |
| 5 | owl | `ce95c3f` | folder + conversation apply-side validator；note tag_type 收紧为 `TagType` enum |
| 6 | owl | `e75ce86` | engine 路由按 entity_type 分发；folder sparse update / conversation append-merge / note apply 调 `syncNoteTags + syncReminders` |
| 7 | owl | `0af56c4` | session helper（`ensureSkybridgeSession` + ctx 缓存）+ SSE bridge（永久重连 + onOpen catch-up）+ `persistSkybridgeIds` 进 core |
| 8 | owl | `a6db4b7` | `sync:status_changed` OwlEvent + `SyncStatusSnapshot` + status-broadcaster + `manual.ts` 包 markSyncing/markSuccess/markError + `scheduler.reload()` |
| 9 | owl | `321e308` | GUI `<SyncStatusBar />` 挂 sidebar 最下 + 四态徽章 + popover；`events-subscriber-core` 加 sync 分支；冷启动 fetch 兜底 |
| 10a | owl | `a1a8f16` | `bridge-lifecycle.ts` daemon-boot SSE 接入（只在 toml 完全 bootstrapped 时 auto-start）+ DI 单测 |
| 10b | owl | `94972f2` | `sync.dual.e2e.ts` 自动化 D1-D10（core-only + in-process skybridge）+ D11/D11b/D12 处置矩阵 |
| 11-owl | owl | `10e98d0` | `docs/history/P5-b-shipped.md` + `CLAUDE.md` skybridge debug 章节 |
| 11-aviary | aviary | `ea3e312` | ROADMAP P5-a/b/c 三段拆 + SKYBRIDGE_ARCH Phase 4-a/b/c 拆 |
| 11-skybridge | skybridge | `177de0b` | PROCESS.md 记 owl P5-a/b 集成验收 |
| 12 | — | n/a | 自动化 + 手动验收全过（见 `docs/history/P5-b-shipped.md` § 自动化验收 + § 手动验收） |

测试基线：**owl 802/802 干净 checkout**（core 314 + cli 134 + daemon 177 + gui 177），**813/813** 含 `SKYBRIDGE_E2E=1` gated dual e2e。`just check` 全绿。skybridge / aviary 仓不动 server 端测试基线。

owl `main` 比 origin 多 32 commits（未 push）；本地**不发版**、不 npm publish、不 push tag。

### P5-b 手动验收期间新发现 3 个 P5-c 待办（2026-05-24）

| 编号 | 现象 | 触发条件 | 处置方向 |
|---|---|---|---|
| **G1** | GUI `preload/index.ts:46` 硬编码 `daemonUrl: 'http://127.0.0.1:47010'`，没读 `OWL_DAEMON_PORT` | `OWL_DAEMON_PORT=47011 just dev-fast` 启 GUI 时，渲染进程仍连 47010；F2 fix 只覆盖了 main 进程 spawn 端口 | P5-c 修：preload 通过 env-injected constant 或 IPC 拿到端口 |
| **G2** | skybridge server SIGTERM 优雅关闭时，`@skybridge/client/sse.js` 的 `reader.read()` 收到 `{ done: true }` **静默退出 read loop**，不触发 `onError`；bridge 卡 zombie 永不重连，GUI 永远显示"已同步" | 服务器优雅 shutdown（不是 crash）+ 不重启时永久卡 zombie，必须 daemon 重启才能恢复。SIGKILL 路径正常 | P5-c 修：在 skybridge 仓的 `pumpStream` 里给 `done: true` 路径补 fire `onError(new NetworkError('SSE stream ended'))` |
| **G3** | SyncStatusBar 的 `syncing` 蓝色旋转动画 < 100ms，肉眼看不见 | runSync 本地同进程对 in-memory skybridge 跑得太快，markSyncing → markSuccess 几乎没可视化时间 | P5-c 修：UI 加 minimum-display-duration（e.g. `syncing` 至少展示 300-500ms，即使 runSync 已返回） |

P5-b Step 10b 期间还从代码里发现两个**设计 §3.3 没完成实施**的 gap，一并记 P5-c：

| 编号 | 现象 | 来源 |
|---|---|---|
| **G4** | `createNote` / `updateNote` 没从 `local_metadata.skybridge_device_id` 读 → 本地新建 note 的 `notes.device_id` 落 NULL（apply 路径正常） | dual.e2e D2 assertion 翻车暴露；与设计 §3.3 不符 |
| **G5** | `createNote` / `updateNote` 不触发 `syncReminders` → /alarm note 本地不立刻生成 reminder_status；现在依赖 daemon `ReminderScheduler` 轮询补 | dual.e2e D10 显式调 syncReminders 模拟 scheduler tick |

### 下一阶段 P5-c（未排期）→ 完成后发 0.5.0

- 后台 sync 触发：定时（可配置间隔）+ 网络恢复 + 应用启动（SSE event 触发 P5-b 已完成）
- 429 / 5xx retry 策略 + jitter（与 SSE bridge 重连退避独立）
- `conflict_record` 写入语义 + 冲突 UI
- 真实双机 + 远程 server soak
- keychain 替换明文 token
- 上述 G1-G5 follow-up 一并修

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
| P5-a skybridge sync engine 单机版（内部 2026-05-22） | `docs/history/P5-a-shipped.md` |
| P5-b 多 entity apply + SSE 实时 + GUI 状态栏（内部 2026-05-24） | `docs/history/P5-b-shipped.md` |

P2-8 / P2-9 手动测试清单分别在 `docs/plans/2026-04-17-p2-8-ai-page.md` 和 `docs/plans/2026-04-20-p2-9-resizable-panels.md` 的附录段。

## 关键参考

- 跨仓路线（skybridge 对接上下文）：`aviary/docs/ROADMAP.md`
- skybridge 架构框架：`aviary/docs/SKYBRIDGE_ARCH.md`
- owl P4 skybridge 对接计划：`docs/plans/2026-05-07-p4-skybridge-plan.md`（已 ship，docs/history 里有完整记录）
- 完整 COEDIT 计划：`docs/plans/COEDIT_PLAN.md`
- 聊天持久化设计（P3.4-f）：`docs/plans/2026-04-18-chat-persistence.md`
- P3 总规划（§8 已作废）：`docs/plans/2026-04-20-p3-plan.md`
