# Step 0 子设计：系统清理 + 平台适配层 + owl-shared

> 起草 2026-06-12（0.5.0 公开发版后扩生态起手）。父设计：
> `docs/plans/2026-06-06-mobile-web-ecosystem-arch.md`（§0/§12/§13）。
> 本文是扩生态开发流的**首个阶段**（Step 0），为 Phase A 云端 daemon 与 Phase B 网页版铺路。
>
> **三项决策已拍板（2026-06-12）**：
> 1. **重构先、cleanup 后** — 先抽平台适配层 + shared，再在稳定结构上跑 cleanup（避免清理一个马上要搬走的 `api.ts`）。
> 2. **fetch-SSE 立即全切**（贴 arch §12）— Step 0 就把 `EventsSubscriber` 的原生 `EventSource` 换成 fetch-SSE（带重连/backoff），并在 Electron 上立即验证。
> 3. **轻量 cleanup** — warnings 清零 + 死 export + 文档/依赖；`>500` 行大文件拆分**显式延后**，另排一轮（不阻塞 web）。
>
> **review 收口（v3，2026-06-12，两轮 P1/P2）**：
> - **P1 鉴权 seam ≠ 鉴权**：Step 0 **不注任何 auth header**。shared 只预留 `getAuthHeaders?:()=>Record<string,string>`，默认 `{}`（gui 接成空，行为与今天等价）。token 来源 + daemon 校验全 Phase A。
> - **P1 web 不从可达 UI throw**：sync 能力**分两类**——「Electron-local 多 profile / IPC push」（`profiles`/`switchProfile`/`deleteProfile`/`onProfileSwitched`/`onClaimPrompt`/`respondClaim` + `migration`/`cli`/`shortcut`/`quit`）→ **optional `?:`**，组件 guard 渲染 disabled；「web 将有的会话/状态操作」（`login`/`logout`/`status`/`run`/`devices`/`revokeDevice`）→ **在场返 typed failure `{ok:false,message:'网页版暂不可用（请用桌面端）'}`**（合 `SyncIpcReply`，调用点已读 `reply.message`）。
> - **P1 SSE 契约**：抽低层 `parseSseFrames` 只产 `{event,data:string}`（raw）；`subscribeSse` 传 raw → `handleDaemonEvent` **不变**；`streamSse`（`/ai/chat` POST）保留「parse 成 unknown」契约**但 URL/headers 也走 shared transport**（Phase A `/ai/chat` 同样带 auth，不留缝）。
> - **P2 web-safety 走守卫不走 optional**（替代「Window.owlAPI 改 optional」）：保持非 optional，`getPlatform()` 用 `typeof window !== 'undefined' && 'owlAPI' in window` 诚实探测；新增守卫 G10 禁 renderer（除 `platform/electron.ts`/`test-setup.ts`/`types/owl-api.d.ts`/`*.test.*`）出现 `window.owlAPI`——**`window.owlAPI` stub 零改动，仅 test-setup 追加 transport 初始化**。
> - **P2 transport 初始化**：prod `main.tsx` + 测试 `test-setup.ts` 各 `configureTransport`；未 configure 默认 `baseUrl:()=>''`（相对）。
> - **P2 类型迁移清单 / build 链 / tsconfig / e2e 门禁** 已写死（见 §2、§3 Phase 0b、§5）。
> - **契约标注**：shared config 端点 local-contract（Phase A 加 secret redaction 可能改 shape）。0d commit 前必问用户、PROCESS.md 不与代码捆绑。

---

## 0. 目标与非目标

**目标**：让 renderer 与 Electron 解耦，使同一份 React 既能寄居 Electron renderer、也能在浏览器（Phase B web）里 boot；并把 api client + wire 类型抽成 `@orpheus-aviary/owl-shared`，让 web/移动第一天起就 build against 它。**不改变任何 Electron 端用户可见行为。**

**非目标（不在 Step 0）**：
- 任何 daemon 鉴权 / CORS / 会话 / `[daemon].mode` 改动 → **Phase A**。
- web 端页面 / 响应式 / 编辑并发 → **Phase B**。
- 发布 `@orpheus-aviary/owl-shared` 到 npm → **Phase C**（Step 0 只建包 + gui 内部消费）。
- `>500` 行大文件拆分（`sync-auth.ts 1042` / `engine.ts 1040` / …）→ 另排一轮。

---

## 1. 现状调查（2026-06-12 实扫）

### 1.1 平台耦合面（web 能跑的前提）
`window.owlAPI` 在 renderer 共 **~25 处直接调用**：

| 位置 | 调用 | web 行为 |
|------|------|----------|
| `App.tsx:15` | `startupMode`（首屏分支） | web 无本地 migration → 恒 `{mode:'normal'}` |
| `MainApp.tsx:271` | `sync.onProfileSwitched`（IPC 订阅） | web 无此 IPC → 能力缺省（guard） |
| `lib/api.ts:82` | `daemonUrl ?? 'http://127.0.0.1:47010'` | 对 web 是反的 → 相对路径 |
| `stores/config-store.ts:32` | `shortcut.setGlobal`（已 guard `typeof window`） | Electron-only |
| `components/settings/{SyncSection,DevicesCard,SavedProfilesCard,CliToolsSection}.tsx` | `sync.*` / `cli.detect` | sync.* → Phase A HTTP；cli Electron-only |
| `components/sync/SyncStatusBar.tsx` | `sync.{profiles,run,switchProfile}` | Phase A HTTP |
| `components/ClaimAccountDialog.tsx` | `sync.{onClaimPrompt,respondClaim}` | Electron-only（claim 流程在 main） |
| `components/UnsavedTabsDialog.tsx` | `quit.{onCheckUnsaved,respond}` | Electron-only（app quit） |
| `pages/MigrationDialog/index.tsx` | `migration.*` | Electron-only |

类型单源 `types/owl-api.d.ts`（`OwlAPI` interface），preload `preload/index.ts` 镜像。
**keychain**：renderer 实际不碰（safeStorage 只在 `main/sync-auth.ts`）——adapter 里它是概念占位，不需在 renderer 抽。

### 1.2 SSE
- `EventsSubscriber.tsx:49` 用原生 `EventSource` 订 `GET /events`（靠浏览器内建指数退避重连）。
- `lib/sse-client.ts` 已是 fetch + ReadableStream 的 **POST-SSE**（给 `/ai/chat`），但**无重连**（单发即走）。
- 重连/backoff 逻辑需新写（fetch-SSE for `/events`）；现成的 wire 解析（`dispatchBlock`）可复用。

### 1.3 cleanup 维度实扫
- biome **53 warnings**（绝大多数 `noNonNullAssertion`）。
- TODO/FIXME **实质为 0**（21 命中全是 `SPECIAL_NOTES.TODO` / node_modules 误报）。
- 暂留 exports：`writeSkybridgeConfig` / `requireAuth` 现**仅测试用**（可降级 test-only/非导出）；`clearSkybridgeAuth` **仍被 `main/sync-auth.ts:370,659` 用**（保留）；`SKYBRIDGE_NOT_INSTALLED` 仍在 CLI/session/e2e 串着（防御分支待定性）。
- `>500` 行源文件 8 个（拆分延后，仅在 findings 登记）。
- 根 `owl.db`、`release/` 已 gitignore（本地残留，非入库项）。

### 1.4 工程基线
- pnpm workspace（`packages/*` + `apps/*`），tsconfig project references（`tsconfig.json` → core/daemon/gui.node/gui.web/cli）。
- gui 双 tsconfig：`tsconfig.web.json`（renderer，不含 `src/main`）/ `tsconfig.node.json`（main+preload）。
- 基线：core **528** / daemon **290** / cli **137** / gui **399** + gated e2e **25/25**；`just check` 8 守卫。

---

## 2. 架构边界（共享线划在「视图之下」）

```
@orpheus-aviary/owl-shared  ← 无 Electron/Node 概念，mobile-safe
  ├─ api client（~51 端点封装）+ wire 类型（Note/Folder/Tag/Conflict/SyncStatus…）
  ├─ 传输配置：configureTransport({ baseUrl: () => string, getAuthHeaders?: () => Record<string,string> })
  │     └─ getAuthHeaders 默认 () => ({})  —— Step 0 不注任何 header，与今天等价；Phase A 接真值
  ├─ 低层 SSE：parseSseFrames(stream) → 产 { event: string, data: string }（raw，不 parse）
  ├─ subscribeSse(path, { events, onEvent(event, rawData), getAuthHeaders, signal })（GET + 重连/backoff，传 raw data）
  └─ streamSse(path='/ai/chat', body, …)：保留「parse data 成 unknown」契约；URL=baseUrl()+path、headers merge getAuthHeaders()

packages/gui/src/renderer/src/platform/  ← GUI 本地，分 Electron/web
  ├─ types.ts        PlatformAdapter（必有 startupMode/daemonBaseUrl + sync 会话操作 login/logout/status/run/devices/revokeDevice；
  │                  optional ?: 多profile/IPC-push: profiles/switchProfile/deleteProfile/onProfileSwitched/onClaimPrompt/respondClaim + migration/cli/shortcut/quit）
  ├─ electron.ts     electronAdapter（薄包 window.owlAPI；getPlatform 已保证在场，内部直读，非 optional）
  ├─ web.ts          webAdapter（startupMode normal；optional 能力 undefined；会话操作返 {ok:false,message:'网页版暂不可用（请用桌面端）'}）
  └─ index.ts        getPlatform()（typeof window!=='undefined' && 'owlAPI' in window ? electronAdapter : webAdapter）
```

**类型迁移（写死）**：
- **进 shared**（HTTP/SSE wire）：`api.ts` 全 interface（Note/Folder/Tag/Conflict/Todo/Config/Ai*）+ `SyncStatusResult` + `SyncStatusSnapshot` + `RunSyncResult`。
- **留 gui**（IPC/main-composed）：`SyncIpcReply` · `SyncStatusReply`（keychain gating）· `LoginAndOpenSessionInput`/`ClaimChoice`/`ClaimPromptInput` · `SyncProfilesReply`（本地 toml 态）。
- **留 gui 待 Phase A 复议**：`SyncDevicesReply`（`is_current` main 算 + SDK camel→snake）。

**铁律**：shared 不 import 任何 Electron/Node/`window.owlAPI`；它只吃「baseUrl provider + auth-headers provider」。
gui boot（`main.tsx`）+ 测试（`test-setup.ts`）各自 `configureTransport({ baseUrl, getAuthHeaders: () => ({}) })`（Step 0 空；Phase A 填）；未 configure 默认 `baseUrl:()=>''`（相对，web 友好）。
**`PlatformAdapter` 留在 gui**（Electron IPC 是视图层概念，移动端走 RN 自己的壳，不复用此 adapter）。

**web-safety 守卫（替代 Window.owlAPI optional）**：`Window.owlAPI` **保持非 optional**（`window.owlAPI` stub 零改动，test-setup 仅追加 transport 初始化）；web 安全靠 `getPlatform()` 的 `typeof window !== 'undefined' && 'owlAPI' in window` 诚实探测 + 新增 `just check` 守卫 G10 禁 renderer（**排除 `platform/electron.ts`、`test-setup.ts`、`types/owl-api.d.ts`、`*.test.*`**）出现 `window.owlAPI`。
*（备选：若决定改 optional，则 `test-setup.ts:15` `type OwlAPI=typeof window.owlAPI` 要改 import 真类型，并加 `getTestOwlAPI()` helper 批量改 ~8 测试文件。）*

**契约标注**：shared 的 config 端点（`GET/PATCH /config`，含 `OwlConfig.llm.api_key`）是 **local/current contract**；Phase A 加 secret redaction + owner-gate + public/secret 拆分时**可能改 shape**——shared 里以注释标明、消费方别假设它永久稳定。

---

## 3. 阶段拆分

### Phase 0a — 平台适配层（gui 内）
**产出**：renderer 不再直摸 `window.owlAPI`，web 能 boot 不抛。

1. `platform/types.ts`：`PlatformAdapter` 接口，**两类能力分明**：
   - **必有**：`startupMode`、`daemonBaseUrl()`、会话/状态操作 `login`/`logout`/`status`/`run`/`devices`/`revokeDevice`——签名沿用 `Promise<SyncIpcReply<T>>`；**web 实现返 `{ok:false,message:'网页版暂不可用（请用桌面端）'}`，绝不 throw**（调用点已读 `reply.ok`/`reply.message`，零冲突；Phase A 换 HTTP 实现、不改签名）。
   - **可选 `?:`**（Electron-local 多 profile / IPC push，web 本质没有）：`profiles?`、`switchProfile?`、`deleteProfile?`、`onProfileSwitched?`、`onClaimPrompt?`/`respondClaim?`、`migration?`、`cli?`、`shortcut?`、`quit?`。web 侧 `undefined`，组件 `cap?.()` guard 或渲染 disabled 态。
2. `platform/electron.ts`：`electronAdapter` 直读 `window.owlAPI`（`getPlatform()` 已保证在场，**无需内部 guard**；现有 ~8 个 test 的 `window.owlAPI` stub 零改动仍命中）。
3. `platform/web.ts`：`webAdapter`（`startupMode:{mode:'normal'}`；可选能力 `undefined`；会话操作返 typed failure，不 throw）。
4. `platform/index.ts`：`getPlatform()` 单例 = `typeof window !== 'undefined' && 'owlAPI' in window ? electronAdapter : webAdapter`（诚实探测，浏览器无 preload / 工具导入无 window 都返 web）。
5. **web-safety 守卫 G10**：`Window.owlAPI` 保持非 optional（`window.owlAPI` stub + test-setup 既有内容不动）；新增守卫 renderer-owlapi-confined——grep `packages/gui/src/renderer/src`（**排除 `platform/electron.ts`、`test-setup.ts`、`types/owl-api.d.ts`、`*.test.*`**）禁出现 `window.owlAPI`，把「renderer 不得绕过 adapter 摸 preload」硬保。
6. 改 ~25 处调用走 `getPlatform()`：
   - `App.tsx` → `getPlatform().startupMode`
   - `MainApp.tsx` → `getPlatform().onProfileSwitched?.(...)`（缺省即 no-op）
   - `config-store.ts` → `getPlatform().shortcut?.setGlobal`
   - settings/* · sync/SyncStatusBar · ClaimAccountDialog · UnsavedTabsDialog · MigrationDialog · CliToolsSection → 经 adapter；optional 能力在 web 用 `cap?.()` guard 渲染 disabled（如 SyncStatusBar 快切区缺 `switchProfile` → 隐藏 + 「桌面端管理」提示）。
7. 验收：`just check`（含新守卫）+ gui 全测试绿（electronAdapter 读 window.owlAPI → 测试 stub 仍命中）；Electron `just dev` 手测无回归。

### Phase 0b — owl-shared + fetch-SSE 全切
**产出**：api client + 类型在 shared；`/events` 走 fetch-SSE（带重连）。

1. 建 `packages/shared`（`@orpheus-aviary/owl-shared`）：
   - `package.json`（`version 0.1.0`、`private:true`（Step 0 不发布）、`type:module`、`main/types` 指 dist、`build: tsc`）。
   - **专属 `tsconfig`（不对齐 base）**：`lib:["ES2022","DOM"]`（fetch/ReadableStream/TextDecoder）、`types:[]`（不拉 node）、`composite:true`、`outDir dist`；其余 strict 选项继承 base 的 spread。
   - `pnpm-workspace.yaml` 已含 `packages/*`（自动纳入）；根 `tsconfig.json` references 加 `{ "path": "packages/shared" }`。
2. 搬 `lib/api.ts` 的 api client + wire 类型进 shared：
   - 加 `configureTransport({ baseUrl, getAuthHeaders? })`；`request()` 用注入 `baseUrl()` 拼 URL、`...getAuthHeaders?.()` 并入 headers。**auth header 行为与现状等价**（默认 `getAuthHeaders=()=>({})` → 不加任何 header，**Step 0 不注 `Authorization`**）；**baseUrl 在 prod/test 显式配置**，未配置默认 `()=>''`（相对路径以利 web）——注意这与今天「未配置 fallback `127.0.0.1:47010`」不同，故 prod/test 都必须显式 configure（见下）。
   - **两处初始化**（测试不走 main.tsx）：prod `main.tsx` render 前 `configureTransport({ baseUrl: () => getPlatform().daemonBaseUrl(), getAuthHeaders: () => ({}) })`；测试 `test-setup.ts` `configureTransport({ baseUrl: () => 'http://127.0.0.1:47010' })`（保住断言全 URL 的 fetch-mock 测试）。
   - gui 的 `lib/api.ts` 改为从 `@orpheus-aviary/owl-shared` re-export（**降低 import 改动面**；`config-store`/stores 的 `import * as api from '@/lib/api'` 不动）。
   - 类型迁移按 §2「类型迁移（写死）」：wire 进 shared，IPC/main-composed 留 gui。
3. **fetch-SSE 三件（契约写死）**：
   - 低层 `parseSseFrames(stream)`：从 ReadableStream 切帧，产 `{ event: string, data: string }`（**raw，不 JSON.parse**）。把现 `sse-client.ts` 的帧切分逻辑（`pumpReader`+block 拆分）抽到这里。
   - `subscribeSse(path, { events, onEvent(event, rawData), getAuthHeaders, signal })`：GET + **重连/backoff**（参考 daemon `sse-bridge` `[2,4,8,16,30]s+jitter`，renderer 档可简化）；`onEvent` 收 **raw data string**。
   - `streamSse`（POST `/ai/chat`）：**保留「`dispatchBlock` 把 data JSON.parse 成 unknown」契约不动**（ai 调用方依赖 parsed data），**但改走 shared transport**——接受 `path`、URL = `baseUrl()+path`、headers merge `getAuthHeaders()`（Phase A `/ai/chat` 也带 auth，不留缝）。ai 调用方（`stores/ai-*`）改传 path `'/ai/chat'`，不再自拼 `baseUrl()`。
4. `EventsSubscriber.tsx` 换用 `subscribeSse('/events', { events: EVENT_TYPES, onEvent: (e, raw) => handleDaemonEvent(e, raw, handlers) })`（**决策 2：立即全切**）。**必须保住**：
   - `handleDaemonEvent(eventName, rawData: string, …)` **签名/实现完全不变**（它自己 parse raw）。
   - 冷启 `GET /sync/status` 种子（`useEffect` 仍在）。
   - 表驱动 `EVENT_TYPES` 分发。
   - StrictMode 双挂安全（abort + 清理）。
   - auth headers 经 `getAuthHeaders` 注入（Step 0 空）。
5. **build 链补全**：
   - `@owl/gui` deps 加 `"@orpheus-aviary/owl-shared": "workspace:*"`。
   - gui `package.json` `build:deps` → `pnpm -F @orpheus-aviary/owl-shared build && pnpm -F @owl/core build && pnpm -F @owl/daemon build`。
   - justfile 加 `build-shared` recipe，并塞进 `build`（§77）/ `dev` 前置（§196）/ `test` 前置链——因 e2e 跑 dist、shared 必须先 build。
6. 验收：`pnpm -r build` → `just check`（含 G9 shared-no-node-electron）→ `just test` 全绿（含 `events-subscriber-core.test` / `sse-client.test`，补 `subscribeSse`/`parseSseFrames` 重连单测）→ `just test-skybridge-e2e`（gated 25）；Electron 手测：`just stop-daemon && just dev-daemon` 重启 → renderer 自动重连、状态条恢复。

### Phase 0c — findings 文档 + triage（轻量）
**产出**：`docs/plans/2026-06-12-0.6.0-cleanup-findings.md`（**重构后再扫**，反映搬动后的文件位置）。

登记维度（轻量）：
- biome 53 warnings 清单（按文件/规则）。
- 死/暂留 export：`writeSkybridgeConfig`/`requireAuth` 降级 test-only；`clearSkybridgeAuth` 保留（main 仍用）；`SKYBRIDGE_NOT_INSTALLED` 防御分支定性。
- 文档冗余：`COEDIT_PLAN.md` / §8 作废的 p3-plan 引用、已 ship 子设计在 `docs/history/*-shipped.md` 索引齐否。
- 依赖审计：CLI `commander`/`pkg` 是否仍用（实际 tsup 打包）；workspace 版本对齐。
- **`>500` 行大文件拆分 = 显式延后**（仅登记 8 个候选，不做）。

与用户过一遍 triage（risk/收益），定执行清单。

### Phase 0d — cleanup 执行批次（轻量）
triage 后的项，**小批 commit、每批 `just check` + `just test` 全绿、不夹带功能改动**：
- 批 1：biome warnings → 0（`!` → `?.`/显式 narrow；热点文件 watchdog/sse-bridge 谨慎）。
- 批 2：test-only export 降级（`writeSkybridgeConfig`/`requireAuth`；`clearSkybridgeAuth` 保留）。
- 批 3：文档索引/失效引用清理。
- 批 4：依赖审计修正。

**PROCESS.md**：Step 0 开工即更新以跟踪进度；按 `分步提交` 习惯，PROCESS.md 改动**不与代码 commit 捆绑**、留工作树由用户另提。**每次 commit 前询问用户确认**（CLAUDE.md 铁律）。

---

## 4. 风险与护栏
- **fetch-SSE 重连 parity**：native EventSource 的内建重连是「白嫖」的；自写需覆盖 daemon 重启 / 网络抖动 / StrictMode 双挂。**护栏**：补 `subscribeSse`+`parseSseFrames` 单测（含重连）；Electron 真机跑 daemon 重启验证。
- **SSE data 契约**：`subscribeSse` 传 **raw string**（给 `/events`+`handleDaemonEvent`），`streamSse` 传 **parsed unknown**（给 `/ai/chat`）——两套契约别串。**护栏**：单测分别钉两条。
- **shared mobile-safe**：shared 误 import Node/Electron 会污染移动端类型图。**护栏**：tsconfig `lib:["ES2022","DOM"]`+`types:[]`；新增守卫 **G9 shared-no-node-electron**（grep `packages/shared/src` 禁 `from 'node:`/`from 'electron'`/`window.owlAPI`）。
- **test 改动面**：`Window.owlAPI` 保持非 optional + electronAdapter 直读 → 现有 ~8 个 `window.owlAPI` stub **零改动**（test-setup 仅追加 transport 初始化）；只有改走 `getPlatform()` 的少数组件测试断言可能需对齐 mock 引用。
- **transport 未初始化**：忘了在 test-setup `configureTransport` → 断言全 URL 的测试会 fail（默认 `baseUrl=''` 相对）。**护栏**：test-setup 统一 configure；新代码 review 时检查。
- **`noUnusedLocals/Params` 严格**：搬动代码可能暴露未用导出 → 顺手清或显式 keep。
- **import 改动面**：gui `lib/api.ts` re-export shared，控制改动半径，避免全仓改导入路径。
- **renderer 绕过 adapter**：新代码可能直摸 `window.owlAPI` 破 web-safety。**护栏**：守卫 **G10 renderer-owlapi-confined**（除 `platform/electron.ts`、`test-setup.ts`、`types/owl-api.d.ts`、`*.test.*` 禁 `window.owlAPI`），漏改即 `just check` 红。

---

## 5. 验收基线
每阶段四步（gated e2e 与单测是**两条独立命令**）：
1. `pnpm -r build`（e2e 跑 dist，先 build；含 `build-shared`）。
2. `just check`（现 8 守卫 + **G9 shared-no-node-electron**[0b 加] + **G10 renderer-owlapi-confined**[0a 加] + biome + tsc）。
3. `just test`（= `ensure-node-abi` + `pnpm -r run test`：core/daemon/cli/gui **单测**——**不含** e2e）。
4. `just test-skybridge-e2e`（= `SKYBRIDGE_E2E=1 pnpm --filter @owl/daemon run test:e2e`，gated **25**）。

Electron 手测：`just dev`（renderer）+ `just dev-daemon`（daemon 生命周期由 Claude 维护），验证首屏 / 同步状态条 / profile 切换 / SSE 重连无回归。

---

*（Step 0 子设计 v1，2026-06-12。决策已锁，待通审后从 Phase 0a 起手。）*
