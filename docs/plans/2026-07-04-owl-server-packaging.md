# Stage 1.1 子设计：`@orpheus-aviary/owl-server` 本地打包

> 状态：**开工设计 2026-07-04，经一轮 review 收束（2026-07-05）**。父路线 `docs/plans/2026-07-04-road-to-1.0.0.md`（Stage 1 #1）。
> 目标：把散装 daemon 打成可发布的云端 server 包（内嵌 web dist + 默认端口 47020），**本地 rig + clean-install 跑通「打包后同源托管 + 登录 + 渲染」**，早暴露打包/ABI/内嵌/端口/依赖风险。**只差公网**（上云 = Stage 2）。

## 0. 现状（file:line，review 已核实）
- daemon 启动 = `packages/daemon/src/cli.ts:41` `daemon` action（~185 行单体）。`@owl/daemon` `private`、`tsc` 逐文件出 dist、`exports` 有 `.`+`./cli`。
- 同源托管 = `web-host.ts`（`resolveWebRoot`/`assertWebRootValid`/`registerWebHost`+CSP）+ `server.ts:153` `const webRoot = resolveWebRoot(ctx.config); if (webRoot) registerWebHost(...)`（B4）。`resolveWebRoot` 相对基准 = `paths.nestDir()`。
- **`loadConfig`（`config:210`）缺文件会 `saveConfig(DEFAULT_CONFIG)` 并返回 local 默认**（`mode:'local'`/`port:47010`，`config:182`）→ server 若裸调会静默变无鉴权 local = **fail-open**。owl-server 必须 `existsSync` 前置拒启。
- **`/config` PATCH（`routes/config:172`）= `deepAssign(ctx.config, filtered)` + `saveConfig(ctx.config, ctx.configPath)`** → **整份 `ctx.config` 回写**（任何 PATCH 都重序列化 daemon 段）→ **凡进 `ctx.config` 的 `web_root` 都会被 bake 进 toml**。`ctx.configPath` 未设时 `saveConfig` 落 `paths.configPath()`（标准 nest 路径）。
- **`account_lock` startup-guard（`startup-guard:118`）错误信息里字面写着** ``run `owl-server compute-owner --server-url <url> --email <email>` `` → **bin 必须提供 `compute-owner`**，否则该提示是谎话。
- **core 运行期从 `import.meta.url` 同目录读 migrations（`migrate:195` `HERE=dirname(fileURLToPath(import.meta.url)); MIGRATIONS_DIR=join(HERE,'migrations')`）** → **bundle 后 `HERE`=bundle 位置**，migrations 必须挨着 bundle 入口。
- owl-cli 发布范式（抄）：`tsup`（`apps/cli/tsup.config.ts`：`noExternal:['@owl/core']` + `external:[better-sqlite3,drizzle-orm,commander,pino,pino-roll,smol-toml,uuid]`，`entry src/index.ts`→`dist/index.js`，`banner` 注 shebang，`onSuccess` 跑 gen-manifest）+ `gen-publishable-manifest.mjs`（改名 + `bin` + `engines>=22` + `files` + 从 `pnpm-lock.yaml` 锁版本 + 拷 migrations）。

## 1. 决策（review 收束）

### D1 形态 = npm 包（非单二进制）
`tsup` bundle `@owl/daemon`+`@owl/core`+`@orpheus-aviary/owl-shared`，**external = 真运行时依赖**：`better-sqlite3`/`drizzle-orm`/`pino`/`pino-roll`/`smol-toml`/`uuid`（owl-cli 那套，`commander` owl-server 不用则去）**+ daemon 侧** `fastify`/`@fastify/cors`/`@fastify/static`/`openai`/`@anthropic-ai/sdk`/`node-notifier`/`@orpheus-aviary/skybridge-client`。host `npm install` 编译 better-sqlite3（Node ABI，prebuilt + node-gyp fallback，同 skybridge）。**不打 `.node` 进单文件。**

### D2 `boot(options?)` 契约
新 `packages/daemon/src/boot.ts`：把 `cli.ts` daemon action **原样搬入**（含 `runDevBootstrapOrPanic`/`maybeStartParentProbe`）。
```ts
boot(options?: { resolveConfig?: () => OwlConfig; embeddedWebRoot?: string }): Promise<void>
```
- **进程级入口**：装 SIGINT/SIGTERM、致命错 `process.exit(1)`。**调用方不应依赖 `boot` 的 resolve 语义做流程控制**——listen 成功后 promise 会 resolve，但**进程由 server socket + 信号 listener 常驻**（不做假阻塞的 never-resolving promise）。**不用于嵌入/单测**（daemon 单测仍测 `buildServer`）。
- `resolveConfig`（默认 `loadConfig`）= 唯一 config seam；`embeddedWebRoot` = 唯一 web seam。
- **无自定义 config path**（走 nest 约定）。
- `cli.ts` daemon action → `.action(() => boot())`；owl-server → `boot({ resolveConfig, embeddedWebRoot })`。**GUI-spawned daemon 行为不变。**
- **daemon 出口**：owl-server 从 `@owl/daemon`（`.` 导出）import `boot`/`BootOptions`/`computeOwnerProfileId`（后者在 `cloud-login.ts`）→ **commit 1 把这三个加进 `packages/daemon/src/index.ts` re-export**（现只导 `buildServer`/`AppContext`/`isDaemonRunning`/`readPid`）。不新增 package `exports` 子路径。

### D3 内嵌 web 走 `ctx.embeddedWebRoot`（不入持久化 config）
- `AppContext` 加 `embeddedWebRoot?: string`；`boot` 把 `options.embeddedWebRoot` 写到 `ctx`。
- `server.ts:153` 改：`const webRoot = resolveWebRoot(ctx.config) ?? ctx.embeddedWebRoot;`（operator 显式设 `web_root` 优先；否则用内嵌）。`boot` 里 `assertWebRootValid(resolveWebRoot(config) ?? options.embeddedWebRoot)`。
- **内嵌路径永不进 `config.daemon.web_root`** → `/config` PATCH 不会把包内绝对路径 bake 进 toml（免升级/迁移漂移）。
- `embeddedWebRoot` = bin 用 `import.meta.url` 定位包内 `dist/web`。

### D4 config 模型 = 强制 cloud + fail-closed
`packages/server/src/config.ts` `resolveServerConfig()`：
1. **`existsSync(paths.configPath())` 前置**；缺 → 拒启（打印指向内置 sample），**绝不触发 `loadConfig` 写默认**。
2. `config = loadConfig()`（文件在 → 只读不写）。
3. **断言 `config.daemon.mode === 'cloud'`**，否则拒启（"owl-server 只能 cloud 模式"）→ 免歧义默认 mode，且防裸 local 无鉴权。
4. **port（⭐7）**：raw-parse toml，`[daemon].port` 缺 → `config.daemon.port = 47020`（**core 保 47010**）。
5. 返回 config；**web_root 不在此处**（走 D3 的 `ctx.embeddedWebRoot`）。
6. `mode`/`bind`/`server_url`/`account_lock`/`public_url` 全由 operator 配（sample 给 `mode=cloud`/`bind=0.0.0.0`/`port=47020` + 三占位）；cloud startup-guard fail-closed 兜底缺失。
- **fail-closed 自己负责 UX**：步骤 1/3 的拒启由 `resolveServerConfig` **`console.error(<友好信息 + sample 路径>)` + `process.exit(1)`**，**不 throw**——它跑在 `createLogger` 之前（`boot` 先 `resolveConfig()` 再建 logger，`cli.ts:54`），直接 throw 会变裸 stack trace。友好信息含所需字段清单 + 内置 `owl_config.toml.sample` 的解析路径。
- `bind=127.0.0.1` 对 cloud **合法**（1a 本地 rig 即 cloud+loopback）→ 本地验证不受影响。

### D5 bin 派发（不上 commander）
`packages/server/src/index.ts`（tsup 入口，banner 注 shebang）：
```
if (process.argv[2] === 'compute-owner')  → computeOwner(argv)   // parseArgs 取 --server-url/--email/--password-stdin，调 @owl/daemon computeOwnerProfileId
else                                        → boot({ resolveConfig: resolveServerConfig, embeddedWebRoot })
```
简单写死 `argv[2]`，默认 boot 与子命令互不咬。（guard 提示已引用 `owl-server compute-owner`，必须提供。）

### D6 入口 + migrations 布局（抄 CLI）
tsup `entry: ['src/index.ts']` → **`dist/index.js`**（非 `dist/bin/`）；gen-manifest **拷 migrations 到 `dist/migrations/`**（挨着 bundle 入口，满足 `import.meta.url`）；`bin: { 'owl-server': 'index.js' }`。

### D7 manifest 依赖单一源（**实施修订：不放 package.json**）
> ⚠️ 原设计想把 external 名单放 owl-server `package.json` `dependencies` 作单一源。**实测推翻**（见 §6 踩坑①）：`node-linker=hoisted` 下声明 `fastify`（`@fastify/static` 的 peer）会物化第二份物理 fastify → 破 daemon `tsc`。**改为单一源 `runtime-externals.json`**：
- owl-server `package.json` `dependencies` **留空**；13 个 external 名单放 **`runtime-externals.json`**（tsup `external` + gen-manifest `dependencies` 都读它）。`@owl/daemon`/`@owl/core`/`@orpheus-aviary/owl-shared` 放 `devDependencies`（tsup bundle，不发布），`@owl/web` 也在 devDeps 作构建边。
- `gen-publishable-manifest.mjs`：`dependencies` 从 `runtime-externals.json` 逐个 **`resolvedVersion(name)`**（读 `node_modules/<name>/package.json` 的实装版本，比 regex 解析 v9 lockfile 更稳；owl-cli 的 `lockedVersion()` 是 dead code）。名单只含 external → **无 workspace/private 泄漏**。`files` 含 `index.js`+`index.js.map`+`web/**`+`migrations/*.sql`+**`owl_config.toml.sample`**+README+LICENSE；`bin`；`engines.node>=22`。

### D8 顺手
内置 **`owl_config.toml.sample`**（**就叫这名，避免诱导复制成错误文件名**；operator `cp` 到 `<nest>/owl/owl_config.toml`。内容 = `mode=cloud`/`bind=0.0.0.0`/`port=47020` + `server_url`/`account_lock`/`public_url` 占位 + 注释）+ **repo 根** `docs/deploy/owl-server-ubuntu.md`（抄 skybridge，明文 HTTP + 锁源 IP，TLS 留 Stage 2；**repo 文档，不随 npm 包发布**）+ favicon（`apps/web`）。

## 2. 包结构
```
packages/server/                @owl/server（private；publish 名 @orpheus-aviary/owl-server）
  package.json                  dependencies=空（见 runtime-externals.json，防 fastify dual-identity）；devDependencies=@owl/daemon+core+shared(workspace,bundled)+@owl/web(仅构建边,不 import/bundle)+tsup+ts
  runtime-externals.json        单一源：13 个运行时 external 名单（tsup external + gen-manifest deps 都读它）
  tsup.config.ts                读 runtime-externals.json 作 external；bundle→dist/index.js（banner shebang）+ onSuccess gen-manifest
  tsconfig.json
  src/index.ts                  #!/usr/bin/env node（banner 注）；argv[2] 派发 compute-owner / boot；password helper 从 @owl/daemon import
  src/config.ts                 resolveServerConfig()（fail-closed / 强制 cloud / port 47020 缺省）
  src/embedded.ts               embeddedWebRoot()（import.meta.url → 包内 dist/web）
  owl_config.toml.sample        （发布进 files；operator cp 到 <nest>/owl/owl_config.toml）
  scripts/gen-publishable-manifest.mjs   改名 + bin + files(web/**+migrations+sample) + deps=runtime-externals.json×resolvedVersion() + copy web/migrations
```
> 部署文档 = **repo 根 `docs/deploy/owl-server-ubuntu.md`**（**非包内、不进 npm files**；operator 在线读，不从 node_modules 找）。

## 3. 提交切分
1. `refactor(daemon)`: 抽 `boot(options?)` from cli.ts（+ `AppContext.embeddedWebRoot` + `server.ts` `?? ctx.embeddedWebRoot` + **daemon `src/index.ts` re-export `boot`/`BootOptions`/`computeOwnerProfileId`**）。`just test-daemon` 钉死。
2. `feat(server)`: `@owl/server` 包骨架 + `src/index.ts` 派发（boot + compute-owner）+ `resolveServerConfig`（fail-closed/强制 cloud/port 缺省）+ `embeddedWebRoot`（workspace 内可跑）。
3. `build(server)`: tsup 打包 + gen-manifest（deps=`lockedVersion()` 锁版本 / 删 workspace / copy web + migrations + sample）+ `just build-server`（前置 `build-shared build-core build-daemon` + `@owl/web` build + **断言 `apps/web/dist/index.html` 存在，缺则拒绝打包**）/ `pack-server`。**根 `tsconfig.json` references 加 `packages/server`**（server 加 composite tsconfig，镜像现有 `apps/cli` 那条）→ `pnpm run typecheck`(`tsc -b`) 覆盖 server。**根 build 排序（硬约束，非可选）**：server 加 **`@owl/web` workspace devDependency 建立构建边** → `pnpm -r build`（拓扑序）保证 `@owl/web` 先于 server；`just build-server` 也显式排序 web 在前。`index.html` 断言 = **belt-and-suspenders**（把任何漏网竞态变 fail-closed，**不作为唯一防线**）。`@owl/web` 只做构建边、**不 import/不 bundle**（server 只 copy 它的 `dist` 静态产物）。
4. `docs(deploy)`: 部署指南（repo 根 `docs/deploy/owl-server-ubuntu.md`）+ `owl_config.toml.sample` + favicon。

## 4. 验证（本地，无公网）
1. **build**：`just build-server` → `dist/index.js` + `dist/web/`(含 index.html) + `dist/migrations/*.sql` + `dist/package.json`（deps 无 workspace/private）。
2. **本地 rig（复刻 1a）**：in-proc skybridge :8443 + owner → **fresh nest** `<nest>/owl/owl_config.toml`（`mode=cloud`/`server_url`/`account_lock`/`public_url`，**不设 `port`/`web_root`**）→ 跑打包后 owl-server → 断言：① 监听 **47020**（port 缺省生效）② 同源托管**包内** web（`ctx.embeddedWebRoot` 生效）③ 登录 → 渲染真实笔记 → 严格 CSP 下 KaTeX/highlight/`/events` SSE 正常（同 1a）④ **fresh nest 触发 migration → SQL 路径解析 OK**（`dist/migrations` 被 bundle 找到）。
3. **clean-install smoke（本轮，非 Stage 2）**：`npm pack`（dist）→ 临时目录 `npm install <tgz>` → 跑**装出来的** `owl-server` 打同一 rig → 逼出 workspace deps / `pino-roll` / `bin` / better-sqlite3 install+ABI 问题。
4. **fail-closed**：缺 config → 拒启；`mode≠cloud` → 拒启；`owl-server compute-owner ...` 不进 boot。
5. **桌面零回归**：`just test-daemon` 全绿（boot 抽取忠实）；GUI 仍 spawn `cli.js daemon`（走 boot）；不设 web_root 时 `?? ctx.embeddedWebRoot`（GUI ctx 无该字段=undefined）→ 行为不变。

## 5. 风险
- **boot 抽取回归**（最大）：~185 行忠实迁移 + `just test-daemon` 钉死 + GUI 真机 spawn 冒烟。
- **external 名单漏**（尤其 `pino-roll` 运行时字符串 target）：**clean-install smoke 专治**（bundle 内没有 + deps 里没有 = 立即炸）。
- **bundled core 找 migrations**：入口 `dist/index.js` + `dist/migrations/` 对齐 `import.meta.url`；fresh nest 触发 migration 必验。
- **web_root 误入持久化**：D3 走 `ctx.embeddedWebRoot` 规避；单测/rig 验 `/config` PATCH 后 toml 无 web_root。

## 6. 实施记录（2026-07-05，已实现 + 本地 rig + clean-install 全绿）

**改动**（与 §1–§3 一致）：`refactor(daemon)` 抽 `boot.ts`（+ `AppContext.embeddedWebRoot` + `server.ts` `?? ctx.embeddedWebRoot` + daemon `index.ts` re-export `boot`/`BootOptions`/`computeOwnerProfileId`）；新 `packages/server/`（`src/index.ts` argv[2] 派发、`config.ts` `resolveServerConfig`、`embedded.ts`、`password.ts`、`owl_config.toml.sample`、`tsup.config.ts`、`scripts/gen-publishable-manifest.mjs`、`runtime-externals.json`）；根 `tsconfig.json` +`packages/server` ref；`justfile` +`build-server`/`pack-server`；`no-prod-env-token` 守卫 `cli.ts→boot.ts`；favicon（`apps/web/public/favicon.svg`+index.html link）；`docs/deploy/owl-server-ubuntu.md`。

**踩坑（复用必看）**：
1. **fastify dual-identity（最大坑）**：`node-linker=hoisted` 下，server 只要在 `dependencies` 声明 `fastify`（`@fastify/static` 的 peer），pnpm 就在 workspace **物化第二份物理 fastify**（`.pnpm/fastify@5.8.4` vs 顶层 `node_modules/fastify`）→ daemon `web-host.ts` 的 `app.register(fastifyStatic)` 报 dual-identity TS2769（daemon 本来好好的）。**解法 = server `dependencies` 清空**，运行时 external 改由 `runtime-externals.json` **单一源**驱动（tsup `external` + gen-manifest `dependencies` 都读它）。清残留需 **`rm -rf node_modules && pnpm install`**（`pnpm install` 不 prune 孤儿 `.pnpm` 目录）。
2. **gen-manifest 版本锁**：v9 lockfile 对 scoped 名加引号、同名多版本，正则脆；且 owl-cli 的 `lockedVersion()` 是 dead code（从没跑过）。改 **`resolvedVersion(name)` = 读 `node_modules/<name>/package.json`**（hoisted 下单份，就是 build/test 的那份）。
3. **block-comment 关闭 bug**：JSDoc 里 `workspace:*/private` 的 `*/` 会**提前关闭注释** → SyntaxError。措辞避开。
4. **entry = `dist/index.js`**（非 `dist/bin/`）+ `dist/migrations/` 挨着：bundle 后 `import.meta.url`=bundle 位置（`migrate:195`），CLI 布局同款。
5. `boot()` 契约：进程级入口（信号/`exit`/成功后进程靠 socket 常驻），`resolveConfig`+`embeddedWebRoot` 两个 seam。

**验证（全绿）**：`just test-daemon` **405/405**（boot 抽取零回归）· `just check` 9 守卫+lint+`tsc -b`（含 `packages/server`）· `just build-server` 出 `dist/index.js`(270KB)+`web/`(含 favicon)+9 migrations+sample+`package.json`（13 externals 精确版本、**零 workspace 泄漏**）。**本地 rig（复刻 1a，配置省略 port/web_root）**：packaged owl-server → 监听 **47020**（缺省生效）· 同源托管**包内** web + 严格 CSP · `/status` 公开/`/notes` 401 · 登录→建笔记→列出 · **fresh nest 触发 migration**（owl.db 建成，SQL 路径解析 OK）· `/events` SSE 200 · `compute-owner` 子命令派发正确。**clean-install smoke**：`npm pack` → 临时目录 `npm install <tgz>`（**better-sqlite3 native 编译成功** + `pino-roll` 等全 pull、**零 @owl workspace**）→ 装出来的 `owl-server` 同样 47020+同源 web+CSP+登录+migration 全过。rig 已拆。

**桌面零回归**：daemon 405 不变；GUI 仍 spawn `cli.js daemon`（走 `boot()`）；不设 web_root 时 `?? ctx.embeddedWebRoot`（GUI ctx 无该字段=undefined）→ 行为不变。**只差公网**（上云 = Stage 2）。

**遗留**：`fastify` 精确锁在 `runtime-externals.json` 经 `resolvedVersion` 得（5.8.4）；未来 workspace fastify 升级需重跑 `build-server` 刷新 published 版本。owl-server `version` 暂 `0.5.0`（对齐 owl-cli；发布时按 release 版本 bump）。
