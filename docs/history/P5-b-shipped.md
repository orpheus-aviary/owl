# P5-b — 多 entity apply + SSE 实时 + GUI 状态栏

> 2026-05-24 收尾。**仍未发版**（0.5.0 留给 P5-c 后台触发 + retry + 真实双机验收之后再发）。承接 [P5-a](./P5-a-shipped.md)（已 ship 内部 2026-05-22）。

## 一句话

P5-a 把 owl daemon 接通 `runSync()` 单 entity 手动同步；P5-b 把它从「能 push/pull note」补全到「跨设备多 entity 实时收敛」：folder + conversation apply、tags + FTS + reminder apply、SSE bridge 实时触发、GUI sidebar 同步状态指示器。F4 `device_id` 双命名空间通过 schema v6 拆 `local_device_uuid` + `device_id` 解决。验收从 P5-a 手动 8 步搬到自动化 dual-profile e2e D1-D10。

## 测试基线

- **干净 checkout `just test`**：**802/802**（dual e2e gated off）
  - `@owl/core`: 314（P5-a 264 → +50 P5-b：0006 migration 8、folder validator 7、conversation validator 13、note tag_type enum 8、engine folder/conv/router 9、persistSkybridgeIds 5）
  - `@owl/cli`: 134（不变）
  - `@owl/daemon`: 177（P5-a 148 → +29 P5-b：sse-bridge 8、status-broadcaster 8、bridge-lifecycle 7；-5 session.test 拆到 core/identity.test）
  - `@owl/gui`: 177（P5-a 156 → +21 P5-b：SyncStatusBar 11、formatRelativeTime 7、events-subscriber sync 分支 5 − 2 retired）
- **`SKYBRIDGE_E2E=1 just test-skybridge-e2e`**：**813/813**（+10 dual D1-D10 + 1 baseline）

`just check` 干净；`scripts/check-skybridge-not-committed.sh` 守卫仍生效。

## 10 个 commit（P5-b 主线）

| Step | Commit | 内容 |
|---|---|---|
| 1+2 | `d70b8fc` | schema v6 `0006_device_id_split.sql`：notes / folders **ADD COLUMN `local_device_uuid`** + BEFORE INSERT/UPDATE OF NULL trigger（不重建表，避免 `note_tags` / `reminder_status` ON DELETE CASCADE 清空）；`LATEST_KNOWN_VERSION = 6`；schema.ts TS-side `.notNull()`；mutation INSERT/UPDATE 读 `local_metadata.{device_uuid, skybridge_device_id}` 写两列 |
| 3 | `9505910` | `deleteFolder` emit payload 加 `updated_at_ms`（LWW 锚点，与 note/delete 在 P5-a Step 0b 同样处理对齐） |
| 4 | `79c47fd` | 抽 `syncNoteTags` → `packages/core/src/notes/tags.ts`，导出给 apply 路径复用；`notes/index.ts` 改 import |
| 5 | `ce95c3f` | `packages/core/src/sync/payloads/folder.ts` + `payloads/conversation.ts` apply-side validator；`payloads/note.ts` 把 `tag_type` 收紧为 `TagType` enum（import from `tags/parser.js`） |
| 6 | `e75ce86` | `sync/engine.ts` 路由表按 `entity_type` 分发到 `applyNoteChange` / `applyFolderChange` / `applyConversationChange`；folder sparse update（动态 SET，缺字段不清）；conversation append-only sequence-merge（无 LWW、无 dedup）；note apply 调 `syncNoteTags` + `syncReminders`；`RunSyncDeps` 加 `db: OwlDatabase` |
| 7 | `0af56c4` | `packages/daemon/src/sync/session.ts` — `ensureSkybridgeSession(ctx)` + `ctx.skybridgeSession` 缓存 + `RealSkybridgeClient` / `loadSkybridgeClient` / `adaptClient` 从 manual.ts 搬来；`sync/sse-bridge.ts` — 2/4/8/16/30s + jitter 永久重连 + `onOpen` catch-up sync + 8 个单测；`@owl/core` `persistSkybridgeIds` 进 `skybridge/identity.ts`（P4 Phase 1 invariant：daemon 不直接写业务表） |
| 8 | `a6db4b7` | `OwlEvent` union 加 `sync:status_changed` + `SyncStatusSnapshot` 类型（snake_case，扩 `/sync/status` 响应）；`sync/status-broadcaster.ts`（per-AppContext WeakMap，双 profile e2e 隔离）；`manual.ts` 用 markSyncing/markSuccess/markError 包 `runSync`；`appliedTotal > 0` 时直接调 `ctx.scheduler.reload()`（不走事件总线、不泄露内部事件给 GUI）；`scheduler.reload()` 新方法 |
| 9 | `321e308` | GUI `<SyncStatusBar />` 挂左侧 sidebar 最下（`mt-auto`，作为 `<nav>` 直接 flex child 拉伸到 64px）。四态徽章（idle 灰 / syncing 蓝旋转 / error 红 / offline 橙）+ popover 显示 server / device / workspace / last_sync_at / pending / seq / last_error。`stores/sync-status.ts` zustand store；`events-subscriber-core.ts` 加 `sync:status_changed` 分支 + state union 校验；冷启动 `GET /sync/status` 兜底 idle。**无手动 sync 按钮** —— SSE bridge 永远重连，offline 是信息态非可操作态 |
| 10a | `a1a8f16` | `sync/bridge-lifecycle.ts` — daemon 启动期 SSE bridge wiring。只有 toml 同时有 `[auth] + [device.id] + [workspace.id]` 才 auto-start（避免 boot 时调网络）；半启动状态 silent skip 等下次 daemon 重启（mid-session restart 留 P5-c）；DI'd deps 让 5 个跳过路径 + start/stop roundtrip 全单元测覆盖。`cli.ts` AppContext 抽 local `ctx`，post-listen 调 `startSseBridgeIfBootstrapped(ctx, logger)`，shutdown 懒读 handle |
| 10b | `94972f2` | `sync/sync.dual.e2e.ts` — 顺序 D1-D10 跑 2 个 :memory: owl-core profile + 1 个 in-process `@skybridge/server`：device 注册 → A 三 entity emit → push → self-replay skip → B pull 拿到 note + folder + tags + FTS + conv → B 改 A 的 note → A pull 看到 `device_id` 翻到 B → folder delete 级联到 B 的 `notes.folder_id=NULL` → A+B 各 append 同一 conversation 都收齐 → `/alarm` tag 跨设备 reminder_status。两层 gating（文件名 + `SKYBRIDGE_E2E`）。**D11/D11b 改 manual checklist**（`docs/plans/2026-05-24-p5-b-d11-d12-manual-checklist.md`），**D12 已被 sse-bridge.test.ts 覆盖** |

P5-a 验收 follow-ups 已在 P5-b 开工前清掉（4 项 fixed + 2 项 extras，F4 留到 P5-b Step 1+2 解决）：

| F | Commit | 内容 |
|---|---|---|
| F1 | `02102e1` | `chore(gui): codesign .node + Electron.app after rebuild`（Sequoia 26 Code Signature Invalid 修复） |
| F2 | `75a9a6b` | `feat(gui): OWL_DAEMON_PORT env override`（多 profile 测试解锁） |
| F3 | `615e233` | `fix(skybridge): coalesce concurrent sync callers into follow-up round`（PATCH→sync 紧邻 pushedTotal=0） |
| F5 | `d3255b3` | `fix(gui): hide date column in editor sidebar note list` |
| F6 | — | TabBar 中键删除（已实装 `TabBar.tsx:14-22`，用户确认） |
| F7 | `06f5e6f` | `fix(gui): container-query gate date column on narrow rows` |
| **F4** | `d70b8fc` | P5-b Step 1+2 内一并修：schema v6 拆 `local_device_uuid`（本机） / `device_id`（skybridge 源），`persistSkybridgeIds` 非破坏性 backfill 旧行 |

## 关键不变量（已落地、有测试 / 守卫保护）

1. **schema v6 trigger-enforced NOT NULL** — `notes.local_device_uuid` / `folders.local_device_uuid` drizzle 是 `.notNull()`（TS-only），SQL 端靠 4 个 BEFORE INSERT/UPDATE OF trigger 兜底；v3 表重建方案被撤回（会触发 `note_tags` / `reminder_status` cascade）。
2. **`notes.device_id` 双命名空间已收齐** — `local_device_uuid` = 本机 owl uuid（永远本机），`device_id` = 来源 skybridge `[device].id`（本地 mutation 默认 NULL，apply 时由 `ServerChange.deviceId` 填入）。`sync_changes.device_id` 不变，仍是本机 owl uuid（仅用作 emit 调试归属）。
3. **mutation 不读模块级 cache** — `notes/index.ts` / `folders/index.ts` 用 `readLocalDeviceUuid(sqlite)`（一条 SELECT），双 profile 同进程 e2e 天然隔离；module cache 在 v3 设计评审被否决。
4. **apply 端 LWW 平局** — note update / folder update 用 `localTs >= remoteTs` 跳过；delete 严格 `localTs > remoteTs`（等号情况远端有效，与 P5-a 一致）。
5. **conversation 是 append-only sequence-merge** — 无 LWW、无 dedup，cid 是唯一的 change-level 幂等键。跨设备同一 conv append 产出"两份"是设计意图；`message_id`-level dedup 留 P5-c。
6. **folder sparse update 不清字段** — apply 端动态构造 SET 子句，payload 中不存在的字段保持本地不变；validator 单测覆盖各 sparse 组合。
7. **tag enum 收紧** — `payloads/note.ts` `tag_type` 从 `string` 收紧为 `TagType`（`tags/parser.ts` 的 `TAG_TYPES` 常量数组）；未知值 throw `SkybridgeProtocolError`，整 batch 回滚。
8. **`syncNoteTags` 抽离可复用** — 从 `notes/index.ts` 内部辅助函数变成独立模块；apply 路径与本地 mutation 走同一逻辑，`note_tags` / `notes_fts.tags_text` 一致性由 `updateFtsTagsText` 保证。
9. **SSE bridge 永久重连** — `[2,4,8,16,30]s + 0-1s jitter`，cap 30s 永不放弃；`onOpen` 自动跑 catch-up `runManualSync`（server SSE 不重放历史）；P5-c 才考虑彻底 give-up 策略。
10. **OwlEvent 是 daemon→GUI 唯一通道** — 不加内部专用事件，避免泄露给 GUI；reminder scheduler reload 由 `manual.ts` 直接调 `ctx.scheduler.reload()`，不走事件总线。
11. **status broadcaster 是 per-AppContext WeakMap** — 不挂 `ctx` 字段，双 profile e2e 时两个 broadcaster 完全独立。
12. **daemon-boot SSE wiring 是 best-effort** — `bridge-lifecycle.ts` 只在 `[auth]+[device]+[workspace]` 全在 toml 才 auto-start，避免 daemon boot 调网络；half-bootstrapped → silent skip → 等下次 daemon 重启。从不 throw，sync 是 opt-in，不许阻塞编辑。
13. **GUI 无手动 sync 按钮** — 设计决策，SSE bridge 永久重连让 offline 是信息态非可操作态；power user 走 CLI `owl sync run`。
14. **dual e2e 是 core-only** — D1-D10 跑 2 个 :memory: owl-core + 1 个 in-process skybridge；不起 daemon、不接 SSE bridge（那块由 sse-bridge.test.ts 单测 + D11/D11b manual checklist 覆盖）。

## P5-b 故意不做的事（留 P5-c）

- **后台触发**：定时同步 / 网络恢复 / 429-5xx retry 策略 / SSE 之外的拉取节奏
- **`conflict_record` 写入 + 冲突 UI**：schema 仍是 P4 Phase 2 占位
- **真实双机 / 远程 server soak**：本 step 全部 in-process
- **attachment 通道 / snapshot 拉取 / 多 workspace 切换**：留 P6
- **keychain 替换明文 token**：留 P5-c
- **mutation-side `notes.device_id` 自动填充** — 设计 §3.3 说 mutation 应读 `local_metadata.skybridge_device_id` 写 `notes.device_id`；当前 `createNote` / `updateNote` 仅取 `input.deviceId ?? null`，本地新建 note 的 `device_id` 落 NULL；apply 路径正常。Step 10b 期间发现，记为 P5-c 待办
- **`createNote` / `updateNote` 触发 `syncReminders`** — 当前依赖 daemon `ReminderScheduler` 轮询补；e2e D10 显式调 `syncReminders` 模拟 scheduler tick。设计 §4.3 未明确，留 P5-c 决定是否在 mutation 路径直接调

## 怎么跑（开发者）

```bash
# 1. skybridge 仓产 tarball（若 P5-a 时未生成）
cd ../skybridge
just pack-all

# 2. owl 仓 install（patch 本地 manifests，禁止 commit）
cd ../owl
just skybridge-install

# 3. ABI 修一下（pnpm install 后必要）
just ensure-node-abi
(cd node_modules/better-sqlite3 && pnpm run install)   # 顶层副本 ABI 也要刷

# 4. 起 skybridge server + owl daemon + GUI（前台）
just dev-skybridge

# 5. 跑自动化双 profile e2e（D1-D10）
SKYBRIDGE_E2E=1 just test-skybridge-e2e

# 6. 跑 D11/D11b manual checklist
#    见 docs/plans/2026-05-24-p5-b-d11-d12-manual-checklist.md

# 7. 调试完恢复
just skybridge-uninstall
just check                              # 守卫不报 = 干净
```

## 自动化验收（2026-05-24）

`SKYBRIDGE_E2E=1 just test-skybridge-e2e`：

| 用例 | 验证 | 结果 |
|---|---|---|
| D1 | A device + workspace registered | ✅ |
| D2 | A note + folder + conv + tags emit sync_changes（3 行，cid 唯一） | ✅ |
| D3 | A first sync → pushedTotal=3，serverSeqHigh ≥ 3 | ✅ |
| D4 | A self-replay → pulledTotal>0 时 applied=0 / skipped=pulled | ✅ |
| D5 | B first sync → note + folder + tags（`note_tags` JOIN）+ FTS（MATCH）+ conv 都到 | ✅ |
| D6 | B 改 A note → pushedTotal=1 | ✅ |
| D7 | A pulls B 的 edit → content 更新；`local_device_uuid=A`，`device_id=B.skybridgeId` | ✅ |
| D8 | A 删 folder → B 看到 folder 消失，`notes.folder_id=NULL`（FK ON DELETE SET NULL） | ✅ |
| D9 | A+B 各 append 同一 conv，互 sync 两轮 → 两侧 ai_messages 都包含两条 | ✅ |
| D10 | A `/alarm` tag → B `reminder_status` pending row，`fire_at` 与 A 一致 | ✅ |

## 手动验收（2026-05-24）

两个 daemon（test-A on :47010, test-B on :47011，独立 nest 目录）+ 1 个 in-process skybridge server + 1 个 GUI（cached connect 到 :47010 = A 端）：

| 用例 | 验证 | 结果 |
|---|---|---|
| D11b | B 创建 note + push → A SSE bridge `change event` 100ms 内触发 catch-up runManualSync → A 的 `已拉取 seq` 推进、popover "最近同步" 刷新 | ✅（visual spinner 太快，靠 seq 推进 + 时间戳确认） |
| D11 离线 | SIGKILL skybridge → A 的 SSE bridge `onError` → `markOffline` → GUI 橙色 "离线" + popover "≤30s 自动重试" 文案 | ✅ |
| D11 catch-up | 重启 skybridge → A 经过 `[2,4,8,16,30]s + jitter` 退避重连 → `onOpen` 跑 catch-up sync → GUI 回 "已同步"，`已拉取 seq` 推进到 B 离线期间累积的新 server_seq | ✅（30 几秒后看到，符合最后一次失败 retry 后的下一次 backoff 等待） |
| D12 | reconnect backoff 数列 + onOpen 重置计数 + stop() 取消 pending timer | ✅ 自动单测 `sse-bridge.test.ts` 6 个 reconnect 用例覆盖 |

### 手动验收期间新发现 3 个 P5-c 待办

| # | 现象 | 触发条件 | 处置方向 |
|---|---|---|---|
| **G1** | GUI `preload/index.ts:46` 硬编码 `daemonUrl: 'http://127.0.0.1:47010'`，没读 `OWL_DAEMON_PORT` | `OWL_DAEMON_PORT=47011 just dev-fast` 启 GUI 时，渲染进程仍连 47010 | P5-a F2 修了 main 进程的 daemon spawn 端口，preload 没跟着改。让 preload 通过 IPC 或 env-injected constant 拿到端口 |
| **G2** | skybridge server SIGTERM 优雅关闭时，`@skybridge/client/sse.js` 的 `reader.read()` 收到 `{ done: true }` 静默退出 read loop，**不触发 `onError`**，bridge 卡 zombie 状态永不重连，GUI 状态栏永远显示"已同步" | 服务器优雅 shutdown（不是 crash）+ 不重启时不可恢复 | skybridge client 端的 `pumpStream` 应该在 `done: true` 路径上 fire `onError(new NetworkError('SSE stream ended unexpectedly'))`。改在 skybridge 仓 |
| **G3** | SyncStatusBar 的 `syncing` 蓝色旋转动画太短肉眼看不见（< 100ms） | runSync 本地同进程对 in-memory skybridge 跑得太快，markSyncing → markSuccess 之间几乎没有可视化时间 | UI 加 minimum-display-duration（e.g. `state==='syncing'` 至少展示 300-500ms，即使 runSync 已经返回） |

## 设计文档 & 后续

- 设计文档：[2026-05-22-p5-b-multi-entity-realtime-design.md](../plans/2026-05-22-p5-b-multi-entity-realtime-design.md)（v5 锁定）
- D11/D11b/D12 manual checklist：[2026-05-24-p5-b-d11-d12-manual-checklist.md](../plans/2026-05-24-p5-b-d11-d12-manual-checklist.md)
- 跨仓架构：`aviary/docs/SKYBRIDGE_ARCH.md`
- skybridge 仓配套：`skybridge/PROCESS.md`

下一步 **P5-c**（后台触发 + retry + `conflict_record` + 真实双机 + keychain；以及 P5-b 留下的两个 mutation 路径 gap）→ 完整 0.5.0 发版。
