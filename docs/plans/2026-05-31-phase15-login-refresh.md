# Phase 15 子设计 —— 登录 / 切换 / 登出（live profile flip + refresh-token 流）

> 父设计：`2026-05-29-account-profile-isolation-design.md`（**v6 定稿，§0.5 + §5.4.1/§5.4.3 + §9 D2/D11 + §14 权威**）。
> 前置（均落 main）：Phase 12 resolver 地基 ✅ + Phase 13 存储/adapter（dormant writer）✅ + Phase 14 `switchProfile`（plumbing-only）✅ + Phase S skybridge 0.1.4（skybridge 仓本地 commit，未 push/publish）✅。
>
> **本阶段是「live 翻转」**：Phase 12-14 全是 plumbing-only（建能力、不接生产路径）。Phase 15 第一次把它们串成真实登录链路。
>
> **形态拍板（2026-05-31，用户两问确认）**：
> - **SDK 接入 = publish 0.1.4 `@next` 三包，owl bump 到 0.1.4**。skybridge 仓 `just publish`（默认 `--tag next`）发 proto/client/server@0.1.4@next；owl daemon+gui dep 从 `^0.1.3` 改 `0.1.4`。`latest` 仍停 0.1.3，Phase 19 阿里云部署时 `just promote-latest`。clean npm install 规避 better-sqlite3 ABI 串台（不走本地 link）。
> - **plumbing 风格 + 切 15a / 15b 两片**：GUI 受控 renderer reload 与「认领空账号」弹框留 Phase 16；本阶段 backend（daemon + GUI main）链路全做 + 单测/e2e/curl 验收。GUI 实时切换的视觉残留留 Phase 16 收。

---

## 0. 一句话

把登录从「单租户、写顶层 `[auth]`」翻成「per-profile：`login() → profileId=hash(server_id,user_id) → 切到 profiles/<id>/owl.db → 装 session → 写 [profiles.<id>]+active_profile`」，并引入 refresh-token（轮换）让重进 profile / 短 access 过期都能免密续。device 跨 logout 复用（§5.3）。**daemon 永不碰 keychain / 永不写 toml**（沿用 Phase 7/10 不变式）；GUI main 独占 SDK login + 密文 + toml 写。

---

## 1. 决策落点（本阶段照此，无歧义）

| 决策 | 落点 |
|---|---|
| **D11** profileId 锚 server_id | `computeProfileId(server_url,userId)` → `computeProfileId(serverId,userId)` = `sha256(serverId + "\n" + userId).slice(0,32)`。`normalizeServerUrl` 留作 url 存储/显示/去重，**退出** profileId。 |
| **R5** server_id 硬要求 | `login()` 回的 `serverId` 缺失（连到 0.1.3 老 server）→ **报错**「需要 skybridge 0.1.4 server」，**绝不**回退 url-key。 |
| **§5.3** device 复用 | 切到目标 profile db 后读 `local_metadata.skybridge_device_id`：有 → 复用、跳过 registerDevice；无（新库）→ registerDevice。 |
| **D2** token 生命周期 | 存 `encrypted_refresh_token`（keychain）。切换/停用**不 revoke、留 token**；完全登出才 revoke（client.logout 撤 refresh family）。 |
| **B9** 登录顺序 | login → profileId → switch → install（device 复用/register + ensureWorkspace + 注入 + sync）→ 写 toml。**Phase 15 无「认领 local」分支**（留 16）：目标库不存在 = 纯拉取/空起步，由 `switchProfile` 的 `createDatabase` 直接建空库。 |
| **§5.9 / R1** 机密 redact | 新字段 `encrypted_refresh_token` → 加 redact glob `*.profiles.*.encrypted_refresh_token` + 更新 logger redact 测试。 |

**refresh 续期编排（拍实：proactive timer in GUI main，不走 daemon event channel）**：
- **为什么不 reactive event**：daemon SSE 的订阅者是 **renderer 不是 main**（`events-subscriber-core.ts`），且 status union 只有 `idle/syncing/error/offline`、renderer 显式丢未知 state（events-subscriber-core.ts:103）。要 reactive 就得：扩 union + 改 renderer 不丢 + 新 preload IPC `sync:refresh-session` 转给 main——还在 window 关闭时断链。
- **改为 main 自持定时**：main 在 login/restore/每次 refresh 后都拿到 `expiresAt`，按 `expiresAt − margin`（如 60s）设 timer；触发即解密 `encrypted_refresh_token` → `refresh()` → 轮换密文落盘 → `POST /sync/session` 重装新 access → 用新 `expiresAt` 重排。**无需碰 events union / renderer / 新 IPC**。补一个 app resume/focus 重校（睡眠唤醒后 timer 可能迟到 → 立刻补刷）。
- **daemon 侧 15b 不改**：proactive 下 daemon 基本撞不到 `TOKEN_EXPIRED`；万一撞到（错钟/漏 timer）走现有 401 路径（invalidate + 现有 status），main 的 timer/resume 重校兜底；refresh 真失效（`REFRESH_INVALID/REPLAYED`）→ main 回退未认证、用户重输密码。把 `TOKEN_EXPIRED` 映射成更软的非致命 status 属 polish，15b 不做。
- **已知取舍（接受、记 release notes）**：app **完全退出**超过 access TTL 后 daemon 后台 sync 停到下次启动（只有 main 能解密 refresh_token，daemon 永不碰 keychain）；仅关窗口（app 仍活）main timer 照刷。缓解：自托管单用户 server 把 access TTL 配宽（refresh 主要服务轮换/吊销）；daemon 自刷新留 0.6+（破 Phase 7 安全模型，不做）。

---

## 2. 前置步骤 S15 —— skybridge 0.1.4 publish @next + owl bump（15a 开工前）

> 跨仓。**npm publish 不可逆**，由用户确认后执行（或用户自跑 `just publish`）。

1. skybridge 仓：确认 Phase S 7 commit 在 `main`；`pnpm -r build`（e2e 测 dist，**必须先 build**，否则假绿）→ `just check`（lint+tsc+redocly）+ `just test`（109）全绿。
2. `just publish`（默认 `--tag next`）发 `@orpheus-aviary/skybridge-{proto,client,server}@0.1.4` 到 npm `next` tag。**不** `promote-latest`（留 Phase 19）。
3. owl：`packages/daemon/package.json` + `packages/gui/package.json` 的 `@orpheus-aviary/skybridge-{client,server,proto}` 从 `^0.1.3` → `0.1.4`（精确，因 @next 不在 latest）；`pnpm install` → node_modules 落 0.1.4。
4. owl 冒烟：`pnpm -r build` + `just check` + `just test`（含 `SKYBRIDGE_E2E=1`，验证 daemon e2e 动态 import 的 server 已是 0.1.4 + 现有 16 e2e 仍绿）。**ABI 自检**：daemon 进程内 spawn 的 skybridge-server better-sqlite3 是 Node ABI（非 Electron），clean install 后应无 ABI 报错。

---

## 3. 15a —— live profile flip on login（identity + switch + install + toml；无 refresh 使用）

> 目标：登录把隔离**真正打开**——切到 per-profile 库、装 session、写 `[profiles.<id>]`+active_profile、device 复用、logout 切回 local。refresh-token 此片**只存不用**（restore/中段仍走 access，15b 接）。

### 3.1 core：`computeProfileId` 翻 server_id

- `packages/core/src/profile/id.ts`：`computeProfileId(serverId: string, userId: string)` = `sha256(serverId + "\n" + userId).slice(0,32)`。删 url 归一化进 id 的部分；`normalizeServerUrl` 保留（url 存储/去重用，独立导出）。
- 更新 Phase 12 单测（原断言 `computeProfileId(url,user)`）→ `computeProfileId(serverId,user)`。
- 无其它 live caller（resolver 用 raw `active_profile`，不调 compute）→ 翻签名安全。

### 3.1-bis core config：把 `encrypted_refresh_token` 穿透整条 adapter（**关键，否则 restore 读不到**）

光给 `ProfileConfigSection` 加字段不够——adapter 把 flat profile section 经 `profileSrc`→`ConfigSource`→`assembleConfig` 映成 `SkybridgeConfig.auth`，不在链上每一环加字段就被丢。`packages/core/src/skybridge/config.ts` 一并加 `encrypted_refresh_token?`：
- 类型：`SkybridgeAuthSection`(:50)、`ProfileConfigSection`(:100)、`RawProfileSection`(:113)、`RawConfig.auth`(:128)、`ConfigSource.auth`(:141)
- 组装：`profileSrc()`(:197) 把 `section.encrypted_refresh_token` 灌进 `auth`；`legacySrc()`(:212) 随 `RawConfig.auth` 自动带（legacy 实际无此字段，对称即可）；`assembleConfig()`(:221) 把它写进 `config.auth`（与 `encrypted_token` 同处条件落字段）
- **token gate(:229) 要含 refresh**：现 `hasAnyToken = token || encrypted_token` → 改 `token || encrypted_token || encrypted_refresh_token`。否则 refresh-only（access 被清/过期但 refresh 还在）的 profile 整个 `auth` 被丢，restore 读不到 refresh。
- **`clearSkybridgeAuth()`(:449) 完全登出要清它**：现仅清 `encrypted_token/token/user_id/email`，残留 refresh 与 D2「完全登出 revoke」冲突 → 加 `section.encrypted_refresh_token = undefined`（active profile 分支）。
- **新 `updateActiveProfileAuth({ encrypted_token?, encrypted_refresh_token? })`（refresh 轮换写回必需）**：`readSkybridgeConfig` 返回的 `SkybridgeConfig` **不含 `server_id`**，`writeProfileConfig` 又是整段替换 → 直接用它轮换会丢 `server_id`/sibling。新增一个 raw patch helper（仿 `clearSkybridgeAuth` 的 `resolveActiveProfile` + `mutateConfigFile`），**只**改 active profile 段里给定的密文字段、保留 `server_id`/`device`/`workspace`/sibling profiles。login（step 6 全段写）走 `writeProfileConfig`，refresh 轮换走 `updateActiveProfileAuth`。
- **新 `readProfileSection(profileId): ProfileConfigSection | null`（按 id 的 raw reader，与 `writeProfileConfig` 对称）**：读**指定** profile 段（不限 active），给 device 复用取旧 `device` meta 用（reuse 时目标 profile 尚未在 toml active，`readSkybridgeConfig` 取不到它）。raw parse → 映射 `RawProfileSection`→`ProfileConfigSection`，缺失/无段返回 null。
- 测试：`config.profile.test.ts` 加「写 `encrypted_refresh_token` → `readSkybridgeConfig` 读回 `auth.encrypted_refresh_token`」+「refresh-only 段（无 encrypted_token）→ `auth` 仍在（gate 含 refresh）」+「`updateActiveProfileAuth` 只改密文、`server_id`/device/workspace/sibling 不动」+「`clearSkybridgeAuth` 后 refresh 字段消失、device/workspace/server_id 留存」。

### 3.2 daemon：新 `POST /sync/switch`（切库 + 回 existing device_id）

新路由（`packages/daemon/src/routes/sync.ts`）：`POST /sync/switch { profile_id }`：

```
profile_id === 'local' → targetDbPath = localProfileDbPath()
profile_id 是 32-hex     → targetDbPath = profileDbPath(profile_id)
                           mkdirSync(dirname(targetDbPath), { recursive: true })   # ★ 见下
否则                     → 400 USAGE_ERROR
{ warnings } = await switchProfile(ctx, targetDbPath, ctx.logger)   # Phase 14 既有
existing_device_id = readSkybridgeDeviceId(ctx.sqlite)              # core identity.ts，新库=null
ok(reply, { device_id: existing_device_id, warnings })
```

- **★ 新 profile 目录必须先建**：`createDatabase` 直接 `new BetterSqlite3(dbPath)`，**不建父目录**（db/index.ts:43）；`profileDbPath(id)` = `owl/profiles/<id>/owl.db`（paths.ts:48）首次登录新账号目录不存在 → `SQLITE_CANTOPEN`。switch 前对 hex profile `mkdirSync(dirname(targetDbPath), { recursive: true })`。（local 库目录 `owl/` 已存在，免 mkdir。）测试覆盖「`profiles/<id>` 目录不存在 → switch 成功建库」。
- **core 补 export**：`readSkybridgeDeviceId` 现未从 `@owl/core` root 导出（index.ts:199 只导 `clearSyncIdentity`/`persistSkybridgeIds`）→ 加 `readSkybridgeDeviceId` 到 `skybridge/identity.js` 导出行。

- **switch gate 自指死锁修（Phase 14 遗留给 15）**：Phase 14 的 server.ts hook 对**所有** mutating 请求 `trackMutation`；`/sync/switch`（POST）若被计数 → `switchProfile` 内 `runExclusive`→`drainMutations` 会等自己这条请求归零 → **死锁**。修：hook 给 `/sync/switch` 单独处理 —— `isSwitching()` 为真 → 503（拒并发切换）；否则**放行但不 `trackMutation`**（它就是切换发起者）。单点改 hook，加一个 path 豁免集。
- `switchProfile` resolve=committed/throw=abort（Phase 14 契约）：throw（PREPARE abort，旧 profile 没动）→ 路由回 5xx，main 不写 toml；resolve → 即使有 warnings 也已切到新库。

### 3.3 GUI main：`loginAndOpenSession` 翻 per-profile

`packages/gui/src/main/sync-auth.ts`，新顺序（B9）：

```
1. auth = skybridgeLogin(serverUrl, email, password)          # 0.1.4：auth.{token, refreshToken, expiresAt, serverId, user}
2. if (!auth.serverId) throw 'requires skybridge 0.1.4 server' # R5
   profileId = computeProfileId(auth.serverId, auth.user.id)   # D11
3. { device_id: existing } = POST daemon /sync/switch { profile_id: profileId }   # 切到 profiles/<id>/owl.db（新库自动建）
4. device 解析（§5.3）：
     existing ? 复用：deviceId=existing；**device meta 先读旧段、缺失再合成**（local_metadata 只有 id，daemon /sync/session 校验要 id+name；目标 profile 此刻还没在 toml active → 用按 id 的 raw reader，非 readSkybridgeConfig）：
                  sec = readProfileSection(profileId)                                 # §3.1-bis 新 raw reader
                  device = sec?.device ?? { id: existing, name: defaultDeviceName(), app_version:`owl ${OWL_APP_VERSION}`, client_version: CLIENT_VERSION }
                  （读到旧名 → 忠实保留用户/历史设备名；缺失 → 合成。name 仅显示、§5.3）
              : seed=createSkybridgeClient({authContext:auth}); device=seed.registerDevice({name:defaultDeviceName(),…})
   ws = createSkybridgeClient({authContext:auth, deviceId}).ensureWorkspace('owl','default')   # 复用/新建都重新 ensureWorkspace（幂等）
5. POST daemon /sync/session { token: auth.token, user_id, email, server_url, device, workspace }   # 既有路由，装在已切好的库上
6. 写 toml（profile writer，main 独占）：
     enc      = safeStorage.encryptString(auth.token).b64           # access（15a restore 仍用）
     encRefr  = auth.refreshToken ? safeStorage.encryptString(auth.refreshToken).b64 : undefined
     writeProfileConfig(profileId, {
       server_id: auth.serverId, server_url: normalizeServerUrl(auth.serverUrl),   # 归一化后存（去重/显示一致）
       user_id, email,
       encrypted_token: enc, encrypted_refresh_token: encRefr, device, workspace,
     }, { setActive: true })                                        # setActive 前置 db 存在闸已被步骤 3 满足
```

- 失败回滚（**保留现有 unwind 语义**，sync-auth.ts:155-159）：步骤 1 之后任一步抛 → `await bestEffortRemoteLogout(auth)`（撤掉刚 login 的 access + refresh family，**否则留孤儿 token**）；步骤 3 之后还要 main `POST /sync/switch { profile_id: 'local' }` 切回 local（daemon 清 session）；**不写 toml**。（步骤 1 之前抛 → 啥都没动。）精确回滚到「上一个 active profile」留 17，15a 先回 local（最稳）。
- `ProfileConfigSection` 已有 `server_id?`/`encrypted_token?`（Phase 13），加 `encrypted_refresh_token?` 字段。

### 3.4 GUI main：logout = 完全登出（切回 local，留 db/device 记忆）

`sync-auth.ts` `logout()`（D2「完全登出」语义；「停用/快切保留 token」留 Phase 17 下拉）：

```
cfg = safeReadConfig()                       # 读 active profile 视图
# 远端撤 family（D2）—— access 可能已过期，撤前先用 refresh 换新 access（否则 logout 撞 TOKEN_EXPIRED，本地清了远端 refresh family 还活）
remoteRevoke():
  access = decrypt(cfg.auth.encrypted_token)
  try { client(access).logout() }                              # 正常：撤 access + refresh family
  catch (TOKEN_EXPIRED) if cfg.auth.encrypted_refresh_token:   # access 过期 → 先 refresh 换新 access 再撤
    try { { token } = await refresh(serverUrl, decrypt(refresh)); client(token).logout() }
    catch (REFRESH_INVALID|REFRESH_REPLAYED) { /* family 已亡，远端无需再撤 */ }
    catch (net) { /* 网络未知 → 尽力而为，可能留远端孤儿；本地登出照常 */ }
  catch (net) { /* 同上：best-effort，登出仍继续本地清理 */ }
  # 注意：logout 是用户主动退出 → 不论远端结果如何都继续下面本地清理（与今 bestEffortRemoteLogout 一致）
POST daemon /sync/switch { profile_id: 'local' }   # 切回 local + 清 in-memory session（switchProfile 自带 skybridgeSession=null）
clearSkybridgeAuth()                          # 清 active profile 密文（含 encrypted_refresh_token，§3.1-bis）；留 device/workspace/server_id + sibling
setActiveProfile('local')                     # active → local
# 不跑 clearSyncIdentity（保 db 内 skybridge_device_id，§5.3 device 复用）；不删 [profiles.<id>] 段（删副本=Phase 17 destructive）
```

- `/sync/logout-local`（既有，跑 `clearSyncIdentity`）**15a 起不再由 GUI logout 调**——它会删 db device 记忆，毁复用。保留路由给「删除账号本地副本」(Phase 17)。

### 3.5 daemon boot：已就绪，确认

- Phase 12 已让 `cli.ts` boot 走 `resolveActiveProfileDbPath()` → 写了 active_profile + 建了 db 后，daemon **重启**自动 boot 进该 profile 库（无需 switch）。15a 不改 boot；live 登录走 §3.2 switch。

---

## 4. 15b —— refresh-token 生命周期（restore + 中段续期 + 轮换 + redact）

> 目标：短 access 过期/重启都免密续；refresh 每次轮换；失效才回退密码。

### 4.1 restore-on-startup 改 refresh-first

`sync-auth.ts` `restoreSessionOnStartup()`：

```
cfg = safeReadConfig()                        # active profile 视图（daemon boot 已在该库）
if (cfg.auth?.encrypted_refresh_token 可解密):
   refreshTok = decrypt(cfg.auth.encrypted_refresh_token)
   try { { token, refreshToken, expiresAt } = await skybridgeRefresh(serverUrl, refreshTok) }   # 0.1.4 独立函数
   catch (REFRESH_INVALID|REFRESH_REPLAYED) { → 未认证（token 真死，不再循环；用户重输密码） }
   catch (net) { → 留 refresh 不动、显示 offline/稍后重试（网络未知，绝不清 token） }
   updateActiveProfileAuth({ encrypted_token: enc(token), encrypted_refresh_token: enc(refreshToken) })  # §3.1-bis：轮换落盘、保 server_id/sibling
   POST /sync/session { token, device, workspace, … }            # 装新 access，daemon 已在 active 库（无需 switch）
   scheduleRefresh(expiresAt)                                     # §4.2
else if (cfg.auth?.encrypted_token 可解密): 走 15a 的 access 路径（兼容，无 refresh 的旧 toml）
```

### 4.2 续期触发 = GUI main 自持 proactive timer（不碰 daemon event channel）

> 定死（取代原 reactive-event 方案）：daemon SSE 订阅者是 renderer 非 main，且 status union（`idle/syncing/error/offline`，events/types.ts:36 / api.ts:418）renderer 会丢未知 state（events-subscriber-core.ts:103）——reactive 要扩 union + 改 renderer + 新 IPC 还断窗口。改 main 自持定时：

- `sync-auth.ts` 加 `scheduleRefresh(expiresAt)`：先 `clearRefreshTimer()`，再按 `expiresAt − margin`(60s) `setTimeout` → `refreshSession()`（单例 timer handle，模块级）。login（15a 拿到 `auth.expiresAt`）、restore（§4.1）、每次 refresh 后都重排。
- `refreshSession()`（与 restore 共用 refresh→install helper）：解密 `encrypted_refresh_token` → `refresh()` → `updateActiveProfileAuth` 轮换落盘 → `POST /sync/session` 重装（daemon 已在 active 库，无 switch）→ `scheduleRefresh(新 expiresAt)`。`REFRESH_INVALID/REPLAYED` → `clearRefreshTimer()` + 未认证；`net` → 不清 token、短延迟重排（offline 重试）。
- **timer 生命周期**：`logout()` 调 `clearRefreshTimer()`（连同切 local）；登录/restore 成功才 `scheduleRefresh`。
- **resume/focus 补刷**：`powerMonitor.on('resume', …)`（睡眠唤醒，timer 可能迟到）+ `app.on('browser-window-focus', …)`：若已近/过期且有 refresh → 立即 `refreshSession()`（去抖，避免 focus 连发）。
- **daemon 不改**：proactive 下基本撞不到 `TOKEN_EXPIRED`；万一撞到走现有 401 路径（invalidate + 现 status），main timer/resume 兜底。不扩 union、不动 renderer、不加 IPC。

### 4.3 redact + 测试

- 给 logger redact globs 加 `*.profiles.*.encrypted_refresh_token`（Phase 12 加 `*.profiles.*.encrypted_token` 的同一处）；更新 logger redact 单测。
- `just check` 的 token 守卫（`token-not-templated` / `session-body-not-logged`）覆盖 refresh_token 不进 log/模板（refresh_token 同样不许字符串拼接进日志）。

---

## 5. 改动清单

| 仓/包 | 文件 | 改动 | 片 |
|---|---|---|---|
| skybridge | — | `just publish --tag next` 0.1.4 三包 | S15 |
| owl | `packages/{daemon,gui}/package.json` | skybridge dep `^0.1.3` → `0.1.4` | S15 |
| core | `profile/id.ts`(+test) | `computeProfileId(serverId,userId)`；`normalizeServerUrl` 留 url 用 | 15a |
| core | `skybridge/config.ts`(+test) | `encrypted_refresh_token?` 穿透 Auth/Profile/Raw/ConfigSource/profileSrc/assembleConfig + token gate 含它（§3.1-bis）；`clearSkybridgeAuth` 清它；**✚ `updateActiveProfileAuth()`**（轮换 raw patch，保 server_id/sibling）；**✚ `readProfileSection(profileId)`**（按 id raw reader，device 复用用） | 15a |
| core | `index.ts` | export `readSkybridgeDeviceId`（现仅导 clearSyncIdentity/persistSkybridgeIds） | 15a |
| daemon | `routes/sync.ts`(✚`/sync/switch`) | hex profile 先 `mkdirSync(dirname)` → switch → 回 `device_id`；local/hex 校验 | 15a |
| daemon | `server.ts` | switch-gate hook 加 `/sync/switch` 豁免（isSwitching→503 / 否则放行不计数），修自指死锁 | 15a |
| gui main | `sync-auth.ts` | `loginAndOpenSession` 翻 per-profile（B9 + device 复用 + normalize url + writeProfileConfig/setActive）；失败 unwind 保留 `bestEffortRemoteLogout`+回 local；`logout` revoke-with-refresh-fallback + 切 local（D2） | 15a |
| gui main | `sync-ipc.ts` | 确认 extractSession/buildStatus 读 active profile 视图（Phase 13 adapter 已透明，无硬编码顶层 auth） | 15a |
| core | logger redact + test | 加 `*.profiles.*.encrypted_refresh_token` | 15b |
| gui main | `sync-auth.ts` | `restoreSessionOnStartup` refresh-first（`updateActiveProfileAuth` 轮换落盘）+ `refreshSession()`/`scheduleRefresh()`/`clearRefreshTimer()` 单例 proactive timer + `powerMonitor`resume/`browser-window-focus` 补刷；logout 清 timer | 15b |
| daemon | — | **不改**（proactive 续期在 main；daemon 撞 `TOKEN_EXPIRED` 走现有 401 兜底） | 15b |

---

## 6. 测试

**15a**
- core `id.test.ts`：`computeProfileId(serverId,userId)` 确定性 + 与 url 无关（换 url 同 server_id 同 id；换 server_id 异 id）。
- core `config.profile.test.ts`：`encrypted_refresh_token` round-trip（写入 → `readSkybridgeConfig` 读回 `auth.encrypted_refresh_token`）；**refresh-only 段（无 encrypted_token）→ `auth` 仍在**（gate 含 refresh）；**`updateActiveProfileAuth` 只改密文、server_id/device/workspace/sibling 不动**；`clearSkybridgeAuth` 后 refresh 密文消失、device/workspace/server_id + sibling 留存。
- daemon `sync.test.ts` / 新 e2e：`POST /sync/switch {hex}` → 切库 + 回 null（新库）；**`profiles/<id>` 目录不存在 → switch 成功建目录+库**（mkdir 回归）；预种 `skybridge_device_id` 的库 → 回该 id；`{local}` → 切回 local；非法 id → 400。**死锁回归**：switch 期间并发 mutating → 503；`/sync/switch` 自身不被 gate 卡死（能跑完）。
- gui main `sync-auth` 单测（mock daemon + mock SDK）：login → 调 `/sync/switch`、existing device_id → **复用：`readProfileSection().device` 读到则用、缺失合成(name=defaultDeviceName())，不调 registerDevice** / null → register、写 `writeProfileConfig(setActive)`（断言 toml 落 `[profiles.<id>]` + active_profile + server_id（已 normalize）+ 两密文）；`serverId` 缺失 → 抛 R5；中途失败 → `bestEffortRemoteLogout` 被调 + 切回 local + 不写 toml。logout → revoke（含 access 过期 → refresh-then-logout 分支；net 失败仍继续本地清理）+ 切 local + clearSkybridgeAuth + `clearRefreshTimer`（断言 device/workspace/server_id 保留、refresh 密文清掉、active=local）。
- **gated e2e**（`just test-skybridge-e2e`，in-process 0.1.4 server）：真打 login → 切库 → registerDevice → ensureWorkspace → sync 拉/推走 `profiles/<id>/owl.db`；二次 login 同账号 → 复用 device（不新增 server device 行）。

**15b**
- gui main `restoreSessionOnStartup`：有 refresh → refresh 成功装 session + 轮换密文落盘 + 排下次 timer；refresh 抛 `REFRESH_REPLAYED`/`REFRESH_INVALID` → 回退未认证（不崩、停排）。
- gui main `scheduleRefresh`/`refreshSession`（fake timers）：近 `expiresAt` 触发 → refresh→轮换→`/sync/session` 重装→用新 `expiresAt` 重排；refresh 失败 → 停排 + 未认证。
- redact：含 `encrypted_refresh_token` 的对象过 logger → 字段被盖；`just check` token 守卫绿。
- **gated e2e（续期）**：access 过期后 main proactive refresh → 续传成功；轮换后旧 refresh 重放 → server `REFRESH_REPLAYED`。

**两片共同验收**：`pnpm -r build`（含 skybridge 0.1.4 dist）→ `just check`（8 守卫，含 `daemon-no-toml-write` —— **/sync/switch 不写 toml**、toml 仍只 GUI main 写）→ `just test`（单测全包）→ `just test-skybridge-e2e`（gated e2e，独立 recipe）全绿。

---

## 7. 验收

- 真机金路径（手动，GUI）：local 起步 → 登录账号 A（0.1.4 本地 dev server）→ daemon.log 见切库 + session 装好 + sync；toml 出 `[profiles.<idA>]` + `active_profile`；`profiles/<idA>/owl.db` 生成。logout → active 回 local、db/section 保留。重登 A → 复用 device（server 设备列表不增行）。重启 GUI → restore 用 refresh 免密续（15b）。
- **Phase 15 不做视觉隔离收尾**：登录后 renderer 可能仍显旧 local 笔记（受控 reload 留 16）——手动验收以 daemon.log + toml + db + server 设备列表为准，GUI 视觉残留记为已知、Phase 16 闭环。

---

## 8. 不做 / 推迟

| 项 | 落点 |
|---|---|
| 认领空账号弹框（local→账号 copy 并入，§5.5/D10b/B2） | Phase 16 |
| 受控 renderer reload / resetAllStores（B7，§5.4.4） | Phase 16（精修 0.6） |
| LWW 时间戳 server 归一化 + counter（W3，`getServerTime` 接入） | Phase 16 |
| GUI 侧栏免密快切下拉 / 「停用保留 token」/ 移除设备 revoke / 状态 popover 手动同步（W4/W8/W9） | Phase 17 |
| 删除账号本地副本（destructive，删 db + 段 + 远端 revoke）/ `clearSyncIdentity` 复用 | Phase 17 |
| 精确回滚到「上一个 active profile」（15a 失败只回 local） | Phase 17 |
| daemon 自刷新（GUI 关闭也能续 access） | 0.6+（破 Phase 7 安全模型，不做；缓解=server access TTL 配宽） |
| npm `promote-latest`（0.1.4 转 latest）+ 阿里云部署 | Phase 19 |
