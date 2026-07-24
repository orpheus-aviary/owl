# Problem A — 跨 skybridge 自动同步不生效：调查 + 修复计划

> 归属：0.6.0 → 0.6.1 真机测试修复环节。本轮**只调查 + 出计划，未实现**。
> 关联修复（已做，不属于 A）：状态栏 `commit d95272a` + 冲突误报 B（`apply.ts`，本轮待提交）。

## 1. 症状（用户 2026-07-24 报告）

- 两台设备连**同一个 owl-server** → 近实时同步（共用 owl-server 的 db + 它自己的 `/events` SSE，**不走 skybridge**，故实时）。
- **桌面端 ↔ skybridge ↔ owl-server**（两个独立 skybridge 客户端）→ 右下角能显示上次同步时间，但**不会自动同步**（对方改了这边要很久 / 要手动才拉到；这边改了很久才推出去）。

## 2. 架构回顾

desktop（local daemon）与 owl-server（cloud daemon）是**独立的 skybridge 客户端**，跨设备靠操作日志 push/pull + SSE `change` 事件。
- skybridge server 的 `EventBus` 是**单进程内存版**（`node_modules/@orpheus-aviary/skybridge-server/src/services/event-bus.js` 注释 "single-process"）。push 后 `changes.js` `eventBus.emit({workspaceId, latestSeq})` → 同进程内所有该 workspace 的 SSE 订阅者收到 `event: change`（`events.js`）。
- ⚠️ 若阿里云 PM2 用 **cluster 多实例**，跨实例收不到 change 事件 → 收方向退化。**需先确认 PM2 是 fork 单实例。**

## 3. 同步触发点（`grep runManualSync`，全在 daemon）

| 触发 | 位置 | 方向 |
|---|---|---|
| 收到别人的变更 SSE `change` → `runManualSync` | `sync/sse-bridge.ts:164` | 拉（近实时） |
| 重连补偿 `onOpen` | `sse-bridge.ts:190` | 拉 |
| 定时器（`[sync].interval_min` **默认 5min**，`core/config/index.ts:41`） | `sync/scheduler.ts:66` | 拉+推 |
| 手动 `/sync/run` | `routes/sync.ts:56` | 拉+推 |

**关键缺口：没有「本地 mutation → 立即推送」触发器**（GUI/renderer 保存后也不调 `/sync/run`）。本地编辑只进 outbox，最长等 ~5min 定时器才推出去 → **发方向天然滞后**，收方向近实时 → 不对称。

## 4. daemon.log.4 证据（`~/orpheus-aviary-nest/owl/logs/daemon.log.4`，2026-07-23，旧 0.6.0，被反复重登污染）

- **163× `sync scheduler tick rejected` = `SkybridgeAuthRequiredError: skybridge session not installed`**（`ensureSkybridgeSession` 在 `ctx.skybridgeSession==null` 时抛）。定时器照跑但 session 为 null 时每 tick 必失败。
- **SSE `change event` ×7 到达** → 收链路（onChange→runManualSync）确实触发，skybridge change 广播工作正常。
- 触发的同步轮里大量是 **seed 笔记 `00000000-…-0001/0002` 的 LWW skip + metadata skip**——两端各自 `ensureSpecialNotes` 用**同一固定 id** 独立播种（时间戳不同）→ 跨设备永久 LWW 抖动，**也会喂给 B 的误报冲突**。
- 会话剧烈 churn：~每 1min `switch→local(dev=None)` 再 `switch→account` + `session installed`。疑似用户手动反复重登对抗已修的状态栏 bug（本日志早于状态修复）。

## 5. 根因假设（按优先级）

- **(a) 无 push-on-mutation**（设计缺口，**主因**）→ 你的编辑滞后 ≤5min 才出去。
- **(b) session 失效后不自动恢复**：token 过期/401 → `invalidateSkybridgeSession` 置 null → 之后每次 scheduler/SSE tick 抛 `AUTH_REQUIRED`，直到 GUI main 重装 session。需确认 `sync-auth-renewal.ts scheduleRefresh` 是否可靠重装（参考 memory `infra_gotchas` Phase 17 long-timer 溢出；本例 cadence 与之不完全吻合，待查 access token TTL）。
- **(c) seed 笔记固定 id 冲突** → 跨设备永久 LWW 抖动 + 可能持续生成冲突。
- **(d) scheduler 在 local profile（无 session）也照跑并每 tick reject** → 噪音 + 掩盖真问题；应按 session 存在与否门控。

## 6. 修复计划（分阶段，逐阶段可独立 ship）

### Phase 0 — 干净复现（前置，必须先做）
在 **0.6.1**（含状态 + B 修复）上跑一次正常登录的双端会话（desktop + owl-server），真实编辑几条笔记，抓新 `daemon.log`，确认 (a)-(d) 各命中程度。**owl-server 也要先升到含修复的构建**（见 0.6.1 change table），否则日志仍被旧行为污染。

### Phase 1 — push-on-mutation 防抖推送（对 (a)，主修）
- 在 daemon 侧监听「本地业务写入」信号：`sync_changes` 新增 pending 行时（core `emitSyncChange` 已是唯一出口）触发一个 **debounced（~1–2s）合并推送**，复用现有 `syncCoalescer`（`sync/manual.ts`）避免和 SSE/scheduler 叠加。
- 设计点：debounce 窗口、与 coalescer 的关系（防抖只决定「何时开一轮」，coalescer 决定「同一时刻只跑一轮」）、cloud + local 两种 mode 都要覆盖、无 session 时静默跳过（衔接 Phase 3）。
- 落点候选：core mutation 层 emit 一个进程内事件 → daemon 订阅后 debounce 调 `runManualSync`；或在 daemon 的 note/folder/tag 路由 handler 成功后打点。倾向前者（单一出口，CLI `--direct` 也覆盖）。
- 效果：编辑 → ~2s 推到 skybridge → 对面 SSE 秒拉 → 双向近实时。

### Phase 2 — session 失效自动恢复（对 (b)）
- 401 / token 过期后不要让 scheduler/SSE 无限 reject。方案二选一或组合：
  - GUI main 的 renewal timer 兜底更稳（segment 长定时器、powerMonitor resume/focus 时 `maybeRefreshNow` 已有——确认真机上是否真的触发）。
  - daemon 侧在收到 `AUTH_REQUIRED` 时通过既有通道请 GUI main 重装（不新增 daemon 写 toml/token 的破坏不变量）。
- 目标：token 到期能自愈，不必「需要重新登录」。

### Phase 3 — scheduler / 触发器按 session 门控（对 (d)）
- 无 `ctx.skybridgeSession` 时，scheduler tick 静默跳过（不 `runManualSync`→不 reject 刷屏），或 local profile 时压根不建 scheduler。
- 纯清洁 + 降噪，风险低。

### Phase 4 — seed 笔记 id 冲突（对 (c)）
- 评估：seed 笔记（welcome 等，固定全零 id）是否应**排除出同步**，或改为 per-workspace/per-device 派生 id，避免两端独立播种同 id 互相 LWW/冲突。
- 需谨慎：改 id 策略涉及历史数据 + 迁移；先量化真机上它造成的实际噪音再决定。

### 验证
每 Phase 后：`just check` + core/daemon 单测 + 双端真机跑一轮（编辑→秒级传播、无误冲突、token 过期自愈、无 scheduler 刷屏）。

## 7. 待确认清单（下轮开工前）
- [ ] 阿里云 PoM2 是 fork 单实例（否则先修部署，SSE 广播才跨端生效）。
- [ ] owl-server 升到含 B（+状态）修复的构建后，Phase 0 干净复现。
- [ ] access token TTL 实际值（决定 (b) 的 renewal 表现）。
- [ ] 量化 seed 笔记抖动的真实影响（决定 Phase 4 是否必要）。
