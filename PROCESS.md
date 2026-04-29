# 开发进度

## 当前状态：**P3.2-b MigrationDialog 已实施**（2026-04-30），271/271 测试 + 真库 smoke 通过，等待 commit

## 仓库迁移（2026-04-20）

- `orpheus-aviary/owl-ts` → `orpheus-aviary/owl`（活跃 TS 版）
- `orpheus-aviary/owl` → `orpheus-aviary/owl-go`（Go 版，归档）
- 本地目录同步：`owl-ts` → `owl`、`owl` → `owl-go`
- 全仓 19 处 `owl-ts` 字符串替换为 `owl`
- `package.json` name 字段：`owl-ts` → `owl`

P3 完整规划见 `docs/plans/2026-04-20-p3-plan.md`。

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
| P2-4 | 设置 — 高级栏（AI 上下文参数 + 日志配置 + 日志级别切换） | `88b9079` |
| fix | trash sticky-deadline（auto_delete_at 列 + 非递增语义 + 独立 cleanup timer + daemon /config 值校验 + GUI ESM spawn 修复） | `d70428a` |
| P2-5a | folders 核心模块 + 递归 CTE + daemon `/folders`/`/notes/:id/move` 路由 | `44ea48d` |
| P2-5b | GUI 文件夹侧边面板（树 + 右键 CRUD + Cmd+B toggle + editor-scoped） | `fa6d225` |
| P2-5c | 拖拽（dnd-kit 排序 + 跨父级 move + 拖笔记入文件夹 + cycle 抑制 + 双击展开） | — |
| P2-7a | LLM client SDK 适配器（OpenAI + Anthropic 双 SDK，统一 StreamChunk 异步流） | `7424c38` |
| P2-7b | Tool registry + 9 个工具（7 read + 2 Tier-1 write）+ WriteToolResult 契约 | `f5ff159` |
| P2-7c | Agent loop + ConversationStore + 系统提示（Layer 1 recent fill）+ max_context_chars 配置 | — |
| P2-7d | SSE 端点 + AI 路由（POST /ai/chat、GET/DELETE /ai/conversations、GET /ai/capabilities）+ AppContext 扩展 | — |
| P2-7e | Tier-2 写工具（create/update_note、create_reminder、apply_update）+ PreviewStore + GUI editorStore 草稿/暂存 | — |
| docs | P2-8 计划文档 + P2-7 计划同步实际事件契约 + PROCESS daemon-restart 历史引用清理 | `8717e6a` |
| P2-8 step 1 | SSE client (`lib/sse-client.ts`) + 9 vitest 测试（GUI 首个测试 runner） | `74c1027` |
| P2-8 step 2 | `/ai/*` HTTP wrappers + ai-store skeleton（newChat/closeChat/abortStreaming + sendMessage 完整 SSE wiring） | `b583630` |
| P2-8 step 3 | 纯函数事件 dispatcher (`ai-dispatcher.ts`)，处理全部 9 类事件 + 14 个 vitest 测试 | `c8bfc86` |
| P2-8 step 4 | AIPage shell + ChatTabBar + MessageList + MessageBubble + ChatInput | `a830fa0` |
| P2-8 step 5 | ToolCallBlock + DraftReadyCard + PreviewReadyCard + 嵌入 MessageBubble | `b335951` |
| P2-8 step 6 | `editorStore.applyNoteAppliedFromAi` + ai-store 转发 + 全局 NoteAppliedToast + 4 个 vitest 测试 | — |
| P2-8 step 7 | DraftReadyCard "打开" → `openAiDraft / stageAiUpdate` + `markDraftOpened` + navigate | `54d87c8` |
| P2-8 step 8 | `@codemirror/merge` 集成 + `components/ai/diff/DiffView.tsx`（read-only split） | `bf16c9d` |
| P2-8 step 9 | `conflictPrompt` + `requestSaveOrConflict` / `resolveConflict` + `<ConflictDialog>` 嵌入 DiffView + 5 个 vitest 测试 | `a993c3c` |
| P2-8 step 9 fix | pre_stage_content 捕获（dirty-stage 触发冲突） + accept-ai 清 pre_stage 避免重试循环 + daemon `setErrorHandler` 把 500 stack 写进 log | `0e7cca5` `c53dbb0` |
| P2-8 step 10 | ChatInput 自动聚焦（mount / chat 切换 / stream 结束）+ abort 后显示"⏹ 已停止生成"指示 + E2E 手动测试清单 | `a3b924d` |
| P2-9 设计 | 2026-04-20 设计文档：3 个 Group（FolderPanel↔main / NoteList↔编辑区 / Editor↔Preview） | `353e821` |
| P2-9 step 1 | `react-resizable-panels@4` + `components/ui/ResizeHandle.tsx`（Separator 包装） | `9953859` |
| P2-9 step 2 | `App.tsx` 外层 Group（FolderPanel 改 collapsible Panel，Cmd+B 走 imperative collapse/expand，main 不再 remount） | `c0db35b` |
| P2-9 step 3 | `EditorPage.tsx` NoteList↔编辑区 Group；UnsavedDialog hoist 出 Group 避免非法子节点 | `831e7a9` |
| P2-9 step 4 | `EditorPanel.tsx` split 模式 Editor↔Preview Group，切换模式/刷新都保留比例 | `98152de` |
| P2-9 fix | Panel size props 单位字符串化（minSize `"120px"`），过滤 collapsed=0 的 save，panelOpen 持久化到 localStorage | `11116a6` `da43e8b` |
| P2-10 | `cleanupOldFiredReminders(db, 90)` + scheduler 集成 + 2 个 core 测试 | `f61253c` |
| P2-6 | 浏览页文件夹筛选：UI 早在 `ad6db40` 随文件夹面板一并做完；本次显式化 `include_descendants` 参数 + 加 daemon 组合测试 | `ad6db40` `1db27cc` |

- 测试：212 个全部通过（core 84 + daemon 93 + gui 35）
- Lint + Typecheck：零错误（11 个 pre-existing warnings）
- 决策文档：
  - `docs/plans/2026-04-14-trash-sticky-semantics.md`
  - `docs/plans/2026-04-17-p2-7-ai-implementation.md`
  - `docs/plans/2026-04-17-p2-8-ai-page.md`
  - `docs/plans/2026-04-18-chat-persistence.md`（未执行，P2-9 之后或 P3）
  - `docs/plans/2026-04-20-p2-9-resizable-panels.md`
  - `docs/plans/p3-deferred.md`（P3 集合清单）

## P3.0.5 — Pre-release 修复打磨（2026-04-28，7/7 完成）

| 项 | 内容 | Hash |
|---|---|---|
| docs | P3.0.5 范围细化 + 双 adapter thinking 协议表 | `162a319` |
| #10 | 拖到"未分类"区域 drop 失效 — UnfiledSection 接 useDroppable + footer 文案按拖拽类型切换 | `40bc340` |
| #4 | 回收站恢复后文件夹树 / 主笔记列表未刷新 | `8f0df50` |
| #4b | 跨页 stale list 统一刷新 — 新增 `stores/data-bus.ts`，note/folder/browser store 模块级订阅；附带修复 Bug A（save 后 folder tree 标题不变）+ Bug B（FolderPanel 删笔记后 TrashPage 不刷新） | `10dbee3` |
| #9/#6/#7 | 滚动条 gutter 暗色 + 列表正文白色 + Bold/Italic 快捷键 toggle 语义（Cmd+E 让位给 useEditorShortcuts 的"聚焦编辑区"） | `76d8937` |
| #3 | AI thinking 协议修复 — 双 adapter（OpenAI `delta.reasoning_content` + Anthropic `thinking_delta` / `signature_delta`）+ agent-loop 累积 + GUI 折叠显示 + Settings `thinking_round_trip` toggle | `7999a01` |
| #2 | DraftReadyCard 折叠 + 单卡"同意"（Tier-1，跳过 editor）+ "同意全部 (N)" 批量按钮 + 冲突检测 / per-card 错误隔离 | `b038d2e` |

- 测试：228 个全部通过（core 84 + daemon 95 + gui 49）
- Lint + Typecheck：零错误（11 个 pre-existing warnings）
- 移出本批：
  - `#11` 同层级笔记拖拽排序（经查不是 regression 而是缺失功能 — 笔记无 `position` 字段）→ 推迟到 P3.4，需 schema + daemon API + GUI gap drop target 设计
  - `#1` 图片粘贴 + 缓存目录 / `#5` VSCode 风格 tab / `#8` FIM 补全：原本就在 P3.4

## P3.1 — GUI `0.2.0` 首发（2026-04-29，smoke 1/2/3 绿，未 tag）

## P3.1 — GUI `0.2.0` 首发（2026-04-29 发版 ✅）

**Release**: https://github.com/orpheus-aviary/owl/releases/tag/v0.2.0
**Commits**（main）: `ef0c989` fix(daemon) → `31e5299` feat(gui) → `bbf600e` docs
**Assets**: `Owl-0.2.0-arm64.dmg`（129 MB）+ `.sha256`（`fc95bad4…d2c236`）

基线：228/228 测试（core 84 + daemon 95 + gui 49）。设计文档 `docs/plans/2026-04-28-p3-1-gui-0.2.0-release-design.md`。

| 项 | 内容 | 备注 |
|---|---|---|
| 配置 | `packages/gui/electron-builder.yml` + `resources/owl-logo-original.png` + `scripts/build-icons.mjs`（sips + iconutil）+ `resources/.gitignore`（`icon.icns`） | 无新 deps（macOS 自带工具） |
| 主进程 | `daemon.ts` 改 Electron-as-Node spawn（`process.execPath` + `ELECTRON_RUN_AS_NODE=1` + `...process.env`）+ `daemonStartedByGui` 标记 + `stopDaemonGracefully`（SIGTERM → 3s → SIGKILL，仅自己拥有时执行） | 外部 daemon 不会被 GUI 退出误杀 |
| 退出语义 | `index.ts` 改单门 Cmd+Q：红叉 `hide()`（保 dock + renderer state）、`activate` 优先 show 已有窗口、`before-quit` await stopDaemonGracefully | macOS 标准交互 |
| daemon CLI | `packages/daemon/src/cli.ts`：`program.parse(process.argv, { from: 'node' })`。Electron-as-Node 下 `process.versions.electron` 为真 → commander 默认 `from: 'electron'` 只 strip argv[0] → script path 被误读为 subcommand → daemon 死在 "unknown command" | 一行 fix，必需 |
| pnpm 兼容 | 根 `.npmrc: node-linker=hoisted` | workspace symlink + electron-builder 打包必备 |
| asar 策略 | `asar: false`（妥协） | pnpm workspace symlink + electron-builder asarUnpack 过滤器冲突（`packages/core/dist/*` 不在 `packages/gui/` 下）。代价：dmg 大一点、冷启动略慢。0.2.1 可用 `pnpm deploy` 改回 |
| postinstall | `electron-builder install-app-deps` **不设 postinstall**，挪到 `pnpm package` 脚本内 | 若 postinstall 跑 → `.pnpm/better-sqlite3` rebuild 为 Electron ABI 132 → 所有 `just test` 段错误 |
| scripts | `packages/gui/package.json` `version=0.2.0` + `package` / `build:deps` / `build:icons` / postinstall 调整 | — |
| justfile | `just package` / `just unpackage`（后者 rebuild better-sqlite3 回 Node ABI，便于 package 后再跑 test） | — |
| README | 根目录新增极简 README（状态 + 中文下载说明「右键→打开」绕 Gatekeeper + 数据目录 + 开发命令） | — |
| P3 主计划同步 | `docs/plans/2026-04-20-p3-plan.md` §2.2 daemon 归属扩展、§4 P3.1 技术要点完全重写、§7 加 tray 条目、§9.3 加 tag 策略分歧 | 设计文档 §7 要求的落地 |

### 实测 smoke 结果

- **Smoke 1（daemon 在 packaged app 内能否 spawn）**✓：Owl.app 启动 → `ensureDaemonRunning` → Electron-as-Node spawn → `daemon.pid=91006`、`/status` 返回 uptime 9.7s、`logs/daemon.log.30` 写入"Daemon started" / "Scheduler starting" / "Reminder scheduled"
- **Smoke 2（better-sqlite3 + FTS + CRUD）**✓：`GET /notes?limit=1` 返回真实数据；`POST /notes` 新建；`POST /notes/:id/permanent-delete` 永久删除测试笔记（已清理干净，`#真实` 笔记未动）
- **Smoke 3a（Cmd+Q 停自己拉起的 daemon）**✓：`kill $APP_PID` → `before-quit` 触发 `stopDaemonGracefully` → daemon 收到 SIGTERM → "Daemon shutting down..." + "Reminder scheduler stopped" + `daemon.pid` 被清
- **Smoke 3b（红叉隐藏）**：osascript 无 Accessibility 权限无法自动 click；逻辑已代码审查（`win.on('close')` + `event.preventDefault()` + `hide()`），留作用户手动验证
- **Smoke 3c（外部 daemon 不被 GUI 退出误杀）**✓：先手动 `node packages/daemon/dist/cli.js daemon` 起 pid 45875 → 启 Owl.app → Owl 走 checkDaemon 命中、不 spawn 新 daemon（`daemonStartedByGui=false`）→ kill Owl.app → 外部 daemon 仍 alive、pid 未变、`/status` uptime 增加；最后手动 SIGTERM 清理外部 daemon

### 产物

`packages/gui/release/Owl-0.2.0-arm64.dmg` ≈ 129 MB（asar 关闭）。

### 还没做

- [ ] 下一个版本（0.2.1 / 0.3.0）决定是否恢复 asar（`pnpm deploy` 路径 B）
- [ ] Windows / Linux + GitHub Actions CI matrix
- [ ] 正式 codesign / notarize（Apple Developer 依赖）

### 下一阶段：P3.2 — CLI 核心开发

详见 `docs/plans/2026-04-20-p3-plan.md` §5。P3.2 切成 4 个独立子提交：

| 子阶段 | 范围 | 状态 |
|---|---|---|
| **P3.2-a** migration runner | `user_version` 分派 + `0001_initial.sql` + `migrateLegacyDb` rebuild + `just migrate` + daemon 拒启动 + 5 种 error + 15 测试场景 | **已 ship**（commit `38e9243`，245/245 测试 + 真库 smoke 通过） |
| P3.2-b GUI modal | `whenReady` precheck + MigrationDialog（4 屏 confirm/running/success/error），复用 `migrateLegacyDb`；把 P3.2-a 的 sealed `onProgress` 升级为实时 emit；9 条 review issue 全部修复 | **已 ship**（2026-04-30，271/271 测试 + 真库 smoke 通过） |
| P3.2-c CLI 核心 | apps/cli + commander + daemon-detect + HTTP/direct 双模式 + `owl migrate` + tsup bundle + publishable manifest | 未开始 |
| P3.2-d SSE reverse channel | `/events` + `open_note` 事件 + GUI 订阅 + `owl open` | 未开始 |

### P3.2-a 实施详情（2026-04-29）

基线：228/228 测试（core 84 + daemon 95 + gui 49）。
现在：**245/245 测试**（core 101 + daemon 95 + gui 49）— core 新增 17 测试（migrate 15 + backup 2）。

文件改动：

| 文件 | 变动 |
|---|---|
| `packages/core/src/db/migrations/0001_initial.sql` | [新] 完整 DDL + FTS 虚表 + 3 触发器；文件头"永不修改"约定 |
| `packages/core/src/db/migrate.ts` | [新] 5 错误类 + `LATEST_KNOWN_VERSION` + `applyInitialSchema` / `applyForwardMigrations`（骨架 + TODO 清单）+ `probeDaemonPid` + `isSchemaEmpty` + `verifyExpectedColumns` + `migrateLegacyDb`（幂等 + 3 层锁 + Phase A/B/C + 嵌套 try/finally） |
| `packages/core/src/db/backup.ts` | [新] `backupDatabase(sqlite, targetPath)` — 通用 backup 原语，为 `owl export` / `owl doctor --backup` 预留复用 |
| `packages/core/src/db/migrate.test.ts` | [新] 15 测试：T1-T4 dispatch + T5/T10/T15 happy + T7/T8/T9/T11/T13/T14 lock/error + T6/T12 FTS+rollback |
| `packages/core/src/db/backup.test.ts` | [新] 2 测试 |
| `packages/core/src/db/index.ts` | [改] `createDatabase` 按 `user_version` 5 分支分派；删 `createTables IF NOT EXISTS` + `migrateSchema()` |
| `packages/core/src/index.ts` | [改] barrel 补 re-export |
| `packages/core/scripts/copy-sql.mjs` | [新] post-build 复制 SQL 进 dist |
| `packages/core/scripts/migrate.mjs` | [新] TTY y/N 交互入口 |
| `packages/core/package.json` | [改] build 脚本接 `node scripts/copy-sql.mjs` |
| `packages/daemon/src/cli.ts` | [改] `writePid()` 提前到 `createDatabase` 之前；catch `MigrationRequiredError`/`IncompatibleDbError` → 中文提示 exit 1 |
| `justfile` | [改] + `migrate` target |

关键设计决策兑现：
- **幂等保护**（增量 #1）：`migrateLegacyDb` 入口 peek `user_version`，v=LATEST 返回 `{ alreadyMigrated: true }`（T15）
- **Forward migration 骨架**（增量 #2）：`applyForwardMigrations` 空实现 + 文件头列 5 项未来 TODO（事务/JS migration/destructive flag/user_version bookkeeping/锁复用）
- **onProgress 签名占位**（增量 #3）：`MigrateOptions.onProgress` 签名已定，0.3.0 sealed hook（P3.2-b 补）
- **`backupDatabase` 抽出**（增量 #4）：独立工具模块，迁移逻辑调它 — 为未来 `owl export` / 定期备份零成本复用
- `0001_initial.sql` **不**内嵌 `PRAGMA user_version`（runner 统一 stamp）
- `probeDaemonPid` 自有实现，避开 `core↔daemon` 循环
- `$AUTO` 占位换列投影 — `auto_delete_at` 缺列兜底 NULL（T10）
- FTS `delete-all` + set-based rebuild，严格复现 `hashTags.join(' ')` 格式 — 无双 posting（T12 硬断言 per-rowid count=1）
- Phase B 嵌套 try/finally 管连接生命周期 + 事务状态 + attach 状态；Phase C 原子替换带完整回滚
- 三层锁：Layer 1 daemon.pid probe / Layer 2 `openSync('wx')` / Layer 3 `locking_mode=EXCLUSIVE` + 触发读
- 源库 `main.foreign_key_check` 预检是权威点（T11）；dest 侧复查纵深（schema-qualified pragma）
- Backup 文件名毫秒 ts，同秒重试不覆盖（T13 retry 断言）

验证：
- `pnpm run lint`：零错误，13 warnings（+1 新：`migrateLegacyDb` cognitive complexity，Phase A/B/C 结构固有）
- `pnpm run typecheck`：全 workspace 零错误
- `pnpm run test`：245/245 pass（core 101 + daemon 95 + gui 49）

---

### P2-9 手动测试清单

跑 `just dev`：

**A. 外层 FolderPanel ↔ 主内容**
1. Cmd+B 打开文件夹面板 → 出现分隔条
2. 拖分隔条 → 文件夹面板缩放；拖到最小约 13%
3. 任意位置刷新 → 宽度恢复
4. Cmd+B 关闭 → 再打开 → 宽度恢复；期间编辑器光标位置保持（main 未 remount）

**B. NoteList ↔ 编辑区**
5. 编辑页拖第 2 条 → 笔记列表缩放；拖到 15% snap
6. 切到浏览页再切回 → 宽度保留
7. 刷新 → 宽度恢复

**C. Editor ↔ Preview（split 模式）**
8. 模式切到 split → 出现第 3 条，默认 50/50
9. 拖到 60/40 → 切到 edit → 切回 split → 恢复 60/40
10. 刷新 → 恢复 60/40

**D. 窗口 resize**
11. 窗口从 1400 拖到 900 → 所有面板按比例缩放，无挤爆

**E. 键盘无障碍**
12. Tab 聚焦到分隔条 → 左右方向键可微调

### P2-8 E2E 手动测试清单

跑 `just dev` 之后按顺序验证：

**A. SSE + 基础对话**
1. 编辑页随便建一条笔记 → 切到 AI 页（侧栏 Cmd+6）
2. 第一次进去应自动建 **1** 个 chat（不是 2 个）
3. 输入"列出我所有标签"，按 Enter 发送
4. 预期：流式文字出现；tool_call `list_tags` 折叠块可展开看 args/result；结尾"思考中…"消失

**B. Tier-1 auto-merge（append_memo）**
5. 编辑页打开 `#随记` 笔记（干净不脏）
6. 切到 AI 页，"在 memo 末尾追加 milk"
7. 预期：右上角绿色 toast "AI 已更新笔记"；memo tab 内容自动更新；DB `sqlite3 owl.db "select content from notes where id like '00000000%1'"` 可查到

**C. Tier-1 dirty-merge**
8. 回到编辑页在 `#随记` tab 里再手写一行（不保存）→ tab 脏
9. AI 页 "在 memo 追加 eggs" → 预期：toast + memo tab 内容变成"(用户本地) + eggs"，脏标志仍在；Cmd+S 走 PUT 路径保存
10. DB 应有 milk + eggs 都在

**D. Tier-2 create 草稿**
11. AI 页 "帮我创建一个叫'旅行清单'的笔记，内容写三项"
12. 收到 DraftReadyCard → 点"打开"
13. 预期：切到编辑页，新 tab 标题"旅行清单"，内容预填，Tab 脏，AI 页按钮变"已打开"
14. Cmd+S → POST 保存，Tab id 从 `draft_` 换成真实 UUID；笔记列表刷新

**E. Tier-2 update（无冲突）**
15. 挑一条已有普通笔记（比如上面建的"旅行清单"），关掉它的 tab
16. AI 页 "把旅行清单的第三项改成'买保险'"
17. 收到 DraftReadyCard action=update → 点"打开"
18. 预期：笔记打开，内容是 AI 版本，Tab 脏，`pendingAiUpdate` 已 stage
19. Cmd+S → PATCH 保存，不弹冲突，Tab 干净

**F. Tier-2 update（触发冲突）**
20. 打开"旅行清单"笔记，手动在末尾加一行 → Tab 脏
21. **不切走**，继续在同一笔记中停留；切 AI 页 "把旅行清单的第二项改成'订机票'"
22. 收到 DraftReadyCard → 点"打开"
23. 回到编辑页看到内容被 AI 覆盖
24. Cmd+S → **ConflictDialog 弹出**，"冲突项：内容"
25. 点"查看差异" → 左栏你的本地版（含刚加的那行）、右栏 AI 版
26. 点"保留本地" → tab 回滚到你的本地版 + 保存
    重复一次选"接受 AI 版本" → tab 保留 AI 版 + 保存，dialog 不再弹

**G. Abort UI**
27. AI 页发一条长问题 "写一篇 500 字散文"
28. 流式到一半点 ⏹ Stop 按钮
29. 预期：光标消失，bubble 底部显示"⏹ 已停止生成"灰字
30. 输入框重新获得焦点可继续输入

**H. 聊天 tab 切换 + scroll 保留**
31. 起两个 chat tab，各发几条消息
32. 在 tab A 滚动到中间位置 → 切 tab B → 切回 tab A
33. 预期：scrollTop 保留在你离开时的位置，不重置到顶

**I. 页面离开后再回**
34. 在 AI 页发消息中途 Cmd+1 切编辑页
35. 切回 AI 页 → 预期：流式继续（后台运行），切走期间新增的 tool_call / 消息都在

**J. 删除系统笔记保护**
36. 浏览页/编辑页找到 `#随记`，右键 → 移到回收站
37. 预期：弹"系统笔记无法删除"对话框（非静默失败）

**K. daemon 500 诊断**
38. 手动停 daemon；GUI 调用任何 API 时出错会在 daemon.log 留 `unhandled route error` 条目含 stack（非 Fastify 默认的空）

**P2-8 实施进度（10 步 ✅）：**

| Step | 内容 | 状态 |
|------|------|------|
| 1 | `lib/sse-client.ts` + 9 vitest 测试 | ✅ |
| 2 | `lib/api.ts` `/ai/*` wrappers + `ai-store` skeleton（newChat/closeChat/sendMessage） | ✅ |
| 3 | `ai-dispatcher.ts` 纯函数 + 14 个事件测试（9 类事件全覆盖 + malformed/unknown） | ✅ |
| 4 | AIPage shell + ChatTabBar + MessageList + MessageBubble + ChatInput | ✅ |
| 5 | ToolCallBlock + DraftReadyCard + PreviewReadyCard + 嵌入 MessageBubble | ✅ |
| 6 | `editorStore.applyNoteAppliedFromAi` + NoteAppliedToast（store onEvent wrapper 触发） | ✅ |
| 7 | DraftReadyCard "打开" → `editorStore.openAiDraft / stageAiUpdate` wiring | ✅ |
| 8 | `@codemirror/merge` 集成 + DiffView 组件 | ✅ |
| 9 | ConflictDialog + `editorStore.requestSaveOrConflict / resolveConflict` | ✅ |
| 10 | Polish: empty-state、scroll、shortcut、abort UI、error bubble、E2E manual test | ✅ |

**P2 设计文档：** `docs/plans/2026-04-12-p2-design.md`、`docs/plans/2026-04-17-p2-8-ai-page.md`

P2 commit 分解（11 步）：

| # | 内容 | 类型 | 状态 |
|---|------|------|------|
| P2-0 | 待办页面（提取+分组+勾选同步，含 openTabs 冲突处理） | 前端+API | ✅ |
| P2-1 | 设置页面框架 + 快捷键自定义栏 | 前端+API | ✅ |
| P2-2 | 设置 — 外观栏 | 前端+配置 | ✅ |
| P2-3 | 设置 — 自定义栏（LLM API + 自动删除天数 + 默认模式/排序） | 前端+配置 | ✅ |
| P2-4 | 设置 — 高级栏（LLM 参数 + 日志） | 前端+配置 | ✅ |
| P2-5a | 文件夹核心 + daemon API（CRUD + 递归 CTE + 移动笔记） | Core+API | ✅ |
| P2-5b | GUI 文件夹侧边面板（树 + 右键 CRUD + Cmd+B + context-menu） | 前端 | ✅ |
| P2-5c | 拖拽（dnd-kit 排序 + 拖笔记入文件夹 + editorStore.folderId 同步） | 前端 | ✅ |
| P2-6 | 浏览页文件夹筛选（include_descendants） | 前端 | ✅ |
| P2-7a | LLM client SDK 适配器 | 后端 | ✅ |
| P2-7b | Tool registry + 9 工具（read + Tier-1 write） | 后端 | ✅ |
| P2-7c | Agent loop + 内存对话 + system-prompt（Layer 1 recent fill） | 后端 | ✅ |
| P2-7d | SSE 端点 `/ai/chat` + AI 路由 + AppContext 扩展 | 后端 | ✅ |
| P2-7e | Tier-2 写工具（create/update_note、create_reminder、apply_update）+ draft/preview | 后端 | ✅ |
| P2-8 | AI 对话页面（聊天界面 + 草稿机制） | 前端 | ✅ |
| P2-9 | 分屏拖拽（列表↔编辑、编辑↔预览、含 FolderPanel） | 前端 | ✅ |
| P2-10 | reminder_status 清理（90 天 fired 记录） | 后端 | ✅ |

**P2 不做（延后事项）**，完整清单见 `docs/plans/p3-deferred.md`：
- 远程连接（原 P2-1）— 与 P4 migration 同步机制耦合，留到 P4
- `open_note_in_gui`（daemon→GUI 反向通道）— P3 CLI 场景再做
- 聊天持久化 + 侧栏（删 ChatTabBar 改成侧栏布局）— `docs/plans/2026-04-18-chat-persistence.md`，排在 P2-9/P2-10 后或 P3
- 特殊笔记视觉区分（pin / badge / 侧栏快捷入口）— P3
- `append_memo` 语义是否跟随 `#memo` 标签笔记 — P3
- 编辑器自动补全（tag / datetime / note-link）— P3，用户 2026-04-18 提出
- AI 聊天 → 跳转打开指定笔记（note citation / open_note 工具）— P3，用户 2026-04-18 提出
- Semantic search / embeddings — P3（P2 只做 FTS + LLM query expansion）
- AI 草稿 banner-instead-of-overwrite 方案（option C）— 暂时保留 stage-overwrite + pre_stage_content 方案

**关键设计决策：**
- AI 草稿走 SSE 响应事件，GUI 自行打开 Tab（无反向通道）
- create_note 用 `draft_<uuid>` 占位 ID，首次 Cmd+S 走 POST
- update_note dirty 冲突弹 modal 三选一（接受 AI / 保留本地 / 查看差异）
- 待办页数据 = daemon 结果 + dirty tab overlay，订阅 editorStore 自动合并

### 实施阶段总览

```
P0 ✅ → P1 ✅ → P2 ✅（10/10） → P3（CLI + 外部调用） → P4（Migration）
```

## 关键文件

- 完整计划：`docs/plans/COEDIT_PLAN.md`
- P1 设计文档：`docs/plans/2026-04-06-p1-design.md`
- Go 版问题清单：`docs/reference/ISSUES_FROM_GO.md`
- AI 搜索模式参考：`docs/reference/AI_SEARCH_PATTERNS.md`
