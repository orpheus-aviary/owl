# SSE idle watchdog（原 Phase 11，0.5.0；✅ 已完成）

- 日期：2026-06-06
- 范围：**owl daemon 单仓**（`packages/daemon/src/sync/`）。**skybridge 零改动**。
- 状态：**✅ 完成（2026-06-06）**，commit `d998d13`（落本地 main 未 push，并入 Phase 23 批 push）。3 项决策已锁：①阈值 **60s** ②**写死常量**不做用户旋钮 ③真机验证 **可选/留 soak**。
- 关联：`2026-05-24-p5-c-plan.md` §1.4 / §355（当年把 watchdog 推后到 P5-d「看真实双机数据再定阈值」）；
  `2026-05-29-account-profile-isolation-design.md`（per-profile 主线）。
- 决策入口：用户 2026-06-06「放到 0.5.0 完成」。

---

## 1. 问题

SSE bridge（`sse-bridge.ts`）目前只能从 **显式断开** 恢复：任何触发 SDK `onError` 的事件
（网络断、HTTP 错、G2 的 `done:true` clean-close）→ `markOffline` → `onErrorHook`（拉起
`health-probe` 10s 探针）→ `scheduleReconnect`（`[2,4,8,16,30]s + jitter` 退避，永不放弃）。

它 **识别不了「半开连接 / 下行假死」**：TCP socket 看起来还活着（没有 FIN/RST，read 不报错），
但 server 静默停止下发。常见成因：

- NAT / 负载均衡 / 反代的 idle 超时**静默丢弃**上游连接但不发 RST；
- server 进程 wedged（被 `kill -STOP`、GC 长暂停、磁盘卡死）但 socket 没关；
- 移动网络 / 休眠唤醒后的僵尸连接。

这种状态下 `onChange` / `onError` / `onOpen` **都不会触发**，bridge 永远停在「已连接」的错觉里，
GUI sidebar 显示「已同步」而实际上**远端推送全部丢失**，只能靠用户手动点「手动同步」按钮（W8）兜底。

`health-probe.ts` 文件头已明确写「Does NOT cover the 'SSE connected but server stopped pushing
events' case (downstream stall)」—— 那正是本设计要补的洞。

## 2. 机制已就位（无需动 skybridge）

调查确认下面三件已经现成，0.5.0 只缺 owl 端一根线：

| 层 | 现状 | 证据 |
|---|---|---|
| server keepalive | 连接即写 `:ok\n\n`，之后**每 25s** 写 `event: ping`（`PING_INTERVAL_MS = 25_000`，`unref`） | `skybridge/packages/server/src/routes/events.ts:8,43,45` |
| SDK 转发每帧 | `subscribeEvents` 把**每个**解析出的 block（`:ok`→`comment` / `ping` / `change`）先喂给可选 `onFrame`，错误隔离，再走 `onChange` | `skybridge/packages/client/src/client.ts:96-119`；**已装** `node_modules/@orpheus-aviary/skybridge-client@0.1.4/src/client.js:96-119` 确认转发存在 |
| SDK 自述用途 | `SubscribeHandlers.onFrame` 注释：「Use this for client-side idle watchdog: any incoming frame proves the stream is alive.」 | `client.d.ts:30-39`（已装版本一致） |

owl 自己的 `SseHandlers`（`session.ts:57-61`）目前只有 `onChange / onOpen / onError`，**没有声明也没有传
`onFrame`** —— 这是唯一缺口。

> **结论：owl-daemon-only。** 不动 skybridge，不发版，不 bump 任何包。

## 3. 设计

### 3.1 watchdog 语义

在 `createSseBridge` 闭包里加一个**单一 idle 计时器**，作为「连接还在喂帧」的活性证明：

- **arm（武装）**：`onOpen` 触发时启动计时器（连接刚建立）。
- **reset（喂狗）**：`onFrame` 触发时**清旧 + 重启**计时器（comment / ping / change 任一帧都算活性）。
- **fire（超时）**：计时器到点 = 在 `watchdogMs` 内一帧都没收到 → 判定连接假死，走**与 onError 同一条恢复路径**：
  1. `clearWatchdog()`（自身已 null）
  2. `unsubscribe?.()` **主动 abort 僵尸连接**（SDK `controller.abort()` → `closed=true`，僵尸的 onError 不会再触发，无双重恢复），置 `unsubscribe=null`
  3. `markOffline(new Error('SSE idle timeout: no frame in <ms>ms'))`
  4. `onErrorHook?.()`（拉起 health-probe，和显式断开一样争取更快恢复）
  5. `scheduleReconnect()`（沿用现有退避；`retryAttempt` 在上次 onOpen 已归零，故首次重连 = 2s）
- **clear（解除）**：在 `scheduleReconnect`（onError / subscribe-threw catch / idle-timeout 三条重连入口的**统一清点**）+ `stop()` 处清掉计时器；`handleIdleTimeout` fire 时自身先置 null。（实现把清点收敛到 scheduleReconnect 这一处 choke-point，避免 onError 内再写一遍——见 §10。）

`onChange` **不需要**单独喂狗：change 帧必先经 `onFrame`（SDK 是先 `onFrame(frame)` 再在内部 `onChange`），
所以 onFrame 一处喂狗即覆盖所有下行。

### 3.2 阈值

server ping = 25s。watchdog 取 **60s = 2 个 ping 周期（50s）+ 10s 余量**：

- 1 个 ping 漏掉（瞬时抖动 / GC / 短丢包）**不该**重连 —— 太激进会 churn。
- **连续 2 个 ping 缺失（50s）** 才强烈表明流死了。
- +10s 调度/时钟松弛 → 60s。

最坏检测延迟 ≈ `timeout + 距上一帧时间` ≈ 60~85s（流刚好在下一 ping 前死）。对后台同步 daemon 完全可接受，
对比现状（**永不恢复**）是质变。

常量 `SSE_IDLE_TIMEOUT_MS = 60_000` 写死在 `sse-bridge.ts`，仅暴露 `watchdogMs?` 注入给测试。

**显式不做（YAGNI）**：不在 `skybridge_config.toml` 加 `[sync].sse_idle_timeout_sec` 用户旋钮。
原设计「看真实数据再定阈值」是**调参决策**而非用户配置面；server ping 周期固定 25s，阈值由它推导，
不需要用户碰。若 0.6 真有人 NAT 超时 < 60s，再加旋钮成本极低。

### 3.3 不变量 / 边界

- **arm 仅在 onOpen 之后**：`connect()` 不 arm（还没连上）；`start()` 后未 onOpen 时无 watchdog。
- **僵尸回调惰性**：watchdog fire 里 `unsubscribe()` 让 SDK `closed=true`，僵尸连接的
  onOpen/onFrame/onChange/onError 全部失效 → **无需 generation 计数器**（沿用现有 `stopped`+`retryHandle` 去重风格）。
- **与 health-probe 协同不变**：watchdog 走 `onErrorHook` 拉起 probe；重连成功 onOpen 走 `onOpenHook` 停 probe。和显式断开路径完全一致，probe 行为零改动。
- **switch / 多 profile 安全**：watchdog 是 bridge 闭包内状态，`bridge.stop()` 清它；`stopBackgroundHandles`/Phase 14 switch 拆 bridge 时一并清，无泄漏、无跨 profile 串台。
- **timer unref**：默认 `setTimeout(...).unref()`，daemon 退出不被 watchdog 吊住。

### 3.4 状态机（文字版）

```
start() ─ connect() ──subscribe──▶ (waiting open)
                                      │ onOpen      → retryAttempt=0; markConnected; onOpenHook(stop probe); catch-up sync; ARM watchdog
   ┌──────────────────────────────────┤ onFrame     → RESET watchdog
   │                                   │ onChange    → runManualSync (watchdog 已由前置 onFrame reset)
   │                                   │ onError     → markOffline; onErrorHook(start probe); scheduleReconnect(→CLEAR watchdog)
   │                                   │ watchdog fire → null self; unsubscribe(abort zombie); markOffline; onErrorHook; scheduleReconnect
   └─ scheduleReconnect ─ (CLEAR watchdog) ─ backoff ─▶ connect() …
stop()        → stopped=true; unsubscribe; cancel retry; CLEAR watchdog
triggerReconnect() → cancel retry; connect()  (watchdog 由下次 onOpen 重新 arm)
```

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `packages/daemon/src/sync/session.ts` | `SseHandlers` 加 `onFrame?: (frame: SseFrame) => void`；新增本地最小类型 `SseFrame { event: string; data: string; id?: string }`（镜像 SDK，owl 鸭子类型不 import skybridge） |
| `packages/daemon/src/sync/sse-bridge.ts` | 新增 watchdog：`SSE_IDLE_TIMEOUT_MS` 常量、`SseBridgeOptions.armWatchdog?` + `watchdogMs?`、闭包内 `watchdogTimer` + `armWatchdog()/clearWatchdog()`、`onOpen` arm、新 `onFrame` reset、`onError` clear、新增 `handleIdleTimeout()`、`scheduleReconnect`/`stop` clear |
| `packages/daemon/src/sync/sse-bridge.test.ts` | `FakeRealClient` 捕获 `onFrame` + 加 `fireFrame()`；独立 `FakeScheduler` 给 watchdog；新增 6 个用例（见 §5） |
| `owl/CLAUDE.md` | sse-bridge debug 关键字补一行：`idle watchdog fired`（warn，`kind:'sse'`），方便真机 grep |

**不改**：health-probe.ts、bridge-lifecycle.ts、status-broadcaster.ts、manual.ts、scheduler.ts，以及 skybridge 任何文件。

## 5. 测试（单元，`sse-bridge.test.ts`）

`FakeRealClient` 扩展：`CapturedHandlers` 加 `onFrame?`；`fireFrame()` 调 `lastHandlers.onFrame?.({event:'ping',data:'{}'})`。
watchdog 用**独立** `FakeScheduler`（与 reconnect 的 `schedule` 分开），通过 `armWatchdog` 注入。

1. **onOpen arms watchdog** —— `start()`+`fireOpen()` → watchdog pending 1 个 @ `watchdogMs`。
2. **onFrame resets watchdog** —— `fireOpen()`→`fireFrame()` → 仍恰好 1 个 pending（旧的被 cancel，不是 2 个）。
3. **watchdog fire → 恢复路径** —— `fireOpen()` 后触发 watchdog cb → `unsubscribeCalls===1`、`onErrorHook` 调用、reconnect 退避 pending @ 2s、status 翻 `offline`。
4. **onError clears watchdog** —— `fireOpen()`（arm）→`fireError()` → watchdog pending 0（不会在退避期间残留误触发）。
5. **stop() clears watchdog** —— `fireOpen()`→`stop()` → watchdog pending 0。
6. **未 onOpen 不 arm** —— 仅 `start()` → watchdog pending 0；且 reconnect 后的 onOpen 能重新 arm（可并入用例 1 的二段）。

现有 14 个 sse-bridge 用例（backoff/reconnect/triggerReconnect/hooks）必须保持全绿——watchdog 不改它们的语义。

## 6. 验收

- `pnpm -r build`（单测跑 dist，先 build）
- `just check`（lint + typecheck + 8 守卫；biome formatter diff 当 error → 每 slice 后 `biome check --write` 收尾）
- `just test`：daemon 单测 **284 → 290**（+6）；core/cli/gui 不变
- `SKYBRIDGE_E2E=1 just test-skybridge-e2e`：**25/25** 不回归（真 server 25s ping，60s watchdog 在短 e2e 内永不触发；timer unref 不吊住进程；`bridge.stop()` 清狗）
- **owl 零生产代码以外改动**之外的 scope = 0（不动 skybridge/不发版/不 bump）

## 7. 真机验证（推荐，非阻塞）

单元测试已完整覆盖逻辑机制；真机用于确认「socket 不关但 server 静默」这一**真实假死**确实被 watchdog 接住。
最干净的复现 = **`kill -STOP` 暂停 server 进程**（socket 由 OS 保持打开、不发 FIN、ping 停发）：

1. 隔离 nest 起 standalone daemon（关 GUI + `just ensure-node-abi` 避 better-sqlite3 ABI 冲突），注会话连真 0.1.4 server，bridge `onOpen` 后稳态。
2. `kill -STOP <server-pid>` → server 暂停下发；`daemon.log` 约 60s 后应出现 `kind:'sse' ... idle watchdog fired` → `markOffline` → reconnect 尝试（server 仍暂停 → 连接失败 → onError 退避 + health-probe）。
3. `kill -CONT <server-pid>` → server 恢复 → 下一次 reconnect / probe 成功 → `sse connected` + onOpen catch-up sync。
4. 临时环境清理（`stop-daemon`，删 `/tmp/owl-pXX`，别用宽 pattern 误杀）。

> 真机可选：阈值临时降（`watchdogMs` 注入或临时改常量）缩短等待。若环境成本高，单测 + 机制已就位即可放行 GA，真机留可选 soak。

## 8. 切片与提交

单一 slice（~半天）：

- **S1**：§4 全部改动 + §5 测试 + §7（可选）真机。一次 commit。
  - commit：`feat(skybridge): add SSE idle watchdog for half-open connections`
    （scope `skybridge` 按 owl scope 字典；body 解释 WHY：补 onError 之外的下行假死洞，server 25s ping + SDK onFrame 已就位，client 侧 60s watchdog）。
  - CLAUDE.md 一行可并入同 commit 或单独 `docs`。

落本地 main，**不 push**（与 Phase 21 / UX 批一并到 Phase 23 统一 push）。

## 9. 与 0.5.0 GA 的关系

做完本项 → 0.5.0 GA 前**再无待决**。随后即 **Phase 22**（0.5.0 bump + release notes）→ **Phase 23**（三仓 push）。
release notes 可加一句：「后台同步连接假死自动检测重连（idle watchdog），不再需要手动同步兜底」。

## 10. 实施记录（2026-06-06 完成，单 slice，未 commit）

按 §3-§5 实现，零偏差。改动文件 4 个，**skybridge 零改动 / 无版本 bump**：

| 文件 | 实际改动 |
|---|---|
| `packages/daemon/src/sync/session.ts` | 新增本地类型 `SseFrame {event,data,id?}`（镜像 SDK，鸭子类型不 import skybridge）；`SseHandlers` 加 `onFrame?: (frame: SseFrame) => void`（注释标 since 0.1.4） |
| `packages/daemon/src/sync/sse-bridge.ts` | 文件头补 idle watchdog 说明；新增 `SSE_IDLE_TIMEOUT_MS = 60_000`（export）+ `SseBridgeOptions.armWatchdog?`/`watchdogMs?`；闭包加 `watchdogHandle` + `armWatchdog()`/`clearWatchdog()`/`handleIdleTimeout()`；`onOpen` arm、新 `onFrame` reset；clear 收敛到 `scheduleReconnect`（onError/catch/idle-timeout 三入口的统一 choke-point）+ `stop()`，`handleIdleTimeout` 先置自身 null |
| `packages/daemon/src/sync/sse-bridge.test.ts` | `CapturedHandlers` 加 `onFrame?`；`FakeRealClient.fireFrame()`；import `getSyncStatusBroadcaster`；新 describe「idle watchdog」6 用例（arm-on-open / onFrame-reset / fire→abort+恢复 / onError-clear / stop-clear / reconnect 重 arm），独立 `watchdogSched` FakeScheduler 注入 |
| `owl/CLAUDE.md` | sse-bridge debug 关键字段补 idle watchdog 一行（`idle watchdog fired` warn + 机制 + 阈值写死 + 设计稿指针） |

**关键实现细节**：`handleIdleTimeout` 先置 `watchdogHandle=null` 再 `unsubscribe?.()` abort 僵尸（SDK `controller.abort()`→`closed=true` 令僵尸回调惰性，无双重恢复、无 generation 计数器），随后 `markOffline` + `onErrorHook`（拉 probe）+ `scheduleReconnect`。`onChange` 不单独喂狗（change 帧必先经 `onFrame`）。默认 `armWatchdog = defaultSchedule`（setTimeout+unref）。**redundancy 清理（commit 内）**：clearWatchdog 原本 onError 与 scheduleReconnect 各写一次，收敛到 scheduleReconnect 单一 choke-point（三条重连入口都经它），onError 不再重复写。

**验收（whole-repo 全绿，2026-06-06）**：`pnpm -r build` → `just check`（lint + typecheck + 8 守卫；biome 仅 1 个 pre-existing `backoffFor` 非空断言 warning，无 formatter diff，零新增）→ `just test`：core **528** / daemon **290**(+6) / cli **137** / gui **399** → `SKYBRIDGE_E2E=1 just test-skybridge-e2e` **25/25**（真 server 25s ping，60s watchdog 短 e2e 内不触发；timer unref + `bridge.stop()` 清狗，无泄漏/无回归）。

**真机**：按拍板「可选/留 soak」**未做**；§7 的 `kill -STOP` 复现 rig 记在案，GA 前可选。

**提交**：code commit `d998d13` `feat(skybridge): add SSE idle watchdog for half-open connections`（含 session.ts / sse-bridge.ts / sse-bridge.test.ts / CLAUDE.md；redundancy 清理已 amend 进同一 commit）。docs（本设计稿 + PROCESS.md）单独 docs commit。均落本地 main 不 push，并入 Phase 23 统一 push。
