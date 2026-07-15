# Refactor Round (Stage 1 #3) — 设计 + per-big-file mini-plans

> 状态：**规划草案 2026-07-15，待用户整体审阅后动手**。对应 `docs/plans/2026-07-04-road-to-1.0.0.md` §2 #3「重构一轮」。
> 前置：A6 local-csrf 已完成并 push（`58399fb`），树干净，`main` 全绿。
> 本doc 是本轮的**唯一实施源**；三个大文件各带一份 mini-plan（拆分边界 + 回归测试点 + 风险）。

---

## 0. 目标与范围

系统性清理，为 0.6 本地功能腾干净地基。**四个 bucket**，用户 2026-07-15 拍板：

- **推进顺序（低风险先行）**：bucket 1 type-dedup → bucket 2 复杂度 warning → bucket 4 B1 tsc-b → bucket 3 大文件拆分。
- **大文件范围**：3 个 >800 强制文件（`sync-auth.ts` / `sync/engine.ts` / `editor-store.ts`）**全包含**，各写 mini-plan、逐个提交。
- **500–800「建议」8 个文件**：本轮**不做整文件拆分**（`notes/index.ts` / `migrate.ts` / `ai-store.ts` 会在 bucket 2 顺手消解其复杂度 warning，可能连带瘦身，但不强制拆到 <500）。若审阅时想纳入再议。

**全程铁律**：桌面端零回归；每步 `just check`（9 守卫 + biome + `tsc -b`）+ 相关 `just test` 全绿才提交；每个 commit 独立可回滚；不改行为，只搬家 / 抽函数。

---

## 1. Ground truth（2026-07-15 实测，doc 旧数字已漂移）

- **复杂度 warning**：**22 条**，全部 `noExcessiveCognitiveComplexity`（max 15），散在 **18 个文件**（road doc 旧记「20 条 / 5 文件」已过时）。
- **>800 大文件**：`sync-auth.ts` **1043** · `sync/engine.ts` **1041** · `editor-store.ts` **846**。
- **500–800**：`notes/index.ts` 754 · `FolderPanel.tsx` 753 · `skybridge/config.ts` 692 · `migrate.ts` 656 · `ai-store.ts` 601 · `cloud-login.ts` 532（+ 2 个 e2e/test）。
- **测试基线**：core **532** / cli **139** / daemon **420** / gui **455** + gated e2e 29；`just check` 9 守卫。

---

## 2. Bucket 1 — 类型 mirror dedup（S–M，1 commit）

**问题**：`packages/shared/src/types.ts`（296 行）手抄了 `packages/core/src/config/index.ts`（374 行）的 config 类型：`OwlConfig` / `LlmConfig`(→`PublicLlmConfig`) / daemon 内联块（含 `web_root`，B4 已漂过一次）/ `PublicOwlConfig` / `PublicDaemonConfig`。两份手同步、易漂。

**约束（已核实）**：
- core 是 Node 包（config/index.ts import 了 `node:fs` + `smol-toml`）→ renderer/web 不能 import `@owl/core`。
- `shared-no-node-electron` 守卫禁止 `owl-shared` import node/electron → shared 不能 import core。
- ∴ 去重后的**单一真源必须是 Node-free**，落在 `@orpheus-aviary/owl-shared`；core **re-export**。

**方案（Option 1，唯一可行）**：
1. 新建 `packages/shared/src/config-types.ts`（纯类型，零 import）：`OwlConfig`、`LlmConfig`、`DaemonConfig`、`WindowConfig`、`FontConfig`、`NavigationConfig`、`AiConfig`、`TrashConfig`、`LogConfig`、`EditorConfig`、`BrowserConfig`、`ShortcutsConfig`、`SyncConfig` + `PublicLlmConfig`、`PublicOwlConfig`、`PublicDaemonConfig`、`LlmApiFormat`。以 core 现有定义为准（core 更全，含 `DaemonConfig` 独立 interface；shared 现在是内联 daemon 块——统一成 `DaemonConfig` interface）。
2. `packages/shared/src/index.ts` + `types.ts` re-export config-types（renderer/web 导入路径不变）；删掉 `types.ts` 里的手抄块。
3. `@owl/core` 加依赖 `@orpheus-aviary/owl-shared`（新的 core→shared 叶子边，方向合法）；`config/index.ts` 改为 `import type { OwlConfig, ... } from '@orpheus-aviary/owl-shared'` 并 `export type` 之，**运行时保留在 core**（`DEFAULT_CONFIG`、load/save、`redactConfig`/`projectConfigForViewer`）。~20 个 daemon `import { OwlConfig } from '@owl/core'` 经 re-export 不变。
4. 若 core 与 shared 的类型有**实质差异**（如 shared 缺 `SyncConfig`、daemon 块字段集不完全一致）→ 对账时以 core 为准补齐 shared；**这正是 dedup 要修的漂移**，逐字段核对。

**验证**：`just check`（含 `shared-no-node-electron` + `core-convergence`）+ `just test` 全绿；`pnpm -r build`（含 owl-server tsup——核实 owl-shared 作为 core 新 dep 在 bundle/externals 中处理正确，gen-manifest 仍删 workspace 包）。

**风险**：① core→shared 新依赖边影响 owl-server 打包 externals（`runtime-externals.json` 单一源）——核实 owl-shared 是否已被当 workspace 包内联；② 字段对账漏项 → tsc 立刻报错兜底；③ `PublicOwlConfig` 的 `Omit` 派生跨包后要保持结构一致。

---

## 3. Bucket 2 — 复杂度 warning（M，4 commit，多机械）

22 条 → 4 个 commit batch。**套路**：抽子函数 / 查表 dispatch / 提前 return，**不改行为**（同 B4 `isAuthExempt` 手法）。22 条里仅 **5 条**有真实行为改动风险（`migrate.ts:426`、`edit.ts:76`、3 条 `TagBar`），其余 17 条近机械。

**Batch 2a — `refactor(core): reduce complexity in notes/tags/folders/migrate`**（6 条）
- `db/migrate.ts:426 migrateLegacyDb [51]`——**最硬**，抽 `peekIdempotency`/`acquireMigrateLock`/`initNewDb`/`copyAndSwap`，顶层变线性；**try/finally 边界逐字保留**（lock/swap/rollback 顺序 load-bearing）。**单独成 hunk**，改前后跑 migrate/core 测试。
- `notes/index.ts:200 listNotes [34]`——抽 `resolveFtsIds`/`resolveTagIds`/`buildFolderConditions` + `attachTags`（`listAlarmNotes:335` 复用）。
- `notes/index.ts:369 updateNote inner txn [22]`——抽 `buildUpdatePayload`/`buildUpdateColumns`，CAS guard 保留 early throw。
- `tags/parser.ts:96 inferDateTime [33]`——抽 `splitDateTimeParts`/`parseTimePart`/`parseDatePart`。
- `tags/parser.ts:33 parseTag [17]`——抽 `parseTimeTag`。
- `folders/index.ts:148 updateFolder inner txn [21]`——抽 `buildFolderUpdateColumns`/`buildFolderPayload`。
- 难度 **tricky**（因 migrate.ts）；⚠️ migrate.ts 高风险，独立 hunk。

**Batch 2b — `refactor(daemon): extract guard/boot/route/auth-hook helpers`**（4 条）
- `routes/ai.ts:22 [27]`——抽 `prepareChatRequest` + `streamAgentEvents`。
- `startup-guard.ts:73 [26]`——拆 `assertDaemonShape` + `assertCloudGuards`（`if mode==='local' return` 是天然切点）。
- `boot.ts:66 [26]`——抽 `runStartupGuards` + `openProfileDb`；`process.exit(1)` 站点不动。
- `server.ts:90 auth preHandler [21]`——拆 `checkLocalToken` + `checkCloudSession`（`setNotFoundHandler:163` 复用 `checkLocalToken`）。
- 难度 **moderate**；⚠️ startup-guard + server auth-hook 是 A0/A6 fail-closed 安全路径——**零逻辑改**，throw/401 条件逐字保留；跑 daemon 测试 + `just check`（部分守卫对这些文件形状有断言）。

**Batch 2c — `refactor(gui): reduce complexity in TagBar + ai cards + lib utils`**（6–7 条）
- `TagBar.tsx:34 parseDateTimeHint [29]`——抽 `parseTimeHint`/`parseDateHint`；⚠️ 年份 rollover(L90) 微妙。
- `TagBar.tsx:342 handleKeyDown [22]`——键位查表 dispatch；⚠️ `preventDefault` 位置。
- `TagBar.tsx:321 handleTabComplete [17]`——抽 `completeSuggestion`/`completeFrequency`。
- `ai/DraftReadyCard.tsx:53 [17]`——拆 `<CardHeader>`/`<CardBody>` 渲染子函数（纯视图）。
- `lib/reminder-utils.ts:60 getNearestAlarm [21]`——抽 `alarmCandidates`。
- `lib/note-id-refs.ts:54 walk [21]`——按 node type 抽 `rewriteLink`/`rewriteInlineCode`/`rewriteText`。
- 难度 **moderate**；⚠️ **TagBar 3 条有真实行为风险**（日期解析 + 键盘）——需按 owl CLAUDE.md 出**手动测试清单**（tag 录入、Tab/Enter/Arrow、日期推断）。TagBar 可单独成 commit。

**Batch 2d — `refactor(cli+gui): simplify runEdit/http/migrate + shortcuts + stores`**（5–6 条）
- `apps/cli/commands/edit.ts:76 runEdit [55]`——**次硬**，按模式拆 `runInteractiveEdit`/`runReplace`/`runPatch`；⚠️ CAS/flag 组合 + `--replace` full-vs-simple payload 逐分支保留。
- `apps/cli/backend/http.ts:137 listNotes [26]`——抽 `buildListQuery`（纯机械）。
- `apps/cli/commands/migrate.ts:53 runMigrate [17]`——抽 `assertMigratable`/`assertNoLiveDaemon`/`confirmMigration`；⚠️ daemon-lock preflight 顺序保留。
- `hooks/useEditorShortcuts.ts:61 [36]`——focus 助手查表 `FOCUS_HELPERS` + 抽 `dispatchConfiguredAction`；⚠️ capture-phase + close_tab 拦截 guard，preventDefault/early-return 语义保留；测 tab-close + focus。
- `stores/ai-store.ts:532 hydrateDaemonMessages [19]`——按 role 抽 `hydrateUserMessage`/`hydrateAssistantMessage`/`slotToolResult`。
- `components/ai/ChatSidebar.tsx:68 [16]`——抽 `nextConversationId`（刚过阈值，trivial）。
- 难度 **moderate-tricky**（edit.ts + useEditorShortcuts）；⚠️ 两者行为风险——existing cli-edit 测试 + 手动 editor-shortcut pass 覆盖。

> **可选守卫收尾**：本 batch 后 biome warning 应归零。可考虑把 max complexity 保持 15 不放宽（当前即是）；不新增守卫。

---

## 4. Bucket 4 — B1 apps/web 接 tsc -b（S–M，1 commit）⚠️ 前提已被推翻，需用户决策

**关键更正**：`PROCESS.md:25/40` + road doc `:46` 写的「撞双 `@types/react` 身份冲突」**在当前树不可复现**。实测：全仓仅 **1 份** `@types/react@19.2.14`（`node-linker=hoisted` 顶层单拷贝，`apps/web` 与 `packages/gui` 解析到同一份，git 历史里从未分叉）。**dedup 是 no-op。**

**真实 blocker**：project-reference / `rootDir` / composite 结构问题。`apps/web` 经 `@` 源码 alias 复用 gui renderer（设计「路 A」），对 `noEmit` bundler 模式合法，但对 composite `tsc -b` 节点非法（composite 要求所有输入文件在自己 rootDir 下；renderer 在 sibling 包）。实测三段 probe 确认：composite → TS6059/TS6307 洪水；rootDir 放宽到 repo root + include renderer glob → **全绿，无任何 react 类型冲突**。

**两个修法（需用户选）**：
- **Option A（真接 tsc -b）**：`apps/web/tsconfig.json` 加 `composite:true`、`rootDir:"../.."`、include 扩到 `packages/gui/src/renderer/src/**` + `shared/**`；root `references` 加 `apps/web`。⚠️ 必须把 emit（`.d.ts`/`.tsbuildinfo`）导到 `out/` 并 gitignore（probe 里误 emit 448 个 stray artifact 到 gui 源码）；renderer 会被 gui + web **双 typecheck**（冗余但无害）。桌面零回归（gui 自己的 `tsconfig.web.json` 不动）。
- **Option B（最小风险）**：不进 `tsc -b`，`just check` 加一条独立 `tsc --noEmit -p apps/web/tsconfig.json`。零依赖/图改动、零桌面风险；覆盖 apps/web 特有文件（`main.tsx`/web glue）。缺点：不满足字面「接 tsc -b」、web 不进增量图、两条命令。

**推荐**：若目标是「apps/web 特有文件进 CI typecheck」→ **Option B**（省事、零风险）；若确实要折进增量 `tsc -b` 图 → **Option A**（注意 emit-dir/gitignore）。**两者都桌面零回归。**
**附带**：改写 `PROCESS.md:25/40` + road doc `:46` 的「双 @types/react」表述为「project-ref/rootDir 墙」。

---

## 5. Bucket 3 — 大文件拆分（L，1 commit/文件，逐个 mini-plan）

三份都是「保持公共 surface 不变，把内部 cluster 搬到 sibling 模块 + barrel/re-export」，消费者与测试导入路径**零改动**。每个开工前再跑一次 pre-flight（确认行数/surface 未漂），跑对应测试 gate。

### 5.1 mini-plan A — `sync-auth.ts` 1043 → 拆 4（GUI main，含 electron/safeStorage）

**测试保护**：`sync-auth.test.ts`（1087 行）只绑公共 surface，重 mock（safeStorage/skybridge-client/core/daemon/fetch），断言 `callLog` 顺序。`beforeEach` 用 `clearRefreshTimer()` + `__resetSwitchQueueForTests()` 复位两个 singleton。

**公共 surface（必须仍从 `sync-auth.js` 可导）**：3 个 error class（`SafeStorageUnavailableError`/`SkybridgeServerTooOldError`/`QuickSwitchNeedsLoginError`）+ `SyncSessionSummary` + 6 动词（`loginAndOpenSession`/`logout`/`switchToProfile`/`deleteProfileLocalCopy`/`restoreSessionOnStartup`/`maybeRefreshNow`）+ `clearRefreshTimer` + `runSwitchExclusive` + `__resetSwitchQueueForTests`。消费者仅 2 个 runtime（`sync-ipc.ts`、`index.ts`）+ 测试。

**拆分（全部落 `packages/gui/src/main/`，都 electron-only、守卫安全）**：
- `sync-switch-queue.ts`（**叶子**）：`switchQueue` + `runSwitchExclusive` + `__resetSwitchQueueForTests`（解 orchestrator↔renewal 环，仿 `claim-prompt.ts` 前例）。
- `sync-auth-crypto.ts`（叶子）：`decryptB64`/`defaultDeviceName`/`safeReadConfig` + 3 error class + `SyncSessionSummary`（谁都依赖它、它不依赖内部）。
- `sync-auth-transport.ts`：daemon HTTP（`postSyncSession`/`postSyncSwitch*`/`bestEffort*`）+ 远程 teardown（`bestEffortRevokeProfile`/`remoteRevoke`/`isTokenExpired`）+ workspace/device（`ensureOwlWorkspace`/`maybeClaimLocalInto`/`reuseDevice`/`registerNewDevice`）。无 module state。
- `sync-auth-renewal.ts`：**独占 `refreshTimer`/`currentExpiresAt` singleton** + `refreshSession[Impl]`/`maybeRefreshNow`/`clearRefreshTimer`/`scheduleRefresh[In]`/`persistRotated`/`isRefreshDead` + 4 timer 常量。**导出 `getCurrentExpiresAt()` getter**（不能 re-export 裸 `let`）。
- **残余 `sync-auth.ts`** = orchestrator + barrel（~430 行）：`loginAndOpenSession[Impl]`/`logout[Impl]`/`switchToProfile[Impl]`/`planQuickSwitch`/`installSessionFor`/`rollbackToPrior`/`reschedulePrior`/`deleteProfileLocalCopy[Impl]`/`restoreSessionOnStartup[Impl]` + `acquireSwitchLockFile`；re-export renewal + crypto 的公共符号。

**风险**：① **singleton 重复**（最高）——`refreshTimer`/`currentExpiresAt`/`switchQueue` 必须各仅一份；32-bit overflow 测试 + 「bad password 保留 prior timer」测试兜底，但前提是 reset 命中同一实例。② orchestrator↔renewal 环——用 `sync-switch-queue.ts` 叶子解。③ electron/safeStorage 守卫——所有含 safeStorage 的模块留 `main/`，勿被 daemon/core import。④ `callLog` 顺序断言（claim `['copy','lock','switch','unlock']`、quick-switch `update` 先于 `switch`、delete `revoke` 先于 `logout`、失败时 lock/unlock 平衡）——`acquireSwitchLockFile` 及其调用点留 orchestrator 不动。⑤ post-listen/timing——`refreshSessionImpl` 仍走同一 queue + 顶部 `safeReadConfig` 重读（Phase 21 layer B）；transport 每个 fetch 保留 `daemonAuthHeaders`（A6 token，否则 daemon 401）。

**gate**：`just test`（gui 455）+ `just check`（`daemon-no-electron-storage`/`daemon-no-toml-write`）。**建议顺序**：先抽叶子（queue、crypto），再 transport，再 renewal（getter），最后残余 orchestrator——每步跑 sync-auth.test。

### 5.2 mini-plan B — `sync/engine.ts` 1041 → 拆 4（core，纯 Node，可用 node）

**测试保护**：`engine.test.ts`（1910 行）+ `hlc-engine.test.ts` 只绑公共 surface（`runSync`/`SkybridgeProtocolError` + `*Like`/`RunSync*` 类型），**零内部符号引用**（grep 确认）。sync/ 内**现无环**（siblings 从不 import engine）。

**公共 surface（core barrel `index.ts:153-164` 保持）**：`runSync`、`upsertSyncCursor`、`SkybridgeProtocolError` + 类型 `LocalChangeLike`/`ServerChangeLike`/`PushAckLike`/`PushResultLike`/`PullResultLike`/`SkybridgeClientLike`/`RunSyncDeps`/`RunSyncResult`/`RunSyncLogger`。消费者：daemon `sync/session.ts`/`manual.ts`/e2e + gui `sync-run-types.ts`（手抄 `RunSyncResult`——字段名勿动）。

**拆分（落 `packages/core/src/sync/`）**：
- `types.ts`（叶子，零 import）：全部 barreled 类型 + `ApplyOutcome`/`ConflictSink`（避免 value/type 环）。engine.ts re-export 供 barrel。
- `lww.ts`（~90）：`LwwKey`/`cmpLww`/`remoteLwwKey`/`readLocalNoteLwwKey`/`readLocalFolderLwwKey`/`readLocalNoteSnapshot`/`isSelfReplay`/`payloadTagsToParsed`。纯 helper，谁都依赖、不依赖 engine。
- `apply.ts`（~500）：Cluster E+F+G+H 全部 `applyNote*`/`maybeRecordNoteConflict`/`applyNoteChange`/`applyFolder*`/`applyConversation*`/`cryptoRandomId`/`hasUpdatedAtMs`/`applyOneChange`（**唯一对外入口**）。若 >500 再拆 `apply-note.ts`/`apply-folder-conversation.ts`。
- `cursor.ts`（~30）：`upsertSyncCursor`（在 barrel → engine.ts `export { upsertSyncCursor } from './cursor.js'`）。
- **残余 `engine.ts`**（~300）= orchestrator：`NOOP_LOGGER`/`refreshServerOffset`/`runSync` + payload-error re-export + cursor/types re-export。`runSync` import `applyOneChange`(apply)/`upsertSyncCursor`(cursor)/`ConflictSink`(types)。

**风险**：① sync/ 内环——所有共享类型放叶子 `types.ts`，勿让 apply.ts 从 engine.js import 类型再反向。② **事务边界留 `runSync`**——per-batch `sqlite.transaction(...)` + `defer_foreign_keys` pragma + push backfill txn 不移出；`applyOneChange` 在 txn 内被调、**必须保持同步**（better-sqlite3 txn 同步），勿把抽出的 apply fn 变 async。③ push/pull 顺序 + cursor 持久化——`upsertSyncCursor` 两个调用点（pull L961 / push L1018）+ `serverSeqHigh>0` guard 不动。④ `RunSyncResult` 字段漂移——gui `sync-run-types.ts` 手抄，`conflictsRecorded`/`cursorBefore/After`/`serverSeqHigh` 全保留；`conflictSink.count` 线程完整（§6.16 有 9 个测试断言 conflict-count 契约）。

**gate**：`node --test engine.test.ts` + `hlc-engine.test.ts` + `just test-core`。**顺序**：`cursor.ts`（练 re-export）→ `types.ts` → `lww.ts` → `apply.ts`，每步跑 engine 测试。

### 5.3 mini-plan C — `editor-store.ts` 846 → 抽纯 helper 到 `editor-tabs.ts`（gui renderer，最低风险）

**测试保护**：`editor-store.test.ts`（755 行，6 describe）驱动公共 store（`useEditorStore.getState()`），mock `@/platform`+`api`+`window`/`fetch`，**零内部 helper 引用** → helper 可自由搬家（只要 store 行为不变）。

**公共 surface（仍从 `stores/editor-store.ts` 可导）**：`useEditorStore` + `useActiveTab` + `openNoteById` + 类型 `TabState`/`EditorMode`/`PendingAiUpdate`/`ConflictDecision`/`VersionConflictDecision`/`AiDraftInput`/`ConflictPrompt`/`VersionConflict` + `detectPendingUpdateConflict`。消费者 ~15 组件/hook（§调查详列）。

**方案（Option a：抽纯函数，最低风险，回收 ~150 行 → ~600）**：
- 新 `stores/editor-tabs.ts`（纯，无 zustand）：搬 `tagsEqual`/`serializeTags`/`deserializeTags`/`extractTitle`/`isUnsaved`/`casBaseline`/`detectPendingUpdateConflict`/`versionConflictFromError` + 相关纯类型/interface。
- `editor-store.ts` **re-export** 所有搬走的类型 + `detectPendingUpdateConflict`（消费者路径不变）。
- **不动闭包**：`saveNote`/`resolveConflict`/`resolveVersionConflict`/`replaceTabAfterCreate`/`saveDraft`（捕获 `set`/`get` + 调 `useDataBus.bumpNotes`）留在 store。
- **不选** slice 拆分（b）——要重写每个 `get().saveNote(...)` 跨 cluster 调用，churn 大；**不选**全 CAS/AI 子系统抽取（c）——那些 action 调 `set`/`get`/data-bus，抽出要传 store-ref，得不偿失。

**风险**：① `openNote` 内 set-callback 复杂度**恰 15**（阈值上，当前不报）——纯 helper 抽取**不降它**；若要留 headroom，另抽 `mergeOpenTab(tab, note, requestPreview)` 纯 helper 到 editor-tabs（可选，不阻断）。② Option a **零闭包搬家**=安全底线，逐个确认搬走的 fn 真纯。③ data-bus bump 只在 `saveNote`/`saveDraft`，二者留 store，勿把 `./data-bus` 拖进「纯」文件（否则破坏测试 window/fetch stub）。④ remoteClient-gated CAS 桌面-vs-web：`casBaseline`/`versionConflictFromError` 纯可搬，但搬后重跑 B2 describe 确认桌面「省略 `expected_updated_at`」路径不变。⑤ 类型 re-export 漏项 → ~10 文件 compile break，tsc 兜底。**无 autosave timer**（Cmd+S via `useEditorShortcuts` 是唯一 save 触发）→ 无 timer 生命周期风险。

**gate**：`just test`（gui 455，尤其 editor-store.test 6 block）+ `just check` + 手测编辑器（开/切/存/冲突）。

---

## 6. 提交计划 / sequencing（用户 2026-07-15 定稿：高风险项 peel 独立 commit）

| # | commit | scope | 风险 | gate |
|---|---|---|---|---|
| 1 | `refactor(config): dedup config types into owl-shared` | bucket 1 | S–M | check + test + build |
| 2 | `refactor(core): reduce complexity in notes/tags/folders` | 2a −migrate（notes:200/369、tags:33/96、folders:148） | mod | test-core |
| 3 | `refactor(core): simplify migrateLegacyDb` | **migrate.ts:426 peel** | tricky | test-core + migrate 手测 |
| 4 | `refactor(daemon): extract guard/boot/route/auth-hook helpers` | 2b | mod(安全路径) | test-daemon + check |
| 5 | `refactor(gui): reduce complexity in ai cards + lib utils` | 2c −TagBar（DraftReadyCard、reminder-utils、note-id-refs） | low | test-gui |
| 6 | `refactor(gui): reduce TagBar complexity` | **TagBar 3 条 peel** | mod | test-gui + 手测 |
| 7 | `refactor(cli+gui): simplify http/migrate + shortcuts + ai-store` | 2d −edit（http、cli/migrate、useEditorShortcuts、ai-store、ChatSidebar） | mod(shortcuts) | test + 手测 |
| 8 | `refactor(cli): split runEdit into mode handlers` | **edit.ts:76 peel** | mod | cli test |
| 9 | `refactor(web): add apps/web standalone typecheck step` | bucket 4 **Option B** | S | check |
| 10 | `refactor(gui): split sync-auth.ts into 4 modules` | 3-A | **L** | test-gui + check |
| 11 | `refactor(core): split sync/engine.ts into apply/lww/cursor/types` | 3-B | **L** | test-core + e2e |
| 12 | `refactor(gui): extract editor-store pure helpers to editor-tabs` | 3-C | M | test-gui + 手测 |

- 每个 commit 前用户确认（遵 CLAUDE.md）。`useEditorShortcuts` 若单 hunk 太大可再从 #7 peel。
- **PROCESS.md 更新**：按 `feedback_process_doc_commit`——分步提交时只提交代码，PROCESS.md 留工作树给用户。
- 三大文件（#10/#11/#12）各自开工前**再跑一次 pre-flight**（行数/surface 复核）。

---

## 7. 决策（用户 2026-07-15 已定）

1. **Bucket 4 = Option B**：`just check` 加独立 `tsc --noEmit -p apps/web/tsconfig.json`（不进 `tsc -b` 增量图；零依赖/桌面风险）。附带改写 `PROCESS.md:25/40` + road doc `:46` 的「双 @types/react」表述为「project-ref/rootDir 墙」。
2. **500–800 文件不强制拆**：本轮只在 bucket 2 顺手消解其复杂度 warning（可能连带瘦身），不拆到 <500。
3. **高风险项 peel 独立 commit**：`migrate.ts:426` / `edit.ts:76` / `TagBar`(3 条) 各自独立 commit（见 §6 表 #3/#6/#8）。
4. **顺序**：低风险先行（bucket 1→2→4→3）。

---

## 8. 关联

- 路线源：`docs/plans/2026-07-04-road-to-1.0.0.md` §2 #3
- 当前状态：`PROCESS.md`
- A6（刚完成，本轮不碰其 token gate 行为）：`docs/plans/2026-07-15-a6-local-csrf.md`
- owl-server 打包（bucket 1 core→shared 新边需核实其 externals）：`docs/plans/2026-07-04-owl-server-packaging.md`

---

## 9. 实施记录（✅ 完成并 push origin/main 2026-07-16，13 commit `95c21bb`…`cac23dd`）

全程 `just check`（9 守卫 + `tsc -b` + biome）+ 相关测试逐步全绿；GUI 手测通过；**行为保持型，无回归**。最终：core **532** / cli **139** / daemon **420** / gui **455** / gated e2e 0-fail。

| commit | 内容 |
|---|---|
| `95c21bb` | refactor(config): dedup config types into owl-shared |
| `55187ac` | refactor(core): reduce complexity in notes/tags/folders |
| `200be86` | refactor(daemon): extract guard/boot/route/auth-hook helpers |
| `4b366f8` | refactor(gui): reduce complexity in ai cards + lib utils |
| `44f946e` | refactor(cli): simplify listNotes query + migrate preflight |
| `806a03b` | refactor(core): split migrateLegacyDb into phase helpers（peel，51）|
| `87d52eb` | refactor(cli): split runEdit into mode handlers（peel，55）|
| `e9b0991` | refactor(gui): reduce useEditorShortcuts keydown complexity |
| `b73b2b8` | refactor(gui): reduce TagBar complexity（peel 3 条）|
| `3f46e9b` | build(web): add apps/web standalone typecheck to just check（B1 Option B）|
| `865e01d` | refactor(editor): extract editor-store pure helpers to editor-tabs |
| `9d6e9c7` | refactor(skybridge): split sync engine into lww + apply modules |
| `cac23dd` | refactor(skybridge): split sync-auth.ts into 4 modules |

**与原计划的差异 / 关键发现**
- **复杂度实测 22 条（非旧记 20/5）**；全部消解为 0。
- **大文件实际拆法**（比 mini-plan 更简）：`engine` 只拆 2 文件（`apply.ts`+`lww.ts`，无 `cursor.ts`/`types.ts`——barreled 类型留 engine，apply→engine 用 **type-only import** 免 runtime 环）；`editor-store` 只抽纯 helper 到 `editor-tabs.ts`（零闭包搬家）；`sync-auth` 按 4-sibling 拆（唯一动到有状态 cluster=renewal 单例，`getCurrentExpiresAt()` getter，靠 `sync-auth.test` 1087 行的 callLog/32bit/prior-timer 钉死）。
- **B1 前提被推翻**：无「双 @types/react」——真为 composite/rootDir 结构墙，用 Option B 独立 typecheck。
- **顺序实际**：bucket 1 → 2（含 peel）→ 4 → 3（editor-store → engine → sync-auth，低风险先行）。
- **⚠️ 踩坑（未修，留 chore）**：`justfile` `ensure-node-abi` 的 `node_modules/.pnpm/better-sqlite3@*/…` glob 在 `node-linker=hoisted` 布局下失配（better-sqlite3 是顶层实目录）→ ABI 自动 rebuild 失败；本轮手动 `(cd node_modules/better-sqlite3 && pnpm run build-release)` 绕过。`just dev`(Electron ABI) ↔ daemon(Node ABI) 切换会触发。
- **已 push origin/main**（`9d6e9c7..cac23dd`）；PROCESS.md/road-doc 已同步标完成。
