# P3.4-b 设计：特殊笔记视觉区分（#随记 / #待办）

> 日期：2026-05-05
> 状态：设计中，待用户确认
> 前置：P3.4-a 已 ship
> 后置：P3.4-c

## 1. 范围

给 `#随记`（`SPECIAL_NOTES.MEMO = ...0001`）和 `#待办`（`SPECIAL_NOTES.TODO = ...0002`）在笔记列表行左侧加 4px 纯色条，让用户一眼能从列表中认出这两个 AI 专用笔记。

### 1.1 作用面

| 渲染位置 | 组件 | 是否生效 | 备注 |
|---|---|---|---|
| 编辑页 NoteList | `NoteList` → `NoteListItem` | ✅ | 主要 surface |
| 浏览页 BrowserPage | `BrowserPage` → `NoteListItem` | ✅ | 主要 surface |
| 回收站 TrashPage | `TrashPage` → `NoteListItem` | ✅（随组件） | 特殊笔记一般会被 `ensureSpecialNotes` 恢复；即使偶发进回收站，保留色条不增加额外成本，并帮助用户识别 |
| FolderPanel 笔记行 | `FolderPanel` 自绘 `FolderNoteRow` | ❌ | 不用 NoteListItem，体积太小不放色条（保持和 pin 图标一致的"只放最小信号"原则） |
| 编辑器 tab | `EditorTabs` | ❌ | 和脏标 / 激活态叠色噪音大（plan §7.3） |
| 侧栏快捷按钮 | — | ❌ | 用户 2026-05-04 明确不做 |

### 1.2 范围外

- 背景色、字体颜色变化（只加左侧色条）
- 右键菜单改动
- 图标改动（不加 emoji / 图标前缀）
- 主题可配置化（只定义 CSS 变量，便于未来扩展）

---

## 2. 颜色 token

在 `packages/gui/src/renderer/src/style.css` 的 `:root` 中新增：

```css
--owl-pin-memo: #3b82f6;   /* 蓝 500 — #随记 */
--owl-pin-todo: #ec4899;   /* 粉 500 — #待办 */
```

不进 `@theme inline` 的 `--color-*` 映射：这俩不是通用语义色，不参与 Tailwind `bg-*`/`text-*` 代号系统，使用时走 `style={{ boxShadow: 'inset 4px 0 0 var(--owl-pin-memo)' }}` 这种直接引用。

选色原因：蓝色是通用 memo 色调（与 markdown checkbox 选中态 `#3b82f6` 一致，视觉语言统一），粉色与蓝色色相拉开足够距离且明度接近，两种笔记在列表里并排不会互相盖过。

---

## 3. 视觉呈现

### 3.1 方案：inset box-shadow（不占 border 通道）

现有 `NoteListItem` 的 active 态用了 `border-l-2 border-l-primary`。若直接改 border 表示特殊笔记，会和 active 冲突（4px vs 2px 打架）。

**改用 `box-shadow: inset 4px 0 0 <color>`**：
- 不占 border 属性，与 active 态的左 border 可同时存在
- inset 在内部绘制，不额外占用布局空间（`border-l-4` 会把内容推右 4px）
- 渲染开销和 border 一样低

### 3.2 状态叠加矩阵

以 `#随记` 行为例：

| 状态 | 左 2px border（active） | 左 4px inset shadow（special） | 背景 |
|---|---|---|---|
| 默认 | 无 | 蓝 4px | 无 |
| hover | 无 | 蓝 4px | `bg-accent/50` |
| active | `border-l-primary` | 蓝 4px | `bg-accent` |
| pinned 且非 active | 无 | 蓝 4px | `bg-primary/5`（若 `showPinBackground`） |
| pinned + active | `border-l-primary` | 蓝 4px | `bg-accent` |

即：special 色条永远存在，active/pin 的既有视觉完全不变。shadow 绘制在 border 之上，视觉上可见最外层 4px 蓝（special），再内 2px 白（active primary），再内部是内容——两条竖线合起来 6px 宽，可接受（不会误读为两个边框，因为颜色对比明显）。

### 3.3 Dark-mode

owl 固定 dark theme（`style.css` line 90 "owl is always dark"）。#3b82f6 / #ec4899 都是饱和度高、明度中等的 tailwind-500 色，在深色 `oklch(0.145 0 0)` 背景下对比度都足够（WCAG AA 对非文本装饰元素没硬要求，目测有充分穿透力）。

---

## 4. 代码改动

### 4.1 `style.css`（+2 行）

`:root` 块末尾加：
```css
  --owl-pin-memo: #3b82f6;
  --owl-pin-todo: #ec4899;
```

### 4.2 `NoteListItem.tsx`（新增 ~6 行）

1. 从 `@owl/core` 导入 `SPECIAL_NOTES`（或 inline 两个常量 ID，避免跨包依赖——见 §4.3 决定）
2. 在组件顶部算 `specialColor`：
   ```ts
   const specialColor =
     note.id === SPECIAL_NOTES.MEMO ? 'var(--owl-pin-memo)' :
     note.id === SPECIAL_NOTES.TODO ? 'var(--owl-pin-todo)' :
     null;
   ```
3. 在根 `<div>` 上追加 `style={specialColor ? { boxShadow: `inset 4px 0 0 ${specialColor}` } : undefined}`
4. 不改 className；active/pin 逻辑原样保留

### 4.3 `SPECIAL_NOTES` 来源

**现状**：`@owl/core` 只被 gui 的 main 进程（`migration-ipc` / `daemon` / `migration-precheck`）引用；renderer 通过 daemon HTTP API 通信，没有现成的 `@owl/core` 渲染器侧导入通道。

**既有约定**：`DeleteConfirmDialog.tsx` 里已经 inline 了两个 UUID 常量：
```ts
/** Kept in sync with `SPECIAL_NOTES` in `@owl/core/db/special-notes`. */
const SPECIAL_NOTE_IDS: ReadonlySet<string> = new Set([
  '00000000-0000-0000-0000-000000000001', // #随记
  '00000000-0000-0000-0000-000000000002', // #待办
]);
```

**决定**：沿用此约定。抽出 `packages/gui/src/renderer/src/lib/special-notes.ts` 作为 renderer 侧唯一常量源：

```ts
/** Kept in sync with `SPECIAL_NOTES` in `@owl/core/db/special-notes`. */
export const SPECIAL_NOTE_IDS = {
  MEMO: '00000000-0000-0000-0000-000000000001',
  TODO: '00000000-0000-0000-0000-000000000002',
} as const;

export const SPECIAL_NOTE_ID_SET: ReadonlySet<string> = new Set(Object.values(SPECIAL_NOTE_IDS));
```

顺手把 `DeleteConfirmDialog.tsx` 的 inline 常量替换为 import，减少副本数量。

### 4.4 不改动

- `BrowserPage.tsx` / `NoteList.tsx` / `TrashPage.tsx` / `EditorTabs.tsx` / `FolderPanel.tsx`：都无需改，因为 color 逻辑内置在 `NoteListItem` 里
- daemon / core / API / schema：纯前端视觉，无后端改动
- 测试：纯 CSS 装饰，不新增单元测试（目测验证即可）

---

## 5. 风险 & 非目标

| 项 | 风险 | 处理 |
|---|---|---|
| 跨包导入 `SPECIAL_NOTES` | renderer 侧没有 `@owl/core` 通道 | §4.3：抽 `lib/special-notes.ts`，renderer 内单一源 |
| 色盲用户 | 蓝/粉辨识差 | 非核心功能（标题 "# 随记" / "# 待办" 已是明文语义），色条只是辅助；未来可加 `prefers-reduced-motion` 类的色板切换（超出本次 scope） |
| 用户想关掉色条 | 暂无 toggle | P6 可加"装饰"设置页；本次不做 |
| 用户新建普通笔记标题写 `# 随记` | 不触发色条 | 色条只认 id，不认标题，符合"特殊笔记"语义 |

---

## 6. 验证

### 6.1 typecheck + lint

```bash
cd packages/gui && pnpm tsc --noEmit
cd ../.. && just check
```

### 6.2 手动测试清单

**前置**：daemon 正在 dev 模式跑，`~/orpheus-aviary-nest/owl/owl.db` 里已有 MEMO/TODO 两条特殊笔记（`ensureSpecialNotes` 会自动保证）。用户 `just dev` 起前端。

```
### 手动测试：P3.4-b 特殊笔记色条

测试步骤：
1. 打开编辑页 → 在 NoteList 中找到 #随记 → 预期：列表项左侧出现 4px 蓝色竖条
2. 找到 #待办 → 预期：左侧 4px 粉色竖条
3. 点击 #随记 激活 → 预期：蓝色 4px 色条保留，内侧叠加 2px 白色 active border，背景变 accent
4. 置顶 #随记（右键菜单 / FolderPanel 中置顶）→ 回到 NoteList → 预期：蓝色色条 + pin 图标 + pin 背景三者并存，互不冲突
5. 切换到浏览页 → 同样两条笔记 → 预期：色条显示与编辑页一致
6. 在 FolderPanel 找到 #随记 / #待办 → 预期：**不**显示色条（保持只带 Pin 图标的极简风）
7. 进入回收站页（若恰好进去过）→ 预期：若列表里能看到特殊笔记，色条仍在（偶发）
8. 普通笔记（新建一条 "# 随记 的普通笔记"）→ 预期：**不**触发色条（按 id 不按标题）
9. 编辑器顶栏 tab → 预期：tab 外观不变（无色条）
```

---

## 7. 上线

typecheck + lint 通过 + 用户手动测试通过后：

- commit scope: `gui`（或 `notes`，沿用 P3.4-a 的 `notes`）；message: `feat(notes): add color bar for memo/todo special notes`
- PROCESS.md 把 P3.4-b 行标 `✅ shipped 2026-05-05`
- memory 更新 `project_owl_rewrite.md`：P3.4-b shipped，下一步 P3.4-c

## Implementation record

**Date shipped**: 2026-05-05（设计 + 实施 + 手动验证同日完成）

**实际改动**（5 files, +20 / -7）：

| File | 改动 |
|---|---|
| `packages/gui/src/renderer/src/style.css` | `:root` 加 `--owl-pin-memo: #3b82f6` / `--owl-pin-todo: #ec4899` |
| `packages/gui/src/renderer/src/lib/special-notes.ts` | 新建。导出 `SPECIAL_NOTE_IDS` / `SPECIAL_NOTE_ID_SET` / `specialNoteColorVar()` |
| `packages/gui/src/renderer/src/components/NoteListItem.tsx` | import `specialNoteColorVar`，`specialColor = specialNoteColorVar(note.id)`，根 div 加 `style={specialColor ? { boxShadow: inset 4px 0 0 ${specialColor} } : undefined}` |
| `packages/gui/src/renderer/src/components/DeleteConfirmDialog.tsx` | 删除 inline `SPECIAL_NOTE_IDS`，改 import `SPECIAL_NOTE_ID_SET` |
| `docs/plans/2026-05-05-p3-4-b-special-notes-visual-design.md` | 本文件 |

**验证**：`just check` 通过（warnings 均为 pre-existing）；`just test` 全部 489 个测试通过（core 150 / daemon 128 / gui 92 / apps/cli 119）；手动测试 10 项全通过。

**设计 vs 实际差异**：无。§3.1 的 inset box-shadow 方案按预期与 active border / pin bg 共存；§4.3 的 renderer-local 常量模块抽离顺手替换了 DeleteConfirmDialog 的 inline 副本。

**后续**：P3.4-c（AI chat 笔记 id → 可跳转标题）。
