# 开发进度

## 当前状态：**P3.3 0.3.0 已 ship（2026-05-04）**，461/461 测试通过。GUI `v0.3.0` (GitHub Release + `Owl-0.3.0-arm64.dmg`) 与 CLI `cli-v0.3.0` (`@orpheus-aviary/owl-cli@0.3.0` on npm) 独立渠道同日发布。发布前在 npm 本地装包 smoke 中发现 `npm i -g` symlink 安装下 CLI 入口 guard 失效（`owl --version` 静默 exit 0）+ `program.version()` 硬编码 `0.3.0-dev` 脱节，两问题修复落在 commit `08e9965`，新增 spawn-via-symlink smoke test 作回归保护（CLI 测试 117 → 119）。后续 simplify round `63ddf1a`：入口 guard 加字符串相等快路径避开常见 case 的 `realpathSync` syscall + 统一 `skill export` 版本来源到 `VERSION` 常量 + 清 test 冗余 rmSync pre-block 加 `afterAll` symlink 清理。共 4 个 commit 交付：`08e9965` (fix+smoke) · `fabf142` (bump) · `24be3da` (docs) · `63ddf1a` (simplify)。

P3.2.5 release polish 已 ship（2026-05-04，3 commits `e6ff4eb`..`b49f6da`，459/459）。

P3.2-d SSE 反向通道 + `owl open` 已 ship（2026-05-03，5 commits `5168b60`..`c565955`，426/426）。

P3.2-c CLI 核心已 ship（2026-05-02，9 commits `10b8bd5`..`63a0d0b`，404/404）。

P3.2-b MigrationDialog 已 ship（2026-04-30，commit `e302838`，271/271 测试 + 真库 smoke S1-S8 通过）。

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
| **P3.2-c** CLI 核心 | apps/cli + commander + daemon-detect + HTTP/direct 双模式 + `owl migrate` + tsup bundle + publishable manifest | **已 ship**（2026-05-02，9 commits `10b8bd5`..`63a0d0b`，404/404 测试 + 真库 smoke 通过） |
| **P3.2-d** SSE reverse channel | daemon `/events` SSE + `/events/emit` + GUI EventsSubscriber + CLI `owl open` | **已 ship**（2026-05-03，5 commits `5168b60`..`c565955`，426/426 测试 + 真库端到端 smoke 通过） |

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
- **onProgress 签名占位**（增量 #3）：`MigrateOptions.onProgress` 签名已定，0.3.0 sealed hook（P3.2-b 已接入 4 phase 实时 emit，并去掉原 `pct?` 占位）
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

### P3.2-b 实施详情（2026-04-30，commit `e302838`）

基线：245/245（P3.2-a 后）。
现在：**271/271 测试**（core 108 + daemon 95 + gui 68）— core +7（migrate T16/T17 + probe PR1-PR5），gui +19（main 新增 project 12：precheck P1-P5 + ipc E1-E7；renderer +7：MigrationDialog M1-M7）。

文件改动（30 files，+2146/-432）：

| 文件 | 变动 |
|---|---|
| `packages/core/src/db/migrate.ts` | [改] `onProgress` 从 sealed 升级为 4 phase 实时 emit（backup → copy → fts-rebuild → swap，每次 `setImmediate` yield + try/catch 包住）；去掉签名里的 `pct?` 占位；新增 `MigratePhase` 类型导出 |
| `packages/core/src/db/migrate.test.ts` | [改] +T16（4 phase 有序 emit）+ T17（alreadyMigrated 不 emit） |
| `packages/core/src/db/probe.ts` | [新] `probeStartupState(dbPath)` 只读探测 `user_version` + schema 非空，`readonly: true` + `fileMustExist: true` 不创建 WAL/SHM、不 stamp |
| `packages/core/src/db/probe.test.ts` | [新] PR1-PR5：not-found / v=LATEST / v=0+空 / v=0+非空 / v=99 |
| `packages/core/src/index.ts` | [改] barrel 补 `probeStartupState` + `StartupProbeResult` + `MigratePhase` |
| `packages/gui/src/main/window.ts` | [新] `createWindow` 从 `main/index.ts` 抽出；接受 `{startupMode?, onClose?}`；startupMode 通过 `webPreferences.additionalArguments: ['--startup-mode=<json>']` 透传给 preload |
| `packages/gui/src/main/migration-precheck.ts` | [新] `runMigrationPrecheck(dbPath)` 纯映射，调 `@owl/core` 的 `probeStartupState` 产出 3 态 `StartupMode`（normal / migrate-required / incompatible）；`@owl/gui` 不直接 import better-sqlite3 |
| `packages/gui/src/main/migration-precheck.test.ts` | [新] P1-P5：mock probeStartupState 覆盖纯映射分支 |
| `packages/gui/src/main/migration-ipc.ts` | [新] `registerMigrationIpc(win, dbPath, createPostMigrationWindow)` — 5 IPC：`migration:start`（invoke）/ `:progress` / `:daemon-failed`（send）/ `:done` / `:quit`；`mapMigrationError` 命名导出为纯函数，独立可测；`:done` 成功路径 `win.destroy() + createPostMigrationWindow()`（避免 argv 污染造成 preload 死循环） |
| `packages/gui/src/main/migration-ipc.test.ts` | [新] E1-E7：5 error class + 通用 Error + 非 Error 映射 |
| `packages/gui/src/main/daemon.ts` | [改] `ensureDaemonRunning` 返回类型 `Promise<void>` → `Promise<boolean>`；失败时 `migration:done` 推 `daemon-failed` 事件，窗口不 destroy |
| `packages/gui/src/main/index.ts` | [改] `whenReady` 先跑 precheck；normal 分支 daemon + createWindow；其它分支 createWindow({startupMode}) + registerMigrationIpc；`onClose` 抽到顶层函数供两条路径共享 |
| `packages/gui/src/preload/index.ts` | [改] 解析 `process.argv` 中 `--startup-mode=<json>`；暴露 `startupMode` + `migration.{start, onProgress, onDaemonFailed, done, quit}`；malformed JSON 兜底 normal |
| `packages/gui/src/renderer/src/App.tsx` | [改] 顶层分流：mode ≠ 'normal' 渲染 `MigrationDialog`，否则 `MainApp`；无 Router |
| `packages/gui/src/renderer/src/MainApp.tsx` | [新] 原 App body 整体搬来（HashRouter + DndContext + 侧栏 + Routes 7 页），仅把函数名改为 `MainApp` |
| `packages/gui/src/renderer/src/pages/MigrationDialog/` | [新] 4 屏状态机：`index.tsx`（container）+ `ConfirmScreen` / `RunningScreen`（4 步 lucide 图标）/ `SuccessScreen`（含 daemon-failed banner 分支）/ `ErrorScreen` + `errorCopy.ts`（reason → title/body/showRetry 查表）+ `MigrationDialog.test.tsx`（M1-M7） |
| `packages/gui/src/renderer/src/types/owl-api.d.ts` | [新] `window.owlAPI` 全量类型声明；替换 `lib/api.ts:67` 的局部 `declare global` |
| `packages/gui/src/renderer/src/test-setup.ts` | [新] renderer vitest setupFiles：默认 mock `window.owlAPI` + `afterEach(cleanup)`（@testing-library/react@16 不自动清理） |
| `packages/gui/src/renderer/src/lib/api.ts` | [改] 删掉原局部的 `declare global { interface Window { owlAPI: { daemonUrl: string } } }` |
| `packages/gui/vitest.config.ts` | [改] 改成 `projects`：renderer（jsdom + `@vitejs/plugin-react` + `react`/`react-dom` 显式 alias + `dedupe` + `@testing-library` inline）/ main（node） |
| `packages/gui/package.json` | [改] 新增 devDeps：`jsdom@^25`、`@testing-library/react@^16.3`、`@testing-library/user-event@^14.6` |

关键设计决策兑现（与 design doc 对齐）：
- **只读探测下沉 @owl/core**：`@owl/gui` 不直接 import better-sqlite3，只调 `probeStartupState`；测试 `migration-precheck.test.ts` 可 `vi.mock('@owl/core', ...)` 测纯映射
- **startupMode 三态**：`normal` / `migrate-required` / `incompatible`；incompatible 跳过 confirm，直接落到 error 屏，仅「退出」按钮
- **argv 污染死循环规避**：成功后 `win.destroy()` + `createWindow()` 重建（不 `loadURL/reload`）；`registerMigrationIpc` 接受 `createPostMigrationWindow` 注入回调，避免 `migration-ipc.ts` ↔ `main/index.ts` 循环 import，同时保留红叉 hide 的 `onClose`
- **daemon 启动失败兜底**：`ensureDaemonRunning` 返 `boolean`；false 时主进程推 `migration:daemon-failed`，SuccessScreen 底部出红 banner +「再试一次」/「退出」，不 destroy 窗口防止用户没地方看错误
- **Cmd+Q 中途**：`daemonStartedByGui=false` 全程，`before-quit` 的 `stopDaemonGracefully` 无副作用；残局恢复（`owl doctor --recover`）出本阶段 scope（post-P3）
- **mapMigrationError**：命名 export，独立纯函数 7 case 单测；renderer 和 main 端映射彻底解耦
- **4 phase emit 位置**：
  - `backup`：`wal_checkpoint(TRUNCATE)` 通过后、`backupDatabase(...)` 之前（>90% 耗时花这）
  - `copy`：`BEGIN` 之后、首条 `INSERT INTO dest.*` 之前
  - `fts-rebuild`：FTS `delete-all` 之前
  - `swap`：`old.close()` 之后、首个 `renameSync` 之前
  - 每次 emit 后 `setImmediate` yield 让 IPC 消息刷到 renderer（better-sqlite3 同步，不 yield 会批量丢过去，renderer 看到时已 swap 完）
- **React 19 + testing-library hook dispatcher bug**：pnpm 严格布局会产生 2 份 react 模块实例，触发 "Cannot read properties of null (reading 'useState')"；修复组合必须 4 个都上：`plugins: [react()]` + react/react-dom 显式 alias 指向 workspace root + `dedupe` + `server.deps.inline: [/@testing-library\//]`
- **@testing-library/react@16 不自动 cleanup**：必须在 setup 文件 `afterEach(cleanup)`，否则 DOM 叠加 `getByRole` 报 multiple

验证：
- `pnpm run lint`：零错误，13 warnings（P3.2-a 基线保持）
- `pnpm run typecheck`：全 workspace 零错误
- `pnpm run test`：271/271 pass（core 108 + daemon 95 + gui 68）
- 真库 smoke S1-S8 全通过（v=1 52 条 ↔ v=0 还原 ↔ lock_file 错误 ↔ incompatible v=99 三种流程）

遗留（post-P3 / P3.2-c+d）：
- `owl migrate` 子命令 → P3.2-c
- `owl doctor --recover`（Cmd+Q 中途强杀 + `.old-pre-v0.3` 残局） → post-P3 / 0.4.0+
- 迁移进度 pct → 未来有大数据场景时再加

---

### P3.2-c 实施详情（2026-05-02，9 commits `10b8bd5`..`63a0d0b`）

基线：271/271（P3.2-b 后）。
现在：**404/404 测试**（core 128 + daemon 110 + gui 68 + cli 98）。

分 9 phase 执行，每个 phase 独立 commit（用户策略：main 直推 + phase 粒度）：

| Phase | Commit | 范围 | 测试增量 |
|---|---|---|---|
| P1 | `10b8bd5` | core CAS + AlreadyTrashedError + listHashtagTags + sqlite param for delete/restore | core +20 |
| P2 | `e57cc13` | daemon PUT 严格 + PATCH/DELETE/restore expected_updated_at + DELETE reject_if_trashed + return-note + fail(details) | daemon +15 |
| P3 | `e603cb4` | GUI: editor-store branch 3 + editTagOnNote 从 PUT 迁 PATCH；api.updateNote 删除；api.delete/restore 返回类型 Note | gui ±0 |
| P4 | `8881b94` | `apps/cli` scaffold: deps + vitest + LICENSE（tsup/manifest/justfile 延后 P8） | — |
| P5 | `e899cf8` | CLI lib: exit-codes / errors / output / tag-strict / input / daemon-detect / db-lock / config | cli +57 |
| P6 | `4d5f142` | backend 抽象: types / http (fetch mock) / direct (@owl/core) / resolve (§4.1 决策矩阵) | cli +35 |
| P7 | `591c8b4` | 13 commands + commander root + context + serializer | cli +6 |
| P8 | `63a0d0b` | tsup bundle + scripts/gen-publishable-manifest.mjs + justfile cli-smoke + README | — |
| P9 | 本 commit | verification + PROCESS.md + global flag merge fix（--id-only / --pretty / --ndjson） | — |

关键设计决策兑现（与设计文档对齐）：
- **CAS via `sqlite.transaction().immediate()`**（§4.3）：core updateNote/deleteNote/restoreNote 包裹 IMMEDIATE 事务做 SELECT + 比对 + UPDATE；并发写不会在 SELECT 和 UPDATE 之间插入
- **reject_if_trashed 默认 false**（§5.7）：GUI TrashPage / batchDeleteNotes / AI tools 的 level 1→2 升级路径不受影响；CLI opt-in 抛 AlreadyTrashedError
- **PUT 严格化 = 全替换三元组**（§5.4）：content + tags + folder_id 缺一即 400 USAGE_ERROR；GUI editor-store 从 PUT 迁 PATCH 避免炸
- **fail(details) 纯增量**（§3.3）：GUI ApiError 只读 error_code + message；daemon wire 多出的 details 字段对旧消费者透明
- **listHashtagTags 下沉 core 但 daemon /tags 路由 wire 不变**（§8 偏差）：GUI Tag / FrequentTag shape（id + tagType + tagValue + usage_count）保持；CLI HttpBackend 在反序列化时 re-shape 成 `{value, count?}`；CLI DirectBackend 直接调 `listHashtagTags`
- **backend 抽象的 9 方法接口**（§2）：commands/ 只依赖 `OwlBackend` + lib/*，不直接 import better-sqlite3 / fetch
- **stdout 紧凑 JSON 默认 + stderr 进度/错误**（§3.1、§4.6）：serialize.ts 统一 snake_case + ms timestamps + 派生 title + sigil-prefix tag 字符串
- **模式决策分 read/write**（§4.1）：decideMode 纯函数 11 测试全覆盖；daemon alive + --direct 写入需 --force 否则 DAEMON_RUNNING_BLOCKED
- **publishable 独立于 workspace**（§7.2）：workspace `@owl/cli` private；dist/package.json 写 `@orpheus-aviary/owl-cli` + bin `owl` / `owl-cli`；copy LICENSE + 0001_initial.sql

手动 smoke（HTTP + direct 双路径）：
- `owl doctor` → status=ok（env.node v24.13.0 + env.sqlite 3.49.2 + config + db user_version=1 + daemon alive）
- `owl create --stdin --tag x` + `owl get --field title` + `owl append --body` + `owl tag --add --remove` + `owl delete` + `owl restore` 全流程
- `owl delete` 已 trash 的 note → 409 ALREADY_TRASHED + details.current_trash_level
- `owl edit --if-updated-at 1` → 409 VERSION_MISMATCH + details.expected/current
- `owl search --limit 3 --id-only` → 纯 ID 流
- `owl tags list --frequent --limit 3 --pretty` → 按 count desc 的 `{value: "#x", type: "hashtag", count: n}` 列表

验证：
- `pnpm run lint`：零错误，16 warnings（+3 新：cli edit / migrate / http cognitive complexity，P1 基线 13）
- `pnpm run typecheck`：全 workspace 零错误
- `pnpm -r run test`：404/404 pass（core 128 + daemon 110 + gui 68 + cli 98）
- `pnpm --filter @owl/cli run build` → `dist/index.js` (87KB) + `dist/package.json` + `dist/migrations/0001_initial.sql` + `dist/LICENSE`
- `just cli-smoke` 通过

偏差 / 延后：
- `--human` 输出格式器 → 未实现（设计 §3.7 明确"不保证稳定解析"，为 post-P3.2-c 的可选增强）
- `owl open` → P3.2-d（需要 SSE reverse channel）
- `owl permanent-delete` + `owl trash list --level all` + `owl folders` CRUD → post-P3.2-c（破坏性 + 低频）
- `owl doctor --llm` 只标 skipped（daemon /llm/test 的 LLM 探活路径留给后续）
- `ensure-node-abi` justfile 只 rebuild `.pnpm/better-sqlite3` 不 rebuild hoisted `node_modules/better-sqlite3`（`.npmrc: node-linker=hoisted` 导致两份） → 不是 P3.2-c 范围，遇到再处理

---

### P3.2-d 实施详情（2026-05-03，5 commits `5168b60`..`c565955`）

设计文档：`docs/plans/2026-05-02-p3-2-d-events-channel-design.md`（v4，含 shutdown bug 修复 + 4 轮 review）。

| Phase | Commit | 内容 |
|---|---|---|
| docs | `5168b60` | 设计文档 v4（含 shutdown 阻塞 bug 修复） |
| P1 | `bc0ff01` | daemon events bus 模块（`events/bus.ts` + `types.ts` + 5 单测） |
| P2 | `e634d89` | daemon `/events` SSE + `/events/emit` 路由（含 `liveReplies` + `preClose` hook 防无限流 shutdown 卡死）+ `AppContext.eventsBus` 必填 + `server.test.ts` / `routes/ai.test.ts` 同步 + 7 routes 测试 |
| P3 | `f635bd4` | GUI EventsSubscriber（EventSource 订阅 + `handleDaemonEvent` 纯函数 + 5 vitest 单测） |
| P4 | `c565955` | CLI `owl open <id>`（http-only，忽略 `--direct`/`--db`；daemon 不活 → DAEMON_UNAVAILABLE；subscribers=0 → stderr warning 但 exit 0）+ 5 单测 |

**关键架构决定**：

- 协议：GET + 原生 `EventSource`（浏览器自动重连）；广播入口 POST `/events/emit`
- 事件类型：`OwlEvent` 联合（当前仅 `hello` + `open_note`，future `config_changed` 等可扩展）
- `EventsBus` 职责单一：纯 pub/sub + 错误隔离 + close，不管 SSE 生命周期
- SSE 生命周期归路由：`routes/events.ts` 维护 `liveReplies` Set + `preClose` hook 主动 `endSse`，防止 Fastify `onClose` 因无限流 handler 永不返回而卡死 `server.close()`（**不**启用全局 `forceCloseConnections`：会改动 CRUD 路由在途请求语义）
- 15s SSE keepalive comment `:\n\n`
- trashLevel > 0 的 note 拒 404：避免打开回收站 tab 造成用户困惑
- GUI 根订阅：`<EventsSubscriber />` 挂 `<HashRouter>` 内部，`handleDaemonEvent` 抽为纯函数方便单测；`openNoteById` reject 仅 console.warn 不 navigate，防 unhandled rejection

**测试增量**（404 → 426 全绿）：

- core 128 不变
- daemon 110 → 122（+5 bus + 7 routes）
- gui 68 → 73（+5 events-subscriber-core）
- cli 98 → 103（+5 runOpen）

**端到端 smoke（2026-05-03 本机实测）**：

- 真实 note id `85b846d4-...` → GUI 自动切到 `/` 并打开对应 tab，stdout `subscribers:1`、stderr 空、exit 0
- 切到第二条 note id → tab 正确切换
- 不存在的 id → `NOTE_NOT_FOUND`（exit 1）
- 软删除的 note id → `NOTE_NOT_FOUND` 且 message 含 "in trash"（exit 1）
- daemon down → `DAEMON_UNAVAILABLE`（exit 4）
- daemon up + GUI 未起 → `subscribers:0`、stderr warning、exit 0

**踩坑笔记**：

- 设计稿 v1 把 bus cleanup 挂在 `onClose`，第 4 轮 review 才发现 Fastify `onClose` 在 in-flight drain 之后跑，`/events` 无限流会卡住 `server.close()`；修正为路由本地 `preClose`（v4）
- `owl search '#<tag>'` 触发 FTS5 语法错（`#` 是保留字符）；smoke 改用 `owl search 真实`；设计文档的手动测试步骤 2 按实况走
- CLI `node apps/cli/dist/index.js` 走 tsup 产物，不是 tsc；每次改 `open.ts` 需 `pnpm --filter @owl/cli run build`

**遗留（post-P3.2-d / P3.3+）**：

- 其它事件类型（`config_changed` / `note_applied_external` / `reminder_fired`）按需补
- SSE 重连期间 renderer console 会闪 red —— `EventSource` 浏览器层行为，接受

---

### P3.2.5 实施详情（2026-05-03..04，3 feature commits + 1 docs）

设计文档：`docs/plans/2026-05-03-p3-2-5-design.md`（6 轮 review 逐条对齐：从"AI 冲突 handoff 方向"到"nvm semver 数值比较"到"test 层级拆分"都固化到了文档）。

基线：426/426（P3.2-d 后）。
现在：**459/459 测试**（core 128 + daemon 122 + gui 92 + cli 117）— gui +19 / cli +14。

| Commit | 内容 |
|---|---|
| `e389920` | 设计文档 |
| `e6ff4eb` | ① `feat(cli): add owl skill export command` — `renderOwlSkillTemplate({version})` 模板函数 + `runSkillExport(flags, deps)` handler + `apps/cli/src/commands/skill-template.ts`（内嵌 markdown，含 frontmatter / 15 命令 / exit codes）+ 14 单测（模板层 7 + 命令层 7，含反向断言 "不应含 `{success, data}` envelope"）+ commander 注册 `owl skill export --output`。默认写 `~/orpheus-aviary-nest/owl/owl-skill.md`；父目录不存在自动 `mkdir -p`。**刻意例外**：本命令 stdout 默认 human（`✓ + 路径 + 提示词`）；`--json` 切回扁平 `{path, prompt}`；`--json --human` 并存抛 `USAGE_ERROR` |
| `8dc4f40` | ② `feat(gui): detect owl CLI in Settings → 高级` — 主进程 `cli-detect.ts` 用 Node 内置子进程 `execFile`（不走 shell，argv 数组，无注入面）两次 `which owl`：第一次走 `process.env.PATH`，未命中再用 `expandPath()` 拼 Homebrew / nvm / volta / asdf / cargo / npm-global。`findLatestNvmBin` 按 `[major, minor, patch]` 数值比（规避 v9 串序到 v22 后面）。`ipcMain.handle('cli:detect', ...)` + preload `owlAPI.cli.detect()` + 新建 `CliToolsSection` 挂到 `AdvancedSection` 底部（🟢 已安装 + 路径+版本 / 🔴 未找到 + `npm install -g @orpheus-aviary/owl-cli` 复制按钮）+ 14 单测（nvm 数值排序 / PATH dedup / Windows 分隔符 / detectCli 两轮 fallback / 版本探测失败兜底） |
| `b49f6da` | ③ `feat(gui): prompt to save unsaved tabs on quit` — Cmd+Q / Quit menu / 非 macOS 红叉拦 `before-quit`，依次处理 dirty tab（Word/VSCode 风格）。**AI 冲突 handoff**：保存走 `requestSaveOrConflict`，返回 `false` + `conflictPrompt !== null` → `quit.respond(false)` 关闭 UnsavedTabsDialog，顶层 ConflictDialog 接管（不嵌套）。**"不保存"仅记意图不 mutate**：中途取消后之前选不保存的 tab 内容仍在。主进程 guard：`pendingQuitCheck` 挡重入 Cmd+Q / 10s timeout → proceed + `console.warn`（renderer 卡死时不死锁）/ `!win.isVisible()` 先 `show+focus`（dock 隐藏场景可见）/ `currentStartupMode !== 'normal'` 跳过 IPC（MigrationDialog 没挂 listener，避免白等 10s）。Store 新增 `hasUnsavedTabs` / `getUnsavedTabs`，过滤 `dirty \|\| isDraft \|\| pendingAiUpdate !== null` —— 与 `saveNote:340` guard 一致。5 store 单测（dirty / draft / pending-AI 含 dirty=false / 顺序保持 / 过滤 clean） |
| `7c560bc` | `docs(p3-plan)`: P3-plan §5 状态 header 加 P3.2.5 ship 记；§10 延后表加 "CLI 自动下载 GUI installer"（与 "GUI installer 内置 CLI" 同属签名 / Gatekeeper / 跨平台 installer 复杂度象限） |

**关键决策 / 坑**：

- `skill.ts` 模板用 TS 字符串而非 `.md` 资源 —— 避开 tsup static assets 配置；测试反向断言防回归到假的 `{success, data, message}` envelope
- `skill export` 和其他 CLI 命令的输出默认方向相反（human vs JSON）。这是**刻意**的单点例外，skill 模板里明写："note commands default to JSON; the only human-default command is `owl skill export`"
- PATH fallback 是 Electron 从 Finder / dock / Spotlight 启动的必要项 —— 不加的话，用户装了 CLI 却会被 GUI 报"未找到"
- 10s timeout 选 proceed（而非 cancel）：renderer 无响应说明编辑器状态已经保不住，继续卡不如放人出去；`console.warn` 兜底
- MigrationDialog 模式跳过 IPC：`currentStartupMode` 在 `whenReady` 里捕获，`before-quit` 早分支判断，省得 10s timeout 每次退出时阻塞
- store 契约保持：`saveNote` / `requestSaveOrConflict` 只返 `boolean`，UnsavedTabsDialog 的保存失败显示通用文案而非 `err.message`（避免拉扯 store 改造）

**验证**：

- `just check`：全 workspace 零 error，16 warnings（pre-existing，与 P3.2-d 后基线一致）
- `just test`：459/459 pass
- 手动测试：feature ① 三种输出模式 smoke 通过；feature ② `🟢 已安装 /opt/homebrew/bin/owl` + 重新检测工作；feature ③ 两 tab 选保存 / 一保存一取消 / 全干净直接退 / Cmd+W 不弹 / 红叉不弹 等场景都过
- ④ `owl skill export` 端到端（装完包敲命令）等 P3.3 发包后真实场景验证

**遗留**（post-P3.2.5）：

- CLI 自动下载 GUI installer → 已记到 P3 plan §10，post-P3 统一做
- 多 host skill 格式适配层（`.mdc` / AGENTS.md / Cline rules）→ 依目前设计，由用户把 prompt 粘给自己的 agent 由 agent 处理；future 若有需求可加 `--format` 参数
- skill export 端到端真实验证（装完 npm 包后敲 `owl skill export` 看 UX）→ 等 P3.3 npm publish 完成后做

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
