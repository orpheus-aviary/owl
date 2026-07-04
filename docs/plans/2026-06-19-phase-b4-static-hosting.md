# Phase B4 子设计：daemon 静态托管（`@fastify/static` + CSP；HashRouter 无需 SPA fallback）

> 状态：**已实施 + 手测通过（2026-06-19，代码未提交）**。实施结果见文末 §7。（v3 → ship：`@fastify/static` `wildcard:false` + `API_PREFIXES` 走 shared `./api-paths` subpath + startup-guard `statSync` try/catch→DaemonStartupError + 父设计 "SPA fallback" 表述已同步作废。）
> 父设计 `docs/plans/2026-06-14-phase-b-web-design.md` §3.5 / §4(B4) / ⭐4·⭐7；架构 `2026-06-06-mobile-web-ecosystem-arch.md` §7/§8。
> 前置：B0 ✅ B1 ✅ B2 ✅ B3 ✅。本片之后 → Phase B 收尾 / Aω。

---

## 0. Context（为什么做）

web 客户端（`apps/web`）现只能在 vite dev server（:5274，proxy→daemon）跑 = 半真环境。B4 让 **daemon 自己同源
托管 web 构建产物**，端到端验证只有真实同源托管才暴露的路径：同源免 CORS · **B3 deferred 的 CSP 头落地** ·
API 路由优先级（静态不遮 API）· cloud 下「静态 shell 公开 / API 仍 bearer-gated」。⭐4 已定**托管能力进 B4**；
「打进 `owl-server` + 内嵌 + 上云 + 发布包」留 **Aω**。

---

## 1. 现状调查（file:line）

- **`buildServer`**（`packages/daemon/src/server.ts:37`）：CORS → Host preHandler（`:61`）→ **auth preHandler（cloud-only，`isPublicPath` 旁路，`:75`）** → switch-gate（`:98`）→ `setErrorHandler`（`:116`）→ 注册 11 路由组（`:135-145`）。**无 `setNotFoundHandler`**（Fastify 默认 404）。`cli.ts:174` listen `{host:bind, port}`。
- **`isPublicPath`**（`auth.ts:164`）：严格 allowlist，仅 `GET /status` + `POST /auth/login`。
- **⚠️ 前端是 `HashRouter`**（`MainApp.tsx:52/317/428`）：路由是 `/#/browser`、`/#/todo`、`/#/settings` 等——**hash 段不进 HTTP，浏览器永远只请求 `/`（+`/assets/*`）**。→ **SPA fallback（notFound→index.html）对现状无必要**（刷新任何 hash 路由，浏览器都只重取 `/`）。
- **`DaemonConfig`**（`core/src/config/index.ts:45`）有 `mode/bind/port/public_url/allowed_hosts/...`，**无 `web_root`**；default `{port:47010, mode:'local', bind:'127.0.0.1'}`。**`assertDaemonStartupSafe(config,opts)`**（`startup-guard.ts:73`）= 现成 fail-fast 校验点。
- **`redactConfig`**（`core/src/config/index.ts:298`）：owner→原样；**非 owner 仅剥 `llm.api_key`，其余字段（含未来 `web_root`）原样透出**（`config.redaction.test.ts:122` 钉死 `public_url` 透出）。shared 侧有镜像 `OwlConfig`（`shared/types.ts:129`，daemon 段镜像 core `:137`）+ `PublicOwlConfig`（`:177`）。
- **`@fastify/static`** 非依赖（daemon 仅 `@fastify/cors`+`fastify`）→ B4 加。web build → `apps/web/dist`（`index.html`+`assets/`）。
- **`apps/web/vite.config.ts`** 维护 `API_PREFIXES`（15 条）；daemon 仅 `@owl/core`、apps/web 仅 `@orpheus-aviary/owl-shared`——**owl-shared 是两侧唯一公共可达包**（mobile-safe，纯 const 数组合规）。

---

## 2. 决策（v1 review 已拍板）

- **⭐A web dist 定位/开关 = 新 `[daemon].web_root?: string`**（不用 env）。**绝对路径原样；相对路径基准写死 `paths.nestDir()`（非 cwd）**。**unset → 跳过托管**（桌面 GUI daemon 不设 = 零变更）；**set 但「非目录 / 缺 `index.html`」→ `assertDaemonStartupSafe` fail fast 拒启**（不静默退回 API-only）。同步：shared `OwlConfig` 镜像 + 脱敏（⭐D）+ startup-guard/config 测试。
- **⭐B CSP = hand-rolled 单头**（无新依赖）。`style-src 'self' 'unsafe-inline'` 在 React/KaTeX/动态 style 现实可接受。**`img-src 'self' data:` 会阻断 markdown 外链图片 → 有意的隐私/反追踪 + 防混合内容策略，文档写明**（日后要外链图可放宽 `https:`，权衡另议）。
- **⭐C cloud auth gate = API-prefix gating，但收紧 fail-closed + 真单一源**：
  - **method 限制**：cloud 下 `isPublicPath` 放行；**`!isApiPath(url) && (GET|HEAD)` 才放行静态 shell**；**其余（含未来 `POST /upload` 这类不在 prefix 的写请求）继续要 bearer** → fail-closed，不是 fail-open。
  - **`API_PREFIXES` 抽成真单一源**放 `@orpheus-aviary/owl-shared`（daemon 加 `owl-shared` 依赖消费 + vite.config 改 import 同一份）→ 构建期复用、消除漂移（非靠注释互指）。
  - **route 覆盖测试**：枚举 daemon 全部注册路由，断言每条非静态路由都被 `isApiPath` 命中（或属已知 public）→ 新增 API 漏配 prefix 时**测试红**，安全模型有机器保证。

---

## 3. 设计

### B4.1 依赖 + 配置 + 校验
- 加 `@fastify/static`（daemon package.json）；daemon 加 `@orpheus-aviary/owl-shared` 依赖（消费 `API_PREFIXES`）。
- `DaemonConfig` 加 `web_root?: string`（`core/src/config/index.ts`，注释 + default 不设）+ shared `OwlConfig.daemon` 镜像加同字段（owner 可见）。
- **`resolveWebRoot(config)`**：`web_root` 为绝对路径→原样；相对→`resolve(paths.nestDir(), web_root)`。
- **startup-guard**（`assertDaemonStartupSafe`）：`web_root` set 时 **try/catch** 校验——`statSync(resolved)` 不存在会抛**普通 fs error**，而 CLI 只对 `DaemonStartupError` 友好拒启 → 用 try/catch 把「路径不存在 / 非目录 / 缺 `index.html`」**统一转成 `DaemonStartupError('[daemon].web_root must be a directory containing index.html')`**（捕获 ENOENT 等并 rethrow 为 DaemonStartupError）。

### B4.2 `API_PREFIXES` 单一源（owl-shared `./api-paths` subpath）
- 新 `packages/shared/src/api-paths.ts`：`export const API_PREFIXES = [...] as const`（15 条，从 vite.config 迁来）+ `export function isApiPath(url: string): boolean`（`const p = url.split('?')[0]; return API_PREFIXES.some(x => p === x || p.startsWith(x + '/'))`）。**纯常量/纯函数，无 fetch/DOM**。
- **shared package.json 加 subpath export** `"./api-paths": { types: "./dist/api-paths.d.ts", default: "./dist/api-paths.js" }`，并由 `index.ts` 也 re-export（web/renderer 仍可从根 import）。
- **daemon 只 import 纯常量**：`import { API_PREFIXES, isApiPath } from '@orpheus-aviary/owl-shared/api-paths'`（**不顺带加载 shared 的 transport/sse/client**）。daemon **加 `@orpheus-aviary/owl-shared` 依赖** + **`packages/daemon/tsconfig.json` references 加 `../shared`**（现仅 `../core`，`:9`）；`just build-daemon` / `just test` **须先 build shared**（`tsc -b` 项目引用会自动按序，但确认 build-daemon 链含 shared）。
- `vite.config.ts` 改 `import { API_PREFIXES } from '@orpheus-aviary/owl-shared'`（删本地副本）。
- daemon `server.ts` auth gate + route-coverage test 用同一 `isApiPath`。

### B4.3 静态托管（注册在 11 路由组**之后**；**无 SPA fallback**）
- `const webRoot = resolveWebRoot(ctx.config); if (webRoot) app.register(fastifyStatic, { root: webRoot, wildcard: false, index: 'index.html' })`。
  - **必须 `wildcard: false`**（⚠️ 默认 `true`）：默认会注册 `GET /*` 通配，导致 `GET /notes/a/b/c` 这类**无匹配 API GET 先落静态通配 → 返回静态 404**，篡改现有 Fastify 默认 404 行为。`wildcard:false` 让 static 只服务实际存在的文件，未匹配落回 Fastify 默认 404（API 行为不变）。
  - **若 `wildcard:false` 不稳定服务 `/`**（实现时实测）：显式补 `app.get('/', (_req, reply) => reply.sendFile('index.html'))`（参考 @fastify/static README）。
  - **路由优先级**：具名 API 路由先注册→命中优先；static 服务 `/`→`index.html`、`/assets/*` 等实际文件。
  - **不设 `setNotFoundHandler`**：HashRouter 下浏览器只请求 `/`+`/assets/*`，无 deep-link 需兜底；`GET /assets/missing.js` 自然 **404**（保持 MIME 正确、不被 index.html 吞，免缓存排查坑）；API 未匹配 404 **行为不变**。
  - **测试钉死**：`/`→index.html · `/assets/<existing>.js`→200 · `/assets/missing.js`→404 · `GET /notes/a/b/c`→Fastify 默认 404（非静态、非 index.html）。
- **unset web_root → 完全不注册 static**：行为与今天一致（桌面 GUI daemon 零回归）。
- **BrowserRouter 迁移 = 明确不在 B4**：要迁需先解决页面路径 vs API prefix 命名冲突（`/ai`·`/reminders` 撞 API；页面是 `/todo` 而 API 是 `/todos`）+ 加 SPA fallback——留后续（B5/0.6 评估）。

### B4.4 cloud auth gate 放行静态（`server.ts:75` preHandler 改）
```
if (ctx.config.daemon.mode === 'local') return;          // 桌面零变更
if (isPublicPath(req.method, req.url)) return;            // /status · /auth/login
const m = req.method;
if (!isApiPath(req.url) && (m === 'GET' || m === 'HEAD')) return;  // 静态 shell/assets 公开
// 其余（API prefix，或非 GET/HEAD 的非 API）→ 要 bearer（fail-closed）
const token = bearerToken(...); ...
```
- 效果：cloud 下 `/`+`/assets/*` 200 公开；`/notes` 等 API 无 bearer→401；未来 `POST /upload`（不在 prefix）非 GET→仍要 bearer。**local preHandler 仍首行 return**。

### B4.5 CSP + 安全头（hook 下发，仅 web_root 启用时）
- `Content-Security-Policy`：`default-src 'self'`；`script-src 'self'`（Vite prod 外链 bundle，无 inline/eval）；**`style-src 'self' 'unsafe-inline'`**（KaTeX 内联 `style=` + React/Tailwind 内联，必需）；**`img-src 'self' data:`**（**外链图被阻断 = 有意隐私/反追踪策略，已记录**）；`font-src 'self' data:`（KaTeX woff2 自托管）；`connect-src 'self'`（同源 REST + fetch-based SSE `/events`·`/ai/chat`）；`object-src 'none'`；`base-uri 'self'`；`frame-ancestors 'none'`。
- 顺带 `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer`。

### B4.6 `web_root` 脱敏（⭐D，P2 review）
- `web_root` 是服务器文件系统路径——**cloud 非 owner 投影必须隐藏**（防泄露部署结构）。`redactConfig` 非 owner 分支额外 **omit `daemon.web_root`**；`PublicOwlConfig`（core + shared 镜像）反映 daemon 段无 `web_root`；owner 仍可见。`config.redaction.test.ts` 加断言：非 owner `web_root===undefined`、owner 透出。

### B4.7 mode local/cloud 均可托管
- 托管 mode-agnostic（local=本地 web 端 / cloud=服务器 web 端）；auth 差异已由现有 preHandler 处理。

---

## 4. 不在范围

- **owl-server 打包 + 内嵌 dist + 上云 + 发布包** → **Aω**（**2026-07-04 已拆**：owl-server 本地打包 = Stage 1；上云 = Stage 2；见 `2026-07-04-road-to-1.0.0.md`）；**⭐7 owl-server 默认端口 47020** = 打包默认（B4 仍用 config `port`）。
- **BrowserRouter 迁移 + SPA fallback**（命名冲突未解）→ 后续。**TLS/反代** → Stage 2。~~**响应式** → 不做。~~ → **2026-07-04 推翻**：响应式/移动端兼容 web UI = **Stage 1 确定交付项**（见 road-to-1.0.0 #5）。

---

## 5. 验证

1. **build**：`pnpm --filter @owl/web build` → `apps/web/dist`。
2. **托管 daemon**（隔离 nest，`web_root` 指 `apps/web/dist` 绝对路径；先 local 后 cloud）：
   - 浏览器开**同源 root**（daemon port，非 vite）→ UI 渲染、登录态（cloud）。
   - **刷新（含 hash 路由 `/#/settings`、`/#/todo`）→ 浏览器重取 `/`→index.html，不 404**（HashRouter 预期）。
   - `curl -I` 看 **CSP + nosniff 头**；`GET /status`、`/notes`(cloud 带/不带 bearer)→**API 未被静态遮**、无 bearer→401 有→200；`GET /assets/missing.js`→**404 非 index.html**。
   - 种 B3 XSS 笔记 → 注入不执行（去 rehypeRaw）+ CSP 双重；外链图被 `img-src` 挡（预期）。
   - **同源无 CORS** 预检失败。
   - **连接探针（设计稿 §5.5）**：同源托管下验既有 `SyncStatusBar`——断网/恢复 offline↔idle + 「手动同步」往返 + 撤 token→弹登录。**无需新增测试连接按钮**。
3. **测试**（daemon `node:test`，build-before-test）：
   - **route 覆盖测试**：用 `onRoute` 收集器重跑各 `registerXRoutes(app,ctx)`，断言每条路由 `isApiPath(url) || isPublicPath`（漏配 prefix→红）。
   - **auth gate**：cloud 无 bearer `GET /` 与 `/assets/x` →放行；`GET /notes`→401；**`POST /not-an-api`（非 prefix 非 GET）→401（fail-closed）**；local 全放行。
   - **static**：web_root 设→`/`→index.html、`/assets/*` 命中、`/assets/missing.js`→404；**未设→不注册 static（回归）**。
   - **startup-guard**：`web_root` 指非目录 / 缺 index.html → `assertDaemonStartupSafe` throw。
   - **redaction**：非 owner `daemon.web_root===undefined`；owner 透出。
   - **CSP**：web_root 启用响应带 CSP 头。
   - **shared parity 顺带**：`API_PREFIXES` 单一源后 vite 与 daemon 同源（无独立副本可漂移）。
4. **桌面零回归**：GUI daemon 不设 web_root → static/CSP/notFound 全不挂；现有 `server.*.test.ts` 不退。

---

## 6. 提交（用户确认后，分步）

- **commit 1（shared）**：`feat(shared): API_PREFIXES single source + isApiPath`（+ vite.config 改 import）。
- **commit 2（core）**：`feat(config): add [daemon].web_root + redact for non-owner`（schema + 镜像 + redactConfig + 测试）。
- **commit 3（daemon）**：`feat(daemon): serve web via @fastify/static + CSP + API-prefix auth gate`（依赖 + startup-guard 校验 + 静态注册 + auth gate 改 + CSP hook + route 覆盖/auth/static 测试）。
- 完成后 `PROCESS.md` + 父设计稿 B4 行 ✅；**并顺手同步父设计 `2026-06-14-phase-b-web-design.md` 里所有 "SPA fallback" 表述**（§3.5 / §4(B4 行) / §5 验收 / §6 风险）——改为「HashRouter → 浏览器只请求 `/`，无需 SPA fallback；BrowserRouter 迁移留后续」，免未来读文档被带偏。（PROCESS.md 留工作区由用户后提。）

---

## 7. 实施记录（2026-06-19，已实施 + 手测通过，代码未提交）

**改动**（与上 §3 一致，含 review 修订）：
- **shared**：新 `src/api-paths.ts`（`API_PREFIXES`+`isApiPath`，纯常量）+ `package.json` `./api-paths` subpath export + `index.ts` re-export。
- **vite.config.ts**：删本地 `API_PREFIXES`，改 `import … from '@orpheus-aviary/owl-shared/api-paths'`（单一源）。
- **core**：`DaemonConfig.web_root?`（注释 owner-only）；`PublicDaemonConfig = Omit<…,'web_root'>` + `PublicOwlConfig` 用之；`redactConfig` 非 owner rest-omit `web_root`。shared `types.ts` 镜像同步。
- **daemon**：加 `@fastify/static` + `@orpheus-aviary/owl-shared` 依赖 + tsconfig `../shared` ref；新 `web-host.ts`（`resolveWebRoot`/`assertWebRootValid`/`registerWebHost`+CSP）；`auth.ts` 加 `isAuthExempt(config,method,url)`（local / `isPublicPath` / 非 API GET·HEAD）；`server.ts` preHandler 改用 `isAuthExempt`（顺带把复杂度压回 ≤15）+ 路由后 `registerWebHost`；`cli.ts` startup-guard try 内 `assertWebRootValid(resolveWebRoot(config))` fail-fast。

**实测修订**：①前端 = **HashRouter** → **删除 SPA fallback 整段**（浏览器只请求 `/`+assets）；②`@fastify/static` `wildcard:false` 实测**能正常服务 `/`→index.html**，**无需显式 `app.get('/')` 兜底**；③`web_root` fs 校验放 `cli.ts`（非纯 startup-guard），try/catch→`DaemonStartupError`。

**验证（全绿）**：
- daemon **405**(+11：resolveWebRoot/assertWebRootValid/static+CSP/cloud auth-gate/route-coverage + web_root 脱敏 2 断言) · core 529 · gui 441 · cli 137 不变。
- `tsc -b` clean · `just check` 9 守卫+biome（**20 warnings = baseline，未新增**，complexity 经 `isAuthExempt` 抽取化解）· `pnpm run build` + apps/web build。
- **curl 实测**（local daemon :47030 托管 apps/web/dist）：`/`→200 html、`/assets/*`→200、CSP+nosniff+referrer 头齐、`/status`→200 未遮、`/assets/missing.js`→404、`/notes/a/b/c`→Fastify 默认 404 JSON。
- **真浏览器**（用户验）：壳 + assets 同源 304 加载、**无 CSP 违规**、唯一 404 = `/favicon.ico`（bundle 无 favicon，B0 起既有，无关 B4）。

**桌面零回归**：不设 `web_root` → 不注册 static/CSP/notFound（单测钉死 + `isAuthExempt` local 首行放行）。

**CSP 备注**：`img-src 'self' data:` 阻断 markdown 外链图 = 有意隐私/反追踪（可日后放宽 `https:`）。

**Aω 续作**：owl-server 打包内嵌 dist + 默认端口 47020（⭐7）+ 上云；favicon 可顺手补。
