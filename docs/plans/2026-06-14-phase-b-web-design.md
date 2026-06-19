# Phase B 子设计：网页版（`apps/web` 瘦客户端）

> 状态：**v1 — ⭐1/2/4/7 已拍板；B0 ✅ B1 ✅ B2 ✅（2026-06-16 已 ship + 手测）**。下一片 = B3（XSS/CSP）。父架构 `docs/plans/2026-06-06-mobile-web-ecosystem-arch.md`（v6，§4 网页版 / §7 安全 / §12 排期 / §14 开放项）。
> **B2 实施另立专档**（含逐文件 + 实施记录 + 决策修订）：`docs/plans/2026-06-16-phase-b2-optimistic-concurrency.md`（v3）。下方 §3.3/§4/§6/§7 关于 B2 的「倾向」已被 B2 实测推翻处，见该专档为准（要点：**ms 从 ISO 无损派生、不加 `updated_at_ms`**；**取消自动保存改 `beforeunload` 守卫**；**仅回流 shared `client.ts`**，daemon 早已支持 CAS）。
> 前置：Step 0 ✅（platform adapter + shared api/SSE）· Phase A 云端 daemon 核心 A0–A5 ✅（cloud 模式 + 端点鉴权 + 两层会话 + `/auth/*` + config redaction）。
> 开发流：Step 0 ✅ → **A 云端 daemon ✅核心** → **B 网页版（本设计）** → C 发 owl-shared → D 移动 v1 → E 移动 v2。

---

## 0. 目标与非目标

**目标**：把现有 React renderer 作为**同一份代码**在浏览器跑起来，连**某一个 daemon**（云端 / 本地 localhost）当瘦客户端 —— 异地登录 + 查看 + **编辑**（v1 含编辑）。

**非目标（本阶段不做）**：
- **不重建 UI**：复用 renderer 组件/页/store，只补 web 缺的能力与硬化，不另起一套视图树（移动 RN 才是独立视图，Phase D）。
- **不发布 `@orpheus-aviary/owl-server`、不上云、不异地真机** —— 那是 **Aω**（依赖本阶段产物 + 重部署 skybridge）。本阶段 daemon 静态托管只做到「本地/LAN 可验」。
- **不做 AI 对话 web 入口**（云端 key 架构已在，排期靠后，§6 arch）。
- **不做 per-profile 多账号切换 UI**：web 连**单个** daemon（cloud 单租户 by account_lock）。profile 列表/快切是 Electron-only 能力（adapter 可选面，web 缺省 absent）。
- **不做 TLS**（明文 HTTP + 安全组锁源 IP；正式公网走 Aω 部署档 + 0.6 TLS）。

---

## 1. 现状调查（Step 0 seam 实扫，带 file:line）

Step 0 已把 web 能跑的**地基**铺好，本设计「接真值」而非重建：

| # | 件 | 状态 | 位置 / 证据 |
|---|----|------|------|
| 1 | **platform adapter** | ✅ 接口 + 双实现（electron + web stub） | `packages/gui/src/renderer/src/platform/{types,electron,web,index}.ts`；`getPlatform()` 以 `'owlAPI' in window` 运行时分流（`index.ts:16`） |
| 2 | **web adapter stub** | ✅ 在位（renderer 内） | `platform/web.ts`：`daemonBaseUrl()→''`(同源相对)、`startupMode:{mode:'normal'}`、`sync.{login,logout,status,run,devices,revokeDevice}` 现返回 `{ok:false,'网页版暂不可用'}`（**Phase B 换真 HTTP，签名不变**）；profile 切换/IPC 推送/migration/cli/shortcut/quit 故意 absent |
| 3 | **transport + bearer 钩子** | ✅ 已接 | `packages/shared/src/transport.ts`：`configureTransport({baseUrl,getAuthHeaders})`；renderer `main.tsx:12` 已 `baseUrl:()=>getPlatform().daemonBaseUrl()`、`getAuthHeaders:()=>({})`（Phase B 填 bearer）。REST(`transport.ts:74`)、SSE(`sse.ts:125/201`) 都已 spread `authHeaders()` |
| 4 | **SSE = fetch-based** | ✅ 可带 bearer | `packages/shared/src/sse.ts`：`subscribeSse`(GET `/events`)/`streamSse`(POST `/ai/chat`) 自定义 fetch loop（非原生 EventSource，能塞 header）+ 自动退避重连 |
| 5 | **renderer ↔ Electron 解耦** | ✅ 完成 + 守卫 | 首屏 `App.tsx:16` 走 `getPlatform().startupMode`；`MainApp.tsx:272` `getPlatform().sync.onProfileSwitched?.()`（可选 guard）。`scripts/check-renderer-owlapi-confined.sh` 钉死 `window.owlAPI` 只在 platform/** |
| 6 | **renderer 可独立 web build** | ✅ 无 electron import | renderer 纯 React+Vite+Tailwind v4；`packages/gui/tsconfig.web.json` 已存在（Step 0 预留 web typecheck）。entry `src/renderer/{index.html,src/main.tsx}` |
| 7 | **LoginForm 可复用** | ✅ host-agnostic | `components/settings/LoginForm.tsx`（`{serverUrl,email,password}` + `onSubmit`）；`SyncSection` 调 `getPlatform().sync.login(values)`，表单内无 IPC/safeStorage |
| 8 | **乐观并发 seam** | ⚠️ 半成品 | daemon `routes/notes.ts` PATCH **已收** `expected_updated_at?:number`；但 shared `client.ts:64` `patchNote()` **未传**该参；且 `Note.updatedAt` 是 **string(ISO)**（`shared/types.ts:27`），daemon 用 number ms → **类型未对齐**（§14 #4 警示） |
| 9 | **markdown XSS 面** | ⚠️ rehypeRaw 开 | `components/MarkdownPreview.tsx:94` `rehypeRaw`（渲染原始 HTML，无 sanitize）；桌面 sandboxed 可接受，**cloud web 必须收口** |
| 10 | **apps/web** | ❌ 不存在 | `apps/` 仅 `cli`；`pnpm-workspace.yaml` 含 `apps/*`（就位待建） |
| 11 | **per-profile pending_count** | ⚠️ 仅全局 | `SyncStatusSnapshot.pending_count` 全局有（`SyncStatusBar.tsx:204`）；无「每 profile」计数 —— **web v1 单账号不需要**，留桌面多账号 backlog |

**结论**：地基绿灯。缺口集中在 ①`apps/web` 工程不存在 ②web adapter 的 HTTP 真身 + token 存储 ③乐观并发对齐 ④XSS/CSP 硬化 ⑤daemon 静态托管。下面按 slice 拆。

---

## 2. 核心架构决策（复述 arch，锚定本设计）

1. **瘦客户端 + 与 daemon 同源**：web = 「同一份 renderer 的浏览器构建」，连**某一个** daemon。两种 web 端同包，只是 baseURL 指向不同 daemon：服务器 web（连云端 daemon，登录 + TTL）/ 本地 web（连本地 daemon localhost）。
2. **复用 renderer，不另起视图**（§13「厚后端薄视图」）：`apps/web` 是薄壳，挂 renderer 的 `<App/>`；web 缺的能力靠 webAdapter 补，**不 fork 组件**。
3. **同源免 CORS**：web 由 daemon 自托管 → 同源 → 不开 CORS。（Electron renderer 才是跨源，那条线走 A6 本地 token，非本阶段。）
4. **bearer-in-header + 内存态 token**（§7.6 / §14 #5）：免 CSRF；TTL token 抗持久 XSS。
5. **数据/逻辑沉 core/daemon，类型/api 沉 shared**：web 端只补「像素 + web 专属状态机分支（登录态 / 401 / 离线提示）」。

---

## 3. 关键设计点（含开放项）

### 3.1 `apps/web` 如何复用 renderer 树 ⭐（B0 核心决策）

renderer 当前在 `packages/gui/src/renderer/src`，web adapter 已在其内、运行时自动分流。两条路：

- **路 A（推荐，先轻）**：`apps/web` 是独立 Vite 工程，**path-alias 直接消费** `packages/gui/src/renderer/src`（自带 `index.html`+`main.tsx` 挂 `<App/>`）。复用 `tsconfig.web.json`。**优点**：零搬迁、最快起步、保持「同一份代码」字面成立。**缺点**：apps/web 耦合 gui 目录内部结构（import 路径深入 `@owl/gui` 内部）。
- **路 B（后重）**：抽 renderer 成独立包 `@owl/renderer`，gui + web 都依赖。**优点**：边界干净、消费方对称。**缺点**：一次性搬迁 + 改 gui 的 electron-vite 入口指向新包，工作量与回归面大，且**不阻塞 web 能跑**。

**倾向 = 路 A**：Step 0 已把 web adapter 放进 renderer、且建了 `tsconfig.web.json`，是「就地消费」的意图信号。路 B 作为**后续整理**（与「延后的重构一轮」编织），不进 Phase B 关键路径。**待用户拍板。**

### 3.2 web auth / session（token 存储，§14 #5）⭐

webAdapter 的 6 个 sync 方法换真 HTTP：
- `sync.login({serverUrl,email,password})` → `POST /auth/login`（serverUrl 在 web 即当前 daemon 同源；实际上 web 连的 daemon 已 `account_lock` 锁定 server_url，**serverUrl 字段对 web 冗余** → 登录表单 web 档可隐藏，只收 email/password）。成功拿 `session_token`+`expires_at`+identity。
- token 存 **内存态**（module 级变量 / zustand store），`configureTransport` 的 `getAuthHeaders` 返回 `{Authorization: 'Bearer '+token}`。
- `sync.status` → `GET /auth/session`（whoami + 滑动 expiry）/ 或 `GET /sync/status`（configured/cursor）。
- `sync.logout` → `POST /auth/logout`；`sync.run` → `POST /sync/run`（cloud daemon 后台已自动同步，web 手动 run 多为冗余，可保留按钮）。
- **401 拦截**：transport 层（或 web 壳）见 401 `SESSION_REQUIRED/INVALID` → 清内存 token + 路由到登录屏。
- **会话生命周期 UI**：未登录 → 登录屏；登录中；已登录 → 主界面；token 过期/被撤 → 回登录屏 + 提示。**登出前提醒兜未提交草稿**（§7.3）。

**token 存储决策**：**内存态**（刷新即重认证，最抗持久 XSS）vs `sessionStorage`（存活刷新、XSS 可读）。**倾向内存态**（与 §14 #5 + §7.7 云端凭据内存态一致）。代价 = 刷新页面要重登（web 用户体验略糙）。**待用户拍板**（可加「记住我」走 sessionStorage 作为后续增量）。

### 3.3 乐观并发 + 编辑（§14 #4）

web v1 含编辑，多 session/多端同账号写同笔记会**后写覆盖** → 必须乐观并发：
- **对齐类型**：`client.ts` `patchNote()` 加 `expected_updated_at?: number`（daemon 已收）。`Note.updatedAt`(string ISO) ↔ daemon number ms 的鸿沟：打开 note 时记基线 `originalUpdatedAtMs`（从何取？daemon 需回传 number ms 形态——**核对 `GET /notes/:id` 是否已带 ms 字段**，没有则补）。存 `TabState`。
- **保存**：传 `expected_updated_at=基线`；成功 → 用响应的新 updated_at 刷新基线；**409** → 拉 current + 冲突提示（复用 0.5.0 已有的冲突页/合并思路；W7 双向合并是 0.6，web 先做「拉远端 + 提示 + 选择覆盖/放弃」最小闭环）。
- **自动保存**：配置化（防丢草稿）。具体节流策略实现时定。
- **范围注意**：这条**触 shared/daemon**（client 签名 + 可能 `GET /notes/:id` 形态），是本阶段唯一回流后端的改动，需保证桌面端 PATCH 行为不变（`expected_updated_at` 不传时 = 现行为）。

### 3.4 XSS / CSP 硬化（§7.6）

cloud web 多用户共享源 + bearer 在 JS 可达 → 笔记里的恶意 HTML 一旦执行即偷 token：
- **markdown 收口**：`MarkdownPreview` 的 `rehypeRaw` 在 web 必须**关掉或 sanitize**。选型：①直接去 `rehypeRaw`（损失原始 HTML 渲染，多数笔记不需要）②`rehype-sanitize` 白名单 ③DOMPurify。**倾向 = `rehype-sanitize`**（保留富文本、白名单可控、与 rehype 链原生兼容）。需保证 KaTeX/highlight passThrough 不被误杀。**注意桌面端是否要一并收口**（桌面是 local sandbox，风险低，但统一收口更省心——待定，倾向 web-only 分支以免动桌面行为）。
- **CSP**：daemon 托管 web 时下发 CSP 头（禁 inline script eval / 限 connect-src 同源 / 限 img-src 等）。
- **bearer 只存内存**（§3.2）+ 外链策略（`target=_blank` + `rel=noopener`）。

### 3.5 daemon 静态托管（同源）

- daemon 用 `@fastify/static` 托管 `apps/web` 构建产物（同源根 `/`）+ SPA fallback（非 API 路由回 `index.html`，react-router@7 客户端路由）+ CSP 头。
- **与现路由不撞**：API 是 `/notes`、`/auth/*`、`/sync/*`、`/events`、`/config` 等具名前缀；web 静态走根 + `/assets/*`。需明确**优先级**（API 路由先注册，static 兜底）+ 别把 `/status`(public) 等遮掉。
- **mode 区分**：local daemon 也可托管（本地 web 端）；cloud daemon 托管 = 服务器 web 端。**本阶段托管在 local/LAN 验**；正式公网部署（owl-server 打包内嵌）= Aω。
- **是否进 Phase B**：托管能力本身（Fastify static + SPA fallback + CSP）值得在 B 落地以便端到端验证；但「打进发布包」留 Aω。**待用户确认托管放 B 还是 Aω。**

---

## 4. 阶段拆分（B0–B4；每片小批 commit + `pnpm -r build` + `just check` + `just test` 全绿 + commit 前确认）

| slice | 内容 | 触桌面端? | 验证 |
|-------|------|:---------:|------|
| **B0** | `apps/web` 工程脚手架（Vite+React，路 A alias renderer 树 + 自带 `index.html`/`main.tsx` 挂 `<App/>`）；web build 跑通；webAdapter 现 stub 下**只读路径**渲染（无 auth） | 否 | `pnpm --filter @owl/web build` 出静态包；`vite` dev 连本地 local daemon 渲染 UI（读路径） |
| **B1** | webAdapter 6 sync 方法换真 HTTP（`/auth/login`·logout·session·`/sync/status`·run·devices）；token 内存态 + `configureTransport` 注 bearer；401→登录屏；登录态机（未登录/登录中/已登录/过期）；复用 LoginForm | 否 | 连 **cloud daemon**：登录→bearer→CRUD 通；401→登录屏；登出；过期重登 |
| **B2 ✅** | 乐观并发：`client.ts` `patchNote` 加 `expected_updated_at`（**唯一回流**；daemon 早已支持）；ms 从 `Note.updatedAt` ISO **无损派生**（未加 `updated_at_ms`）；TabState 基线；保存传基线/刷新/409 拉远端 `VersionConflictDialog`（覆盖/加载远端/取消）；folder-drag rebase；**取消自动保存** → web `beforeunload` 脏 tab 守卫 | **仅 shared（桌面 PATCH 字节不变，`remoteClient` 门）** | ✅ 手测全过（gui 434）。详见 B2 专档 |
| **B3** | XSS/CSP：`MarkdownPreview` web 分支 `rehype-sanitize`（或去 rehypeRaw）+ 外链 noopener；bearer 内存态确认；（若 §3.5 入 B）daemon 下发 CSP 头 | 倾向否（web 分支） | 笔记注入 `<script>/<img onerror>` 在 web 不执行；KaTeX/highlight 不被误杀 |
| **B4** | daemon 静态托管（`@fastify/static` + SPA fallback + 路由优先级 + CSP）；`mode` 区分 local/cloud 托管 | 否 | daemon 起 → 浏览器开同源根 → SPA 路由通；同源无需 CORS；API 路由未被遮 |

> B3/B4 顺序可调（CSP 在 B3 还是 B4 一起下发，看 §3.5 拍板）。**响应式适配**（窄视口）：先以桌面浏览器为主，明显破版的页随手修；系统性响应式重构若需要，单列 B5（待评估，可能不入 v1）。

---

## 5. 验证（本地/LAN，无真云）

复用 Phase A rig（`just ensure-node-abi` + 隔离 nest 起 cloud daemon + 本地 skybridge）：
1. **B0**：`pnpm --filter @owl/web dev` 连 local daemon → 渲染 + 读路径（笔记列表/编辑器只读）。
2. **B1**：浏览器开 web → 登录屏 → 真密码 `/auth/login` → 主界面 → 笔记 CRUD（带 bearer）→ `/events` 实时更新到达 → 401（伪造/过期 token）回登录屏。
3. **B2**：两个 web tab（同账号）/ 或 web + 桌面 改同笔记 → 后者 409 → 拉远端 + 提示；桌面端 PATCH 不带参仍现行为。
4. **B3**：种一条含 `<img src=x onerror=alert(1)>` / `<script>` 的笔记 → web 预览不执行；含 `$x^2$`/代码块仍正常。
5. **B4**：daemon 托管 → 浏览器同源访问根 + 刷新子路由（SPA fallback）→ 不 404；`GET /status` 等 API 未被静态遮。
   - **连接/会话探针（验既有 `SyncStatusBar`，非新增）**：web 复用的 `SyncStatusBar`（`components/sync/SyncStatusBar.tsx`，挂 `MainApp.tsx:371`，无 Electron 门）已提供「不刷新即可测服务还连着 + 会话有效」的全部能力——① SSE `/events` 驱动的状态点 idle/syncing/error/**offline**（被动指示，断线 amber、恢复自动回绿）；② 弹层「手动同步」按钮 → `sync.run()` → `POST /sync/run`（主动往返），且带 bearer，过期/被撤 → 401 → `onUnauthorized` → 切回登录（`App.tsx:24`）= 顺带会话探针。**验证项**：B4 同源托管下断网/恢复 → 状态点 offline↔idle 正确切换；点「手动同步」成功刷新「最近同步」；伪造/撤销 token 后点「手动同步」→ 弹回登录屏。**结论：无需新增「测试连接」按钮**。
   - （延后增量，非 B4）：若嫌 `/sync/run` 当 ping 偏重，可加一行用 `sync.status()`（`GET /auth/session`，便宜 + 续滑动 TTL）显示「连接正常 / 会话有效至 HH:MM」；与「刷新即重登」的真正解法 **「记住我」/sessionStorage opt-in（⭐2 deferred）** 是两件事，均归 0.6 backlog。
6. （可选）LAN 档 `bind=0.0.0.0` + `allowed_hosts`，另一设备浏览器连桌面 IP（非安全上下文坑：纯 IP http 丢 SW/secure-cookie，§8 arch）。

---

## 6. 风险与护栏

- **renderer 复用耦合**（§3.1）：路 A 让 apps/web import 深入 `@owl/gui` 内部；约束 import 面（只挂 `<App/>` + `configureTransport`），别散引内部组件 → 降路 B 搬迁成本。
- **token 进 JS / XSS**（§3.4）：rehypeRaw 不收口 = token 失守。B3 必做；bearer 内存态。
- **桌面端零回归底线**：B2 触 shared/daemon（`patchNote` 签名 + 可能 `GET /notes/:id` 形态）—— `expected_updated_at` 缺省必须 = 现行为；`Note.updatedAt` 若改 ms 形态需扫所有消费方（renderer 显示/排序）。**这是本阶段最大回归面**，单独核。
- **`Note.updatedAt` string↔number**：~~倾向新增 `updated_at_ms`~~ → **B2 实测推翻**：ISO（3 位毫秒）`new Date(s).getTime()` 与库 INTEGER ms 严格无损往返（daemon `server.test.ts` 已证），故**直接派生、不加字段、不改 wire**，桌面 updatedAt 消费点零触动。
- **SPA fallback 遮 API**（§3.5）：static 必须最低优先级 + 只兜非 API 前缀；单测钉 `/status`/`/notes` 不被 index.html 吞。
- **同源 vs CORS**：web 同源免 CORS；但 dev 期 `vite dev`(5173) 连 daemon(47010) 是跨源 → 复用 A1 CORS allowlist 已含 dev origin（核对），或 vite proxy 同源化。
- **local CSRF 仍开**（A6 前）：web 同源 bearer 不受影响，但 local daemon 的 simple-POST CSRF 洞仍在（arch §15）—— 与 web 无关，A6 闭，本阶段 PROCESS/release notes 续标。
- **刷新重登体验**（内存态 token）：可接受度待用户定；不行则 sessionStorage 增量。

---

## 7. 开放项（⭐1/2/4 已拍板 2026-06-14；3/5/6 倾向，实施时定）

| # | 项 | 结论 |
|---|----|------|
| ⭐1 | renderer 复用机制（§3.1） | **✅ 已定 = 路 A**：apps/web alias 消费 `packages/gui/src/renderer/src`（不抽包）。理由：Step 0 已铺 `platform/web.ts`+`getPlatform()`+`tsconfig.web.json` = 「就地消费」意图；抽 `@owl/renderer` 会把 B0 从「验证第二宿主」变成「搬家 + 回归 Electron」，收益不抵风险。抽包留后续整理。 |
| ⭐2 | token 存储（§3.2/§14#5） | **✅ 已定 = 内存态**（B1 默认）。理由：web 最大风险非刷新重登，而是 XSS 后 token 被长期拿走；内存态砍掉持久化攻击面。sessionStorage 仅作后续「记住我」**显式**选项，不做默认。 |
| ⭐4 | daemon 静态托管放 B 还是 Aω（§3.5） | **✅ 已定 = 托管能力进 B4**（验同源 / SPA fallback / CSP / API 路由优先级等真实路径，否则 B1–B3 都在 dev server 半真环境跑）。「打进 `owl-server` + 上云 + 发布包」留 **Aω**，B4 不提前拖入发布复杂度。 |
| ⭐7 | 正式版端口约定（B4/Aω） | **✅ 已定 = 云端 `owl-server` 默认 `47020`（= 47010 + 10）**；**桌面本地 daemon 保持 `47010`**（0.5.0 已发版，GUI 自启动 / CLI 默认 / 存量安装钉死，不改）。理由：同机并跑桌面 owl + 本地 web-serving daemon 免撞口、「+10」好记。真上公网仍塞反代（443/80）+ 显式配端口，47020 只是服务版缺省。**B4/Aω 时落地（owl-server 打包/部署默认 + 部署文档），不阻塞 B1–B3。** |
| 3 | XSS 收口选型（§3.4） | 倾向 **`rehype-sanitize`** web 分支；桌面端是否一并收口（倾向否，免动桌面行为）。B3 定。 |
| 5 | 响应式重构范围 | 桌面浏览器优先，破版随手修；系统性响应式若需 → B5 单列（可能不入 v1）。 |
| 6 | `Note.updatedAt` 对齐方式（§3.3 风险） | **✅ 已定（B2）= 从 ISO 派生**（`new Date(updatedAt).getTime()`），**不新增 `updated_at_ms`**、不改 wire。理由：ISO 3 位毫秒与库 INTEGER ms 无损往返；新增字段反而触 core/daemon 全序列化路径。 |

---

*（v1，§7 ⭐1/2/4/7 已拍板 2026-06-14。按 §4 slice 拆 commit，B0 ✅ B1 ✅ B2 ✅（2026-06-16）。下一片 = B3 XSS/CSP。B2 细节见 `2026-06-16-phase-b2-optimistic-concurrency.md`。）*
