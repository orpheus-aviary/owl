# 开发进度

## 当前阶段：**🎉 0.6.4 已发版（2026-08-27）→ Stage 2 收尾**

0.6.4 = 设备列表按工具过滤 + 折叠已撤销 + 登录自愈（下一节）。**无 migration**，协议不变，
可与 0.6.3 混用。dmg + `@orpheus-aviary/owl-server@0.6.4` + `@orpheus-aviary/owl-cli@0.6.4`
（⚠️ CLI 发布名带 scope）。说明见 `docs/history/0.6.4-release-notes.md`。

## 上一阶段：**🎉 0.6.3 已发版（2026-08-11）→ 云端验收全闭环（2026-08-27）**

0.6.3 = 0.6.2 长期使用测试复盘挖出的一批同步问题，**无 migration**（`user_version` 仍 11）。
计划 + 详细现象记录 + 三轮审阅修订见 `docs/plans/2026-08-11-0.6.3-plan.md`，
用户可见说明 `docs/history/0.6.3-release-notes.md`。

| 包 | 版本 | 渠道 |
|---|---|---|
| 桌面 | `Owl-0.6.3-arm64.dmg` | GitHub Release `v0.6.3` |
| owl-server | `@orpheus-aviary/owl-server@0.6.3` | npm（`latest`）|
| owl-cli | `@orpheus-aviary/owl-cli@0.6.3` | npm |

### 0.6.3 修了什么

- **V1 `sync_cursor` pull/push 游标互相清零** —— `engine.ts` 的 upsert 里两个 `COALESCE` 打架，
  `excluded.pulled_seq` 拿到的是 0 而非 NULL，于是 push 冲掉 pull 游标、pull 冲掉 push 游标。
  后果：**每次本地写入后的下一轮全量重放整条变更日志**（真机一天 49 轮 / 6.5MB 日志）·
  `/sync/status` 的 `pushed_seq` 恒为 0 · **W2 裁剪在任何推送过的轮次里一行都删不掉**。
  修法 = DO UPDATE 引用命名参数而非 `excluded`。
- **V2 轮次可观测性** —— 新增 `sync round done`（游标前后 + 9 个计数 + `triggers` 来源集合，
  按 coalescer 槽累积而非单个全局字段）；`apply.ts` 逐条变更日志 info → debug。
  V1 能藏三周的直接原因就是「每轮都写着 cursor_before: 0，但没人看得见」。
- **V4 pin / reorder 跨设备** —— 接收侧此前直接丢弃。现在按到达顺序应用，**不进行级 LWW**
  （否则一次置顶会压过另一台的正文编辑）。⚠️ 只保证 0.6.3 之后新产生的 op，历史状态不自动对齐。
- **V3 云端 session watchdog** —— cloud 无会话满 10 分钟 warn + 每小时一条；
  `GET /status` 加 `sync` 健康投影（`session_ready`/`login_required` + `last_success_at`）。
  健康判据只能是 `syncTriggerReady`（401 后凭据还在、session 没了）；watchdog 属**进程**生命周期，
  不能进 `stopBackgroundHandles`（`teardownCloudSession` 会调它且不重启）。第 10 个守卫钉住接线。

### 真机验收（2026-08-11，桌面侧全过）

push 轮 `cursor 1023→1023 pushed=1` → 紧接 sse 轮 `cursor_before=1023 pulled=1`（旧代码是
`cursor_before:0 pulled:1024`）· 连续 5 次写入游标严格单调 `1025/1025→1029/1029` ·
`pushed_seq` 不再恒 0 · info 级 per-change 日志 0 条 · pin 自身 echo `applied=1`（旧版 `skipped=1`）
且 `pinned_at ≠ updated_at` · 裁剪在健康游标下跑通（`deleted:27, pulled_seq:1023`）。

### 云端验收（2026-08-11 同日完成，四项全闭环）

云端已升 0.6.3（`/www/owl-server`）并登录。

- **V3** —— `/status` 投影登录前 `{session_installed:false, state:"login_required", last_success_at:null}`、
  登录后 `{true, "session_ready", 1786434082603}`；日志有
  `{"kind":"session-watchdog","pollMs":60000,"firstReportAfterMs":600000,"msg":"started"}`
  （**接线是否生效只能这样验**，单测看不到）。10 分钟告警的时序由 fake clock 单测覆盖，
  真机不值得为它停 11 分钟同步。
- **V4 完整跨设备** —— 桌面置顶一条笔记 → 云端 `pinned_at` 逐字节一致（`1786434258017`）、
  `updated_at` 保持创建时间不变（`1786434254170`）；云端那一轮 `cursor 1037→1038 pulled=1 **applied=1**`。
  0.6.2 时代这里是 `skipped=1` + `pinned_at IS NULL`。
- **V1 / V2 云端同样成立** —— 三轮 `cursor_before` 依次 1036→1037→1038 无一从 0 起，
  每轮一条 9 数字 summary。

### 云端 W2 裁剪复验（2026-08-27，通过 —— 0.6.3 收尾全部关闭）

等满 7 天窗后跑 `just sync-retention-report` 读云端 profile 库：**推算已裁 12 行**（唯一硬判据
`> 0`）· 该裁未裁 0 · 闸 3 挡住 0 · `pulled/pushed = 2031/1915`（此前留账的
「云端 `pushed_seq` 恒为 0」一并闭环）· 最老存活 acked 行只比 7 天窗 cutoff 晚 2 小时 · round summary 游标链
2002→2031→2031 连贯无归零。明细 + 判读见 `docs/plans/2026-08-11-0.6.3-plan.md` §9。

日志 5 次事件合计 `deleted=8`，与 db 推算的 12 差 4 行（日志轮转 / `local_seq` 空洞）——
「推算已裁」本就是含空洞的上界，不是精确计数。
**C6 这次有了具体数字**：冻结 293 行 / 全表 303 行 = 97% 的 outbox 永远裁不掉，
但它是一次性地板、不再增长。

### 设备列表 + 登录自愈（0.6.4）

skybridge 0.1.5/0.1.6 的云端体检牵出的两件 owl 侧的事，一起做了：

- **设备列表按工具过滤 + 折叠已撤销**（backlog C7）。设备是按**账号**注册的，lark 的注册和
  owl 的混在同一个响应里，而 skybridge 的 `devices` 表**没有 tool 列** → 只能按 `app_version`
  前缀判定。规则和文案抄 lark 的 `packages/shared/src/sync-devices.ts`，**有意保持一致**：
  ① `owl …` 显示 ② **未知（`null`）也显示**（无法证明不是自己的，而这个列表正是用来撤销
  不信任的设备的）③ **被隐藏的数量要说出口**（那些设备也持有本账号凭证）。
  已撤销的折叠不过滤，且不再给「移除」按钮。落点 `packages/gui/src/shared/sync-devices.ts`。
- 🔴 **登录不自愈**（同一轮发现）：`cloud-login.ts` 只要本地 profile 库在就复用记住的 device id，
  **从不问服务器它还有效吗**。而 `/workspaces` 是 authOnly ⇒ 拿着被撤销的 id **登录会成功**，
  然后每一次 `/changes`、`/events` 都 403 `DEVICE_FORBIDDEN`；403 不是 401，走不进 W3 那套
  token 自愈，**重新登录也救不回来**。现在 `resolveDevice` 先 `listDevices()`，
  「已撤销 / 服务器不认识」就重新注册一台（照 lark 的做法：复用等于把用户刚关上的门重新打开）。
  `DEVICE_FORBIDDEN` 文案同步改成可操作的。

测试：gui 668 → **681**，daemon 509 → **511**（两条新回归用例分别覆盖「被撤销」和「服务器不认识」）。

### 🎯 下一步 = Stage 2 收尾 → 1.0.0

**A1 TLS/反代**（换 https = 换 endpoint，游标会从 0 重来；迁移做法和它的三条前提见
0.6.2 计划 §4.1）· 真·24h soak · **A3 P6 多设备 GA**（跨仓）。
待办清单 `docs/plans/2026-07-27-backlog-as-of-0.6.1.md`（**C6 + C7 + D9 待拍板**；
C7 = `DevicesCard` 不折叠已撤销设备，纯 renderer 改动）；
路线源 `docs/plans/2026-07-04-road-to-1.0.0.md`。

---

## 上一阶段：**🎉 0.6.2 已发版（2026-07-27）**

0.6.2 = backlog 的 **B1 / B2 / C2** 三项（桌面 token 自愈 + conflict LWW key + outbox 裁剪）。
计划 + 实施记录 + 真机验收记录见 `docs/plans/2026-07-27-0.6.2-plan.md`（§11），
用户可见说明 `docs/history/0.6.2-release-notes.md`。

真机验收四个自愈场景全过，并抓到一个**计划没预见的 bug**：`requestRecovery` 的 10s 限流
原本是全局一个时间戳，而「daemon 重启 → 重装过期 token → subscribe 401」会在 1.5 秒内
连发两个**不同** reason，升级后的 `token_rejected` 被静默丢弃且不再排期 → 永久卡「需登录」。
已改成**按 reason 限流** + 回归用例。（教训：单测里每个 reason 各是一个用例、时间戳互不干扰，
这类「同一窗口内 reason 升级」只有真机时序能踩出来。）

### 0.6.2 发布内容

| 包 | 版本 | 渠道 |
|---|---|---|
| 桌面 | `Owl-0.6.2-arm64.dmg` | GitHub Release `v0.6.2` |
| owl-server | `@orpheus-aviary/owl-server@0.6.2` | npm（`latest`）|
| owl-cli | `owl-cli@0.6.2` | npm（0.6.0 → 0.6.2，补上 0.6.1 漏发）|
| `OWL_APP_VERSION` | `'0.6.2'` | 决定 skybridge 设备管理显示的版本 |

⚠️ 含 migration `user_version` 10 → 11（`0011_conflict_record_lww_key.sql`），单向不可回滚，
升级前备份 db。三端共用同一套 core，**桌面 / CLI / 云端必须一起升**。

### 0.6.2 修了什么

- **W1 conflict LWW key** —— `conflict_record` 存完整三元组 `(updated_at_ms, lww_counter, device_id)`，
  冲突页在「同一毫秒」时能解释谁赢。LWW 判定零变化。
- **W2 outbox 裁剪** —— `sync_changes` 里已确认、且服务器不可能再投的行，每小时最多裁一次
  （四道闸：endpoint 单一 / provenance 水位 / 游标水位 / 7 天窗）。实测 200k 行稳态 ~5ms。
- **W3 桌面 token 自愈** —— 新状态 `auth_required` + `auth_reason` 三值；daemon 401 / SSE 401 /
  冷启动无 session 都进状态机；GUI main 自动 refresh 或重装 session；凭据真的死了才让用户重登。
- 顺带修掉从 0.6.1 起就挂在 `before` 钩子里的 `profile-chain.e2e`（与本轮无关的历史遗留）。

### 长期使用测试 —— 首次复盘（2026-08-11）

完整数据 `docs/plans/2026-07-27-0.6.2-plan.md` §7.1。三句话版：

- **W2 桌面已闭环** —— 15 天裁掉 346/709 行（49%），「该裁未裁 = 0」，`pruned:false` warn 0 条，
  存活行 = 干净的 7 天滑动窗 + 18 行升级前冻结行。**`RETENTION_MS = 7 天` 默认值合适，不提成配置项。**
- **云端当天才补升 0.6.2** —— 发版时 `/www/owl-server/package.json` 锁在 `^0.6.1-rc.2` 漏升了，
  以致云端从 7-23 起一行没裁（293 行里 213 行早该裁）。已升（`user_version 10→11`、水位 293），
  **第一次真正裁剪待 2026-08-19 复验**。
- **两条新账进 backlog**：**C5** 云端重启后同步静默停摆（RAM-only 凭据，必须手动登录，无告警）·
  **C6** 闸 2 对升级前存量行永久冻结且无一次性清理路径（当前不急）。
- 🔴 **同一轮复盘挖出一个更重的 bug**：`sync_cursor` 的 pull / push 游标**互相清零**
  （`engine.ts:164` 的 `VALUES (?, COALESCE(?,0), …)` 让 `excluded.pulled_seq` 变成 0 而非 NULL，
  DO UPDATE 的 `COALESCE(excluded.…, sync_cursor.…)` 于是冲掉老值）→ **每次本地写入之后的
  下一轮同步都全量重放整条变更日志**（真机一天 49 轮、日志 6.5MB/天）。根因已最小复现。
  → **0.6.3 计划 = `docs/plans/2026-08-11-0.6.3-plan.md`**（V1 游标 / V2 可观测性 /
  V3 云端重启失联 / V4 pin+reorder 跨设备；无 migration）。

⚠️ **验证 W2 装没装要看 db，不能看日志**：水位由 `installSkybridgeSession` 直接写（不打日志），
且无可裁行时 `deleted:0` 也不打日志 —— 「日志里没有 `sync-retention`」是健康态，不是异常。
查 `pragma_user_version` + `local_metadata` 的 `sync_retention_safe_after_local_seq` 才作数。

---

## 上一阶段：**🎉 0.6.1 已发版（2026-07-27）**

0.6.0（2026-07-23）转真机长期使用测试，暴露的跨设备同步问题在 0.6.1 一批修完并发版。
主线是 **Problem A（跨 skybridge 自动同步不生效）**，计划 + 三轮审阅记录见
`docs/plans/2026-07-24-problem-a-auto-sync-plan.md`，用户可见说明见
`docs/history/0.6.1-release-notes.md`。

### 0.6.1 发布内容

| 包 | 版本 | 渠道 |
|---|---|---|
| 桌面 | `Owl-0.6.1-arm64.dmg` | GitHub Release `v0.6.1` |
| owl-server | `@orpheus-aviary/owl-server@0.6.1` | npm（`latest`）|
| owl-cli | 0.6.0 **不变** | 无改动，不重发 |

⚠️ **同步类修复必须两端都升**：桌面和 owl-server 跑同一套 daemon/core 同步代码。
本版含一个 migration（`user_version` 9 → 10），单向不可回滚，升级前备份 db。

### 0.6.1 修了什么

**先修的两个（真机直接踩到）**
- 状态栏读 installed session —— 修「登录后闪『已同步』又退回『本地』」（`d95272a`）。
- 冲突误报 B —— 只在有 **pending**（`synced_at IS NULL`）本地编辑时记冲突，fast-forward 不再误报（`4fd1a79`）。冲突在**接收侧**判定，所以两端都要跑修复。

**Problem A 主线**
- **push-on-mutation**（Phase 1）—— `sync/outbox-watcher.ts` 每秒轮询已提交 outbox，debounce 800ms / maxWait 5s / 退避 `[2,4,8,16,30]s+jitter`。此前根本没有「本地写入 → 推送」触发器，发方向只能等定时器。选轮询而非进程内事件的三个理由（覆盖 daemon 外的写入、`emitSyncChange` 契约要求在事务内、boot 时天然自带 pending 扫描）见计划 §6。
- **触发 gate**（Phase 1/3）—— `sync/trigger-gate.ts`：`syncTriggerReady` 两种 mode 都只看 `ctx.skybridgeSession != null`；`syncRecoveryCapability` 返回 `{canReinstall, canRefresh}` 仅供日志/分派。scheduler 与 watcher 共用，无 session 时静默跳过 + 只打状态转换日志（旧日志 163 条刷屏 → 2 条）。
- **cloud refresh 三态**（Phase 2B 前置）—— `refreshCloudSession` 返回 `{outcome, error?}`。**独立真 bug**：旧实现 catch 到任何异常都 `teardownCloudSession`，一次网络抖动就清空云端 RAM 凭据 + 注销所有 Layer-2 会话。现在 transient 保留凭据并按 `[30,60,120,300]s` 重排恢复定时器（复用 `ctx.refreshTimer`）。
- **401 自刷新**（Phase 2B 后半）—— `attemptSyncRound` 拆分 + `maybeRecoverCloudSession`：cloud 401 → refresh → 重试一轮，30s 冷却；desktop 不走此路（没有 refresh token）。
- **special notes 确定性 seed**（Phase 4）—— `SEED_TS=0` + migration `0010`。迁移只归零 pristine 行：`created_at = updated_at` + 内容等默认模板 + 没有**带 `updated_at_ms`** 的 outbox 行（按 payload 判而非按 op —— reorder 也是 `op='update'` 但只带 `{position}`）。
- **部署不变量**（Phase 5）—— skybridge 必须单实例 fork，写进 `docs/deploy/baota-fish-runbook.md` + `pm2 describe` 确认步骤。进程内探测不可靠（`NODE_APP_INSTANCE` 是序号不是总数），只能靠部署纪律。

**计划外（真机验收时用户提出）**
- **远端变更前端自动刷新** —— daemon 在 `appliedTotal > 0` 时发 `notes:changed`；renderer bump 列表 + `reconcileRemoteChanges()` 逐个开着的标签页比对：版本没动不碰 / 干净 adopt 远端 / 脏只打 `remoteUpdated` 标记走 banner。成本按打开的标签数算，不按变更数算。
- **桌面 CAS** —— `expected_updated_at` 此前只在网页端发，桌面 stale 保存会**静默覆盖**同步进来的远端编辑（无 409、无对话框，覆盖还会 LWW 传播出去）。现在两端都走 `VersionConflictDialog`。

### 本轮的关键教训（写进不变量）

- **coalescer 的 follow-up 在前一轮 reject 后照跑** → 任何轮询型触发器必须自带 singleflight，否则退避形同虚设。
- **`@owl/server` 必须是单文件 bundle**：一个 `await import()` 就让 tsup 拆出 hashed chunk，而 publish manifest 的 `files` 只列 `index.js` → 发出去的包会在首次使用时炸。已给 `gen-publishable-manifest.mjs` 加 fail-closed 检查。
- **`MAX(local_seq) WHERE synced_at IS NULL` 不需要新索引**：`local_seq` 是 rowid = 现有 partial index 的隐式尾列，实测 0.4µs/200k pending 行；真正贵的是 `count(*)`（1772µs），已移出热路径。

### 待办

**⭐ 完整逐项清单（截至 0.6.1，含每项背景 / 落点 / 验收 / 已知坑）= `docs/plans/2026-07-27-backlog-as-of-0.6.1.md`。** 摘要：

- [ ] **Stage 2 收尾 → 🎯1.0.0**：**TLS / 反代**（现在明文 HTTP；改 https = 换 sync endpoint key，注意游标会从 0 重来）· **真·24h soak** · **P6 多设备 GA**（skybridge Phase 5，跨仓）。
- [x] ~~**Phase 2A / B1**：desktop token 过期自愈~~ —— 0.6.2 W3 已做（`auth_required` 加了）。
- [ ] **长期使用测试（= backlog A2 soak）**：~~W2 桌面侧~~（2026-08-11 已验证闭环，见上）·
      **W2 云端待 2026-08-19 复验**（08-11 才补升 0.6.2，届时看「推算已裁行数 > 0」）·
      W3 是否真自愈（跨过一次真实吊销/到期后有无手动登录记录）· 0.6.1 的修复有无回归。
- [ ] **技术债**：skybridge EventBus 换跨进程总线（跨仓，解除单实例约束）· ~~`sync_changes` 无裁剪策略~~（0.6.2 W2 已做，2026-08-11 桌面侧验证有效，7 天窗默认值定了）· **C5 云端重启后同步静默停摆**（RAM-only 凭据 → 必须手动登录且无告警；倾向「日志升级 + `/status` 暴露状态 + 写进 runbook」）· **C6 闸 2 存量行永久冻结**（当前不急）· **D9 未拍板**：含同步痕迹的 local 库要不要禁止 claim merge（计划 §4.4，已知会带旧 cursor + 旧 synced_at 进新账号）。
- [ ] **1.0.0 后**：跨 profile 统一视图（需 spike）· 跨账号导入 · 完整 RN 移动 app（C→D→E）· P8 非核心池。

---

## 历史归档

每个已 ship 阶段的实施细节收在对应设计文档的 `## 实施记录` 段，或 `docs/history/` 下的专题 doc：

| 阶段 | 位置 |
|---|---|
| P0 / P1 基础搭建 | `docs/history/P0-P1-shipped.md` |
| P2 功能完善 | `docs/history/P2-shipped.md` |
| P3.0.5 pre-release polish | `docs/history/P3-0-5-shipped.md` |
| P3.1 GUI 0.2.0 首发 | `docs/plans/2026-04-28-p3-1-gui-0.2.0-release-design.md` § 实施记录 |
| P3.2-a~d / P3.2.5 | 对应 `docs/plans/2026-04-29`…`2026-05-03-*.md` § 实施记录 |
| P3.3 0.3.0 发版 | `docs/history/P3-3-shipped.md` |
| P3.4 UX + P4 skybridge Phase 1+2 + 0.4.0 发版 + 0.4.1 hotfix | `docs/history/P3-4-P4-shipped.md` |
| P5-a 单机 sync engine（内部 2026-05-22） | `docs/history/P5-a-shipped.md` |
| P5-b 多 entity + SSE + GUI（内部 2026-05-24） | `docs/history/P5-b-shipped.md` |
| P5-c 后台 + retry + conflict + token-mask（内部 2026-05-25） | `docs/history/P5-c-shipped.md` |
| **0.4.2 发版**（全局快捷键 + skybridge npm 切换） | GitHub Release v0.4.2 + `docs/history/P5-c-shipped.md` |
| **P5-d per-profile 隔离 + 免密快切 → 0.5.0 发版** | **`docs/history/P5-d-shipped.md`** + `docs/history/0.5.0-release-notes.md` |
| **扩生态 → 1.0.0 路线（两阶段）** | `docs/plans/2026-07-04-road-to-1.0.0.md` + `docs/plans/2026-06-06-mobile-web-ecosystem-arch.md` |
| Phase A 云端 daemon（A0–A6）+ Phase B 网页版（B0–B4）| 各 `docs/plans/2026-06-12`…`2026-06-19-*.md` § 实施记录 |
| **Stage 1**：owl-server 打包 · A6 local CSRF · 重构一轮 · 0.6 本地功能 · 移动 web UI + PWA | `2026-07-04-owl-server-packaging.md` · `2026-07-15-a6-local-csrf.md` · `2026-07-15-refactor-round.md` · `2026-07-16-0.6-local-features.md` · `2026-07-22-mobile-web-ui.md` |
| **Stage 2 公网部署 + 0.6.0 三端发版**（2026-07-23：阿里云/宝塔 skybridge 0.1.4 + owl-server 0.6.0；桌面 dmg GitHub Release v0.6.0；owl-cli npm；异地真机/PWA 验收）| `docs/deploy/baota-fish-runbook.md` + `docs/history/0.6.0-release-notes.md` |
| **0.6.2 token 自愈 + conflict LWW key + outbox 裁剪**（2026-07-27：桌面 dmg + owl-server + owl-cli 三端同发；migration 0011）| `docs/plans/2026-07-27-0.6.2-plan.md` §11 + `docs/history/0.6.2-release-notes.md` |
| **0.6.1 跨设备同步修复**（2026-07-27：Problem A push-on-mutation + 前端自动刷新 + 桌面 CAS + special-notes seed；桌面 dmg + owl-server npm）| `docs/plans/2026-07-24-problem-a-auto-sync-plan.md` + `docs/history/0.6.1-release-notes.md` |

## 关键参考

- 跨仓路线：`aviary/docs/ROADMAP.md`
- skybridge 架构框架：`aviary/docs/SKYBRIDGE_ARCH.md`
- per-profile 隔离父设计（v6 定稿）：`docs/plans/2026-05-29-account-profile-isolation-design.md`
- skybridge 本地开发/调试/发布：见 owl `CLAUDE.md` skybridge 段 + `skybridge/docs/deploy/ubuntu-baota.md`
- 部署/运维（阿里云宝塔 + fish + PM2）：`docs/deploy/baota-fish-runbook.md`
- 历史 P3 总规划（§8 已作废）/ COEDIT 早期规划：`docs/plans/2026-04-20-p3-plan.md` / `docs/plans/COEDIT_PLAN.md`
