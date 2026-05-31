# Phase 16 子设计 —— import 守卫 + 受控 renderer reload + W3 时间戳

> 父设计：`2026-05-29-account-profile-isolation-design.md`（**v6 定稿，§0.5 + §5.4.4(B7) + §5.5(D10b/B2) + §5.6(W3) + §13 W6 + §11 路线**权威）。
> 前置（均落 owl main 未 push）：Phase 12 resolver ✅ + 13 存储/adapter ✅ + 14 `switchProfile` ✅ + 15 live 登录/refresh ✅；skybridge **0.1.4 已 publish @next**（server 已具 W3 所需 `serverTime`）。
>
> **本阶段收 Phase 15 留尾的视觉/导入/时钟三件事**：Phase 15 把 per-profile 登录链路打通了，但①切换后 renderer 不刷（串味，**真机手测印证的首要粗糙点**）②首登空账号无「认领 local」入口 ③LWW 仍用裸 `Date.now()`（错钟黑洞）。Phase 16 全部闭环。
>
> **形态拍板（2026-06-01，用户三问确认）**：
> - **W3 = 完整 HLC-lite**（归一化 ts + per-device 单调 counter + deviceId 三元全序），**owl 单仓实现，不动 skybridge**（0.1.4 已在每次 push/pull 回 `serverTime`；LWW 时间戳在 owl 自有 opaque payload；wire 已带 `device_id`）。代价 = 一个 owl schema migration（`0009`）+ payload 加 counter 字段。
> - **认领弹框 = 应用内 React 弹框（IPC 往返）**，复用 MigrationDialog 的 main↔renderer 对话先例，不用 Electron 原生 dialog。
> - **切片（仿 Phase 15 的 15a/15b）**：**16a = B7 受控 reload**（#1 痛点、最小、独立，先落马上止血）→ **16b = D10b 认领弹框 + W6 local UI** → **16c = W3 HLC-lite**。每片独立可测/可提交。
>
> **Review round 1 修订（2026-06-01，用户审计，正文已照此）**：
> 1. **migration 编号 = `0009_lww_counter.sql`，schema 版本 8→9**（`0008_backfill_create_ops.sql` 已 ship，且自注「后续走 0009」；`migrate.ts:47` `LATEST_KNOWN_VERSION=8`）。
> 2. **W3 必须改 payload parser**：`parseNotePayload`/`parseFolderPayload`（`sync/payloads/note.ts`/`folder.ts`）重建 typed body，未知字段被丢 → `lww_counter` 发了也不进三元比较。须给每个 op interface 加 `lww_counter?: number` + sparse 校验（present 时有限整数）。
> 3. **W3 补 remote-observe**：pull apply 时对每个带 `updated_at_ms` 的（已校验）remote payload 调 `observeRemoteLwwKey(sqlite, remoteKey)` 推进本地 HLC 状态，否则「刚看见并编辑」的本地写在极端同毫秒/错钟下仍可能输（严格 HLC 语义）。
> 4. **16a reload 时序写硬**：handler 内 `const reply = await safe(...); if (reply.ok) <在 return 之后再通知>`（`queueMicrotask`/`setImmediate`），或 renderer 收事件后延一 tick reload —— 否则整窗 reload 抢掉在途 IPC reply。
> 5. **promptClaim 防 import 环**：`sync-ipc.ts` import `sync-auth.ts`；prompt 放独立 `main/claim-prompt.ts`（sync-auth 调它），不放回 sync-ipc。
> 6. **W6 banner 判据收紧**：local ⇔ `snapshot !== null && snapshot.server_url === null`（**非** `session===null` 单条，也**非** `snapshot===null`）——`session===null` 覆盖 keychain 坏的**账号** profile、`snapshot===null` 覆盖 daemon 不可达，二者都不是 local（§3.5）。
>
> **Review round 2 修订（2026-06-01，正文已照此）**：① W6 判据进一步写硬为 `snapshot !== null && server_url === null`（round 1 的 `snapshot?.` 仍把 `snapshot===null` 误当 local）；② **conflict_record counter 列移出本片**（连带改 conflicts.ts + GUI 类型/测试，display-only，留 0.6/W7）；③ W3 offset 用 `runSync` 注入时钟 `deps.nowMs`（非裸 `Date.now()`）+ **empty pull 也落 offset**；④ 三元比较本地 `deviceId` 用 `row.device_id ?? ''`（列可空）；⑤ 删掉不存在的 `SETUP_USER_VERSION` 提法（fresh install 走 `applyInitialSchema`→`applyForwardMigrations`）。

---

## 0. 一句话

Phase 16 让 profile 切换在三个维度上「不串味」：**视图**（切换后 renderer 受控整窗 reload，零残留）、**数据**（首登空账号显式问「并入 local / 独立」，账号同步永不写 local）、**时间**（LWW 时间戳改 server 归一化 offset + per-device counter + deviceId 全序，错钟设备不再单方面压制全网）。

---

## 1. 决策落点（本阶段照此，无歧义）

| 决策 | 落点 |
|---|---|
| **B7** 受控 reload | profile switch（login/logout，未来 17 快切）成功后，**GUI main 通知 renderer 整窗 reload**（`webContents.send('profile:switched')` → renderer `window.location.reload()`）。零残留、最稳（设计 §5.4.4 钦定 0.5.0 初版）。`resetAllStores(epoch)` 软重置留 0.6。 |
| **D10b/B2** 认领空账号 | **仅「目标 profile db 不存在（本机首登该账号）+ 账号空 + local 有笔记」三条同真**才弹框。并入 = **整库 copy** `owl/owl.db` → `profiles/<id>/owl.db`（**switch 前**完成，B9）；独立 = 不碰 local，switch 建空库。**账号同步永不写 `owl/owl.db`**（不变式）。 |
| **B9** 顺序 | 认领抉择必须在 `postSyncSwitch` **之前**（switch 会 `createDatabase` 建空目标库 / 打开已 copy 的库）。首登路径把 registerDevice + ensureWorkspace + 空账号 probe 上提到 switch 前。 |
| **W6** local UI | SyncStatusBar popover + SyncSection 未登录视图明示「**本地独立工作区**（笔记仅存本地、非账号）」。复用现有信号（`session===null` / `server_url===null`），不强加新类型。 |
| **W3** HLC-lite | offset = `serverTime − Date.now()`（每轮 sync 落 `local_metadata`）；stamp = `serverNormalizedStamp()` 返 `{ms, counter}`（HLC：物理时间不前进则 counter++）；apply 远端时 `observeRemoteLwwKey` 推进本地 HLC；payload 加 `lww_counter`（**并改 parser 接住**）；notes/folders 加 `lww_counter` 列（**migration `0009`**）；LWW 比较改三元 `(ms, counter, deviceId)`。 |

---

## 2. 16a —— 受控 renderer reload（B7，§5.4.4）

> 目标：login / logout 成功翻转 profile 后，renderer 卸载所有页面状态重载，消除「切换后仍显示旧账号笔记 / editor tab / AI 会话 / conflict 列表 / sync timer」串味。**最小、独立、先落**。

### 2.1 触发链路（main 单点 chokepoint）

切换发起者**永远是 GUI main**（16 的 login/logout、17 的快切都在 main）→ 在 main 单点通知，覆盖所有切换来源。

- `packages/gui/src/main/sync-ipc.ts`：`sync:login` / `sync:logout` handler 拿到结果后判 `reply.ok` 再通知（写硬，避免抢 reply）：
  ```
  ipcMain.handle('sync:login', async (_e, input) => {
    const reply = await safe<void>(() => loginAndOpenSession(input));
    if (reply.ok) setImmediate(() => notifyProfileSwitched());   // 在 return 之后才发
    return reply;                                                 // renderer 的 invoke 先 resolve
  });
  ```
  - `notifyProfileSwitched()` = `BrowserWindow.getAllWindows()[0]?.webContents.send('profile:switched')`（main 已有 `webContents.send('quit:check-unsaved')` 同款用法，index.ts:62）。
  - **双保险**：①main 用 `setImmediate`（macrotask）保证发事件在 handler `return` 之后；②renderer 收到 `profile:switched` 后**再延一 tick**（`queueMicrotask`/`setTimeout 0`）才 `window.location.reload()`。两层都保证整窗 reload 绝不抢掉在途的 IPC reply。失败（login/logout 抛错）→ `reply.ok===false` → 不通知。
- `restoreSessionOnStartup`（main，boot 期）**不触发** —— 那时 renderer 还在冷启动，无残留；冷启动 fetch 直接打 active 库（正确）。

### 2.2 renderer 侧

- `packages/gui/src/preload/index.ts`：暴露 `owlAPI.onProfileSwitched(cb): () => void`（`ipcRenderer.on('profile:switched', cb)` + 返回退订），并补 `types/owl-api.d.ts`。
- `packages/gui/src/renderer/src/MainApp.tsx`（或 App 顶层）：mount 注册 `onProfileSwitched(() => window.location.reload())`，unmount 退订。
- **0.5.0 = 整窗 `window.location.reload()`**（最稳零残留）。所有 zustand store（editor tabs / ai-store 流 + AbortController / conflicts / sync-status pendingTimer / note/folder/browser/reminder/tag）随页面销毁自然清空，冷启动重新 fetch 当前（新）profile 数据。`resetAllStores(epoch)` 软重置（免闪烁）留 0.6（§5.4.4 精修）。

### 2.3 已知取舍

- 整窗 reload 会丢编辑器未保存草稿。**profile 切换语义上这些草稿属旧账号，应当丢弃**；且 login 由 Settings 页发起、不在编辑场景。0.5.0 不为切换加「未保存」拦截（保持简单，与 Cmd+Q 的 `quit:check-unsaved` 解耦）。记 release notes，必要时 0.6 复议。

### 2.4 测试

- main：`sync:login` / `sync:logout` 成功 → `notifyProfileSwitched` 被调（mock `BrowserWindow.getAllWindows`）；失败（login 抛错）→ **不**通知。
- preload/renderer：`onProfileSwitched` 注册收事件 → `window.location.reload` 被调（jsdom mock）；退订生效。

---

## 3. 16b —— 认领空账号弹框（D10b/B2）+ local UI 明示（W6）

> 目标：首登一个**空**账号、且 local 有笔记时，显式问「并入 / 独立」；并入 = 整库 copy（switch 前）。登出后回 local 时 UI 明示「本地独立工作区」。

### 3.1 `loginAndOpenSession` 重构（B9：认领在 switch 之前）

`packages/gui/src/main/sync-auth.ts`（现 step 1-7，:111-197）。关键约束：`postSyncSwitch`（:134）会 `createDatabase` 建空目标库或打开已存在库 → 认领 copy 必须更早。按「目标 profile db 是否已存在」分两路：

```
step1 login → auth（token/refreshToken/expiresAt/serverId/user）       # 不变
step2 require serverId（R5）；profileId = computeProfileId(serverId, userId)   # 不变

profileDbExists = fs.existsSync(paths.profileDbPath(profileId))        # ★ 新：本机是否已有该账号副本

if (profileDbExists) {
  # —— 回访路径（= Phase 15 现状，无认领）——
  { device_id } = postSyncSwitch(profileId)                            # 现 step3
  device = reuseDevice(...) / registerNewDevice(...)                   # 现 step4（device_id 必非空 → reuse）
  workspace = ensureWorkspace(...)
} else {
  # —— 首登路径（认领机会）——
  device   = registerNewDevice(auth)                                   # ★ 上提：首登必新设备
  client   = createSkybridgeClient({authContext:auth, deviceId:device.id})
  ws       = client.ensureWorkspace('owl','default'); workspace = {id, slug}
  empty    = await probeAccountEmpty(client, ws.id)                    # ★ pullChanges(ws,0,limit=1) → latestSeq===0 && changes.length===0
  if (empty) {
    localCount = countLocalProfileNotes()                             # ★ 直接读 owl/owl.db（与 daemon 当前 active 无关）
    if (localCount > 0) {
      choice = await promptClaim({ email, localCount, orphanWarn })   # ★ IPC 往返 React 弹框（§3.4）
      if (choice === 'merge') {
        mkdirSync(dirname(profileDbPath(profileId)), {recursive:true})
        await copyLocalDbInto(profileDbPath(profileId))               # ★ 整库 copy（§3.3），switch 前
      }
      # 'independent' / 关闭 → 不 copy，switch 建空库
    }
  }
  postSyncSwitch(profileId)                                            # 现 step3：打开已 copy 的库 or 建空库
}

step5 encrypt access(+refresh)                                         # 不变
step6 postSyncSession({token, device, workspace, ...})                # 不变（装在已切好/已 copy 的库）
step7 writeProfileConfig(profileId, section, {setActive:true})        # 不变
scheduleRefresh(auth.expiresAt)                                       # 不变
```

- **register/ensureWorkspace 上提无副作用**：device 注册 + workspace 创建对账号合法且幂等；用户选「独立」或关闭也只是多注册了本机设备（install 后 db 记住、复用），workspace 是账号本就该有的 `owl/default`。
- **失败 unwind 不变**（:188-195）：`bestEffortRemoteLogout(auth)` + `bestEffortSwitchLocal()`，不写 toml。新增的 copy 若已发生而后续抛错 → 留下的 `profiles/<id>/owl.db` 是 local 的副本（无害；下次同账号登录走「回访」路径直接 reuse，或 Phase 17 删副本清理）。可选在 unwind 删掉刚 copy 的库，**保持最稳**——本片**不删**（避免误删，且内容=local 副本无损失），记为已知。

### 3.2 空账号 / local 笔记探测

- **空账号 probe**：`client.pullChanges(workspaceId, 0, 1)` → `latestSeq === 0 && changes.length === 0`（刚 `ensureWorkspace` 出来的新 workspace 必空）。非空 → 账号已有数据，走纯拉取（独立路径，account 数据首次 sync 拉进新库），**不弹框**（根除 F3 静默并集）。
- **local 笔记数**：新 core helper `countLocalProfileNotes(): number` —— 只读打开 `paths.localProfileDbPath()`（`owl/owl.db`）`SELECT count(*) FROM notes WHERE trash_level < 2`（或等价未删条件）。**直接读 local 库**（认领源永远是 local，D10b），与 daemon 当前 active profile 无关（用户可能正登在账号 B）。WAL 下与 daemon 并发只读安全。

### 3.3 整库 copy（B2：无 op 手术）

- 复用 core `backupDatabase(sqlite, targetPath)`（`db/backup.ts`，better-sqlite3 `.backup()`，WAL-safe、源库不锁）。main 需要一个 source sqlite handle：新 core helper `copyLocalProfileDbInto(targetPath)` 内部只读打开 local 库 → `backupDatabase` → 关源。
- **copy as-is（设计 §5.5 钦定，不做 op 手术）**：copy 后 install 用新注册 device，`persistSkybridgeIds` 覆写 `skybridge_device_id`、一次性 backfill 重写 notes/folders 的 `device_id`；首次 sync `WHERE synced_at IS NULL` 推 pending outbox 到账号 A。纯 local（从未登录）→ 所有行 `synced_at` 本就 NULL → 全量上行，干净。
- **B8 orphan 告警（legacy 迁移库）**：若 local 库含旧同步痕迹（`sync_cursor` 有行 / `sync_changes.synced_at NOT NULL` / `local_metadata` 有 `skybridge_*`）→ 弹框文案追加「⚠️ 本地库含旧同步痕迹，认领进新账号会一并上传/可能漏传」。**0.5.0 只告警、不硬 guard、不做 op 手术**（设计 §5.7 B8 降级；单用户实机足够）。`orphanWarn` 布尔由 `countLocalProfileNotes` 同次探测附带返回（合并成 `inspectLocalProfile(): { noteCount, hasSyncTraces }`）。

### 3.4 弹框机制（应用内 React，IPC 往返）

复用 MigrationDialog 的 main↔renderer 对话先例（`migration:start/progress/done` 已有此模式）：

- **防 import 环**：`sync-ipc.ts` 已 import `sync-auth.ts`；prompt 放**独立** `packages/gui/src/main/claim-prompt.ts`（`sync-auth.ts` import 它），**不**放回 sync-ipc（否则 sync-auth→sync-ipc→sync-auth 成环）。
- `claim-prompt.ts`：`promptClaim(input): Promise<'merge'|'independent'>` —— `BrowserWindow.getAllWindows()[0]?.webContents.send('sync:claim-prompt', {email, localCount, hasSyncTraces})` + `ipcMain.once('sync:claim-response', (e, choice) => resolve(choice))`；窗口不存在/超时 → 默认 `'independent'`（最安全：不动 local）。
- preload：`owlAPI.sync.onClaimPrompt(cb)` + `owlAPI.sync.respondClaim(choice)`；补 `owl-api.d.ts`。
- renderer：新 `ClaimAccountDialog`（shadcn `AlertDialog`，**不可点外部关闭**，两按钮「并入账号」「保持独立」，文案见设计 §5.5；有 `hasSyncTraces` 时显警示行）。挂在 MainApp 顶层、收 `onClaimPrompt` 打开。
- **文案**（设计 §5.5）：
  > 检测到本地有 {N} 条笔记。登录账号 {email}：
  > - **并入账号 {email}**（上传，账号所有设备可见，**不可撤销**）
  > - **保持独立**（笔记留在本地，账号 {email} 只同步自己的数据）

### 3.5 W6 —— local 工作区 UI 明示

- **判据写硬**：local ⇔ **`snapshot !== null && snapshot.server_url === null`**。`snapshot === null` 不算 local —— 那是 daemon 不可达/未上报（冷启动、kill），或账号 profile + keychain 坏（daemon 仍在账号库但 main 读不出 session），都不能显「本地」。
- `SyncStatusBar.tsx` popover：仅当 `snapshot !== null && snapshot.server_url === null` 才加明示行「本地独立工作区 —— 笔记仅存本地、不同步」+ 引导「在 [设置 → 同步] 登录账号」。`snapshot===null` 保持现有冷启动兜底文案。
- `SyncSection.tsx` 未登录视图 banner 判据 = **`session === null && snapshot !== null && snapshot.server_url === null`**。`session===null` 单条会误命中「keychain 不可用 / 密文坏」的**账号** profile（`sync-status-types.ts:42` 注；那种情形 `snapshot.server_url` 仍非空）→ 三条同真才显 banner「当前为**本地独立工作区**，笔记仅存储在本地。登录账号可在多设备间同步。」否则保持现有登录表单/错误态。
- **不强加新类型**：复用现有 `session`（IPC 全 reply）+ `snapshot.server_url`（SSE snapshot）双信号。（可选：给 `SyncStatusSnapshot` 加 `is_local` 让信号更显式、消除上面的双条件 —— 本片**不做**，避免 daemon broadcaster/类型连锁改动，留待真有歧义再加。）

### 3.6 测试

- core：`inspectLocalProfile`（空库/有笔记/含 sync 痕迹三态）；`copyLocalProfileDbInto`（copy 后目标库笔记数 == 源、源仍可用）。
- main `sync-auth`（mock daemon + SDK + fs + prompt）：
  - 首登空账号 + local 有笔记 + 选「并入」→ copy 被调（switch 前）+ switch + install + 写 toml；
  - 选「独立」→ **不** copy + switch 建空库；
  - 首登**非空**账号 → 不 probe 弹框、直接拉取；
  - 回访（profile db 已存在）→ 走 reuse 路径、不 probe、不弹框；
  - probe 弹框默认（窗口无）→ independent。
- renderer：`ClaimAccountDialog` 渲染 N/email、两按钮回 'merge'/'independent'、`hasSyncTraces` 显警示。
- W6：SyncStatusBar popover local 文案；SyncSection 未登录 banner（补两个组件单测）。

---

## 4. 16c —— W3 LWW server 归一化 + per-device counter（HLC-lite，§5.6）

> 目标：LWW 时间戳从裸 `Date.now()` 改 **server 归一化 + 单调 counter + deviceId 全序**，错钟设备不再单方面压制；同设备同毫秒连续编辑不再被对端丢弃。**owl 单仓，0.1.4 server 已就绪（回 serverTime），不动 skybridge。**

### 4.1 schema migration `0009`（owl）

- 文件名 **`0009_lww_counter.sql`**（`0008_backfill_create_ops.sql` 已 ship 且自注「后续走 0009」，**不可复用 0008**）。
- `notes` / `folders` 各加 `lww_counter INTEGER NOT NULL DEFAULT 0`（本地 LWW tiebreaker 存储；旧行回填 0）。
- **conflict_record 的 counter 列本片不做**：`conflict_record` 加 `local_counter`/`remote_counter` 会连带改 `sync/conflicts.ts` 的 `ConflictRecord`/`RecordConflictArgs`/INSERT/SELECT + GUI conflict 类型/测试，纯 display-only、与 LWW 正确性无关 → 留 conflict UI 迭代 / 0.6（W7 双向可见时一并）。本片 conflict_record 仍只记 `local_updated_at_ms`/`remote_updated_at_ms`（现状）。
- **`migrate.ts:47` `LATEST_KNOWN_VERSION` 8 → 9** + 落 `0009_lww_counter.sql` 到 migration 文件目录（`applyForwardMigrations` 按 `NNNN_*.sql` 自动定位）。fresh install 走 `applyInitialSchema` → `applyForwardMigrations(1, 9)`、升级走 `applyForwardMigrations(旧, 9)`，**二者跑同一批 forward migration**（migrate.ts 既有机制，**不碰 `0001_initial.sql`**）。`createDatabase` 版本派发已在 Phase 14 包好 close-on-throw。

### 4.2 offset 采集（每轮 sync）

- skybridge 0.1.4 `PushResult.serverTime` / `PullResult.serverTime` 每次都回（已确认）。**daemon adapter 当前丢弃**（`session.ts` RealSkybridgeClient `pullChanges` 只透传 `{changes, hasMore}`，吞了 `serverTime`/`latestSeq`）。
- 改：`engine.ts` 的 `PullResultLike`（+ push 结果类型）加 `serverTime: number`；adapter 透传。`runSync` 每轮 pull/push 后 `setServerTimeOffset(sqlite, serverTime - now())` 落 `local_metadata.server_time_offset_ms`。
- **`now()` 用 `runSync` 的注入时钟（`deps.nowMs`），不用裸 `Date.now()`** —— 与现有 runSync 测试注入一致、可断言。**empty pull（零 changes）也要落 offset**（空响应仍带 `serverTime`）→ offset 不靠「有变更」才更新，断网久了回来也能立即纠偏。
- bootstrap（从未 sync）→ offset 缺失视作 0（裸 `Date.now()`），首轮 sync 后归一化。可接受（设计 §5.6 末「老笔记一次性轻微抖动」）。

### 4.3 stamp helper（core）

新 `packages/core/src/sync/hlc.ts`（或并入 `changes.ts`）：

```
serverNormalizedStamp(sqlite): { ms: number; counter: number }
  offset = readInt('server_time_offset_ms') ?? 0
  phys   = Date.now() + offset
  lastMs = readInt('hlc_last_ms') ?? 0; lastCtr = readInt('hlc_last_counter') ?? 0
  if phys > lastMs { ms = phys;    ctr = 0 }
  else             { ms = lastMs;  ctr = lastCtr + 1 }     # 物理不前进 → 逻辑 counter 递增（HLC）
  write('hlc_last_ms', ms); write('hlc_last_counter', ctr)
  return { ms, counter: ctr }
```

- 全在一个事务内被业务写调用（与该写同事务，保证 `local_metadata` HLC 状态与行 stamp 一致）。
- `local_metadata` 新键：`server_time_offset_ms` / `hlc_last_ms` / `hlc_last_counter`（沿用 `key/value TEXT` 表，int 存字符串，仿 `device_uuid` 的读写）。

**`observeRemoteLwwKey(sqlite, remoteKey)`（严格 HLC，pull apply 时调）** —— 只 bump 本地写 HLC 还不够：设备 pull 到远端 `(ms,counter)` 后，本地 HLC 状态没推进，下一次「刚看见就编辑」的本地写在极端同毫秒/错钟下仍可能 ≤ 已观察 remote 而输。补：

```
observeRemoteLwwKey(sqlite, { ms: rMs, counter: rCtr }):    # rMs = remote updated_at_ms（已校验）
  lastMs = readInt('hlc_last_ms') ?? 0; lastCtr = readInt('hlc_last_counter') ?? 0
  if rMs > lastMs            { write('hlc_last_ms', rMs); write('hlc_last_counter', rCtr) }
  else if rMs === lastMs && rCtr > lastCtr { write('hlc_last_counter', rCtr) }
  # remote 更旧 → 不动
```

- 调用点：`runSync` apply 路径，**对每个带 `updated_at_ms` 的 remote payload、在 payload 校验成功后**执行（无论该 op 最终 apply 还是 LWW-skip，都已「观察」到该时间）。次轮本地 `serverNormalizedStamp` 因 `phys ≤ hlc_last_ms` 走 counter++ 分支，必 > 已观察 remote。

### 4.4 stamp 落点替换（core 业务写）

把**带 `updated_at_ms` 的 LWW 写**从 `new Date()/Date.now()` 改 `serverNormalizedStamp(sqlite)`：行写 `updated_at = ms` + `lww_counter = counter`，emit payload `updated_at_ms = ms` + **新增 `lww_counter = counter`**（additive 进 owl 自有 opaque payload，server 透明、对端读取）。

| 文件 | 函数 | 锚点 |
|---|---|---|
| `notes/index.ts` | createNote / updateNote / deleteNote / restoreNote / permanentDeleteNote | :124/:375/:457/:516/:567 + 各 emit payload |
| `folders/index.ts` | createFolder / updateFolder / deleteFolder（含子 + delete 锚） / reorderFolders | :49/:151/:200/:220/:237/:253 |

- **不带 `updated_at_ms` 的 metadata 写不改**（engine 本就跳过）：`setNotePinned`（`pinned_at_ms`）/ `reorderNotesInFolder`（`position`）/ conversations（`applied_at_ms`，append-only 无 LWW）。
- `created_at_ms` 可一并归一化（一致性），但非 LWW 键，**最小改动只动 `updated_at` 路径**；createNote 同一 `ms` 同时写 created/updated 即可。

### 4.4-bis payload parser 接住 `lww_counter`（**关键，否则发了也丢**）

apply 侧 `parseNotePayload`/`parseFolderPayload`（`sync/payloads/note.ts`/`folder.ts`）**重建 typed body、未知字段被丢** → 即使 emit 带了 `lww_counter`，到比较处也读不到。必须：

- 给每个 op payload interface 加 `lww_counter?: number`：note 的 `NoteCreate/Update/Trash/Restore/DeletePayload`、folder 的 `FolderCreate/Update/DeletePayload`。
- 每个 per-op parser sparse 接：新 helper `optionalNumber(op, raw, obj, 'lww_counter')`（present 时 `Number.isFinite` 校验、整数；缺失 → `undefined`）。仿现有 `requireNumber`。
- 兼容：pre-W3 / 0.1.3-era payload 无此字段 → `undefined` → 比较处 `?? 0`。

### 4.5 LWW 比较改三元（engine）

- `readLocalUpdatedAt` → `readLocalLwwKey(sqlite, id): { ms, counter, deviceId } | null`（notes 读 `updated_at, lww_counter, device_id`；folders 同）。**`notes.device_id`/`folders.device_id` 可空 → `deviceId: row.device_id ?? ''`**（null 归一化为空串，使三元比较类型/边界确定；远端 `c.deviceId` 是 wire string、非空）。
- 远端键：`{ ms: payload.body.updated_at_ms, counter: payload.body.lww_counter ?? 0, deviceId: c.deviceId }`（counter 经 §4.4-bis parser 接住；**向后兼容**：0.1.3-era / pre-W3 payload 无 counter → 0）。
- 比较 `cmp(remote, local)`：先 `ms`、平 `counter`、再 `deviceId`（字典序）。**remote > local → apply；否则 skip**。完全相等 → skip（保 idempotent / self-replay 安全，等价现 `>=`）。
  - `applyNoteChange` LWW gate（:445 `localTs >= remoteTs`）→ 三元。
  - `applyNoteDelete`（:357 `localTs > body.updated_at_ms`）→ 三元（remote ≤ local → skip）。
  - `applyFolderChange` / `readLocalFolderUpdatedAt`（:465）→ 三元。
  - `maybeRecordNoteConflict`（:374-413）输方判定改用三元（`cmp(remote,local) > 0` 即本地输）；**conflict_record 落库字段不变**（仍 `local_updated_at_ms`/`remote_updated_at_ms`，counter 列本片不加，§4.1）。
- **`observeRemoteLwwKey`（§4.3）在此处接线**：apply 路由对每个 payload 校验成功（`parseNotePayload`/`parseFolderPayload` 通过）后，无条件 `observeRemoteLwwKey(sqlite, remoteKey)` —— 在 LWW 比较之前或之后均可（只推进 HLC 观察态，不影响本次 apply 判定），但须在「校验通过、确有 `updated_at_ms`」之后。

### 4.6 测试

- core `hlc`：同毫秒连续 stamp → counter 0,1,2…；物理前进 → counter 归 0；offset 影响 `ms`（注入固定 `Date.now` + offset）；**`observeRemoteLwwKey` 推进后下次 stamp > 已观察 remote**（observe `(T, 5)` → 下次 stamp ms=T,counter=6）。
- core parser：note/folder 各 op `lww_counter` present → 接住进 body；缺失 → `undefined`；非有限数 → 抛 `*PayloadInvalidError`（round-trip 不丢）。
- core 业务写：createNote/updateNote 后行 `lww_counter` 落库 + payload 带 `lww_counter`。
- engine LWW 三元：
  - **错钟黑洞修**：快钟设备 stamp 经负 offset 归一化、不再恒赢。
  - **同设备同毫秒连续编辑不丢**：op1(ms=T,ctr=0)、op2(ms=T,ctr=1) 按 seq apply → op2 apply（ctr 高）而非被 `>=` skip（回归现 bug）。
  - 跨设备同 `(ms,counter)` → deviceId 决定，确定（非「最新」但全序一致）。
  - pre-W3 payload（无 counter）→ counter=0，与旧行为兼容。
- adapter：pull/push 透传 `serverTime`；`runSync` 后 `server_time_offset_ms` 落 local_metadata（注入 mock serverTime）。

---

## 5. 改动清单

| 片 | 仓/包 | 文件 | 改动 |
|---|---|---|---|
| 16a | gui main | `sync-ipc.ts` | login/logout 成功后 `notifyProfileSwitched()`（`webContents.send('profile:switched')`） |
| 16a | gui | `preload/index.ts` + `types/owl-api.d.ts` | `owlAPI.onProfileSwitched(cb)` |
| 16a | gui renderer | `MainApp.tsx` | mount 注册 onProfileSwitched → `window.location.reload()` |
| 16b | core | `notes/count` 或 `profile/inspect.ts`(✚) | `inspectLocalProfile(): {noteCount, hasSyncTraces}` + `copyLocalProfileDbInto(target)`；`index.ts` 导出 |
| 16b | gui main | `sync-auth.ts` | `loginAndOpenSession` 分「回访/首登」两路（B9）：首登上提 register+ensureWorkspace+probe，空账号+local 有笔记 → `promptClaim` → merge 则 switch 前 copy |
| 16b | gui main | `claim-prompt.ts`(✚) | `promptClaim()`（`sync:claim-prompt` send + `sync:claim-response` once）—— **独立文件防 sync-ipc↔sync-auth import 环** |
| 16b | gui | `preload/index.ts` + `owl-api.d.ts` | `sync.onClaimPrompt` / `sync.respondClaim` |
| 16b | gui renderer | `ClaimAccountDialog.tsx`(✚) + `MainApp.tsx` | shadcn AlertDialog，挂顶层 |
| 16b | gui renderer | `SyncStatusBar.tsx` / `SyncSection.tsx` | W6 「本地独立工作区」明示 |
| 16c | core | `db/migrations/0009_lww_counter.sql`(✚) + `schema.ts` + `migrate.ts` | notes/folders 加 `lww_counter`；`LATEST_KNOWN_VERSION` 8→9（conflict_record counter 列**不做**，§4.1） |
| 16c | core | `sync/hlc.ts`(✚) | `serverNormalizedStamp` + `observeRemoteLwwKey` + offset/HLC `local_metadata` 读写 |
| 16c | core | `sync/payloads/note.ts` / `folder.ts` | 各 op interface 加 `lww_counter?: number` + sparse 校验（§4.4-bis） |
| 16c | core | `notes/index.ts` / `folders/index.ts` | LWW 写改 `serverNormalizedStamp`；payload + 行加 `lww_counter` |
| 16c | core | `sync/engine.ts` | `PullResultLike`+push 加 `serverTime`；`runSync` 落 offset + 每 payload `observeRemoteLwwKey`；LWW 比较改三元（note/folder/delete/conflict） |
| 16c | daemon | `sync/session.ts`（RealSkybridgeClient adapter） | pull/push 透传 `serverTime`（停止丢弃） |

---

## 6. 验收

- 三片均：`pnpm -r build` → `just check`（8 守卫，含 `daemon-no-toml-write`——**16b copy/认领不写 toml**，toml 仍只 GUI main login/logout 写）→ `just test`（单测全包）→ `just test-skybridge-e2e`（gated e2e）全绿。
- **16a 真机**：local 起 → 登录账号 A → 窗口自动 reload、立即显示 A 的笔记（无需手刷，**闭环 Phase 15 首要粗糙点**）；logout → reload 回 local 视图。
- **16b 真机**：纯 local（有笔记）首登空账号 A → 弹「并入/独立」；并入 → A 拉到这些笔记、`profiles/<idA>/owl.db` 生成、**`owl/owl.db` 原样不变**；独立 → A 空、local 不变；登录**非空**账号不弹框、纯拉取；登出回 local → UI 见「本地独立工作区」。
- **16c 真机/soak**：错钟设备（系统时钟拨快）写笔记 → 经 offset 归一化不再恒赢；多设备 LWW 收敛一致（错钟必测项进 Phase 20 soak）。

---

## 7. 不做 / 推迟

| 项 | 落点 |
|---|---|
| `resetAllStores(epoch)` 软重置（免整窗 reload 闪烁） | 0.6（§5.4.4 精修） |
| 切换/login 的「未保存草稿」拦截 | 0.6（0.5.0 整窗 reload 直接丢旧 profile 草稿，记 release notes） |
| 跨账号导入 / local→**非空**账号显式导入 | 0.6+（§5.5 末） |
| 认领时对 orphan 库做 op 手术（清 cursor / 重置 synced_at） | 不做（0.5.0 仅告警，B8 降级；单用户实机足够） |
| GUI 侧栏免密快切下拉 / 移除设备 revoke / 状态 popover 手动同步 | Phase 17（W4/W8/W9） |
| 删除账号本地副本（destructive） / 精确回滚到上一个 active profile | Phase 17 |
| `created_at_ms` / `client_created_at` 归一化（非 LWW 键） | 不做（W3 只动 LWW 比较键 `updated_at_ms`+counter） |
| 给 `SyncStatusSnapshot` 加 `is_local` 显式字段 | 不做（复用现有 server_url===null / session===null 信号；真有歧义再加） |
| `conflict_record` 加 `local_counter`/`remote_counter` 列 + GUI 展示 | 不做（display-only，连带改 conflicts.ts/GUI 类型/测试；留 conflict UI 迭代 / 0.6 W7） |
| skybridge 任何改动 | **不需要**（0.1.4 已具 serverTime；payload owl 自有；wire 已带 device_id） |
