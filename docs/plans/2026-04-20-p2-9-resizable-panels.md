# P2-9 设计文档：可拖拽分屏面板

日期：2026-04-20
阶段：P2-9（最后一个 P2 前端任务）
依赖：P2-5b（FolderPanel）、P1-5a（三栏布局）

## 1. 目标

为编辑页添加 3 条可拖拽分隔条，使用户可调整：

1. **FolderPanel ↔ 主内容**（所有页面生效，仅在文件夹面板打开时出现）
2. **NoteList ↔ 编辑区**（编辑页）
3. **Editor ↔ Preview**（编辑页 split 模式）

比例持久化到 localStorage，刷新后恢复；关闭/切换再打开（折叠面板、切换模式）不重置。

## 2. 设计决策

### 2.1 方案选型

| 决策 | 选择 | 理由 |
|------|------|------|
| 范围 | 3 条分隔条（含 FolderPanel） | 一次到位，共用实现，避免后续再改 |
| 实现 | `react-resizable-panels` | 声明式 Panel/Handle、原生 ARIA + 键盘 + touch、支持嵌套与 autoSave |
| 持久化单位 | 百分比（库默认） | 窗口 resize 等比缩放，符合 VSCode/Zed 等编辑器体验 |
| 约束 | 每面板最小百分比 | 到达最小会 snap，防止挤爆；设计文档的 160/200px 换算为百分比 |

### 2.2 不做的事（YAGNI）

- 双击重置 / 折叠按钮 — 库支持但暂缓，等用户提出
- 拖拽 handle 时的实时 px 提示 tooltip — 库内置视觉反馈已足够
- 手动按键微调 — 库内置 arrow key 支持（有焦点时）
- 跨页面不同比例 — 只有编辑页用内层 2 条 group，其它页共用 FolderPanel group

## 3. 架构

### 3.1 三个独立 PanelGroup

全部 `direction="horizontal"`，相互独立；各自一份 localStorage 键。

```
App.tsx
├── <nav> (w-16, 固定)
└── [panelOpen]
    ├── PanelGroup #1 autoSaveId="owl-folder-layout"
    │   ├── Panel: <FolderPanel />         default=20%  min=13%
    │   ├── ResizeHandle
    │   └── Panel: <main><Routes /></main> default=80%  min=40%
    │       └── EditorPage.tsx (/ route)
    │           └── PanelGroup #2 autoSaveId="owl-editor-layout"
    │               ├── Panel: <NoteList />      default=22% min=15%
    │               ├── ResizeHandle
    │               └── Panel: 编辑区             default=78% min=50%
    │                   ├── <TabBar />
    │                   └── EditorPanel.tsx
    │                       └── [mode==='split']
    │                           PanelGroup #3 autoSaveId="owl-editor-split"
    │                           ├── Panel: <MarkdownEditor />  default=50% min=25%
    │                           ├── ResizeHandle
    │                           └── Panel: <MarkdownPreview /> default=50% min=25%
[!panelOpen]
    └── <main><Routes /></main>   // 不包 Group，独立渲染
```

### 3.2 最小值换算（参考窗口 1200px）

| 面板 | 最小 px | 所在 group 宽度估算 | minSize 百分比 |
|------|---------|---------------------|----------------|
| FolderPanel | 160 | ≈ 1136（window - nav 64） | 14% → 取 13% |
| 主内容（FolderPanel 展开时） | 400 | 同上 | 35% → 取 40% 保证不挤爆 |
| NoteList | 160 | ≈ 920（FolderPanel 展开）或 1136 | 14–17% → 取 15% |
| 编辑区 | 300 | 同上 | 32–35% → 取 50% 保底 |
| Editor / Preview 各 | 200 | ≈ 720（编辑区内） | 28% → 取 25% |

minSize 是 group 内的相对百分比；实际换算不完美（依赖 FolderPanel 是否开），取偏保守值，在主流窗口（≥ 1000px）均能保证最小可读宽度。

### 3.3 组件抽象

```
components/ui/ResizeHandle.tsx
```

统一封装 `<PanelResizeHandle>` 的样式：

- 1px 宽（垂直方向），透明 `bg-border`
- hover：宽度保持 1px，背景色 `bg-sidebar-primary/40` + 2px outline 柔和延展
- dragging：背景色 `bg-sidebar-primary`
- `data-resize-handle-state` attribute 由库提供，可用 CSS 选择器匹配

所有三处 resize 都引用此组件，保证视觉一致。

## 4. 数据流

- 库自动将当前 `sizes: number[]` 写入 `localStorage["react-resizable-panels:<autoSaveId>"]`
- 初始化时库自动读取；若无记录用 `defaultSize`
- 窗口 resize：库按比例重排，不触发任何业务代码
- 面板模式切换（`mode` 从 split → edit）：group #3 卸载，比例保留在 localStorage，下次 split 重建时恢复

无 zustand/context 参与；纯组件级状态 + localStorage。

## 5. 错误与边界

- **localStorage 读失败**（私密模式）：库 fallback 到 `defaultSize`，业务无感
- **FolderPanel 关闭 → 再打开**：panelOpen 从 false 切到 true 时，group #1 重建，从 localStorage 读取上次比例
- **mode 切换**：group #3 按需渲染，路径同上
- **窗口极窄（< 600px）**：各 min 之和可能超 100%；库会按优先级挤压，不崩溃但视觉可能不佳。超小窗口不在 P2 目标内，P3 再考虑响应式

## 6. 测试

### 6.1 单元测试（vitest）

加一个 `ResizeHandle.test.tsx`（轻量）：

- render 后 `role="separator"` 存在
- 传入 `className` prop 可合并
- 接受 `disabled` 时设 `data-resize-handle-disabled`

PanelGroup 本身不测（库自测）。

### 6.2 手动测试清单（P2-9 End-to-End）

跑 `just dev`：

**A. 外层 FolderPanel ↔ 主内容**
1. Cmd+B 打开文件夹面板 → 出现 1 条分隔条
2. 拖动到最右 → 主内容 snap 到 40%；拖到最左 → FolderPanel snap 到 13%
3. 拖到任意位置 → 刷新 → 宽度恢复
4. Cmd+B 关闭 → 再打开 → 宽度恢复到刷新前

**B. NoteList ↔ 编辑区**
5. 在编辑页拖中间那条 → 列表缩放
6. 拖到最小 → snap；刷新恢复
7. 切到浏览页再切回 → 宽度保留（编辑页独立 group）

**C. Editor ↔ Preview（split 模式）**
8. 模式切到 split → 出现第 3 条分隔条，默认 50/50
9. 拖到 60/40 → 切到 edit 模式 → 切回 split → 恢复 60/40
10. 刷新 → 恢复 60/40

**D. 窗口 resize**
11. 把窗口从 1400px 拖到 900px → 所有面板按比例缩放，无挤爆
12. 缩到 600px 以下 — 可能出现重叠（超出 P2 目标，观察即可）

**E. 键盘无障碍**
13. Tab 聚焦到 handle → 左右方向键可微调 → Home/End 到极值

## 7. 实施步骤（建议 commit 分解）

| # | 内容 | 涉及文件 |
|---|------|---------|
| 1 | `pnpm add react-resizable-panels` + `ResizeHandle.tsx` + vitest | `packages/gui/package.json`、`components/ui/ResizeHandle.tsx`、`ResizeHandle.test.tsx` |
| 2 | `App.tsx` — 外层 group（panelOpen 条件） | `App.tsx` |
| 3 | `EditorPage.tsx` — NoteList/编辑区 group | `EditorPage.tsx` |
| 4 | `EditorPanel.tsx` — split 模式 group | `EditorPanel.tsx` |
| 5 | `PROCESS.md` + 手动测试清单更新 | `PROCESS.md` |

全部完成后：`just check` + `just test` 零错误；手动验收 A-E 通过。

## 8. 受影响范围评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| 新增依赖 `react-resizable-panels` | bundle 体积 +~15KB gz | 可接受，功能集中 |
| localStorage key 冲突 | 其它代码未用此前缀 | 无冲突（已 grep 确认） |
| FolderPanel 拖拽与 dnd-kit 手势冲突 | dnd-kit 用 5px 激活距离，PanelResizeHandle 在 handle 区域独占 mousedown | 分隔条宽度窄（1px），不会与文件夹/笔记拖动混淆 |
| CodeMirror 焦点劫持 handle 键盘事件 | CodeMirror 内 Tab 不冒泡到 handle | handle 聚焦路径独立，无实际冲突 |

## 9. 参考

- 库：https://github.com/bvaughn/react-resizable-panels
- 设计文档第 7 节：`2026-04-12-p2-design.md#分屏拖拽p2-9`
