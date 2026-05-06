# P3.4-e 笔记 tab VSCode 风格预览 — 设计文档

日期：2026-05-07
子项：P3.4-e（P3.4 6 子项的第 5 个；a/b/c/d 已 ship）
对齐依据：`docs/plans/2026-04-20-p3-plan.md` §7.6 + 用户 2026-05-07 scope 回答

## 1. 目标

给编辑器 tab 引入 VSCode 风格的 **预览 / 固定** 双态，让用户能像 VSCode 快速浏览笔记而不堆 tab：

- **预览 tab**：标题斜体；同一时刻最多 1 个；再打开新的预览会替换它
- **固定 tab**：常规样式；互不干扰，可多开
- **脏标升级**：预览 tab 一旦被编辑（dirty）就自动升为固定

## 2. Scope（用户 2026-05-07 拍板）

| 维度 | 决定 |
|---|---|
| 触发范围 | **只 NoteList.tsx**（主编辑页左侧列表） |
| 其他列表 | BrowserPage / FolderPanel / TrashPage 保留当前 `single=select / double=open` 双击行为 |
| 键盘导航 | **NoteList 上/下键重定义为选中 + 预览切换**（替换当前"默认滚条滚动"），其他区域不动 |
| 已固定 tab 再单击 | **激活该固定 tab，不碰 preview slot** |
| 签名 | `openNote(note, opts?: {preview?:boolean})` 扩展（非新函数） |
| 预览位置 | 新预览替换**原 preview tab 在数组中的位置**（不追加；VSCode 做法） |
| 预览视觉 | 斜体 italic（**不**加下划点线，避免与 active `bg-accent` 冲突） |

明确**不做**：

- BrowserPage / FolderPanel / TrashPage 的 preview 行为（保持双击打开语义）
- AI 草稿 tab 的 preview 态（isDraft / pendingAiUpdate 一诞生就是固定）
- 固定 → 预览 的降级路径（单向升级）

## 3. 状态模型

### 3.1 新字段 `TabState.preview: boolean`

位置：`packages/gui/src/renderer/src/stores/editor-store.ts`

```ts
export interface TabState {
  // ... 现有字段
  /** True 表示"预览 tab"：斜体渲染 + 允许被下一次预览替换。
   *  false 表示"固定 tab"：常规样式、永久驻留直到 closeTab。
   *  openNote({preview:true}) 开；双击 / 脏标 / markSaved 升为固定。*/
  preview: boolean;
}
```

**不变量**：

- AI draft 路径（`openAiDraft`）永远 `preview: false`（isDraft=true 含义就是"待保存的固定 tab"）
- **`stageAiUpdate` 必须显式 `preview: false`**：AI update 落到一个本来是预览态的 tab 上（用户刚单击预览又被 AI 用 search→update 命中），不打掉 preview 会让这条 dirty+pending 的 tab 仍可被下一次单击替换，丢失 AI 改动。**凡是 dirty 或 pendingAiUpdate 非空的 tab 不应为预览**
- `updateContent` / `updateTags` 里 dirty 从 false → true 的瞬间 → 强制 `preview = false`（见 §3.3）
- `markSaved` 也要把 preview 打掉：既然已经 commit 过一次，用户对它有"认可"语义，不应再被下一次预览替换

### 3.2 `openNote` 新增 `preview` 参数

```ts
openNote: (note: Note, opts?: { preview?: boolean }) => void;
```

默认 `preview: false`（保持 openNoteById / AI 草稿等现有调用位点语义不变）。

**保留现有"已打开 tab 的刷新/rebase 逻辑"**（editor-store.ts L220 起）：
- clean tab 被重新 openNote → 用 `note` 完整刷新内容 + baseline + title
- dirty tab 被重新 openNote → 只 rebase `originalContent / originalTags / originalFolderId`，保留用户 in-flight edits

preview 语义叠加在这个基础上，**只影响 `preview` 字段本身**，不改动 refresh/rebase 语义。

行为分支（existing 指已打开的 tab）：

1. **existing 为固定 tab**（`preview=false`）：
   - 照常走 refresh / rebase + setActiveTab
   - `opts.preview` **被忽略**（`true` 也不降级为预览）——固定是单向态
2. **existing 为预览 tab**（`preview=true`）：
   - 照常走 refresh / rebase + setActiveTab
   - `opts.preview=true` → 保持 preview=true（纯预览点击）
   - `opts.preview=false` → 升级为 preview=false（双击 / 外部 openNoteById 默认路径）
3. **尚未打开**：
   - `opts.preview=true`：**替换当前存在的预览 tab**（如有）的数组位置，新 tab preview=true
   - `opts.preview=false`：追加新 tab，preview=false

"替换"逻辑：遍历 `tabs` 找 `preview=true` 的 idx；若存在用新 tab 替换该位置（数组不增长），否则追加。

### 3.3 脏标自动升固定

在 `updateContent` / `updateTags` 内部：

```ts
const becomingDirty = !tab.dirty && nextDirty;
return {
  ...tab,
  ...patch,
  dirty: nextDirty,
  preview: becomingDirty ? false : tab.preview,
};
```

只在 **"从 clean 转 dirty"** 的瞬间升固定，避免每次按键都写 preview（性能 + 避免 stale-equality 干扰）。

### 3.4 `markSaved` / `replaceTabAfterCreate`

两个点都强制 `preview: false`：保存过的 tab 一律视为用户"认可"，不可再被预览替换。

## 4. NoteList 行为改造

位置：`packages/gui/src/renderer/src/components/NoteList.tsx`

### 4.1 props 协议 + **同步 open**（避免异步乱序）

`openNoteById(id, opts?)` 走 `api.getNote()` fetch，快速单击 / 上下键时旧请求晚返回会覆盖新预览（lost-update）。

**解决方案**：NoteList 已经通过 `useNoteStore` 拿到完整 `Note[]`（`notes` state），**直接把 note 对象同步传给 `openNote`**，不再经过 `openNoteById` 的 fetch 路径。

改造：

- `NoteList` 的 `onSelectNote` 签名改为 `(note: Note, opts?: { preview?: boolean }) => void`（传 `Note` 不再是 noteId）
- `EditorPage.handleSelectNote` 拿到 note 后直接调 `useEditorStore.getState().openNote(note, opts)`
- **`openNoteById` 保持不变**（用于外部深链 / AI 草稿已存在 tab 再点击等场景，依旧 fetch + openNote）

这样 NoteList 所有交互（单击 / 双击 / ArrowUp / ArrowDown）都是**同步**打开，没有 race。

### 4.2 鼠标

| 事件 | 当前 | 改后 |
|---|---|---|
| single-click | `setSelectedId(note.id)` | `setSelectedId(note.id)` + `onSelectNote(note, {preview:true})` |
| double-click | `onSelectNote(note.id)` | `onSelectNote(note, {preview:false})` |

注意：浏览器双击 = 两次 click + 一次 dblclick。我们的 onClick + onDoubleClick 顺序：
1. 第一次 click → 打开预览
2. 第二次 click → 同 note `{preview:true}` 再调一次（幂等；existing 预览分支，内容刷新，preview 保持 true）
3. dblclick → 同 note `{preview:false}` 升为固定

结果：最终 tab 状态 = 固定。无需 click delay 策略（VSCode 也不做）。

### 4.3 键盘上下键

当前只有 Backspace/Delete 全局 listener。上下键改造**不用 document listener**，而是绑在 NoteList 的**列表容器**（不包住 header 里的搜索框 / 新建按钮）：

- 列表容器（包 ScrollArea 的那层 div）加 `tabIndex={0}`、`ref` + `onKeyDown`
- 事件内 **`ref.current?.contains(e.target)` + `target.tagName !== 'INPUT'`** 双重守卫
- ArrowDown：下一条；ArrowUp：上一条；`e.preventDefault() + e.stopPropagation()`
- 触发 `setSelectedId + onSelectNote(note, {preview:true})`
- 滚到对应 row：复用现有 `scrollIntoView({block:'nearest'})` effect（它本来就 watch `activeNoteId`，但键盘预览会让 `activeNoteId` 变化→自动生效）

**初始 selectedId**：按下时若 `selectedId == null`：
- `activeNoteId != null` → 以它为 anchor 选相邻一条
- 否则选 index 0
- 若 `activeNoteId` 不在当前过滤后的 notes 列表里（搜索收缩）→ fallback 到 index 0

### 4.4 键盘焦点进入

用户按 Tab 或点 list 区域空白时，让列表容器拿到 focus，后续上下键才工作。`tabIndex={0}` 让它进入 tab order；**不需要** `onFocus` 里 seed selectedId（seed 在 ArrowDown/Up 的 null-case 已处理）。

### 4.5 NoteListItem 共享组件的 tabIndex

`NoteListItem.tsx` 是 NoteList / BrowserPage / FolderPanel / TrashPage 都在用的共享组件，默认 `tabIndex={0}`（L94）是 BrowserPage / FolderPanel / TrashPage 的键盘可达性所依赖。**不能直接全局改 -1**。

改造：给 NoteListItem 加可选 prop `tabIndex?: number`，默认 `0`（保留现有行为）：

```tsx
interface NoteListItemProps {
  // ...
  tabIndex?: number; // default 0
}
```

`NoteList` 里传 `tabIndex={-1}`（单条 item 不抢 tab stop，列表容器作为唯一入口），其他页面不传维持默认 `0`。

## 5. TabBar 视觉

位置：`packages/gui/src/renderer/src/components/TabBar.tsx`

- `tab.preview` 为 true 时，给 `<span className="truncate">` 加 `italic`
- 不加下划点线（§7.6 写了但实际和 active 的 `bg-accent` 叠加会视觉紊乱；斜体已经足够区分。偏离 §7.6 这一点记录在 §9）

活跃态、dirty 指示、close 按钮照旧。

## 6. EditorPanel / 其他脏标触点

脏标升固定在 `updateContent` / `updateTags` 里做（§3.3），不动 Editor 组件。`stageAiUpdate` 是独立的直接 `set()` 路径（不走 updateContent），**必须显式** `preview: false`（见 §3.1 契约）——避免 AI update 命中预览 tab 后仍可被替换。

## 7. 测试计划

### 7.1 单测：editor-store

- `openNote` 第一次调用，无参 → preview=false，追加
- `openNote({preview:true})` 第一次 → preview=true，追加
- 两次不同 note 都 `preview:true` → 第二次替换第一次位置，tabs.length 不变
- `{preview:true}` 后同 note 再次 `{preview:true}` → 无变化
- `{preview:true}` 后同 note `{preview:false}` → 原 tab 升为固定，位置不变
- **固定 tab 收到 `{preview:true}` → 仍走 refresh 路径更新 baseline，但 preview 保持 false**（保护 §3.2 分支 1 的单向性 + 现有 refresh 语义）
- dirty → preview 自动变 false（updateContent）
- markSaved 清 preview
- openAiDraft：preview=false
- **以上都写进 `editor-store.test.ts`**

### 7.2 组件测：NoteList

前置：NoteList 通过 `useRequestDeleteNote`（`DeleteConfirmDialog.tsx:66`）调用 `useNavigate`，非 Router 上下文会抛。测试两种方案任选：

1. 用 `MemoryRouter` 包裹 render 树（推荐，贴近真实环境）
2. mock `@/components/DeleteConfirmDialog` 的 `useRequestDeleteNote` 为 noop

测试用例：

- Render 3 笔记，click 第 1 条 → onSelectNote 被调，参数是 Note 对象 + `opts.preview=true`
- Double-click 第 2 条 → onSelectNote 被调，参数是 Note 对象 + `opts.preview=false`
- focus 列表容器，ArrowDown → 选第 1 条 + `{preview:true}`
- 再 ArrowDown → 第 2 条；ArrowUp 回到第 1 条
- 焦点在搜索 Input 时 ArrowDown **不**触发 onSelectNote（target.tagName 守卫）

### 7.3 组件测：TabBar

- preview=true 的 tab 标题 span 含 `italic` 类
- preview=false 不含

### 7.4 回归

- 现有 `editor-store.test.ts` 全部保持绿（AI flow / save / conflict 不动）
- 现有 TabBar 测试（如果有）关闭按钮 hover 等行为不动

## 8. Load-bearing 契约

把这些写进未来 memory 的 P3.4-e 段：

- **openAiDraft / stageAiUpdate / replaceTabAfterCreate / markSaved 必须显式 `preview:false`** —— 否则 AI 草稿 / AI update / 刚保存的 tab 会以预览身份被下一次单击替换，丢失在途工作
- **updateContent / updateTags 的 dirty 升级只在 clean→dirty 边沿打 preview=false**，不是"dirty 就打"，避免 set 频率爆炸
- **NoteList keydown 用 ref.contains，不用 document listener**：避免和 TagBar picker（P3.4-d）/ 全局快捷键冲突
- **`openNote` 已有固定 tab 分支里，`preview:true` 不降级为预览** —— 单向态，降级破坏语义
- **NoteList 必须同步把完整 `Note` 对象传给 `openNote`，不走 `openNoteById` fetch 路径** —— 快速切换时 fetch 乱序会 lost-update 到旧预览
- **`openNote` 默认 `preview: false`**（而非 §7.6 暗示的 true）：现有调用点（深链、AI 草稿、stageAiUpdate 前置 open）都需要固定语义

## 9. 与 §7.6 的偏离记录

- **§7.6 写"斜体 italic + 下划点线"，此设计只用斜体**。下划点线会和 TabBar active 态（`bg-accent`）视觉冲突，斜体已足够区分。若用户体感仍不明显再补 —— 极低改动成本
- **§7.6 暗示 "preview 默认 true"**（"状态字段：`EditorTab.preview: boolean`（新增），默认 true"）。此设计改为 **`openNote` 默认 `preview: false`**：现有调用点（`openNoteById` / `openAiDraft` / `stageAiUpdate` 触发前的 open）都期望固定 tab 语义，把 default 设为 true 会反向破坏所有已有路径。预览态只从 NoteList 显式 `{preview:true}` 开启
- §7.6 没提键盘导航范围，此设计限定只 NoteList 区域，由用户 2026-05-07 拍板
- §7.6 没提异步 race，此设计把 NoteList → openNote 改成**同步**（直接传 Note 对象，不走 openNoteById fetch），避免快速切换时 lost-update

## 10. 实施顺序

1. editor-store：新增 preview 字段 + openNote opts + dirty 升级 + markSaved 清零 + openAiDraft / stageAiUpdate / replaceTabAfterCreate 显式 false
2. editor-store 单测补上（含新"固定 tab 收 preview:true 不降级"保护）
3. NoteList：single-click 预览 / double-click 固定 + 键盘上下键 + 列表容器焦点（`tabIndex={0}`）
4. NoteListItem：加 `tabIndex?: number` 可选 prop（默认 0，NoteList 传 -1）
5. NoteList 组件测补上（用 `MemoryRouter` 或 mock `useRequestDeleteNote`）
6. TabBar：italic 样式
7. TabBar 组件测（如果不存在就最小新建）
8. `just check` + `just test` 全绿
9. 手动测试清单 → 用户验

## 11. 风险 / 边界情况

- **ScrollArea 对键盘事件的处理**：shadcn/radix ScrollArea 可能吞或转发 PageUp/Down；我们只关 ArrowUp/Down，一般不冲突。若测试时发现，考虑绑到 ScrollArea 外层 wrapper
- **搜索后 notes 列表收缩**：当前 selectedId 可能不在可见列表里 → 按上下键时要 fallback 到第 0 条
- **多个 NoteList 实例**：理论上 EditorPage 只渲染一个，但未来多窗口要注意 module-level 状态隔离（目前不成问题）

---

## Implementation record

日期：2026-05-07  
测试状态：542/542 绿（core 150 + cli 119 + daemon 128 + gui 145，gui +28）

### 动过的文件（6 个）

- `packages/gui/src/renderer/src/stores/editor-store.ts` — `TabState.preview` 字段 + `openNote` opts + dirty 边沿升级 + markSaved / openAiDraft / stageAiUpdate / replaceTabAfterCreate 显式 `preview:false`
- `packages/gui/src/renderer/src/components/NoteListItem.tsx` — 加可选 `tabIndex?: number` prop，默认 0
- `packages/gui/src/renderer/src/components/NoteList.tsx` — `onSelectNote(note, opts)` 新签名、single/double click 分开、`tabIndex=0` 列表容器 + `handleKeyDown` + `computeNextNoteIdx` helper（cognitive complexity 拆出去），传 `tabIndex=-1` 给 item
- `packages/gui/src/renderer/src/pages/EditorPage.tsx` — `handleSelectNote` 换成**同步** `openNote(note, opts)` 路径，不再走 `openNoteById` fetch
- `packages/gui/src/renderer/src/components/TabBar.tsx` — `tab.preview` 时标题 `italic`
- **新增测试**：
  - `packages/gui/src/renderer/src/stores/editor-store.test.ts` +12 cases（含"固定 tab 收 preview:true 不降级但仍 refresh"保护）
  - `packages/gui/src/renderer/src/components/NoteList.test.tsx` 新建，5 cases
  - `packages/gui/src/renderer/src/components/TabBar.test.tsx` 新建，3 cases

### 实施偏离设计

- **EditorPage 不再导入 `openNoteById`**：设计提到 `openNoteById` 保持不变供外部深链用。实施时发现 EditorPage 是它的唯一在用方，移掉后 `openNoteById` 仍然保留在 editor-store 里（其他地方或未来可能用），只是 EditorPage 改成 `useEditorStore.getState().openNote(...)` 直通
- **NoteList 测试路径**：设计 §7.2 建议用 MemoryRouter 或 mock `useRequestDeleteNote`。实施时发现 React 19 + pnpm 下，即便 mock 了 `useRequestDeleteNote`，zustand / Radix ScrollArea / Radix ContextMenu / @dnd-kit 都会各自解析到独立 React 实例触发"Cannot read properties of null (reading 'useState')"。最终方案：除 `useRequestDeleteNote` 外还 mock 了 `@/stores/note-store`、`@/stores/data-bus`、`@/components/ui/scroll-area`、`@/components/ui/context-menu`、`@/components/NoteListItem`（替换为最小 `<button>` 行）。此法干净，测试只关心 NoteList 自己的回调/键盘，不需要真实的行渲染
- **TabBar 测试**：同样 zustand 触发 dup-React，所以 mock 掉 `useEditorStore` 成 selector pass-through

### Load-bearing 踩坑记录（下次动这块必读）

1. **NoteList 不能经 `openNoteById` 打开预览**：后者是 `getNote` fetch，快速单击 / 上下键时旧请求晚返回会把 preview slot 的新笔记替换回旧的。必须**同步**把已在 `useNoteStore` 的 Note 对象直接喂给 `openNote`
2. **preview 默认值 false**（非 §7.6 暗示的 true）：`openNote` / `openNoteById` / `openAiDraft` / `stageAiUpdate` 所有已有调用点都期望固定语义；把默认改 true 会反向破坏所有路径
3. **固定 tab 单向**：`openNote({preview:true})` 命中已固定 tab **不**降级——降级会让用户已经表态"要保留"的 tab 被下一次单击替换
4. **openAiDraft / stageAiUpdate / markSaved / replaceTabAfterCreate 都要显式 `preview:false`**：任何 dirty / 含 `pendingAiUpdate` 的 tab 都不应为预览；`...t` spread 不会兜底（stageAiUpdate 以前没 preview 字段，老 tab 的 preview 取决于 openNote 时写的值）
5. **dirty 升级只在 clean→dirty 边沿打 preview=false**，不是"每次 dirty=true 都 overwrite preview"——避免 set 频率爆炸和奇异 stale-equality
6. **NoteList keydown 用 ref 守卫，不用 document listener**：document 会和 TagBar picker（P3.4-d）/ 编辑器快捷键抢劫；用列表容器 `onKeyDown` + `tagName !== 'INPUT'` 双重守卫最干净
7. **NoteListItem 共享组件加 `tabIndex?: number`，默认 0**：BrowserPage / FolderPanel / TrashPage 的键盘可达性依赖 `tabIndex=0`；不能直接改 -1，只能 NoteList 显式 opt-in 传 -1
8. **React 19 + pnpm 组件测试规律**：任何子组件链路里的 **zustand / Radix portal（ScrollArea / ContextMenu / Popover）/ @dnd-kit** 都会触发 dup-React hook check。解决方式不是改 vitest config inline list（影响面大），而是 mock 该组件或 store 为纯 pass-through —— 测试覆盖只落在当前组件行为上
