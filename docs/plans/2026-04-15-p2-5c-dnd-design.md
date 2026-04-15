# P2-5c 设计：文件夹 / 笔记拖拽（dnd-kit）

> 日期：2026-04-15
> 状态：已确认，待实施
> 前置：P2-5a（core + daemon API）、P2-5b（GUI 侧边面板）

## 1. 范围

| 维度 | 行为 |
|---|---|
| 文件夹拖文件夹 | 同级 reorder + 跨父级 move + 提升到根 |
| 笔记拖文件夹 | 浏览页 NoteList → 文件夹节点（移动到该文件夹）/ 面板空白区（清除 folder_id） |
| 不做 | 编辑页 NoteList 拖拽、TabBar 拖拽到文件夹、笔记之间排序（笔记无 position 字段） |

理由：浏览页是组织整理场景，编辑页是写作场景；TabBar 已有排序逻辑会冲突；笔记排序没有持久化语义。

## 2. 技术选型

- `@dnd-kit/core` 作为引擎（新增到 `@owl/gui` 依赖）
- **不用** `@dnd-kit/sortable`：其面向扁平 sortable list，无法表达"节点 vs 间隙"的树形语义
- 自定义 collision detection + `DragOverlay` 渲染 VSCode 风格圆角矩形
- `DndContext` 提升到 `App.tsx` 顶层（source 在 BrowsePage、target 在 FolderSidebar，必须共享同一 context）
- `MouseSensor` + activation distance `5px`，避免误触发（兼顾 React.StrictMode）

## 3. 拖拽数据契约

```ts
type DragData =
  | { kind: 'folder'; folderId: string; parentId: string | null }
  | { kind: 'note'; noteId: string };

type DropTarget =
  | { kind: 'folder-node'; folderId: string }                       // 放在文件夹节点上
  | { kind: 'folder-gap'; parentId: string | null; index: number }  // 同级间隙
  | { kind: 'root-blank' };                                         // 面板底部空白区
```

`useDraggable` / `useDroppable` 通过 `data` 字段携带，`onDragEnd` 在 handler 中 narrow 后分发。

## 4. Collision Detection（VSCode 风格）

每个 folder row 渲染**三个 droppable 区**叠加：

- 顶部 25% → `folder-gap`（在该节点之前插入）
- 中间 50% → `folder-node`（成为子节点 / 笔记移入）
- 底部 25% → `folder-gap`（在该节点之后插入）

外加面板底部一个 `root-blank` droppable 兜底"提升到根 / 清除 folder_id"。

collision strategy：dnd-kit 的 `pointerWithin`，配合 `data.kind` 区分。`useDroppable.over` 时设置高亮 / indicator state。

## 5. 视觉

- **DragOverlay**：圆角矩形带 1 个图标 + 文本（文件夹名或笔记首行），源元素拖动时 `opacity-40`
- **folder-node 高亮**：整行 `bg-primary/15` + `outline-2 outline-primary`
- **folder-gap indicator**：在目标位置插入一条 2px 高 `bg-primary` 横线（绝对定位）
- **root-blank 高亮**：面板底部空白区 dashed border + `bg-primary/5`

## 6. 后端调用映射

| Drop | API |
|---|---|
| folder → folder-gap（同 parent） | `PATCH /folders/reorder`（parent 内重排 position 数组） |
| folder → folder-gap（不同 parent） | `PUT /folders/:id` 改 parent，再 `PATCH /folders/reorder` 重排；失败 refetch + toast |
| folder → folder-node | `PUT /folders/:id` body `{ parent_id }` |
| folder → root-blank | `PUT /folders/:id` body `{ parent_id: null }` |
| note → folder-node | `PATCH /notes/:id/move` body `{ folder_id }` |
| note → root-blank | `PATCH /notes/:id/move` body `{ folder_id: null }` |
| folder → 自身或后代 | **client 端拒绝**（cycle 早返） |
| 同位置 / 拖到自身 | noop |

**实施前 P2-5a 验证**：`PUT /folders/:id` 是否支持 `parent_id` 字段更新（设计文档未明说）。不支持就在 5c 顺手补 + 写 daemon 测试。

## 7. State / Store 更新

**folderStore**：
- `move(id, parentId)` / `reorder(parentId, orderedIds)`：乐观更新 + 失败回滚 + refetch fallback
- 前端 cycle 检测函数（等价 P2-5a `getFolderSubtreeIds` 逻辑，递归本地树）

**editorStore**：
- `EditorTab` 加 `folderId: string | null` 字段
- `openNote` / `loadNote` 时从 `GET /notes/:id` 响应同步 `folderId`
- 新增 action `syncTabFolderId(noteId, folderId)`：拖拽移动笔记后调用，更新已打开 Tab
- draft tab 的 `folderId` 默认 `null`（不预填选中文件夹；selected state 留给 P2-6 浏览页筛选）
- `saveNote` 的 `createNote` 调用继续传 `folder_id: tab.folderId`，无需改

## 8. 边界 / 防御

- **Cycle**：拖文件夹 A 到 A 的后代 → client 端递归检查，dragEnd noop
- **拖到自己 / 同位置**：noop（避免无意义请求）
- **拖动期间外部修改数据**：refetch 覆盖乐观更新，可接受
- **跨父级 reorder 两步调用失败**：第一步成功第二步失败 → 至少 parent 已变更，refetch 后视觉一致，toast 提示 position 可能不准
- **React.StrictMode**：`MouseSensor` activation distance `5px` 避免重复 listener 触发

## 9. 测试

- **单测**（`folderStore.test.ts` 扩展）：cycle 检测纯函数、乐观更新回滚路径
- **不写**：拖拽手势单测（dnd-kit 不适合 jsdom 环境）
- **daemon 测试**：仅在第 6 节验证结果发现 `PUT /folders/:id` 不支持 `parent_id` 时补
- **手动测试清单**（GUI 变更强制项，见下）

### 手动测试：P2-5c 拖拽

测试步骤：
1. 创建 A、B、C 三个顶级文件夹 → 预期：折叠顺序 A B C
2. 拖 C 到 A 和 B 之间的间隙 → 预期：顺序变为 A C B，间隙横线高亮
3. 拖 C 到 A 的中间区 → 预期：C 成为 A 的子文件夹，A 行高亮
4. 尝试拖 A 到 C（A 的后代） → 预期：无视觉反馈或 noop，无请求发出
5. 展开 A，拖 A 内的 C 到面板底部空白 → 预期：C 回到顶级，最后位置
6. 浏览页选中一篇笔记（#真实 标签的要排除），拖到 B 文件夹的中间区 → 预期：B 行高亮，松开后笔记 folder_id 更新
7. 在编辑器中打开刚移动的笔记 → 预期：Tab 内部 folderId 已同步（修改后保存不会回到旧文件夹）
8. 拖笔记到面板空白 → 预期：笔记 folder_id 清空
9. 拖一个 draft tab（未保存笔记）对应的笔记 → 预期：draft 无真实 id，浏览页不存在此行，不可能触发（作为负向验证）
10. Cmd+B 折叠面板时拖拽 → 预期：面板隐藏期间无拖拽目标，不崩溃

## 10. Commit 拆分

**单 commit**：`feat(gui): P2-5c folder/note drag-and-drop`

拆分会出现"装好库但没接线"或"接 store 但没视觉"的中间态，不可独立验证。单 commit 范围适中（新增 dnd-kit 依赖 + ~300 行 GUI 代码 + store 扩展）。

## 11. 验收

- [ ] 文件夹同级 reorder 生效
- [ ] 文件夹跨父级 move 生效
- [ ] 文件夹提升到根生效
- [ ] Cycle 拖拽被拒绝
- [ ] 笔记拖入文件夹生效
- [ ] 笔记拖到空白清除 folder_id
- [ ] 已打开 Tab 的 folderId 同步更新
- [ ] VSCode 风格视觉（DragOverlay + gap indicator + node 高亮）
- [ ] `just check` 零错误
- [ ] 手动测试 10 项全过
