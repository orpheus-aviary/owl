# Problem A — 跨 skybridge 自动同步不生效：调查 + 修复计划

> 归属：0.6.0 → 0.6.1 真机测试修复环节。本轮**只调查 + 出计划，未实现**。
> 关联修复（已做，不属于 A）：状态栏 `d95272a` + 冲突误报 `4fd1a79`。
> **v2（2026-07-27）**：第一版把 (a) 直接定性为主因、把 core 进程内事件当推荐落点、
> 并假设 daemon 能"请 GUI main 重装 session"。经逐条对代码核实后，这三点都不成立，重写了 §5–§7。
> **v3（2026-07-27，第二轮审阅后）**：又修掉 5 个会直接写出错误代码的点 ——
> gate 判据与现有认证模型冲突、watcher 经 coalescer 绕过自己的退避、401 恢复靠本地 expiry 猜原因、
> cloud refresh 把网络抖动当永久登出、迁移三处写法错误。
> **v4（2026-07-27，第三轮审阅后）**：修掉 4 个闭环缺口 —— 迁移 SQL 仍误伤 reorder、
> cloud transient 后无人再触发恢复、单布尔的 recovery 判据表达不了 reason-dependent 能力、
> `auth_required` 的进入/退出/主动登出没闭环（状态与命令必须拆开）。逐条依据见 §9。

## 1. 症状（用户 2026-07-24 报告）

- 两台设备连**同一个 owl-server** → 近实时同步（共用 owl-server 的 db + 它自己的 `/events` SSE，**不走 skybridge**，故实时）。
- **桌面端 ↔ skybridge ↔ owl-server**（两个独立 skybridge 客户端）→ 右下角能显示上次同步时间，但**不会自动同步**（对方改了这边要很久 / 要手动才拉到；这边改了很久才推出去）。

## 2. 架构回顾

desktop（local daemon）与 owl-server（cloud daemon）是**独立的 skybridge 客户端**，跨设备靠操作日志 push/pull + SSE `change` 事件。

- skybridge server 的 `EventBus` 是**单进程内存版**（`node_modules/@orpheus-aviary/skybridge-server/src/services/event-bus.js` 注释 "single-process"）。push 后 `changes.js` `eventBus.emit({workspaceId, latestSeq})` → 同进程内该 workspace 的 SSE 订阅者收到 `event: change`。
- 当前部署命令是 `pm2 start …/bin/skybridge-server.js --name skybridge`（`docs/deploy/baota-fish-runbook.md:99`），**默认 fork 单实例**，所以现状 OK。但这是隐式依赖，见 Phase 5。

## 3. 同步触发点（`grep runManualSync`，全在 daemon）

| 触发 | 位置 | 方向 |
|---|---|---|
| 收到别人的变更 SSE `change` → `runManualSync` | `sync/sse-bridge.ts:164` | 拉（近实时） |
| 重连补偿 `onOpen` | `sse-bridge.ts:190` | 拉 |
| 定时器（`[sync].interval_min`，**默认 5min，`<=0` 可禁用**） | `sync/scheduler.ts:47`、`core/config/index.ts:41` | 拉+推 |
| 手动 `/sync/run` | `routes/sync.ts:56` | 拉+推 |

**关键缺口：没有「本地 mutation → 立即推送」触发器**（GUI/renderer 保存后也不调 `/sync/run`）。本地编辑只进 outbox，要等下一次定时器 / SSE / 手动才推出去。

⚠️ 措辞修正：**不是"最长 5 分钟"**。`interval_min` 是可配置的，`<= 0` 时 `createSyncScheduler` 直接返回 noop handle（`scheduler.ts:54-60`），此时若 SSE 也没建起来，发方向可以**无限期**不推。

## 4. daemon.log.4 证据（2026-07-23，旧 0.6.0，被反复重登污染）

- **163× `sync scheduler tick rejected` = `SkybridgeAuthRequiredError: skybridge session not installed`**。定时器照跑，但 `ctx.skybridgeSession == null` 时每 tick 必失败。
- **SSE `change event` ×7 到达** → 收链路（onChange→runManualSync）确实触发，skybridge change 广播工作正常。
- 大量 seed 笔记 `…0001/0002` 的 **LWW skip + metadata skip**。
- 会话剧烈 churn：~每 1min `switch→local(dev=None)` 再 `switch→account` + `session installed`。疑似用户手动反复重登对抗已修的状态栏 bug（本日志早于状态修复）。

**这份日志不能用来定主因**：163 次「session 未安装」意味着那段时间**任何**触发器（包括还不存在的 push-on-mutation）都会同样失败。(a) 与 (b) 在这份日志里无法区分。

## 5. 根因假设（**均待 Phase 0 证实，不预先排序**）

- **(a) 无 push-on-mutation**（设计缺口，确定存在）→ 发方向依赖 scheduler/SSE 的节奏。
- **(b) session 失效后不自动恢复**。已核实的具体缺口（不是"可能"，是代码事实）：
  - 401 只会 `invalidateSkybridgeSession(ctx)` 把 session 置 null（`sync/manual.ts:274-278`）。desktop 的 per-profile toml 里只有 `encrypted_token`（daemon 无法解密），所以之后每次 `ensureSkybridgeSession` 都抛 `AUTH_REQUIRED`，**daemon 自己永远出不来**。
  - 重新 POST 同一枚已被拒的 access token 无用 —— 必须先 refresh。
  - desktop 侧 `refreshSessionImpl`（`gui/src/main/sync-auth-renewal.ts:86-95`）：`postSyncSession()` 抛错时 `scheduleRefresh(rotated.expiresAt)` 不会执行 → **renewal timer 从此不再重排**，且因为调用点是 `void refreshSession()` 会变成 unhandled rejection。refresh token 已经轮换过了，所以重试**不能再 refresh**（会 `REFRESH_REPLAYED`），只能拿已持久化的新 access token 重发 `/sync/session`。
  - cloud daemon 自己持有 refresh token（`CredentialStore`），但 401 路径**没有**接到 `refreshCloudSession`（`daemon/src/cloud-login.ts:507`）上；只有定时器会 refresh。
  - ✅ 长定时器分段（>2^31ms 溢出）与 resume/focus 补偿**都已经实现了**：desktop `sync-auth-renewal.ts:127-146` + `gui/src/main/index.ts:236-243`（`powerMonitor.resume` / `browser-window-focus` → `maybeRefreshNow`），cloud `cloud-login.ts:475-492`。v1 计划把这些列成待做是错的。
- **(c) seed 笔记 LWW 抖动**（真实存在，但因果与 v1 描述不同，见 §6 Phase 4）。
- **(d) 无 session 时 scheduler 照跑并每 tick reject** → 日志噪音，掩盖真问题。

## 6. 修复计划

**依赖关系（重要）**：Phase 1 的触发器必须在"无 session 时安静跳过"，所以它和 Phase 3 的 gate helper 是**同一个可 ship 单元**（1 里实现 helper，3 复用到 scheduler）。其余 Phase 之间独立。

---

### Phase 0 — 干净复现（前置，必须先做）

在 **0.6.1**（含状态 + 冲突两个修复）上跑一次正常登录的双端会话（desktop + owl-server），真实编辑几条笔记，抓新 `daemon.log`。

- **owl-server 必须先重建重部署**（冲突在接收侧判定，旧构建仍跑旧 core），否则日志继续被旧行为污染。
- 要分别量化：
  - 编辑 → 对端可见的实际延迟分布（区分「等 scheduler」和「压根没推」）。
  - `AUTH_REQUIRED` 出现次数 / 是否伴随 `sync session installed` 自愈。
  - seed 笔记 LWW skip 的实际条数与是否伴随 `conflict recorded`。
- **在 Phase 0 出结论前，不把 (a) 写成"主因"。**

---

### Phase 1 — committed-outbox watcher（对 (a)）+ 触发 gate helper（Phase 3 共用）

**为什么不用 core 进程内事件**（v1 的推荐落点，已否决）：

1. **覆盖不到 daemon 进程外的写入**。`createDirectBackend`（`apps/cli/src/backend/direct.ts:79`）是**独立进程**直接开同一个 db 文件写；daemon 收不到它的内存事件。两种情况都会漏：`--force` 与 daemon 并存时（当场漏），以及 daemon 没跑时写入（重启后没有事件可收 —— 事件方案还得**另外**实现一次 boot 时的 pending 扫描，而轮询天然自带）。
2. **事件会在事务提交前发出**。`emitSyncChange` 的契约是「必须在外层 `sqlite.transaction(...)` 内调用」（`core/src/sync/changes.ts:32-36`）。在那里广播意味着：事务回滚了事件已经发出；或 debounce 到期时事务还没提交，push 的 `SELECT … WHERE synced_at IS NULL` 读不到这行，之后**也不会再被触发**。
3. **绕过 emit 的写入收不到**。migration 直接 INSERT `sync_changes`（`0008_backfill_create_ops.sql`）就是现成例子。

**方案：daemon 侧轮询已提交的 pending outbox。** 新文件 `packages/daemon/src/sync/outbox-watcher.ts`。

- **脏检测查询**：`SELECT MAX(local_seq) AS hi FROM sync_changes WHERE synced_at IS NULL`（clean 时返回 NULL）。
  - ⚠️ v2 写的 `count(*) + MAX(...)`「微秒级」不成立 —— 但**病灶是 `count(*)`，不是索引**。实测（200k pending 行，见下）：
    | 查询 | 耗时 | 计划 |
    |---|---|---|
    | `MAX(local_seq) WHERE synced_at IS NULL` | **0.4 µs** | `SEARCH … USING COVERING INDEX idx_sync_changes_pending` |
    | `count(*) WHERE synced_at IS NULL` | **1772 µs** | 同索引，但必须走完每一条 pending |
  - ✅ **不需要新 migration**（v3 的结论作废）。`local_seq` 是 rowid，也就是 `idx_sync_changes_pending`（`0005_sync_change_outbox.sql:46-49`）的隐式尾列，SQLite 直接套 MIN/MAX 优化 seek 到索引末端。实测追加一条 `(local_seq) WHERE synced_at IS NULL` 的 partial index 后，规划器**根本不选它**，耗时不变 —— 加了纯属白搭一次 schema 版本。
  - 真正的修法就一条：**`count(*)` 移出热路径** —— 只在真正要发起一轮、以及状态转换打日志时读一次。
  - 单测用 `EXPLAIN QUERY PLAN` 断言探针仍命中 partial index 且没退化成 `SCAN`，防以后 schema 变更把它悄悄变成每秒一次 O(pending) 扫描。
- **周期**：`POLL_MS = 1000`，`setInterval(...).unref()`。
- **debounce + maxWait**（避免连续打字期间反复推、也避免饥饿）：
  - 记 `lastHi` / `lastHiChangedAt` / `oldestPendingSeenAt`。
  - 触发条件：`hi` 连续静默 ≥ `QUIET_MS = 800` **或** 最早一批 pending 已等待 ≥ `MAX_WAIT_MS = 5000`。
  - 用轮询窗口实现 debounce，全模块**只有一个 timer**，没有额外 pending callback 要取消。
- **singleflight guard（必须，v2 漏了）**：watcher 自己持一个 `inflight` 标志，**本 watcher 发起的 `runManualSync` 未 settle 前，tick 一律不再调用**。
  - 原因：`createCoalescer.run()`（`sync/coalesce.ts:48-62`）在有轮次在飞时会**排一个 follow-up，且 follow-up 在前一轮 reject 后照跑**（`.catch(() => undefined).then(start)`）。watcher 每秒轮询，一轮慢同步期间必然再次命中 `run()` → 第一轮失败后立刻又跑一轮，**绕过 `nextAttemptAt` 退避**。v2 写的"两者正交"是错的。
  - 只加 watcher 侧的 guard，仍然**不改 coalescer**（SSE / 手动 / scheduler 依赖它现有的 follow-up 语义）。
- **失败退避**：`runManualSync` reject → `nextAttemptAt = now + backoff[i]`，`backoff = [2,4,8,16,30]s + jitter`（与 SSE 重连一致），成功即清零。这解决"push 失败后若没有新 mutation 就只能等 scheduler"。
  - **测试**：一轮失败后、退避到期前，`runManualSync` 的调用次数必须保持为 0（fake timers 直接断言 spy 调用数）。这条测试同时覆盖上面的 singleflight guard。
- **session gate**：调用共享 helper `syncTriggerReady(ctx)`（见下），未就绪就不进入 `runManualSync`，且**不打 warn**（状态转换时各打一条 info）。
- **profile-switch / 生命周期隔离**（v1 完全没写，是真缺口）：
  - `ctx.outboxWatcher` 作为新的 background handle，加进 `stopBackgroundHandles`（`bridge-lifecycle.ts:234`）和 `ensureBackgroundHandles`（同文件 :193），跟 `sseBridge` / `syncScheduler` 完全同构。于是 `switchProfile` 的 `stopBackgroundHandles → drainManualSync → swap → ensureBackgroundHandles` 顺序（`profile-switch.ts:67-99`）**自动覆盖它**。
  - `stop()` 置 `stopped = true` 并 `clearInterval`；tick 里 `gate.isSwitching()` 为真直接 return。
  - **generation 检查**：进入 `runManualSync` 前抓 `epoch = gate.generation()`，await 回来后若 `stopped || generation() !== epoch` → 丢弃结果、不排退避、不再触发。防止旧 profile 的 tick 在换库后对新库做无意义同步、旧库 pending 永久留下。
  - 每 tick 读 `ctx.sqlite`（不闭包捕获），因为 `switchProfile` 是原地改 ctx 字段。
- **session 安装后立即追赶**：`POST /sync/session` 已经是 `stopBackgroundHandles` → `installSkybridgeSession` → `ensureBackgroundHandles`（`routes/sync.ts:200-214`），watcher 会被重建、静默窗口归零 → 登录后 ~1–2s 内自动把积压的 dirty outbox 推出去。**不需要额外接线。**
- **cloud + local 两种 mode 都启用**（owl-server 上网页版的写入同样只进 outbox）。
- **与 coalescer 的关系**：watcher 只决定「何时开一轮」，`syncCoalescer`（`sync/manual.ts:205`）继续决定「同一时刻只跑一轮」。但见上面的 singleflight guard —— 这两件事**不是**正交的。

**两个 helper（Phase 1 落地）**：

1. `syncTriggerReady(ctx): boolean` —— **两种 mode 都只看 `ctx.skybridgeSession != null`**。
   - v2 写的"local 可从明文 toml 自举"是错的：`ensureSkybridgeSession`（`sync/session.ts:262-268`）在 P5-d Phase 10 之后**明确不再读 toml**，唯一入口是 `installSkybridgeSession`（`POST /sync/session`）；明文 `auth.token` 是遗留字段，daemon 不认。
   - v2 写的"cloud 有 `credentialStore` 就算 ready"也是错的：凭据只说明**可以尝试恢复**，不等于**现在能同步**。401 之后 session 被清空、凭据还在，按 v2 的 gate 会继续触发注定失败的同步 —— 正是要消灭的行为。
2. `syncRecoveryCapability(ctx): { canReinstall: boolean; canRefresh: boolean }` —— 手上**有哪种**恢复手段。单个布尔不够用，因为两种 reason 要的能力不同：
   - `canReinstall` = 存在可用的 access 凭据（cloud：`credentialStore.get()?.token`；desktop：活动 profile 的 `encrypted_token`）。**只有 access 也算数** —— `sync-auth.ts:608-611` 明确保留了 "Legacy access path — encrypted_token only, no refresh token (predates D2)"，这类配置能 reinstall 但不能 refresh。
   - `canRefresh` = 存在 refresh 凭据（`encrypted_refresh_token` / `credentialStore.get()?.refreshToken`）。
   - 对应关系：`missing_session` 需要 `canReinstall`；`token_rejected` 必须 `canRefresh`（access 已被拒，重装它没有意义）。
   - **不参与触发决策**，只用于 (a) 状态/日志分档；(b) Phase 2 按 reason 选恢复手段，选不出就进 `logged_out`。
   - ⚠️ **进入 `logged_out` 必须真的清凭据**：调 `clearSkybridgeAuth()`（`core/src/skybridge/config.ts:495`，会清活动 profile 的 `encrypted_token` / `encrypted_refresh_token`）或 cloud 的 `teardownCloudSession`。否则这个 helper 会长期返回 `canRefresh: true`，状态栏一直显示"可自动恢复"，而实际上永远恢复不了。

**验收**：编辑 → ≤2s 推到 skybridge → 对端 SSE 秒拉。

⚠️ v2 写的"CLI `--direct` 写入 ≤2s 被推出去"作为验收条件是错的：`decideMode`（`apps/cli/src/backend/resolve.ts:28-58`）在 daemon 存活时对 direct **写**直接 `DAEMON_RUNNING_BLOCKED`，除非 `--force`；正常 direct 写发生在 **daemon 没跑**的时候，那时根本没有 watcher。正确表述是：
- 轮询相对进程内事件的收益是**覆盖所有绕过 daemon 内存的写入路径**（`--force` direct、migration/backfill 直写 outbox、未来任何新写入方），而不是"让 direct CLI 变实时"。
- 真实语义 = **daemon 下次启动后 ≤2s 把积压推出去**（watcher 首个 tick 就看到 pending）。验收按这条写。

**测试**：fake timers 下的 debounce/maxWait/退避/singleflight/gate 单测；profile-switch 期间 tick 不触发、switch 后旧 epoch 结果被丢弃的单测；"daemon 停止时 direct 写入 → 重启后首轮被推"的集成测。

---

### Phase 2A — desktop（GUI main 拥有 refresh token）session 自愈状态机

**当前唯一的恢复路径**是 renewal timer + resume/focus，且如上所述 `postSyncSession` 失败会把 timer 打死。目标是把它写成显式状态机。

状态：`none → installed(expiresAt) → refreshing → installing → installed`，异常出口 `logged_out`。

- **拆出 `reinstallFromConfig()`**：解密已持久化的 access token 重发 `/sync/session`，**不做 refresh**。
  - 📌 理由更正：v2 说"再 refresh 一次会 `REFRESH_REPLAYED`"是**错的**。server 的 `/auth/refresh`（`node_modules/@orpheus-aviary/skybridge-server/src/routes/auth.js:80-99`）会签发一枚**全新有效**的 refresh token 并 `rotateRefreshToken`；replay 只在**重用旧的那枚**时才触发，而 `persistRotated` 已经把新的落盘了。所以再 refresh 一次功能上是可行的。
  - 真正的理由是：install 失败时手上那枚 access token **本来就是好的**（server 签发新 access 不会吊销旧的），失败的只是"发给 daemon"这一步 —— 重发即可，没必要多烧一次轮换和一个 RTT。
- `refreshSessionImpl` 改成：`refresh → persistRotated → scheduleRefresh(expiresAt)`（**先排下一次**）→ `postSyncSession`；install 失败进 `reinstallFromConfig` 的独立退避 `[2,5,10,30,60]s`，**不影响** renewal timer。
- **daemon → GUI 的 AUTH_REQUIRED 信号**（v1 写的"通过既有通道请 GUI main 重装"**不存在**：`OwlEvent` 只有 `hello` / `open_note` / `sync:status_changed` / `conflicts:changed`（`daemon/src/events/types.ts:30`），且订阅者在 renderer，不是 Electron main）。需要新增：
  1. daemon 新增事件 **`sync:auth_required` 且必须带 `reason`**，在状态转换处 emit（每次 invalidate 至多一条，不随 tick 刷屏）：
     - `missing_session` —— 从没装过 / 被 `logout-local` 清过 → GUI 侧 `reinstallFromConfig()` 就够。
     - `token_rejected` —— 真的收到 401（`manual.ts:274` 那条分支）→ GUI 侧**必须 refresh**，重装同一枚已被拒的 token 没有意义。
     - ⚠️ v2 写的"按本地 expiry 决定 refresh 还是 reinstall"是**错的**：服务器可以提前吊销（logout / device-revoke，见 auth.js 的 `revokedAt` 分支），此时本地 expiry 还没到，会陷入"反复重装同一枚被拒 token"的死循环。**原因必须由拒绝方给出，不能由消费方猜。**
  2. renderer 的 events dispatcher（`components/events-subscriber-core.ts`）把事件 + reason 转发到 main 的新 IPC `sync:recover-session`。
  3. main 的 `recoverSession(reason)` 按 reason 分派，不再自己推断。
- **singleflight + 限流**：`recoverSession` 走已有的 `runSwitchExclusive`（`sync-switch-queue.ts`）+ 模块级 inflight promise；同时**最多 10s 一次**，避免 daemon 连续 401 时打出 refresh 风暴。
- **refresh token 死亡**（`REFRESH_INVALID` / `REFRESH_REPLAYED`）：`clearRefreshTimer()` + 进入 `logged_out`。
- **`logged_out` 的 UI 落点（v2 缺，必须先定）**：`SyncState` 现在只有 `'idle' | 'syncing' | 'error' | 'offline'`，daemon 侧 `daemon/src/events/types.ts:36` 和渲染侧 `packages/shared/src/types.ts:140` **各定义一份，必须同步改**。
  - **推荐：新增 `auth_required` 枚举值**。理由：`error` 已经承载了瞬时网络/API 失败，状态栏对它的处理是"稍后自动重试"；而 `logged_out` 需要的是一个**可点击去登录**的终态提示，语义完全不同。改动量 = 两个枚举 + 状态栏一个分支 + 图标/文案。
  - 备选（更小但更糊）：复用 `error` + 约定 `error_code = 'SKYBRIDGE_AUTH_REQUIRED'`，状态栏按 code 特判。**不推荐**：把终态混进重试态，以后每个消费方都要记得特判。
- **⚠️ 必须把「状态」和「命令」拆成两件东西**（v3 把它们混在一个事件里，闭环有洞）：
  - **状态**（可重新查询，不怕丢）：`SyncStatusBroadcaster`（`sync/status-broadcaster.ts`）加 `markAuthRequired(reason)`，落进 `SyncStatusSnapshot.state`，随现有 `sync:status_changed` 广播，并且 `GET /sync/status` 也能读到。这样即使某个渲染进程错过了瞬时事件，重新打开窗口 fetch 一次就能看到正确状态。
  - **命令**（瞬时，尽力而为）：`sync:auth_required(reason)` 只是"请 GUI main 现在去恢复"的催促，丢了不致命 —— 状态还在，用户也能手动登录。
  - 谁产生：`invalidateSkybridgeSession` 的调用点（`manual.ts` 的 401 分支、`ensureSkybridgeSession` 抛 `AUTH_REQUIRED` 时）→ `markAuthRequired`。
  - 谁清除：**`POST /sync/session` 成功后必须显式回到 `idle`**（`routes/sync.ts` 装完 session 调 `markSessionInstalled()` 并广播新 snapshot）。否则 renderer 会永远卡在 `auth_required`。
  - **主动登出不发命令**：`POST /sync/logout-local` 是用户主动清除，只更新状态、**不发 `sync:auth_required`** —— 否则 GUI 会立刻把刚登出的账号自动重装回去。
  - **只在 local mode 发命令**：cloud daemon / 浏览器端没有 Electron main，没人消费；cloud 的恢复完全走 2B 的 recovery timer。
- **已知残留缺口，写进文档不修**：窗口全关但 app 仍在时没有 renderer 转发命令，此时只能靠 timer + resume/focus 兜底 —— 但状态仍然是准确的（见上面的状态/命令拆分），所以用户再打开窗口就能看到并手动处理。

---

### Phase 2B — cloud daemon（自己持有 refresh token）401 自刷新

**前置改造（必须先做，v2 把现有实现描述错了）**：`refreshImpl`（`daemon/src/cloud-login.ts:512-532`）现在 `catch` 到**任何** refresh 异常都 `teardownCloudSession(ctx)` —— 网络抖动、服务端 5xx 一样会清掉内存凭据并注销所有 Layer-2 浏览器会话。v2 说"只有硬失败才 teardown"是错的。

- 先把 `refreshCloudSession` 的结果分类成三态返回（**带上失败的 error 本身**，`{outcome, error?}`，否则调用方无法区分"同步的 401"和"refresh 的网络错"）：
  - `refreshed` —— 正常轮换并 rebind。
  - `transient_failure` —— 网络错误 / 5xx / 超时：**保留凭据、保留 Layer-2 会话**，不 teardown。
  - `logged_out` —— 仅在明确失效时 teardown：`REFRESH_INVALID` / `REFRESH_REPLAYED`（server 对 logout、device-revoke、过期、replay 都归到这两个 code，见 auth.js:65-77）。
- **先做模块拆分，再改逻辑**：把 `isNetworkError` / `isApiError` / refresh error-code 分类抽到新的 `daemon/src/sync/skybridge-errors.ts`。它们现在是 `sync/manual.ts:133-143` 的私有函数，而 Phase 2B 会让 `manual.ts` 反过来 import `cloud-login.ts` —— 直接互相 import 会造出新的循环依赖。
- **这条本身就是一个独立的 bug 修复**，即使 Problem A 其它部分推迟也值得先 ship（现状下一次机房抖动就会把云端 daemon 踢成未登录 + 注销所有 Layer-2 浏览器会话）。

**cloud recovery timer（v3 缺，必须补）**：v3 写的"transient 后交给 watcher backoff / renewal timer"两条路**都不通**：

- 同步侧抛回 401 后，`doRunManualSync` 的 catch 会 `invalidateSkybridgeSession` 清空 session → `syncTriggerReady` 变 false → **watcher 从此不再触发**，没人再来重试。
- proactive refresh 是一次性的 `setTimeout`（`cloud-login.ts:475-492`），**transient 失败后不会自动重排**（现状是直接 teardown，改成三态后如果不补重排，就变成"什么都不做"）。

所以需要一个**独立于 `syncTriggerReady` 的 cloud recovery timer**：

- `transient_failure` 时：保留 credentials、清掉被拒的 session，安排 30s 后重试 refresh（退避 `[30,60,120,300]s` 封顶）。
- refresh 成功 → `rebindSession` → 重启 background handles → **触发一次追赶同步**。
- `logged_out` → 停 timer，不再重试。
- ⚠️ **重启顺序有个已知交互**：`rebindSession` 之后重建 SSE bridge，其 `onOpen` 会自己调一次 `runManualSync`（`sse-bridge.ts:190`）。如果此时 coalescer 里还有轮次在飞，会排一个 follow-up，**"最多两轮"的约束就被突破了**。二选一并写进测试：(a) 把 background restart 推到追赶同步之后；(b) 显式接受这个 follow-up，但断言它**不会绕过 watcher 的退避**（watcher 的 singleflight 只管自己发起的轮次，SSE 的 follow-up 是另一条腿）。倾向 (a)，更容易讲清楚。

**401 自刷新**：

- 把 `doRunManualSync` 的同步主体抽成 `attemptSyncRound(ctx)`，`doRunManualSync` 里最多调两次。**不能递归调 `runManualSync`**，那会绕回 coalescer。
- 401 且 `config.daemon.mode === 'cloud'` 且本轮尚未重试过：`await refreshCloudSession(ctx)` → 按三态分派：`refreshed` 重试一轮；`transient_failure` 抛回**原同步 401**（不是 refresh 的网络错，两者都在返回值里，别搞混）并**启动 recovery timer**；`logged_out` 不重试，交给 Phase 1/3 的 gate 安静下来。
- **冷却**：同一 daemon 进程内 refresh-on-401 至少间隔 30s，避免 token 真死时热循环。
- desktop（local mode）不走这条路径 —— 它没有 refresh token，只能靠 2A。

---

### Phase 3 — scheduler 降噪（复用 Phase 1 的 gate）

- `createSyncScheduler` 的 tick 先过 `syncTriggerReady(ctx)`（= `ctx.skybridgeSession != null`）：不就绪 → 不调 `runManualSync`、不打 warn。
- **保留可观测性**：进入/离开「未就绪」各打一条 info，带 `pending_count` + `syncRecoveryCapability(ctx)`，这样"163 次刷屏"变成两条状态行，同时能一眼看出是**在等自动恢复**还是**已经没凭据、需要用户重新登录**。
- 就绪后的第一 tick 正常跑（追赶语义由 Phase 1 的 watcher 保证，这里不重复实现）。

---

### Phase 4 — special notes（随记 / 待办）确定性 seed 时间戳（对 (c)）

**先纠正 v1 的因果描述**（v1 写的"两端各自播种同 id → 永久互推抖动"不成立）：

- `ensureSpecialNotes`（`core/src/db/special-notes.ts:23`）**不写 outbox**，migration 0008 也显式排除这两个 id（`0008_backfill_create_ops.sql:17,101-104` + 测试 T4）。所以 seed 本身**不会**产生 `create` op、不会互推。
- 真正的问题是：seed 用 **`new Date()`（当前时间）**写 `created_at/updated_at`；而用户或 AI 改随记/待办走的是普通 `updateNote`（`core/src/notes/index.ts:417`），**会**正常产生 `update` op。于是「晚开机设备的默认 seed 时间戳」可能在 LWW 上**压过对端的真实编辑** → 对端的随记内容永远同步不过来。日志里的 LWW skip 就是这个。

**语义已拍板（2026-07-27，用户决定）：随记 / 待办 = 跨设备同步的用户数据。**

- ⇒ **固定 id 保留**。"改 per-workspace/per-device 派生 id"选项已从计划中移除（会制造重复系统笔记，并打断 GUI `renderer/src/lib/special-notes.ts:9` 与 AI system prompt `daemon/src/ai/system-prompt.ts:19` 对固定 id 的定位）。
- ⇒ 修法 = **确定性低优先级 seed 时间戳**，`SEED_TS = 0`。让每台设备的 pristine seed **字节一致，且在 LWW 上永远输给任何一次真实编辑**。

**具体改动**：

1. `core/src/db/special-notes.ts` — seed 的 `createdAt` / `updatedAt` 写 `new Date(SEED_TS)`（`SEED_TS = 0`，导出常量供迁移测试引用），并显式写 `lwwCounter: 0`（列默认已是 0，显式写是为了让"确定性 seed"这个不变量在代码里看得见）。`trash_level > 0 → restore` 分支不动。
2. 新增 migration `0010_special_notes_seed_ts.sql`（Phase 1 最终没有引入迁移，所以 0010 空着）—— 归零**从未被编辑过**的 seed 行。**同时把 `LATEST_KNOWN_VERSION`（`core/src/db/migrate.ts:47`，现为 9）改成 10**，否则 `applyForwardMigrations` 的枚举上界不覆盖新文件，迁移静默不跑。

   **每个 id 一条独立 UPDATE**（v2 那段 `CASE id WHEN '…0001'` 写了带省略号的字面量，永远匹配不上完整 UUID，随记会落进待办的 ELSE 分支拿到错模板）：

   ```sql
   UPDATE notes SET created_at = 0, updated_at = 0, lww_counter = 0
   WHERE id = '00000000-0000-0000-0000-000000000001'
     AND created_at = updated_at
     AND content = '# 随记' || char(10) || char(10)
     AND NOT EXISTS (
       SELECT 1 FROM sync_changes sc
        WHERE sc.entity_type = 'note' AND sc.entity_id = notes.id
          AND ( sc.op IN ('create','trash','restore','delete')
             OR ( sc.op = 'update'
                  AND json_type(sc.payload, '$.updated_at_ms') IS NOT NULL ) ));
   -- 同形一条给 '…0002' + '# 待办' || char(10) || char(10) || '- [ ] '
   ```

   三道 WHERE 的分工：
   - `created_at = updated_at` —— seed 时两者相等，任何一次编辑都会只推高 `updated_at`。这是最直接的"未编辑"判据。
   - `content = 默认模板` —— 双保险。
   - 最后一道**按 payload 判、不按 op 判**：`op IN (...)` 的粗筛会误伤 reorder —— `reorderNotes`（`core/src/notes/index.ts:780-793`）发的**也是 `op='update'`**，但 payload 只有 `{position}`，既不碰 `content` 也不碰 `updated_at`。v3 的写法（连 `update` 一起排除）等于把"只被拖动过顺序的 pristine seed"也跳过了，跟正文说的"允许 pin/reorder"自相矛盾。
     判据换成 **payload 里有没有 `updated_at_ms`**：`buildNoteUpdatePayload`（`core/src/notes/index.ts:403-415`）保证真正的 `updateNote` 一定带这个字段，而 pin（`{pinned_at_ms}`）/ reorder（`{position}`）都不带。
   - 📌 顺带纠正一个更省事但不可靠的候选条件 `device_id IS NULL`：`updateNote` 写的是 `readSkybridgeDeviceId(sqlite) ?? null`（`core/src/notes/index.ts:392-393`），**没登录过 skybridge 的设备编辑后 `device_id` 仍是 NULL**，会误判成 pristine。不用它。
3. LWW 全序是三元组 `(updated_at_ms, lww_counter, device_id)`（`core/src/sync/apply.ts:9`）。只要前两项固定成 `(0, 0)`，任何真实编辑（ms > 0）必胜；而 pristine seed **永远不发 op**，所以 `device_id` 那一位兜底比较根本不会被触发 —— 两端都是 pristine 时不存在需要比较的远端变更。

**收益 / 影响**：

- ✅ 修掉 bootstrap 方向：晚开机的设备第一次 pull 时能正常应用对端历史里的 `update` op（此前被本地 seed 的 `now()` 压掉，随记内容永远同步不过来）。
- ✅ 与 0.6.1 冲突门一致：pristine seed 没有 pending `sync_changes` 行，`apply.ts` 的 pending-gate 不会误报冲突。
- ⚠️ **可见副作用**：新装设备上随记/待办会排在笔记列表最底、时间显示 1970-01-01。GUI 对特殊笔记只做了颜色条和删除确认特判（`special-notes.ts:18`、`DeleteConfirmDialog.tsx:83`），**没有置顶**，所以这个效果是真实可见的。真机手测时若觉得刺眼，改成固定过去常量（如 `2020-01-01`）是一行改动 —— 排序位置不变，只是日期显示不同。
- 📝 记录不修的小差异：`ensureSpecialNotes` 的 restore 分支同样不写 outbox，所以一条被删掉的随记会在下次启动时被本地 restore 复活且不广播。**注意这只在异常路径下可达** —— 正常 API 删不掉：`routes/notes.ts:23-24` 有 `SPECIAL_NOTE_IDS` 守卫 + `系统笔记不可删除`。可达场景仅限：旧版本 db、直接跑 SQL、或数据损坏。

**测试**：core 单测（两个独立 db 的 seed 完全一致；seed 后 `sync_changes` 仍为空）；迁移测试（pristine 归零 / 已编辑不动 / **只被 pin 过的 pristine 仍归零** / **只被 reorder 过的 pristine 仍归零** / 有真 `update`（带 `updated_at_ms`）行不动）；apply 层 LWW 测试（`(0,0)` 的本地行输给任何 `ms > 0` 的远端 update）。

**Phase 0 若显示实际噪音很小，本 Phase 优先级可后置**（语义已定，但不必抢在 Phase 1/2 之前做）。

---

### Phase 5 — skybridge server 单实例：从"碰巧对"变成显式不变量

- 现状是 `pm2 start`（fork 单实例）→ SSE 广播正确。但任何 `pm2 -i`、多容器、滚动发布都会**静默**退化成"收方向失效"，而且现象跟 Problem A 一模一样、极难归因。
- **本轮只做部署侧（owl 仓内可完成的部分）**：
  - 在 `docs/deploy/baota-fish-runbook.md` 写成**部署不变量**：单实例 fork，禁止 cluster / 多副本 / 滚动并存。
  - 把启动方式从裸 `pm2 start` 改成受版本控制的 `ecosystem.config.cjs`，显式写死 `instances: 1` / `exec_mode: 'fork'` —— 强制在配置里，而不是靠操作者记得别加 `-i`。
  - 部署 checklist 加一步 `pm2 describe skybridge`，人工确认 exec mode / instances。
- ⚠️ **v2 说的"给 skybridge server 加启动检查"要降级**，两个原因：
  1. skybridge server 在本仓是 **npm 依赖**（`node_modules/@orpheus-aviary/skybridge-server`），不是受控源码。真要改得走：skybridge 仓改 → 发版 → owl 升依赖 → 重新部署验证。属于**跨仓工作项**，记进 skybridge backlog，不在 Problem A 范围内。
  2. 进程内**探测不可靠**：`pm_id` 只说明进程受 PM2 托管；`NODE_APP_INSTANCE` 是**实例序号**不是总数（单实例也可能是 0），更覆盖不了"多个容器各自都是 0"。所以最多只能做成"检测到 cluster 迹象时打 warn"的尽力提示，**不能声称能可靠发现所有多副本场景**。
- 长期（skybridge backlog，不在本轮）：换成 Redis / pubsub 跨进程事件总线 —— 这才是真正解除单实例约束的办法。

---

### 验证（每 Phase 后）

`just check` + core/daemon 单测 + 双端真机跑一轮：

- 健康条件下，编辑落库后**至多 2 个 poll 周期内开始同步**（不承诺"2 秒内对端可见"—— 实际网络 push + 对端 SSE 往返不在我们控制内）。
- daemon 停止期间的直写（`--direct` / migration），**重启后首轮被推出去**。
- 切账号期间与之后无脏同步；token 过期自愈；无 scheduler 刷屏；无误报冲突。

## 7. 实施记录（2026-07-27 随 0.6.1 发版）

> 除 Phase 2A 外全部已 ship，真机验收通过。用户可见说明 `docs/history/0.6.1-release-notes.md`，
> 状态以 `PROCESS.md` 为准。下面保留原实施顺序 + 落地情况。

- [x] **0a. 抽 `daemon/src/sync/skybridge-errors.ts`** —— `isNetworkError` / `isApiError` 从 `manual.ts` 搬出，新增 `isRefreshTokenDead`（只认 `REFRESH_INVALID` / `REFRESH_REPLAYED`，其余一律当瞬时）。避开 Phase 2B 的循环依赖。
- [x] **0b. Phase 2B 前置改造** —— `refreshCloudSession` 返回 `{outcome, error?}` 四态（`refreshed` / `transient_failure` / `logged_out` / `no_credentials`）；transient 保留凭据 + 保留 Layer-2 会话 + 按 `[30,60,120,300]s` 阶梯重排恢复定时器；`rebindSession` 失败也走 transient（轮换后的 token 已落盘，重试会读到它）。`refreshImpl` 不再抛出。**recovery timer 复用 `ctx.refreshTimer`** —— 语义就是"下次尝试 refresh 的时间"，不需要第二个 timer 字段。追赶同步交给 SSE bridge 已有的 `onOpen` catch-up，所以 §6 Phase 2B 里那个"重启顺序"的取舍不再存在（选了第三条路：不额外发起同步）。
- [x] **1. Phase 0 干净复现** —— 以 rc.1 / rc.2 真机验收代替：修复后「桌面改 → 网页端 2–4 秒可见」直接成立，(a) 无 push-on-mutation 确认是主因。
- [x] **2. Phase 1** —— `sync/trigger-gate.ts`（`syncTriggerReady` + `syncRecoveryCapability`）+ `sync/outbox-watcher.ts`，接进 `ensureBackgroundHandles` / `stopBackgroundHandles` / `ctx.outboxWatcher`。**最终没有引入迁移**（见上面的实测）。
- [x] **3. Phase 3** —— scheduler tick 过同一个 gate，未就绪时静默跳过 + 只打状态转换日志（带 `can_reinstall` / `can_refresh`）。
- [ ] **4. Phase 2A**（desktop token 过期自愈）—— **唯一未做项**。用户 2026-07-27 定：不影响使用，延后。开工前先定 `SyncState` 是否加 `auth_required`（§8）。
- [x] **5. Phase 2B 的 401 自刷新** —— `attemptSyncRound` 拆分 + `maybeRecoverCloudSession`（cloud only，30s 冷却）。
- [x] **6. Phase 4** —— `SEED_TS=0` + migration `0010` + `LATEST_KNOWN_VERSION` → 10。
- [x] **7. Phase 5** —— 部署不变量写进 runbook（单实例 fork + `pm2 describe` 确认）；server 端启动检查转 skybridge 仓 backlog。
- [x] **计划外（真机验收时追加）** —— 远端变更前端自动刷新（`notes:changed` → 列表 bump + 开着的标签页三态 reconcile）+ 桌面 CAS（`expected_updated_at` 不再只在网页端发，堵掉桌面 stale 保存静默覆盖远端编辑的路径）。

## 8. 待确认清单

**仍待办（只剩 Phase 2A 相关）**

- [ ] skybridge access token TTL 实际值（决定 2A 的 renewal 节奏；`sync-auth-renewal.ts:130` 注释说 server 默认 30 天，要真机确认）。
- [ ] **拍板**：`SyncState` 加 `auth_required` 枚举值（推荐），还是复用 `error` + `error_code` 特判。影响 2A 的 UI 落点，`daemon/src/events/types.ts` 与 `packages/shared/src/types.ts` 两处要同步改。

**已了结**

- [x] ~~阿里云 PM2 是否 fork 单实例~~ → 是（`pm2 start` 默认）。已写成部署不变量 + `pm2 describe` 确认步骤。
- [x] ~~Phase 0 干净复现~~ → 以 rc.1 / rc.2 真机验收代替，(a) 确认是主因。
- [x] ~~量化 seed 笔记 LWW skip~~ → 直接做了 Phase 4；因果已在 §6 澄清（seed 用 `now()` 参与 LWW，不是"互推"）。
- [x] ~~随记 / 待办的同步语义~~ → **2026-07-27 定：跨设备同步的用户数据，固定 id 保留。**
- [x] ~~`SEED_TS` 取值~~ → **定 `0`**。新机器上列表沉底 + 显示 1970 是已知副作用；手测觉得刺眼再换固定过去常量。

## 9. 修订依据（逐条对代码核实）

### 实施中推翻的计划结论（2026-07-27 落地时实测）

| 计划说法 | 实测结果 | 处置 |
|---|---|---|
| Phase 1 需要新建 `(local_seq) WHERE synced_at IS NULL` partial index + `LATEST_KNOWN_VERSION` +1 | ❌ 200k pending 行下，`MAX(local_seq) WHERE synced_at IS NULL` 在**现有** `idx_sync_changes_pending` 上就是 **0.4µs**（`local_seq` 是 rowid = 该索引隐式尾列，SQLite 直接 MIN/MAX seek 末端）。加了新索引规划器根本不选，耗时不变 | 迁移已建后删除，`LATEST_KNOWN_VERSION` 回退到 9。真正要修的是 `count(*)`（1772µs），已移出热路径 |
| Phase 2B「rebind 后重启 background handles 会突破"最多两轮"，需推迟重启或显式接受」 | ⚠️ 问题本身成立，但前提可以消掉 | 选了计划里没写的第三条路：**refresh 成功后不额外发起追赶同步**，直接复用 SSE bridge `onOpen` 已有的 catch-up。没有第二个同步入口，就没有排序取舍 |
| cloud recovery timer 是"独立于 proactive refresh 的新 timer" | ⚠️ 没必要 | 复用 `ctx.refreshTimer` —— 它的语义本来就是"下次尝试 refresh 的时刻"，两个 timer 反而会互相踩 |

### v4（第三轮审阅）

| v3 说法 | 核实结果 | 依据 |
|---|---|---|
| 迁移排除 `op IN ('create','update',…)`，正文却说"允许 reorder" | ❌ 自相矛盾：`reorderNotes` 发的正是 `op='update'`（payload 只有 `{position}`）。判据改成"payload 有没有 `updated_at_ms`" | `core/src/notes/index.ts:780-793`、`:403-415` |
| cloud `transient_failure` 后"交给 watcher backoff / renewal timer" | ❌ 两条路都断：401 已清 session → gate=false → watcher 不再触发；proactive refresh 是一次性 `setTimeout`，transient 后不重排。需要独立的 cloud recovery timer | `sync/manual.ts:274-278`、`daemon/src/cloud-login.ts:475-492` |
| 三态返回 | ⚠️ 不带 error 就分不清"同步的 401"和"refresh 的网络错"，`transient` 分支"抛原错误"有歧义 → 返回 `{outcome, error?}` | 本文 §6 Phase 2B |
| rebind 后立即重启 background handles | ⚠️ SSE `onOpen` 会自己再调一次 `runManualSync`，可能在当前轮次未结束时排 follow-up，突破"最多两轮" → 推迟重启或显式接受并测试 | `sync/sse-bridge.ts:190` |
| `syncRecoveryAvailable(): boolean` | ❌ 表达不了 reason-dependent 能力：`missing_session` 只有 access 也能 reinstall（legacy refresh-less 配置真实存在），`token_rejected` 必须有 refresh。改成 `{canReinstall, canRefresh}` | `gui/src/main/sync-auth.ts:608-611` |
| 进入 `logged_out` | ❌ 不清持久化凭据的话 helper 会长期返回"可恢复"，状态栏骗人 → 调 `clearSkybridgeAuth()` / `teardownCloudSession` | `core/src/skybridge/config.ts:495` |
| `auth_required` 只靠一个瞬时事件 | ❌ 没闭环：没人产生 broadcaster 状态、`/sync/session` 成功后没人回 `idle`、主动 logout 会被自动重装回去、cloud 无 Electron main、renderer 转发丢了不可重放 → **状态（可查询）与命令（瞬时）拆开** | `sync/status-broadcaster.ts`、`routes/sync.ts:190-247` |
| cloud-login 复用 `manual.ts` 的私有分类函数 | ⚠️ Phase 2B 会让 `manual.ts` 反向 import `cloud-login.ts` → 循环依赖。先抽 `sync/skybridge-errors.ts` | `sync/manual.ts:133-143` |
| 验证章节"CLI `--direct` 秒级传播" | ❌ 与前文已修正的表述矛盾，删掉；"≤2s 推到 skybridge"改成"≤2 个 poll 周期内开始同步" | 本文 §6 Phase 1 |
| "在 A 删掉随记" | ⚠️ 正常 API 删不掉（`SPECIAL_NOTE_IDS` 守卫 + `系统笔记不可删除`），只在旧版本 / 裸 SQL / 数据损坏时可达，需注明 | `daemon/src/routes/notes.ts:23-24` |

### v3（第二轮审阅）

| v2 说法 | 核实结果 | 依据 |
|---|---|---|
| `syncTriggerReady`：local 可从明文 toml 自举 | ❌ P5-d Phase 10 之后 `ensureSkybridgeSession` **从不读 toml**，明文 token 是遗留字段 | `sync/session.ts:244-268` |
| `syncTriggerReady`：cloud 有 credentials 就 ready | ❌ 凭据 = 可尝试恢复 ≠ 现在能同步；401 后会继续触发注定失败的轮次。拆出 `syncRecoveryAvailable()` | `sync/manual.ts:274-278` |
| watcher 与 coalescer"正交，不改 coalescer" | ❌ `run()` 在飞行中会排 follow-up，**且前一轮 reject 后照跑** → 绕过 watcher 退避。必须加 watcher 侧 singleflight | `sync/coalesce.ts:48-62` |
| 401 后按本地 expiry 决定 refresh / reinstall | ❌ 服务器可提前吊销（logout / device-revoke），本地 expiry 未到 → 死循环重装被拒 token。事件必须带 `reason` | `…/skybridge-server/src/routes/auth.js:65-77` |
| "再 refresh 会 `REFRESH_REPLAYED`" | ❌ refresh 会签发**全新有效**的 refresh token；replay 只在重用旧的那枚时触发。理由换成"手上的 access 本来就是好的" | `…/routes/auth.js:80-99` |
| `logged_out` → 状态栏显示"需要重新登录" | ❌ `SyncState` 只有 4 态，没有落点；且 daemon / shared 各定义一份要同步改 | `daemon/src/events/types.ts:36`、`packages/shared/src/types.ts:140` |
| cloud `refreshImpl`"只有硬失败才 teardown" | ❌ catch 到**任何**异常都 `teardownCloudSession`；网络抖动/5xx 会清凭据 + 注销所有 Layer-2 会话 | `daemon/src/cloud-login.ts:512-532` |
| 0010 迁移直接可写 | ❌ 三处错：没提 `LATEST_KNOWN_VERSION` 必须 +1（否则静默不跑）；`CASE id WHEN '…0001'` 是带省略号的字面量永不匹配；`NOT EXISTS 任何 sync_changes` 过宽（pin/reorder 也留行且不碰 updated_at） | `core/src/db/migrate.ts:47`、`core/src/notes/index.ts:695-718` |
| 每 tick `count(*) + MAX()`"微秒级" | ⚠️ 一半对：`count(*)` 确实要扫完所有 pending（200k 行 = 1772µs），必须移出热路径。但"要新建索引"是错的 —— 见下面 v4 实施记录 | `0005_sync_change_outbox.sql:46-49` |
| 验收"CLI `--direct` 写入 ≤2s 被推出" | ❌ daemon 存活时 direct 写会 `DAEMON_RUNNING_BLOCKED`（除非 `--force`）；正常 direct 发生在 daemon 没跑时，那时没有 watcher | `apps/cli/src/backend/resolve.ts:28-58` |
| 给 skybridge server 加启动检查 | ⚠️ server 在本仓是 npm 依赖，属跨仓工作项；且 `pm_id` / `NODE_APP_INSTANCE` 探测不到多副本（后者是序号不是总数）。降级为 ecosystem 配置 + 部署 checklist | `node_modules/@orpheus-aviary/skybridge-server/` |

### v2（第一轮审阅）

| v1 说法 | 核实结果 | 依据 |
|---|---|---|
| core 进程内事件可覆盖 CLI `--direct` | ❌ direct 是独立进程 | `apps/cli/src/backend/direct.ts:79` |
| 在 `emitSyncChange` 处广播 | ❌ 该函数契约要求在外层事务内；事件会早于/独立于提交 | `core/src/sync/changes.ts:32-36` |
| 新 trigger 的生命周期 | ❌ v1 完全没写；不接 `stopBackgroundHandles` + generation 就会跨 profile 脏同步 | `sync/profile-switch.ts:67-99`、`sync/bridge-lifecycle.ts:193-239`、`sync/switch-gate.ts:88-101` |
| Phase 2 要做长定时器分段 + resume/focus | ❌ 已实现 | `gui/src/main/sync-auth-renewal.ts:127-146`、`gui/src/main/index.ts:236-243`、`daemon/src/cloud-login.ts:475-492` |
| "通过既有通道请 GUI main 重装" | ❌ 无此通道；事件只有 4 种且消费者在 renderer | `daemon/src/events/types.ts:30` |
| 401 后能自愈 | ❌ 只置 null；desktop toml 只有 `encrypted_token`，daemon 解不了 | `sync/manual.ts:274-278` |
| desktop refresh 后 install 失败 | ❌ 不重排 timer + unhandled rejection | `gui/src/main/sync-auth-renewal.ts:86-95` |
| seed 笔记"每次播种持续互推" | ❌ seed 不写 outbox、0008 已排除；真正问题是 seed 用当前时间参与 LWW | `core/src/db/special-notes.ts:23`、`0008_backfill_create_ops.sql:17,101-104` |
| 改 per-device id | ❌ 会破坏 AI/GUI 对固定 id 的定位并制造重复系统笔记 | `daemon/src/ai/system-prompt.ts:19`、`renderer/src/lib/special-notes.ts:10` |
| "最长 5 分钟" | ❌ `interval_min` 可配置，`<=0` 直接禁用 | `sync/scheduler.ts:47-60` |
| "各 Phase 可独立 ship" | ❌ Phase 1 依赖 Phase 3 的无 session 行为 → 合并为一个单元 | 本文 §6 |
| 单实例检查 | ⚠️ 现状对（`pm2 start` = fork），但需写成不变量 + 启动检查 | `docs/deploy/baota-fish-runbook.md:99` |
