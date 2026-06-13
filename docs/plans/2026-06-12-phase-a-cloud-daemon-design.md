# Phase A 子设计：云端 daemon（`[daemon].mode` cloud/local + 端点鉴权 + 两层会话）

> 状态：**v2.1，经两轮代码核对评审收口**。起草 2026-06-12（扩生态 Step 0 完成后起手）。
> v2 = 12 处事实修正 + 6 必须决策；v2.1 = 第二轮 6 项（compute-owner 提前 / public_url 无条件必填 / refresh 须 rebind / return-visit fallback register + switchToProfileId helper / 限速 keying / 新字段 runtime validation）。
> 父设计：`docs/plans/2026-06-06-mobile-web-ecosystem-arch.md`（§0/§3/§7/§9/§12/§14）。
> 前置：Step 0 已抽出 `@orpheus-aviary/owl-shared`（transport `getAuthHeaders` seam 已预留、返空）+ fetch-SSE（`subscribeSse` 带 bearer）。
>
> **本会话 = 只出本设计稿，停下评审**（不写生产代码）。三项会话级决策（2026-06-12）：
> 1. **云优先，local token 后置** — 先做 cloud 鉴权 + 两层会话；CORS allowlist + Host 校验早做；
>    跨切的 **local 模式 mutating-token**（触及已发版 0.5.0 桌面端所有客户端）排到 Phase A 末尾独立 slice **A6**。
> 2. **仅代码 + 本地/LAN 模拟验证** — `@orpheus-aviary/owl-server` 真·发布 + 上云冒烟 = 另立 gated 步骤 **Aω**（需先重部署 skybridge），不在本轮。
> 3. **产出 = 子设计稿**，评审收口后再拆 commit 实现。
>
> **v2 评审收口（6 必须决策，已拍板）**：① cloud 缺 `account_lock` → **拒启**（fail-closed，3 态字段）· ② daemon public host 由
> **`public_url`/`allowed_origins`** 声明（非 skybridge `server_url`）· ③ cloud 下 `/sync/session` → **禁用** · ④ A6 local-token 后置 =
> **显式 override arch §7.6**，A1–A5 期间 simple-POST CSRF 仍开（A1 已部分收敛）· ⑤ `off` + 服务端 AI key → **拒启** · ⑥ 生命周期**按锁档区分**
> （locked 常驻 / off 引用计数 quiesce）。另含事实修正：profileId 用 `computeProfileId()`、daemon SDK duck-type 须先扩、cloud 登录走 GUI
> **两分支**（复用 device）+ 失败补偿 + 串行 mutex、cloud 状态源改 CredentialStore、`PublicOwlConfig` 投影免 sentinel round-trip。

---

## 0. 目标与非目标

**目标**：把现有 daemon 从「只对 loopback、无鉴权」升级为可安全暴露的**云端共享后端**：加 `[daemon].mode`（local/cloud）开关、
cloud 端点鉴权（Layer 2 浏览器会话）、cloud daemon 自发起 skybridge 登录链（Layer 1，凭据内存态）、账号锁、跨源硬化（CORS allowlist + Host 校验）、
`GET /config` secret redaction。**local/Electron 桌面端行为零变更**（默认 `mode=local`、bind loopback、auth preHandler 在 local 下 no-op；唯一例外 = A1 的 CORS/Host 收紧，见 §4.1/§7）。

**非目标 / 显式后置**：
- **local 模式 mutating-token CSRF 硬化** → slice **A6**（云优先决策；**显式 override 父设计 arch §7.6「Phase A 含 local」**，见 §7 A6 + §10）。
- **owl-server npm 发布 + 内嵌 web 包 + 上云 + 真机冒烟** → gated 步骤 **Aω**（需先重部署 skybridge；内嵌 web 包依赖 Phase B 才存在的 `apps/web`）。
- **web 端页面 / 响应式 / 编辑并发 / token 只存内存 / sanitize+CSP** → **Phase B**（本设计只保证服务端契约就位、`getAuthHeaders` seam 可被 web 消费）。
- **TLS / 反代** → 部署件；daemon 恒明文 HTTP，TLS 与否纯是部署档之别（arch §8）。
- **内容 E2E / 凭据加密落盘 / 移动推送 / setup-token 安装向导** → 更后（arch §7.7、§14 #1/#2/#3）。

---

## 1. 现状调查（2026-06-12 实扫，带行号；v2 含评审核对的 3 处关键修正）

| 面 | 现状 | 文件:行 |
|----|------|---------|
| CORS | `origin: true`（**任意网页可跨源打本机 daemon**，CSRF/DNS-rebind 靶） | `daemon/src/server.ts:35` |
| 绑定 | 硬编码 `host: '127.0.0.1'` | `daemon/src/cli.ts:151` |
| 鉴权 | **无任何端点鉴权**；唯一闸是 switch-gate `preHandler`（只对 mutating 方法做 503 quiesce） | `daemon/src/server.ts:46` |
| `[daemon]` 配置 | 仅 `{ poll_interval_min, port }`；deepMerge 回填缺省 | `core/src/config/index.ts:45,147` |
| `GET /config` | 直接回 `ctx.config`（**含 `llm.api_key` 明文**） | `daemon/src/routes/config.ts:118` |
| **profileId 公式** ⚠ | `computeProfileId(serverId,userId)` = `sha256(serverId + "\n" + userId).slice(0,32)`（**不是** `sha256(server_id‖user_id)`；手算会锁死 owner） | `core/src/profile/id.ts:63` |
| Layer 1 登录 | **daemon 被动收**：`installSkybridgeSession(ctx, 全量 payload)`；GUI main 先远程 login+register+ensure 再 `POST /sync/session` 注入 | `session.ts:284` / `gui sync-auth.ts:209-338` |
| **daemon SDK duck-type** ⚠ | `SkybridgeClientModule.login` 只声明 `→{serverUrl,token,user}`，**无 serverId/refreshToken/expiresAt、无 `refresh`** —— A3 须先扩 surface | `session.ts:136-151` |
| 真实 SDK | `login→AuthContext{serverUrl,token,user,refreshToken?,expiresAt?,serverId?}`；另有 `refresh()`/`getServerInfo()`/`getServerTime()`（均 0.1.4） | `node_modules/@orpheus-aviary/skybridge-client/src/{auth-context,client}.d.ts` |
| 「daemon 自登录」先例 | `dev-bootstrap.ts`：双 env 闸 + 生产 hard-panic（最接近的「daemon 自装会话」，但仍只组装、不发起远程 login） | `daemon/src/sync/dev-bootstrap.ts` |
| GUI 登录链（cloud 要移植的真身） | 两分支（return-visit switch→reuse device / first-login register）+ serverId 校验 + switch-lock + 失败 rollback + remote logout + refresh 串行（`runSwitchExclusive`） | `gui sync-auth.ts:209-338,474-573` |
| **`readSyncStatus`** ⚠ | **只读 `skybridge_config.toml`**：cloud 不写 toml 时即使 `ctx.skybridgeSession` 已有，也报 `configured:false/server_url:null` —— cloud 须改状态源 | `daemon/src/sync/manual.ts:305-312` |
| auth seam（Step 0 已建） | transport `getAuthHeaders()` 默认 `{}`，**REST + `/ai/chat`(streamSse) + `/events`(subscribeSse) 三路都已 spread** | `shared/src/transport.ts:28,74` / `shared/src/sse.ts:126,201` |
| 健康检查 | `GET /status`（GUI/CLI 都依赖），非 `/health` | `daemon/src/routes/system.ts:6` |
| 后台同步句柄 | `ensureBackgroundHandles(ctx)` 在 `ctx.skybridgeSession` 非空时拉起 SSE bridge + sync scheduler；`/sync/session` 路由已用 stop→null→install→ensure replace 舞 | `daemon/src/routes/sync.ts:198-231` |
| 守卫 | `just check` 8 shell 守卫（含 `daemon-no-toml-write`/`daemon-no-electron-storage`/`no-prod-env-token`/`session-body-not-logged`）+ lint + tsc | `justfile:70` |

**关键复用点**：cloud Layer-1 绑定 = 复用 `installSkybridgeSession` + `ensureBackgroundHandles` 的 replace 舞 + **GUI 登录链的两分支/补偿/串行逻辑**；
真正新增的只是「daemon 自己发起远程 login/register/ensure」+「先扩 SDK duck-type」。

---

## 2. 核心模型：两层会话 + 凭据内存态（reconcile arch §7.1/§7.7）

### 2.1 两层（arch §7.1）

| 层 | 是什么 | local（桌面） | cloud |
|----|--------|---------------|-------|
| **Layer 1 — 账号绑定**（daemon↔skybridge） | 这台 daemon 复制哪个账号（持 token、materialize profile X） | GUI main 远程登录后经 `/sync/session` 注入 | **daemon 自发起**（见 §2.2） |
| **Layer 2 — 客户端会话**（client↔daemon） | 这个客户端有没有权访问 daemon | **无**（auth preHandler no-op；A6 才上 local token） | **有**：每客户端过密码门拿 session token（TTL） |

`[daemon].mode` 一个开关决定 Layer 2 开不开。`mode=local` 时 auth preHandler 首行 `return`（桌面端零变更，A6 前）；`mode=cloud` 时全端点强制 bearer。

### 2.2 cloud Layer-1 = **浏览器登录驱动**（⭐ 核心决策 §9 #1）+ 两分支 + 失败补偿 + 串行

arch §7.7「v1 只存内存、**重启需重登**」+ §7.1「cloud 首次完整登录设 Layer 1」+ §7.7「daemon 自发起 login」三者推出：
**不在启动时用 env 预置密码自动登录**，而是 owner 经浏览器提交密码 → daemon 用该密码自己跑 skybridge 登录链。

**移植 `gui/src/main/sync-auth.ts` 的真身（不可简化为直线流程）**，搬进 daemon 侧一个 `cloud-login.ts`：

```
POST /auth/login {email, password}    （cloud 唯一 public 鉴权入口；走 TLS）
  ── 经 daemon 内进程 login mutex 串行（防并发 /auth/login race，见下）──
  1. sb.login(server_url_固定, email, password) → AuthContext{token, refreshToken?, expiresAt?, serverId?, user}
  2. require serverId（R5：0.1.4 server，否则 SkybridgeServerTooOld）；profileId = computeProfileId(serverId, user.id)
  3. 校验 account_lock（§5.1）：locked 且 profileId≠owner → 拒；off 且别账号活跃 → 拒（§5.3）
  4. ── 两分支（同 GUI，§9 #6 修正「always register」错）；用 switchToProfileId(profileId) helper 封
        mkdir + paths.profileDbPath(id) + switchProfile(**dbPath**)——switchProfile 真实签名收 db **path** 非 id，
        逻辑同 /sync/switch 路由 sync.ts:158-176（§9 #15）──
     return-visit（profiles/<id>/owl.db 已存在）:
        switchToProfileId(profileId) → existingDeviceId = readSkybridgeDeviceId(sqlite)
        → device = existingDeviceId ? reuseDevice(...) : await registerNewDevice(auth)   （**fallback register**，同 GUI §9 #6）
        → ensureWorkspace
     first-login（无 db）:
        registerDevice → ensureWorkspace → switchToProfileId(profileId)（创建空 db）
        （cloud 无 local→account claim：cloud daemon 无 local profile 可认领，跳过 §5.5 claim）
  5. installSkybridgeSession(ctx, …)（复用）→ ensureBackgroundHandles（复用）
  6. CredentialStore.set(RAM)：token/refreshToken/expiresAt/identity   ← 永不写盘
  7. scheduleRefresh(expiresAt)（refresh 语义见 §2.3——必须 rebind，否则到期坏）
  8. SessionStore.mint(profileId) → 铸 Layer-2 session token（RAM）
  ← 返回 {session_token, expires_at, identity}；日志打 `account logged in: profileId=<x>`（无 token）
失败补偿（移植 sync-auth.ts:324 unwind）:
  bestEffortRemoteLogout(auth)（撤新铸 skybridge token）+ 若已 switched → rollback 到 prior profile（cloud 一般是「无绑定」初态）
```

- **凭据内存态（§7.7、§9 #2）**：skybridge token/refreshToken 收进 `CredentialStore` 抽象（in-RAM 实现），**永不写盘** → `check-daemon-no-toml-write.sh` 守卫**原封不动**。代价：daemon 重启后 owner 重登（可接受；加密落盘是后续纯增量）。
- **device 复用（§9 #6 修正）**：profile db 持久化在 cloud 服务器磁盘（materialize 的数据本体），`persistSkybridgeIds` 把 `skybridge_device_id` 写进该 db。故即便 token RAM-only，**device_id 跨重启存活**，return-visit 分支 reuse 不会每次重登都注册新设备。
- **并发串行（§9 #5 修正）**：daemon 单进程是其 nest 的唯一 writer，但并发 `POST /auth/login` 仍要串行 → 加**进程内 login mutex**（同 GUI `runSwitchExclusive` 精神，daemon 侧自建轻量版）。跨进程 `switch-lock.ts` 文件锁对独占 cloud daemon **非必需**（可选 belt-and-suspenders，default 不引入）。
- **password 不进 toml / 不进 env**：toml `[daemon]` 只放非密配置；密码只随浏览器登录流过，用完不留；handler 禁 log（§10 守卫）。
- **多设备同账号**（Model A，arch §7.2）：第 2+ 浏览器同账号登录 → 密码校验过、profileId 命中已绑定 profile → **只铸新 Layer-2 token、不重切 profile**（共享一 owl.db；SSE 实时广播；无 skybridge 冲突）。

> **被否方案**：boot 读 `OWL_CLOUD_PASSWORD` env 自动登录（违「重启需重登」、钉死密码、owner 无法不重启登录）。env 路径仅留 dev-bootstrap（已存在、双闸 + 生产 panic）。

### 2.3 refresh 语义：必须 rebind（⭐ §9 #14 修正——只续期不重建 client 会到期坏）

daemon 侧 refresh 定时器 ~expiry 前触发，**不能只换 store 里的字符串**：`ctx.skybridgeSession.realClient` 是用旧 token 经 `buildClient`(authContext) 造的（`session.ts:176`），不重建就一直拿旧 token，access 过期后**同步 push/pull + SSE bridge 全坏**。GUI 现在的做法是 refresh 后**重新 `POST /sync/session`** 走 replace 舞——cloud 要在进程内等价复现：

```
refresh = （经同一 login mutex 串行）
  1. sb.refresh(server_url, refreshToken) → ApiRefreshResult{token, refreshToken(rotated), expiresAt}
  2. CredentialStore.rotate(新 token/refreshToken/expiresAt)
  3. rebindSession(ctx, 新 auth)：复用 install replace 舞但 **不切 profile**（同 profile，仅换 token）
       → stop→重建 realClient(新 authContext)→ensureBackgroundHandles（SSE bridge 用新 token 重连）
  4. scheduleRefresh(新 expiresAt)（分段 long-timer 防 32 位溢出，carry-forward ef059b2）
  5. refresh 失败(REFRESH_INVALID/REPLAYED) → 撤销会话 + 标 Layer-1 需重登（owner 重新 /auth/login）
```

> 把 `installSkybridgeSession`+`ensureBackgroundHandles` 的 replace 舞抽成 `rebindSession(ctx,auth,{switch?})`，`/auth/login`（switch=true）与 refresh（switch=false）共用，避免两份漂移。每次 refresh churn 一次 SSE 重连，可接受（bridge 退避重连成熟）。

---

## 3. 配置：`[daemon]` 扩展 + bind 矩阵 + 启动守卫（fail-closed）

### 3.1 `DaemonConfig` 扩展（`core/src/config/index.ts`）

```ts
export interface DaemonConfig {
  poll_interval_min: number;
  port: number;
  mode: 'local' | 'cloud';        // 默认 'local'
  bind: string;                   // 默认 '127.0.0.1'
  // ── cloud 专属（local 忽略）──
  server_url?: string;            // 固定 skybridge URL（公网 daemon 不让登录者填，防 SSRF，arch §7.4）
  account_lock?: string;          // 3 态：<ownerProfileId> | 'off' | 缺省→拒启（§3.2 ①）
  public_url?: string;            // ② daemon 自身公网 origin（如 https://owl.example.com）；Host allowlist + 同源 CORS 由此派生
  allowed_origins?: string[];     // ② 额外放行 origin（如单独托管的 web origin）；可选
  allowed_hosts?: string[];       // ② 额外放行 Host（多 hostname / LAN IP）；可选
  session_ttl_min?: number;       // Layer-2 会话 TTL（默认 720=12h，滑动续期，§4.2）
  trust_proxy?: boolean;          // 默认 false；true → Fastify trustProxy 读 X-Forwarded-For（限速 per-IP 才有意义，§4.3）
}
```

`DEFAULT_CONFIG.daemon` 补 `mode:'local'`, `bind:'127.0.0.1'`。deepMerge 回填 → 现存 toml 无新字段 → 取默认 → **桌面端零变更**。
`cli.ts:151` `host:'127.0.0.1'` 改 `host: config.daemon.bind`。

### 3.2 bind 矩阵（arch §3）

| 部署 | mode | bind | 前置 |
|------|------|------|------|
| 公网正式 | cloud | `127.0.0.1` | 反代 + TLS（反代绑 `0.0.0.0:443`，daemon 只对反代可达） |
| LAN / 调试 | cloud | `0.0.0.0` | 显式 opt-in，纯 IP，无反代 |
| local / Electron | local | `127.0.0.1` | — |

### 3.3 启动守卫（`cli.ts` listen 前，全部 hard-refuse + 明确中文报错）

1. `bind` 非 loopback（≠ `127.0.0.1`/`::1`/`localhost`）**且** `mode=local` → 拒（红线「`0.0.0.0` + 免鉴权」；A6 前/后 local 都只能 loopback）。
2. `mode=cloud` 缺 `server_url` → 拒（cloud 必须有固定 skybridge）。
3. **① `mode=cloud` 缺 `account_lock`（未显式 `<profileId>` 或 `'off'`）→ 拒**（fail-closed）。报错指引 bootstrap：**主路径 = `owl-server compute-owner --server-url <url> --email <email>`**（密码经**交互式隐藏输入**或 `--password-stdin`；一次性 login + getServerInfo → 算 profileId 打印 → 丢弃 token；**不启动服务、与 AI key 无关**，已提前进实现 §7 A3）；**回退路径（仅当未配服务端 AI key）** = 以 `account_lock='off'` 登录一次抄日志 `account logged in: profileId=<x>`（避开守卫 #4 与守卫 #3 互锁的死结）。TOFU-RAM-claim 被否（重启重开认领窗口 → 抢注 race）。
4. **⑤ `mode=cloud` + `account_lock='off'` + `resolveLlmConfig(config).api_key` 非空 → 拒**（可切账号 cloud 不得持服务端 AI key；锁到 owner 或移除 key）。
5. **② `mode=cloud` 既无 `public_url` 又无 `allowed_hosts` → 拒**（**不限 bind**：正式档是 cloud + bind `127.0.0.1` + 反代，缺 `public_url` 会启动成功却被 Host 校验挡掉反代的 `Host: owl.example.com`；loopback host 恒隐式放行，本地模拟显式配 `public_url='http://127.0.0.1:<port>'`，见 §8）。
6. **⑥ 新字段 runtime validation**（`loadConfig` 只 deepMerge+cast 不校验，拼错进奇怪态）：`mode ∈ {local,cloud}`；`account_lock === 'off' || isHexProfileId(account_lock)`；`server_url`/`public_url` 经 `normalizeServerUrl`、`allowed_origins[]` 元素经 `URL`/origin 解析（否则 `InvalidServerUrlError`）；**`allowed_hosts[]` 按 `host[:port]`/IP/`localhost` 规则校验（是 Host 值、非 URL，不走 URL parser）**；`session_ttl_min` 为正数且在合理范围。校验失败 → 拒启 + 报错点名字段。

---

## 4. 端点鉴权（Layer 2）+ 跨源硬化

### 4.1 CORS allowlist + Host 校验（**早做；唯一在 cloud 前就动 local 行为的片，谨慎**）

替换 `server.ts:35` 的 `origin:true`：
- **CORS allowlist**（`@fastify/cors` `origin` 传函数）：放行 = 无 `Origin` 头（CLI/curl/同源直发）∪ Electron renderer（dev `http://localhost:5173` / prod `loadFile`→`file://`→Origin `null`）∪ **②** cloud 的 `public_url` 派生同源 + `allowed_origins`。
- **Host 头校验 hook**（`preHandler`；**CORS 挡不住 simple-request 的 DNS-rebinding，Host 校验才行**）：放行 = loopback(`127.0.0.1`/`localhost`/`::1`) ∪ **②** `public_url` host ∪ `allowed_hosts`；其余 → 403/421。
- **public route allowlist**：`/status` 免 bearer（Host 仍校验）。

> ⚠ 收紧触及已发版桌面端。护栏：allowlist 必覆盖 dev(`localhost:5173`)/prod(`file://`→null)/CLI(无 Origin)/`127.0.0.1:47010`；daemon 单测钉各 case；`just dev` 手测首屏/同步状态条/AI 流无回归。

### 4.2 鉴权 preHandler + SessionStore（Layer 2 闸）

- **`SessionStore`**（in-RAM）：`mint(profileId):token` / `verify(token):Session|null` / `revoke(token)` / `revokeAll()` / TTL 滑动续期 + 周期清扫 + **持有 token→live `/events` reply 的映射**（§5.3 撤销时主动关流）。token = `crypto.randomBytes` 不可猜。
- **auth `preHandler`**（注册在路由前，紧贴现有 switch-gate hook，`server.ts:46` 同位）：
  ```
  if (mode === 'local') return;                  // A6 前 no-op（桌面端零变更）
  if (isPublic(req.url)) return;                  // /status、/auth/login、（Phase B）静态资源
  const session = SessionStore.verify(bearerFrom(req.headers.authorization));
  if (!session) → 401 { error_code: 'SESSION_REQUIRED' | 'SESSION_EXPIRED' }
  req.session = session;                          // 下游 owner-gate 用（§5/§6）
  ```
- **bearer-in-header（非 cookie）** → 跨站页面读不到 → 免疫 CSRF（arch §7.6）。`/events`(GET SSE) 过同一 preHandler；`subscribeSse` 已带 `authHeaders()`（Step 0）。
- **seam 闭环**：cloud web（Phase B）`configureTransport({ getAuthHeaders: () => ({ Authorization: \`Bearer ${sessionToken}\` }) })` → REST + `/ai/chat` + `/events` 三路自动带 token。

### 4.3 `/auth/*` 端点（cloud）+ `/sync/session` 禁用

| 端点 | 鉴权 | 作用 |
|------|------|------|
| `POST /auth/login` | public | §2.2 全链 + 限速/退避锁定（抗暴力，arch §7.3）。**禁 log password/token**（扩守卫覆盖）。 |
| `POST /auth/logout` | 需 session | `{all?:bool}`：默认撤当前 session；`all` → `revokeAll()` + 释放 Layer-1 + remote-revoke（§5.3）。 |
| `GET /auth/session` | 需 session | whoami（identity + expires_at），滑动续期。 |

> **③ cloud 下禁用全部 GUI-main plumbing 端点（404/403）**：`POST /sync/session`（无 `server_id`、不受固定 `server_url` 约束 → 绕过 account_lock/URL）、`POST /sync/switch`（`sync.ts:158` 直切 active DB，`switchProfile` 会清 `ctx.skybridgeSession`，`profile-switch.ts:63` → 绕过 account_lock/生命周期）、`POST /sync/logout-local`（`sync.ts:238` → 绕过 `/auth/logout` 的 remote-revoke/引用计数语义）。**cloud 的账号绑定/切换/释放只走 `/auth/login` + `/auth/logout`。** dev 种子用既有 `OWL_DAEMON_DEV_TOKEN`（生产 panic 闸），无需例外。**local 三端点全保持现状**（GUI main 注入/切换/登出）。

> **限速 keying（§9 #5 修正——反代后裸 IP 全是 127.0.0.1）**：`/auth/login` 限速**默认 key = account/email + 一个 global bucket**，不默认按 IP（公网正式档 daemon 绑 loopback、前面是反代 → `req.ip` 恒 `127.0.0.1`，per-IP 退化无意义）。per-IP bucket **仅在显式配 `trust_proxy`（Fastify `trustProxy` + 读 `X-Forwarded-For`）时**启用——是 keying-source 决策，非阈值；阈值（提案 5 次/5min + 退避）实现时定。

---

## 5. 账号锁 + 释放/切换 + 生命周期（arch §7.3/§7.4/§7.5）

### 5.1 `account_lock` 3 态（owner = `computeProfileId(serverId, userId)`，部署预配置）

| 值 | 行为 |
|----|------|
| `<ownerProfileId>`（**推荐默认**） | `/auth/login` 算出 profileId ≠ owner → 拒（即使 Layer-1 空闲，别人也绑不上）。owner 用 `computeProfileId()` 算（**不要手算** `‖`）。 |
| `'off'` | 只锁 URL：允许在固定 server 上**切账号**，遵守 §5.3 释放规则 + §3.3 ⑤ 禁服务端 AI key。 |
| 缺省 | **§3.3 ① 拒启**。 |

### 5.2 AI key 安全（§3.3 ⑤ 落地）

- `off` + 服务端 key → **拒启**（见 §3.3 ⑤）。
- 锁到 `<owner>` 时：每个 Layer-2 session 必是 owner（只有 owner 能绑），故 `/ai/chat` + `/llm/test` **天然 owner-only**，无需额外 per-endpoint AI gate。

### 5.3 释放 / 切换 / 生命周期（⑥ 按锁档区分）

| 事件 | locked（`<owner>`，默认） | off（可切账号） |
|------|---------------------------|------------------|
| **单 session 登出 / TTL 过期** | 撤该 token + **主动关该客户端 live `/events` 流**（preHandler 只在连接建立时跑，已开流须显式 kill：SessionStore 持 token→reply 映射）；无 remote-revoke；Layer-1 不动 | 同左 |
| **Layer-1 常态** | **常驻**：refresh 定时器 + 后台同步全程在（专用 always-on 副本，连上即最新） | **引用计数**：最后一个 Layer-2 session 消失 → grace 计时 → quiesce Layer-1（停 refresh + `stopBackgroundHandles` + 关 SSE；**无 remote-revoke、保 device_id 于 db 供 reuse**）→ 账号释放可切 |
| **显式「登出所有」**（owner 动作） | `session.realClient.logout()` remote-revoke + 全拆 + `revokeAll()` Layer-2 | 同左 |
| **别账号 Y 顶 X** | N/A（锁死） | X 有活跃 session → 拒 Y；X 全释放(free) → 绑 Y（arch §7.3「Y 永不强顶活着的 X」） |
| **切换前 flush 失败** | N/A | 允许切换 + pending 留本地 profile db 续传 + `pending_count` 显示（arch §14 #6；复用 `switchProfile` 现不主动 final-sync） |

- **数据安全不变量（§7.5）**：锁保护「占用权/可用性/AI 额度」，非机密性；profile 隔离保证 Y 绑上 materialize 的是 Y 自己的库。

---

## 6. `GET /config` secret redaction + owner-gate（arch §9；⑥ 修正 sentinel round-trip）

cloud 模式（`config.ts`）：
- **定义 `PublicOwlConfig`**（shared 类型）：从 `OwlConfig` 派生、**省略 secret 字段**（`llm.api_key` 等）+ 加 `llm.has_api_key: boolean` 标志（不放 `'***'` 哨兵）。
- **`GET /config`**：cloud 非 owner session → 回 `PublicOwlConfig` 投影；owner / local → 回全量 `OwlConfig`。`redactConfig(config, {owner})` 纯函数单点。
- **`PATCH /config`**：`llm.*` 写 **owner-gate**（`req.session.profileId === account_lock owner`，或 local）；非 owner 的 `llm.*` patch 拒。**因投影不含 `'***'` 哨兵 → 无 round-trip 写回占位符的洞**（直接避开，不靠 PATCH 忽略 sentinel）。
- **契约对齐**：Step 0 已注 shared `/config` 为 local-contract；本步落地后更新注释为「cloud 下 GET 可能是 PublicOwlConfig 投影」；Phase B web 据此裁 key 配置 UI（但「隐藏 UI ≠ 保护数据」，真闸在此）。
- **cloud 状态源修正（§9 #7）**：cloud 下 `readSyncStatus` 不能只读 toml（`manual.ts:305` 会报 `configured:false`）→ cloud 从 `CredentialStore`/`ctx.skybridgeSession` 取 `configured/server_url/device_id/workspace_id`，cursor/pending 仍读 sqlite。

---

## 7. 阶段拆分（云优先；A6 后置 = 显式 override；Aω 另立）

> 每片：小批 commit、每批 `pnpm -r build` + `just check`（含新守卫）+ `just test` + gated e2e 全绿、不夹带功能改动。**每次 commit 前询问用户确认**（CLAUDE.md 铁律）。`分步提交` 时 PROCESS.md 改动不与代码捆绑。

| slice | 内容 | 触桌面端? | 验证 |
|-------|------|:---------:|------|
| **A0** | `[daemon]` 扩展字段 + 默认 + deepMerge 回填；`cli.ts` bind 用 config；**6 条启动守卫**（§3.3，含 ①⑤② + ⑥ 字段校验） | 否（默认保持） | daemon 单测：守卫拒/放矩阵；loadConfig 回填默认 |
| **A1** | CORS `origin:true`→allowlist（含 `public_url`/`allowed_origins`）；**Host 校验 preHandler**（`public_url`/`allowed_hosts`/loopback）；public allowlist(`/status`) | **是（CORS/Host）** | 单测各 origin/host case；`just dev` 手测无回归 |
| **A2** | `SessionStore`(RAM/TTL + token→reply 映射) + auth `preHandler`（local no-op / cloud 强制 bearer）；401 codes | 否（local no-op） | 单测：cloud 缺/坏/过期 token→401；public 放行；local 放行；撤销关 SSE |
| **A3** | **先扩 daemon SDK duck-type**（login→serverId/refreshToken/expiresAt + `refresh`/`getServerInfo`）；`switchToProfileId(id)` helper（封 mkdir+path+switchProfile）；`CredentialStore`(RAM) + 自登录链模块（移植 GUI **两分支**含 fallback register + 抽 `rebindSession(ctx,auth,{switch?})` 复用 install/ensure）+ refresh 定时器（**rebind 语义 §2.3** + 分段 long-timer）+ login mutex + 失败补偿；**`owl-server compute-owner` CLI**（bootstrap 主路径，§3.3 ①） | 否 | 单测 mock SDK；本地 skybridge 验证自登录→句柄起→device reuse→**refresh 后同步/SSE 不坏** |
| **A4** | `POST /auth/login`（全链+限速+锁定+铸 Layer-2）/`/auth/logout`(单/all)/`GET /auth/session`；**cloud 下禁用 GUI-main plumbing（`/sync/session`+`/sync/switch`+`/sync/logout-local`）**；**account_lock** 3 态校验 + `off` 释放/切换 + 生命周期(§5.3) + cloud `readSyncStatus` 状态源改 | 否 | 本地 skybridge：登录→token→鉴权 CRUD→401→account_lock 拒→多设备→重启重登→**禁用端点 404** |
| **A5** | `PublicOwlConfig` 投影 + `GET /config` redaction + `[llm]` PATCH owner-gate；更新 shared `/config` 契约注释 | 否 | 单测：cloud 非owner 投影 / owner 全量 / local 全量 / 非owner llm patch 拒 |
| **A6**（后置，**显式 override arch §7.6**） | **local 模式 mutating-token**：GUI main per-boot 生成 token → preload 注入 renderer + 落 CLI 可读处；daemon 在 local 也校验 mutating 端点（扩 A2 preHandler + `getAuthHeaders`）；覆盖 CLI/GUI main/renderer/web 全调用方 | **是（全客户端）** | 全端手测回归（CLI `owl sync run`/`owl open`、GUI、renderer） |
| **Aω**（另立 gated） | `@orpheus-aviary/owl-server` 发布（含内嵌 web 包，依赖 Phase B）+ 上云部署 + 异地真机冒烟 | — | 重部署 skybridge → 真云 smoke |

**A6 显式 override 说明（④）**：父设计 arch §7.6 定「Phase A 必做含 local mutating 认证」；本设计据「云优先」决策后置到 A6。**A1–A5 期间 local CSRF 态**：A1 已收敛 DNS-rebinding（Host 校验）+ 跨源读响应（CORS allowlist），但 **cross-site simple-POST 仍开**（恶意页可裸 `POST /sync/run` 等打 `127.0.0.1`，无 token 拦截）—— 与已发版 0.5.0（`origin:true`）相比**严格更好但未闭环**，A6 才闭环。此 gap 在 A6 前**必须**在 PROCESS.md / release notes 标明。

---

## 8. 验证（本地/LAN 模拟，无真云）

- **rig**：`just ensure-node-abi`（cloud daemon 跑 standalone node、须先关 GUI，ABI carry-forward）→ 本地起 skybridge server → 隔离 nest 写 `owl_config.toml` 设 `[daemon] mode='cloud' bind='127.0.0.1' server_url=<本地skybridge> public_url='http://127.0.0.1:<port>' account_lock=<ownerProfileId>` → 起 daemon。
- **脚本/curl 驱动**（Phase B 才有 web；本轮脚本持 Layer-2 token）：
  1. 无 token CRUD → 401 `SESSION_REQUIRED`；`/status` 免鉴权通；坏 Host → 403。
  2. `POST /auth/login` 真密码 → 拿 session_token；带 token CRUD 通；`/events` 带 token 连上（emit→收）；无 token 连 `/events` → 401。
  3. `account_lock` 命中 owner 通 / 非 owner 拒；`off`+AI key → 启动即拒。
  4. `GET /config` 非 owner → `PublicOwlConfig`(无 api_key) / owner → 全量；非 owner PATCH `llm.*` → 拒。
  5. daemon 重启 → token 失效 → 重登（验「凭据内存态」）；return-visit 不新增 device（验 reuse）。
  6. cloud `GET /sync/status` 报 `configured:true/server_url=<x>`（验状态源改）。
  7. （可选）LAN 档 `bind='0.0.0.0'` + `allowed_hosts`，手机同 wifi 连桌面 IP。
- **守卫验证**：`daemon-no-toml-write` 在 cloud 自登录后仍绿（凭据 RAM-only）；新增守卫见 §10。

---

## 9. 决策表（v2 收口；⭐ = 已拍板核心）

| # | 项 | 结论 |
|---|----|------|
| ⭐1 | cloud Layer-1 触发 | **浏览器登录驱动**（`/auth/login` 提交密码，daemon 自发起 skybridge 登录链；RAM-only；重启重登）。否 boot-env 自动登录。 |
| 2 | 凭据/会话存储 | 全 RAM：`CredentialStore`(skybridge token/refresh) + `SessionStore`(Layer-2)。加密落盘 = 后续增量。 |
| ⭐3 | `account_lock` 缺省 | **3 态：`<profileId>` / `'off'` / 缺省→拒启**（fail-closed）；owner=`computeProfileId()`。bootstrap **主路径 = `owl-server compute-owner`**（不启服务、与 AI key 无关，已进 A3）；off-登录抄 profileId 仅作无 AI key 回退。setup-token 后续。 |
| 4 | Layer-2 TTL | 默认 **12h 滑动**（`session_ttl_min=720`），opaque 随机 token，per-客户端。 |
| 5 | 登录限速/锁定 | **默认 key = account/email + global bucket**；per-IP 仅 `trust_proxy`(XFF) 下启用（反代后裸 IP 全 `127.0.0.1`，§4.3）。滑窗阈值（提案 5次/5min）+ 退避，实现时定。 |
| ⭐6 | 生命周期 / 释放 | **按锁档区分**（§5.3）：locked 常驻；off 引用计数 quiesce；单 session 撤销关 SSE；登出所有 remote-revoke。 |
| ⭐7 | cloud `/sync/session` | **禁用**（404/403）；Layer-1 只经 `/auth/login`；local 不变。 |
| ⭐8 | daemon public host | **`public_url`**（+`allowed_origins`/`allowed_hosts`），非 skybridge `server_url`；驱动 Host+CORS。cloud **无条件**要求 `public_url` 或 `allowed_hosts`（**不限 bind**，§3.3 #5）。 |
| 9 | `off` + 服务端 AI key | **拒启**；locked 时 AI 天然 owner-only。 |
| 10 | config redaction | **`PublicOwlConfig` 投影**（省 secret + `has_api_key`），无 `'***'` 哨兵；PATCH `llm.*` owner-gate。 |
| 11 | profileId 文档表述 | 一律「`computeProfileId(serverId, userId)`」，**禁** `sha256(server_id‖user_id)` 误导写法。 |
| 12 | SDK duck-type | A3 先扩 daemon `SkybridgeClientModule`（login 返 serverId/refreshToken/expiresAt + `refresh`/`getServerInfo`）。 |
| ⭐13 | 新配置校验 | A0 启动守卫含 runtime validation：mode enum / `account_lock`('off'\|isHexProfileId) / URL 可解析 / TTL 正数（§3.3 #6）；`loadConfig` 不校验。 |
| ⭐14 | refresh 语义 | **必须 rebind**：rotate store + 重建 realClient/session + 保持 handles（§2.3）；只续期字符串会让旧 token 致同步/SSE 到期坏。 |
| ⭐15 | `switchProfile` 接口 | 真实签名收 db **path** 非 id → 用 `switchToProfileId()` helper 封 mkdir+`paths.profileDbPath`+`switchProfile`（§2.2）。 |

---

## 10. 风险与护栏

- **CORS/Host 收紧触及已发版桌面端**（A1）：allowlist 必覆盖 dev(`localhost:5173`)/prod(`file://`→null)/CLI(无 Origin)/`127.0.0.1:47010`；单测钉各 case + `just dev` 手测回归。**唯一在 cloud 前就动 local 行为的片。**
- **A1–A5 期间 local simple-POST CSRF 仍开**（④）：严格优于 0.5.0 但未闭环，A6 才闭；A6 前 PROCESS.md/release notes 必标。
- **`daemon-no-toml-write` 守卫**：cloud 凭据**必须 RAM-only**。护栏：`CredentialStore` 无 fs 写；单测断言 cloud 登录后 toml 未变；守卫注释加 cloud-creds-RAM scope。
- **新守卫（已定独立）**：① `auth-login-body-not-logged`（`/auth/login` 的 password/token 不入 log）；② `cloud-creds-no-disk`（`CredentialStore` 不得 import fs 写）。**拆开独立**——扫描目标不同，比塞进现有守卫的脆弱正则清楚（评审拍板）。
- **SDK duck-type 不全**（§9 #12）：A3 不先扩 surface，类型与 refresh 设计对不上 → A3 第一步硬卡。
- **cloud 登录链非直线**（§9 #5/#6）：缺失败补偿（rollback/remote-logout）/并发串行/两分支 device reuse → 埋 race + 设备膨胀。A3/A4 必移植 GUI 真身。
- **cloud 状态错报**（§9 #7）：`readSyncStatus` 只读 toml → cloud 报 `configured:false`。A4 改状态源。
- **token 进 log**：password/token 严禁进 log（pino redact + `redactToken()` + handler 不打 body）；refresh 定时器日志只打 `kind`。
- **long-timer 溢出**：refresh 定时器 >24.8 天溢出 32 位（carry-forward `ef059b2`）→ 分段（移植 sync-auth 现成逻辑）。
- **ABI**：cloud daemon 本地验证跑 standalone node → 先关 GUI + `just ensure-node-abi`。
- **skybridge SDK optional**：cloud 自登录用 SDK；clean checkout 无包 → `SKYBRIDGE_NOT_INSTALLED`（cloud 部署必装）。
- **`/config` 契约变更**（A5）：cloud 投影改 shape；shared 注释更新 + Phase B web 据此。
- **mode=local 零变更（A6 前，除 A1）**：auth preHandler `mode==='local'` 首行 return。**回归底线。**

---

## 11. 与 Step 0 seam 的衔接（已就位，本设计只「接真值」）

- `transport.getAuthHeaders()`：Step 0 返 `{}`；Phase A **服务端**校验 + **客户端**（Phase B web bearer / A6 local token）经 `configureTransport` 注真值。本设计聚焦服务端。
- `subscribeSse`/`streamSse`：已 spread `authHeaders()` → `/events`+`/ai/chat` 自动带 token，服务端只需让其过 auth preHandler（A2）。
- `PlatformAdapter`：cloud web 走 `webAdapter`（Step 0 已建）；Phase B 接 HTTP 实现。本设计不动 adapter。

---

*（v2.1，不含代码。评审收口后按 §7 slice 拆 commit 实现，A0 起手——本稿落地后即开工 A0。）*
