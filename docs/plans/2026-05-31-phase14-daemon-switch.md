# Phase 14 子设计 —— daemon profile switch（db replace 完整重建 + switch gate）

> 父设计：`2026-05-29-account-profile-isolation-design.md`（**v6 定稿，§0.5 + §5.4.2/§5.4.2-bis 权威**）。
> 前置：Phase 12（resolver 地基）✅ + Phase 13（存储+迁移 plumbing）✅ 均落 main。
>
> **形态拍板（2026-05-31，用户确认）**：
> - **Plumbing-only** —— 建 `switchProfile`（db replace 完整状态重建）+ switch gate + 单测，**不接 live 触发**。login 翻转接它在 Phase 15，GUI 快切在 Phase 17。switchProfile 本 Phase 只被测试调用。
> - **switch gate 全覆盖（单点 hook）** —— 在 `server.ts` 注册一个 Fastify preHandler/onResponse hook，swap 窗口对 mutating 请求回 `503 SWITCH_IN_PROGRESS`，完整落实 D9（sync + scheduler + 业务写），单点改动不散落各路由。
>
> **审计修订（2026-05-31，经 3 轮用户 review；以下为最终决策，正文 §2-§5 已照此）**：
> - **P1（最终：epoch 防陈旧）** —— `switchProfile` 期间不得有陈旧 bootstrap 重挂后台句柄、触发新 sync。`ensureBackgroundHandles` 在 `await startSseBridgeIfBootstrapped` **之后**才写 `ctx.sseBridge`（bridge-lifecycle.ts），故仅靠入口 `if isSwitching() return` 挡不住"切换前已过入口、await 后才恢复"的 bootstrap（它会重挂旧 bridge → `onOpen` 立即 `runManualSync`，sse-bridge.ts:99）。**最终用 epoch**：`SwitchGate` 加单调 `generation()`（`runExclusive` body 起始 `switching=true` 时 `++`）；`ensureBackgroundHandles` 进入捕获 epoch，**写回前**重判 `isSwitching() || generation!==epoch` → `handle?.stop()`+return。**airtight 关键**：`bridge.start()`/`subscribeEvents` 同步返回（sse-bridge.ts:86），`onOpen` 是其后的网络 macrotask；失配后的 `handle.stop()` 在同一同步续延里退订、抢在 onOpen 前 → 被弃 handle 绝不触发 sync、`ctx.sseBridge` 也从不被写。代价：switch 末尾 `ensureBackgroundHandles` 放 `runExclusive` **之外**（switching=false 才真正重挂）→ QUIESCE 单次 stop+drain 即足。（途中评估过更轻的"入口 guard 单独 / 双 stop 三明治 / `pendingBootstrap` 追踪 / `runManualSync` 自检"，均有时序漏洞或冗余，弃。）
> - **P1-a** shutdown 闭包持 boot 局部 → 改读 `ctx.scheduler`/`ctx.sqlite`（§4）。
> - **P2-order** `ensureSpecialNotes` 硬要求先 `ensureDeviceId`（special-notes.ts:30）→ PREPARE `ensureDeviceId` 先、`ensureSpecialNotes` 后（§2）。
> - **P3（core 顺手修）** `createDatabase` 仅 incompat/migration 两路 close，`applyInitialSchema/applyForwardMigrations` 抛错漏关句柄 → `try { 版本派发 } catch { sqlite.close(); throw }` 包住（§4）。
> - **P4（提交后语义）** `switchProfile` 返回 `{ warnings }`：**throw = PREPARE abort（什么都没变）/ resolve = 已提交**（COMMIT 后异常进 `warnings`、不 reject）→ 调用方按 throw/resolve 判断、杜绝 split-brain（§2/§5）。
> - **gate API/契约**：`drainMutations` 收为 `runExclusive` 内部、不上接口（P2-d）；503 走 `response.ts:fail()` 带 `error_code`、无 `runManualSync` 自检故无落 500 歧义（P2-e）；hook 在 route 注册前挂（P2-g）；broadcaster 测试只断 DB-backed `pending_count`（P2-f，Phase 14 不写 toml）；abort-safe 拆 PREPARE/COMMIT、可 throw 的全在 PREPARE（P1-c）。

---

## 0. 一句话

把「切 profile = 换 `ctx.db/ctx.sqlite`」升级为 §5.4.2-bis 的**完整状态重建**：一个 `switchProfile(ctx, targetDbPath)` 串行化地 drain 在飞写入 → 停旧后台句柄 → 开新库（abort-safe：先开新再关旧）→ rebuild 所有**构造时捕获了 db/sqlite** 的对象（ReminderScheduler / ConversationStore）→ evict 以 ctx 为 key 的 broadcaster WeakMap → 重设 deviceId、清 session/preview → 重启后台句柄。配一个 ctx 级 **switch gate** 串行化切换并在 swap 窗口拒绝 mutating HTTP。**Phase 14 无 live 调用方**：gate 永不触发、`switchProfile` 永不被生产路径调，现网行为基本不变；唯一现网变化 = `createDatabase` 迁移抛错时多关一次句柄（P3，仅错误路径）+ shutdown 改读 `ctx.*`（切换前与 boot 局部同值）。

---

## 1. §5.4.2-bis 重置清单（已对照代码 file:line 核实）

| 对象 | 持 db/sqlite？ | 处置 | 代码锚点 |
|---|---|---|---|
| `ReminderScheduler(db,sqlite,config,logger)` | 是（`this.db/this.sqlite`） | **rebuild** + `.start()` | `scheduler.ts:38-43` |
| `ConversationStore(sqlite)` | 是（`this.sqlite`） | **rebuild** 替换 `ctx.conversationStore` | `ai/conversations.ts:46-49` |
| `SyncStatusBroadcaster`（WeakMap by ctx） | 否（live 读 ctx），但 `current` 快照旧 | **evict WeakMap 项** → 下次 get 重建 | `sync/status-broadcaster.ts:29` |
| `runManualSync` coalescer（模块级） | 否（live 读 ctx.db/sqlite） | **drain 在飞轮** + gate block 新触发；currentCtx 不重置 | `sync/manual.ts:204-217` |
| `previewStore` | 否（纯内存） | **替换** `new PreviewStore()` | `ai/preview-store.ts:35` |
| `ctx.skybridgeSession` | — | 清 `null` | `context.ts:43` |
| `ctx.deviceId` | — | **重设** `ensureDeviceId(新db)` | `cli.ts:89` |
| `sseBridge` / `syncScheduler` | — | `stopBackgroundHandles` → 换库后 `ensureBackgroundHandles` | `sync/bridge-lifecycle.ts:193,214` |
| routes / eventsBus / toolRegistry / llmClientFactory / config / parentProbe | 否 | **不动**（live 读 mutated ctx） | §5.4.2-bis 已审计 |

> ctx **原地 mutate**（保对象身份）→ 持 ctx 的 route/handle 无需重接线；代价是必须**显式** evict broadcaster WeakMap（以 ctx 为 key，mutate 不会自动 miss）。

---

## 2. switchProfile 时序（abort-safe 改良）

新文件 `packages/daemon/src/sync/profile-switch.ts`：`switchProfile(ctx, targetDbPath, logger)`，整段走 `ctx.switchGate.runExclusive`（串行化 + switching=true）。

`runExclusive` 在跑 body **之前**已 drain 在飞 mutating HTTP（gate 内部职责，§3）；body 自己只 drain sync 链路。`switchProfile` 返回 `Promise<{ warnings: string[] }>`，契约：**throw = PREPARE 内 abort（什么都没变）；resolve = 已提交切库**（P4）。

```
switchProfile(ctx, targetDbPath, logger) -> { warnings }:
 warnings = await runExclusive(():           # switching=true（gate 已 drain 在飞 mutation；hook 拒新 mutating）
   # ── PREPARE —— 所有可能 throw 的新库操作；旧 ctx 全程未动 → throw = abort、什么都没变 ──
   { newDb, newSqlite } = createDatabase({ dbPath: targetDbPath })   # 迁移/不兼容 → throw（自身已 close，P3）
   try { newDeviceId = ensureDeviceId(newDb); ensureSpecialNotes(newDb) }   # ★ deviceId 先、specialNotes 后（P2，special-notes.ts:30）
   catch (e) { newSqlite.close(); throw e }                          # 收半开的新句柄再抛
   # ── QUIESCE —— 停后台后 drain；ensureBackgroundHandles 在 switching 期被 guard no-op ──
   stopBackgroundHandles(ctx)               # syncScheduler + SSE bridge(+probe) OFF
   await drainManualSync()                   # await 在飞 coalescer 轮（含 push/pull/apply 事务）；此后无新轮
   # ── COMMIT —— 校验过的新库；以下不向外抛，异常进 warnings（P4） ──
   w = []
   ctx.scheduler.stop(); ctx.skybridgeSession = null
   oldSqlite = ctx.sqlite
   ctx.db = newDb; ctx.sqlite = newSqlite; ctx.deviceId = newDeviceId
   ctx.previewStore = new PreviewStore()
   try { oldSqlite.close() } catch (e) { w.push('old db close: '+msg(e)) }
   ctx.scheduler = new ReminderScheduler(newDb,newSqlite,config,logger)
   try { ctx.scheduler.start() } catch (e) { w.push('scheduler start: '+msg(e)) }
   ctx.conversationStore = new ConversationStore(newSqlite)
   evictSyncStatusBroadcaster(ctx)           # 下次 getSyncStatusBroadcaster 用新库 initialSnapshot
   return w
 )
 # ── 出 runExclusive（switching=false）后重挂后台句柄 —— 必须在锁外，否则 guard 会 no-op 它 ──
 try { await ensureBackgroundHandles(ctx, logger) } catch (e) { warnings.push('bg handles: '+msg(e)) }
 return { warnings }
 # session install（Phase 15）+ renderer notify §5.4.4（Phase 16）不在本 Phase
```

**P1 —— `ensureBackgroundHandles` epoch 防陈旧**（bridge-lifecycle.ts）：
```ts
export async function ensureBackgroundHandles(ctx, logger, deps = {}) {
  const gate = ctx.switchGate;
  if (gate?.isSwitching()) return;                       // 切换期间不开新句柄
  const epoch = gate?.generation() ?? 0;
  const stale = () => gate?.isSwitching() || (gate?.generation() ?? 0) !== epoch;
  if (!ctx.sseBridge) {
    const handle = await startSseBridgeIfBootstrapped(ctx, logger, deps);
    if (stale()) { handle?.stop(); return; }             // await 期间发生过 switch → 弃陈旧 handle
    ctx.sseBridge = handle;
  }
  if (!ctx.syncScheduler) {
    if (stale()) return;                                 // 建 syncScheduler 会起 timer，必须先判
    ctx.syncScheduler = deps.createSyncScheduler?.({ ctx, logger }) ?? createSyncScheduler({ ctx, logger });
  }
}
```
- **入口 fast-path** + **await 后写回前重判**：覆盖"切换前已过入口、await 后才恢复"的 pending bootstrap（含 manual.ts:230 fire-forget）。失配 → `handle?.stop()` 同步退订（抢在网络 `onOpen` 前，见顶部 P1 审计修订）→ 旧 bridge 绝不触发 sync、`ctx.sseBridge` 不被写。
- **代价**：switch 末尾的 `ensureBackgroundHandles` 放 `runExclusive` **之外**（switching=false、epoch=新值 → 正常重挂）。
- **故 QUIESCE 单次 stop+drain 足矣**：drain 期间无新轮（scheduler/SSE 已停、HTTP 503、陈旧 bootstrap 的 handle 在 onOpen 前被弃）。`generation` 单调 → 多次连切也按"最后一次胜"收敛。

**abort 边界（P1-c）**：可能 throw 的全在 **PREPARE**（createDatabase + ensureDeviceId + ensureSpecialNotes）—— 旧 ctx 完全未动（句柄仍跑、旧库仍开），throw 即"什么都没变"，旧 profile 继续可用。原 §5.4.2 close-then-open 改 **open-then-close**（abort 时 `newSqlite.close()` 收半开句柄）。

**提交后语义（P4）**：COMMIT 起为提交点，**不再向外抛**：`oldSqlite.close()` / `scheduler.start()` 万一抛 → 进 `warnings`、`switchProfile` 仍 **resolve**（ctx 已在新有效库）。调用方（Phase 15）只认 throw=abort / resolve=committed → 不会"以为失败而漏写 toml/session"造成 split-brain。

**为何不 gate scheduler(reminder) 进 mutation 计数**：`ctx.scheduler.stop()` 在 swap 前清所有 timer；已触发的 tick 是**同步** sqlite 调用，在自己那一 event-loop tick 内对仍开的旧库跑完。stop() 后无新 tick → 不会写到已关库。故 reminder scheduler 覆盖 = stop-before-swap，无需进计数。

---

## 3. switch gate（D9：独立 ctx 级锁）

新文件 `packages/daemon/src/sync/switch-gate.ts`。**不复用** `syncCoalescer`（只串行化 sync run，盖不住业务写/scheduler）。

```ts
export interface SwitchGate {
  isSwitching(): boolean;
  /** 单调代际号；每次 runExclusive 进 body（switching=true）时 ++。给 ensureBackgroundHandles epoch 防陈旧（§2 P1）。 */
  generation(): number;
  /** 标记一个通过闸门的 mutating 请求在飞；返回释放函数（onResponse 调）。 */
  trackMutation(): () => void;
  /** 串行化执行切换体：switching=true + generation++ → (内部)drain 在飞 mutation → body → switching=false。 */
  runExclusive<T>(body: () => Promise<T>): Promise<T>;
}
export function createSwitchGate(): SwitchGate
```

- **计数 drain（P2-d：内部职责）**：`trackMutation` ++，释放 --，归零时 resolve 内部 `drainMutations()` waiter。`runExclusive` 先置 `switching=true` + `generation++`（同步）→ `await drainMutations()` → 跑 body。`drainMutations` **不在接口上**，switchProfile body 不调它（只调 `drainManualSync`，§2 QUIESCE）。单线程下「hook 检查 `isSwitching()` + `trackMutation()`」**同步原子**（中间无 await）→ 不会有请求漏过闸门又不被计数。
- **串行化 + 防 poison**：`lock = run.catch(() => undefined)`，一次 rejected switch 不污染锁链；两个并发 switch 排队（Phase 14 无 live 触发，仅防御 + 测试）。
- **无 `SwitchInProgressError` 类**：hook 直接用 `fail()` 出 503（下），无 throw 路径，不引入未用的错误类。

**hook（server.ts，单点，必须在 route 注册之前挂；P2-g）**：
```ts
const MUTATING = new Set(['POST','PUT','PATCH','DELETE']);
ctx.switchGate ??= createSwitchGate();             // buildServer 兜底
app.addHook('preHandler', async (req, reply) => {
  if (!MUTATING.has(req.method)) return;
  const gate = ctx.switchGate;
  if (gate?.isSwitching()) { fail(reply, 503, 'profile switch in progress', 'SWITCH_IN_PROGRESS'); return reply; }
  if (gate) (req as { __switchRelease?: () => void }).__switchRelease = gate.trackMutation();
});
app.addHook('onResponse', async (req) => { (req as { __switchRelease?: () => void }).__switchRelease?.(); });
// …随后才 registerNoteRoutes(app, ctx) 等（Fastify hook 只作用于其后注册的 route）
```

- 覆盖业务写（notes/folders/tags/todo/ai）+ sync 触发（`POST /sync/run` 也是 mutating）。GET（/sync/status 等）不拦。
- 503 body 走 `response.ts:fail(reply, status, message, error_code)` → `{ success:false, message, error_code:'SWITCH_IN_PROGRESS' }`，与全站失败体一致（P2-e）。
- **不**给 `runManualSync` 加 gate 自检：§2 先 `stopBackgroundHandles` 已断 scheduler/SSE 触发，新 HTTP 触发被 hook 503 → 无需自检 → 不产生落到 500/`SKYBRIDGE_SYNC_FAILED` 的歧义错误（P2-e）。

---

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `sync/switch-gate.ts`（新） | `SwitchGate`（含 `generation()`）+ `createSwitchGate`（无错误类） |
| `sync/profile-switch.ts`（新） | `switchProfile(ctx, targetDbPath, logger): Promise<{ warnings: string[] }>`（PREPARE→QUIESCE→COMMIT + 锁外 ensureBg，§2） |
| `sync/status-broadcaster.ts` | 导出 `evictSyncStatusBroadcaster(ctx)` = `cache.delete(ctx)` |
| `sync/coalesce.ts` | `Coalescer` 加 `whenIdle(): Promise<void>`（await 在飞 inflight+followUp，settled 即 idle） |
| `sync/manual.ts` | 导出 `drainManualSync()` = `syncCoalescer.whenIdle()`。line 230 **不改**（保留 `void ensureBackgroundHandles(...)`，靠下面入口 guard 在 switch 期自动 no-op）。**不**加 runManualSync 自检 |
| `sync/bridge-lifecycle.ts` | **`ensureBackgroundHandles` epoch 防陈旧**（§2 P1）：入口 `if isSwitching() return` + 捕获 `generation()` + await 后写 `ctx.sseBridge` / 建 `syncScheduler` 前重判失配则 `handle?.stop()`+return。`stopBackgroundHandles` 不变 |
| `context.ts` | 只加 `switchGate?: SwitchGate`（**optional** → 现有 ~8 个内联 ctx 测试零改） |
| `db/index.ts`（**core**，P3） | `createDatabase` 用 `try { pragma + 版本派发 + drizzle } catch (err) { sqlite.close(); throw err }` 包住，删两处内联 `sqlite.close()` → 任何 throw（含 `applyInitialSchema/applyForwardMigrations`）都关句柄 |
| `cli.ts` | boot ctx 加 `switchGate: createSwitchGate()`；**shutdown 改读 `ctx.scheduler.stop()` + `ctx.sqlite.close()`**（P1-a） |
| `server.ts` | `ctx.switchGate ??= createSwitchGate()` + 在 `registerXRoutes` **之前**挂 preHandler/onResponse hook（P2-g），503 走 `fail()`（P2-e） |

---

## 5. 测试

- `switch-gate.test.ts`：isSwitching 初始 false；trackMutation 计数 drain（持一个未释放的 track → runExclusive body 不进；释放后进）；runExclusive 串行化（两个并发 body 不交叠、switching 窗口正确）；一次 reject 的 runExclusive 不 poison 后续。
- `profile-switch.test.ts`（两个 temp db A/B，各 `createDatabase` + 种可辨数据 + 一个带 switchGate 的最小 ctx）：
  - switch A→B：返回 `{ warnings: [] }`；`ctx.db/sqlite` 查到 B 的数据；`ctx.deviceId === ensureDeviceId(B)`；旧 sqlite `.close()` 后查抛错；`ctx.scheduler` 是新实例且 started；`ctx.conversationStore` 新实例；`ctx.skybridgeSession === null`；`ctx.previewStore` 新实例。
  - **broadcaster evict（P2-f：只断 DB-backed 字段）**：dbA 种 2 行 `sync_changes(synced_at IS NULL)`、dbB 种 0 行；先 `getSyncStatusBroadcaster(ctx).snapshot().pending_count===2`（建缓存）→ switch → `snapshot().pending_count===0`（evict 后用 B 重建）。**不**断 server/device/workspace（来自 toml，Phase 14 不写 toml）。
  - **abort 边界（P1-c）**：注入会 throw 的 `createDatabase`（迁移/不兼容）→ `switchProfile` **reject**；`ctx.db/sqlite/scheduler/skybridgeSession` 仍是 A、`stopBackgroundHandles` 未被调用（旧句柄未停）。
  - **提交后不 reject（P4）**：注入一个 `scheduler.start()` 抛错（或 `oldSqlite.close()` 抛错）→ `switchProfile` **resolve** `{ warnings:[非空] }`，且 `ctx.db/sqlite` 已是 B（committed）。
  - **ensureBg 末尾在锁外**：switch 后 `ctx.scheduler`/`ctx.sqlite` 指向新实例（佐证 P1-a shutdown 读 ctx 的正确性）。
- `bridge-lifecycle.test.ts`（新增 3 例，P1 epoch）：① `isSwitching()===true` 时 `ensureBackgroundHandles` **no-op**（不赋值、deps 工厂未被调）。② epoch 失配：`ensureSkybridgeSession` 在 await 期间 `gate.generation()` 跳变 → 断言返回的 `handle.stop()` 被调用、`ctx.sseBridge` 未被写。③ 无 switch 抢占（epoch 一致）→ 正常重挂。既有用例（无 gate ctx）回归绿。
- `db/index.test.ts`（**core**，P3）：注入 `applyForwardMigrations`/`applyInitialSchema` 抛错 → `createDatabase` 抛出**且** sqlite 句柄已关（断言可立即对同路径再 `new BetterSqlite3` 或删文件、无锁）；既有 incompat/migration-required 错误路径回归绿。
- server hook：mutating 请求在 `ctx.switchGate.isSwitching()` 为 true 时回 **503 + `error_code:'SWITCH_IN_PROGRESS'`**；GET 不受影响；非 switch 期 mutating 正常（回归现有 255 daemon 测试绿）。
- `cli.ts` shutdown：单测难覆盖（进程级），靠 `profile-switch.test.ts`「switch 后 `ctx.scheduler`/`ctx.sqlite` 指向新实例」+ code review 确认 shutdown 读 ctx。

---

## 6. 验收

- `just check`（lint + tsc + 8 守卫，含 `daemon-no-toml-write` —— **switchProfile 不写 toml**，active_profile 由 GUI main 在 Phase 15/17 写）全绿。
- `just test` 现有基线 + 新增（daemon: switch-gate/profile-switch/bridge-lifecycle guard/hook；**core: db/index createDatabase close-on-throw**）全绿；`SKYBRIDGE_E2E=1` 全绿。
- **运行时 diff=0**：无 live 触发 → gate 永不 503、switchProfile 永不被生产调、`ensureBackgroundHandles` guard 永不命中（无 switch）；boot/sync 链路不变。**唯一现网行为变化**：`createDatabase` 在 migration 抛错时多关一次句柄（P3，纯收尾，对成功路径无影响）+ shutdown 改读 `ctx.*`（切换前与 boot 局部同值，等价）。

---

## 7. 不做（推迟）

| 项 | 落点 |
|---|---|
| live 切换触发（login 翻转 / GUI 快切下拉） | Phase 15 / 17 |
| switch 后 session install（`installSkybridgeSession`） | Phase 15（switchProfile 后 compose） |
| renderer 受控刷新（§5.4.4 / B7） | Phase 16 |
| 写 toml `active_profile`（daemon 不写 toml，守卫拦） | GUI main，Phase 15/17 |
| refresh-token 免密快切 | Phase 15 |
