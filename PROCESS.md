# 开发进度

## 当前阶段：**Stage 1 #4 0.6 本地功能 ✅ 全部完成**（设计 `docs/plans/2026-07-16-0.6-local-features.md` **v3.4**，6 轮 review；顺序 ①→③→④→②）。**① 本地同步状态 ✅ + ③ 会话隔离原语 ✅（+「脏标签切换防护」）+ ④ web session UX ✅ + ② W7 冲突手动解决/合并 ✅ 均完成 + GUI/真 rig 手测通过**（①③=2026-07-21，④②=2026-07-22）。**⭐ Stage 1 #5 移动端兼容 web UI 实施中**（设计 `docs/plans/2026-07-22-mobile-web-ui.md` v7 + §15 实施记录；Phase 1 前端本地，直接提 main 逐步小 commit）：**Step 1–4 ✅ 完成**（`20b7339` useIsMobile+Sheet · `13be269` 分壳+AppRoutes[+`/note/:id`]+DndContext 提层 · Step 3 导航契约核心 4 commit = `89960cf` SaveResult 判别联合 / `8cd0d57` loadNoteById+mobileMode+draft-alias / `b3e57a7` note-nav-guard+useOpenNote / `b1ee33c` events-core/MessageBubble/NoteAppliedToast 接 opener · `2b4bd20` 移动导航壳[TopBar 两态/BottomNav/更多 sheet/FolderDrawer/FolderPanel+SyncStatusBar drawer variant]），gui 519→**566**、桌面零回归。**下一步 = Step 5 EditorPage master-detail**（`/`列表全宽 + `/note/:id`编辑全宽，解移动端窄文件列表）→ Step 6 单栏 Settings/Login/AI → Step 7 移动冲突 UI → Step 8 触摸打磨 → Step 9 浮动 TagBar → Phase 2（PWA + docs）。**#1 owl-server ✅ + #2 A6 local CSRF ✅ + #3 重构一轮 ✅**（三者已 push origin/main，2026-07-16，13 commit `95c21bb`…`cac23dd`）。Phase A 核心 A0–A5 + Phase B 网页版 v1（B0–B4）+ Aω 1a 本地云 rig 均已完成并 push。基线：core **542**/cli **139**/daemon **431**/gui **519**/e2e 29(0-fail)/`just check` 9 守卫。

**0.5.0**（per-profile 隔离 + 免密快切）已公开发版（2026-06-06）。**扩生态 Step 0** 已全部完成（2026-06-12，renderer/Electron 解耦 + `@orpheus-aviary/owl-shared`）。
**Phase A = 云端 daemon** 核心 slice **A0–A5 已完**（cloud/local 模式 + 端点鉴权 + 两层会话 + `/auth/*` + config redaction）；
剩 A6（触桌面全客户端，闭 local CSRF）· Aω（**已一分为二**：owl-server 本地打包=Stage 1，上云=Stage 2）。
**Phase B = 网页版**（`apps/web` 瘦客户端复用 renderer 树）。子设计 → `docs/plans/2026-06-14-phase-b-web-design.md`（v1，⭐1/2/3/4/7 已拍板）。

- **Phase B B0+B1 已实现 + 全绿，main 未 push**：`d499d33` docs 设计稿 · `697afd8` **B0**（`apps/web` Vite 脚手架：
  `@` alias renderer 源 + 挂 `<App/>`；浏览器 `getPlatform()` 返 webAdapter；Tailwind v4 content + React dedupe；dev proxy；`just dev-web`）·
  `a4badee` **B1**（web auth/session：`web-session.ts` 内存态 token + `web.ts` 6 sync→真 HTTP + `requiresAuth` + `WebAuthGate` 登录闸
  复用 `LoginForm`(`hideServerUrl`) + transport `onUnauthorized` 401 钩子 + apps/web `main.tsx` 注 bearer）。
- **B1 验证**：`tsc -b` 绿 · gui **418**（+12 web auth 单测：session 生命周期/login 成败/logout/status/401/设备映射）· `just check` 9 守卫 · shared+web build。**桌面端零变更**（Electron `requiresAuth=false`，renderer 自身 main.tsx 未动）。
- **B2 乐观并发已 ship（2026-06-16，6 commit 落 `main` 未 push，手测全过）**，设计/实施记录 `docs/plans/2026-06-16-phase-b2-optimistic-concurrency.md`（v3）：
  `64d8b2f` feat(shared) `patchNote`+`expected_updated_at`（**唯一回流**；daemon 早已支持 CAS）· `e24aa2d` feat(gui) platform `remoteClient` 门 · `3bb31f4` feat(editor) editor-store CAS 基线 + 409→拉远端 · `3de0dc3` feat(editor) `VersionConflictDialog`（覆盖/加载远端/取消）+ folder-drag rebase · `0405c0e` feat(gui) `beforeunload` 脏 tab 守卫（挂 `App.tsx` 会话根，取消自动保存）· `e0cdc6d` docs。
  **ms 从 `Note.updatedAt` ISO 无损派生（未加 `updated_at_ms`）**。**保护模型 = 仅 web editor save**（web 后写者 409；桌面后写仍 LWW + conflict_record，刻意取舍）。
- **B2 验证**：gui **434**（+16：12 editor-store CAS + 4 unload guard）· `just check` 9 守卫/biome/`tsc -b` · `pnpm -r build`+web build · daemon 394/core 529/cli 137 不变 · **云端 rig 手测全过**。**桌面端零回归**（CAS/guard 均 `remoteClient` 门，桌面 PATCH 字节不变）。
- **B3 XSS 硬化 实施+手测通过（2026-06-19，代码未提交）**，专档 `docs/plans/2026-06-19-phase-b3-xss-hardening.md`：
  `MarkdownPreview` web 分支（`remoteClient` 门）**去 `rehypeRaw`** → 原始 HTML 被 react-markdown 转义为文本、注入不执行（math 直通 rehypeKatex、highlight 照常、零误伤）；外链强制 `target=_blank`+`rel=noopener noreferrer`+`window.open(...,'noopener,noreferrer')`。**CSP 移 B4**。开放项 ⭐3 落定 = 去 rehypeRaw（非 rehype-sanitize）。
- **B3 验证**：gui **441**（+7：3 web XSS + 1 桌面 raw HTML 回归 + 3 外链 DOM/window.open）· `just check` 9 守卫/biome/`tsc -b`（改动 2 文件 0 warning）· `pnpm run build`（含 apps/web） · daemon 394/core 529/cli 137 不变 · **真浏览器 throwaway harness 手测全过**（注入不执行 / KaTeX+highlight 正常 / 外链 `opener===null`，测后已删 harness）。**桌面端零回归**（`remoteClient=false` 仍走 rehypeRaw，单测钉死）。
- **B4 daemon 静态托管 实施+手测通过（2026-06-19，代码未提交）**，专档 `docs/plans/2026-06-19-phase-b4-static-hosting.md`：
  daemon 用 `@fastify/static`（**`wildcard:false`**）同源托管 `apps/web/dist`（`[daemon].web_root`，相对基准 `paths.nestDir()`，set 但非目录/缺 index.html → `cli.ts` fail-fast 拒启）+ 下发 **CSP**（`script-src 'self'`/`style-src 'unsafe-inline'`(KaTeX)/`img-src 'self' data:`/`connect-src 'self'`）+nosniff+referrer。**前端 HashRouter → 无 SPA fallback**（浏览器只请求 `/`+assets，未匹配落 Fastify 默认 404）。cloud auth gate 抽 `isAuthExempt`：非 API 的 GET/HEAD = 公开 shell，**API/非 GET 仍 bearer-gated（fail-closed）**。**`API_PREFIXES` 抽 `@orpheus-aviary/owl-shared/api-paths` 单一源**（daemon+vite 共用）+ **route-coverage 测试**（全路由 ⊂ prefixes）。`web_root` 非 owner `/config` 脱敏（`PublicDaemonConfig` omit）。
- **B4 验证**：daemon **405**（+11：resolveWebRoot/assertWebRootValid/static+CSP/cloud auth-gate/route-coverage + web_root 脱敏 2 断言）· `just check` 9 守卫/biome（**20 warnings=baseline，complexity 经 `isAuthExempt` 抽取化解**）/`tsc -b` · `pnpm run build`+apps/web build · core 529/gui 441/cli 137 不变 · **curl 实测**（同源 `/`+assets+CSP、`/status`/API 未遮、missing→404）+ **真浏览器手测**（壳+assets 同源、无 CSP 违规；唯一 404=favicon，B0 起既有无关）。**桌面端零回归**（不设 web_root → 不挂 static/CSP；`isAuthExempt` local 首行放行）。
- **B1 deferred（仍挂账）**：**apps/web 接 `tsc -b` + dedup `@types/react`** 撞 monorepo project-ref 墙 → 独立小任务（功能已由 gui typecheck 全覆盖）。
- **Phase A/B 基线**：core **529** / daemon **405** / cli **137** / gui **441** + gated e2e **29**；`just check` **9 守卫**。**全部已 push `origin/main`**（上文各 "未 push/代码未提交" 字样均为当时记录，现已推送）。

### 下一步

**Phase B v1 (B0–B4) 全 ✅ 已 push；Aω 1a 本地云 rig ✅ 手测通过（2026-07-04）。用户 2026-07-04 拍板重排：「不碰真服务器就能做完的」全部先做完（含 owl-server 本地打包），公网部署 + soak + TLS + 多设备 GA 攒成发版前最后一道关卡（避免反复搭/拆阿里云 skybridge）。**

**Aω 1a 本地云 rig ✅ 已手测通过（2026-07-04）**：cloud daemon 配 `[daemon].web_root` 同源托管 web bundle（隔离 nest `/tmp/owl-aw1a` + in-proc skybridge `:8443` + owner `owner@x.test` + daemon `:47020`）→ 浏览器登录 → 渲染真实笔记，**补上 B4 没验到的「登录后内容在严格 CSP 下」全部正常**：KaTeX 字体（同源 `/assets/*.woff2`）/highlight/笔记/`/events` 同源 SSE 均未被 CSP 误伤；**唯一 CSP 拦截 = 外链图片（`img-src`），有意隐私/反追踪策略**；XSS 注入笔记转义不执行（B3 + `script-src 'self'` 双防）。curl 端 CSP 头/公开壳/API 401 fail-closed 全绿。rig 已拆。

> **⭐ 完整路线定稿（含逐 item 拆解 + 设计稿计划）= `docs/plans/2026-07-04-road-to-1.0.0.md`（源）。** 下为速览。

**Stage 1（全本地、不碰真服务器，发版前先做完；建议顺序，#4/#5 可互换）：**

1. **✅ owl-server 本地打包 + 本地 rig 跑通（2026-07-05 完成，代码未提交）**：`@orpheus-aviary/owl-server`（tsup bundle daemon+core+shared，内嵌 web dist+migrations+sample，**默认端口 47020**，抽 daemon `boot(options?)`，`argv[2]` 派发 compute-owner/boot，`resolveServerConfig` 强制 cloud+fail-closed，内嵌 web 走 `ctx.embeddedWebRoot` 不入 toml）+ favicon。**本地 rig（配置省略 port/web_root）+ clean-install smoke（`npm pack`→temp `npm install`→better-sqlite3 native 编译）全绿**：47020 缺省/同源托管包内 web+严格 CSP/登录/建笔记/fresh-nest migration/SSE 全过。`just test-daemon` 405 零回归、`just check` 9 守卫全绿。**只差公网。** 专档 `docs/plans/2026-07-04-owl-server-packaging.md`（§6 实施记录 + fastify dual-identity 等踩坑）。
2. **✅ A6 local CSRF 完成并 push（2026-07-15，S0–S9 共 11 commit `5d6107b`…`d22a350`）**：local daemon 除 `GET /status` 外全要 `Authorization: Bearer <token>`（daemon 内存生成→listen 后同步原子发布 0600 文件 `<nest>/owl/daemon-token`；CLI/GUI-main 读文件、preload[sandbox:false]读文件暴露 proxied `getDaemonToken()`、renderer getAuthHeaders fresh-read；`buildServer` fail-closed；`pid.ts:acquireDaemonLock` 原子 wx；web host 改 **cloud-only**[browser=cloud，local 不托管壳]；`/status` 加 `mode`+local-only `pid`/`local_auth_version`[owl-shared `LOCAL_AUTH_VERSION`]；GUI 旧 daemon 检测[tri-state+`/status.pid` 证身份+原生 dialog]；dev-web vite mode 预检 fail-fast）。**关跨站 simple-POST CSRF + null-origin GET 读泄露**（sandboxed iframe 读 `/config` api_key）。全绿 core **532**/cli **139**/daemon **420**/gui **455** · `just check`+`just test` · **curl 实测**（无 token→401 `LOCAL_TOKEN_REQUIRED`/带 token→200/token 0600）+ **GUI 手测通过**（正常启动/CRUD/AI/同步状态，请求达 handler 非 401）。专档 `docs/plans/2026-07-15-a6-local-csrf.md`（v5+§7 实施记录，四轮 review 收口）。**⚠️ 破坏性变更**：旧 CLI/GUI/curl/第三方本地 API 集成升级前无法访问新 daemon（须带 token 或升级）；browser↔local-daemon 不再支持（用 cloud）；**升级后须重启 daemon**。**待补（不阻断）**：完整 dev-web-cloud rig（`scripts/dev-web-cloud.sh`，deferred 到整体调试）· A4 off grace-quiesce（留重构轮）· 可选守卫 `check-local-token-not-logged`。
3. **✅ 重构一轮完成并 push origin/main（2026-07-16，13 commit `95c21bb`…`cac23dd`）**：设计+实施 `docs/plans/2026-07-15-refactor-round.md`（§9 实施记录）。**复杂度 warning 22→0**（4 batch + peel migrate/edit/TagBar）· **类型 mirror dedup**（config 类型单一 Node-free 源 `@orpheus-aviary/owl-shared/config-types`，core re-export；修 shared 缺 `sync` 的漂移）· **3 个 >800 大文件全拆**（`sync-auth` 1043→615+4 sibling[queue/crypto/transport/renewal，getCurrentExpiresAt getter]·`sync/engine` 1041→378+apply/lww·`editor-store` 846→650+editor-tabs；**全仓再无 >800 非测试源文件**）· **B1**（apps/web 进 `just check` 独立 `tsc --noEmit`——**修正「双 @types/react」错误前提=实为 composite/rootDir 结构墙**）。全绿 core **532**/cli **139**/daemon **420**/gui **455**+e2e 0-fail/`just check` 9 守卫。行为保持型，靠 pinning 测试兜底。**⚠️ 已知：`just` `ensure-node-abi` recipe 的 `.pnpm/better-sqlite3@*` glob 在 hoisted 布局下失配（本轮手动 rebuild 绕过）——留 chore 修。**
4. **⭐ 0.6 本地功能实施中（设计 `docs/plans/2026-07-16-0.6-local-features.md` v3.4）**（**跨 profile 视图已移出 → 1.0.0 后**）；实施顺序 **①→③→④→②**：
   - **① 本地同步状态 ✅ 完成 + GUI 手测通过（2026-07-21）**：`probeStatus` 三态（pending/ok/unreachable）+ bar 四分支 + shared `subscribeSse` exactly-once `onDisconnect({error,clean,usedToken})`（移除 `onError` 恢复依赖，逐 `connectOnce` 捕获裸 token）+ SSE `hello`/`onDisconnect` 重探 + `fetch()` single-flight。**手测暴露并修正判据 bug：账号判据 = 已注册（`device_id && workspace_id`），非 `server_url≠null`**（dev 残留 `[server].url` 让 server_url 非空 → 误显「已同步」；未注册 popover 亦不显手动同步按钮）。gui **473**（+18）· `just check` 9 守卫全绿。触 GUI(renderer)+**shared**。
   - **③ 会话隔离原语 ✅ 完成 + GUI/真 rig 手测通过（2026-07-21）**：`stores/session-epoch.ts`（epoch/phase + `currentGen`/`isStale`；`beginInvalidate`/`beginBootstrap`/`endBootstrap`）+ 11 store `reset()` + **全异步写回 gen-guard**（fetch/mutation/stream/bus-bump，逐 await `if(isStale(gen))return`）+ `note-id-refs` `resetNoteIdCaches`（pending 按 Promise 身份删）+ `stores/reset.ts` `resetAllStores`（单一清理所有者）+ `session/bootstrap.ts`（唯一可等待 cold-start 入口）+ `session/session-actions.ts`（`invalidateSession`/`activateSession`）+ `<SessionCoordinator>`（唯一探针，StrictMode `useRef`；桌面 `bootstrapSession(0)`）+ `<BootstrapOverlay>`（`phase==='bootstrapping'`）+ `App` 拆 `NormalSessionShell` + `key={epoch}` 会话根 + `MainApp` 删 mount fetch + `onProfileSwitched → activateSession()` **替 `location.reload()`** + EventsSubscriber/`handleNoteDrop`/TrashPage/Browser·Reminders/pin 全 gen-guard。**真 rig 手测**（本地↔账号切换无白屏 reload、overlay、同步条翻转、无串号、SSE 重订）。**未用的 `guarded` helper 已删**。**手测新增「脏标签切换防护」**（§4.8）：`stores/switch-guard.ts`（三选一 `request()`）+ `<SwitchUnsavedDialog>` + 3 入口门控（SyncSection 登录/登出 · SyncStatusBar 快切）。gui **490**· `just check` 9 守卫全绿。触 GUI(renderer)。
   - **④ web session UX ✅ 完成 + 真 web-cloud rig 手测通过（2026-07-22）**：`web-session` token-only 持久（opt-in `sessionStorage`）+ `probingToken` 复水探针（token 绑定单飞）+ `clearWebSession` 无条件清 storage；transport `onUnauthorized({usedToken})` 契约 + web REST/SSE 401 比 `getWebSession()?.token` 失活；`activateWebSession` 唯一激活入口（begin→reset→发布 bearer→bootstrap，**不重置路由**=复水保留 deep-link）+ `SessionCoordinator` 复水分支替 ③ interim 桥；「记住我」勾选 + `LoginAndOpenSessionInput.remember`。gui **505**（+15）· `just check` 9 守卫全绿。新增手测 rig `scripts/dev-web-cloud.mjs` + `just dev-web-cloud`（in-proc skybridge + cloud daemon 同源托管 `apps/web/dist`；顺带修 `ensure-node-abi` hoisted-glob 活坑）。触 GUI(web/renderer) + **shared**（transport 契约 + login 类型）。
   - **② W7 冲突手动解决/合并 ✅ 完成 + GUI 手测通过（2026-07-22）**：core `resolveConflict(db,sqlite,id,args)` 独占外层 `.immediate()` 事务（SELECT→`pickResolvedContent`→原子抢占 `resolved_at`→`updateNote` CAS+`rejectIfTrashed`，抢占先于写笔记、失败一路回滚）+ 4 typed error（trash 复用 `AlreadyTrashedError`）+ `ConflictResolution` 扩 local/merged；daemon `POST /conflicts/:id/resolve`（纯校验 400 → core[事务外] → 200/404/409/422+emit，`resolved:false` 幂等 200）；shared client；GUI `ConflictsPage`（用本地覆盖/手动处理…/采用远端）+ `ConflictMergeDialog`（**callback ref 构造** 绕 radix Portal 时序 + content-height + 深色 gutter）+ `refreshList` count 修正 + D9 脏 tab 阻止/干净 tab 刷新 + gen-guard。**UI 措辞：忽略→采用远端、合并…→手动处理…**（消歧义）。零 migration（下一号仍 0010）。core **542**/daemon **431**/gui **519**·`just check` 9 守卫全绿。**0.6（#4）全部完成。**
5. **⭐ 移动端兼容 web UI（实施中）**：响应式 + 移动导航 + 触摸 + PWA（**不是 RN**；RN 是 1.0.0 后单独 app）。设计 `docs/plans/2026-07-22-mobile-web-ui.md`（v7 定稿 + §15 实施记录）。**Phase 1 前端 Step 1–4 ✅**（useIsMobile+Sheet / 分壳+AppRoutes / 导航契约核心[SaveResult+loadNoteById+note-nav-guard+useOpenNote，桌面逐字节零回归] / 移动导航壳）；gui **566**。**下一步 = Step 5 EditorPage master-detail**（+ deferred：useEditorShortcuts Cmd+N opener、DeleteConfirmDialog delete 按来源）→ 6 单栏 → 7 冲突 → 8 触摸打磨（含 FolderDrawer 拖拽手柄）→ 9 浮动 TagBar → Phase 2 PWA。发网页版前做。

**Stage 2（发版前最后关卡，需真服务器；攒一起做）：**

- **Aω 上云 = 公网部署**：重部署 skybridge（阿里云）+ owl-server 上云 + 异地真机。**⚠️ 公网先不配反代/TLS，IP 直连 + 安全组锁源 IP**（照 `skybridge/docs/deploy/ubuntu-baota.md` 明文 HTTP）。
- **TLS/反代** · **真·24h soak** · **P6 多设备 GA** → **🎯 1.0.0**。

**1.0.0 之后**：跨 profile 统一视图（+跨账号导入，时机再议）· **完整 RN 移动 app**（Phase C 发 owl-shared → D/E）· 其余 0.6+ backlog。

> **扩生态架构定稿** → `docs/plans/2026-06-06-mobile-web-ecosystem-arch.md`（v6）。**开发流（按 2026-07-04 路线修订）**：Step 0 ✅ → Phase A ✅核心 → B 网页版 ✅v1 → **Stage 1（owl-server 打包 + A6 + 重构 + 0.6 本地功能 + 移动 web UI）→ Stage 2（上云 + TLS + soak + P6 GA）→ 🎯1.0.0** → C 发 owl-shared → D 移动 v1（RN）→ E 移动 v2。

---

## 历史归档

每个已 ship 阶段的实施细节收在对应设计文档的 `## 实施记录` 段，或 `docs/history/` 下的专题 doc：

| 阶段 | 位置 |
|---|---|
| P0 / P1 基础搭建 | `docs/history/P0-P1-shipped.md` |
| P2 功能完善 | `docs/history/P2-shipped.md` |
| P3.0.5 pre-release polish | `docs/history/P3-0-5-shipped.md` |
| P3.1 GUI 0.2.0 首发 | `docs/plans/2026-04-28-p3-1-gui-0.2.0-release-design.md` § 实施记录 |
| P3.2-a~d / P3.2.5 | 对应 `docs/plans/2026-04-29`…`2026-05-03-*.md` § 实施记录 |
| P3.3 0.3.0 发版 | `docs/history/P3-3-shipped.md` |
| P3.4 UX + P4 skybridge Phase 1+2 + 0.4.0 发版 + 0.4.1 hotfix | `docs/history/P3-4-P4-shipped.md` |
| P5-a 单机 sync engine（内部 2026-05-22） | `docs/history/P5-a-shipped.md` |
| P5-b 多 entity + SSE + GUI（内部 2026-05-24） | `docs/history/P5-b-shipped.md` |
| P5-c 后台 + retry + conflict + token-mask（内部 2026-05-25） | `docs/history/P5-c-shipped.md` |
| **0.4.2 发版**（全局快捷键 + skybridge npm 切换） | GitHub Release v0.4.2 + `docs/history/P5-c-shipped.md` |
| **P5-d per-profile 隔离 + 免密快切 → 0.5.0 发版** | **`docs/history/P5-d-shipped.md`** + `docs/history/0.5.0-release-notes.md` |

## 关键参考

- 跨仓路线：`aviary/docs/ROADMAP.md`
- skybridge 架构框架：`aviary/docs/SKYBRIDGE_ARCH.md`
- per-profile 隔离父设计（v6 定稿）：`docs/plans/2026-05-29-account-profile-isolation-design.md`
- skybridge 本地开发/调试/发布：见 owl `CLAUDE.md` skybridge 段 + `skybridge/docs/deploy/ubuntu-baota.md`
- 历史 P3 总规划（§8 已作废）/ COEDIT 早期规划：`docs/plans/2026-04-20-p3-plan.md` / `docs/plans/COEDIT_PLAN.md`
