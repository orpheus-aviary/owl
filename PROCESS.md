# 开发进度

## 当前状态：P1 实施中（P1-0 ~ P1-4 完成）

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
| bugfix | 自动提取标签 + FTS5 trigram 中文搜索 + /time: 冒号格式 | `ead7014` `0ae1f83` `3dfc4b1` |
| P1-0 | 回滚 extractTagsFromContent，标签栏为唯一标签源 | `25bec4b` |
| P1-1 | shadcn/ui + API 调用层 + lucide-react 侧边栏 | `b9f4bb8` |
| P1-2 | zustand stores + 笔记列表 + CORS | `9b9a946` |
| P1-3 | CodeMirror 6 编辑器 + 语法高亮 + 列表续行 | `fadc527` |
| P1-4 | Markdown 渲染组件 + 外部链接 + 脚注 + 数学公式 | `eaebf96` |
| P1-5a | 编辑页面 — 三栏布局 + 多标签 + 模式切换 | `pending` |

- 测试：65 个全部通过（core 50 + daemon 15）
- Lint + Typecheck：零错误（4 个 pre-existing complexity warnings）

### 下一步：P1-5b（编辑页面 — 快捷键 + 手动保存 + 脏标记）

P1 目标：完整的笔记管理 GUI，解决 Go 版所有渲染问题。

**设计文档：** `docs/plans/2026-04-06-p1-design.md`

P1 commit 分解（12 步）：

| # | 内容 | 类型 |
|---|------|------|
| P1-0 | 回滚 extractTagsFromContent | 架构修正 |
| P1-1 | shadcn/ui 初始化 + API 调用层 + 侧边栏图标 | 基础设施 |
| P1-2 | zustand stores + 笔记列表组件 | 数据层+组件 |
| P1-3 | CodeMirror 6 编辑器组件 | 核心组件 |
| P1-4 | Markdown 渲染组件 | 核心组件 |
| P1-5a | 编辑页面 — 三栏布局 + 多标签 + 模式切换 | 页面框架 |
| P1-5b | 编辑页面 — 快捷键 + 手动保存 + 脏标记 | 交互逻辑 |
| P1-6 | 标签栏 Tag Bar（Go 风格输入+自动补全+日期选择器） | 交互组件 |
| P1-7 | 浏览页面（搜索+标签筛选下拉+自动补全） | 页面 |
| P1-8 | 回收站页面（两 Tab + 批量操作 + 自动清除） | 页面 |
| P1-9 | 提醒页面（时间筛选+待触发列表） | 页面 |
| P1-10 | reminder_status 表 + daemon 提醒调度器 + 系统通知 | 后端 |

**关键设计决策：**
- 标签栏为唯一标签数据源，正文纯 Markdown（`#` 是 Markdown 语法，不从 content 提取标签）
- 手动保存（Cmd+S），无自动保存，关闭未保存标签弹窗提示
- 提醒调度：DB 持久化（reminder_status 表）+ 事件驱动 + setTimeout 精确触发
- 编辑模式三种切换：编辑→分屏→预览（Cmd+Option+V 循环），P1 分屏固定 50/50
- 所有快捷键 P1 硬编码，P2 设置页面可自定义

### 实施阶段总览

```
P0 ✅ → P1（P1-0~P1-5a ✅，P1-5b 下一步） → P2（待办+设置+文件夹+AI+分屏拖拽） → P3（CLI+外部调用） → P4（Migration）
```

**P2 范围预览：**
- 待办页面（`- [ ]` 提取、按笔记整理、交互式编辑）
- 设置页面（远程配置、快捷键自定义、窗口/自动清除/标签栏位置配置）
- 文件夹（嵌套、拖拽排序、展开折叠）
- AI 工具调用 + AI 生成标签
- 分屏拖拽调整比例 + 记住偏好

## 关键文件

- 完整计划：`docs/plans/COEDIT_PLAN.md`
- P1 设计文档：`docs/plans/2026-04-06-p1-design.md`
- Go 版问题清单：`docs/reference/ISSUES_FROM_GO.md`
- AI 搜索模式参考：`docs/reference/AI_SEARCH_PATTERNS.md`
