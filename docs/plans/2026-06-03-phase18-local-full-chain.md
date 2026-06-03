# Phase 18 — 本地全链路验证（per-profile model dual e2e）

> **状态**：v2 定稿（2026-06-03，1 轮 review 已纳：teardown/synced_at/登录序/switch 清会话/mkdir/`just build`/restartDaemonCtx helper；§10 三决策拍板）。父设计 `2026-05-29-account-profile-isolation-design.md`（v6，§11 路线第 18 行 / §13 W-items 权威）。
> **前置**：Phase 12-17 + 插队「多账号 add」全部落 main 已 push；调查起始时工作树干净；whole-repo 全绿（core 519 / daemon 283 / cli 134 / gui 385 / gated e2e 16/16）。
> **工作树状态**：本 plan 文件 + 后续 PROCESS.md 改动是 **untracked / 留工作树给用户**（[[feedback_process_doc_commit]]），不是 dirty 残留——验收"干净"指代码无未提交改动。

## 0. 一句话目标

§11 第 18 行：「本地全链路：just check/test + **dual e2e 跑 profile 模型**」。现有 `sync.dual.e2e.ts` 只跑 **in-memory core-engine**（push/pull/LWW/tags/folder/conversation/reminder），从不碰 toml / resolver / on-disk `profiles/<id>/owl.db` / daemon `POST /sync/switch`。Phase 18 **新增一个 gated e2e**，把 per-profile **存储+切换模型**的全链路串起来跑一遍真 skybridge server，封住"各组件单测都绿、但集成缝从未被自动化验证过"的风险，再整套跑绿，作为 Phase 19 真机部署前的本地闸。

## 1. 决策（已与用户拍板 2026-06-03）

| # | 决策 | 取舍 |
|---|------|------|
| Q1 | **新建** profile-model e2e 文件；保留 `sync.dual.e2e.ts` 原样不动；最后跑整套 | 现有 dual e2e 是宝贵的 core-engine 回归，不改写它 |
| Q2 | 链路上界 = **daemon `POST /sync/switch` 打真 skybridge server + core resolver/config 真 toml + 真 on-disk profile db**。GUI-main（`loginAndOpenSession`/快切/refresh 定时器）依赖 Electron safeStorage，headless node 跑不了 → 留单测 + Phase 19 真机 | headless 能自动化的最高层；正好补上唯一未被自动化的集成缝 |

## 2. 现状覆盖矩阵（调查结论）

| 层 | per-profile 覆盖现状 |
|---|---|
| **core** resolver / config R/W / `computeProfileId` / `deleteProfileDb` / `inspectLocalProfile` | ✅ 单测强：**真 fs + 真 toml + 真 on-disk profile db**（`resolver.test.ts` / `config.profile.test.ts` / `local-inspect.test.ts`） |
| **daemon** `switchProfile` / `POST /sync/switch` | ✅ 单测：真 on-disk db（`profile-switch.test.ts` / `sync.switch.test.ts`）—— 但**无真 skybridge server**、**无 toml resolver 集成**、**无 D10b 隔离断言** |
| **gui main** `loginAndOpenSession`/`switchToProfile`/快切/删除 | ✅ 单测**全 mock**（SDK/fetch/safeStorage/core writers 全 stub） |
| **`sync.dual.e2e.ts`** | ❌ `:memory:` + core engine，不碰 toml/resolver/on-disk profile db/`/sync/switch` |

**缺口（Phase 18 唯一目标）**：没有任何自动化测试把"真 toml `[profiles.X]`+`active_profile` → resolver → on-disk `profiles/<id>/owl.db` → daemon `POST /sync/switch` 打真 server → 重启重解析 → 快切 → 删除"**串起来**跑。

## 3. 测试基建（复用现成两块拼接）

1. **真 skybridge 0.1.4 server**：照搬 `sync.dual.e2e.ts` 的 `startSkybridgeServer()`（变量 specifier 导入 `@orpheus-aviary/skybridge-server`，in-process listen port 0，`createUser` 种账号）。
2. **真 daemon Fastify + 真 fs nest**：照搬 `sync.switch.test.ts` 的 `makeCtx(dbPath)` + `buildServer(ctx)` + `app.inject(...)`；`OWL_NEST_DIR=<tmp nest>`。
3. **GUI-main 的远端动作由 e2e 自己做**（login / registerDevice / ensureWorkspace 走 SDK client，变量 specifier 导入 `@orpheus-aviary/skybridge-client`），再把结果喂给 daemon —— 按 **daemon 可自动化链路顺序**（与生产 *daemon 侧* 一致，**不含** GUI claim / safeStorage / `restoreSessionOnStartup`）：
   - **首登**（fresh account，sync-auth.ts:200-211）：SDK registerDevice → ensureWorkspace（remote-only，不碰 daemon db）→ `POST /sync/switch {hex}`（daemon 建库，返回 device_id:null）→ `POST /sync/session`（装会话+起 bg handles）→ `writeProfileConfig(setActive)` 落 toml。
   - **回访**（profile db 已在，sync-auth.ts:189-195）：**switch 先**（`/sync/switch` 返回库里记住的 device_id）→ 复用 device → ensureWorkspace。
   - ⚠️ 不写"严格等同生产登录全序"——真实首登在 switch *前* 还有 claim 抉择（GUI/safeStorage，out of scope）。P1-P2 走首登序、P6 走回访序，两序都被覆盖。
4. **模拟 daemon 重启 = `restartDaemonCtx()` helper（统一必做序，避免实现时漏）**。helper 体（**每步都必做，不是"必要时"**）：
   - `ctx.scheduler.stop()` → `stopBackgroundHandles(ctx)`（清 sseBridge + syncScheduler，bridge-lifecycle.ts:234）→ **`await drainManualSync()`**（排空在飞 sync round）→ `app.close()` → `ctx.sqlite.close()`（= cli.ts:125-142 shutdown 序）→ **`__resetInflightSync()`**（manual.ts:375 清模块级 inflight Promise——防跨用例订阅/timer 打到已关闭 sqlite）。
   - 再用 `resolveActiveProfileDbPath()`（= cli.ts:66 boot 解析）重建 ctx + `buildServer(ctx)`，return 新 `{ctx, app}`。
   - **重启后无会话**（不测 `restoreSessionOnStartup`）；只验 resolver→db-path 缝，要再 sync 须重 `POST /sync/session`。
   - 同一 helper 也用于**最终 after() 收尾**（最后一次不重建，纯拆）。

### 边界（明确不做）
- **不**走 GUI-main `loginAndOpenSession` 真函数（Electron safeStorage 无法 headless）。toml 里 `encrypted_token` 存占位明文即可——daemon 从不读 `encrypted_token`（只 GUI main 读），resolver 只看 `active_profile`+section 存在+db 存在三闸。
- **不**测会话重启恢复（`restoreSessionOnStartup` 是 GUI main 职责）。P4 重启只验 **resolver→db-path** 缝；重启后如需再 sync 就再 `POST /sync/session`。
- **不** mock 任何 core/daemon 代码——全真。仅 SDK server/client 用变量 specifier 保 clean-checkout `tsc -b` 绿（沿用 dual e2e 既有手法）。

## 4. 文件 & 命名

- 新文件：`packages/daemon/src/sync/profile-chain.e2e.ts`
  - `.e2e.ts` 后缀 → `just test-daemon` 默认 `*.test.js` glob **不**命中；只 `just test-skybridge-e2e`（`test:e2e` glob `dist/**/*.e2e.js`）+ 运行时 `{ skip: !SKYBRIDGE_E2E }` 双闸命中（与 dual e2e 同款两层 gating）。
  - 不用 `.skybridge.e2e.ts` 后缀（该后缀只是描述性；gating 由 glob+env 决定，dual e2e 也打真 server 却用 `.dual.e2e.ts`）。
- `sync.dual.e2e.ts` **零改动**。

## 5. 测试旅程（顺序式 user journey，全 `SKYBRIDGE_E2E` gated）

> 顺序非隔离（同 dual e2e）：P2 建在 P1 之上，逐步推进。命名 P1-P9（profile-chain）。

> **fixture 前置**：`createDatabase` 直接 `new BetterSqlite3(dbPath)`，**不**建父目录（db/index.ts:43）。setup 必须先 `mkdirSync(paths.owlDir(), {recursive:true})`（沿用 sync.switch.test.ts beforeEach）。
> **横切不变量**：**每次 `/sync/switch` 后 `ctx.skybridgeSession` 被清空**（profile-switch.ts:62 COMMIT），`/sync/run` 会 401 直到重 `POST /sync/session`。下表凡 switch 后要跑 sync 的步骤都显式重装会话。

| 用例 | 动作 | 关键断言 |
|---|---|---|
| **P0 local 基线** | `mkdirSync(owlDir())` → boot ctx via `resolveActiveProfileDbPath()`（无 toml/active_profile）→ 应解析到 `owl/owl.db`。core 种 1 条 local 笔记 | resolver → `localProfileDbPath()`（==`dbPath()`）；local 笔记落 `owl/owl.db`（建库即产生 1 条 **pending** sync_changes，`synced_at IS NULL`——正常） |
| **P1 首登远端 bootstrap** | `createUser(A)` → SDK login → **`serverId` 直接取 `auth.serverId`**（sync-auth.ts:167-171；R5：缺失即 `ServerTooOldError`，`getServerInfo()` 仅可选做一致性断言）→ `profileId=computeProfileId(auth.serverId, auth.user.id)` → SDK registerDevice + ensureWorkspace（**remote-only，不碰 daemon db**） | login 拿到 token/refresh/`auth.serverId`；device + workspace 建于 server；daemon db 此刻**未动**（仍 local） |
| **P2 switch 建库 + 装会话 + 落 toml**（首登序） | `POST /sync/switch {profile_id:<hex>}` → `POST /sync/session {token,user_id,email,server_url,device,workspace}` → `writeProfileConfig(<hex>, {server_id,server_url,user_id,email,encrypted_token:'<非密占位>',device,workspace}, {setActive:true})` | `/sync/switch` 200 + `device_id:null`（fresh db）+ 建 `profiles/<id>/owl.db`；`/sync/session` 200 装好会话+起 bg handles；toml 有 `[profiles.<hex>]`（server_id 锚 + device + workspace）+ `active_profile=<hex>` |
| **P3 push 隔离（D10b 铁证）** | core 在 active profile 库（`ctx.db`/`ctx.sqlite`）建 1 条账号笔记 → `POST /sync/run` | 账号笔记落 `profiles/<id>/owl.db` 且 push 成功（profile 库该行 `synced_at IS NOT NULL`）；**`owl/owl.db`（local）从未被账号同步**——**语义断言**：local 笔记数 == P0（不变）、无账号笔记、**无任何 `synced_at IS NOT NULL` 行**、无 `sync_cursor` 行、`local_metadata` 无 skybridge device/workspace 绑定（D10b 不写 local）；server change-log 收到该账号笔记（普通笔记上行，特殊笔记不推） |
| **P4 重启 resolver 拾取** | `restartDaemonCtx()`（§3.4 helper）→ 新 ctx 经 `resolveActiveProfileDbPath()` 重建 + `buildServer` | resolver 三闸（hex + section 存在 + db 存在）→ 开 `profiles/<id>/owl.db`；ctx 库含账号笔记、**不含** local 笔记（集成缝核心）。重启后无会话（不测 restore） |
| **P5 快切 local** | `POST /sync/switch {profile_id:local}` + `setActiveProfile(LOCAL_PROFILE)` | ctx 切到 `owl/owl.db`（local 笔记在、账号笔记不在）；switch 已清会话；`restartDaemonCtx()` → resolver → local |
| **P6 快回 profile + device 复用（W4/§5.3，回访序）** | `POST /sync/switch {profile_id:<hex>}` + `setActiveProfile(<hex>)` →（验 sync 可用）重 `POST /sync/session`（带返回的 device_id）→ `POST /sync/run` | `/sync/switch` 返回的 `device_id` == P2 注册的 device（**复用，非新建**）；ctx 切回 profile 库、账号笔记在；重装会话后 `/sync/run` 200；**server 仍 1 device 不堆积**（listDevices==1，复用证据） |
| **P7 第二账号（多账号 add，must-have）** | `createUser(B)`（**P7 前先建第二用户**）→ SDK login B → 第二 profileId → switch+session+toml（首登序）→ core 在 B 库建一条 **marker note**（区别 A 笔记） | 两 `[profiles.X]` 段共存 + 两 profile 库；A↔B 切换各看各的笔记（切到 A 看 A note、切到 B 看 B marker；每次 switch 重装会话）；`listProfiles()` 返回两行 |
| **P8 删除账号 A 副本 + ghost 断言（含 P9）** | **P7 后先切回 A**（switch A + setActive A）→ switch local 释放句柄 → `deleteProfileDb(A)` + `removeProfile(A)` | A 库 db/wal/shm 全删；A 的 toml 段移除、`active_profile=local`；**B 的 toml 段 + B 库仍在**（sibling 不误删，最清晰断言）；`owl/owl.db` 原样；**ghost 防复活（P9 折入）**：删后 `readEffectiveActiveProfileId()` 回 local、`listProfiles()` 不含已删 A（不复活） |

**must-have**：**P0-P8 全部**（核心全链路 + D10b + 重启拾取 + device 复用 + 第二账号/多账号 add 存储层 + 删除生命周期 + ghost 防复活薄断言）。**P7 已纳入 must-have**（不再 stretch；第二账号是多账号 add 存储模型的真实端到端覆盖）。
**P9（ghost 防复活）不单独成 journey**：resolver/config 单测已实，standalone 收益不大 → **折进 P8 删除后顺手断言**（见 P8 行）。

## 6. 不变量断言清单（旅程横切）

- **D10b**：账号同步**永不写** `owl/owl.db`（P3 **语义**核验：local 笔记数不变、无账号笔记、无 `synced_at IS NOT NULL` 行、无 `sync_cursor`、无 skybridge device/workspace 绑定。注意 `synced_at` nullable——pending=`IS NULL`，建本地笔记本就产 1 条 pending，不是污染）。
- **switch 清会话**：每次 `/sync/switch` COMMIT 置 `ctx.skybridgeSession=null`（profile-switch.ts:62）；switch 后要 sync 必重 `POST /sync/session`（P6 显式验）。
- **resolver 三闸**：active=hex + `[profiles.<id>]` 段在 + profile db 在，缺一回退 legacy（P4/P5 重启验）。
- **device 复用（W4/§5.3）**：再切回已存在 profile，`/sync/switch` 返回库里记住的 `skybridge_device_id`，不新注册（P6）；server `listDevices` 仍 1 不堆积。
- **toml 段生命周期**：write/setActive（P2）→ remove + deleteProfileDb（P8）；sibling profile 不被误删（P7+P8）。
- **switch gate**：复用 `sync.switch.test.ts` 已覆盖（自死锁豁免 + 503）；本 e2e 不重复。

## 7. 验收（whole-repo，照历史每 Phase 口径）

```bash
cd .../owl
just build                          # build-core/daemon/gui/cli；e2e import dist 须先 build
just check                          # lint + typecheck + 8 守卫
just test                           # core 519 / daemon 283 / cli 134 / gui 385（单测数不变——e2e 独立 gated）
just test-skybridge-e2e             # recipe 自带 build-daemon + SKYBRIDGE_E2E=1（justfile:269-270，无需外层 env）；16 → 16+N（N=本 e2e 用例数）全绿
```

PROCESS.md 记录最终计数 + 新 e2e 用例数。

## 8. 风险 & 注意

- **`writeProfileConfig(setActive)` 的 db 存在闸**：必须 switch（建库）→ session → writeProfileConfig 顺序，否则 `ProfileDbMissingError`（生产同序，§5.4.1）。
- **server_id 来源**：0.1.4 SDK `login` 响应 / `getServerInfo()` 给 `serverId`；R5 硬要求，缺失报错不回退 url-key。e2e 从 login 响应抓。
- **clean-checkout typecheck**：SDK server/client 必须变量 specifier 导入（不出现在 `import` 语句字面量），结构 interface 只声明用到的字段——照搬 dual e2e 既有 `SkybridgeServerModule`/`SkybridgeClientModule`。
- **background-handle 泄漏打到已关闭 sqlite**（reviewer 重点）：`/sync/session` 起 SSE bridge + sync scheduler，SSE onOpen/onChange 会触发 `runManualSync`（sse-bridge.ts:89）。重启/收尾若只 `app.close()+sqlite.close()` 会留订阅/timer 打到已关闭库 → 必按 §3.4 序：`scheduler.stop()` → `stopBackgroundHandles(ctx)` → `await drainManualSync()` →（收尾）`__resetInflightSync()` → `app.close()` → `sqlite.close()`。
- **顺序式脆弱性**：单 describe 内 before/after 起停 server + nest；profile switch 会 close 旧 sqlite，收尾 `try{sqlite.close()}catch{}`（沿用 sync.switch.test.ts）。
- **不碰 `#真实` 笔记**；清理 kill 进程别用宽 pattern 误杀（[[reference_skybridge_dev_workflow]]）。

## 9. 切片 & 提交

- **18（单片）**：新增 `profile-chain.e2e.ts`（must-have P0-P6+P8，stretch P7/P9 视 review）→ 整套验收 → 1 commit。
- scope：`feat(skybridge)` 或 `test(skybridge)`（review 定；纯加 e2e 倾向 `test`）。
- **提交前必向用户确认**（CLAUDE.md「YOU MUST confirm before committing」）。代码 commit 落 main（push 与否由用户定）；**PROCESS.md + 本 plan 留工作树给用户**（[[feedback_process_doc_commit]]）。commit trailer = `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## 10. 决策（已拍板 2026-06-03，review 后）

1. **P7 纳入 must-have**（第二账号 = 多账号 add 存储层真实端到端，比 P9 更有价值）；**P9 不单独成 journey**，折进 P8 删除后薄断言（`readEffectiveActiveProfileId()`→local、`listProfiles()` 不复活已删 A）。
2. **commit scope = `test(skybridge)`**（纯加 gated e2e，不改生产行为）；**提交前仍向用户确认**。
3. **文件名 = `profile-chain.e2e.ts`**（测整条 profile chain：toml/resolver/on-disk db/switch/session/delete，非仅 sync engine）。

## 11. 实施记录（2026-06-03 完成）

**文件**：`packages/daemon/src/sync/profile-chain.e2e.ts`（~390 行，单片）。`sync.dual.e2e.ts` 零改动。

**用例**：P0-P8 共 **9 个**（P9 ghost 防复活折入 P8）。全部按设计旅程：
- P0 boots-on-local + 种 local note；P1 首登远端 bootstrap（A，register+workspace，daemon db 未动）；P2 switch 建库 + `/sync/session` + `writeProfileConfig(setActive)`；P3 push 隔离 + **D10b 语义铁证**；P4 `restartDaemonCtx()` → resolver 拾取 A；P5 快切 local + 重启；P6 快回 A + **device 复用**（switch 返回 device_id===A.device.id）+ 重装会话 + `/sync/run` + `listDevices()===1`；P7 第二账号 B 共存 + 各看各笔记 + `listProfiles()` 两行；P8 删 A 副本（先切 local 释放句柄）+ B/local 完好 + ghost 不复活。

**验收（whole-repo 全绿）**：`just build` → `just check`（typecheck + 8 守卫）→ `just test`（core **519** / daemon **283** / cli **134** / gui **385**，**单测数全不变**——e2e 独立 gated）→ `just test-skybridge-e2e` **16 → 25（+9）**。9 个新用例全过。

**踩坑/约定（carry-forward）**：
- **session.ts 的 `SkybridgeClientModule.login` 只声明 `{serverUrl,token,user}`**（daemon 从不登录）→ e2e 自声明 richer `E2EClientModule`/`E2EAuthContext`（加 `serverId`/`refreshToken`/`expiresAt`），`auth.serverId` 取自 0.1.4 `login` 响应（`ApiLoginResponse`）。
- **`restartDaemonCtx()` helper** 统一拆/重建序（每步必做）：`scheduler.stop()` → `stopBackgroundHandles(ctx)` → `await drainManualSync()` → `app.close()` → `sqlite.close()` → **`__resetInflightSync()`** → `resolveActiveProfileDbPath()` 重建 + `buildServer`。after() 收尾复用（不重建）。**无此序则 SSE bridge 订阅/sync timer 打到已关闭 sqlite**。
- **D10b** 用 `probeLocalDb()`（独立打开 `owl/owl.db` 探针，用完即 close——此时 daemon ctx 在 profile 库，local 无并发句柄）断言**语义**：local note 在、account note 不在、`synced_at IS NOT NULL`=0、`sync_cursor`=0、`local_metadata` 无 `skybridge_device_id`/`skybridge_workspace_id`。**不是** `synced_at=0`（nullable，pending=`IS NULL`，建本地 note 本就产 1 条 pending）。
- **`SkybridgeDeviceSection` 必填 `app_version`+`client_version`**（写 toml section 时补）；`SkybridgeWorkspaceSection` 必填 `slug`（默认 `'default'`）。
- `createDatabase` **不** mkdir 父目录 → setup `mkdirSync(paths.owlDir(),{recursive:true})`（沿用 sync.switch.test.ts）。
- 顺序式（单 describe，before 起 server+nest+createUser(A)+load client，P7 内 createUser(B)）；每次 `/sync/switch` 清会话（profile-switch.ts COMMIT），P6 显式重 `/sync/session` 才 `/sync/run`。
- **SSE bridge flake 风险**：install session 后 bridge 活跃，跑 `/sync/run` 与 bridge onChange 经 `drainManualSync` 合并；首跑全绿，未见 flake。
- format：`pnpm exec biome check --write <file>`（既有 53 条 repo-wide warning 不 fail）。commit scope = **`test(skybridge)`**（纯加 gated e2e）。
