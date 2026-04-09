# P1-7 浏览页面设计

> 日期：2026-04-09
> 状态：已确认

## 概述

浏览页面是笔记的全局浏览入口，提供搜索 + 标签筛选 + 排序功能。两栏布局（侧边导航 + 内容区），复用 `NoteListItem` 组件。

## 布局

```
┌──────┬─────────────────────────────────────────────────────┐
│      │ 🔍 [搜索内容...]  [标签筛选 ▼]  排序: [更新时间 ▼]    │
│      │ 已激活: [#工作 ×] [#重要 ×]                           │
│ 导航  │─────────────────────────────────────────────────────│
│ 栏    │ 笔记标题                                             │
│      │   预览文字                                            │
│      │   [#工作] [#重要]                                     │
│      │ 笔记标题                                             │
│      │   预览文字                                            │
│      │   [#学习]                                            │
└──────┴─────────────────────────────────────────────────────┘
```

## 状态管理：useBrowserStore

使用 zustand store 持久化筛选状态，切换页面再回来保留条件。

```typescript
interface BrowserState {
  // 筛选状态
  query: string           // 搜索关键词（FTS）
  activeTags: string[]    // 已激活的标签筛选值
  sortBy: 'updated' | 'created'  // 排序方式

  // 数据
  notes: Note[]
  total: number
  loading: boolean

  // 方法
  setQuery(q: string): void
  addTag(tag: string): void
  removeTag(tag: string): void
  setSortBy(sort: 'updated' | 'created'): void
  fetchNotes(): void
  resetFilters(): void    // Cmd+R 调用，清空所有筛选条件
}
```

## 标签筛选交互：Popover

点击「标签筛选」按钮弹出 Popover，内含：
- 顶部搜索输入框（过滤标签列表）
- 下方标签列表（从 `useTagStore.fetchTags()` 获取）
- 已激活标签带勾选标记
- 点击标签 → toggle 激活/取消
- Popover 外部点击关闭

已激活标签以 chip 形式展示在操作栏下方，点击 × 移除。

## 快捷键

| 快捷键 | 功能 | 作用域 |
|--------|------|--------|
| `Cmd+R` | 重置所有筛选条件（搜索词 + 标签 + 排序） | 浏览页 |

## 筛选逻辑

- 搜索内容：FTS 全文搜索（调用 `api.listNotes({ q })`)
- 标签筛选：通过 `api.listNotes({ tags })` 传递逗号分隔的标签值
- 搜索 + 标签 = AND 关系
- 多个已激活标签之间 = AND 关系（daemon 端已支持）
- 排序：`sort_by` 参数（需确认 daemon 是否支持，不支持则前端排序）

## 组件复用

- `NoteListItem`：直接复用，展示标题 + 预览 + 标签 chips
- 点击笔记 → `navigate('/')` 跳转编辑页 + `openNoteById(noteId)` 打开标签

## 验收标准

- [ ] 笔记列表完整显示（标题 + 预览 + 标签）
- [ ] 搜索框输入触发 FTS 搜索，结果实时更新
- [ ] 点击标签筛选按钮 → Popover 展示所有标签，带搜索过滤
- [ ] 点击标签 toggle 激活/取消，已激活标签出现在操作栏下方
- [ ] 已激活标签 × 可移除
- [ ] 多个已激活标签 AND 过滤
- [ ] 搜索内容 + 标签筛选 AND 关系
- [ ] 排序切换（更新时间 / 创建时间）生效
- [ ] 点击笔记跳转到编辑页
- [ ] Cmd+R 重置所有筛选条件
- [ ] 切换到其他页面再回来，筛选状态保留
- [ ] `just check` 零错误
