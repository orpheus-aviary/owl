# owl 同步身份与数据模型重构 —— per-profile 隔离设计（定稿）

> **状态**：定稿 v6（2026-05-30）。D1-D11 + W1-W13 全部拍板，见 **§0.5 决策总账**（权威，与正文冲突以总账为准）。**Phase 12-21 全部完成并落本地 main（2026-06-06，未 push）；下一步 Phase 22（0.5.0 bump+发版）→ 23（push）。逐 phase 状态见 PROCESS.md。**
> 起草 2026-05-29，缘起 P5-d Phase 10.6（同名设备去重）讨论中暴露的根因问题。
>
> 关系：
> - **取代/收编** `2026-05-26-p5-d-design.md` §3.6.2（cursor 按 workspace 隔离）与 Phase 10.6（同名设备去重）/ 10.5（device revoke）——前两者被 per-profile 隔离自然吸收；revoke 收编进 §14 skybridge 0.1.4 + Phase 17。
> - **收编** [[multi-profile wish]]（memory，原定 0.6 头牌）：**免密快切（含 refresh-token）现已并入 0.5.0**（W4 决定），不再留 0.6。
> - Phase 12 子设计见 `2026-05-29-phase12-profile-foundation.md`。
>
> 历史：v1-v5 是讨论稿（B1-B10 blocker、D1-D9）。v6 后**废案已就地清理**——profileId 由 url 改 server_id（D11）、D2 由 revoke 翻转为保留 refresh-token、§7 由"不需 server 能力"改为需 skybridge 0.1.4。下方正文已同步，不留矛盾旧文。

---

## 0. 一句话

owl 当前是**单租户**模型：`owl.db` / `toml` / `sync_cursor` / `local_metadata` 把"这台机器 / 这个账号 / 这个 workspace / 纯本地数据"揉在一起。这导致切账号串味、首登静默合并、同名设备堆积、cursor 复用等一连串问题。**根因解法是引入 profile，让每个 profile 拥有独立的本地副本与独立身份。**

---

## 0.5 决策总账（权威，2026-05-30 全部拍板）

> 与下方正文冲突时**以本节为准**。后面开发照此执行，无歧义。

**身份模型（终态）**
- `profile = (server_id, user_id)`，`profileId = sha256(server_id + "\n" + user_id)` 前 32 位（128-bit）。**D11**：锚点是 **server_id**，不是 url —— 换 server 部署位置/换 url 不影响找回工作区。
- **server_id**：skybridge server 端长随机标识，首次 init 自动生成 + **持久化于 server db `server_meta`** + **可在 config 文件显式覆盖**（迁移/换部署时带过去 → 客户端按 server_id 认旧 profile，只更新存的 url；config≠db 时 server 打 loud warning）。存储细节见 Phase S 子设计 §2（`2026-05-30-phase-S-skybridge-0.1.4.md`，跨仓 skybridge）。安全网：server_id 变了但 user_id 命中既有 profile → 提示"换服务器了，关联到既有 profile？"
- **local profile = `~/orpheus-aviary-nest/owl/owl.db` 原地**（**D10a**，Option B）。纯本地用户零迁移；账号在 `profiles/<id>/owl.db`。
- 设备名仅显示；device_id 存 profile db、跨 logout 复用（§5.3）。

**数据 / 同步**
- 每登录设备 + server 各存一份副本，最终一致（op-log 先拉后推）。
- **账号同步永不写 `owl/owl.db`**（不变式）：local 只在"认领空账号"时被 copy 一次（非 move），其余账号活动碰不到它。
- **导入（D10b）**：local→账号**仅限"认领空账号"**（copy local→profiles/<A>，整库认领）。登录**非空**账号 = 纯拉取(首次)/增量(回访)，**不并入 local**。local→非空账号的显式导入 = 0.6+。跨账号导入 = 0.6+。
- **LWW + W3**：全笔记 LWW 按时间戳；时间戳改用 **server 归一化时间**（client 存 offset = server_t − local_t）+ **per-device 单调 counter** tie-breaker（HLC-lite）→ 整机时钟平移不影响。冲突存 conflict_record（输方可见）。

**Token / 切换（D2 翻转）**
- **快切并入 0.5.0**（**D1 重开 / W4**）：refresh-token 流，**带轮换**。登录发 短 access + 长 refresh_token；refresh 按 profile 加密存 keychain。
- **切换/停用 = 保留 refresh_token，不 revoke**；**仅"完全登出 / 移除设备"才 revoke**。再进 profile 用 refresh 免密；refresh 失效才回退密码。

**skybridge 0.1.4 server 能力（§14，0.5.0 新增依赖，跨仓）**
1. 暴露 `server_id`（登录响应 + `/server-info`）2. 同步响应回**权威 server 时间** 3. **`/auth/refresh`（带轮换）** 4. **device revoke/delete 端点**。

**W1-W13 处置**：见 **§13**（同意/文档/Phase/弃）。重点：W11 附件**不做**（保持轻量，仅保证不埋坑）；W5 提醒仅 active profile（文档注明）；W2 迁移强制留 local（B5 简化、B8 降为告警）。

**路线**：见重排后的 **§11**。Phase 12 ✅ 完成；下一步 **Phase S（skybridge 0.1.4）** 与 Phase 13/14 可并行，Phase 15 前合流。

---

## 1. 缘起：一组质疑串起同一个根

P5-d Phase 10.6 本来只想解决"同名设备堆积"，但讨论中浮现 8 个互相关联的疑问，全部指向同一个根：

| # | 质疑 | 指向的根因 |
|---|------|-----------|
| 1 | 设备名应只作显示、用稳定身份防名称冲突 | 身份模型把"机器名"当 reuse key |
| 2 | 2 个账号在本地/server 的存储结构 | 本地无账号维度；server 靠 user_id 分区 |
| 3 | 一台机器跑两个 skybridge 是否不推荐 | 见 §10 澄清（与本文模型正交） |
| 4 | 本地设备列表的实际用途 | 设备身份不稳定 → 列表只能当日志看 |
| 5 | 本地 workspace 存储逻辑、是否绑账号 | workspace 身份只是 1 个 metadata 值，绑得很松 |
| 6 | 一台推了数据，另一台首登是拉还是覆盖 | 同步是 op-log merge，但**无隔离** |
| 7 | 本地是否应按账号隔离单独存储 | **核心：是。本文主张。** |
| 8 | 非空设备首登有数据的账号怎么 merge | 静默并集合并，无询问 → "不合理" |

---

## 2. 失败模式清单（均对照代码验证，附 file:line）

### 已验证的底层事实

- **`emitSyncChange` 无条件执行**：每次增删改都在同一事务追一行 `sync_changes`，与登录状态无关（`packages/core/src/sync/changes.ts:58`）。`sync_changes.device_id` = 本机 `local_metadata.device_uuid`。
- **runSync = 先拉后推**：Step 1 pull（`engine.ts:820`），Step 2 push `WHERE synced_at IS NULL`（`engine.ts:874`）。
- **logout 不碰数据**：`clearSyncIdentity` 只删 `local_metadata` 三个 skybridge 键，**不动 `sync_changes` / `sync_cursor`**（`packages/core/src/skybridge/identity.ts:59`）。
- **`sync_cursor` 只按 server URL 做 key**（`engine.ts:115` / `:809`）。
- **server `devices` 表无 fingerprint、无 `UNIQUE(user_id,name)`**；`registerDevice` 是纯 `INSERT`，每次新 id（`skybridge/.../routes/devices.ts:90`）。
- **server pull 不按 device 过滤**（`skybridge/.../services/change-log.ts:173`）；设备鉴权只校验归属（`auth/plugin.ts:114`）→ **共享 device_id 不破坏同步，复用旧 device_id 配新 token 放行**。
- **`openDatabase({ dbPath })` 路径已参数化**（`packages/core/src/db/index.ts:43`），`dbPath()` 是单一函数（`paths.ts:36`）；`ctx.db` / `ctx.sqlite` boot 时开一次（`context.ts:15`）。
- **`ReminderScheduler` 构造时闭包持有 `db/sqlite/config`**（`packages/daemon/src/scheduler.ts:38`），有 `start()/stop()`。
- **CLI 默认开全局库**：`apps/cli/src/lib/config.ts:43` `dbPath = overrides.dbPath ?? paths.dbPath()`；direct 模式 `createDatabase({ dbPath })`（`backend/direct.ts:82`）。
- **GUI 启动 precheck 只看单一全局库**：`runMigrationPrecheck(paths.dbPath())`（`packages/gui/src/main/index.ts:73`）。
- **server workspace `UNIQUE(owner_id, tool, name)`** → 每账号一个 `owl/default`。

### 由此产生的症状

**F1 · 同名设备堆积**（质疑 #1#4）
`registerDevice` 每次 INSERT；logout 清掉本地 device_id（toml `[device]` + `local_metadata.skybridge_device_id`）→ 每次 logout→login 多一行。真实数据已积 6 行 `jay@local (owl)`。**主因是 logout 丢了 device_id，不是 hostname 冲突。**

**F2 · 切账号三重串味**（质疑 #5#6#7）
同一 nest 下 logout A → login B：
- **界面串味**：B 下仍显示 A 的笔记（`owl.db` 无账号维度）。
- **推送串味**：编辑 A 的笔记 → 新 update 推进 **B 的 workspace**。
- **cursor 串味**：pull B 时 `sync_cursor WHERE endpoint=serverUrl` 命中 **A 的 pulled_seq** → B 从错误基线起拉、可能漏拉（Phase 12 原计划用 `syncEndpointKey` 修，但只修 cursor，不修前两个）。

**F3 · 非空设备首登静默并集**（质疑 #8）
设备 2 本地有 N 条笔记，首登有数据的账号 A：先拉下 A 的全部，**同时把自己 N 条 `synced_at IS NULL` 的笔记推进 A**（id 不撞 → 纯并集，无 LWW、无丢失，但**无询问、不可撤销**）。"我登录一个已有账号，本地笔记被静默并上去了"——这就是 #8 说的不合理。

**F4 · 纯本地 → 首登 行为不可控**
纯本地期 `sync_changes` 一直累积；首登瞬间全灌进当时那个账号。用户没有"哪些该上传 / 保持独立"的选择权。

> F1~F4 同源：**缺少"一个账号 = 一份隔离的本地副本 + 一个稳定身份"这一层。**

---

## 3. 根因：四个概念被压成一个

| 概念 | 本应是 | 当前实现 |
|------|--------|---------|
| 机器 | 稳定的物理/安装实例身份 | `local_metadata.device_uuid`（仅本 nest 稳定） |
| 账号 | 登录主体 | toml 单 `[auth]` |
| workspace | 账号下的同步域 | `local_metadata.skybridge_workspace_id` 单值 |
| 本地副本 | 某账号数据在本机的镜像 | **整个 `owl.db`（无账号维度）** |

`owl.db` 既是"账号 A 的副本"又是"账号 B 的副本"又是"纯本地草稿"——全压在一个文件里，靠切 toml 的几个 id 假装切换，底层不隔离 → F2/F3/F4。

---

## 4. 设计原则（正确模型必须保证）

1. **隔离**：账号 A 的笔记永不出现在账号 B 的视图，永不被推进 B。
2. **稳定身份**：同一机器 + 同一账号，跨 logout/login 复用同一个 skybridge device（不堆积）；设备名仅作显示。
3. **无静默合并**：纯本地数据并入某账号必须是**显式选择**。
4. **确定性**：再次登录同一账号 → 落到同一本地副本，无需额外注册表查找。
5. **最小侵入已交付架构**：复用现有 session install / keychain / sync engine，不推倒。
6. **可分期**：隔离正确性（0.5.0）与快捷切换体验（0.6）可拆。
7. **切库无竞态、无残留入口**（v2 新增，见 §6）：切 profile 必须原子地换掉**所有**持旧 db 的句柄；任何旁路（CLI direct / 启动 precheck）都必须解析当前 profile，不得退回全局旧库。

---

## 5. 提议方案：profile 模型

### 5.0 统一 profile 路径解析（core resolver —— 开工第一步，**blocker B6，见 §6**）

当前多处入口各自默认全局 `paths.dbPath()`，per-profile 后**任何一处漏改 = 旧库旁路入口**：
- daemon boot：`createDatabase({ dbPath: paths.dbPath() })`（`packages/daemon/src/cli.ts:62`）
- GUI 启动 precheck：`runMigrationPrecheck(paths.dbPath())`（`packages/gui/src/main/index.ts:73`）
- CLI：`dbPath = overrides.dbPath ?? paths.dbPath()`（`apps/cli/src/lib/config.ts:43`）

**开发顺序硬性要求：先在 `@owl/core` 加 profile resolver，再替换上述全部入口。**
- 新增 `resolveActiveProfileDbPath(): string` —— 读 `skybridge_config.toml.active_profile` → 账号 = `profiles/<id>/owl.db`；**`local` = `owl/owl.db`（D10a，根目录原地，非 profiles/local）**。
  - **上述是 Phase 13 完成后的目标态。** **Phase 12 带"存在性闸 + profileId 校验"且未迁移**：无 active / 非法 id / 目标 profile db 不存在 → **一律静默回退 legacy `paths.dbPath()`**（绝不新建空库）→ 运行时行为 0-diff。
  - ⚠️ **Phase 12 已 ship 的 `localProfileDbPath()` 暂指 `profiles/local/owl.db`（provisional）；D10a 后 Phase 13 把 `local` 重映射到 `owl/owl.db`（= `paths.dbPath()`）。** 详见 Phase 12 子设计 T1。
- 三个入口（cli.ts:62 / index.ts:73 / config.ts:43）全部改调 resolver；`paths.dbPath()` 退役为内部实现/escape-hatch。
- CLI `--db` 显式覆盖仍保留（§5.8 escape hatch）。

### 5.1 profile 定义

> **profile = (`server_id`, `user_id`)**，`profileId = sha256(server_id + "\n" + user_id).hex 前 32 位（128-bit）`。（**D11**，2026-05-30 定）

- **锚点是 server_id 不是 url**：server 换部署位置/换 url，只要 server_id 不变 → 仍命中同一 profile、找回工作区（见 §0.5 / §14）。
- `server_id` = skybridge server 端长随机标识（首次 init 自动生成 + **持久化于 server db `server_meta`** + **config 文件可显式覆盖以迁移带走**，见 Phase S 子设计 §2）。client 登录时从 server 拿到并存进 profile。
- **`server_url` 不再进 profileId**，降级为 profile 内的连接地址（可变）。仍归一化它（`new URL`、仅 http/https、小写 scheme+host、默认端口剥离/非默认保留、path 去尾斜杠保留非根前缀、丢 query/hash）**仅用于存储/显示/去重**。⚠️ Phase 12 的 `computeProfileId(url,user)` 是 **provisional**，Phase 15 改为 `computeProfileId(server_id,user)`。
- 确定性 → 再次登录同一账号自然命中同一 profile（原则 4）。
- 不含 device → 同账号在本机始终一个 profile（device 复用见 §5.3）。
- workspace 暂仍是 profile 内的 `owl/default`（owl 只用一个）；未来多 workspace 可在 profile 内再分。

### 5.2 存储布局

```
~/orpheus-aviary-nest/owl/
├── profiles/
│   ├── <profileId-A>/owl.db        # 账号 A 的隔离副本（notes/sync_changes/sync_cursor/local_metadata 全独立）
│   └── <profileId-B>/owl.db        # 账号 B
├── owl.db                          # **local profile（D10a，原地，纯本地/离线，账号同步永不写它）**
├── owl_config.toml                 # 本地偏好，跨 profile 共享（不同步、不分 profile）
└── logs/
```
（纯本地用户只有 `owl/owl.db`，无 `profiles/`；登录账号才长出 `profiles/<id>/`。）
```
~/orpheus-aviary-nest/skybridge/skybridge_config.toml
  active_profile = "<profileId-A>"          # 当前激活；"local" 表示 owl/owl.db
  [profiles.<profileId-A>]
    server_id, server_url, user_id, email    # server_id = profileId 锚点；server_url 可变
    encrypted_refresh_token                  # safeStorage 密文 refresh_token（D2 翻转：切换保留，仅完全登出/移除设备才 revoke）
    device = { id, name }
    workspace = { id, slug }
  [profiles.<profileId-B>] ...
```

要点：
- **profile 的 db 文件本身就是"注册表 + 设备记忆"** —— db 在 → 这个账号本机用过 → 它的 `local_metadata` 里存着上次的 `skybridge_device_id`（§5.3）。无需单独注册表文件。
- toml 只存**密文 token + 展示字段 + device/workspace id**（不含明文，沿用 Phase 7 keychain 模型）。
- `owl_config.toml`（interval、UI 偏好等）跨 profile 共享，不动。
- 迁移：0.4.2/0.5.0-dev 老用户的单 `[auth]` + `owl/owl.db` → 一次性迁成 `profiles.<id>/owl.db` + `[profiles.<id>]`（非破坏，见 §5.7）。

### 5.3 身份：device_id per-profile（收编原 Phase 10.6，回答质疑 #1）

- **设备名 `${hostname} (owl)` 仅作显示**，不再当 reuse key。
- **reuse key = profile db 里记住的 `skybridge_device_id`**：
  - 登录账号 A → profile A 的 db 存在 → 读其 `local_metadata.skybridge_device_id` → **直接复用，跳过 registerDevice**（已验证：旧 device_id 配新 token，server 鉴权放行、同步不破）。
  - profile A 的 db 不存在（本机首次登 A）→ registerDevice 出新行（**正确**：新机器/新副本本就是新设备）。
  - 复用的 device_id 若被 server 撤销（未来 10.5 revoke）→ 撞 403 `DEVICE_FORBIDDEN` → fallback registerDevice。
- **关键**：profile db **不随 logout 删除** → device_id 记忆天然跨 logout 存活 → **F1 同名堆积从根上消失**，且**零 hostname 冲突风险**（不靠名字匹配）。
- 这就是之前讨论的"思路 D"，在 profile 模型下变成自然结果，不需额外机制。
- OS 级硬件 fingerprint（IOPlatformUUID / machine-id）只在"同机 wipe nest 重装也要复用"才需要，且要 server 加字段 → 留作未来可选增强，**不在本方案**。

### 5.4 登录 / 切换 / 登出（含 db replace dance 与 token 生命周期）

#### 5.4.1 登录（顺序：先在当前 profile 备好目标库，再 switch，**blocker B9，见 §6**）

> 关键：**import / 认领决策必须在 daemon switch 之前、当前 profile 仍可访问时完成**。文档 v1/v2 像"先 switch 再判断 import"——那样先建了空目标库会丢掉 import 来源。

```
登录(server_url, email, password):
  1. remote login → access+refresh token + user_id + **server_id**（仍在当前 active profile，未切库）
  2. profileId = hash(server_id, user_id)               （D11，server_id 锚点，不用 url）
  3. 备目标库（仍未 switch）:
       目标 profile db 已存在             → mode=reuse（稍后读其 device_id）
       目标不存在 + 账号空 + local 有笔记 → §5.5 import 抉择:
                                            并入 → 复制 owl/owl.db → profiles/<id>/owl.db（认领，switch 前完成）
                                            独立 → 准备空 profiles/<id>/owl.db
       目标不存在 + 账号空 + local 空      → 准备空 profiles/<id>/owl.db
       目标不存在 + 账号非空              → 准备空 profiles/<id>/owl.db、纯拉取（不并 local，D10b）
  4. daemon switch（§5.4.2 完整重建）→ 打开已备好的目标库
  5. install session: device 复用 or registerDevice → ensureWorkspace → 注入 → sync(先拉后推)
  6. 写 toml [profiles.<id>]（server_id/server_url/user_id + encrypted_refresh_token）+ active_profile
```

#### 5.4.2 profile switch —— 完整状态重建（**blocker B1，见 §6**）

仅换 `ctx.db/ctx.sqlite` **远远不够**：daemon 多处缓存/闭包绑着旧 db 或旧 ctx（D8 闭包审计已穷尽 daemon 包，结论见 §5.4.2-bis）：
- `ReminderScheduler`（scheduler.ts:38）构造体闭包持旧 `db/sqlite` → **rebuild**。
- **`ConversationStore`（conversations.ts:49）构造时捕获 `sqlite`，所有方法用 `this.sqlite`** → **必须 rebuild（D8 审计新发现，原 B1 未列）**；只清内存 Map 不够，handle 仍指旧库。
- `SyncStatusBroadcaster`（status-broadcaster.ts:29 WeakMap by ctx）：闭包对 `ctx.sqlite`/`ctx.eventsBus` 是 **call-time live 读**，但 `current` 快照含旧 profile 的 server_url/device_id/workspace_id/seq → **evict WeakMap 项**重建。
- `runManualSync` 模块级 `currentCtx` + `syncCoalescer`（manual.ts:204）：`doRunManualSync` 对 `ctx.db/ctx.sqlite` 是 live 读，**原地 mutate 下 currentCtx 无需重置**（指向同一 mutated ctx）；真正要求 = **drain in-flight coalescer 轮**（push/pull 事务不能落在被 `close()` 的旧 sqlite 上）+ switch 期 block 新触发。
- `ctx.skybridgeSession` 清 null；`previewStore` 内存数据清。

完整时序（switch mutex + drain + 状态重建）：

```
profile switch(→ X):
  1. quiesce  取 switch mutex；拒绝新 sync 触发 + 业务写 HTTP；
              drain：等 in-flight push/pull/apply 事务 + mutation + 已在飞的 syncCoalescer 轮排空
  2. stop     stopBackgroundHandles(SSE bridge + syncScheduler)
              + ReminderScheduler.stop() 后丢弃（scheduler.ts:38）
              + 清 ctx.skybridgeSession = null
              + 清 previewStore 内存
  3. swap     ctx.sqlite.close()（better-sqlite3 显式关）
              + 开 profiles/<X>/owl.db → 新 ctx.db / ctx.sqlite + 重设 ctx.deviceId(ensureDeviceId 新库)
  4. rebuild  new ReminderScheduler(新 db,...).start()
              + new ConversationStore(新 sqlite) 替换 ctx.conversationStore（D8 审计新增）
              + evict SyncStatusBroadcaster WeakMap 项（status-broadcaster.ts:29）→ 下次 get 用新 initialSnapshot 重建
              + installSkybridgeSession(X) + startBackgroundHandles
              （manual.ts currentCtx 无需重置——指向同一 mutated ctx；in-flight 已在 step 1 drain）
  5. notify   renderer 受控刷新（见 §5.4.4）；释放 switch mutex
```

- **ctx 重建（D8 已定：原地 mutate）**：保持 ctx 对象身份不变 → 所有持 ctx 引用的 route/handle 无需重接线；代价是必须**显式** evict broadcaster WeakMap 项（以 ctx 为 key，原地 mutate 不会自动 miss）+ 重置 manual.ts 模块级 state + rebuild ReminderScheduler。（弃 "新建 AppContext"：虽 WeakMap 自动 miss，但要重接所有持旧 ctx 的 route/handle，面更大易漏。）
- **boot 闭包审计（D8 前置）✅ 已完成 2026-05-29**：穷尽 daemon 包，结论见 §5.4.2-bis。待审三者 `eventsBus`/`toolRegistry`/`llmClientFactory` **全部不持 db** → 安全；新发现 `ConversationStore` 持 sqlite，已纳入重建清单。
- **switch mutex（D9 已定：独立 ctx 级锁）**：新引入独立 switch gate，覆盖 sync(push/pull/apply) + 业务 mutation + scheduler tick；swap 不得落在任何上述操作期间。不复用 `syncCoalescer`（manual.ts:204，职责仅串行化 sync run，盖不住业务写/scheduler）。

#### 5.4.2-bis D8 boot 闭包审计结论（2026-05-29，daemon 包穷尽）

判据：boot 构造的对象，**构造时捕获 `db`/`sqlite`**（→ switch 须 rebuild）vs **call-time 读 `ctx.X`**（→ 原地 mutate 后自然生效）。穷尽性：`rg "^let "` 全包仅 `manual.ts:204` 一个模块级可变单例；`rg "new (Weak)Map"` 仅 `status-broadcaster.ts:29` 一个 ctx-keyed cache；无其它隐藏单例。

| boot 对象（cli.ts:85-91） | 是否持 db/sqlite | switch 处置 |
|---|---|---|
| `ReminderScheduler(db,sqlite,config,logger)` | 是（`this.db/this.sqlite`，scheduler.ts:38-43） | **rebuild** + start |
| `ConversationStore(sqlite)` | 是（`this.sqlite`，conversations.ts:49）**⚠️新发现** | **rebuild**（替换 ctx.conversationStore） |
| `SyncStatusBroadcaster`（WeakMap by ctx） | 否（live 读 ctx.sqlite/eventsBus），但 `current` 快照旧 | **evict WeakMap 项** → 重建快照 |
| `manual.ts currentCtx`/`syncCoalescer` | 否（doRunManualSync live 读 ctx.db/sqlite，manual.ts:237-238） | **drain in-flight** + block 新触发；currentCtx 不重置 |
| routes（notes/folders/tags/todo/config/ai/events/sync/conflicts） | 否（`buildServer(ctx)` 共享同一 ctx 引用，handler live 读 ctx.db/sqlite；已 grep 验证无注册期解构/赋值捕获） | 不动（mutate 后自动见新库）—**原地 mutate 成立的决定性依据** |
| ToolContext（routes/ai.ts:68-73；manual.ts:237） | 否（每请求从 ctx.db/sqlite 现建） | 不动 |
| `eventsBus`（EventsBus，Set<Subscriber>） | 否（无 db） | 不动；subscribers 是 SSE 连接，B7 renderer reload 重订阅 |
| `previewStore`（无参 in-memory） | 否 | 清内存 |
| `toolRegistry`（createBuiltinRegistry() 无参，db 走 per-call ToolContext） | 否 | 不动 |
| `llmClientFactory`（(config)=>client，routes/ai.ts:38） | 否（吃 config 非 db） | 不动 |
| `ctx.deviceId`（ensureDeviceId(db) 值） | — | **重设**（从新库 ensureDeviceId） |
| `ctx.config` | — | 不动（owl_config.toml 跨 profile 共享，§5.2） |
| `parentProbe`（闭包持 ctx，cli.ts:286-293） | 否（持 ctx 引用，mutate 安全） | 不动（process 级，watch parent PID，与 profile 正交） |

**结论**：原地 mutate ctx 成立且更优。Phase 14 switch 重置清单 = **rebuild**{ReminderScheduler, ConversationStore} + **evict**{Broadcaster WeakMap} + **重设**{ctx.deviceId, ctx.db, ctx.sqlite} + **drain**{in-flight syncCoalescer 轮} + **清**{skybridgeSession, previewStore} + **stop/restart**{sseBridge, syncScheduler} + **不动**{routes, eventsBus, toolRegistry, llmClientFactory, config, parentProbe}。

#### 5.4.3 登出 / 停用 / 删除（拆分两类动作，**blocker B4，见 §6**）

**D2 翻转（2026-05-30，W4：快切并入 0.5.0）**：原 v5 为"切换即 revoke、快切留 0.6"；现改为 **refresh-token 流（带轮换）、切换保留 token、仅完全登出/移除设备才 revoke**。三类动作：

- **切换 / 停用 / 切回 local**（step away，**最常见，免密**）
  - db replace dance（§5.4.2）
  - **保留** profile DB + device id + workspace id + **encrypted_refresh_token**
  - **不 revoke、不清 token**；`active_profile` → 目标（账号 or `local`=owl/owl.db）
  - 再进入此 profile：用存的 refresh_token 换新 access_token **免密**进入；refresh 失效（过期/被吊销）才回退输密码
- **完全登出**（log out，主动退出账号）
  - 上面的 db replace + **远端 revoke refresh_token + 清 toml 密文**
  - **绝不**对 profile db 跑 `clearSyncIdentity`（会删 `skybridge_device_id`，毁 §5.3 device 复用）——只清 toml 凭证 + active session，profile db / device / workspace 记忆**留着**（下次重登仍复用）
  - `active_profile` → `local`
- **删除此账号本地副本**（destructive，二次确认）
  - 完全登出 + 删 `profiles/<X>/owl.db` + 移除 `[profiles.X]` toml 段 + （可选）远端 device revoke

**要点**：
- **access token 短效、refresh token 长效**；refresh **每次刷新轮换**（旧 refresh 作废，防重放）。详见 §14 skybridge `/auth/refresh`。
- 本机会按 profile 存多个加密 refresh_token（keychain，Phase 7 机制）——这是快切 UX 的安全取舍，已接受。redact 见 §5.9（refresh_token 字段要进 redact globs）。

#### 5.4.4 renderer 刷新策略（**blocker B7，见 §6**）

`data-bus` 的 `bumpNotes/bumpFolders` **只能刷新列表**，无法清：已打开的编辑器 tabs、AI conversation cache、conflict list、sync-status pending timer。profile switch 后这些会指向旧账号数据 → 串味。

- **初版（0.5.0，最稳）**：profile switch 成功后做**受控 reload**（main 通知 renderer，卸载所有页面状态后重载/重新初始化），保证零残留。
- **精修（0.6 或有余力）**：实现 `resetAllStores(profileEpoch)` —— 每次切换 bump 一个 `profileEpoch`，各 zustand store 订阅 epoch 变化做清空 + 重拉，避免整窗 reload 闪烁。

### 5.5 import 语义（**D10b 终态**，回答 #8；blocker B2）

> **不变式（D10b 核心）**：**账号登录/同步永不写 `owl/owl.db`（local）**。local 只在"认领空账号"时被 **copy 一次**（非 move），其余任何账号活动碰不到它 → 纯本地安全用户的本地库永远原样。

按"登录的账号是否为空 / 本机是否已有该账号副本"分支：

| 情形 | 行为 | 动 owl/owl.db |
|---|---|---|
| **空账号 + local 有笔记** | **弹框问 并入/独立**（唯一 local→账号 on-ramp） | 并入=**读** owl/owl.db 复制进 `profiles/<A>`（不改 local）；独立=不碰 |
| **空账号 + local 空** | A 空起步 | 不碰 |
| **非空账号，本机首次**（无 `profiles/<A>`） | **直接拉取**进新 `profiles/<A>/owl.db` | 不碰 |
| **非空账号，本机回访**（有 `profiles/<A>`） | **增量同步**（LWW + conflict_record） | 不碰 |

- **认领（空账号 + 并入）= 整库认领**：copy `owl/owl.db` → `profiles/<A>/owl.db`，注入 A session → 首次 sync 把 pending outbox 推到 A。**无 op 手术，最安全（B2）。**
- 弹框文案（仅"空账号 + local 有 N 条笔记"时出）：
  > 「检测到本地有 N 条笔记。登录账号 A：**并入账号 A**（上传，A 所有设备可见，不可撤销）/ **保持独立**（笔记留在本地，账号 A 只同步自己的数据）」
- **登录非空账号绝不自动并入 local**（符合"打开我的账号"认知，根除 F3）。"把 local 笔记导入已有非空账号"= 显式手动动作，**0.6+**。
- **跨账号导入（账号 A → 账号 B）**：绝不搬已 synced 的 outbox（server_seq 属 A）；正确做法 = 快照 A 业务表 → 在 B 生成全新 create ops。**0.5.0 不做，留 0.6+。**
- **空账号检测**（实现细节，Phase 15/16）：`profiles/<A>` 不存在 → 先拉/probe A 的 change-log 是否为空 → 据空/非空 + local 有无笔记分支。

### 5.6 cursor 隔离 + LWW 时间基准（W3）

- per-profile db → 每个 profile 有自己的 `sync_cursor` 表 → **跨账号 cursor 自动隔离**，F2 的 cursor 串味消失。`syncEndpointKey` 降级为可选预留。**原 Phase 12 cursor 工作被本方案吸收。**
- **LWW 时间基准（W3，2026-05-30 定，HLC-lite）**：现 LWW 用客户端 `Date.now()`（notes/index.ts，server 不覆盖），**无任何 skew 防护** → 时钟超前的设备会单方面压制全网。改为：
  - client 每次同步从 server 拿**权威时间**（§14），存 `offset = server_t − local_t`；
  - 打时间戳用 `local_now + offset`（= server 归一化时间）→ **整机时钟平移被 offset 吸收**；
  - 再带 **per-device 单调 counter** 作 tie-breaker（同毫秒打平）→ `(归一化ts, counter, deviceId)` 全序。这就是 **HLC（混合逻辑时钟）轻量版**。
  - 落点 Phase 16（stamping 从 `Date.now()` 换 `serverNormalizedNow()`）；老笔记 updated_at 是裸本地时间，切换有一次性轻微抖动（可接受）。

### 5.7 迁移 / 启动路径（**W2 简化**，原 blocker B5/B8）

> **W2 决定（2026-05-30）：强制留 local，不做"已登录用户搬库"。** 因旧 server 实际没怎么用、用户基本都在本地用 → `owl/owl.db` **一律原地保留为 local**（D10a），**不自动搬进 profile**。账号一律靠**显式登录重建**（走 §5.5 D10b：登录 = 拉账号数据进 `profiles/<id>`，不动 local）。

这把原 v5 的迁移大幅简化：

```
首次 0.5.0 启动：
  owl/owl.db 原地不动（它就是 local profile，D10a）；不写 active_profile（resolver 回退它）。
  不创建 profiles/；账号在用户显式登录时才长出 profiles/<id>/。
  无 "copy 旧库 / .premigrate.bak / 回滚" 这套——因为根本不搬。
```

- **B5（旧库搬迁+回滚）基本消失**：不搬就无需原子 copy/校验/回滚。
- **B8（legacy-orphan guard）降级为告警**：若 `owl/owl.db` 含旧账号残留（sync_cursor / synced_at NOT NULL / local_metadata.skybridge_*），它仍当 local 用；**风险仅在"日后把这个 local 认领进某个空账号"时把旧账号残留数据带过去**。0.5.0 对此**只给一句告警**（"本地库含旧同步痕迹，认领进新账号会一并上传"），不做硬 guard（对实际单用户场景足够）。
- GUI precheck（main/index.ts:73）已在 **Phase 12** 改走 resolver；Phase 13 再让它对解析出的 profile db 跑 `runMigrationPrecheck`（schema 版本迁移仍照旧）。

### 5.8 CLI / direct 模式（**blocker B3，见 §6**）

CLI 默认 `dbPath = paths.dbPath()`（`lib/config.ts:43`）。per-profile 后若 daemon 不在、CLI 走 `--direct` → 写**全局旧库**，绕过隔离 → 新串味入口。

- **CLI 必须解析当前 active profile 的 db**（读 `skybridge_config.toml.active_profile` → `profiles/<id>/owl.db`），作为 direct 模式默认库。
- `--db <path>` 降级为**显式 escape hatch**（高级用户/调试），不再是隐式默认。
- daemon 在线时 CLI 仍优先走 HTTP（命中 daemon 当前激活 profile），与隔离一致。
- **D7' 已定：CLI 只跟随 active，不提供 `owl profile use`**（见 §9）。
- **落地相位**：CLI direct 默认 db 解析（B3 核心）必须**随 Phase 12 core resolver 同期落**——它本身就是 §5.0 列的"旧库旁路入口"之一。Phase 21 只做 `--db` 文案 + 命令兼容回归。

---

### 5.9 SkybridgeConfig v2 active-profile adapter（**blocker B10，见 §6**）

toml 从单 `[auth]` 改 `[profiles.X]` + `active_profile`。**采用低风险路：沿用 `readSkybridgeConfig(path?)`（config.ts:118）的函数名 + 签名作为 adapter，Phase 13 只改其内部（读 active profile 的 `[profiles.<id>]` 而非 `[auth]`），14 个 caller 不动。** 校对后的 `readSkybridgeConfig` 读者清单（漏一个 = Phase 13 schema 下读到错/空 auth）：
- core：`skybridge/config.ts:118`（reader 本体 = adapter；`:222` `requireAuth`/`clearSkybridgeAuth` 内部自调）
- daemon：`cli.ts:153`（boot skybridgeEnabled probe）、`sync/manual.ts:299`（status，经 `:296` cfgPath）、`sync/bridge-lifecycle.ts:71`（经 `deps.readSkybridgeConfig ?? default`）、`sync/dev-bootstrap.ts:83`（同 deps 注入）
- GUI main：`sync-ipc.ts:177`、`sync-auth.ts:290`（`safeReadConfig()` 唯一 reader，被 logout `:166` / restoreSessionOnStartup `:208` 调用；`cfg.auth.*`/`cfg.server.*` 消费散在 `:173/184/200` 等，非 reader 调用点）
- CLI：`commands/sync.ts:240`（`owl sync config show`，经 `env.readConfig ?? readSkybridgeConfig`）

> **T3 bypass 审计结论（2026-05-29，已 grep 全 packages/apps）**：
> - 所有读 skybridge toml 的点**要么经 `readSkybridgeConfig`（adapter），要么是 `profile/resolver.ts` 故意的 raw-parse**（只抽顶层 `active_profile`）——**无第三条旁路 reader**，Phase 13 改 adapter 内部即全覆盖读侧。
> - 校正：原列 `sync/session.ts:150` 是内存消费者（`buildClient`），非 toml 读者，移出；`sync-auth` reader 实为 `:290`（非 :173/215/...）；补 CLI `commands/sync.ts:240`。
> - **⚠️ Phase 13 不止改 readers，写侧同步改**：toml 写出者 = GUI `sync-auth.ts` `serializableConfig` + 两写点（`:146` login persist / `:203` logout clear，经 `atomicWriteFile`）、core `config.ts` `writeSkybridgeConfig:192` / `clearSkybridgeAuth:220` / `removeSkybridgeConfig:229`。schema 翻 `[profiles.X]`+`active_profile` 时这些写出形状必须同步，否则读写 schema 不一致。

要点：
- adapter 内部在 Phase 13 改：解析 `active_profile` → 返回该 profile 的 `[profiles.<id>]` 视图（复用旧 `SkybridgeConfig` 形状，caller 零改）；无 active / active=local 时按 `SkybridgeNotConfiguredError` 表达"未认证"。
- **resolver 的 `readActiveProfileId` 不走 `readSkybridgeConfig`**：后者缺 `[server].url` 会抛错，而读顶层 `active_profile` 不需要 server.url → resolver 必须 raw toml parse、只抽顶层字段、任何失败回退 legacy（见 Phase 12 子设计 T1）。
- Phase 12 子任务（不改 14 caller）：① 校对清单 + bypass 审计（grep 是否有绕过 `readSkybridgeConfig` 直接 `parse` skybridge toml 的读者，除 resolver 故意的那个）② redact globs。
- **pino redact globs**：Phase 12 已加 `*.profiles.*.encrypted_token` / `*.profiles.*.auth.token`（T4 done）。**D2 翻转后存的是 `encrypted_refresh_token`** → Phase 15 再补 `*.profiles.*.encrypted_refresh_token`（或确认沿用 `encrypted_token` 字段名则已覆盖），并更新 logger redact 测试。

## 6. 开工前必须修订（blockers — 2026-05-29 用户两轮 review）

下列各点不补会在实现期留下"新串味入口 / 切库竞态 / 漏 redact"，定为开工前 blocker，已落入对应小节：

| # | Blocker | 落点 | 状态 |
|---|---------|------|------|
| B1 | profile switch ≠ 换 db：`ReminderScheduler`(scheduler.ts:38) / `SyncStatusBroadcaster` WeakMap(status-broadcaster.ts:29) / `manual.ts` currentCtx+coalescer(204) 均绑旧 db/ctx + in-flight 竞态 | §5.4.2 switch mutex + drain + 完整状态重建 + boot 闭包审计 | ✅ 已纳入 |
| B2 | import 语义："搬 sync_changes" 不安全（sparse update/delete 依赖业务表现状；已 synced outbox 属原账号） | §5.5：local→账号=整库认领；跨账号=快照+重发 create（0.5.0 不做） | ✅ 已纳入 |
| B3 | CLI/direct 默认 `paths.dbPath()`（config.ts:43）→ 绕过隔离写旧库 | §5.8 + §5.0 resolver：CLI 解析 active profile db，`--db` 仅 escape hatch。**核心随 Phase 12 resolver 同期落（旁路入口），Phase 21 只做文案/兼容收尾** | ✅ 升为 blocker |
| B4 | logout 远端 revoke 与"保留 token 快切"冲突；切换 ≠ logout | §5.4.3：拆"停用(清 active session)" vs "删除副本"；**D2 定=清 token+远端 revoke，但不跑 clearSyncIdentity（保留 db 内 device 记忆）** | ✅ 拆分语义 |
| B5 | 迁移/启动 precheck 只看单一 `paths.dbPath()`（index.ts:73）；旧库搬迁 + 回滚未落细 | §5.7：copy→校验→bak→写 active；失败原位回滚 | ✅ 已纳入（D6 定案） |
| B6 | 多入口默认 `paths.dbPath()`（cli.ts:62 / index.ts:73 / config.ts:43）→ 旧库旁路入口 | §5.0：先加 core resolver，再替换全部入口（**开工第一步**） | ✅ 新增 |
| B7 | renderer `bump*` 刷不掉 editor tabs / AI cache / conflict list / pending timer | §5.4.4：初版受控 reload，精修 `resetAllStores(epoch)` | ✅ 新增 |
| B8 | 迁移"无 [auth] = 纯本地"不安全：曾登录后 logout 的库仍含账号数据，不能认领到别账号 | §5.7：legacy-orphan guard（探 sync_cursor / synced_at / skybridge 残留） | ✅ 新增 |
| B9 | 登录顺序：先 switch 再判 import 会丢 import 来源 | §5.4.1：当前 profile 内备好目标库（含认领）→ 再 switch | ✅ 新增 |
| B10 | toml schema 迁移要覆盖全部 readSkybridgeConfig 读者 + redact globs | §5.9：沿用 `readSkybridgeConfig` 名/签名作 adapter（Phase 13 改内部，caller 不动）。**Phase 12 = 校对读者清单(core/daemon×4/GUI×2/CLI sync config show；删 session.ts)+ bypass 审计 + redact globs**；adapter 内部逻辑随 Phase 13 schema | ✅ 新增 |

> 用户判断：方案 B 模型能解决当前问题，且比单修 hostname 去重/cursor key 更正确；补齐上述 5 点后实现风险可控。

---

## 7. 对已交付 P5-d 的影响评估（返工面）

**结论：owl 客户端侧不需要大返工（地基可复用）。但 0.5.0 现需 skybridge 0.1.4 server 能力（§14，2026-05-30 决定，原 v5 "不需 server 能力" 已作废）——这是本次最大的范围变化。**

| 已交付（Phase 2-10） | 命运 | 说明 |
|---|---|---|
| skybridge SDK / server 0.1.3 | 🔁 **升 0.1.4** | **新增 4 能力（§14）**：暴露 server_id / 同步回 server 时间 / `/auth/refresh`(带轮换) / device revoke。跨仓工作，Phase 15 前必须 ready |
| daemon `/sync/session` install + replace dance | ✅ 复用 | 每 profile 注入一次；"db replace dance"是它的姊妹 |
| daemon `/sync/logout-local` + `clearSyncIdentity` | 🔁 拆分/替换 | **D2 关键**：停用/切换路径**绝不调用 `clearSyncIdentity`**（它删 profile db 内 `skybridge_device_id`，毁 §5.3 device 复用）。停用 = 远端 revoke + 清 toml 密文 + 清 active session，**保留 db 内 device/workspace 记忆**。`clearSyncIdentity` 仅"删除账号本地副本"(destructive)时可用 |
| GUI keychain（safeStorage） | ✅ 复用 | 每 profile 一份密文（机制不变） |
| `sync-auth.ts` login/restore | 🔁 改 | 加 profileId + device 复用 + profile 写入；骨架留用 |
| `sync-ipc.ts` extractSession / buildStatus | 🔁 改 | 读 `[profiles.active]` 而非 `[auth]` |
| toml schema | 🔁 迁移 | → `[profiles.X]` + `active_profile`（§5.7 非破坏迁移） |
| DevicesCard | ✅ 不动 | 列"当前 profile 账号"的设备；device 复用后 `is_current` 更稳 |
| sync engine（push/pull/apply/LWW/self-replay） | ✅ 不动 | 对 db 无感；per-profile db 直接受益 |
| `ReminderScheduler` | 🔁 切换时 stop/rebuild | 见 B1；构造体不改，生命周期管理改 |
| `SyncStatusBroadcaster`（WeakMap by ctx） | 🔁 切换时 evict/rebuild | 见 B1；status-broadcaster.ts:29 |
| `manual.ts` currentCtx + syncCoalescer | 🔁 drain + 重置 | 见 B1；manual.ts:204；"ctx 单例"假设破裂 |
| core profile resolver | ➕ 新增 | 见 B6；替换 cli.ts:62 / index.ts:73 / config.ts:43 |
| renderer 全局状态 reset | ➕ 新增 | 见 B7；受控 reload / resetAllStores(epoch) |
| CLI direct/resolve | 🔁 改 | 见 B3：默认解析 active profile db |
| GUI startup/migration precheck | 🔁 改 | 见 B5：profile 感知 + 一次性迁移 |
| SSE bridge / scheduler / 6 bash 守卫 | ✅ 不动 | profile switch 复用 start/stop |
| 原计划 Phase 10.6（hostname 去重） | ♻️ 收编 | 由 §5.3 per-profile device 记忆取代，**更优** |
| 原计划 Phase 12 cursor `syncEndpointKey` | ♻️ 收编 | per-db 自动隔离，§5.6 |
| 原计划 Phase 11 watchdog / 13-18 soak+发版 | ✅ 不变 | 与 profile 正交 |

**新增工作（profile 层）**：profileId(server_id)、daemon db-replace dance（B1）、toml schema + 迁移（W2 简化）、login/switch/logout 改造（D2 翻转 refresh-token）、§5.5 import 守卫（D10b）、CLI profile 感知（B3）、GUI（账号列表 + **免密快切** + 移除设备）、**skybridge 0.1.4 server（§14，跨仓）**、测试。量级比原"隔离子集"估计大（含快切 + server 改动）。

---

## 8. 版本切分（核心待决：0.5.0 切到哪）

### 8.1 「隔离正确性」—— 提议纳入 0.5.0（floor）
- profile = (server,user)；per-profile db；toml `[profiles.X]` + `active_profile` + 迁移（§5.7）。
- 登录命中/新建 profile；device 复用（F1 解）；切账号 = profile switch + 完整 db dance（F2 解，含 B1）。
- §5.5 import 守卫（F3/F4 解，B2）。
- cursor 自动隔离（§5.6）。CLI profile 感知（B3）。停用清 token（B4）。
- GUI（**含免密快切**，W4 翻新）：账号列表 + 切换/登录入口 + **侧栏一键快切下拉** + 移除设备 + 手动同步。

→ 达到"可用、合理"的底线：**无串味、无静默合并、无设备堆积、无旁路旧库入口**。

### 8.2 「快捷切换体验」—— 留 0.6（polish）
- 保存多组 (server,account) 一键免密切换（需 §5.4.3 的 0.6 token 生命周期）。
- 侧栏 profile 快切下拉。
- （可选）跨 profile 统一收件箱/搜索；跨账号导入（§5.5 末）。

### 8.3 给用户的取舍

| | 方案 A：0.5.0 单账号 + 守卫（小） | 方案 B：0.5.0 全 profile 隔离（本文主张） |
|---|---|---|
| F1 设备堆积 | 部分修（device 记忆，不上 db 隔离） | ✅ 根治 |
| F2 切账号串味 | ❌ 仍在（只能禁止/强警告切第二账号） | ✅ 根治 |
| F3/F4 静默合并 | ✅ import 守卫修 | ✅ |
| 多账号是否真可用 | ❌ 只是被守卫挡住 | ✅ 真正可用 |
| 0.5.0 GA 工期 | 小，快发 | +1 个 profile Phase，**会推迟 GA** |
| 与 0.6 关系 | 0.6 再补隔离（可能返工守卫） | 0.6 只加跨视图/跨账号导入，地基+快切已在 |

> **已定（D1，2026-05-30 翻新）：方案 B + GUI 含免密快切。** 隔离正确性 + 免密快切均纳入 0.5.0（W4）。代价是 GA 推迟 + 需 skybridge 0.1.4；收益是地基+快切一次到位。0.6 只加跨 profile 统一视图 / 跨账号导入。（本 §8 为"是否纳入 0.5.0"的决策过程历史，结论见 §0.5/§9。）

---

## 9. 决策记录（D1-D11，**以 §0.5 总账为准**）

早定案：**D5**=server_url 归一化（现降级为 url 存储用，§5.1）；**D6**=迁移（W2 简化，§5.7）；**D7**=CLI 升 blocker（§5.8）。

**2026-05-29 第一轮（D1-D9）**：D3/D4/D7'/D8/D9 见下；D1/D2 已被 2026-05-30 第二轮**翻新**（见下加粗）。

- **D1 · 切线** → **方案 B 全 profile 隔离纳入 0.5.0**。~~GUI 最小版~~ → **2026-05-30 W4 翻新：GUI 含免密快切（侧栏下拉）**，不再留 0.6。
- **D2 · token** → ~~清 token + 远端 revoke~~ → **2026-05-30 翻转：refresh-token 流（带轮换），切换保留 token、不 revoke；仅完全登出/移除设备才 revoke**（§5.4.3）。免密快切并入 0.5.0。
- **D3 · import 默认** → **默认并入 + 可选独立**（仅"空账号 + local 有笔记"时弹框，D10b）。
- **D4 · `local` profile 定位** → **一等公民**。落点 = **`owl/owl.db` 原地（D10a）**，非 profiles/local。并入 = copy 认领（非 move）。
- **D7' · CLI 切 profile** → **只跟随 active**；`--db` escape hatch；daemon 在线优先 HTTP。
- **D8 · ctx 重建** → **原地 mutate + 显式 evict**。闭包审计已完成（§5.4.2-bis）：rebuild ReminderScheduler+ConversationStore、evict broadcaster WeakMap、drain coalescer。
- **D9 · switch mutex** → **独立 ctx 级 switch 锁**（覆盖 sync + 业务 mutation + scheduler；不复用 coalescer）。

**2026-05-30 第二轮新增**：
- **D10 · local 落点 / 导入源 / 退出落点**：
  - **D10a** local = `owl/owl.db` 原地（Option B；纯本地零迁移、与 resolver legacy 回退一致、零配置默认库不动）。
  - **D10b** 导入源 = local；**仅"认领空账号"**走 local→账号 copy；登录非空账号 = 纯拉取/增量，**不并入 local**；跨账号/local→非空账号导入 = 0.6+。**不变式：账号同步永不写 owl/owl.db。**
  - **D10c** 退出/切换默认回 local；"认领后 local 成冻结快照"需 UI 明示"本地独立工作区"（Phase 16/17）。
- **D11 · profileId 锚点 = server_id**：`profileId = hash(server_id, user_id)`，server_id = skybridge 配置文件里的长随机标识（自动生成+持久化+可覆盖以迁移）。换 server 部署/换 url 不丢工作区。url 退出 profileId（降级为连接地址）。**Phase 12 的 `computeProfileId(url,user)` 为 provisional，Phase 15 改 server_id。**

---

## 10. 非目标 / 澄清

- **质疑 #3（一台机器两个 skybridge）**：(a) 两个 server 进程——默认同端口同 db，需各传 `--config` 隔离，**无意义不推荐**；(b) server + owl client 同机自托管——server 默认不读 client `skybridge_config.toml`（仅 `--config` 读独立 server.toml），文件名不同、**共存无冲突**；(c) 同机两 owl client 并存——本方案 profile 切换覆盖（单激活）。与本文数据模型正交，仅澄清。
- 不做 server 端 device fingerprint 字段（§5.3 末，留未来可选）。
- 不做跨 profile 统一搜索 / 跨账号导入 / local→非空账号导入（0.6+）。
- 不做**附件同步**（W11，2026-05-30）：保持轻量；当前 attachmentRefs 被丢弃即天然不传播，仅需保证"不埋坑"（local-only + 设备 B 优雅显示"无此附件" + round-trip 不丢 refs）。
- 不改 sync engine 的 self-replay / op-log 语义；**LWW 比较逻辑不变，但时间戳基准从裸 `Date.now()` 改 server 归一化 + counter（W3，§5.6）**。
- **引入** `/auth/refresh`（带轮换，§14）—— W4 翻新原 P5-d "不引入 refresh" 的非目标，因免密快切并入 0.5.0。仍不做 `/auth/register` / pair code。

---

## 11. 0.5.0 发版前实施时序（2026-05-30 重排）

> 含 D1-D11 + W1-W13 + skybridge 0.1.4。每 Phase 一次 commit，PROCESS.md 同步。
> **✅ 进度（2026-06-06）：Phase 12-21 全部完成并落本地 main（未 push）。下表 Phase 12 的 ✅ 之外，13-21 亦已全部 done；剩 22（0.5.0 bump+发版）+ 23（push）。逐 phase 实施记录见 PROCESS.md 与各 phase 子 plan。**

| Phase | 内容 | 备注 |
|---|---|---|
| **11 ✅** | SSE idle watchdog | 原 P5-d Phase 11，与 profile 正交。**已完成（2026-06-06，0.5.0）** —— `d998d13`，60s 半开假死检测。详见 `2026-06-06-sse-idle-watchdog.md` |
| **12 ✅** | **profile 地基**：core resolver(B6) + 三入口切 resolver(含 B3) + B10 bypass 审计 + redact globs + D8 闭包审计 | **已完成并落 main**（45eef1e/a4c61bd/d15c9cd），behavior diff=0。详见 `2026-05-29-phase12-profile-foundation.md` |
| **S** | **skybridge 0.1.4 server**（跨仓）：①暴露 server_id（config，§14）②同步回 server 时间 ③`/auth/refresh`(带轮换) ④device revoke 端点 + SDK 升 | **新增**。可与 13/14 并行；**Phase 15 前必须 ready + 部署**（阿里云在 Phase 19 正式上） |
| 13 | **存储 + 迁移**：`[profiles.X]`+`active_profile` schema + resolver 真返回 profile 路径 + **local 重映射到 owl/owl.db**(D10a) + adapter(readSkybridgeConfig)内部改 active-profile 视图 + **写侧同步改**(§5.9) | W2 简化：**强制留 local、不搬旧库**（B5 基本消失、B8 降告警） |
| 14 | **daemon profile switch**：db replace 完整状态重建(§5.4.2-bis：rebuild scheduler+ConversationStore / evict broadcaster / drain coalescer) + switch mutex(D9) + **为快切保留 refresh_token** | |
| 15 | **登录/切换/登出**：`profileId=hash(server_id,user_id)`(D11，改 provisional computeProfileId) + **refresh-token 流(轮换)**(D2 翻转) + device 复用(§5.3，收编原 10.6) + 登录顺序(B9) | 依赖 Phase S |
| 16 | **import 守卫 + renderer reset + W3**：仅认领空账号(D10b,B2) + 受控 reload(B7) + local 快照 UI 明示(W6) + **时间戳改 server 归一化+counter**(W3) | |
| 17 | **GUI 账号/设备管理**：profile 列表 + **侧栏免密快切下拉**(W4) + **移除设备 revoke**(W9) + 状态 popover 加手动同步(W8) + reminder-仅-active 文案(W5) | 依赖 Phase S 的 revoke/refresh |
| 18 | **本地全链路**：just check/test + dual e2e 跑 profile 模型 | |
| 19 | 阿里云部署 **skybridge 0.1.4** + 真机 GUI login/快切 smoke | |
| 20 | 真机 soak ≥24h：多账号快切 + **错钟设备(W3)** + **备份恢复(W12)** + 强制场景 | |
| 21 | CLI compat 收尾：`--db` 文案 + 兼容回归(B3 核心已在 12) + **CLI direct 尊重 switch lockfile(W10)** | |
| 22 | owl 0.5.0 bump + release（notes：附件 local-only/W11、提醒仅 active/W5、备份恢复指引/W12） | |
| 23 | 收尾：PROCESS / next-session-brief / 三仓 push clean | |

**被收编/取消**：原 Phase 12 cursor `syncEndpointKey`（per-db 自动隔离）；Phase 10.6 hostname 去重（device 记忆取代）；Phase 10.5 revoke **收编进 Phase S+17**（W9）。
**0.5.0 之外（0.6+）**：跨 profile 统一视图、跨账号导入、local→非空账号导入、`resetAllStores(epoch)` 免闪烁精修、附件同步(W11)、conflict 双向可见(W7)。

## 12. 下一步

1. ✅ **已完成**：D1-D11 + W1-W13 拍板（§0.5/§9/§13）；§11 重排；**Phase 12 落 main**。
2. 更新 ROADMAP 0.5.0 gate（含 profile 隔离 + 快切 + skybridge 0.1.4）。
3. **下一步开工**：**Phase S（skybridge 0.1.4 server）** 与 Phase 13（存储+迁移）—— 可并行。Phase S 是跨仓（skybridge 仓），Phase 13 在 owl 仓。

---

## 13. 实机边界与风险（W1-W13，2026-05-30 排查）

实机使用可能"奇怪"的点，逐条处置（早发现早规划）：

| # | 现象 | 处置 | 落点 |
|---|------|------|------|
| W1 | 换 server 部署位置/url → profileId 裂、旧工作区丢 | profileId 锚 **server_id**（D11）；server_id 自动生成+持久化(config)+可覆盖；安全网=同 user_id 异 server_id 提示关联 | Phase S+15 |
| W2 | 迁移已登录老用户复杂 | **强制留 local、不搬旧库**；账号靠显式登录重建 | Phase 13（B5 消失、B8 降告警） |
| W3 | 时钟偏差 → 静默 LWW 覆盖（错钟设备成黑洞） | LWW 时间戳改 **server 归一化 offset + per-device counter**（HLC-lite） | Phase 16；soak 必测错钟 |
| W4 | 切账号每次重输密码 | **免密快切并入 0.5.0**：refresh-token 流（轮换），D2 翻转保留 token | Phase 15/17 + Phase S |
| W5 | 提醒只为 active profile 触发（别账号提醒不响） | **接受**单活跃，UI/文档注明 | Phase 17 文案 |
| W6 | 认领后 local 成冻结快照，登出看到旧 local | UI 明示"本地独立工作区，非账号 A" | Phase 16/17 |
| W7 | 冲突只在输方可见，赢方无感 | **记录后定**（类比 git pull，看实机反馈）；双向可见需 server 配合 | 0.6+ |
| W8 | SSE 无手动重连、offline 信息态 | 状态 popover 加"手动同步"action（兼当重连） | Phase 17 |
| W9 | 重装/wipe → 孤儿设备，无 revoke 清不掉 | **移除设备进 0.5.0**（需 server revoke 端点） | Phase S + 17 |
| W10 | CLI direct 撞 GUI profile switch → 开到 swap 中途的库 | CLI direct 尊重 switch lockfile | Phase 21 |
| W11 | 笔记同步但**附件不传播**（attachmentRefs 被丢） | **0.5.0 不做附件**（保持轻量）；仅保证不埋坑（local-only + 优雅缺失 + round-trip 不丢 refs） | 0.6+（§10 非目标） |
| W12 | 从备份恢复 → cursor 落后 → 重拉/冲突风暴/复活已删 | soak 测 + release 恢复指引；可选启动 cursor sanity 告警 | Phase 20 + 22 |
| W13 | 两设备同时认领同一空账号（竞态→并集） | **可忽略**（一方 claim 后另一方即面对非空；结果并集无丢失） | 不处理 |

## 14. skybridge 0.1.4 server 能力清单（0.5.0 新增依赖，跨仓）

> 原 v5 "profile 不需 server 能力" 作废。以下 4 项须在 skybridge 仓实现 + 发 0.1.4 SDK + owl 对接，**Phase 15/17 前 ready、Phase 19 部署**。

1. **server_id 暴露**：server 端长随机标识（首次 init 自动生成 + **持久化于 server db `server_meta`** + **config 文件可显式覆盖以迁移带走**；config≠db 时打 loud warning。存储决策详见 Phase S 子设计 §2）。经登录响应 + `GET /server-info` 返回。client 存进 `[profiles.X].server_id`，作 profileId 锚点（D11/W1）。
2. **权威 server 时间**：同步响应（或 `/time`）回 server 当前时间，供 client 算 `offset` 做 LWW 归一化（W3）。
3. **`/auth/refresh`（带轮换）**：登录发 短 access + 长 refresh_token；refresh 换新 access **并轮换 refresh**（旧作废，防重放）。支撑免密快切（W4/D2）。logout/移除设备时作废 refresh。
4. **device revoke/delete 端点**：吊销/删除某 device（^0.1.3 缺，sync.ts:64 已注）。支撑"移除设备"(W9) + "删除账号本地副本"远端清理。

**owl 侧对接点**：`encrypted_refresh_token` 进 redact globs（§5.9）；`server_id` 写入 toml schema（§5.2）；SDK bump（参照 [[skybridge local-dev workflow]] 的 ABI/版本 ping-pong 注意）。
