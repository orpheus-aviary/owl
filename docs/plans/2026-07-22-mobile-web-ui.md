# owl 移动端兼容 web UI（Stage 1 #5）设计稿 — v7（定稿）

> 状态：**规划 v7 —— 定稿，实施就绪**，起草 2026-07-22。整体架构自 v6 不变；本轮补齐 4 个协议边界 + 5 个实现细节，避免实现期「静默丢 AI 更新 / 旧 intent 抢导航 / 跨会话串状态」。
> v6→v7：**①AI update 的 `prepare` 补 `openNote(found)`**（`loadNoteById` 只加载不写 store；`stageAiUpdate` 对未打开 tab 静默 no-op，`editor-store:530`）；**②last-wins 覆盖异步 `prepare`/`saving`**（导航级 `navSeq` + `isCurrent()`，每 await 后复核、旧 Promise 结算 `cancelled`、`discard` 在 target prepare 成功后再关当前脏 tab）；**③`SaveResult` 改判别联合**（`saved|noop|conflict|failed|cancelled`，让 note-nav guard 无歧义区分冲突与失败，`dismiss` 不再伪装成功）；**④note-nav-guard/alias/mobileMode/在途 Promise 全进 `resetAllStores`**（`reset.ts:32`）；**⑤实现细则**：TopBar 用 `locationRef.current`/nav token 非旧闭包 · alias 按 session 有限生命周期 · 脏删除经统一 open intent（写 `canPop/returnTo`）· **桌面分支规范条款**（`!isMobile` 保持 `openNoteById+navigate('/')`、不启用移动 guard，AI `prepare` 仍跑但 Electron 路由/tab 不变）· `OpenOutcome='opened'` = **导航已提交**（非普通笔记加载成功，后者仍由 EditorPage 展示错误）。
> **路线源** = `2026-07-04-road-to-1.0.0.md` §2 #5；状态以 `PROCESS.md` 为准。前置：`2026-06-06-mobile-web-ecosystem-arch.md`（§4/§5/§9/§13）、Phase B（B0–B4）。

---

## 0. 拍板决策
| # | 决策 | 结论 |
|---|------|------|
| 1 架构 | 断点切壳 + 复用叶子 | `useIsMobile=remoteClient&&width<768`（Electron `minWidth=600` 不改，恒桌面壳）。 |
| 2 导航壳 | 底栏(`shrink-0`)+文件夹抽屉 | 底栏主 5+更多；详情页无抽屉钮；Sheet 随 location 统一关。 |
| 3 编辑器 | 编辑⇄预览 + 浮动 TagBar | `mobileMode` 独立默认 `edit`；切换在 TopBar；仅 TagBar 浮动(+ResizeObserver 流内占位)。 |
| 4 PWA | 交付安装元数据 | manifest(+id/scope)+图标+meta；本轮不测安装；真安装验收 Stage 2。 |
| A1 导航契约 | `OpenNoteIntent{noteId,prepare}`→`Promise<OpenOutcome>` + `navSeq` | §4.1；桌面分支保原行为（§4.1.0）。 |
| A2 tab 模型 | preview 语义 + 脏→note-nav guard(`isUnsaved`) | §4.1.5/5a；编辑过 tab 保留（可接受）。 |
| A3 保存链 | `SaveResult` 判别联合贯穿全 save 家族 | §4.1.6。 |
| A4 session reset | note-nav-guard/alias/mobileMode/在途 Promise 进 `resetAllStores` | §4.1.7。 |
| A（拍板） | 返回落点 | 自然来源页（`canPop`/`returnTo`）。 |
| B（拍板） | 浮动 TagBar | 做（代码+单测），真软键盘验证延后。 |

---

## 1. 现状勘查（关键坑）
web 版=桌面 renderer 逐字节，桌面取向（64px 竖 nav+三层 resizable；`overflow:hidden`+`h-screen`；hover/右键）。坑：
- `openNoteById`（`:680`）fetch 后**直接写 store**；散落 ~10 入口（§4.1.4）。`ApiError` 带 `.status`（`transport.ts:9`）。
- AI 草稿 `draft_*` **只在 store**（`MessageBubble:50`）；`MessageBubble:25` 先写 store+markDraftOpened 再 navigate。**`stageAiUpdate`（`:530`）只 map 已存在 tab → 未打开时静默 no-op。**
- **`saveNote`（`:298`）被 `saveActiveNote`(`:335`)/`resolveVersionConflict('overwrite')`(`:385`)/`requestSaveOrConflict`(`:398`,冲突时返 false)/`resolveConflict`(`:463`)/`saveDraft`/`handleSaveFailure` 链式返回**；真 id 在 `replaceTabAfterCreate` store 内替换（`:596`）。`isUnsaved(tab)` 已存在（`:304`）；`markSaved` 保 `preview:false`。
- `if(ok)` 外部调用方：`UnsavedTabsDialog:92`/`switch-guard:74`/`EditorPage:40`/`VersionConflictDialog`/`ConflictDialog`；`useEditorShortcuts:23`(void)。
- **`resetAllStores`（`reset.ts:32`）= 会话 teardown 唯一所有者**，逐 store `reset()`（不知新 guard/alias/mobileMode）。
- `mode` 持久（`bootstrap.ts:31`）。`MergeView.orientation` 仅 `a-b|b-a`；`ConflictMergeDialog` 与 AI/Version `DiffView:53` 都并排 MergeView。冲突 API：`resolveConflict` 仅 `local|merged`，保留当前胜出走 `ignoreConflict`（`client.ts:208`），无 `remote`。
- `DateTimePicker` fixed 子（`:84`）、TagBar 建议 absolute 子（`:421`），非 portal。`SyncStatusBar` 含 `<Link>`→Settings（`:197`）。`DeleteConfirmDialog` 脏分支先 `setActiveTab`+`navigate('/')` 再弹确认（`:89`）。

---

## 2. 架构
### 2.1 `useIsMobile` `remoteClient && matchMedia('(max-width:767.98px)')`（`useSyncExternalStore`）。Electron 恒桌面壳，`minWidth=600` 不动。
### 2.2 切壳 `MainApp` 内 `useIsMobile()?<MobileShell>:<DesktopShell>`，内容槽都渲 `<AppRoutes/>`(+`/note/:noteId`)。`DesktopShell` 吸收面板 hooks（`panelOpen`/`usePanelRef`/`useOwlLayout`/折叠 effect）。留 `MainApp` 的仅 `onProfileSwitched`+DndContext+弹窗。

---

## 3. 移动导航
### 3.1 `MobileShell` `h-dvh`；`[☰ 标题 ctx]`/`<AppRoutes/>`(flex-1 min-h-0 **overflow-hidden**，页面各自唯一滚动)/BottomNav(`shrink-0` flex 子)。detail 路由隐藏底栏。
### 3.2 `MobileBottomNav` 主 5（编辑`/`/浏览/提醒/待办/更多 sheet）；编辑 tab 在 `/`||`/note/*` active；≥44px+`aria-current`；冲突进更多+badge。
### 3.3 `MobileTopBar` normal=`☰`+标题；detail=**←**+标题+模式切换+**保存**，无 `☰`。Browser 搜索/筛选留页内。
### 3.4 `Sheet`(radix Dialog 侧滑) + **Shell `useEffect([location])→关所有 Sheet/抽屉**（覆盖抽屉内 Settings `<Link>` 等）。
### 3.5 `FolderPanel` 加 `variant`+`onOpenNote`（drawer 单击开→`useOpenNote`→关抽屉；独立拖拽手柄；触摸尺寸）。`SyncStatusBar` 加 `variant`（整行+弹层 `side="top"`，抽屉底部）。

---

## 4. 页面改造

### 4.1 导航契约（本轮核心）

#### 4.1.0 契约总览 + 桌面分支规范（写清 d）
```ts
type OpenOutcome = 'opened' | 'cancelled' | 'failed';           // 'opened' = 导航已提交（非普通笔记加载成功）
type PrepareResult = 'ok' | 'not-found' | 'stale' | 'failed';
interface OpenNoteIntent {
  noteId: string;
  prepare?: (ctx: { isCurrent: () => boolean }) => Promise<PrepareResult> | PrepareResult;  // 仅守卫通过后执行
}
useOpenNote(): (intent: OpenNoteIntent) => Promise<OpenOutcome>;
```
- **桌面（`!isMobile`）规范**：**不启用移动 note-nav guard**；`intent.prepare` 仍执行（`isCurrent=()=>!isStale(gen)`），之后 `!prepare` 时 `openNoteById(noteId)`、统一 `navigate('/')`——**Electron 路由/tab 行为与现状逐字节一致**。移动分支才走 §4.1.1–4.1.6。

#### 4.1.1 打开 effect（移动）：token 覆盖卸载 + 空 id + 重试
```ts
useEffect(() => {
  const token = ++requestToken.current;                 // 递增即失效所有在途
  if (!noteId) return () => { requestToken.current++; }; // 空 id：失效 + return，不调 resolveOpen(undefined)
  let cancelled = false;
  void resolveOpen(noteId).then((r) => {
    if (cancelled || token !== requestToken.current) return;   // 唯一提交闸（非闭包 params 比较）
    commit(r);
  });
  return () => { cancelled = true; requestToken.current++; };
}, [noteId, retryNonce]);   // retryNonce：加载失败「重试」触发重跑
```

#### 4.1.2 `loadNoteById` 判别联合（只加载、不写 store）
```ts
type LoadNoteResult = { status:'found'; note:Note } | { status:'not-found' } | { status:'stale' };
```
gen 变→`stale`。`catch(e){ if(e instanceof ApiError && e.status===404) return {status:'not-found'}; throw e }`——**仅 404 报「不存在」**；401/网络重抛+**200 缺 `data`=协议错误抛出**→「加载失败·重试」。解析定序：**store 有 id tab/draft→`setActiveTab`**（不重载、保脏基线、`draft_*` 命中）；无→`loadNoteById`→found=`openNote(preview)`/not-found=空态/stale=丢弃。

#### 4.1.3 返回：`canPop`（写清 a 见 §4.1.6）
```ts
navigate(`/note/${id}`, { replace:isDetail, state:{ appNavigation:true,
  canPop: isDetail?(cur.state?.canPop??false):true, returnTo: isDetail?(cur.state?.returnTo??'/'):cur.pathname+cur.search }});
```
顶栏 ← = `state?.canPop ? navigate(-1) : navigate(state?.returnTo??'/', {replace:true})`。冷启/detail→detail 继承 `canPop:false` 不退出、无重复历史项。硬件 back=原生 pop。

#### 4.1.4 每入口移动目标
| 入口 | 移动 |
|---|---|
| FolderPanel:155 / Browser:110 / Reminders:76 / Todo:209 / Conflicts:202 / NoteIdPill:52 / NoteList | `open({noteId})`→`/note/:id`（preview） |
| AI `MessageBubble`:59 | `open({noteId, prepare})`（§4.1.5a AI prepare）；**仅 `outcome==='opened'` 后 mark/dismiss/close** |
| `NoteAppliedToast`:69 | `open({noteId})`→`/note/:id` |
| `DeleteConfirmDialog`:89 **非脏** | 删除后**留来源页**（Browser 删留 Browser，不跳 `/`） |
| `DeleteConfirmDialog`:89 **脏** | **经 `open({noteId})` 进详情**（写 `canPop/returnTo`，非裸 navigate）；`outcome==='opened'` 后弹确认；确认删成功 `replace('/')`（非 push） |
| `events-subscriber-core`:82 SSE | `EventHandlers.openNote(intent)`，`EventsSubscriber` 注入 `useOpenNote()` |
| `useEditorShortcuts`:34 键盘 | 注入 opener（桌面为主） |

#### 4.1.5 tab 模型：preview 语义 + 累积说明
移动路由新加载普通笔记用 **`openNote(note,{preview:true})`**：干净 preview 槽自动替换（clean 不累积）；编辑即 pin 保脏。⚠️ `markSaved` 保 `preview:false`→**编辑并保存过的 tab 会在移动后台留存**（有限累积）：**接受**，作桌面断点恢复 + 会话末 `UnsavedTabsDialog` 兜底；不误关桌面继承 pinned tab。（备选「只关 mobile-owned 已保存 tab」= ownership 记账，本轮不做，§12。）

#### 4.1.5a note-navigation guard：intent + navSeq（写清 b/c/e，review #1/#2）
`stores/note-nav-guard.ts`（新建，**不复用 profile 级 `switch-guard`/仅 UI 的 `UnsavedDialog`**）。持 `navSeq`（导航级序号）：
```
open(intent):
  const mySeq = ++navSeq;  结算任何旧 pending/preparing Promise 为 'cancelled'      // last-wins 覆盖 pending+preparing
  !isUnsaved(current) → runOpen(intent, mySeq)                                      // isUnsaved 含 pendingAiUpdate，非仅 dirty
  isUnsaved(current)  → pending(intent) 弹 save/discard/cancel：
    save    → saving → r=await requestSaveOrConflict(current)（§4.1.6）
                       mySeq!==navSeq → 'cancelled'
                       r.status 'saved'|'noop' → runOpen(intent, mySeq)
                       'conflict' → 暂停导航（version/AI 冲突弹窗接手）→ 'cancelled'（用户解决后再 open）
                       'failed'   → save-failed（留 pending）
    discard → runOpen(intent, mySeq, { closeAfterPrepareOk: current.noteId })       // 见下：prepare 成功后才关脏 tab
    cancel  → idle → 'cancelled'

runOpen(intent, mySeq, opts?):
  preparing
  if (intent.prepare) {
    const pr = await intent.prepare({ isCurrent: () => navSeq===mySeq });           // prepare 内每 await 后自查 isCurrent 才写 store
    if (navSeq!==mySeq) return 'cancelled';
    if (pr!=='ok') return pr==='failed'?'failed':'cancelled';                       // not-found/stale/failed → 不导航、不 mark
  }
  if (opts?.closeAfterPrepareOk) closeTab(opts.closeAfterPrepareOk);                // discard：目标 prepare 成功后再关当前脏 tab（失败则不丢当前）
  navigate(`/note/${intent.noteId}`, …§4.1.3…); idle; return 'opened'
```
- **AI `prepare`**（补 `openNote(found)`，review #1）：
  ```
  create → ({isCurrent}) => { editor.openAiDraft(draft); return 'ok'; }             // 纯 store，恒 ok；EditorPage 靠 store-first setActiveTab
  update → async ({isCurrent}) => {
    if (editor.tabs.some(t=>t.noteId===noteId)) { editor.stageAiUpdate(noteId,payload); return 'ok'; }
    const r = await loadNoteById(noteId); if(!isCurrent()) return 'stale';
    if (r.status!=='found') return r.status;                                        // not-found/stale
    editor.openNote(r.note); editor.stageAiUpdate(noteId,payload); return 'ok';     // ★先 openNote(found) 再 stage，避免静默 no-op
  }
  ```
- 调用方 `await open(...)==='opened'` 才 `markDraftOpened`/toast dismiss/sheet close；`cancelled/failed` 不产生副作用。
- `OpenOutcome='opened'` = **导航已提交**，非普通笔记加载成功（普通笔记 not-found/加载失败由 EditorPage §4.1.2 展示）。
- 硬件 back 离开脏笔记不拦截（HashRouter 非 data-router）→ 脏 tab 留内存不丢，`UnsavedTabsDialog`/`useWebUnloadGuard` 兜底。

#### 4.1.6 保存链 `SaveResult` 判别联合（review #3）+ 保存-返回竞态（写清 a/b）
```ts
type SaveResult =
  | { status:'saved'|'noop';               ok:true;  noteId:string|null }   // saved=已写；noop=无需保存/已解析为干净
  | { status:'conflict'|'failed'|'cancelled'; ok:false; noteId:string|null }; // conflict=已弹冲突；failed=真失败；cancelled=用户留守
```
- **贯穿全家族**：`saveDraft`(拿 create id)→`saveNote`(unsaved 假=`noop`;成功=`saved`;`handleSaveFailure`=`failed`)→`saveActiveNote`→`resolveVersionConflict`(dismiss=`cancelled`留脏 / load-remote=`noop`干净 / overwrite=saveNote)→`requestSaveOrConflict`(冲突弹窗=`conflict` 替原 false)→`resolveConflict`(→saveNote)。**guard 读：`saved|noop`→导航；`conflict`→暂停；`failed`→save-failed；`cancelled`→留守。**
- 外部调用方迁 `result.ok`：`UnsavedTabsDialog:92`、`switch-guard:74`(`map(r=>r.ok)`)、`EditorPage:40`、`VersionConflictDialog`、`ConflictDialog`。**`ok:false` 是真值，`if(ok)` 必换 `if(result.ok)`**。`dismiss` 现为 `cancelled` 不再伪装成功。
- **EditorPage 保存后关 tab 用 `result.noteId`**（非旧 `draft_*`）。
- **保存-返回竞态（写清 a）**：TopBar 保存 `const original=routeNoteIdRef.current; const r=await requestSaveOrConflict(original);` 之后**用 `locationRef.current`（随 render 更新，非 await 前 `cur` 闭包）** 判当前路由仍 `original` 才 `navigate('/note/'+r.noteId,{replace:true,state:locationRef.current.state})`；已离开→只更 store 不导航。
- **`draftId→realId` alias（写清 b）**：保存登记；`EditorPage` 命中 stale `draft_*` URL（forward/旧历史）→canonical `replace` 到真 id **后即删该 alias**；**alias 表按 session 存活、`resetAllStores` 清空**（§4.1.7），仅当前 session、有限增长。

#### 4.1.7 session reset 集成（review #4）
`resetAllStores`（`reset.ts:32`）新增：`useNoteNavGuard.getState().reset()`（**`++navSeq` 使 preparing/pending intent 失效、其 Promise 结算 `cancelled`**）；`editor-store.reset()` 追加清 **`mobileMode`** + **`draftId→realId` alias 表**。→ 切账号时：取消 preparing intent、结算 pending Promise、清 alias、清 mobileMode、**旧 `prepare` 不会在新账号 stage/navigate**（`isCurrent()` 失败）。touched：`reset.ts`+`reset.test.ts`（测「pending/preparing 时切 session」）。

### 4.2 `EditorPanel` → 编辑⇄预览 + 浮动 TagBar
`mobileMode` 独立不持久默认 `edit`；`effectiveMode=isMobile?mobileMode:mode`；移动 Toggle 只写 `mobileMode`，**不碰持久 `mode`/`cycleMode`**（无 split→preview 映射）。浮动 TagBar：`useKeyboardInset`（`visualViewport`，**inset 仅在「编辑/标签输入获焦 且 `vv.scale≈1` 容差」**否则 0）；TagBar `position:fixed; bottom:<inset>`，**祖先无 transform**；**ResizeObserver 流内占位**；**校验 `DateTimePicker` 日历落 visual viewport（fixed 按 `getBoundingClientRect` 需校正）**。模式切换在 TopBar。无 vv 退化普通底栏。真软键盘本轮测不了（§11）。

### 4.3 `SettingsPage`+`LoginForm` 单栏+section 切换器；**隐藏 tab URL 重定向有效 tab**；**LLM key 在 `CustomSection` 内→`hideSecrets` prop 条件渲染**；固定宽整改（`LoginForm` 输入区 + `settings/SettingRow.tsx` + `CustomSection` 私有 `SettingRow` 两处→`w-full`/竖排）。
### 4.4 `AIPage` 聊天全屏+会话列表 sheet；草稿走 §4.1（intent.prepare + draft→real alias/保 state）。
### 4.5 冲突 UI（**不做 MergeView 竖排**）
`ConflictMergeDialog` 与 AI/Version `DiffView:53` 都并排 MergeView → 移动全走**独立只读 fallback（非 CSS）**：本地/远端只读对比 + **「采用本地 / 保留当前版本」**；手工→独立单栏「最终结果」编辑区。**「保留当前版本」=`ignoreConflict`**（语义=保留当前胜出版，不保证等于 remote payload，避免 `losing_side='remote'` 歧义）；「采用本地」=`resolveConflict('local')`；手工=`resolveConflict('merged',最终结果)`。`ConflictsPage` 双栏→堆叠。独立 commit。
### 4.6 其余列表页 Browser action bar 换行(留页内)；`⋯` 常显；44px；无 bottom padding。

---

## 5. 触摸 & 视觉
≥44px/`size-5`；`h-dvh`+safe-area+`viewport-fit=cover`；滚动归页面。**`TouchSensor` 限域**：Browser 行不挂 drag，文件夹整理仅抽屉独立手柄（`delay:200,tolerance:8`）。常显 `⋯` 替 hover/右键。恒暗。

## 6. PWA（交付安装元数据，无 SW，本轮不测安装）
manifest（+`id`/`scope`/standalone/图标 192/512/512-maskable/暗色）；图标源 `resources/owl-logo-original.png`，`scripts/build-pwa-icons.mjs`(`sips`) 产物**入 git、手动 macOS 跑、绝不进 `build-server`**；`index.html` 加 manifest/theme-color/apple-touch-icon；删「无 SW⇒Android 手动」因果；安装后冷启重登接受；CSP 核对 `manifest-src`（Phase 2）。**本轮=交付元数据；真安装验收（HTTPS/A2HS）留 Stage 2。**

## 7. 断点判定 `isMobile=remoteClient&&<768`；跨断点 tab/dirty 不丢、`/note/:id` 保留；与 `key={epoch}` 正交。
## 8. 明确不做 离线/SW/缓存；真机/真安装/Lighthouse；RN/跨 profile；移动 LLM Key(`hideSecrets`)/快捷键设置；Electron 移动化；通用 TopBar slot；新持久登录。

---

## 9. 触及面
| 文件 | 改动 |
|---|---|
| `hooks/{useIsMobile,useOpenNote,useKeyboardInset}.ts`、`stores/note-nav-guard.ts` | 新（`useOpenNote`=intent/Outcome/navSeq；桌面分支保原行为） |
| `components/ui/sheet.tsx`、`components/mobile/{MobileShell,MobileTopBar,MobileBottomNav,FolderDrawer}.tsx` | 新 |
| `stores/editor-store.ts` | `loadNoteById`(判别联合)、`mobileMode`、**`SaveResult` 判别联合贯穿 `saveDraft/saveNote/saveActiveNote/resolveVersionConflict/requestSaveOrConflict/resolveConflict/handleSaveFailure`**、`draftId→realId` alias、`reset()` 清 mobileMode+alias |
| `stores/reset.ts`(+`reset.test.ts`) | **加 `note-nav-guard.reset()`；测 pending/preparing 时切 session** |
| 保存返回类型迁移：`UnsavedTabsDialog:92`/`switch-guard:74`/`EditorPage:40`/`VersionConflictDialog`/`ConflictDialog`（`result.ok`）+ 测试 | 改 |
| `MainApp.tsx` | AppRoutes(+/note/:id)+分壳+面板 hooks 移 DesktopShell+DndContext 提层+限域 TouchSensor |
| `EditorPage.tsx` | master-detail（token 覆盖卸载+空 id+retryNonce+解析定序+`canPop`+preview+note-nav guard+not-found/加载失败+alias 解析+关 `result.noteId`+`locationRef`） |
| `EditorPanel.tsx` | `mobileMode`/`effectiveMode`+浮动 TagBar+ResizeObserver 占位 |
| 打开入口(§4.1.4)+`events-subscriber-core`/`EventsSubscriber`/`useEditorShortcuts`+`MessageBubble`(prepare 化) | intent 迁移 |
| `FolderPanel`/`SyncStatusBar`(variant)、`SettingsPage`/`CustomSection`(hideSecrets)/`SettingRow`(×2)/`LoginForm`/`AIPage` | 移动契约/固定宽 |
| `ConflictsPage`/`ConflictMergeDialog`/AI `DiffView`/`ConflictDialog`/`VersionConflictDialog` | 移动只读 fallback；保留当前版本=`ignoreConflict` |
| `BrowserPage` 等/`style.css`/`index.html`+`manifest.webmanifest`+icons+`build-pwa-icons.mjs` | 触摸/dvh/PWA |
| daemon CSP `manifest-src` 核对；`main/window.ts` 不改 | 核对 |

---

## 10. 实施阶段（先前端本地→满意后接后端；**每次 `git commit` 前逐次等你确认**）
**Phase 1 前端**（`just dev-web-cloud`+浏览器设备模拟）
1. `useIsMobile+Sheet(随 location 关)`（+单测）
2. `AppRoutes(+/note/:id)+分壳+面板 hooks 移 DesktopShell+DndContext 提层+限域 TouchSensor`
3. **`loadNoteById`(判别联合)+`SaveResult` 判别联合全家族+调用方迁移+`useOpenNote`(intent/Outcome/navSeq/桌面分支)+note-nav guard(+reset 集成)+events-core/shortcuts opener+alias**（含竞态卸载/解析定序/preview/保存-返回竞态/delete 按来源/AI prepare openNote(found)）
4. `MobileBottomNav+MobileTopBar(两态)+FolderDrawer+FolderPanel variant/onOpenNote+SyncStatusBar variant`
5. `EditorPage master-detail + EditorPanel mobileMode + TopBar 保存(result.noteId, replace 保 state, locationRef 竞态确认)`
6. `移动 Settings/Login/AI 单栏`（section 切换+tab 重定向+hideSecrets+固定宽）
7. `移动冲突 UI`（ConflictsPage 堆叠 + ConflictMergeDialog/AI DiffView/VersionConflict 独立只读 fallback + 保留当前版本=ignoreConflict）
8. `触摸打磨`（Browser 换行+`⋯`+44px+style.css dvh/safe-area+Shell overflow-hidden/页面滚动归属）
9. `浮动 TagBar`（useKeyboardInset[焦点+scale]+bottom+ResizeObserver 占位+DateTimePicker 视口校正+单测；真键盘延后）

**Phase 2 接后端** 10. `PWA manifest(+id/scope)+图标(入 git)+meta`+核对 CSP `manifest-src`；11. `docs`（更 `PROCESS.md`+实施记录，末尾单独 `docs:` commit）

---

## 11. 测试（PC 本地+浏览器移动模拟）
验收：`just dev-web-cloud`+DevTools 设备工具栏。单测（gui 519+N），至少：
- 冷启 `/note/A`；冷启 A→replace B→顶栏返回（`canPop:false`→replace，不退出、无重复历史项）。
- **A 请求未完成即切 B / 卸载去 Browser → A 不写 store**；空 noteId 不调 `resolveOpen`；**`retryNonce` 触发重跑**。
- `loadNoteById`：found/`not-found`(仅 404)/`stale`；401/网络+200 缺 data→「加载失败」非「不存在」。
- 解析：已存在 tab / 脏 tab(不刷新基线) / `draft_*`(store 命中不打 API)。
- **note-nav guard**：脏(`isUnsaved`)→弹 save/discard/cancel；save→conflict 暂停、failed 留守；**discard 在 target prepare 成功后才关脏 tab**（prepare 失败不丢当前）；**AI update prepare 未打开时先 `openNote(found)` 再 stage**（不 no-op）；**last-wins 覆盖 preparing/saving**（旧 intent 加载完不 stage/navigate，Promise 结算 `cancelled`）；**`prepare` 仅 `opened` 后 mark/dismiss/close**。
- **`SaveResult` 判别**：`saved/noop/conflict/failed/cancelled` 映射；`dismiss=cancelled` 不伪装成功；`EditorPage` 关 `result.noteId`；各 `if(result.ok)`。
- **保存-返回竞态**：保存后立刻硬件返回→不被拉回 `/note/realId`（用 `locationRef` 非旧 `cur`）；forward 旧 `draft_*` URL→alias canonical replace 后删 alias。
- **session reset**：pending/preparing 时切 session→intent 取消、Promise `cancelled`、alias/mobileMode 清、旧 prepare 不在新账号 stage/navigate。
- preview 不累积干净 tab；编辑保存 tab 保留（可接受）。
- **delete 按来源**：非脏 Browser 删→留 Browser；脏→经 open intent 进 `/note/:id`→确认→`replace('/')`（系统返回不回已删详情）。
- `mobileMode` 独立默认 `edit`；不改持久 `mode`。
- `useKeyboardInset`：无焦点/`scale≠1` 不上浮；ResizeObserver 占位；`DateTimePicker` 日历落 visual viewport。
- 冲突 fallback：不实例化 MergeView（含 AI `DiffView`）；采用本地=`resolve('local')`/保留当前版本=`ignoreConflict`/手工=`resolve('merged')`。
- **桌面回归**：`useOpenNote(!isMobile)` 保 `openNoteById+navigate('/')`、不启 guard；`useIsMobile`/`MobileBottomNav` active/Sheet 随 location 关。
回归：`just check`（9 守卫+typecheck+typecheck-web）+ `just test`（桌面壳原样全绿；SaveResult 迁移不破桌面）+ 桌面手测。本轮不测：真软键盘 TagBar、真 PWA 安装/真机/Lighthouse。

---

## 12. 开放项（仅实施期微调）
| # | 项 | 处理 |
|---|----|------|
| C | maskable padding / iOS `fixed` 抖动 / 「更多」底部 Sheet vs 全屏 / 是否加「只关 mobile-owned 已保存 tab」防累积 | 实施期微调（A/B 已入 §0） |

---

## 13. 风险 / 留意点
- **导航契约=最大面**：intent/Outcome + `navSeq`(覆盖 preparing/saving) + `prepare` 时序(AI update 先 openNote(found)) + token 覆盖卸载 + 判别联合(404/stale/401/协议) + `canPop` + preview + delete 经 intent + 保存-返回竞态(`locationRef`) + alias(有限生命周期) + **reset 集成**——漏一即串号/隐藏态/历史错乱/永等/跨会话串。`events-core`/`MessageBubble`(动态 import)/`useEditorShortcuts` 特标。
- **保存链改判别类型**：触整个 save 家族 + 5 处 `if(ok)`（`ok:false` 真值）；`dismiss=cancelled`；pinning 测试兜底。
- **冲突全 fallback**：`ConflictMergeDialog` 和 AI `DiffView` 都并排 MergeView；保留当前版本=`ignoreConflict`（无 `remote`）。
- **VisualViewport**：inset 作 `bottom`(无祖先 transform)+焦点&scale+ResizeObserver 占位+DateTimePicker 视口校正；真键盘延后。
- **Sheet 随 location 关**；**`mobileMode` 独立严禁 `setMode`**；**面板 hooks 移 DesktopShell**；**commit 逐次确认**；**PWA 仅交付元数据**。
- **桌面回归**：DesktopShell 原样+DndContext 提层+限域 TouchSensor+SaveResult 迁移+`useOpenNote` 桌面分支保原行为 → pinning+手测兜底。

---

## 14. 关联文档
路线源 `2026-07-04-road-to-1.0.0.md` §2 #5 · 架构 `2026-06-06-mobile-web-ecosystem-arch.md`(§4/§5/§9/§13) · Phase B `2026-06-14-phase-b-web-design.md`+B0–B4 · 前序 #4 `2026-07-16-0.6-local-features.md`(③ 会话隔离；commit 规范：代码 commit + 按需末尾 `docs:`) · 状态 `PROCESS.md`
