# owl 待开发清单 —— 截至 0.6.1（2026-07-27）

> **性质**：备忘清单，不是设计稿。每项记「是什么 / 为什么 / 落点 / 验收 / 已知坑」，
> 开工前该项若需要设计，另拉 design doc。
> **口径**：`0.6.1` 发版当天盘点。已 ship 的不列（历史见 `PROCESS.md` 归档表）。
> **状态源**：当前进度永远以 `PROCESS.md` 为准；本文只在有项目完成/新增时改。
>
> **2026-07-27 更新**：**B1 / B2 / C2 已在 0.6.2 全部完成**（计划 + 实施记录
> `docs/plans/2026-07-27-0.6.2-plan.md`），下面三节保留原文只加一行完成标记，
> 便于回看当时的判断。新增待办：**D9 —— 含同步痕迹的 local 库要不要禁止 claim merge**
> （0.6.2 计划 §4.4；已知 bug：整库复制会把旧 `sync_cursor` 与旧 `synced_at` 行带进新账号，
> 导致新账号漏拉低 seq 的远端变更 + 本地笔记永不上传，尚未拍板修法）。
>
> **2026-08-11 更新**（0.6.2 首次真机复盘）：**C2 桌面侧已验证闭环**（7 天窗默认值合适，
> 不提成配置项）；云端同日补升 0.6.2，待 08-19 复验。新增 **C5 云端重启后同步静默停摆**、
> **C6 闸 2 对存量行永久冻结且无清理路径**（用户已确认 C6 当前不急）。
> 数据见 `docs/plans/2026-07-27-0.6.2-plan.md` §7.1。
>
> 盘点来源：`docs/plans/2026-07-04-road-to-1.0.0.md` §3-4 · `docs/plans/2026-06-06-0.6.0-plan.md`
> §Step1+ · `docs/plans/2026-07-24-problem-a-auto-sync-plan.md` §7-8 · 0.6.1 实施中发现的技术债。

---

## A. Stage 2 收尾 —— 通往 🎯 1.0.0 的全部剩余项

只剩三项。做完即 1.0.0 候选。

### A1. TLS / 反代

**现状**：公网部署是**明文 HTTP**，靠阿里云安全组锁源 IP 挡着。登录密码、skybridge
access/refresh token、笔记正文全部明文过网。

**要做**：Caddy 或 nginx 反代 + TLS 证书（Let's Encrypt）。落点已有占位：
`skybridge/docs/deploy/ubuntu-baota.md` §11。owl 侧 `docs/deploy/baota-fish-runbook.md`
需同步更新（端口、`public_url`、CORS/CSP 是否受影响）。

**牵连**：
- owl-server 的 `[daemon].public_url` 要改成 https，否则 web 端拿到的绝对 URL 不对。
- skybridge server url 也要改 https；客户端 toml / RAM 凭据里存的是 server url，
  **改协议 = 换 endpoint**，`sync_cursor` 按 `syncEndpointKey(serverUrl, workspaceId)` 分桶 →
  ⚠️ 换 url 会让游标从 0 重来（全量重拉，不丢数据但会重放一次）。开工前先确认这条。
- 宝塔面板自带 nginx，别和手起的反代抢 80/443。

**验收**：https 直连可用 · 明文 80 跳转或关闭 · 桌面 + 手机 PWA 都能登录同步 · 证书自动续期跑通一次。

### A2. 真·24h soak

**现状**：Phase 20 T4 当时降范围跳过了，云端后来又拆过重建，没跑过完整长跑。

**要做**：双端（桌面 + owl-server）连同一账号，持续 24h，期间穿插：常规编辑、离线/断网恢复、
息屏/休眠唤醒、token 到期跨越（access token 默认 30 天 —— 需要人为缩短 TTL 或用测试账号，
否则 24h 覆盖不到续期路径）、profile 切换。

**盯什么**：
- `daemon.log` 里 `kind:'outbox-watcher'` / `kind:'sync'` / `kind:'cloud-refresh'` 的错误率与退避是否收敛。
- 内存/句柄是否线性增长（SSE 长连接 + 1s 轮询 watcher 是新引入的，重点看这两条）。
- ~~`sync_changes` 表增长~~ —— 0.6.2 W2 已裁剪，**2026-08-11 桌面侧复盘确认有效**
  （15 天裁掉 49%，稳定在 7 天滑动窗），见 C2。云端待 2026-08-19 复验。
- 有无误报冲突（0.6.1 修了 fast-forward 误报，长跑是它的真正验证）。

**验收**：24h 无人工干预、两端数据一致、无未处理错误、内存平稳。

### A3. P6 多设备 GA（= skybridge Phase 5）

**跨仓**（skybridge 仓主导）。owl 侧是消费方。

**内容**：skybridge 侧多设备同步的 GA 化 —— 具体 scope 在 skybridge 仓定，
owl 侧至少要覆盖：三台以上设备并发编辑、device revoke 后的清理、
server 端 changes 表的保留策略。

**依赖**：A1（TLS）先做完更合理 —— GA 不该建立在明文链路上。

---

## B. 明确延后但已有设计的

### B1. Phase 2A —— 桌面 token 过期自愈

> ✅ **已完成（0.6.2 W3）**。`SyncState` 加了 `auth_required` + `auth_reason` 三值优先级；
> 真机验收还抓到一个计划没预见的 bug（外部限流吞掉「升级后的 reason」），见 0.6.2 计划 §11。


**现状**：access token 过期后，桌面**必须手动去设置里重新登录一次**。云端 daemon 已在 0.6.1
自愈（它自己持 refresh token），桌面不行 —— refresh token 在 GUI main 的 keychain 里，
daemon 拿不到。

**用户 2026-07-27 定**：不影响使用，延后。

**⚠️ 开工前必须先拍板**：`SyncState` 加不加 `auth_required` 枚举值？
- 推荐**加**。`error` 已经承载瞬时网络/API 失败，状态栏对它的处理是「稍后自动重试」；
  而需要用户去登录是**终态**，需要一个可点击的提示，语义完全不同。
- 备选：复用 `error` + `error_code = 'SKYBRIDGE_AUTH_REQUIRED'` 特判。不推荐 —— 终态混进
  重试态，以后每个消费方都要记得特判。
- 两处定义要**同步改**：`packages/daemon/src/events/types.ts` 与 `packages/shared/src/types.ts`。

**设计要点**（详见 `docs/plans/2026-07-24-problem-a-auto-sync-plan.md` §6 Phase 2A，
那里记了三轮审阅逐条核实的结论，**别重新推导**）：

1. **事件必须带 reason，不能靠本地 expiry 猜**。服务器可以提前吊销（logout / device-revoke），
   此时本地 expiry 还没到 —— 按 expiry 判断会陷入「反复重装同一枚被拒 token」的死循环。
   两种 reason：`missing_session`（没装过/被清过 → reinstall 就够）、
   `token_rejected`（真收到 401 → **必须 refresh**）。
2. **状态与命令拆开**。状态 = `SyncStatusBroadcaster` 里可重新查询的 `auth_required`
   （`GET /sync/status` 也能读到，渲染进程错过瞬时事件也不会卡住）；
   命令 = `sync:auth_required(reason)` 瞬时事件，丢了不致命。
3. **`/sync/session` 成功后必须显式回 `idle`**，否则 renderer 永远卡在 `auth_required`。
4. **`/sync/logout-local` 是主动登出，不发命令** —— 否则 GUI 会立刻把刚登出的账号自动装回去。
5. **只在 local mode 发命令**（cloud 没有 Electron main，走 2B 的 recovery timer）。
6. **进入 `logged_out` 必须真清凭据**（`clearSkybridgeAuth()`，`core/src/skybridge/config.ts`），
   否则 `syncRecoveryCapability` 会长期返回「可自动恢复」，状态栏骗人。
7. GUI main 侧：`reinstallFromConfig()`（解密已存 access token 重发 `/sync/session`，
   **不做 refresh** —— 那枚 access 本来就是好的，失败的只是发给 daemon 这一步）；
   refresh 与 reinstall 各自独立退避；singleflight 走已有的 `runSwitchExclusive` + 10s 限流。

**触及 9 处跨 3 进程**：`SyncState`×2 + broadcaster + `manual.ts` 401 分支 +
`/sync/session`·`/sync/logout-local` 路由 + renderer 转发 + preload/IPC + main `recoverSession`
+ 状态栏 UI。**改的是登录/登出可感知行为，建议单独验一轮**。

**已知残留（做完也仍在）**：窗口全关但 app 还在时没有 renderer 转发命令，只能靠 timer +
resume/focus 兜底 —— 但状态是准确的，用户再开窗口能看到。

**开工前还需确认**：skybridge access token 的**实际 TTL**（`sync-auth-renewal.ts` 注释说
server 默认 30 天，未真机确认）—— 决定 renewal 节奏和怎么测。

### B2. W7 尾巴 —— `conflict_record` 加 counter 列

> ✅ **已完成（0.6.2 W1）**。迁移 `0011`，counter + device_id 四列一起加，冲突页按三级分支展示。


**现状**：W3 上了 HLC-lite 三元组 LWW `(updated_at_ms, lww_counter, device_id)`，但
`conflict_record` 表只存了 ms，没存 counter。W3 §4.1 当时明确留账。

**影响**：display-only —— 冲突页展示的「本地 vs 远端」少一维信息，**不影响 LWW 正确性**。

**落点**：新 migration（**下一个编号是 0011**，0010 已被 special-notes seed 占用）+
`core/src/sync/conflicts.ts` 的读写 + GUI 冲突页类型/展示。

**注意**：W7 的其余部分（冲突双向可见、「用本地版本覆盖」、`@codemirror/merge` 两栏合并编辑器）
**0.6.0 已经发了**，只剩这一条。

---

## C. 技术债（0.6.1 实施中发现，都已记录未做）

### C1. skybridge EventBus 换跨进程总线 —— **跨仓，优先级最高的一条债**

**现状**：skybridge server 的 `EventBus` 是**单进程内存实现**，push 之后只能通知同进程内的
SSE 订阅者。所以部署**必须单实例 fork**，这条已写进 `docs/deploy/baota-fish-runbook.md`
作为不变量 + `pm2 describe` 确认步骤。

**为什么是债**：任何时候有人加了 `pm2 -i`、上了多容器、或滚动发布期间新旧并存，
连到 A 副本的设备就收不到 B 副本处理的推送 —— 症状是**「对方改了这边一直不同步」**，
和 Problem A 一模一样，而且日志上完全看不出来，极难归因。**进程内探测不到**
（`NODE_APP_INSTANCE` 是实例序号不是总数，多容器各自都是 0），只能靠部署纪律。

**要做**（skybridge 仓）：EventBus 换 Redis pub/sub 或等价物。做完才能真正水平扩展。

**中间态**（也在 skybridge 仓）：启动时检测到 cluster 迹象打 warn —— 尽力提示，
**不能声称能可靠发现所有多副本场景**。改动路径：skybridge 仓改 → 发版 → owl 升依赖 → 重新部署验证。

### C2. `sync_changes` 无裁剪策略

> ✅ **已完成（0.6.2 W2）**。`core/src/sync/retention.ts` 四道闸 + 每小时节流；
> 默认 7 天窗 / 5000 行仍是模块常量，等长期使用测试的数据再定要不要提成配置项。
>
> ✅ **2026-08-11 真机复盘：桌面侧已闭环** —— 15 天里裁掉 346/709 行（49%），
> 「该裁未裁 = 0」，`pruned:false` warn 0 条，单次删 5–42 行。**7 天窗默认值合适，
> 不提成配置项**。云端同日才补升 0.6.2（发版时漏升），第一次真正裁剪待 2026-08-19 复验。
> 完整数据见 `docs/plans/2026-07-27-0.6.2-plan.md` §7.1。


**现状**：engine 推送成功只置 `synced_at`，**从不 DELETE**。表单调增长。

**目前不痛**：0.6.1 已经把每 tick 的 `count(*)`（O(pending)）移出热路径，脏检测用
`MAX(local_seq) WHERE synced_at IS NULL`（走 0005 partial index，200k pending 行实测 0.4µs）。
但**全表**仍在长。

**触发条件**：A2 长跑（24h soak）是第一个可能暴露它的场合。真要做时注意：
`0008` 那类 backfill 依赖历史行的存在性判断，裁剪策略要避开。

### C3. 随记 / 待办的 1970 显示

**现状**：0.6.1 的 `SEED_TS = 0` 让从未编辑过的随记/待办排在按时间排序列表的最底、
日期显示 1970-01-01。GUI 对特殊笔记只做了颜色条和删除确认特判，**没有置顶**。

**若嫌刺眼**：换成一个固定过去常量（如 `2020-01-01`）是**一行改动**
（`core/src/db/special-notes.ts` 的 `SEED_TS`）—— 排序位置不变，只是日期显示不同。
⚠️ 改常量要连带出一个新 migration 把已归零的行搬到新常量，否则新旧设备的 pristine seed
不再字节一致，LWW 的确定性就没了。

### C4. `ensureSpecialNotes` 的 restore 分支不写 outbox

**现状**：特殊笔记被 `trash_level > 0` 后，下次启动会被本地 restore 复活，**且不广播**。

**已决定不修**：正常 API 删不掉（`daemon/src/routes/notes.ts` 有 `SPECIAL_NOTE_IDS` 守卫 +
`系统笔记不可删除`），只在旧版本 db / 直接跑 SQL / 数据损坏时可达。记录备查。

### C5. 云端重启后同步静默停摆（2026-08-11 复盘新增）

**现状**：cloud 模式凭据是 **RAM-only**（`daemon/src/credential-store.ts`，Phase A 的安全选择：
服务器没有 keychain，不落盘 refresh token）。owl-server 进程一重启就退回 local 库、无 session，
**直到有人从网页端登录才恢复同步**。

**为什么是问题**：没有任何告警。表现只有 daemon.log 里每 5 分钟一条
`sync scheduler tick rejected / SkybridgeAuthRequiredError`（level 40）。桌面端此时照常同步、
UI 一切正常，只有云端这一路默默掉队 —— 2026-08-11 复盘就是这么发现云端漏升 0.6.2 的
（顺带发现它当时也没在同步）。这台机器至今已重启 4 次。

**候选修法**（未拍板，详见「优化方案」讨论）：
1. 云端持久化 refresh token（0600 文件 + 显式 opt-in）→ 重启自动恢复。**推翻「云端不落盘凭据」
   的安全前提，代价大于收益**，倾向不做。
2. 启动后 N 分钟仍无 session → 日志升级 + `/status` 暴露 `sync_state`，让它**可被监控发现**。
3. 写进部署 runbook：「重启 owl-server 后必须手动登录一次」。

倾向 **2 + 3**。落点：`daemon/src/sync/scheduler.ts`（无 session 的 tick 已有静默跳过逻辑）+
`routes/system.ts` 的 `/status` + `docs/deploy/baota-fish-runbook.md`。

### C6. 闸 2 对升级前存量行是永久冻结，无一次性清理路径（2026-08-11 复盘新增）

**现状**：`retention.ts` 的 `computeWatermark` 对「已有 `sync_cursor` 行」的库直接
`safe_after = MAX(local_seq)`，把升级当下的全表划为不可裁。这是刻意的保守设计
（那些行归属哪个 endpoint 已不可考），但**没有任何后续清理入口**。

**实测量级**：桌面冻结 18 行（升级时表还小），云端冻结 293 行（跑了 19 天）。
都无害。但一台跑半年才升上来的 daemon 会背几万行永久驻留。

**当前判断（用户 2026-08-11 确认）**：测试阶段只有这一台服务器、数据量小，**不急**。

**真要做时的两条路**：给一条 opt-in 的一次性清理命令（把水位重置为 0，之后由闸 1/3/4 兜底 ——
对「单 endpoint + 从没换过账号」的库其实成立）；或在升级说明里写清这个地板的存在。

---

## D. 1.0.0 之后

按 `docs/plans/2026-07-04-road-to-1.0.0.md` §4 与 0.6 backlog 的重排结论，这些**明确不进 1.0.0**。

### D1. 跨 profile 统一视图

一个界面里同时看多个账号的笔记。**机制全空白**：daemon 现在是单库单跑
（一个 `ctx.db`，profile switch 是整体换库）。要做得先 spike 架构 —— 多库并存？
还是一个聚合只读视图？这是设计题不是实现题。

### D2. 跨账号导入 / local→非空账号导入

- **A→B 跨账号**：快照业务表 + 在 B 生成**全新 create ops**，
  **绝不搬 synced outbox**（会污染 B 的 change log 序列）。**时机再议**。
- **local→非空账号**：0.5.0 的 D10b 只支持「认领空账号」。往已有内容的账号里并本地库，
  需要一套合并语义（重复怎么办、id 冲突怎么办），未设计。

### D3. 完整 RN 移动 app（Phase C→D→E）

C = 发布 `@orpheus-aviary/owl-shared` 到 npm → D/E = RN app。
现在移动端是**兼容 web UI + PWA**（0.6.0 已发），够用。

### D4. P8 非核心池（scope 届时定）

tray 图标 · 图片粘贴 · FIM 补全 · `[[` note-link · 编辑器正文 slash command ·
`owl doctor --recover` · `@owl/core` 公开发布。

---

## E. 已废弃 / 已完成（防止重复捡起）

| 项 | 结论 |
|---|---|
| **W11 附件跨设备同步** | ❌ **已废弃** —— 0.5.0 后的 **text-first 决策**（不做附件存储/同步/文件上传；markdown 外链图片仍渲染），见 `docs/plans/2026-06-06-mobile-web-ecosystem-arch.md` §10。原 `attachmentRefs` 占位无需再扩 |
| **`resetAllStores(epoch)` 免闪烁切换** | ✅ **已完成** —— 就是 0.6.0 的 session-epoch，代码里 `location.reload` 只剩解释性注释。0.6 backlog 里那条是旧的 |
| **W7 冲突双向可见 / 覆盖 / 合并编辑器** | ✅ 0.6.0 已发，只剩 B2 的 counter 列 |
| **Problem A Phase 0 干净复现** | ✅ 以 rc.1 / rc.2 真机验收代替，(a) 无 push-on-mutation 确认是主因 |
| **给 outbox 探针加新索引** | ❌ **实测否决** —— `local_seq` 是 rowid = 0005 partial index 的隐式尾列，SQLite 已 seek 末端（200k 行 0.4µs），加了规划器根本不选。曾建了 0010 索引迁移又删除，**别再走回头路** |
