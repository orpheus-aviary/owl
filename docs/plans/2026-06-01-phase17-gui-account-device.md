# Phase 17 子设计 —— GUI 账号/设备管理（免密快切 + 移除设备 + 手动同步 + 删除副本）

> 父设计：`2026-05-29-account-profile-isolation-design.md`（**v6 定稿，§0.5 + §5.4.3(D2 三动作) + §11 路线 + §13 W4/W5/W8/W9 + §14 skybridge 0.1.4 能力**权威）。
> 前置（均落 owl main 未 push）：Phase 12 resolver ✅ + 13 存储/adapter ✅ + 14 `switchProfile` ✅ + 15 live 登录/refresh ✅ + 16 受控 reload/认领/W3 ✅；skybridge **0.1.4 已 publish @next**（已具 `refresh`/`revokeDevice`/`getServerTime`/`server_id`）。
>
> **本阶段是 0.5.0 profile 隔离的最后一块拼图**：Phase 12-16 把"每账号一份隔离副本 + 稳定 device 身份 + 受控 reload + 认领 + HLC-lite"全打通了，但**账号之间还没有"切换"这件事的 UI** —— 现在离开账号只有 Settings 的完全登出（revoke + 重输密码），没有免密快切；设备列表只读不能清孤儿；offline 是纯信息态没有手动同步；提醒只为 active profile 触发也没说明。Phase 17 补齐这些 GUI 账号/设备管理动作，达成设计 §8.1「无串味、无静默合并、无设备堆积、无旁路旧库入口」的可用底线。
>
> **形态拍板（2026-06-01，用户四问确认）**：
> 1. **快切 UI = 扩展现有 `SyncStatusBar` popover**（不另起独立下拉）：popover 里加一段"切换账号"列表（local + 各账号，标当前），点选即免密切换。账号列表区 `max-h` + `overflow-y-auto`（账号通常 1~3 个、几乎不触发滚动，防御性加）。
> 2. **「删除账号本地副本」（destructive）纳入 Phase 17**（设计 §5.4.3 第三类动作；Phase 16 §7 已把它推给 17）。落在 Settings → 同步 tab 的"已保存账号"管理区，**不放进 hover popover**（destructive 不进轻量悬浮层）。
> 3. **离开账号两种语义并存（D2）**：侧栏快切的"切回本地" = **step away，保留 refresh token、下次免密回来、不 revoke**；Settings"退出登录"**保持现状 = 完全登出（远端 revoke + 清密文）**。两入口语义/文案明确区分。
> 4. **移除设备仅限非当前设备**：当前设备（本机 `[device].id`）的移除按钮禁用/隐藏；移除当前=自我登出，引导走"退出登录"。
>
> **切片（仿 Phase 15/16）**：**17a = W8 手动同步 + W5 文案**（最小、独立，先落）→ **17b = W4 免密快切**（头牌，含精确回滚到前一 profile）→ **17c = W9 移除设备 revoke**（device 列表写动作）→ **17d = 删除账号本地副本**（destructive，复用 17b 列表 + revoke 管线）。每片独立可测/可提交。
>
> **Review round 1 修订（2026-06-01，用户审计，正文已照此）**：
> 1. **快切一进来就 `clearRefreshTimer()`**（不只切 local 时）：否则 A→B 期间旧 `refreshSession()` 可能在"daemon 已切 B 库、toml 还没 `setActive(B)`"窗口触发，按 active toml 读 A 把 A 的 session 装进 B 库。**no-op 判断先于 clear**（同 profile 不动 timer）；成功后给 target 重排、失败回滚后给 prior 重排（捕获 `priorExpiresAt`）。
> 2. **轮换密文 persist-first（按 id）**：`skybridgeRefresh(target)` 成功后**立刻** `updateProfileAuth(target, …)` 落盘，**再**切 daemon。否则 refresh 成功（旧 refresh 已作废）但 switch/session 失败 → 新 refresh 没落盘 → target 下次快切直接 dead。新增 `updateProfileAuth(profileId, patch)`（by-id，非 active）。
> 3. **删除副本远端清理 device-first / logout-last**：`logout()` 作废 token-family 后同一 token 再调即 401（skybridge smoke 已验，`skybridge-sdk-smoke.skybridge.e2e.ts`）→ 必须**先 `revokeDevice(device.id)`、后 `logout()`**；access 过期则先 `refresh` 拿新 access，仍 device-first/logout-last。
> 4. **active 删除的"切 local 释放句柄"是硬前置、不能吞错**：`postSyncSwitch(local)` 成功才删库；**仅 daemon 明确不可达（NetworkError）**才走"无句柄持有"路径继续删，**HTTP 500/503/校验失败一律中止删除**（daemon 在线但 switch 失败可能仍持 target 句柄）。不用吞错的 `bestEffortSwitchLocal()`。
> 5. **active/prior 取"有效 active"而非 raw `readActiveProfileId()`**：resolver 三重 gate 会在 section/db 缺失时回退 local；raw id 可能把 ghost profile 标当前、点击 no-op、或回滚到不存在 profile。抽 `readEffectiveActiveProfileId() = resolveActiveProfile()?.id ?? LOCAL_PROFILE`，快切/profiles 列表/删除判断全用它。
>
> **Review round 2 修订（2026-06-01，用户审计，正文已照此）**：
> 6. **快切早期失败也要重排 prior timer**：`clearRefreshTimer()` 之后的**整个**账号分支（`readProfileSection` 缺字段 / 无 refresh / `updateProfileAuth` 写盘失败 / refresh 抛 …）包一层 catch，凡**未成功切走** daemon → `reschedulePrior`；已切走 → `rollbackToPrior`。用 `switched` 标志区分。`reschedulePrior`：`priorExpiresAt == null` 时**显式 no-op**（绝不把 null 传给 `scheduleRefresh(expiresAt?)`——会算出 NaN 立即 fire）。
> 7. **ghost profile 不可从 popover 快切（防空库复活）**：`/sync/switch` 对 hex id 会 `mkdir` + 打开目标路径 → db 不存在时**创建空库**。`listProfiles` 增 `dbExists`（`existsSync(profileDbPath(id))`），`can_quick_switch = hasRefreshToken && dbExists`；db 缺失段在 popover **不可快切**、Settings 显「本地副本缺失」（可删段 / 重新登录）。
> 8. **active 删除中止时恢复 timer**：删当前账号先 `clearRefreshTimer()`，若 `postSyncSwitchStrict(local)` HTTP 500/503/校验失败 → **中止删除 + 恢复当前账号 timer**（捕获 `activeExpiresAt`）。仅"真正继续删除 / 切 local 成功"才保持 timer 停。
> 9. **删除副本远端清理覆盖 refresh-only profile**：现有配置允许 refresh-only、现有 `remoteRevoke` 在无 access 时走 refresh 路径。改：**access 缺失或过期、且 refresh 存在 → 先 refresh 取新 access，再 device-first/logout-last；仅当 access 与 refresh 都不可用才跳过远端**。
>
> **Review round 3 修订（2026-06-01，用户审计，正文已照此）**：
> 10. **`switchToProfile` main 侧硬校验 target db 存在（refresh 之前）**：`sync:switch-profile` 是 IPC，可能被 stale UI / 测试 stub / 未来入口绕过 popover 的 `can_quick_switch` gate 直接调；`/sync/switch` 对 hex id 会 `mkdir` + 创建空库 → **不能只靠 popover gate**。账号分支进 try 第一步 `if !existsSync(profileDbPath(targetId)) throw ProfileDbMissingError`（**在 refresh 之前**）→ 杜绝复活空库。popover `dbExists` gate（⑦）保留为 UX 层、main 闸为权威层（纵深防御）。

---

## 0. 一句话

Phase 17 给 profile 模型补上**账号之间的动作**：侧栏 popover 免密快切（保留 token、切回 local）、状态 popover 手动同步（兼当 offline 时的即时纠偏）、设备列表移除孤儿设备（远端 revoke）、Settings 删除某账号在本机的整库副本（destructive 二次确认）+ 提醒仅 active profile 的明示。**所有切换仍走 GUI main 单点 → 复用 16a 受控 reload，零残留。**

---

## 1. 决策落点（本阶段照此，无歧义）

| 决策 | 落点 |
|---|---|
| **W8** 手动同步 | 状态 popover 加「手动同步」按钮 → 新 IPC `sync:run` → 既有 daemon `POST /sync/run`（`runManualSync`）。daemon **无改动**。offline 时点击即尝试一轮 pull/push（兼当即时纠偏；SSE 永久退避重连不变，**不加手动 reconnect 按钮**——设计 §13 W8 本意是给个 action，不是改重连模型）。 |
| **W5** 提醒仅 active | Settings 已登录视图加一行说明「提醒仅在当前账号激活时触发」+ Phase 22 release notes。**纯文案，无逻辑改动**（设计 §13 W5「接受单活跃」）。 |
| **W4** 免密快切 | core 新增 `listProfiles()` / `updateProfileAuth` / `clearProfileAuth` / `readEffectiveActiveProfileId`；GUI main `switchToProfile(targetId)`（进门 `clearRefreshTimer` + **refresh-first** + **persist-first 轮换密文落 target** + `postSyncSwitch` + install + `setActive` + **精确回滚前一 profile**，active 全用有效 active）；新 IPC `sync:profiles` / `sync:switch-profile`；`SyncStatusBar` popover 加账号列表。**切回 local = step away（保留 token、不 revoke）**，与 Settings 完全登出区分（D2）。 |
| **W9** 移除设备 | daemon `RealSkybridgeClient` 接口加 `revokeDevice` + 新路由 `POST /sync/revoke-device`（仿 `/sync/devices`：读 `ctx.skybridgeSession`、translateSkybridgeError、401 invalidate）；GUI main IPC `sync:revoke-device`；`DevicesCard` 非当前设备行加「移除」+ 确认 → revoke → 重拉列表。**当前设备无移除按钮**（Q4）。 |
| **删除副本** | core 新增 `deleteProfileDb(profileId)`（删 `owl.db`+`-wal`+`-shm`）；GUI main `deleteProfileLocalCopy(targetId)`（active→**硬要求**切 local 释放句柄，HTTP 失败中止删除；**main 侧**用该 profile 密文 **device-first→logout-last** 远端清理，再删库 + `removeProfile` toml 段）；新 IPC `sync:delete-profile`；Settings"已保存账号"区每行「删除本地副本」+ 二次确认。 |

---

## 2. 17a —— 手动同步（W8）+ 提醒仅-active 文案（W5）

> 目标：状态 popover 给个「手动同步」动作（最小、独立、先落止血），顺手补 W5 一行文案。

### 2.1 手动同步（W8）

- **daemon 无改动**：`POST /sync/run` 既有（`routes/sync.ts:56`，调 `runManualSync(ctx)` → markSyncing/markSuccess/markError 经 broadcaster 推 `sync:status_changed`）。
- **GUI main `sync-ipc.ts`**：新 handler `ipcMain.handle('sync:run', …)` → `safe<RunSyncResult>(() => postSyncRun())`；`postSyncRun()` = `fetch(POST /sync/run)`，非 2xx 抛（裸 fetch reject 包 `NetworkError`，与 `buildDevices` 同款，走 `safe()` 的 network 分支出中文）。**不**调 `notifyProfileSwitched`（无 profile 变更，不 reload）。
- **preload + `owl-api.d.ts`**：`owlAPI.sync.run(): Promise<SyncIpcReply<RunSyncResult>>`。`RunSyncResult` 形状从 daemon 复用（shared 里若无则加最小 `{ pushed, pulled, … }`，按 `readSyncStatus`/`runManualSync` 现有返回裁剪；renderer 只需知道"成功/失败"+ 可选计数）。
- **renderer `SyncStatusBar.tsx`**：popover 详情视图（`snapshot && server_url !== null` 的账号态）底部加「手动同步」按钮：
  - 点击 → `running=true` → `await owlAPI.sync.run()` → `running=false`；成功不需手动刷新（daemon 经 SSE 推 `sync:status_changed` 更新 `useSyncStatus`），失败 inline 显 `reply.message`。
  - `state==='syncing'` 时按钮 disabled（避免叠触发；`syncCoalescer` 本就串行化，但 UI 不给重复点）。
  - **本地态（`server_url === null`）/ 无 snapshot 态不显此按钮**（local 无可同步；冷启动未配置不 actionable）。
- **W8 不做**：手动 SSE reconnect 按钮（设计 §13 W8 只要 action；SSE 永久退避 cap 30s 自愈，模型不变）。`SyncStatusBar` 头注释「No manual sync button」相应更新为「manual sync action added (Phase 17/W8); SSE reconnect 仍自动」。

### 2.2 提醒仅-active 文案（W5）

- `SyncSection.tsx` 已登录视图（identity 三行附近）加一行 muted 说明：「⏰ 提醒仅在当前账号激活时触发；切换到其他账号或本地时，此账号的提醒不会响起。」
- Phase 22 release notes 记一条（设计 §13 W5 落点）。
- **无逻辑改动**：`ReminderScheduler` 本就只对 active profile db 跑（Phase 14 switch 时 rebuild），W5 仅明示既有行为。

### 2.3 测试（17a）

- main：`sync:run` 成功 → 返回 daemon result；daemon 非 2xx / fetch reject → `ok:false` 中文。
- renderer：`SyncStatusBar` 账号态显「手动同步」按钮、`syncing` 时 disabled、local 态/无 snapshot 不显；点击调 `owlAPI.sync.run`、失败显 message。`SyncSection` 已登录视图含 W5 文案。

---

## 3. 17b —— 免密快切（W4，设计 §5.4.3 step-away + §11）

> 目标：侧栏 popover 列出本机所有 profile（local + 各账号），点选即**免密切换**（用该 profile 存的 refresh token 换新 access）；切回 local = step away 保留 token。**切换发起永远在 GUI main 单点 → 复用 16a 受控 reload。**

### 3.1 core 新增 `listProfiles()`

`packages/core/src/skybridge/config.ts`：

```
listProfiles(path?): ProfileListEntry[]
  raw = parse(toml)（失败/无 [profiles] → []）
  for [id, section] of raw.profiles:
    若 id 非 32-hex → skip（防脏数据）
    push { id, email, server_url, server_id,
           hasRefreshToken: !!encrypted_refresh_token,
           dbExists: existsSync(profileDbPath(id)) }      # ⑦ ghost 检测
```

- `ProfileListEntry`（新导出 type）：`{ id; email?; server_url; server_id?; hasRefreshToken: boolean; dbExists: boolean }`。
- 纯 raw parse（不经 `readSkybridgeConfig` adapter——后者只返 active 视图、缺 server.url 会抛）。与 `readProfileSection` 同款读法。`index.ts` 导出。
- **⑦`dbExists`（防 ghost 复活）**：`/sync/switch` 对 hex id 会 `mkdir` + 创建空库，故 db 缺失的段**不能**走快切（否则复活成空账号库）。`dbExists` 喂给 `buildProfiles` 的 `can_quick_switch = hasRefreshToken && dbExists`（§3.4）。
- **不含 local**：local 是隐式 profile（无 `[profiles.local]` 段），由 GUI 合成一条固定条目。

### 3.2 GUI main `switchToProfile(targetId)`（refresh-first + persist-first + 精确回滚）

`packages/gui/src/main/sync-auth.ts` 新增 export。**这是 Phase 17 头牌**，把 `restoreSessionOnStartup` 的 refresh 路径泛化成"切到任意指定 profile"。**timer 停止 / 轮换落盘 / 有效 active** 三个边界按 review round 1 写硬。

```
switchToProfile(targetId: string):
  if !safeStorage.isEncryptionAvailable(): throw SafeStorageUnavailableError
  prior = readEffectiveActiveProfileId()               # ⑤ 有效 active（resolver gate），非 raw toml
  if targetId === prior: return                        # no-op 先于 clear → timer 不受扰
  priorExpiresAt = currentExpiresAt                     # ① 捕获 prior 续期点（回滚/重排用）
  clearRefreshTimer()                                  # ① 一进来就停（防 A 的 refresh 装进 B 库）

  if targetId === LOCAL_PROFILE:
    # —— 切回本地（step away，保留 token、不 revoke，D2）——
    try {
      await postSyncSwitch(LOCAL_PROFILE)              # daemon 开 owl/owl.db、清 session
      setActiveProfile(LOCAL_PROFILE)                  # 不动 [profiles.<prior>]（token 留着）
    } catch (err) { reschedulePrior(prior, priorExpiresAt); throw err }
    return                                             # local 无续期，timer 保持停

  # —— 切到账号（免密 refresh-first + persist-first），整段一个 catch（⑥）——
  let switched = false
  try {
    # ⑩ main 侧硬闸（权威，refresh 之前）：db 不存在绝不往下——否则 /sync/switch mkdir 复活空库
    if !existsSync(paths.profileDbPath(targetId)): throw ProfileDbMissingError(targetId)
    section = readProfileSection(targetId); 若缺 device/workspace/user_id/server_url → throw
    refreshTok = decryptB64(section.encrypted_refresh_token)
    若无 refreshTok → throw QuickSwitchNeedsLoginError       # legacy 无 refresh → 不能免密
    # ① refresh 先行
    let rotated
    try { rotated = await skybridgeRefresh(section.server_url, refreshTok) }
    catch (err) { if isRefreshDead(err) clearProfileAuth(targetId); throw err }   # 标"需重登"（§3.3）
    # ② persist-first：轮换密文立刻落 target（旧 refresh 已作废，必须先存新的，再动 daemon）
    updateProfileAuth(targetId, { encrypted_token: enc(rotated.token),
                                  encrypted_refresh_token: enc(rotated.refreshToken) })
    # ③ 切 daemon 库（Phase 14 契约：throw=abort 旧 ctx 未动）+ 装 session
    await postSyncSwitch(targetId); switched = true         # return visit，db 必存在（⑦ popover 已 gate dbExists）
    await postSyncSession({ token: rotated.token, user_id, email, server_url,
                            device: section.device, workspace: section.workspace })
    setActiveProfile(targetId)                              # active 翻 target（db 存在，过闸）
    scheduleRefresh(rotated.expiresAt)                      # 给 target 重排续期
  } catch (err) {
    # ⑥ 任何失败：切走过 → 精确回滚（daemon+session+timer）；没切走 → 仅恢复 prior timer
    if (switched) await rollbackToPrior(prior, priorExpiresAt)
    else reschedulePrior(prior, priorExpiresAt)
    throw err
  }
```

**关键点**：
- **①timer 边界**：`clearRefreshTimer()` 在 no-op 判断之后、任何 daemon 动作之前。捕获 `priorExpiresAt = currentExpiresAt`（clear 会清掉它）。成功路径 `scheduleRefresh(rotated.expiresAt)` 给 target 重排。**杜绝"A 的 refresh 在 B 库窗口触发"**。
- **⑩main 侧 db 硬闸**：账号分支进 try 第一步 `existsSync(paths.profileDbPath(targetId))` 失败 → `ProfileDbMissingError`（**早于 refresh**）→ `switched===false` 路径，仅 `reschedulePrior`、**不** refresh / **不** `postSyncSwitch` / **不**建空库。这是权威闸（popover `can_quick_switch` 是 UX 层，可被 stale UI / 测试 / 未来入口绕过）。复用 core 既有 `ProfileDbMissingError`。
- **⑥整段 catch + null 守卫**：`clearRefreshTimer()` 之后的整个账号分支包**一个** catch；早期失败（db 缺 / `readProfileSection` 缺字段 / 无 refresh / refresh 抛 / `updateProfileAuth` 写盘失败，`switched===false`）→ `reschedulePrior`；已 `postSyncSwitch(target)` 成功（`switched===true`）→ `rollbackToPrior`。`reschedulePrior(prior, priorExpiresAt)` = **`prior===local || priorExpiresAt == null` → no-op**（绝不把 null 传给 `scheduleRefresh(expiresAt?)`——`null - Date.now()` = NaN，`setTimeout(NaN)` 会立即 fire）；否则 `scheduleRefresh(priorExpiresAt)`。
- **②persist-first（修 restore 反向风险）**：`skybridgeRefresh` 服务端即时轮换（旧 refresh 当场作废）→ 新密文必须**先落 target 段**再切 daemon。否则 switch/session 失败 → 新 refresh 没落盘 → target 下次快切 dead。`updateProfileAuth(targetId, …)`（§3.3 新增 by-id 变体，**不**用只改 active 的 `updateActiveProfileAuth`——此刻 active 仍是 prior）。crash-between（refresh 成功未落盘）窗口收窄到"refresh 返回↔updateProfileAuth"一行内，比原计划安全得多。
- **dead refresh**：`REFRESH_INVALID`/`REFRESH_REPLAYED` 在切库前抛 → 当前 active 会话毫发无伤；`clearProfileAuth(targetId)` 让 Settings 对该账号显"需重登"；network/unknown 不清（留着重试）。renderer 收 `ok:false` → 文案「该账号登录已过期，请在设置中重新登录」。
- **精确回滚 `rollbackToPrior(prior, priorExpiresAt)`**（best-effort、不二次抛，偿还 `sync-auth.ts:210` 注释欠的 Phase 17 债）：
  - `prior === LOCAL` → `postSyncSwitch(local)` + `setActiveProfile(local)` + `clearRefreshTimer`。
  - `prior` 是账号 → `postSyncSwitch(prior)` + best-effort 重装 prior 会话（`refreshAndPersist(prior)` + `installSessionFor(prior)`，prior 密文未动仍可用）；重装失败兜底 `scheduleRefresh(priorExpiresAt)`（让稍后一 tick 自愈）。
- **抽共用件压重复**：`refreshAndPersist(profileId): {rotated, section}`（refresh + `updateProfileAuth` persist-first；dead/no-refresh → throw）+ `installSessionFor(profileId, rotated, section)`（postSyncSession + setActive + scheduleRefresh，假定 daemon 已在该库）。`switchToProfile` 账号分支 / `rollbackToPrior` 账号分支共用；（可选）`restoreSessionOnStartup` 亦可改用同一对 helper。复用既有 `postSyncSwitch`/`postSyncSession`/`scheduleRefresh`/`decryptB64`/`isRefreshDead`。

### 3.3 core 新增 by-id config helpers + 有效 active

现有 `clearSkybridgeAuth`/`updateActiveProfileAuth` 都只作用于 **active** profile；快切/回滚里 target 与 prior 多半**不是** active → 需要按 id 操作。三个新增（`config.ts` + `resolver.ts`，`index.ts` 导出）：

- **`updateProfileAuth(profileId, patch, path?)`**（**②persist-first 用**）：raw read-modify-write，只 patch `[profiles.<id>]` 的 `encrypted_token`/`encrypted_refresh_token`（present 的键才写），保 device/workspace/server_id/sibling，不动 `active_profile`。即 `updateActiveProfileAuth` 的 by-id 变体（后者保留给 refresh timer 主线，active 即 target 的常态）。
- **`clearProfileAuth(profileId, path?)`**（dead-refresh 标记用）：raw read-modify-write 清 `[profiles.<id>]` 的 `encrypted_token`/`encrypted_refresh_token`/`token`/`user_id`/`email`（保 device/workspace/server_id，§5.3 device 记忆不毁），不动 `active_profile`。即 `clearSkybridgeAuth` active 分支的参数化 id 版。
- **`readEffectiveActiveProfileId(path?): string`**（**⑤所有 active/prior 判断用**）：`resolver.ts` 新增 = `resolveActiveProfile(path)?.id ?? LOCAL_PROFILE`。resolver 三重 gate（id 是 hex / section 存在 / db 存在）任一缺 → 回退 local；**避免 raw `readActiveProfileId()` 把 ghost profile 标当前、点击 no-op、回滚到不存在 profile**。`buildProfiles`（§3.4）/`switchToProfile`（§3.2）/`deleteProfileLocalCopy`（§5.2）全用它。

### 3.4 IPC + 类型

- **shared 新文件 `sync-profiles-types.ts`**：
  ```
  ProfileSummary = { id; email: string | null; server_url: string | null;
                     is_active: boolean; can_quick_switch: boolean; db_missing: boolean }
  SyncProfilesReply = { active: string; profiles: ProfileSummary[] }   # profiles 含合成的 local 条目
  ```
  - `local` 合成条目：`{ id:'local', email:null, server_url:null, is_active: active==='local', can_quick_switch:true, db_missing:false }`。
  - 账号条目 **`can_quick_switch = hasRefreshToken && dbExists`**（⑦）；`db_missing = !dbExists`。三类不可快切：无 refresh（legacy）、db 缺失（ghost）、已是 active。popover 对前两类灰显；Settings 对 `db_missing` 显「本地副本缺失」（可删段 / 重新登录）。
- **GUI main `sync-ipc.ts`**：
  - `buildProfiles(): SyncProfilesReply` = `listProfiles()` + `readEffectiveActiveProfileId()`（⑤有效 active，非 raw）合成；缺省 'local'。ghost profile（toml 有段但 db 缺失）→ effective 不会指向它，故不会被误标当前。
  - `ipcMain.handle('sync:profiles', …)` → `safe<SyncProfilesReply>(buildProfiles)`（纯 toml 读，不打 daemon → 不会因 daemon down 失败；daemon down 时仍能列、切换时才报错）。
  - `ipcMain.handle('sync:switch-profile', async (_e, id) => { const reply = await safe(() => switchToProfile(id)); if (reply.ok) notifyProfileSwitched(); return reply; })` —— **成功即复用 16a reload**（切到 local 也 reload，回 local 视图）。
- **preload + `owl-api.d.ts`**：`owlAPI.sync.profiles()` / `owlAPI.sync.switchProfile(id)`。

### 3.5 renderer `SyncStatusBar.tsx` popover 账号列表

popover 详情视图（账号态 + local 态都显，**冷启动无 snapshot 态不显**——还没 daemon 信息）中部加「切换账号」段：

- Popover `onOpenChange(open)` → open 时 `owlAPI.sync.profiles()` 拉一次（仿 DevicesCard 首展开 fetch；popover 每次开都拉，账号列表轻、要反映最新登录态）。
- 列表区 `max-h-48 overflow-y-auto`，每行：
  - local 条目文案「本地独立工作区」；账号条目显 `email`（+ 灰 `server_url` 第二行可选）。
  - `is_active` 行：左侧 ✓ + 不可点（当前）。
  - 非 active + `can_quick_switch`：可点 → `owlAPI.sync.switchProfile(id)`；点击中 disabled + spinner；失败 inline 显 message（成功则整窗 reload，组件随之销毁，无需自更新）。
  - 非 active + `!can_quick_switch`：灰显不可点 —— `db_missing` → 提示「本地副本缺失」、`!hasRefreshToken` → 提示「需重新登录」，均点击跳 `设置 → 同步`（**绝不**从 popover 触发 `/sync/switch` 复活空库，⑦）。
- 段落标题「切换账号」；下方保留既有「管理账号 →」link + 17a「手动同步」按钮（账号态）。
- **W6/local 态也要能切**：`server_url === null`（本地态）的 popover 现在是纯说明，17b 给它也挂上同一账号列表（这样从 local 能一键切到已存账号）。即账号列表对 `snapshot !== null` 的两态（账号/local）都渲染。

### 3.6 测试（17b）

- core `listProfiles`：空文件/无 `[profiles]` → `[]`；多 profile → 全枚举；脏 id（非 hex）skip；`hasRefreshToken` 准确。`updateProfileAuth(id)`：只 patch 指定段密文、保 device/workspace/server_id/sibling、不动 active。`clearProfileAuth(id)`：清指定段密文、保 device/workspace/server_id、不动 active 与 sibling。`readEffectiveActiveProfileId`：active=hex 且 section+db 全在 → 返该 id；section 或 db 缺（ghost）→ `local`；active=local → `local`。
- main `switchToProfile`（mock daemon + SDK + fs + safeStorage）：
  - 切 local → `postSyncSwitch(local)` + `setActiveProfile(local)` + `clearRefreshTimer`，**不** revoke、**不**清 token。
  - 切账号（有 refresh）→ **进门 clearTimer** → refresh → **persist-first `updateProfileAuth(target)`（在 `postSyncSwitch` 之前调用，断言顺序）** → switch → install → `setActive(target)` → `scheduleRefresh(target.expiresAt)`。
  - **①timer 不串库**：切换中若构造 refreshSession 触发条件，断言它不会把 prior 的 session 装进 target（进门 clear + 无 active=target 之前的 fire）。
  - **②persist-first**：refresh 成功但随后 `postSyncSwitch`/`postSyncSession` 抛 → target 段已落新密文（断言 `updateProfileAuth` 已被调）→ 回滚后 target 仍可再快切。
  - dead refresh → 切库前抛 + `clearProfileAuth(target)` + daemon 未切（`postSyncSwitch` 未被调）+ `reschedulePrior`（prior=账号时 `scheduleRefresh(priorExp)`）。
  - install 失败（postSyncSession 抛）→ `rollbackToPrior`：prior=账号 时 `postSyncSwitch(prior)` + 重装 prior；prior=local 时切回 local + clearTimer。
  - `targetId === 有效 active` → no-op（**timer 不动**，断言 `clearRefreshTimer` 未被调）。
  - ghost active（toml active=hex 但 db 缺）→ prior 解析为 `local`，回滚走 local 路径（不回滚到 ghost）。
  - 无 refresh（legacy 段）→ `QuickSwitchNeedsLoginError`。
  - **⑩db 缺失硬闸**：toml 段有 refresh 但 `profiles/<id>/owl.db` 不存在 → `switchToProfile(id)` 失败（`ProfileDbMissingError`）、**不** refresh、**不** `postSyncSwitch`、**不**建空库（断言三个 mock 均未被调）。
  - **⑥早期失败重排 prior**：db 缺 / `readProfileSection` 缺字段 / 无 refresh / `updateProfileAuth` 写盘抛（`switched===false`）→ `reschedulePrior` 被调（prior=账号时 `scheduleRefresh(priorExpiresAt)`、prior=local 或 priorExpiresAt=null 时**不**调 `scheduleRefresh`）。断言 prior timer 未被永久停。
- main `buildProfiles`：合成 local 条目 + **有效 active** 标记（ghost 不被标当前）+ `can_quick_switch = hasRefreshToken && dbExists` 映射；**⑦db 缺失段 `can_quick_switch===false` + `db_missing===true`**（不可从 popover 快切）。
- renderer `SyncStatusBar`：popover 开拉 profiles、列表渲染（active ✓/不可点、非 active 可点、legacy 灰显）、点击调 `switchProfile`、滚动容器 `max-h`。`sync:switch-profile` 成功 reload 路径已被 16a 测试覆盖（此处只验 IPC 调用）。

---

## 4. 17c —— 移除设备 revoke（W9，设计 §13 W9 + §14.4）

> 目标：`DevicesCard` 给**非当前**设备加「移除」，远端 revoke（清孤儿/重装堆积的设备）。当前设备不可移除（Q4）。

### 4.1 daemon

- **`session.ts` `RealSkybridgeClient` 接口加 `revokeDevice(deviceId: string): Promise<void>`**（SDK `createSkybridgeClient` 返回的对象运行时已有此方法，client.d.ts:59；接口现缺声明，补上即透传）。`buildClient`/`adaptClient` 无需改（revoke 不经 runSync adapter）。
- **新路由 `POST /sync/revoke-device`**（`routes/sync.ts`，**紧贴 `/sync/devices` 后**，复用其错误处理范式）：
  ```
  app.post('/sync/revoke-device', async (req, reply) => {
    const deviceId = (req.body as {device_id?: unknown})?.device_id
    if 非 string/空 → fail 400 USAGE_ERROR
    try {
      session = ctx.skybridgeSession; if !session → throw SkybridgeAuthRequiredError(...)
      await session.realClient.revokeDevice(deviceId)
      ok(reply, { revoked: true })
    } catch (err) {
      translated = translateSkybridgeError(err)
      if translated instanceof SkybridgeAuthRequiredError → invalidateSkybridgeSession(ctx)
      fail(reply, statusForError, messageForError, codeForError)   # 与 /sync/devices 完全同款
    }
  })
  ```
  - **不**校验"是否当前设备"（前端已挡；daemon 层多一道也行但非必须——server 端 revoke 自己的 device 是合法操作，只是 UI 不暴露）。
  - **revoke 后不改本地状态**：当前 session 的 device 是另一台（前端只对非当前调），daemon 这边不需 invalidate（除非撞 401）。

### 4.2 GUI main

- `sync-ipc.ts`：`ipcMain.handle('sync:revoke-device', async (_e, deviceId) => safe(() => postRevokeDevice(deviceId)))`；`postRevokeDevice(deviceId)` = `fetch(POST /sync/revoke-device, {device_id})`，非 2xx 取 daemon envelope `.message`（已中文，仿 `buildDevices`）抛，fetch reject 包 `NetworkError`。**不** `notifyProfileSwitched`。
- preload + `owl-api.d.ts`：`owlAPI.sync.revokeDevice(deviceId): Promise<SyncIpcReply<{revoked:true}>>`。

### 4.3 renderer `DevicesCard.tsx`

- `DeviceRow` 非当前设备（`!is_current`）行右侧加「移除」按钮（ghost/destructive 小号）；当前设备**不渲染**移除按钮（Q4，旁可加 title「当前设备请用『退出登录』」）。
- 点击「移除」→ inline 二次确认（仿 `SyncSection` logout 的 inline「取消/确认移除」，不引第三方 confirm）→ `owlAPI.sync.revokeDevice(d.id)`：
  - 成功 → `void fetchDevices()` 重拉列表（被移除的行消失）。
  - 失败 → 行内显 `reply.message`（401 → 中文「请在设置中重新登录」）。
- 移除中该行 disabled + spinner。

### 4.4 测试（17c）

- daemon `routes/sync.ts`：`/sync/revoke-device` 成功 `{revoked:true}`；无 session → 401 `SKYBRIDGE_AUTH_REQUIRED`；SDK 401 → translate + `invalidateSkybridgeSession`；缺 `device_id` → 400。（仿现有 `/sync/devices` 测试。）
- main：`sync:revoke-device` 成功/失败映射；缺参/网络。
- renderer `DevicesCard`：非当前行有「移除」、当前行无；确认流程；revoke 成功后重拉；失败显 message。

---

## 5. 17d —— 删除账号本地副本（destructive，设计 §5.4.3 第三类动作）

> 目标：彻底移除某账号在**本机**的整库副本 + toml 段 + 远端 revoke（token-family + device）。二次确认。落 Settings"已保存账号"区，**不进 popover**。

### 5.1 core 新增 `deleteProfileDb(profileId)`

`packages/core/src/profile/` 或 `db/`：删 `profiles/<id>/owl.db` + `owl.db-wal` + `owl.db-shm`（各 `existsSync` 后 `unlinkSync`，缺失忽略）。**只删账号 profile 目录下的库**，`isHexProfileId` 校验（拒 `local`——绝不删 local 库，D10a）。`index.ts` 导出。可选连带 `rmdirSync(profiles/<id>/)`（空目录），失败忽略。

### 5.2 GUI main `deleteProfileLocalCopy(targetId)`

`sync-auth.ts` 新增 export。两路（active / 非 active），**句柄释放是硬前置、远端清理 device-first/logout-last**：

```
deleteProfileLocalCopy(targetId):                      # targetId 必为 hex（UI 不暴露删 local）
  section = readProfileSection(targetId)               # 删前读出密文/device 做远端清理
  wasActive = (readEffectiveActiveProfileId() === targetId)   # ⑤ 有效 active

  if wasActive:
    activeExpiresAt = currentExpiresAt                  # ⑧ 捕获，HTTP 失败中止时恢复
    clearRefreshTimer()
    # ④ 硬前置：daemon 必须真切走才删库。daemon 在线但 switch 失败 → 它可能仍持 target 句柄 → 中止删除。
    try {
      await postSyncSwitchStrict(LOCAL_PROFILE)         # 非 2xx/校验失败 → 抛 → 中止（不删库）
    } catch (err) {
      if (err instanceof NetworkError) { /* daemon 确不可达 → 无句柄持有，可继续删（session 已死，timer 保持停）*/ }
      else {                                            # ⑧ HTTP 500/503/校验失败 → 中止删除 + 恢复当前账号 timer
        if (activeExpiresAt != null) scheduleRefresh(activeExpiresAt)
        throw err
      }
    }
    setActiveProfile(LOCAL_PROFILE)                     # toml active → local（best-effort 后续）

  # 远端清理（best-effort；main 侧用 target 自己的密文，不经 daemon——daemon 此刻在 local/别账号）
  await bestEffortRevokeProfile(section)                # ③ device-first → logout-last
  deleteProfileDb(targetId)                             # 删本地整库（db+wal+shm）
  removeProfile(targetId)                               # 删 [profiles.<id>] toml 段（曾 active→active 兜底落 local）

  return { wasActive }
```

- **④句柄释放硬前置**：active 删除**只有 `postSyncSwitch(local)` 成功（daemon 真切到 owl/owl.db）或 daemon 明确不可达（`NetworkError`）**才往下删库。HTTP 500/503/校验失败 → **中止删除**并把错传给 UI（daemon 在线但没切走 → 可能仍持 target 句柄，删文件会留 -wal / 失败）。为此引入 `postSyncSwitchStrict()`：非 2xx 抛带 status 的 Error、fetch reject 包 `NetworkError`（让上面能区分"daemon 挂"vs"switch 报错"）。**不**用吞错的 `bestEffortSwitchLocal()`。
- **③/⑨ `bestEffortRevokeProfile(section)` device-first / logout-last，覆盖 refresh-only**（泛化 `remoteRevoke`，logout/delete 两路共用）：
  1. **拿一个可用 access**：解 `section.encrypted_token` 当 access；**access 缺失或过期、且 `encrypted_refresh_token` 可解 → 先 `skybridgeRefresh` 换新 access**（refresh-only profile 也能清远端，⑨）。**仅当 access 与 refresh 都不可用/不可解才跳过远端**（只本地删）。沿用现有 `remoteRevoke` 的"试 access → `TOKEN_EXPIRED` 落 refresh"骨架。
  2. **先** `revokeDevice(section.device.id)`（device 存在时）—— 必须在 logout 之前，因 `logout()` 作废 token-family 后同一 token 再调即 401（`skybridge-sdk-smoke.skybridge.e2e.ts` 已验）。
  3. **后** `logout()` 作废 token-family。
  - 全 best-effort：server 不可达/token 已死都吞，本地删照常（"删本机副本"语义 = 本机不再留它；远端清不掉是次要）。把现有 `remoteRevoke(cfg: SkybridgeConfig)` 泛化为吃 `{ serverUrl, user, encryptedAccess, encryptedRefresh, deviceId? }`，Settings 完全登出（无 deviceId，仅 logout）与删除副本（有 deviceId，device-first）复用同一主体。
- **非 active 删除**：daemon 在别处，target 库无句柄 → 直接 `bestEffortRevokeProfile` + `deleteProfileDb` + `removeProfile`，不切 daemon、不 reload。

### 5.3 IPC + renderer

- `sync-ipc.ts`：`ipcMain.handle('sync:delete-profile', async (_e, id) => { const reply = await safe(() => deleteProfileLocalCopy(id)); if (reply.ok && reply.data.wasActive) notifyProfileSwitched(); return reply; })` —— **仅删的是 active 时才 reload**（切到 local 视图）；删非 active 不 reload（当前账号视图不变，Settings 列表自更新）。
- preload + `owl-api.d.ts`：`owlAPI.sync.deleteProfile(id): Promise<SyncIpcReply<{wasActive:boolean}>>`。
- renderer `SyncSection.tsx` 新「已保存账号」管理区（仅当 `listProfiles` 经 `sync:profiles` 返回 >0 账号时显）：
  - 列出各账号 profile（email + server_url + 「当前」chip）；每行「删除本地副本」按钮（destructive）。
  - **⑦`db_missing` 行**：显「本地副本缺失」hint（ghost 段）；「删除本地副本」对其仍可用 —— `deleteProfileDb` 是 no-op（文件已无），`removeProfile` 清掉孤儿 toml 段 + `bestEffortRevokeProfile` 清远端。即这里也是清 ghost 段的入口。
  - 点击 → **强二次确认 Dialog**（shadcn `Dialog`，`showCloseButton` 留默认，文案见下）→ 确认 → `owlAPI.sync.deleteProfile(id)` → 成功重拉 profiles（行消失）；删的是当前账号则窗口随 16a reload。
  - 文案：「删除账号 {email} 在本设备的本地副本？将从此设备登出该账号、删除其全部本地笔记副本，并从同步服务器移除此设备。**此操作不可恢复**（账号在服务器及其他设备上的数据不受影响，可重新登录再次同步下来）。」
- **复用 `sync:profiles`**：管理区与 popover 同一数据源（`buildProfiles`）。Settings 区显**账号 profile**（过滤掉 local 合成条目；local 不可删）。

### 5.4 测试（17d）

- core `deleteProfileDb`：删 db+wal+shm（建临时三文件验删）；缺失忽略；`local`/非 hex 拒。
- main `deleteProfileLocalCopy`（mock daemon+SDK+fs）：
  - active → **`postSyncSwitchStrict(local)` 成功**（句柄释放序）→ revoke → `deleteProfileDb` → `removeProfile`，`wasActive:true`。
  - **④硬前置**：active 删除时 `postSyncSwitchStrict` 抛 **HTTP 错误（500/503/校验）→ 中止删除**（断言 `deleteProfileDb` **未**被调、错误上抛）；抛 **NetworkError（daemon 不可达）→ 继续删库**。
  - **⑧HTTP 中止恢复 timer**：active 删除 HTTP 失败中止 → `scheduleRefresh(activeExpiresAt)` 被调（当前账号续期恢复）；NetworkError 继续删 → timer 保持停。
  - 非 active → 不切 daemon → revoke + 删库 + removeProfile，`wasActive:false`。
  - **③device-first/logout-last**：断言 `revokeDevice(device.id)` 在 `logout()` **之前**调用。
  - **⑨refresh-only**：`encrypted_token` 缺失/过期但 `encrypted_refresh_token` 可解 → 先 `skybridgeRefresh` 拿 access 再 device-first/logout-last（断言 refresh 被调、远端未跳过）；access 与 refresh 都不可用 → 跳过远端、仍本地删。
  - revoke best-effort（SDK 抛）不阻断本地删库（非 active 路径或已确认无句柄时）。
- renderer `SyncSection`：已保存账号区渲染、删除确认 Dialog、调 `deleteProfile`、active 删除 reload 路径、删除后重拉。

---

## 6. 改动清单

| 片 | 仓/包 | 文件 | 改动 |
|---|---|---|---|
| 17a | gui main | `sync-ipc.ts` | `sync:run` handler + `postSyncRun()` |
| 17a | gui | `preload/index.ts` + `types/owl-api.d.ts` | `owlAPI.sync.run()` |
| 17a | gui shared | `sync-run-types.ts`(✚, 若需) | `RunSyncResult` 最小形状（或复用 daemon 现有） |
| 17a | gui renderer | `SyncStatusBar.tsx` | 账号态 popover 加「手动同步」按钮 + 头注释更新 |
| 17a | gui renderer | `SyncSection.tsx` | 已登录视图加 W5 提醒说明一行 |
| 17b | core | `skybridge/config.ts` + `profile/resolver.ts` + `index.ts` | `listProfiles()` + `ProfileListEntry` + `updateProfileAuth(id, patch)` + `clearProfileAuth(id)` + `readEffectiveActiveProfileId()` |
| 17b | gui main | `sync-auth.ts` | `switchToProfile(id)`（进门 clearTimer + refresh-first + persist-first + 切 local step-away + 精确回滚）+ 抽 `refreshAndPersist(id)` / `installSessionFor(id,…)` + `rollbackToPrior(prior, priorExp)` / `reschedulePrior` + `QuickSwitchNeedsLoginError` |
| 17b | gui main | `sync-ipc.ts` | `buildProfiles()` + `sync:profiles` + `sync:switch-profile`（成功 `notifyProfileSwitched`） |
| 17b | gui shared | `sync-profiles-types.ts`(✚) | `ProfileSummary` / `SyncProfilesReply` |
| 17b | gui | `preload/index.ts` + `owl-api.d.ts` | `sync.profiles` / `sync.switchProfile` |
| 17b | gui renderer | `SyncStatusBar.tsx` | popover 加「切换账号」列表（`max-h` 滚动，账号/local 两态都挂） |
| 17c | daemon | `sync/session.ts` | `RealSkybridgeClient` 接口加 `revokeDevice` |
| 17c | daemon | `routes/sync.ts` | `POST /sync/revoke-device`（仿 `/sync/devices`） |
| 17c | gui main | `sync-ipc.ts` | `sync:revoke-device` + `postRevokeDevice()` |
| 17c | gui | `preload/index.ts` + `owl-api.d.ts` | `sync.revokeDevice(id)` |
| 17c | gui renderer | `DevicesCard.tsx` | 非当前设备行「移除」+ inline 二次确认 + revoke 后重拉 |
| 17d | core | `profile/delete.ts`(✚) 或 `db/` + `index.ts` | `deleteProfileDb(id)`（db+wal+shm，拒 local/非 hex） |
| 17d | gui main | `sync-auth.ts` | `deleteProfileLocalCopy(id)`（硬切 local 前置）+ `postSyncSwitchStrict()` + 泛化 `remoteRevoke`→`bestEffortRevokeProfile(section)`（device-first/logout-last） |
| 17d | gui main | `sync-ipc.ts` | `sync:delete-profile`（active 删才 `notifyProfileSwitched`） |
| 17d | gui | `preload/index.ts` + `owl-api.d.ts` | `sync.deleteProfile(id)` |
| 17d | gui renderer | `SyncSection.tsx` | 「已保存账号」管理区 + 删除二次确认 Dialog |
| 17a-d | gui renderer | `test-setup.ts` + `MigrationDialog.test.tsx` | 两处 owlAPI stub 同步加 `sync.{run,profiles,switchProfile,revokeDevice,deleteProfile}`（[[infra gotchas]] 提醒：扩 sync.* 两处都要补，否则 typecheck/render 挂） |

---

## 7. 验收

- **每片**：`pnpm -r build` → `just check`（8 守卫，**含 `daemon-no-toml-write`**——17b/17d 写 toml 全在 GUI main、daemon 不碰）→ `just test`（单测全包）→ `SKYBRIDGE_E2E=1 just test-skybridge-e2e`（gated e2e 16/16）全绿。
- **17a 真机**：账号态 popover 显「手动同步」→ 点击触发一轮 sync（daemon.log `kind:'sync'`）；local 态/无 snapshot 态不显该按钮。
- **17b 真机**（隔离 nest + 真 0.1.4 server + 两账号 A/B + local，rig recipe 见 [[next session brief]]/[[skybridge local-dev workflow]]）：
  - local 起 → popover 列「本地 + A + B」→ 点 A → **免密**切到 A、窗口自动 reload 显 A 笔记；server 仍 1 device（device 复用，不堆积）。
  - A → 点 B → 免密切 B、reload；A 的 `[profiles.<A>]` token **保留**（切回 A 仍免密）。
  - 切回「本地」→ reload 回 local 视图、A/B token 都还在（step-away 不 revoke）。
  - dead refresh 模拟（手改 toml 密文为废值或 server 端 revoke family）→ 点该账号 → 报「请在设置中重新登录」、daemon 未切走、当前会话不受扰。
- **17c 真机**：A 的设备列表（jay@local 真机有多孤儿行）→ 非当前行「移除」→ 确认 → server change/device 行消失、列表重拉少一行；当前行无移除按钮。
- **17d 真机**：Settings"已保存账号"显 A/B → 删 B（非当前）→ B 段从 toml 消失、`profiles/<B>/owl.db` 删除、server 端 B 的 device revoke；删 A（当前）→ 先切 local + reload + A 段消失 + 库删 + 远端清理；**`owl/owl.db`（local）始终原样**（D10a/D10b）。

---

## 8. 不做 / 推迟

| 项 | 落点 |
|---|---|
| 手动 SSE reconnect 按钮 | 不做（SSE 永久退避 cap 30s 自愈；W8 只要 action，§13） |
| `resetAllStores(epoch)` 软重置（免整窗 reload 闪烁） | 0.6（16a 整窗 reload 沿用） |
| 跨账号导入 / local→非空账号显式导入 | 0.6+（§5.5 末） |
| 跨 profile 统一搜索/收件箱 | 0.6+（§8.2） |
| `conflict_record` counter 列 + 冲突双向可见 | 0.6/W7（16c 已记） |
| CLI `owl profile use` / CLI 快切 | 不做（D7' CLI 只跟随 active；CLI compat 收尾在 Phase 21） |
| OS 级硬件 fingerprint device 复用 | 不做（§5.3 末，未来可选） |
| 删除副本时对 orphan 库做 op 手术 | 不做（整库删除，无需手术） |
| skybridge 任何改动 | **不需要**（0.1.4 已具 `refresh`/`revokeDevice`/`getServerTime`/`server_id`） |

---

## 9. 实施记录

（待实施后回填：commit、验收基线、与设计偏差、真机手测。）
