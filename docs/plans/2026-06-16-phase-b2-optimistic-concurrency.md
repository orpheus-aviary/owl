# Phase B2 实施计划：Web 编辑器乐观并发（CAS）

> 状态：**v3 — 已实现 + 全绿（2026-06-16），待手测 + commit**。父设计 `docs/plans/2026-06-14-phase-b-web-design.md`（§3.3 + §7 #6）。见文末 §实施记录。
> 前置：B0 ✅ B1 ✅。本片是 Phase B 唯一回流 shared 的 slice。
> v2 变更：**取消自动保存**（改手动保存，和桌面一致）；明确保护模型为「仅 web editor save」；补 folder-drag 基线 rebase；收紧 409 判定；列清越过 CAS 的写入口。
> v3 变更：**确认保留 web 脏 tab `beforeunload` 刷新保护**（替代自动保存的防丢；已锁定为计划项，非可选）。

## Context（为什么做）

Web v1 含编辑。当**两个 web session**、或 **web 与桌面**同账号先后写同一笔记时，后写会静默覆盖先写、丢数据。
B2 给 **web 编辑器的保存路径**加乐观并发（CAS）：保存带基线版本，服务端版本变了就 409，
web 拉远端 + 让用户选「用我的覆盖 / 放弃加载远端 / 取消」。

**保护模型（明确取舍，回应审阅 #3）**：
- B2 **只保护 web 编辑器的 `saveNote` 路径**。受检写 = web 作为**后写者**时会收到 409 并弹窗，不会静默覆盖。
- **桌面保存不变**（仍 last-write-wins，不带 `expected_updated_at`）。因此「桌面作为后写者覆盖 web」仍可能发生，
  交给既有 sync / `conflict_record`（LWW + 冲突可见）兜底——这是刻意取舍，不在 B2 改桌面。
- 不是「同一笔记任何写入口都不丢」。其它 web 写入口（见下「越过 CAS 的写入口」）暂不纳入 CAS。

**关键调查结论（决定本片范围）**：
- daemon/core **已端到端实现 CAS**：`PATCH/PUT/DELETE/restore` 都收 `expected_updated_at`（ms number）；
  `updateNote` 对 `existing.updatedAt.getTime()` 严格相等校验，不匹配抛 `VersionMismatchError` → 路由 409 `VERSION_MISMATCH` + `details:{expected,current}`
  （`packages/daemon/src/routes/notes.ts:140-177`、`packages/core/src/notes/index.ts:373-378`、`errors.ts`）。
- 唯一 wire 缺口：`packages/shared/src/client.ts:64` 的 `patchNote()` 没传 `expected_updated_at`。
- **ms 对齐无需改 wire**：`Note.updatedAt` 是 ISO string（带 3 位毫秒），`new Date(s).getTime()` 与库里 INTEGER ms 无损往返
  （daemon 自己的 `server.test.ts` 就这么取基线）。→ **不新增 `updated_at_ms` 字段**（推翻 §7 #6 初步倾向）。

## 决策（已拍板 2026-06-16）

1. **ms 基线 = 从 ISO 派生**（`new Date(note.updatedAt).getTime()`）。不动 wire/core/daemon，仅 `client.ts` 加可选参数。
2. **CAS 仅 web**（platform `remoteClient` 门）。桌面 save 路径字节级不变 → 严格零回归。
3. **取消自动保存**（v2 改）。web 与桌面一致：**手动保存**（Cmd+S）。
   防丢草稿改用 **web 脏 tab `beforeunload` 刷新保护**（v3 确认锁定）：有未保存 tab 时刷新/关页弹浏览器原生「离开?」提示。
   仅 web，等价桌面退出时的 `UnsavedTabsDialog`，**不做后台保存** → 不引入 in-flight 竞态。

## 改动（按层）

### 1) shared（唯一回流后端的改动）
- `packages/shared/src/client.ts` — `patchNote(id, data)` 的 `data` 类型加 `expected_updated_at?: number`（带注释：缺省 = LWW = 桌面现行为）。
  `editTagOnNote` 不动（见「越过 CAS 的写入口」）。

### 2) platform adapter（web-only 门，仅门 CAS）
- `platform/types.ts` — `PlatformAdapter` 加 `readonly remoteClient: boolean`（注释：网络瘦客户端 web=true → 乐观并发保存 + beforeunload 守卫；Electron=false）。
- `platform/web.ts` — `remoteClient: true`；`platform/electron.ts` — `remoteClient: false`。

### 3) editor-store（基线追踪 + 409 状态机；renderer 内部，桌面行为不变）
`packages/gui/src/renderer/src/stores/editor-store.ts`：
- `TabState` 加 `originalUpdatedAt: string`（load / 上次保存的 ISO updatedAt 基线；draft 为 `''`）。桌面也追踪但 save 不读 → inert。
- 设基线点：`openNote`（新开 + 刷新两分支，L236-309）、`replaceTabAfterCreate`（L654）。
  **`applyNoteAppliedFromAi`（L567）不动**（回应审阅 #2）：其入参只有 `(noteId, latestDbContent, appendedText)`，
  `note_applied` SSE payload 也只有 `note_id/content/appended_text`（`daemon/ai/tool-registry.ts:40`），拿不到新 `updated_at`；
  扩 payload 带 `updated_at` 就破了「唯一回流 shared」。→ 该路径后 `originalUpdatedAt` 会 stale，下次编辑器保存安全 409（见「越过 CAS」）。
- **`syncTabFolderId(noteId, folderId, updatedAt?)` 加可选第 3 参**（回应审阅 #5）：拖拽 move 会 bump 服务端 `updated_at`
  （`daemon/routes/folders.ts` → `updateNote`），不 rebase 则 web 拖拽后再保存会 **409 自己**。move 调用方传回 `res.data.updatedAt`。
- `markSaved(noteId, content, tags, updatedAt?)` 加可选第 4 参，刷新 `originalUpdatedAt`（`?? t.originalUpdatedAt`）。
- `saveNote`（L400-451）Branch 2/3 PATCH：`getPlatform().remoteClient` && `tab.originalUpdatedAt` 非空时带
  `expected_updated_at: new Date(tab.originalUpdatedAt).getTime()`；成功用 `res.data.updatedAt` 刷新基线。桌面不传 → 与今日一致。
- `catch` 收紧（回应审阅 #6）：
  `if (getPlatform().remoteClient && err instanceof ApiError && err.status === 409 && err.errorCode === 'VERSION_MISMATCH')`
  → `try { remote = await api.getNote(noteId) } catch { return false }`；`remote?.data` 有则置 `versionConflict`、`return false`；
  否则 `return false`。其它错（含其它 409 码如 `ALREADY_TRASHED`）走原 `return false`，不当版本冲突。
- 新增 state `versionConflict: { tabId; remote: Note } | null` + 动作 `resolveVersionConflict('overwrite'|'load-remote'|'dismiss')`
  （每个分支都清 `versionConflict`，回应审阅 #4）：
  - `overwrite`：把 tab 基线换成 `remote.updatedAt` 后重存（仍受检；再 409 则重弹）。
  - `load-remote`：用 remote 覆盖 tab（content/tags/folderId + 全 baseline + `originalUpdatedAt=remote.updatedAt` + dirty=false + **清 `pendingAiUpdate`**）。
  - `dismiss`：保留本地继续编辑。
- **`closeTab`（L311）补清 `versionConflict`**（回应审阅 #4）：若 `versionConflict?.tabId === noteId` 则一并置 null，避免弹窗状态悬空。
- import `getPlatform`（`@/platform`）、`ApiError`（经 `@/lib/api`）。

### 4) MainApp move 调用方（回应审阅 #5）
- `MainApp.tsx:204/213/226` 三处：`const res = await moveNoteToFolder(...)` 后
  `syncTabFolderId(drag.noteId, folderId, res.data?.updatedAt)`。

### 5) 409 冲突对话框（新组件）
- `components/editor/VersionConflictDialog.tsx`：读 `versionConflict`，复用 `components/ui/dialog` + `components/ai/diff/DiffView`
  （props `{original, modified, originalLabel, modifiedLabel}`，左=本地 `tab.content` / 右=`remote.content`）。
  三按钮分派 `resolveVersionConflict`。挂载：`MainApp.tsx:419` `<ConflictDialog />` 旁加 `<VersionConflictDialog />`。

### 6) Web 防丢草稿（替代自动保存，回应审阅 #1/#2；v3 锁定）
- `hooks/useWebUnloadGuard.ts`：`getPlatform().remoteClient` 否则 no-op。`window.addEventListener('beforeunload', …)`，
  `useEditorStore.getState().hasUnsavedTabs()` 为真时 `e.preventDefault(); e.returnValue = ''`（兼容性更稳，触发浏览器原生「离开?」提示）。卸载时移除监听。
- **挂载位置写死 `App.tsx`**（`App()` 顶层、无条件调用，在 `startupMode` / `requiresAuth` 分支之前；回应审阅 #1）：
  `App()` 是会话根、永不卸载。**不可挂 `MainApp`**——token 过期 / 401 后 `WebAuthGate` 回登录页会卸载 `MainApp`，
  但 dirty tabs 仍在 store 里，挂 `MainApp` 会连刷新保护一起丢。等价桌面 `UnsavedTabsDialog` 退出守卫；**不做后台保存**，无 in-flight 竞态。

## 越过 CAS 的写入口（明确 out of scope，回应审阅 #4）

B2 **只**给主编辑器 `saveNote` 上 CAS。下列写入口仍不带 `expected_updated_at`，本片不纳入：
- `editTagOnNote`（`client.ts:212`）：带旧 content 直 PATCH。**不经编辑器保存路径**；web 若暴露单标签编辑，旧 content 可能覆盖远端正文。
  → 标注已知限制，留后续（可改为只 patch tags / 或带 CAS）。
- AI 直接批准 PATCH（`stores/ai-store.ts:489`）：不带 CAS。web 复用 `MainApp`，AI nav + `/ai` route **无条件存在**
  （`MainApp.tsx:68/405`）→ web 用户**可达** AIPage（回应审阅 #3）。结论：**即使 web 可到达 AIPage，AI 直接批准不纳入 B2 CAS**（不说「web 不触发」）。
- AI append 副作用 `applyNoteAppliedFromAi`（`append_memo`/`append_note`）：见 §3，payload 无 `updated_at`，本片不 rebase 基线。
- toggle-todo（`daemon/routes/todos.ts:123`）：daemon 端直接改 content，不经客户端 CAS。
- 副作用：上述任一改了某笔记后，若该笔记的 web 编辑器 tab 已打开，则其 `originalUpdatedAt` 变 stale → 下次编辑器保存会 **409**。
  这是**安全失败**（弹窗让用户拉远端/选择），非静默丢失，可接受。folder-drag 例外已在 #3/#5 主动 rebase 避免自我 409。

## 已知 / 不在本片

- **`markSaved` 在 in-flight 期间被新输入打断**（审阅 #1）：取消自动保存后回到既有「极少见的手动保存窗口」问题，
  B2 不引入、不放大。可选的「保存快照一致性」硬化留后续，不在 B2。
- `updated_at_ms` wire 字段（调查证明无需）；桌面 CAS / 桌面自动保存（保持现状）；
  自动保存（本片取消）；W7 双向合并编辑器（0.6）；B3（XSS/CSP）、B4（daemon 静态托管）。

## 测试

- **gui `editor-store.test.ts`**（drive store + stub `fetch`，`vi.mock('@/platform')` 控 `remoteClient`）：
  - remoteClient=true：保存 PATCH body 含 `expected_updated_at`（查 fetch 参数）；200 刷新 `originalUpdatedAt`。
  - 409 `VERSION_MISMATCH`（fetch 返 status 409 + `{success:false,error_code:'VERSION_MISMATCH'}`）→ getNote 返 remote → `versionConflict` 置位、未 markSaved、返 false。
  - getNote **失败**时返 false、不抛、不置 versionConflict。
  - 其它 409 码（如 `ALREADY_TRASHED`）**不**当版本冲突。
  - `resolveVersionConflict('overwrite')` 用新基线重存；`'load-remote'` tab 被 remote 覆盖且 dirty=false；`'dismiss'` 清状态保留本地。
  - **remoteClient=false（桌面回归）**：保存 PATCH body **不含** `expected_updated_at`；409 路径不触发。
  - `openNote` 存 `originalUpdatedAt`；`markSaved(…, updatedAt)` / `syncTabFolderId(…, updatedAt)` 刷新它。
  - `closeTab` 清掉指向该 tab 的 `versionConflict`。
- **gui `useWebUnloadGuard.test.tsx`**（新，回应审阅 #5；`vi.mock('@/platform')` 控 `remoteClient`）：
  remoteClient=true + 有 dirty tab → `beforeunload` 被 `preventDefault`（`returnValue` 被设）；clean → 不阻止；
  remoteClient=false → 不阻止（且不挂 listener）；卸载后 listener 被移除。
- `just check`（9 守卫 + biome + tsc -b）+ `pnpm -r build`（shared 改了）+ gui vitest + daemon/core 跑一遍兜底。基线 gui **418**。

## 手动验证（复用 B1 云端 rig：skybridge :8443 + cloud daemon :47020 + vite :5274）

1. 两个 web tab 同账号开同一笔记 → A 改+Cmd+S → B 改+Cmd+S → B 弹冲突对话框（diff 本地 vs 远端）；三按钮各验。
2. **folder-drag 自我 409 不复现**：web 把已打开的笔记拖到别的文件夹 → 再改内容 Cmd+S → **不** 409（基线已 rebase）。
3. **防丢草稿**：web tab 有未保存编辑 → 刷新/关页 → 浏览器弹「离开?」提示。
4. **桌面零回归**：`just dev` 桌面端编辑保存正常；日志/抓包确认 PATCH body **无** `expected_updated_at`；无 beforeunload 提示（Electron 自有退出守卫）。

## 零回归护栏

- 桌面 PATCH 字节级不变：`expected_updated_at` 仅在 `remoteClient` 分支拼入；`originalUpdatedAt` 桌面追踪但不读。
- `markSaved` / `syncTabFolderId` 加可选参 = 现有调用方不破。
- `saveNote` catch 由「吞所有」改为「web + 409 + VERSION_MISMATCH 特判 + 其余仍 return false」——非该路径行为不变。
- beforeunload 仅 `remoteClient`，桌面 no-op。

## 实施记录（2026-06-16，全绿，未 commit）

**改动文件**（按层）：
- **shared** `client.ts`：`patchNote` data 加可选 `expected_updated_at?: number`（纯增量）。
- **platform** `types.ts`(+`remoteClient: boolean`)/`web.ts`(true)/`electron.ts`(false)。
- **editor-store** `stores/editor-store.ts`：`TabState.originalUpdatedAt`；`VersionConflict` 类型 + state `versionConflict` + `resolveVersionConflict('overwrite'|'load-remote'|'dismiss')`；
  `openNote`/`replaceTabAfterCreate`/`openAiDraft`('') 设基线（`applyNoteAppliedFromAi` **不动**）；`syncTabFolderId(+updatedAt?)`、`markSaved(+updatedAt?)` 加可选参刷新基线；
  `closeTab` 清指向自身的 `versionConflict`；`saveNote` 经 `casBaseline()` 带 CAS、catch 经 `versionConflictFromError()` 收 409；
  **顺手 DRY**：合并原 Branch2/3（AI-staged 与 ordinary PATCH 字节相同）+ 抽 `saveDraft()`/`casBaseline()`/`versionConflictFromError()`，`saveNote` 复杂度回 <15。
- **dialog** 新 `components/editor/VersionConflictDialog.tsx`（复用 `ui/dialog`+`ai/diff/DiffView`，三按钮 + 查看差异），挂 `MainApp.tsx` `<ConflictDialog>` 旁。
- **MainApp** 3 处 move：`moveNoteToFolder` 返回 `res.data?.updatedAt` 传入 `syncTabFolderId`（防自我 409）。
- **unload guard** 新 `hooks/useWebUnloadGuard.ts`（`beforeunload` + `preventDefault()`+`returnValue=''`，仅 `remoteClient`），挂 `App.tsx` 顶层（会话根，越 WebAuthGate↔MainApp）。
- **测试**：`editor-store.test.ts` +12（web 带参/桌面不带/409 拉远端/409 拉失败/非 VM 409/三 resolve/基线/closeTab×2）；新 `useWebUnloadGuard.test.tsx` +4。

**验证**：`just check`（9 守卫+biome+`tsc -b`）✓ · `pnpm -r build`+web build ✓ · gui **434**(+16) / daemon 394 / core 529 / cli 137 全绿。桌面端零回归（CAS/guard 均 `remoteClient` 门）。

**测试踩坑**：本文件原有测试用 `vi.spyOn(api,'patchNote')` 且**无 `restoreMocks`** → spy 泄漏到后续测试（隔离跑过、全量跑挂的元凶）。修法：照同文件 `requestSaveOrConflict` describe 的成例，每个 B2 describe `beforeEach` 加 `vi.restoreAllMocks()` + 用 `vi.spyOn(api,…)`（**不要**自建 fetch stub 去对抗 transport 全局 fetch）。`new api.ApiError(409,'VERSION_MISMATCH',…)` 触发 409 路径。

**待办**：①用户浏览器手测（清单见下/会话）②commit（未提交，含本 doc + PROCESS.md）。B3（XSS/CSP）、B4（静态托管）后续。
