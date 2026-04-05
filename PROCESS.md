# 开发进度

## 当前状态：P0 完成，准备 P1

### 已完成

| Commit | 内容 | Hash |
|--------|------|------|
| P0-1 | monorepo 初始化 (pnpm workspace + biome + tsconfig) | `42ad912` |
| P0-2 | @owl/core 数据库层 (drizzle + FTS5 + 专项笔记) | `9fdd9f1` |
| P0-3 | @owl/core 配置 + 日志 (TOML + pino) | `cc4b76b` |
| P0-4 | @owl/core 笔记 CRUD + 标签解析 + 搜索 | `b950e8e` |
| P0-5 | @owl/daemon Fastify REST API (15 endpoints) | `e6fbe69` |
| P0-6 | @owl/gui Electron 空壳 (7 页面占位) | `840c164` |
| - | justfile | `8bbcf0d` |

- 测试：62 个全部通过
- Lint + Typecheck：零错误（3 个 complexity warnings 可接受）

### 下一步：P1 编辑器 + 浏览 + 回收站 + 提醒

P1 目标：完整的笔记管理 GUI，解决 Go 版所有渲染问题。

P1 预计 commit 分解（待细化）：
1. CodeMirror 6 编辑器组件（语法高亮、Tab 缩进、快捷键）
2. Markdown 渲染组件（remark-gfm + rehype-katex + 代码高亮）
3. 编辑页面（多标签 + 分屏 + 标签输入）
4. 浏览页面（文件夹树 + 搜索 + 筛选）
5. 回收站页面（一级/二级 + 批量操作）
6. 提醒页面（日期范围 + 快捷按钮）
7. daemon 提醒调度器（轮询 + 精确定时器 + 系统通知）

### 实施阶段总览

```
P0 ✅ → P1（进行中） → P2（文件夹+待办+AI+设置） → P3（CLI+外部调用） → P4（Migration）
```

## 关键文件

- 完整计划：`docs/plans/COEDIT_PLAN.md`
- Go 版问题清单：`docs/reference/ISSUES_FROM_GO.md`
- AI 搜索模式参考：`docs/reference/AI_SEARCH_PATTERNS.md`
