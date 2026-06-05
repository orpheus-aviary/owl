# Phase 21 — CLI compat 收尾 + W10 switch lockfile + GUI 切换并发安全

> 设计稿父文档：`2026-05-29-account-profile-isolation-design.md`（v6，§11 行 21 + §13 W10）。
> 前序：Phase 19（部署+promote latest+smoke）、Phase 20（W12/网络/W3）已完成。
> 0.5.0 发版前最后一个 **代码** 收尾 Phase（之后 22=bump+release，23=push）。
> v3（2026-06-06）：纳入用户两轮 review。新增 GUI 切换互斥队列 + refresh 防污染 + 单实例锁 + lockfile heartbeat/owner-token。

## 0. 决策总账（2026-06-05/06 与用户拍板）

| # | 决策 | 选择 |
|---|------|------|
| Q1 | CLI sync 表面范围（登录架构上不可行） | 保持现状：CLI = 笔记 + 观察同步。仅修 `sync login` → 跳转提示「请在 GUI 登录」 |
| Q2 | W10 防护范围 | 完整：GUI 持锁全程（critical-section 精确 + heartbeat，见下） |
| Q3 | sync login 选项兼容 | 保留 `--email`/`--server-url` 注册但忽略；`email?: string`；只删内部死代码 |
| Q4 | 并发顶层切换串行化 | **GUI 切换互斥队列**（async mutex 串行 login/logout/switch/delete + refresh + restore） |
| Q5 | lockfile 单一持锁者证明 | **单实例锁 + owner-token**：加 `app.requestSingleInstanceLock()` + lockfile 带 nonce，release 只删自己的 |
| Q6 | lock staleness | **heartbeat**：GUI 持锁期每 ~10s 刷 `started_at`，CLI TTL 30s；活切换永不误判 stale，crash ≤30s 自愈 |
| Q7 | refresh 防污染（review P1） | refresh + restore 走同一 switch mutex，body 内新鲜读 config → 永远操作当前 active profile |

## 1. 背景与现状（调查结论）

### 1.1 `authenticated` cosmetic
`manual.ts:324` `Boolean(config?.auth?.token)` 读 legacy 顶层明文，per-profile 恒 false。`assembleConfig`（`config.ts:288-299`）只在任一凭证存在时装配 `config.auth` → **`config?.auth != null` 才对**。仅 `owl sync status` CLI 输出受影响（renderer `sync-status.ts:111` 丢弃此字段）。

### 1.2 CLI `sync login` 已死
`/sync/login` Phase 6 退役。`runSyncLogin` 仍 prompt + `POST /sync/login` → 404。description / `config show` 错误（`sync.ts:248`）引用过时登录。

### 1.3 core 默认错误文案残留
`config.ts:188`（`SkybridgeNotConfiguredError`）+ `:203`（`SkybridgeAuthRequiredError` 默认）硬编 `run "owl sync login"` → 改向 GUI。

### 1.4 `--db` 文案
`config.ts:46` 默认走 `resolveActiveProfileDbPath()`（active profile 库），`--db` 是 escape hatch（可指任意库）。help 文案点明。

### 1.5 W10 + 并发：三层防护（关键，含两轮 review）
三件正交的事，分清：

| 层 | 解决什么 | 范围 | 机制 |
|---|---|---|---|
| **A. 单实例锁** | 两个 GUImain 进程并存 → 两 orchestrator / lockfile 互相覆盖（review P1） | 进程级 | `app.requestSingleInstanceLock()`（owl 现无），第二实例聚焦已有窗口后退出 |
| **B. 切换互斥队列** | 同进程内两个顶层切换/refresh 交错写 toml/session（review P1 + Q4） | GUI 进程内 | 模块级 async mutex `runSwitchExclusive`，串行 login/logout/switch/delete + **refresh/restore** |
| **C. W10 lockfile** | CLI direct 在切换窗口打开被切走/swap 中途的库 | 跨进程（GUI↔CLI） | GUI 在 **critical section** 写带 nonce + heartbeat 的 lockfile；CLI direct 读并尊重 |

**hazard window（lockfile，review P2）**：仅 `daemon active db ≠ toml active_profile` = **首个 `postSyncSwitch` → `writeProfileConfig(setActive)`，含 unwind `rollbackToPrior`**。`loginAndOpenSession` 首个 `postSyncSwitch`(192/209) **之前** 的远程 login/register/ensureWorkspace + `maybeClaimLocalInto` **用户 prompt**(207) **不进 lockfile**（idle 用户不持锁）。

**层 B vs C 嵌套**：mutex（外，包整个函数含 prompt，纯 GUI 内）⊃ lockfile（内，仅 critical section，跨进程）。prompt 期间持 mutex（只挡 GUI 内其它编排，无妨）但 **不持 lockfile**（CLI direct 此时无 db 分歧，不该被挡）。

**refresh 污染（review P1）**：`refreshSession`(574) 读 config→HTTP→`persistRotated`(updateActiveProfileAuth)+`postSyncSession`，全程无 mutex。`clearRefreshTimer` 挡不住已在跑的 refresh，也挡不住 focus/resume 的 `maybeRefreshNow`。切换中旧账号 refresh 回来 → 把旧 token 写进新 profile / 旧 session 装进新 db。现有注释（`sync-auth.ts:301-304`）已承认此隐患但只用 clearRefreshTimer 兜，不全。→ 走 mutex + body 内新鲜读 config 根治（refresh 不 swap db，故 **不碰 lockfile**，只走 mutex）。

**lock TOCTOU（review P1）**：`buildContext`→`resolveConfig` 早早解析 dbPath（config.ts:46），晚于 lock 检查 → 先读旧路径锁后失效仍开旧库。→ direct-open 收进紧凑 bracket + 新鲜重解析。

## 2. 任务切分（3 commit）

### 21a — cosmetic + CLI sync login redirect + 文案（小、无跨切）

- **daemon** `manual.ts:324`：`Boolean(config?.auth?.token)` → `config?.auth != null` + `sync.test.ts` 用例。
- **core** `config.ts:188`/`:203` `run "owl sync login"` → 「请在 owl GUI（设置 → 同步）中登录」；grep 同步消息断言测试。
- **cli**：
  - `runSyncLogin` 立即抛 `CliError('USAGE_ERROR', '登录请在 GUI「设置 → 同步」中完成；CLI 不支持登录（需 GUI 钥匙串加密）')`；删 prompt + `POST /sync/login`；删 `readPasswordSilently` + `SyncCommandEnv.readPassword`（确认仅 login 用）。`SyncLoginFlags.email` 改 `email?: string`，保留 serverUrl（接住被忽略选项）。
  - `runSyncConfigShow` 错误 `:248` → 「请在 GUI（设置 → 同步）中登录」。顶部 docstring 更新。
  - `index.ts`：`sync login` `.description()` → 「(removed) login is GUI-only」；`--email` `requiredOption`→`option`；`--db` help `:104` → 「override sqlite db path (escape hatch; default resolves the active profile db)」。
  - `lib/config.ts:17` doc comment 同步。
  - 测试：`sync.test.ts` login → 抛 USAGE_ERROR + 零 fetch；`config.test.ts` 默认/`--db` 兼容回归。

### 21b — GUI 切换并发安全：互斥队列 + refresh 防污染 + 单实例锁（层 A+B）

> 不含 lockfile（21c）。本 commit 后：GUI 内切换/refresh 已串行、单实例已强制，CLI direct 仍是 pre-21 行为（W10 留 21c 关）。树绿。

- **gui main 切换互斥队列（层 B）**：`sync-auth.ts` 模块级 `let switchQueue: Promise<unknown> = Promise.resolve()` + `runSwitchExclusive<T>(fn)`（仿 `switch-gate.ts:88-101`：`const run = switchQueue.then(() => fn()); switchQueue = run.catch(()=>undefined); return run`）。
  - 包：`loginAndOpenSession` / `logout` / `switchToProfile` / `deleteProfileLocalCopy` / `refreshSession` / `restoreSessionOnStartup`（提 `*Impl` 内层 + 外层 wrapper，覆盖所有 caller 含测试/timer/IPC）。
  - **非重入**：逐函数核对调用图，确保被包函数内部 **不再** 调用任何被包函数（否则 plain promise-chain mutex 自死锁）。已知：refresh/restore 用 inline refresh 逻辑、不互调；switch 函数的 rollback 走 `postSyncSwitch`/`scheduleRefresh`（非被包函数）。impl 时再确认 `restoreSessionOnStartup` 不调 `refreshSession`。
- **refresh 防污染（层 B / Q7）**：`refreshSession` body 在 mutex 内已新鲜 `safeReadConfig()`（575）→ HTTP→persist→install 对同一当前 profile 原子。`maybeRefreshNow` 的 freshness 早退在 mutex 外（廉价），命中才进 `refreshSession`（mutex 内）。
- **单实例锁（层 A）**：GUI main 入口加 `if (!app.requestSingleInstanceLock()) { app.quit(); return }` + `app.on('second-instance', () => 聚焦已有窗口)`。位置：`packages/gui/src/main/index.ts` whenReady 之前。
- 测试：`sync-auth.test.ts`——(a) 两并发切换被 mutex 串行不交错；(b) 切换中 refresh 入队、不污染（新 profile 不被写旧 token）；(c) refresh 与 switch 串行。`index` 单实例锁分支单测（mock app）。

### 21c — W10 switch lockfile：core 模块 + GUI critical-section + CLI bracket（层 C）

- **core 新 `skybridge/switch-lock.ts`**（纯 Node，无 timer，易测）：
  - 格式 JSON `{ pid, started_at, nonce }`。
  - `writeSwitchLock(nonce)`：**atomic**（写 `${path}.tmp.${pid}` 再 `renameSync` 覆盖）`{pid: process.pid, started_at: Date.now(), nonce}`。
  - `touchSwitchLock(nonce)`：当前文件 nonce 匹配才 atomic 重写 `started_at=Date.now()`（否则 no-op）。
  - `releaseSwitchLock(nonce)`：当前文件 nonce 匹配才 `unlink`（否则 no-op；review P1 owner-token）。
  - `readSwitchLock(): SwitchLock | null`：读 + **shape 校验（review P1）**——`pid`/`started_at` 须 `Number.isInteger && >0`、`nonce` 须非空 string，否则（含 `{}`/坏 JSON/缺失）→ `null`。绝不让裸值进 `process.kill`。
  - `isSwitchLockActive(lock)`：`pidAlive(pid) && (Date.now()-started_at) < TTL_MS`。`pidAlive`：`process.kill(pid,0)`，`ESRCH`死/`EPERM`活。`TTL_MS=30_000`（配 heartbeat 10s）。
  - `paths.ts` 加 `switchLockPath()` → `join(owlDir(), 'profile-switch.lock')`。
  - 导出 `readSwitchLock`/`isSwitchLockActive`（CLI 用）+ write/touch/release（GUI 用）。
  - 测试 `switch-lock.test.ts`：atomic round-trip；坏 JSON/`{}`/负 pid/空 nonce→null；nonce 不匹配 release/touch no-op；死 pid→inactive；超 TTL→inactive；活+新鲜→active。
- **gui main critical-section 持锁 + heartbeat（层 C / Q6）**：`sync-auth.ts` helper
  ```
  function startSwitchLock(): () => void {
    const nonce = randomUUID(); writeSwitchLock(nonce);
    const iv = setInterval(() => touchSwitchLock(nonce), 10_000); iv.unref?.();
    return () => { clearInterval(iv); releaseSwitchLock(nonce); };
  }
  ```
  - 在每个 switch 函数的 **首个 `postSyncSwitch` 之前** `const releaseLock = startSwitchLock()`，外层 `finally` `releaseLock()`（覆盖成功 toml 写 + unwind rollback）。**仅 switch 函数**（refresh/restore 不持 lockfile，不 swap db）。
  - `loginAndOpenSession`：claim/register/ensureWorkspace 在锁外；handle 在两分支首个 `postSyncSwitch`(192/209) 前 acquire；try/finally 包到 265（return-visit 分支 swap 后的 reuse/register/ensureWorkspace 天然在锁内，确属 hazard window）。
  - 测试 `sync-auth.test.ts`：lock 写于 critical section、成功/抛错都 release、claim prompt 期间未持锁、heartbeat touch 被调。
- **cli 紧凑 bracket + 新鲜重解析（层 C / review P1）**：
  - `errors.ts`：加 `SWITCH_IN_PROGRESS` → `EXIT_CODES.CONFLICT`。
  - direct-open（`resolveBackend` direct 分支，注入 `resolveDbPath` thunk 供测）：
    ```
    if (explicitDb !== undefined) open(explicitDb)        // --db 指名库 → 不 gate（避免误拒 local/非 active）
    else {
      assertNoActiveSwitch()                              // 早拒
      const dbPath = resolveDbPath()                      // 新鲜重解析（不信 config.dbPath 早解析）
      assertNoActiveSwitch()                              // 复检解析期间起的 switch
      open(dbPath)
    }
    ```
    `assertNoActiveSwitch` = `isSwitchLockActive(readSwitchLock())` 真 → 抛 `CliError('SWITCH_IN_PROGRESS', 'GUI 正在切换账号，请稍后重试')`。`config.dbPath` 仍早解析，仅供展示/doctor。
  - 测试 `resolve.test.ts`：默认 direct + active lock → SWITCH_IN_PROGRESS；默认 + stale/无 → 正常；**显式 `--db` + active lock → 仍开**；http → 不检查。

## 3. 不变量 / 边界

- **三层正交**：A 单实例（进程级）/ B mutex（GUI 内，包整函数含 prompt）/ C lockfile（跨进程，仅 critical section + heartbeat + nonce）。
- mutex ⊃ lockfile：prompt 持 mutex 不持 lockfile（CLI direct 此时无分歧不被挡）。
- refresh 走 mutex 不碰 lockfile（不 swap db）。
- lock 只 gate 默认解析 direct open；显式 `--db` 不 gate。
- lockfile 写必 atomic（temp+rename）→ CLI 永不读到 torn 文件。
- owner-token nonce → release 只删自己的；单实例锁 → 坐实单一持锁者。
- 活切换 heartbeat 刷新 → 永不误判 stale；crash（pid 死）立即放行 / heartbeat 停 ≤30s 放行。
- lockfile 只含 pid/started_at/nonce，无凭证 → 不触 redact/token 守卫。
- daemon 不读不写 lockfile（保持 Phase 10 不变量；HTTP 路径用 switch-gate 503）。
- CLI 遇 stale lock 只 **忽略**（不 unlink；下次 GUI acquire 覆盖）。
- 残留窗口：CLI 第二次 check 与 `open()` 间微秒缝隙不可消（完美互斥需 CLI 也持 GUI 尊重的锁，0.5.0 外）。

## 4. 验收（whole-repo 全绿）

```bash
pnpm -r build
just check          # lint + typecheck + 8 bash 守卫
just test           # core / daemon / cli / gui
```
- 基线（Phase 18 后）：core 519 / daemon 283 / cli 134 / gui 385，随新测试增长。
- gated e2e 25/25 结构不变。
- 手测（可选）：GUI 切换瞬间另一终端 `owl create --direct`（无 --db）→ SWITCH_IN_PROGRESS；完成后重试成功；`--db <explicit>` 切换中不被拒；第二次启动 GUI 聚焦已有窗口。

## 5. 风险

- **mutex 自死锁**：被包函数内部不得再 `runSwitchExclusive`；逐函数核对调用图（尤其 restore 不调 refreshSession）。
- **acquire 点放错**（包进 prompt 或漏 unwind rollback swap）→ §2 21c 已列每函数点，impl 逐一核对。
- **torn read**：靠 atomic temp+rename 杜绝；测试覆盖。
- mutex 持锁期含 claim prompt（分钟级）→ 只挡 GUI 内编排（可接受；refresh 此时本就该等）。
- `process.kill(pid,0)` 跨用户 EPERM 误判活（同机同用户基本不触发）。
- core 文案改动命中消息断言 → grep 同步。
- 单实例锁改变第二次启动行为（聚焦而非新开）→ release notes 提一句。

## 6. 提交 / 后续

- 三 commit：21a（`cli`/`daemon`/`config`）、21b（`gui`）、21c（`skybridge` 跨 core+gui+cli）。
- 「分步提交」时只提代码，PROCESS.md 留工作树（feedback memory）。
- **不在本 Phase**：ConflictsPage「复制输方内容」按钮（feature A，与本 Phase 无关）。
- Phase 21 完 → 22（0.5.0 bump + release notes：附件 local-only/W11、提醒仅 active/W5、W12 恢复指引、单实例锁行为）→ 23（PROCESS/brief + 三仓 push clean）。

## 7. 实施记录（2026-06-06 完成，待提交）

三 slice 全实现 + 全绿。**owl 工作树未提交**（等用户确认）。

**21a — cosmetic + CLI sync login redirect + 文案**
- daemon `manual.ts:324` `authenticated: config?.auth != null`（+ `sync.test.ts` 加 encrypted_token-only 回归用例）。
- core `config.ts:188`/`:203` `owl sync login` → 「log in via the owl GUI (Settings → Sync)」。
- cli `commands/sync.ts`：`runSyncLogin` 立即抛 USAGE_ERROR 跳转提示；删 `readPasswordSilently`+`readPassword`+`/sync/login` POST；`SyncLoginFlags.email?`；`config show` 错误文案；docstring。`index.ts`：login description + `--email` 改 option + `--db` help。`lib/config.ts` doc。
- cli 测试：login describe 改 2 用例（抛 USAGE_ERROR + 零 fetch）；`config.test.ts` 加默认 active-profile 解析回归 + 401 fixture 去 `owl sync login`。

**21b — GUI 切换并发安全（层 A+B）**
- `sync-auth.ts`：模块级 `runSwitchExclusive` 互斥队列 + `__resetSwitchQueueForTests`；包 6 函数（login/logout/switch/delete + refresh + restore，各拆 `*Impl`）。refresh 防污染 = 走 mutex + body 内新鲜读 config。
- 新 `single-instance.ts`（`acquireSingleInstanceLock`）+ `index.ts` 入口 acquire + `whenReady` guard。
- 测试：`single-instance.test.ts`（5）+ `sync-auth.test.ts` mutex 序列化（2）。

**21c — W10 switch lockfile（层 C）**
- core 新 `skybridge/switch-lock.ts`（atomic temp+rename / nonce owner-token / shape 校验 / pidAlive+TTL 30s）+ `paths.switchLockPath()` + index 导出 + `switch-lock.test.ts`（9）。
- gui `acquireSwitchLockFile()`（nonce + 10s heartbeat，unref）；包 4 个 switch 函数的 critical section（首 postSyncSwitch→toml，含 unwind；claim prompt 在锁外）。测试经 callLog 验「copy→lock→switch→unlock」+ 失败路径 release 平衡。
- cli `errors.ts` `SWITCH_IN_PROGRESS`→CONFLICT；`resolve.ts` 抽 `resolveDirectDbPath`（显式 --db 不 gate / 默认 assertNoActiveSwitch→新鲜重解析→复检）；`resolve.test.ts`（4）。

**最终基线（全绿）**：`just build` + `just check`(lint+typecheck+8 守卫) + core **528**(+9) / daemon **284**(+1) / cli **137**(+3) / gui **392**(+7) + gated e2e **25/25**。

**踩坑**：① daemon/core 单测跑 dist → 改 src 后必 `just build-daemon`/`build-core` 才生效（21a daemon 一度显示旧 283）。② biome `check` 把 formatter diff 当 error → 每 slice 后 `biome check --write` 收尾。③ gui 测试 mock `@owl/core` → 新增 `newSwitchLockNonce`/`writeSwitchLock`/`touchSwitchLock`/`releaseSwitchLock` stub（经 callLog 验序）。④ 既有 callLog 精确断言（claim 2 用例）顺势升级为含 lock/unlock 的更强序断言。

**待办**：手测清单（见下）→ 用户确认 → 提交三 commit → 22（0.5.0 bump）→ 23（push）。
