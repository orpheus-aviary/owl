# 开发进度

## 当前阶段：P5-d per-profile 隔离 — **Phase 21 完成 + 0.5.0 GA 前 UX 顺手批（待办创建排序 + 冲突页复制/打开/限高）完成（2026-06-06）**；下一步 **22（0.5.0 bump+发版）→ 23（push 收尾）**

**✅ 0.5.0 GA 前 UX 顺手批（2026-06-06，2 commit 落本地 main 未 push）** —— Phase 21 之后、用户逐项确认：
- `9a66e6c` **feat(todo)**：待办页改按笔记 **created_at desc**（创建顺序，新→旧）而非 updated_at；脏编辑旧笔记不再浮顶、只有刚建草稿置顶；删掉随之失活的 `TodoGroup.updated_at`（daemon `todos.ts` + api + `TodoPage.tsx`，4 测试）。
- `62d0591` **feat(gui)**：冲突页 **「复制」输方全文**（`conflict_record.local_payload` 存整段 content 快照 → 复制= 输方笔记完整全文，非某处差异；缓解 W7 = 兑现「Feature A」GA-prep todo）+ **「打开笔记」**跳编辑器（`openNoteById(entity_id)`，打开看到的是赢方/远端版本）+ **内容块限高 `max-h-60 overflow-auto`**（长笔记块内滚动，行保持紧凑）。3 测试。
- 真机手测（隔离 nest + 种真实冲突 + 真笔记）：复制/打开均符合预期；测试数据已清。基线 core **528** / daemon **284** / cli **137** / gui **399**(+7) + `just check` 全绿。
- **0.5.0 GA 前剩余待决：SSE idle watchdog（原 Phase 11，sse-bridge.ts 无 idle 检测，半开连接静默假死无法识别）—— 进 0.5.0 还是推 0.6 未定。**

**✅ Phase 21（CLI compat 收尾 + W10 + 并发安全）2026-06-06 完成** —— plan `docs/plans/2026-06-05-phase21-cli-compat.md`（v3 定稿，经用户 4 轮 review；§7 实施记录）。三 slice：
- **21a cosmetic + CLI sync login 退役 + 文案**：daemon `manual.ts:324` `authenticated: config?.auth != null`（per-profile 只写 `encrypted_token`，老 `auth.token` 恒空 → 改读 auth 段是否装配）；core `config.ts` 两处 `owl sync login` 文案 → 指向 GUI；cli `runSyncLogin` 立即抛友好 USAGE_ERROR（删 prompt + 死 `/sync/login` POST），`--email` 改 optional 保留兼容，`--db` help + `config show` 文案。
- **21b GUI 切换并发安全（层 A+B）**：`sync-auth.ts` 模块级 `runSwitchExclusive` 互斥队列串行 login/logout/switch/delete **+ refresh/restore**（refresh 防污染 = 走 mutex + body 内新鲜读 config）；新 `single-instance.ts` `app.requestSingleInstanceLock()` + `whenReady` guard（**真机手测过**：第二实例聚焦已有窗口）。
- **21c W10 switch lockfile（层 C）**：core 新 `skybridge/switch-lock.ts`（atomic temp+rename / nonce owner-token / shape 校验 / pidAlive+TTL 30s）+ `paths.switchLockPath()`；gui `acquireSwitchLockFile()`（nonce + 10s heartbeat unref）只包 4 个 switch 的 critical section（首 postSyncSwitch→toml，含 unwind；claim prompt 在锁外）；cli `errors.SWITCH_IN_PROGRESS`→CONFLICT + `resolve.ts` `resolveDirectDbPath`（显式 `--db` 不 gate / 默认 assertNoActiveSwitch→新鲜重解析→复检）。
- **三层正交**：A 单实例（进程级）/ B mutex（GUI 内，包整函数含 prompt）/ C lockfile（跨进程，仅 critical section + heartbeat + nonce）。mutex ⊃ lockfile（prompt 持 mutex 不持 lockfile）；refresh 走 mutex 不碰 lockfile。
- **验收全绿**：`just build` + `just check`（lint+typecheck+8 守卫）+ core **528**(+9) / daemon **284**(+1) / cli **137**(+3) / gui **392**(+7) + gated e2e **25/25**。CLI 行为已用 dist 二进制 smoke（login 跳转 / `--db` help）。
- **提交**：3 code commit（`6b5d658` daemon authenticated / `fde19b9` cli sync login / `8559ed6` skybridge 并发+lockfile）+ docs `6448609` + **清理 `a675f7d` refactor(cli) 删 vestigial `ResolveBackendInput.dbPath`**，落本地 main 未 push（Phase 23 统一 push）。
- **0.6+ backlog 不变**：W7 冲突双向 / W11 附件 / 跨 profile 视图 / TLS（设计稿 §11）。

---

**✅ Phase 19（阿里云部署 + promote latest + 真机 smoke）2026-06-04 完成** —— plan `docs/plans/2026-06-03-phase19-deploy-promote-smoke.md`（§9 实施记录）。
- 阿里云 Ubuntu ECS 部署 0.1.4 server（明文 HTTP + 安全组锁源 IP + systemd，`server_id` smXxhd…），`/v1/health` 公网可达。**测试环境已拆；正式环境照 `skybridge/docs/deploy/ubuntu-baota.md`**（已补 §12 日常运维 + §13 拆除/迁移）。TLS 留 0.6。
- 真机 smoke **S1-S5a 全过**：首登+claim、**D10b 本地库零污染**、免密快切、多账号隔离、refresh 不风暴（3 次 `/v1/auth/refresh` 全来自快切 refresh-first）。
- **promote `0.1.4 → npm latest`**（proto/client/server 三包 dist-tag move，2026-06-04）。
- **cosmetic**：daemon `/sync/status` 的 `authenticated`=`Boolean(config?.auth?.token)`（`manual.ts:324`）读老顶层 `[auth].token`，per-profile 下恒 false（功能无碍）→ **Phase 21 顺手修**。

**✅ Phase 20（W12 备份恢复 / 网络中断 / W3 错钟）2026-06-04 完成** —— plan `docs/plans/2026-06-04-phase20-soak-clockskew-recovery.md`（§5 实施记录）。真云 server + mac rig，API+sqlite 驱动核验。
- **T1 W12 备份恢复**：旧备份覆盖 → 重拉补齐 + **删不复活**（`trash — local row missing, skipped`）+ cursor 追平。**1 条「远端胜出」冲突 = 恢复场景预期安全**（远端为准 + W7 可见 + 零丢失，非风暴）→ **写进 0.5.0 恢复指引**。
- **T2 网络中断**：离线识别 `SKYBRIDGE_SERVER_UNREACHABLE` + 编辑排队 + 退避 health-probe → 恢复 `sse connected`+`health-probe stopped`+catch-up 补推，无重复 apply/复活。
- **T3 W3 错钟（libfaketime +10d）**：standalone node daemon（关 GUI+Node ABI 避 better-sqlite3 ABI 冲突）+ 脚本注入 A 会话，`server_time_offset_ms≈-10天` → 错钟设备写入 `updated_at≈真实时间`（距真实 2 秒/距+10d 整 10 天）→ **错钟不成黑洞**。
- **T4 计时 soak 降范围跳过**（用户定；正确性已由 T1-T3+S1-S5a 覆盖；真·24h 留 GA 前可选）。
- **owl 零生产代码改动**（Phase 19+20 = 部署 + 文档 + 真机验证 + npm dist-tag）。

---

**✅ Phase 18（本地全链路 per-profile model e2e）2026-06-03 完成（代码待提交，PROCESS+plan 留工作树）** —— 照 `docs/plans/2026-06-03-phase18-local-full-chain.md`（v2 定稿，1 轮 review 已纳；§11 实施记录）。
- **唯一改动**：新增 gated e2e `packages/daemon/src/sync/profile-chain.e2e.ts`（~390 行，单片）。`sync.dual.e2e.ts` 零改动；无生产代码改动。
- **覆盖缺口**：现有 dual e2e 只跑 in-memory core-engine，per-profile **存储+切换模型**（真 toml `[profiles.X]`+`active_profile` → resolver → on-disk `profiles/<id>/owl.db` → daemon `POST /sync/switch` 打真 0.1.4 server → 重启重解析 → 快切 → 删除）从无端到端自动化覆盖。新 e2e 把这条链路串起来跑。
- **9 用例 P0-P8**（P9 ghost 折入 P8）：P0 boots-on-local + 种 local note · P1 首登远端 bootstrap(A) · P2 switch 建库+`/sync/session`+`writeProfileConfig(setActive)` · P3 push 隔离 + **D10b 语义铁证**（local owl.db 从未被账号同步） · P4 `restartDaemonCtx()` resolver 拾取 A · P5 快切 local+重启 · P6 快回 A + **device 复用** + 重装会话 + `/sync/run` + `listDevices()===1` · P7 第二账号 B 共存+各看各笔记 · P8 删 A 副本(先切 local 释放句柄)+B/local 完好+ghost 不复活。
- **上界（Q2 拍板）**：daemon HTTP 路由打真 server + core resolver/config 真 toml + 真 on-disk profile db。GUI-main 编排（loginAndOpenSession/refresh 定时器/safeStorage/claim）留单测 + Phase 19 真机。
- **验收（whole-repo 全绿）**：`just build` → `just check`(typecheck + 8 守卫) → `just test`（core **519** / daemon **283** / cli **134** / gui **385**，**单测数全不变**——e2e 独立 gated）→ `just test-skybridge-e2e` **16 → 25（+9）**。
- **carry-forward**：`restartDaemonCtx()` 拆/重建必做序（scheduler.stop→stopBackgroundHandles→drainManualSync→app.close→sqlite.close→`__resetInflightSync()`，否则 SSE/timer 打已关闭 sqlite）；D10b 是**语义**断言（`synced_at` nullable，pending=`IS NULL`，建本地 note 本就产 pending）；session.ts `SkybridgeClientModule.login` 不含 serverId（daemon 不登录）→ e2e 自声明 richer `E2EClientModule`；`SkybridgeDeviceSection` 必填 app_version+client_version、Workspace 必填 slug；`createDatabase` 不 mkdir。详见 plan §11。

---

## 历史：Phase 12-17 + 插队「多账号 add」（P5-d per-profile 隔离主线，全落 main 已 push）

**Phase 17 子设计**：`docs/plans/2026-06-01-phase17-gui-account-device.md`（经 **3 轮 review**，切片 17a/17b/17c/17d；§9 实施记录有全验收 + 真机手测 + bug 修复诊断）。父设计 `2026-05-29-account-profile-isolation-design.md`（v6，§0.5/§5.4.3 D2/§11/§13 W4/W5/W8/W9 权威）。

**✅ Phase 17 五 commit（已落 main 已 push）**：
| Commit | 内容 |
|---|---|
| `58fc3f5` | **17a** 手动同步(W8)+提醒文案(W5)：shared `RunSyncResult` + main `sync:run` + SyncStatusBar「手动同步」按钮（账号态显，syncing disabled）+ SyncSection W5 一行。daemon 零改动（复用 `POST /sync/run`）。 |
| `7bc2a59` | **17b** 免密快切(W4)：core `listProfiles`(含 `dbExists`)/`updateProfileAuth`(by-id)/`clearProfileAuth`(by-id)/`readEffectiveActiveProfileId`；main `switchToProfile`（进门 clearTimer + refresh-first + persist-first + db 硬闸 + `switched` 整段 catch + 精确回滚前一 profile）+ `QuickSwitchNeedsLoginError`；`sync:profiles`/`sync:switch-profile`；SyncStatusBar popover `ProfileSwitcher`(账号列表 max-h 滚动)。切回 local = step-away 保留 token（D2）。 |
| `66906c8` | **17c** 移除设备(W9)：daemon `RealSkybridgeClient.revokeDevice` 声明 + `POST /sync/revoke-device`(仿 /sync/devices)；main `sync:revoke-device`；DevicesCard 非当前行「移除」+ inline 确认 + revoke 后重拉（当前行无按钮 Q4）。 |
| `6cecd19` | **17d** 删除账号本地副本(destructive)：core `deleteProfileDb`(拒 local/非 hex)；main `deleteProfileLocalCopy`(active 硬切 local 释放句柄+`postSyncSwitchStrict` HTTP 失败中止/NetworkError 继续 + 泛化 `remoteRevoke`→`bestEffortRevokeProfile` device-first/logout-last + refresh-only)；`sync:delete-profile`(仅 wasActive 才 notify)；renderer `SavedProfilesCard`(Settings「已保存账号」+ 强二次确认 Dialog)。 |
| `ef059b2` | **fix(skybridge)** 续期定时器 setTimeout 32 位溢出（Phase 15 遗留，非 Phase 17）：server 默认 30 天 access TTL → delay 2.59e9 ms > 2147483647 → Node 钳 1ms 立即触发 → refresh+install ~250/sec 死循环 → 卡「同步中」。修：`scheduleRefreshIn` 分段（>`MAX_TIMER_MS` 睡满上限+重算+重 arm）。回归测试 1。 |

**Phase 17 验收（whole repo 全绿）**：`pnpm -r build` → `just check`(8 守卫+typecheck) → core **519** / daemon **283** / cli **134** / gui **368** → gated e2e **16/16**。

**✅ 真机手测全过（2026-06-02，隔离 nest + 真 0.1.4 server + 账号 a@local/b@local）**：手动同步 / 提醒文案 / 免密快切(A↔B↔本地、切回免密、dead-refresh 提示) / 移除设备(仅非当前) / 删除账号副本(active+非 active、local 库原样)。**手测暴露并修复上方 setTimeout 溢出 bug**（诊断法见 plan §9）。

四决策拍板：①快切扩展 SyncStatusBar popover ②删除副本纳入 Phase 17 ③离开账号两语义并存（侧栏切回保留 token / Settings 退出完全 revoke）④移除设备仅非当前。

> **插队功能（用户 2026-06-02 提，需求已反转）**：原「登录守卫」（已登录态**禁止**直接登另一账号、须先切回本地）**作废**；改为**支持已登录态直接添加新账号**（多账号 add，语义 A：新账号成 active，旧账号留在已保存列表可免密快切回去，符合 D2 step-away）。**不加任何 login guard**。设计稿 `docs/plans/2026-06-02-add-account-while-logged-in.md`（经 2 轮 review 定稿，§9 实施记录）。做完此插队功能再回 Phase 18。
>
> **✅ 状态：两 slice 已实现 + 全绿 + 真机手测通过（2026-06-02）+ 已 commit 落 main（未 push）**。slice add-1（main `loginAndOpenSession` 多账号化：prior 捕获 + claim 仅 from-local + 失败回滚到 prior）；slice add-2（renderer：抽 `LoginForm` + auth view「添加账号」URL `?action=add` 驱动 + 侧栏「+ 添加账号」`PopoverClose`）。**无 daemon/core/新 IPC 改动**。验收：`pnpm -r build` + `just check`（typecheck+6 守卫）+ core 519/daemon 283/cli 134/gui **385**(+17) + gated e2e 16/16 全绿。真机手测：隔离 nest + 真 0.1.4 server（a@local/b@local）跑完设计稿 §5 全清单。**下一步回 Phase 18（本地全链路验证）**。

---

**Phase 16 子设计**：`docs/plans/2026-06-01-phase16-import-renderer-w3.md`（经 2 轮 review，切片 16a/16b/16c；§8 实施记录有 16a/16b/16c 全验收 + 手测）。

**✅ 16a 受控 renderer reload（B7，commit `3d19ded`）**：profile switch（login/logout，main 单点）成功后 main `webContents.send('profile:switched')`（`setImmediate` 在 IPC reply 之后）→ renderer 收后再延一 tick `window.location.reload()`，整窗 reload 零残留（editor tab / AI / conflict / sync timer 全清）。软 `resetAllStores(epoch)` 留 0.6。

**✅ 16b 认领空账号弹框 + W6 local UI（D10b/B2 + W6，commit `4dfbbbe`）**：
- core `inspectLocalProfile()`（只读 owl/owl.db 计数 + B8 orphan 探测）+ `copyLocalProfileDbInto()`（readonly backup 整库 copy）。
- gui main `loginAndOpenSession` 分回访/首登：首登 register+ensureWorkspace+空账号 probe(`pullChanges(ws,0,1)`)全在 switch **之前**（B9），空账号+local 有笔记 → `promptClaim`(独立 `claim-prompt.ts` 防 import 环) → merge 则 copy 到 target **再** switch。**账号同步永不写 owl/owl.db**（D10b）。
- renderer `ClaimAccountDialog`（forced choice，用 `Dialog` 非 AlertDialog——后者不存在）+ W6 「本地独立工作区」明示（SyncStatusBar popover + SyncSection banner，判据 `snapshot!==null && server_url===null`）。

**16a/16b 验收（commit-time，whole repo 全绿）**：`just check` 8 守卫 · core **480** / daemon **278** / cli **134** / gui **316** · gated e2e **16/16**。（16c 后基线见下方 505/279。）

**✅ 16a/16b 真机 e2e 手测通过（2026-06-01，隔离 nest + 真 0.1.4 server + 账号 test@local，rig 已清理）**：W6 banner/popover 显「本地独立工作区」；local 2 笔记登录空账号 → claim 弹框 → 并入 → 窗口自动 reload 进登录态；**文件/server 核验**：`profiles/<id>/owl.db` 生成且与 local 同笔记数、**`owl/owl.db` 零被账号同步污染（synced_at=0/cursor=0/无 skybridge meta，D10b 铁证）**、server change-log 仅 2 用户笔记上行（特殊笔记不推）、server device=1/workspace=1 无堆积、profile db 身份与 toml 一致 backfilled=1；logout → active=local、`[profiles.<id>]` 段保留、token 清空、窗口自动 reload 回 local。

**✅ 16c W3 HLC-lite（owl 单仓不动 skybridge，commit `e3472f9` `feat(skybridge)`，落 main 未 push）**：migration **`0009_lww_counter.sql`**（notes/folders 加 `lww_counter`；`LATEST_KNOWN_VERSION` 8→9）+ 新 `sync/hlc.ts`（`serverNormalizedStamp` 同毫秒 counter++ / `observeRemoteLwwKey` / `setServerTimeOffset` / `readServerTimeOffset`，HLC 状态落 `local_metadata`）+ payload parser 接 `lww_counter`（`optionalNumber`）+ 业务写 stamp 落点（notes/folders create/update/delete/restore/reorder，行+payload 带 counter，create/reorder 的 stamp 移进 tx）+ engine 三元 LWW `cmpLww(ms,counter,deviceId)`（update/delete/conflict gate 全改 + apply 写行 counter + 每 payload `observeRemoteLwwKey`）+ `runSync` 每轮 pull(含 empty)/push 落 offset + daemon `adaptClient` 透传 `serverTime`。`conflict_record` counter 列**未做**（§4.1 留 0.6/W7）。新测试 4 文件（`hlc.test`/`hlc-engine.test`/parser/daemon adapter）。**验收全绿**：`pnpm -r build` + `just check`(8 守卫) + core **505**/daemon **279**/cli **134**/gui **316** + gated e2e **16/16**。错钟真机/soak 留 Phase 20。详见 plan §4 + §8。

---


**设计文档**：`docs/plans/2026-05-29-account-profile-isolation-design.md`（**v6 定稿，以 §0.5 决策总账为准**）+ `2026-05-29-phase12-profile-foundation.md`（Phase 12 子设计）。

**模型（终态）**：`profile = (server_id, user_id)`，`profileId = sha256(server_id, user_id)` 前 32 位。锚点 **server_id**（skybridge 配置文件长随机标识，可迁移带走，换 url 不丢工作区，D11/W1）。每账号 `profiles/<id>/owl.db`；**local = `owl/owl.db` 原地**（D10a）。**账号同步永不写 local**（不变式）。导入仅"认领空账号"（D10b）。**免密快切并入 0.5.0**（refresh-token 带轮换，D2 翻转/W4）。LWW 时间戳改 server 归一化 offset + counter（W3）。

**✅ Phase 12（profile 地基）已落 main，3 commit**：
| Commit | 内容 |
|---|---|
| `45eef1e` | T1 core resolver（`resolveActiveProfileDbPath` raw-parse + 存在性闸 + profileId 校验回退 legacy）+ `normalizeServerUrl`/`computeProfileId`(sha256/128bit) + path helpers + index 导出 + 25 单测 |
| `a4c61bd` | T2 三入口切 resolver（daemon cli.ts:62 / GUI index.ts:73 / CLI config.ts:43，含 B3） |
| `d15c9cd` | T4 redact globs `*.profiles.*.encrypted_token`/`*.profiles.*.auth.token` + logger 测试 |
（T3 = bypass 审计 doc-only：无旁路 reader，readSkybridgeConfig 沿用为 adapter，清单校正见设计稿 §5.9。）

**Phase 12 验收**：core 435 · CLI 134 · daemon 255 · GUI main 74 · **SKYBRIDGE_E2E 16/16** · `just check` 8 子任务全绿。**运行时行为 diff=0**（resolver 全程回退 legacy）。

**⚠️ Phase 12 provisional（后续决策修订，实现时以设计稿为准）**：`computeProfileId(url,user)` → D11 改 server_id（Phase 15）；~~`localProfileDbPath()=profiles/local` → D10a 重映射 owl/owl.db~~（**Phase 13 已落**）。

**✅ Phase 13（存储+迁移，plumbing-only）2026-05-31 完成（落 owl main，未 push）** —— 照 `docs/plans/2026-05-30-phase13-storage-migration.md` v2。**运行时行为 diff=0**（无 live profile db → 全程回退 legacy `owl/owl.db` + 顶层 `[auth]` 视图；真机 legacy toml 读取一致）。
| 任务 | 内容 |
|---|---|
| T1 | `paths.localProfileDbPath()` 重映射 `owl/owl.db`（D10a）；`profile/resolver.ts` 抽出**单一 `resolveActiveProfile()` 三重一致 gate**（① active 是 hex ② `[profiles.<id>]` 段存在 ③ profile db 存在；缺一 → null=legacy）+ `isHexProfileId` + `readActiveProfileId(path?)` 加可选 path；`resolveActiveProfileDbPath()` 委托之，行为等价 |
| T2 | `skybridge/config.ts` adapter：`readSkybridgeConfig` 经**同一 `resolveActiveProfile` gate** 返回 active-profile 视图 / 否则 legacy（抽 `assembleConfig` 公共组装；active 非 null 但 section 缺 → **fail-closed throw**，杜绝反向 split-brain）。写侧全走 **raw read-modify-write**（`mutateConfigFile`，保 sibling profiles + `active_profile`）：`writeProfileConfig`（hex 校验 + setActive 前 db 存在闸）/ `setActiveProfile`（hex 或 local + 同闸）/ `removeProfile` / `clearSkybridgeAuth` 改为只清 active profile auth。**dormant**：v2 writer 有能力+测试但无 live 调用（login flip 留 Phase 15） |
| T3 | redact glob `*.profiles.*.encrypted_token` Phase 12 已覆盖 flat-fields 机密路径 → **无需新增** |
| T4 | W2 迁移 = **no-op**：`owl/owl.db` 原地留 local，不搬库、0 迁移动作；`migrate.mjs` / GUI precheck 已走 resolver，确认无改动 |

**Phase 13 验收**：core 464（+29）· CLI 134 · daemon 255 · GUI 299 · **SKYBRIDGE_E2E 16/16** · `just check` 8 守卫全绿。新错误类型 `InvalidProfileIdError` / `ProfileDbMissingError`；新导出 `resolveActiveProfile`/`isHexProfileId`/`LOCAL_PROFILE`/`writeProfileConfig`/`setActiveProfile`/`removeProfile`/`ProfileConfigSection`。

**⚠️ Phase 13 登记给 Phase 15**：profile 段 `server_id` 留空占位（R2，无 live writer）；机密字段沿用 `encrypted_token`，refresh 落地若改 `encrypted_refresh_token` 需补 writer/reader/redact glob（R1）；version negotiation 硬要求 0.1.4 server，`server_id` 缺失报错不静默回退 url-key（R5）。

**✅ Phase 14（daemon switch，plumbing-only）2026-05-31 完成（工作树，未 commit）** —— 照 `docs/plans/2026-05-31-phase14-daemon-switch.md`（v4 定稿，经 3 轮 review）。`switchProfile(ctx, targetDbPath, logger): Promise<{warnings}>` 走 §5.4.2-bis 完整状态重建 + switch gate。**无 live 触发**（login 翻转留 Phase 15）→ 运行时 diff≈0。
| 任务 | 内容 |
|---|---|
| switch-gate | `SwitchGate`（`isSwitching`/`generation`/`trackMutation`/`runExclusive`）—— 串行化切换 + swap 期 drain 在飞 mutation；server.ts 单点 hook 在 route 注册前挂、mutating 请求 switch 期回 503 `SWITCH_IN_PROGRESS`（`fail()`） |
| switchProfile | **PREPARE**（createDatabase+ensureDeviceId+ensureSpecialNotes，可 throw=abort 旧 ctx 未动）→ **QUIESCE**（stopBackgroundHandles+drainManualSync）→ **COMMIT**（swap db/sqlite/deviceId、rebuild ReminderScheduler+ConversationStore、evict broadcaster WeakMap、清 session/preview、异常进 warnings 不 reject）→ 锁外 ensureBackgroundHandles |
| 4 轮 review 修 | P1-a shutdown 改读 `ctx.scheduler/ctx.sqlite`；**P1 epoch**：`ensureBackgroundHandles` 入口 guard + await 后写回前重判 generation 失配则弃 stale handle（抢在 SSE onOpen 前同步退订）；P2 ensureDeviceId 先于 ensureSpecialNotes；**P3 core**：`createDatabase` try/catch 包版本派发、任何 throw 关句柄；P4 `switchProfile` throw=abort/resolve=committed 契约 |

**Phase 14 验收**：core 465 / CLI 134 / daemon **272**（+17）/ GUI 299 / **E2E 16/16** / `just check` 8 守卫全绿。改动文件：daemon `{switch-gate.ts(新), profile-switch.ts(新), coalesce.ts, status-broadcaster.ts, manual.ts, bridge-lifecycle.ts, context.ts, cli.ts, server.ts}` + core `db/index.ts` + 5 测试文件。

**⚠️ Phase 14 登记给 Phase 15/16/17**：live 切换触发 + switch 后 `installSkybridgeSession` compose（15）；renderer 受控刷新 §5.4.4（16）；GUI 快切下拉触发 switchProfile（17）；写 toml `active_profile` 由 GUI main（daemon 不写 toml，守卫拦）。

**✅ skybridge 0.1.4（Phase S）已实施落 skybridge main 2026-05-31**（7 commit 未 push/未 publish，`just check` + 109 tests 全绿）= server_id（db `server_meta`+config 覆盖）+ 权威时间 + refresh 轮换（replaced_by 区分 replay/invalid）+ device revoke + lazy-bind。Phase 15 对接 ready；npm publish 留 Phase 19。详见 skybridge `docs/plans/2026-05-30-phase-S-skybridge-0.1.4.md` 与 skybridge PROCESS.md。

**重排路线（设计稿 §11）**：Phase 12 ✅ + Phase S ✅ + Phase 13 ✅ + Phase 14 ✅ → **15(登录/切换/登出：profileId=hash(server_id,user_id)、refresh-token 流、device 复用、登录顺序 B9，依赖 Phase S)** → 16(import 守卫+renderer reset+W3) → 17(GUI 快切+移除设备+手动同步) → 18-23(全链路/阿里云部署 0.1.4/soak/CLI/发版/收尾)。

**✅ Phase 15（登录/切换/登出 + refresh，live）2026-06-01 完成（落 owl main，未 push）** —— 照 `docs/plans/2026-05-31-phase15-login-refresh.md`（经 3 轮 review）。子设计两决策：① SDK 接入 = skybridge `just publish --tag next` 发 0.1.4 三包 + owl bump `0.1.4`（latest 仍停 0.1.3，Phase 19 promote）；② plumbing 风格切 15a/15b。
| 任务 | 内容 |
|---|---|
| S15 | **skybridge 0.1.4 已 publish @next**（proto/client/server）。Phase S 漏 bump package.json 版本 → 补 bump commit `db50768`（skybridge main）。owl daemon+gui dep → `0.1.4`，gated e2e 16/16 真打 0.1.4 server |
| 15a | core `computeProfileId(server_id,user)`(D11) + `encrypted_refresh_token` 穿透 config adapter/gate + `updateActiveProfileAuth`(轮换 raw-patch)/`readProfileSection`(按 id 读 device 复用) + export `readSkybridgeDeviceId` + redact glob；daemon `POST /sync/switch`(mkdir+switchProfile+回 device_id，switch-gate 自指死锁豁免)；GUI main login 翻 per-profile(B9: switch→device 复用/register→ensureWorkspace→session→writeProfileConfig setActive；R5 硬要求 server_id；unwind 回 local) + logout D2 full(revoke with refresh-then-logout 兜过期) |
| 15b | restore **refresh-first**(refresh→轮换落盘→install；dead refresh 清 creds、net 留 token)；**GUI main proactive timer 续期**(`scheduleRefresh`/`refreshSession`/`maybeRefreshNow`，expiresAt−60s + `powerMonitor`resume/`browser-window-focus` 重校；非 daemon event) |

**Phase 15 验收**：core **474** / daemon **278** / gui 308 / cli 134 / `just check` 8 守卫 / gated e2e 16/16 全绿。**已知取舍**：app 完全退出超 access TTL → daemon 后台 sync 停到下次启动（记 release notes）。**Phase 15 留尾**：受控 renderer reload + 认领空账号弹框 + W3 时间戳 → Phase 16；GUI 快切下拉/移除设备/手动同步 → Phase 17。

**✅ Phase 15 真机 e2e 手测全过（2026-06-01，对真 0.1.4 server，隔离 nest）**：登录写 per-profile toml（server_id 锚 + 两密文 + device + workspace）+ 生成 `profiles/<id>/owl.db`；**local `owl/owl.db` 未被账号同步污染**（D10b 验）；server 1 device 不堆积；账号笔记同步上行；**proactive 续期每 60s 免密**（daemon.log 4+ 次 session install）+ **refresh 轮换**（server 旧 family 撤销）；登出 `op:switch local`；**重登 device 复用**（`op:switch` device_id 非 null，server 仍 1 device，F1 根治）；**重启免密 refresh-first restore**（新 daemon pid 启动即 install）。唯一粗糙点 = 切换后 renderer 需手刷才显示对的 profile 笔记（受控 reload 缺 → Phase 16 首要项）。临时环境已清理。

**🧹 Phase 15 顺手 cleanup（gui，待提交）**：① Settings tab 重排 `外观→自定义→同步→快捷键→高级`（default `外观`，原 `快捷键` 首位非行业惯例）+ 测试同步；② 删死代码 gui `atomic-write.ts`(+test)——Phase 15 login/logout 改走 core `writeProfileConfig`/`clearSkybridgeAuth`/`setActiveProfile`，atomic-write 唯一消费者消失（§40 不变量作废）。gui 308→297（−11 测随文件删）。

**Push 状态补充**：Phase 15 owl 提交 = 5 commit（`eff7e1e` chore bump / `1795b90` core / `c8308e4` daemon switch / `133af6c` gui login / `386388c` docs plan）+ 15b 1 commit（待提交/已提交见 git log）。skybridge `db50768` bump 在 skybridge main。**均未 push**。

**下个对话**：开工 **Phase 15（登录/refresh/server_id）** —— 接 Phase S 0.1.4 client（login 回 refreshToken/expiresAt/serverId；`refresh()`/`getServerInfo()`/`getServerTime()`；`revokeDevice`）。登录顺序 §5.4.1（**先在当前 profile 备好目标库再 switch**，B9）：login → profileId=hash(server_id,user_id) → 备库（reuse/import 抉择 §5.5）→ **switchProfile（Phase 14 已就绪）** → installSkybridgeSession → 写 toml `[profiles.<id>]`+active_profile（GUI main）。硬要求 0.1.4 server，`server_id` 缺失报错不回退 url-key（R5）。owl 存 `encrypted_refresh_token` + 补 redact glob。

**Push 状态**：Phase 12（`45eef1e`/`a4c61bd`/`d15c9cd`）**已在 origin/main（已 push）**。Phase 13（`c4da3f1`/`9b61ae0`/`f9113f7`）+ Phase 14（`c4f2240` fix db / `da3e900` feat switch / `ae7c61a` docs plan）**六 commit 在本地 main 未 push**。**本 PROCESS.md 改动留工作树待用户提交**；MEMORY 不入 git。

---

## 历史：P5-d Phase 10 完成 — 2026-05-29（设备列表 GUI + daemon plaintext bootstrap 退役）

**设计文档**：`docs/plans/2026-05-29-p5-d-phase-10-design.md`（v 锁定 2026-05-29，已实施 + 手动 e2e 9/9 通过）；父框架 `docs/plans/2026-05-26-p5-d-design.md`（v3）。

**Phase 10 commit 列表（3 个，本地 main，未 push）**：

| Commit | Phase | 内容 |
|---|---|---|
| `e8106c6` | 10 (1) | shared `sync-devices-types.ts`（`SyncDeviceEntry` / `SyncDevicesReply` snake_case）+ daemon `RealSkybridgeClient` 加 `listDevices()` 结构方法 + daemon `manual.ts` **export** `translateSkybridgeError`（commit 1 仍带 `configPath`，commit 3 改签名）+ 新 `routes/sync.ts GET /sync/devices`（catch 走 `translateSkybridgeError` 再 status/code helper；401 时调 `invalidateSkybridgeSession` 跟 `doRunManualSync` 对齐）+ main `sync-ipc.ts buildDevices`（**显式 `new NetworkError(...)` 包裸 fetch reject**，避免落 unknown 分支）+ preload `owlAPI.sync.devices` + `owl-api.d.ts` 补 devices + test-setup / MigrationDialog.test mock 补 devices stub + 8 单测（daemon 3 + main 5） |
| `44427b9` | 10 (2) | `DevicesCard.tsx`（collapsed by default + 首次展开 fetch + **缓存命中 collapse/expand 不 re-fetch** + 显式刷新按钮唯一 re-fetch 触发 + 是否当前 chip + `Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })` 自然中文「前天 / 8 秒钟前」）+ `SyncSection.tsx` auth view 嵌入 DevicesCard（unauth view 不渲染）+ 12 单测（DevicesCard 10 + SyncSection 2）。**没加 radix Collapsible** 依赖（一个 sub-card 不值得新增 dep；`useState + 条件渲染 + aria-expanded` 即可） |
| `6e9237b` | 10 (3) | `session.ts ensureSkybridgeSession` 收缩到「读 cached / 抛 `SkybridgeAuthRequiredError`」（删 `requireAuth` / `writeSkybridgeConfig` / `readSkybridgeConfig` / `skybridgeConfigPath` import + 删 `defaultDeviceName` + 删 lazy `registerDevice` / `ensureWorkspace` 路径 + 删第 243 行重复的 `persistSkybridgeIds`）+ `manual.ts translateSkybridgeError` 签名改 `(err)`（删 `configPath` 参数 + 401 副作用清空）+ 同步两个 caller（`doRunManualSync` + `/sync/devices`）+ 局部 `cfgPath` 删 + `scripts/check-daemon-no-toml-write.sh` 新增（`rg \b(writeSkybridgeConfig\|clearSkybridgeAuth)\s*\(` 排除 test/e2e/d.ts）+ justfile `check` 7 → 8 子任务 + 现有 `sync.test.ts POST /sync/run` 两个错误码用例改 Phase 10 语义（missing toml AND missing [auth] 都收敛到 401 `SKYBRIDGE_AUTH_REQUIRED`）+ 新 `session.ensure.test.ts` 4 case + 新 `manual.translate.test.ts` 10 case + `sync.dual.e2e.ts` 注释更新 |

**测试基线**：
- 单元 **1096/1096**（core 408 + daemon 255 + gui 299 + cli 134；1062 → 1096，+34）
- `SKYBRIDGE_E2E=1 just test-skybridge-e2e` **16/16 重跑通过**（2026-05-29 post-Phase-10，1.45s）
- `just check` **8 子任务**全过（lint + typecheck + 6 bash 守卫，baseline 7 → 8，新增 `daemon-no-toml-write`）

**Phase 10 关键不变量**（编号续 Phase 8+9 §49 → 50-54）：

50. **`ensureSkybridgeSession` 不读 toml** —— 仅返回 `ctx.skybridgeSession`，不存在抛 `SkybridgeAuthRequiredError`。Phase 6 起会话只通过 `POST /sync/session` 安装；Phase 10 起 daemon 没有 fallback 路径。daemon 无 Electron handle 无法解密 `encrypted_token` → 必须依赖 GUI main 注入
51. **daemon source 不写 toml** —— `writeSkybridgeConfig` / `clearSkybridgeAuth` 在 `packages/daemon/src/**/*.ts`（非 test / 非 e2e / 非 d.ts）中全部禁止；bash 守卫 `daemon-no-toml-write` 拦截。两个 helper 仍由 `@owl/core` 导出（GUI main + 测试使用，Phase 11+ 顺手退）
52. **`persistSkybridgeIds` 由 `installSkybridgeSession` 独占** —— `session.ts:320` 在 POST /sync/session 注入时执行 `local_metadata` 写入 + 一次性 backfill。Phase 10 commit 3 删 `ensureSkybridgeSession` 第 243 行重复调用；idempotent 保障
53. **`/sync/devices` 路由不触发 lazy bootstrap** —— 直接读 `ctx.skybridgeSession`；未注入抛 `SkybridgeAuthRequiredError` → `translateSkybridgeError` → 401 + `SKYBRIDGE_AUTH_REQUIRED`，不静默给空数组。**SDK 原生 `ApiError` / `NetworkError` 必须先经 `translateSkybridgeError` 翻译再交错误码 helper**（否则裸 SDK error 落 500 / `SKYBRIDGE_SYNC_FAILED`）。翻译后若为 `SkybridgeAuthRequiredError` 调 `invalidateSkybridgeSession(ctx)` 与 `doRunManualSync` 对齐
54. **设备列表 `is_current` 由 main IPC 计算** —— 不依赖 daemon 返回；main 读 toml `[device].id` + SDK 返回的设备 id 对比；toml device.id 缺失则全部 false

**手动 e2e 9/9 全过（2026-05-29，post-commit `6e9237b`）**：

| Step | 验证项 | 结果 |
|---|---|---|
| 1 | GUI 登录成功，三行 identity 渲染 | ✓ |
| 2 | 「管理我的设备」collapsed by default | ✓ |
| 3 | 展开 → loading → 6 行渲染 + 「当前」chip 准确（jay@local 现实 6 行同 hostname 重复 device 行 —— 验证 Phase 10.5+「重装防御」决策正确，真实数据已积出来）| ✓ |
| 4 | collapse → expand 缓存命中 0 IPC | ✓ |
| 5 | 刷新按钮 → 强制 fetch（skybridge server log `req-d` 200）| ✓ |
| 6 | daemon kill → 「网络连接失败」+ 「重试」；daemon restart → 「skybridge session not installed; 请在设置中登录」（**不变量 50 现网验**）；GUI Cmd+Q + `just dev` → 完全恢复 | ✓ |
| 7 | logout → 子卡片消失（auth view only）| ✓ |
| 8 | 手工 plaintext `[auth].token` toml + restart daemon + POST /sync/run → 立即 401 + skybridge server **0** HTTP 请求 + toml `[auth].token` 保持原样 | ✓✓✓ |
| 9 | TS daemon log **0** 命中 `writeSkybridgeConfig` / `clearSkybridgeAuth` | ✓ |

Pre-Phase-10 行为对比（已退役）：Step 8 同样输入会让 daemon 读 plaintext token → 调 `/devices/register` → server 401 → daemon 调 `clearSkybridgeAuth` 抹掉 `[auth]`。Phase 10 三个动作都没了。

**Phase 10 设计岔路（拍板归档）**：

- **revoke 端点不在 Phase 10**：skybridge server `^0.1.3` 没 `DELETE /devices/:id` / `POST /devices/:id/revoke`；SDK 只暴露 `listDevices` + 当前 token 的 `logout`。要做需跨 3 repo + 2 npm publish (server + client) + owl 升级 dep。独立 Phase 10.5+
- **重复 device row 防御不在 Phase 10**：原 brief「409 → listDevices → hostname 恢复」实际不触发（重装 owl → 新 token 未绑定 device → server 不返回 409，而是默默插入新 row）。手动 e2e 实测：jay@local 现有 6 行同 hostname 重复 device，正是该问题的真实数据 sample。要防御需前置 listDevices + 「复用 / 新建」弹窗。推后 Phase 10.6
- **CLI `owl sync login`** 文案 `apps/cli/src/commands/sync.ts:248` 仍是 `owl sync login` 字样；`/sync/login` daemon 路由 Phase 6 已 retire（CLI 调 404 已 dead）。Phase 16 一并改文案

**Phase 10 留尾 / 后续观察**：

- **daemon 401 envelope 中英混排 UX 小坑**：main `buildDevices` 把 daemon `reply.message` 直接抛成 `Error` → `safe<T>()` unknown 分支 → 「同步出错：skybridge session not installed; 请在设置中登录」中英混排。Phase 11 顺手改：main 识别 `error_code === 'SKYBRIDGE_AUTH_REQUIRED'` 走 `syncErrorMessage({ kind: 'api', code: ... })` 输出纯中文
- **mid-session daemon 重启 → GUI 不自动 re-restore**：Phase 7 `restoreSessionOnStartup` 只在 GUI app 启动时跑一次；daemon 被 kill 后重启不会自动恢复 session，必须 GUI 完全重启或 logout+login。Phase 11 可加 daemon-down 检测 + main 自动 re-POST `/sync/session`
- **`@owl/core` 三 helper exports 暂留** —— `clearSkybridgeAuth` / `writeSkybridgeConfig` / `requireAuth` GUI main + 测试仍用；Phase 11+ 与 core 收尾一起清

**用户 0.6 头牌 wish（记给后续，**不**塞 0.5.0）**：multi-profile 快速切换 —— 用户 2026-05-29 Phase 10 e2e 后明确 raise：save (server, account) 多组 + 快切。**别和 DevicesCard 混淆**（一个是「多 (server, account)」一个是「单 (server, account) 的多 device」）。详 memory `[[project_multi_profile_wish]]`。

---

## 历史：P5-d Phase 8 + Phase 9 完成 — 2026-05-29（GUI Settings 同步 tab + 守卫脚本）

**设计文档**：`docs/plans/2026-05-28-p5-d-phase-8-9-design.md`（v4 锁定 2026-05-29，已实施）；父框架 `docs/plans/2026-05-26-p5-d-design.md`（v3 锁定 2026-05-26）。

**Phase 8 + 9 commit 列表（3 个，本地 main，未 push）**：

| Commit | Phase | 内容 |
|---|---|---|
| `191fd66` | 8 (1) | shared 三型 (`sync-auth-types` / `sync-status-types` / `sync-error-message`) + `main/sync-ipc.ts` (三 IPC handler，`extractSession` 与 `restoreSessionOnStartup` 同 gate：`safeStorage.isEncryptionAvailable + 试 decryptString`) + preload `owlAPI.sync` + `owl-api.d.ts` 只 import shared + `lib/api.ts` 去重 SyncStatusResult + tsconfig×2 + vitest include + gui dep `@orpheus-aviary/skybridge-proto@^0.1.3` + 32 单测 |
| `5e4916a` | 8 (2) | `SyncSection.tsx` (未登录 form / 已登录三行 + inline 退出确认) + `SettingsPage.tsx` `useSearchParams` deep link + `SyncStatusBar.tsx` 替掉「`owl sync login`」+ "管理账号 →" link + `daemon manual.ts:172` 文案 + vitest react-router 别名/dedupe/inline + 14 单测 |
| `ef6a7cd` | 9 (3) | 3 bash 守卫 (`check-daemon-no-electron-storage.sh` / `check-no-prod-env-token.sh` / **`check-session-body-not-logged.sh` `rg -U --multiline-dotall` 多行版**) + justfile 集成 (`just check` 4 → 7 子任务) + SyncSection.test 一处类型拓宽 |

**测试基线**：
- 单元 **1062/1062**（core 408 + daemon 238 + gui 282 + cli 134；1016 → 1062，+46）
- `SKYBRIDGE_E2E=1 just test-skybridge-e2e` 16/16（未跑过，结构未变）
- `just check` **7 子任务**全过（lint + typecheck + 5 bash 守卫，baseline 4 → 7）

**v4 关键不变量在 Phase 8+9 实施后的当前形态**（编号续 Phase 7 §44 → 45-49）：

45. **`owlAPI.sync` 是 renderer 唯一登录入口** —— Settings → 同步 tab 登录 / 退出 / 切账号；preload 暴露 `sync.{login, logout, status}` IPC，main `registerSyncIpc()` 注册三 handler，统一 `SyncIpcReply<T>` shape
46. **single display truth** —— Settings 显示字段（email / workspace_slug / device_name）只从 `sync:status` 读；`sync:login` 成功 reply 锁 `{ ok: true, data: undefined }`（summary 丢弃），renderer `await refreshStatus()` 拿展示数据
47. **`extractSession` 与 `restoreSessionOnStartup` 同 gate** —— `safeStorage.isEncryptionAvailable()` + 试 `decryptString(encrypted_token)`，任一失败回 null。Settings 永远不能比 startup restore "更乐观"（v4 关键 review finding 修复）
48. **shared 类型物理边界** —— `LoginAndOpenSessionInput` / `SyncIpcReply<T>` / `SyncStatusReply` / `SyncStatusResult` 全部 own 在 `packages/gui/src/shared/`；renderer `types/owl-api.d.ts` 严禁 import `./main/*`（`tsconfig.web.json` include 不含 main）；main `sync-ipc.ts` import shared
49. **5 个 bash 守卫**（baseline 2 → 5）—— `check-daemon-no-electron-storage.sh`（daemon 静/CJS/动态 三 import 形态）/ `check-no-prod-env-token.sh`（白名单 `dev-bootstrap.ts + cli.ts`）/ `check-session-body-not-logged.sh`（**多行 `rg -U --multiline-dotall`**，拦 `ctx.logger.*(…)` 含 `req.body` / `.token` / `token:` / `.password` / `password:` 形态，已自验 baseline 同款多行风格不漏报）

**v4 review 三处修复对应**：

| v4 调整 | 落地点 |
|---|---|
| A: session-body 多行 regex | `scripts/check-session-body-not-logged.sh` 用 `rg -U --multiline-dotall`，自验加多行 leak 样例 |
| B: `extractSession` 加 safeStorage 试解密 | `packages/gui/src/main/sync-ipc.ts:67-90` + 2 条新单测 (`isEncryptionAvailable=false` / `decryptString throw`) |
| C: shared 类型物理 owner | `packages/gui/src/shared/sync-auth-types.ts` + `sync-status-types.ts`（含 SyncIpcReply / SyncStatusReply 上移）；`owl-api.d.ts` 仅 import shared |

**Phase 8 完成后顺手清掉的 Phase 7 留尾**：
- `SyncStatusBar.tsx:102` 「在终端运行 owl sync login」→ `<Link to="/settings?tab=sync">` 进设置
- `manual.ts:172` 401 「re-run `owl sync login`」→ 「请在设置中重新登录」
- popover 配置区底加 "管理账号 →" 链接

**手动验收（2026-05-29）**：金路径 1-5 + Step 7 全过：
- Step 2 SyncStatusBar 灰点 / 已同步 + 「管理账号 →」popover 链接 + deep link 跳转 ✓
- Step 3 form 渲染（v4 §47 invariant 现网验：daemon authenticated=true via legacy plaintext，Settings 仍展示 form 不示已登录）+ 错密码中文映射 ✓
- Step 4 真密码 → 已登录三行 + toml 只写 encrypted_token + daemon log 无 token 泄漏 ✓ §39
- Step 5 inline confirm（取消 / 确认退出）+ toml 清三段保留 `[server].url` + `pulled_seq=482` 不动 ✓ §37 + §3.6.2
- Step 7 `?tab=...` 三种 case fallback 工作 ✓
- Step 6 cold-start popover snapshot-null 分支跳过（mid-session 杀 daemon 不触发 null，已被单测覆盖）

**手动测试中发现并修复**：`SyncSection.tsx:24` DEFAULT_SERVER_URL `18443` → `8443`（skybridge server 实际默认；设计文档 v4 抄错 → 落代码 → 1 个单测）。已修：tsx + 设计文档 + 1 单测 `getByDisplayValue` 字面量。基线仍 1062/1062。**未额外 commit**，待用户决定 fixup vs 新 commit。

**手动测试中发现的正向 UX**（非 bug）：登出后 form 记住上次成功登录的 serverUrl + 邮箱，只清密码 —— 比设计暗示的「回退 DEFAULT」更友好。

**Phase 8/9 留尾归属**（v4 收尾时锁定，不在 8/9 scope）：
- daemon `writeSkybridgeConfig` 完全退役 + legacy plaintext bootstrap 整体退役 —— 需配 device-id 恢复路径（`registerDevice` 409 → `listDevices` → hostname 匹配 → 恢复 id；hostname 重名 / 用户改 name / 多设备同 host 边界拍板），适合到 Phase 11 watchdog 之后、0.5.0 GA 前
- CLI `owl sync login` 文案 `apps/cli/src/commands/sync.ts:248` 「请使用 GUI 登录」—— 留 Phase 16 一起
- `clearSkybridgeAuth(configPath)` 仍由 daemon `manual.ts:166` 在 401 path 调（401 self-heal 路径，不属 keychain 主线）

---

## 历史：P5-d Phase 6 + Phase 7 完成 — 2026-05-27（daemon /sync/session + GUI main 钥匙串落地）

**设计文档**：`docs/plans/2026-05-26-p5-d-design.md`（v3 锁定 2026-05-26）

**Phase 6 + 7 commit 列表（8 个，本地 main，未 push）**：

| Commit | Phase | 内容 |
|---|---|---|
| `90993ec` | 6 (a) | `OWL_APP_VERSION` 0.4.2 → 0.5.0-dev signal commit |
| `713825f` | 6 (b) | `POST /sync/session` replace 语义 + `installSkybridgeSession` + bridge-lifecycle ctx-cache short-circuit |
| `58df287` | 6 (c) | `POST /sync/logout-local` + `clearSyncIdentity` + retire `POST /sync/login` |
| `487c4bc` | 6 (d) | `OWL_GUI_PARENT_PID` 10s probe + dev 双 env gate + cold-start unauthenticated 日志 |
| `9babaf6` | 7 (e) | `SkybridgeAuthSection.encrypted_token?` transitional schema + GUI `atomic-write.ts` + logger redact `*.encrypted_token` |
| `4902704` | 7 (f) | GUI main `sync-auth.ts`（loginAndOpenSession / logout / restoreSessionOnStartup） |
| `13f3547` | 7 (g) | `spawnDaemon` env 加 `OWL_GUI_PARENT_PID=<process.pid>` + `index.ts` whenReady 串 `restoreSessionOnStartup` |
| `bfe2528` | 7 (h) | `OWL_APP_VERSION` 提到 `@owl/core/version.ts` 单源 |

**Phase 6+7 测试基线（Phase 8 开工前）**：单元 **1016/1016**（core 408 + daemon 238 + gui 236 + cli 134；vs 957 +59）。`just check` 4 guards。

**Phase 6+7 不变量（详见 §44）**：daemon 不读 prod env token；`/sync/session` replace 语义；bridge-lifecycle 优先 ctx 缓存；toml transitional schema；GUI main 是唯一 plaintext+ciphertext 持有者；atomic toml 写顺序锁死；`restoreSessionOnStartup` 拒 fallback plaintext；`OWL_GUI_PARENT_PID` 探测闭环；`OWL_APP_VERSION` 单源。

---

## 历史：P5-d Phase 2-5 完成 — 2026-05-27（skybridge SDK 配套 + npm latest @0.1.3）

**Phase 2-5 已 ship 的内容**：

| Phase | 内容 | commit |
|---|---|---|
| 2 | skybridge SDK 三 additive API + 单测 | skybridge `220cc50` |
| 3 | npm publish 三包 `0.1.2@next` →（撞 logout 空 body 500 bug）→ bump 0.1.3 republish | skybridge `1f56edc` |
| 4 | owl dep bump `^0.1.3` + dual e2e 13→16 + SDK fixture smoke + D11 pre-existing fixture fix | owl `74066bb` + `41a699d` |
| 5 | promote `next → latest` 三包，`@orpheus-aviary/skybridge-{proto,client,server}@0.1.3` 上 npm `latest` | n/a（dist-tag move） |

**skybridge SDK 新增**（0.1.3 vs 0.1.1）：
- `client.logout()` → POST /v1/auth/logout（带 `body: {}` 避 Fastify 空 body 500）
- `client.listDevices()` → GET /v1/devices
- `subscribeEvents({ onFrame? })` 透传每个 SSE block；`parseFrame` 给 `:ok\n\n` 合成 `{event:'comment'}` 让 watchdog 能感知 keep-alive

**owl 端配套**：
- `packages/daemon/package.json`：`@orpheus-aviary/skybridge-client/server: ^0.1.3`
- 新文件 `packages/daemon/src/sync/skybridge-sdk-smoke.skybridge.e2e.ts`（spawn 0.1.3 server in-process 验三 API）
- `packages/daemon/src/sync/sse-bridge.skybridge.e2e.ts` D11 fixture 补 logger（之前 P5-c Step 10b `f73d052` 引入 `ctx.logger.warn` 后 D11 一直 stale，gated e2e CI 没触发所以漏。brief 之前的 13/13 baseline 实际是 12/13）

**测试基线（Phase 5 完成后）**：
- 单元 **957/957**（core 400 + daemon 216 + gui 207 + cli 134）
- **dual e2e 16/16**（旧 13 + 新 SDK smoke 3：logout 撤 token、listDevices 字段映射、subscribeEvents onFrame 收 :ok/ping/change）
- `just check` 4 guards 全过

**npm 状态**：

| 包 | latest | next |
|---|---|---|
| `@orpheus-aviary/skybridge-proto`  | 0.1.3 | 0.1.3 |
| `@orpheus-aviary/skybridge-client` | 0.1.3 | 0.1.3 |
| `@orpheus-aviary/skybridge-server` | 0.1.3 | 0.1.3 |

**Phase 6+ 接力点**：daemon `/sync/session` (replace) + `/sync/logout-local` + 删 `/sync/login` + 父进程 PID 探测 + dev 双 env gate（`OWL_DAEMON_DEV_TOKEN` + `OWL_ALLOW_INSECURE_DEV_TOKEN`）。`OWL_APP_VERSION` 在 Phase 6 开工时切回 `0.5.0-dev`。

**v3 关键不变量**（详见设计文档 §3）：
- 生产路径 daemon **完全不用 spawn env 传 token**（Node ChildProcess env 复制后不可撤）
- `/sync/session` 是 replace 语义：stopBackgroundHandles → 清旧 → set 新 → restart
- watchdog 直接 `unsubscribe + mark offline + scheduleReconnect()`，不依赖 close→onError
- `sync_cursor` 切号靠 `syncEndpointKey(serverUrl, workspaceId)` 隔离，logout **不动** cursor
- toml `[auth]` 写 `encrypted_token + user_id + email`；daemon 不读 `encrypted_token`，由 GUI main 通过 HTTP `/sync/session` 注入明文

---

## 历史：0.4.2 公开发版完成 — 2026-05-26

**Release**：https://github.com/orpheus-aviary/owl/releases/tag/v0.4.2

**包内容**：
- **新功能**：全局唤起快捷键（默认 ⌘⌥O，可在设置中改键，main process Electron globalShortcut + Settings UI）
- **Fix**：`⌘W` 在编辑区外不再误抢 macOS 关窗（只在 CodeMirror + 有 tab 时拦截）
- **Perf**：浏览页 NoteList 拖动 FolderPanel 边界时不再 380px 阈值闪现，每行加 CSS containment
- **内部**：skybridge 切到 npm 装的 `@orpheus-aviary/skybridge-{client,server}@0.1.1`，废止本地 tarball workflow（删 `scripts/skybridge-overrides.mjs` + `scripts/check-skybridge-not-committed.sh` + 同名 justfile recipe + 同名 check 守卫）

**版号路径决策**：0.5.0 仍保留给 P5-d（safeStorage keychain + 真实双机 soak），不动 ROADMAP gate。0.4.2 是 patch 级。

**测试基线**：**core 400 / daemon 216 / gui 207 / cli 134 = 957/957 干净 checkout**。`just check` 4 个守卫全过（5 → 4，`skybridge-not-committed` 守卫退役）。

**dmg artefact**：`Owl-0.4.2-arm64.dmg` 124 MB，sha256 `033f1027b682638cdbf752920b3a58f29b1011c36e5a1fceefa432ae3853eeee`。afterPack `codesign-adhoc.mjs` 钩子做 bundle-level ad-hoc 签名（沿用 0.4.1 模式）。

**OWL_APP_VERSION**（`packages/daemon/src/sync/session.ts`）：当前 `0.4.2`，下次 P5-d 开工时切回 `0.5.0-dev`。

---

## 历史：P5-c shipped (内部) — 自动化 + 手动 M1-M8 + 3 个 follow-up bug 全过 2026-05-25；不发版，下一步 P5-d 完工后才 0.5.0

**P5-c 设计文档**：`docs/plans/2026-05-24-p5-c-plan.md`（v5 锁定）
**手动 M1-M8 checklist**：`docs/plans/2026-05-24-p5-c-manual-checklist.md`
**M1-M8 暴露的 3 个 bug 闭环**：`docs/plans/2026-05-25-p5-c-manual-bugs.md`
**实施记录**：`docs/history/P5-c-shipped.md`

P5-c shipped 时测试基线：**core 392 / cli 134 / daemon 219 / gui 207 = 952/952 干净 checkout**，**965/965** 含 `SKYBRIDGE_E2E=1` gated dual e2e（13/13）。`just check` 5 个守卫全过。

**0.5.0 时机**：仍按原口径等 P5-d（safeStorage keychain + 真实双机 soak + logout 流程）完工再发；本次 manual M1-M8 暴露的 3 个 fix 直接进 P5-c 主线，不切 P5-c.5。

---

## 历史：P5-b shipped (内部) — 自动化 D1-D10 + 手动 D11/D11b 验收 2026-05-24 通过

**P5-b 设计文档**（v5 锁定）：`docs/plans/2026-05-22-p5-b-multi-entity-realtime-design.md`
**D11/D11b 手动 checklist**：`docs/plans/2026-05-24-p5-b-d11-d12-manual-checklist.md`
**实施记录**：`docs/history/P5-b-shipped.md`

### P5-b 切片（10 commit 主线 + 3 仓 docs 收尾）

| Step | 仓 | Commit | 内容 |
|---|---|---|---|
| 1+2 | owl | `d70b8fc` | schema v6 `0006_device_id_split.sql`（ADD COLUMN `local_device_uuid` + NOT NULL trigger，不重建表）+ mutation 写两列；F4 device_id 双命名空间分手 |
| 3 | owl | `9505910` | `deleteFolder` emit payload 加 `updated_at_ms`（LWW 锚点对齐 note/delete） |
| 4 | owl | `79c47fd` | 抽 `syncNoteTags` → `notes/tags.ts` 给 apply 路径复用 |
| 5 | owl | `ce95c3f` | folder + conversation apply-side validator；note tag_type 收紧为 `TagType` enum |
| 6 | owl | `e75ce86` | engine 路由按 entity_type 分发；folder sparse update / conversation append-merge / note apply 调 `syncNoteTags + syncReminders` |
| 7 | owl | `0af56c4` | session helper（`ensureSkybridgeSession` + ctx 缓存）+ SSE bridge（永久重连 + onOpen catch-up）+ `persistSkybridgeIds` 进 core |
| 8 | owl | `a6db4b7` | `sync:status_changed` OwlEvent + `SyncStatusSnapshot` + status-broadcaster + `manual.ts` 包 markSyncing/markSuccess/markError + `scheduler.reload()` |
| 9 | owl | `321e308` | GUI `<SyncStatusBar />` 挂 sidebar 最下 + 四态徽章 + popover；`events-subscriber-core` 加 sync 分支；冷启动 fetch 兜底 |
| 10a | owl | `a1a8f16` | `bridge-lifecycle.ts` daemon-boot SSE 接入（只在 toml 完全 bootstrapped 时 auto-start）+ DI 单测 |
| 10b | owl | `94972f2` | `sync.dual.e2e.ts` 自动化 D1-D10（core-only + in-process skybridge）+ D11/D11b/D12 处置矩阵 |
| 11-owl | owl | `10e98d0` | `docs/history/P5-b-shipped.md` + `CLAUDE.md` skybridge debug 章节 |
| 11-aviary | aviary | `ea3e312` | ROADMAP P5-a/b/c 三段拆 + SKYBRIDGE_ARCH Phase 4-a/b/c 拆 |
| 11-skybridge | skybridge | `177de0b` | PROCESS.md 记 owl P5-a/b 集成验收 |
| 12 | — | n/a | 自动化 + 手动验收全过（见 `docs/history/P5-b-shipped.md` § 自动化验收 + § 手动验收） |

测试基线：**owl 802/802 干净 checkout**（core 314 + cli 134 + daemon 177 + gui 177），**813/813** 含 `SKYBRIDGE_E2E=1` gated dual e2e。`just check` 全绿。skybridge / aviary 仓不动 server 端测试基线。

owl `main` 比 origin 多 32 commits（未 push）；本地**不发版**、不 npm publish、不 push tag。

### P5-b 手动验收期间新发现 3 个 P5-c 待办（2026-05-24）

| 编号 | 现象 | 触发条件 | 处置方向 |
|---|---|---|---|
| **G1** | GUI `preload/index.ts:46` 硬编码 `daemonUrl: 'http://127.0.0.1:47010'`，没读 `OWL_DAEMON_PORT` | `OWL_DAEMON_PORT=47011 just dev-fast` 启 GUI 时，渲染进程仍连 47010；F2 fix 只覆盖了 main 进程 spawn 端口 | P5-c 修：preload 通过 env-injected constant 或 IPC 拿到端口 |
| **G2** | skybridge server SIGTERM 优雅关闭时，`@skybridge/client/sse.js` 的 `reader.read()` 收到 `{ done: true }` **静默退出 read loop**，不触发 `onError`；bridge 卡 zombie 永不重连，GUI 永远显示"已同步" | 服务器优雅 shutdown（不是 crash）+ 不重启时永久卡 zombie，必须 daemon 重启才能恢复。SIGKILL 路径正常 | P5-c 修：在 skybridge 仓的 `pumpStream` 里给 `done: true` 路径补 fire `onError(new NetworkError('SSE stream ended'))` |
| **G3** | SyncStatusBar 的 `syncing` 蓝色旋转动画 < 100ms，肉眼看不见 | runSync 本地同进程对 in-memory skybridge 跑得太快，markSyncing → markSuccess 几乎没可视化时间 | P5-c 修：UI 加 minimum-display-duration（e.g. `syncing` 至少展示 300-500ms，即使 runSync 已返回） |

P5-b Step 10b 期间还从代码里发现两个**设计 §3.3 没完成实施**的 gap，一并记 P5-c：

| 编号 | 现象 | 来源 |
|---|---|---|
| **G4** | `createNote` / `updateNote` 没从 `local_metadata.skybridge_device_id` 读 → 本地新建 note 的 `notes.device_id` 落 NULL（apply 路径正常） | dual.e2e D2 assertion 翻车暴露；与设计 §3.3 不符 |
| **G5** | `createNote` / `updateNote` 不触发 `syncReminders` → /alarm note 本地不立刻生成 reminder_status；现在依赖 daemon `ReminderScheduler` 轮询补 | dual.e2e D10 显式调 syncReminders 模拟 scheduler tick |

### 下一阶段 P5-c（未排期）→ 完成后发 0.5.0

- 后台 sync 触发：定时（可配置间隔）+ 网络恢复 + 应用启动（SSE event 触发 P5-b 已完成）
- 429 / 5xx retry 策略 + jitter（与 SSE bridge 重连退避独立）
- `conflict_record` 写入语义 + 冲突 UI
- 真实双机 + 远程 server soak
- keychain 替换明文 token
- 上述 G1-G5 follow-up 一并修

## 历史：0.4.x 发版状态

P5-a 前的基线 **600/600 测试通过**（core 187 + cli 119 + daemon 138 + gui 156）。P3.4 + P4 Phase 1+2 全部 shipped，2026-05-08 发 0.4.0；2026-05-09 发 GUI 0.4.1 hotfix（修复 macOS Sequoia 上 dmg 安装后报"已损坏"，原因是 electron-builder `identity: null` 跳过了 bundle-level codesign，新增 `afterPack` 钩子做 ad-hoc 签名）：

- GUI 0.4.1 Release：https://github.com/orpheus-aviary/owl/releases/tag/v0.4.1（`Owl-0.4.1-arm64.dmg`，sha256 `be62243b...67e23b7`）
- GUI 0.4.0（已废）：https://github.com/orpheus-aviary/owl/releases/tag/v0.4.0
- CLI npm：`npm i -g @orpheus-aviary/owl-cli`（@0.4.0，hotfix 仅改 GUI 打包，CLI 不受影响）
- 实施细节：`docs/history/P3-4-P4-shipped.md`

## 整体路线

```
P3.4 UX 完善 ✅ + P4 skybridge Phase 1+2 ✅ → 0.4.0 发版完成
  → P5 skybridge Phase 3+4（server 首发 + 后台 sync，发 0.5.0）
  → P6 skybridge Phase 5（多设备 GA，发 1.0.0 候选）
  → P7 打包 / 发布自动化
  → P8 次要功能集
  └→ P3.5 可选 MCP server（任意时刻并行）
```

完整规划：`aviary/docs/ROADMAP.md`（跨仓路线）、`docs/plans/2026-04-20-p3-plan.md`（owl 历史 P3 规划，§8 已作废）。

**P8 非核心**（原 "P6 非核心"，届时再定 scope）：tray 图标 / 图片粘贴 / FIM 补全 / `append_memo` 语义 / AI banner option C / `[[` note-link / 编辑器正文 slash command / `owl doctor --recover` / CLI 别名 / `@owl/core` 公开发布 / 0.3.0 rebuild 代码移除。

## 历史归档

每个已 ship 阶段的实施细节都收在对应设计文档的 `## Implementation record` 段，或 `docs/history/` 下的专题 doc：

| 阶段 | 位置 |
|---|---|
| P0 / P1 基础搭建 | `docs/history/P0-P1-shipped.md` |
| P2 功能完善 | `docs/history/P2-shipped.md`（含 commit 表 + 设计文档引用） |
| P3.0.5 pre-release polish | `docs/history/P3-0-5-shipped.md` |
| P3.1 GUI 0.2.0 首发 | `docs/plans/2026-04-28-p3-1-gui-0.2.0-release-design.md` § Implementation record |
| P3.2-a migration runner | `docs/plans/2026-04-29-p3-2-a-migration-runner-design.md` § Implementation record |
| P3.2-b MigrationDialog | `docs/plans/2026-04-30-p3-2-b-migration-dialog-design.md` § Implementation record |
| P3.2-c CLI 核心 | `docs/plans/2026-05-02-p3-2-c-cli-core-design.md` § Implementation record |
| P3.2-d SSE 反向通道 | `docs/plans/2026-05-02-p3-2-d-events-channel-design.md` § Implementation record |
| P3.2.5 release polish | `docs/plans/2026-05-03-p3-2-5-design.md` § Implementation record |
| P3.3 0.3.0 发版 | `docs/history/P3-3-shipped.md` |
| P3.4 UX 完善 + P4 skybridge Phase 1+2 + 0.4.0 发版 + 0.4.1 hotfix | `docs/history/P3-4-P4-shipped.md` |
| P5-a skybridge sync engine 单机版（内部 2026-05-22） | `docs/history/P5-a-shipped.md` |
| P5-b 多 entity apply + SSE 实时 + GUI 状态栏（内部 2026-05-24） | `docs/history/P5-b-shipped.md` |

P2-8 / P2-9 手动测试清单分别在 `docs/plans/2026-04-17-p2-8-ai-page.md` 和 `docs/plans/2026-04-20-p2-9-resizable-panels.md` 的附录段。

## 关键参考

- 跨仓路线（skybridge 对接上下文）：`aviary/docs/ROADMAP.md`
- skybridge 架构框架：`aviary/docs/SKYBRIDGE_ARCH.md`
- owl P4 skybridge 对接计划：`docs/plans/2026-05-07-p4-skybridge-plan.md`（已 ship，docs/history 里有完整记录）
- 完整 COEDIT 计划：`docs/plans/COEDIT_PLAN.md`
- 聊天持久化设计（P3.4-f）：`docs/plans/2026-04-18-chat-persistence.md`
- P3 总规划（§8 已作废）：`docs/plans/2026-04-20-p3-plan.md`
