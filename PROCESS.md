# 开发进度

## 当前状态：P2 实施中（P2-4 完成）

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
| P1-5a | 编辑页面 — 三栏布局 + 多标签 + 模式切换 | `4aaaf9c` |
| P1-5b | 快捷键 + 手动保存 + 脏标记 + 未保存弹窗 | `577b2fe` |
| P1-6 | 标签栏 Tag Bar（输入+自动补全+日期选择器+排序+唯一性） | `401e671` `7b6bdef` `90aa594` `3141eba` |
| P1-7 | 浏览页面（搜索+标签筛选+排序+单击选中+双击打开） | `37d8193` |
| P1-8 | 回收站页面（两Tab+批量操作+倒计时+删除功能） | `7dbf409` |
| 补充 | Cmd+1-7 导航快捷键 + AI 排序调整 + 拖动修复 | `f4119d4` |
| 补充 | 删除关闭Tab + 列表自动滚动到活跃笔记 | `defb0ac` |
| 补充 | 编辑器Backspace误触修复 + 语法高亮增强 | `2d7b1f9` |
| 补充 | 行号3位宽度 + 滚动到底(scrollPastEnd) | `7231b81` |
| P1-9 | 提醒页面（alarm筛选+周期计算+时间范围+编辑） | `997173d`~`03eb7c8` |
| 补充 | 全页面标签显示增强：所有标签类型+可编辑time/alarm | `3928a05` |
| 补充 | 统一标签排序（#拼音→/alarm→/time→频率） | `47ccf9d` |
| 补充 | 多频率同时生效+频率排序修复 | `f04979b` |
| 补充 | 代码简化：提取TagDisplay/date-format/useMemo优化 | `03eb7c8` |
| P1-10 | reminder_status 表 + daemon 提醒调度器 + 系统通知 | `e28c27b`~`948b24b` |
| fix | daemon 测试挂死修复（scheduler.stop() 到 after hook） | `72f05e6` |
| P2-0 | 待办页面（提取+分组+勾选同步+dirty tab overlay） | `1bd0889` |
| P2-1 | 设置页面框架 + 快捷键自定义栏（daemon /config API + 12 项快捷键录制） | `dba637b` |
| P2-2 | 设置 — 外观栏（窗口大小 + 全局字体偏移 + 编辑器字号/行高，CSS 变量） | — |
| P2-3 | 设置 — 自定义栏（LLM API + 测试连接 + auto_delete_days + 默认模式/排序） | `73e7ea0` |
| P2-4 | 设置 — 高级栏（AI 上下文参数 + 日志配置 + 日志级别切换） | — |

- 测试：93 个全部通过（core 61 + daemon 32）
- Lint + Typecheck：零错误（8 个 pre-existing warnings）

### 下一步：trash sticky-deadline fix（粘性截止时间 + 剩余时间展示格式化）

**P2 设计文档：** `docs/plans/2026-04-12-p2-design.md`

P2 commit 分解（11 步）：

| # | 内容 | 类型 | 状态 |
|---|------|------|------|
| P2-0 | 待办页面（提取+分组+勾选同步，含 openTabs 冲突处理） | 前端+API | ✅ |
| P2-1 | 设置页面框架 + 快捷键自定义栏 | 前端+API | ✅ |
| P2-2 | 设置 — 外观栏 | 前端+配置 | ✅ |
| P2-3 | 设置 — 自定义栏（LLM API + 自动删除天数 + 默认模式/排序） | 前端+配置 | ✅ |
| P2-4 | 设置 — 高级栏（LLM 参数 + 日志） | 前端+配置 | ✅ |
| P2-5 | 文件夹管理面板（侧边栏 + CRUD + 拖拽排序 + 递归 CTE） | 前端+API+Core | ⏳ |
| P2-6 | 浏览页文件夹筛选（include_descendants） | 前端 | ⏳ |
| P2-7 | AI Tool Registry + daemon agent loop | 后端 | ⏳ |
| P2-8 | AI 对话页面（聊天界面 + 草稿机制） | 前端 | ⏳ |
| P2-9 | 分屏拖拽（列表↔编辑、编辑↔预览） | 前端 | ⏳ |
| P2-10 | reminder_status 清理（90 天 fired 记录） | 后端 | ⏳ |

**P2 不做（延后事项）：**
- 远程连接（原 P2-1）— 与 P4 migration 同步机制耦合，整体留到 P4
- `open_note_in_gui`（daemon→GUI 反向通道）— 留到 P3 CLI 场景再做

**关键设计决策：**
- AI 草稿走 SSE 响应事件，GUI 自行打开 Tab（无反向通道）
- create_note 用 `draft_<uuid>` 占位 ID，首次 Cmd+S 走 POST
- update_note dirty 冲突弹 modal 三选一（接受 AI / 保留本地 / 查看差异）
- 待办页数据 = daemon 结果 + dirty tab overlay，订阅 editorStore 自动合并

### 实施阶段总览

```
P0 ✅ → P1 ✅ → P2 实施中（P2-0 ✅，P2-1 ~ P2-10 待开发） → P3（CLI+外部调用） → P4（Migration）
```

## 关键文件

- 完整计划：`docs/plans/COEDIT_PLAN.md`
- P1 设计文档：`docs/plans/2026-04-06-p1-design.md`
- Go 版问题清单：`docs/reference/ISSUES_FROM_GO.md`
- AI 搜索模式参考：`docs/reference/AI_SEARCH_PATTERNS.md`
