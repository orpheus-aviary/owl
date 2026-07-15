# A6 实施 plan：闭 local 模式 CSRF + GET 读泄露洞（local token）

> 状态：**实施 plan（v5，经四轮 review 收口，可开工），2026-07-15**。权威设计源 = `docs/plans/2026-06-12-phase-a-cloud-daemon-design.md` §7 A6 + arch `2026-06-06-mobile-web-ecosystem-arch.md` §7.6。
> v4→v5（review#4 修）：**token 同步发布 + 原子 `acquireDaemonLock` + 失败语义**（闭启动所有权/ready 竞态）· **S9 spawn 返 ChildProcess + 验 `/status.pid===child.pid` + owned handle 替 daemonStartedByGui**（不再"自 spawn 必新"）· **`pid`/`local_auth_version` 仅 local 返** · **boot `assertWebRootValid` 也改 cloud-only**（否则 local 仍因坏 web_root 拒启）· **dev-web cloud rig = 可执行 `scripts/dev-web-cloud.sh`，提前到 enforcement 前** · misc（D3 措辞/POST /notes 是 API/未注册无 token→401 有 token→404/`timingSafeEqualStr` 长度守卫/nonce/curl stdin/release-note 全破坏面）。
> 归属：Stage 1 #2（`docs/plans/2026-07-04-road-to-1.0.0.md`）。

---

## 0. 现状与 gap（实扫 2026-07-15）

`auth.ts:isAuthExempt` local 首行 `return true` → local daemon 对 API 零鉴权。两洞：① 跨站 simple-POST CSRF；② GET 读泄露（`access-guard.ts:69` 放行 `origin==='null'`，sandboxed iframe/`data:` 的 opaque origin 也是 `null` → 跨源 GET `/config` 读明文 `api_key`）。**A6**：合法本地客户端请求带 local token（`Authorization: Bearer`）。

---

## 1. 已拍板决策

| # | 决策 | 结论 |
|---|------|------|
| D1 | token 归属 | daemon 生成 + 写 0600 文件；GUI/CLI 只读；不开返回 token 端点。 |
| D2 | header | 复用 `Authorization: Bearer <token>`（`getAuthHeaders` seam + `bearerToken()`）。 |
| D3 | gate 范围 | local 下**除公开 `GET /status` 外，所有到达 auth gate 的业务请求都要 token**（含 GET/非-API/未来路由；OPTIONS preflight 由 `@fastify/cors` 在 gate 前答，不进 gate）。 |
| D4 | fail-open? | **fail-closed**：local `buildServer` 断言 `localToken` 必存在；测试经 harness 供真 token。 |
| D6 | secret 传输 | 不落 argv（`sandbox:false` → preload 有 fs）：preload 读 0600 文件；argv 仅非密路径。 |
| D7 | browser↔local | **browser=cloud**：local 只服务 Electron+CLI；**local 不托管 web 壳**（`registerWebHost` + `assertWebRootValid` 均 cloud-only；local 有 web_root → **warn+ignore**）。`just dev-web-cloud` 走 cloud rig。破坏性变更。 |

---

## 2. Token 生命周期 + 启动所有权（review#3#1 / #4#1）

- **内存生成÷同步发布**：装配处（buildServer 前）`ctx.localToken = generateLocalToken()`（纯内存 `randomBytes(32).toString('base64url')`）；**`server.listen()` 成功后、事件循环处理 HTTP 前，用同步 fs 发布**（`openSync(tmp,'wx',0o600)`/`writeSync`/`closeSync`/`renameSync`）——同步保证 daemon 首次答 `/status` 200 时文件必已就位，消除 "GUI 见 200→读 token→偶发 401"。
- **原子临时文件**：`daemon-token.<pid>.<nonce>.tmp`（`nonce=randomBytes(6).toString('hex')`），O_EXCL 创建即 0600，`try/finally` 失败清 tmp。
- **原子启动锁**（replace `boot.ts:66` 非原子 check-then-write）：`acquireDaemonLock()` = pid 文件 `wx` 创建；已存在则判 stale（pid 死）→ 删+重试，pid 活→"已在运行"退出。杜绝"两进程都过 check、失败者 `removePid()` 删掉成功 daemon 的 pid 文件"。
- **失败语义**：local token 发布失败 → close server + 释放 pid 锁 + 启动失败(exit 1)；cloud stale 删除 → 忽略 `ENOENT`，其他错误至少明确告警（倾向拒启）。
- **弃 shutdown unlink**（消 TOCTOU）；每 boot 同步覆盖即保证。
- **cloud 清 stale**：`mode==='cloud'` 且 **listen 成功后** `removeLocalTokenFile()`（防旧 local token 被当 bearer 发给 cloud daemon 致 `SESSION_INVALID`）。
- **renderer 刷新**：preload 暴露 **proxied 函数 `getDaemonToken()`**（每调用重读文件；contextBridge 冻结缓存值故必须是函数）；`getAuthHeaders` 每次调它 → REST+`/ai/chat`+`/events` 每次建连取新值，轮换后自动生效。

---

## 3. Commit 拆分（先客户端带 token→再翻 enforcement；cloud rig 提前；每步全绿）

> 每 commit：`pnpm -r build`（改 daemon 必 `just build-daemon`→`just test-daemon`；gated e2e = `just test-skybridge-e2e`）+ `just check` + 单测全绿。**commit 前问用户**；`分步提交` PROCESS.md 不捆绑。

### S0 — AppContext 字段 + 测试 harness（纯重构）
`context.ts` `AppContext` 加 `localToken?: string`。`testing/build-test-server.ts`：`buildTestServer(overrides)→{app,ctx,injectRaw,injectAuthed}`（`injectAuthed` 带 `Authorization: Bearer <ctx.localToken>`）。迁移 13 inject 文件：**所有 local API 请求（GET+mutating）→ `injectAuthed`**；**cloud-auth/安全边界/静态/`/status` → `injectRaw`**。gate 未上、header 忽略，全绿。

### S1 — core：`localTokenPath()` + `readLocalToken()`.

### S2 — dev-web cloud rig（提前；独立于 A6 代码，保 dev 流不断）
`scripts/dev-web-cloud.sh`（照 `dev-skybridge.sh`/owl-server rig）：隔离 nest `/tmp/owl-dev-web-cloud`、起 skybridge(:8443)、compute-owner 预置 `account_lock`、写 cloud `owl_config.toml`（mode=cloud/server_url/account_lock/bind=127.0.0.1/port=47030/public_url）、起 daemon、**mode 预检**（`/status.mode==='cloud'` 否则报错）、前台跑 Vite(:5274 proxy→47030)、`trap` 清 daemon+skybridge。`just dev-web-cloud`。旧 `just dev-web` 暂留（S10 移除）。dev 时 Vite 托管壳、daemon 只出 API（**无需 web_root**），浏览器 `/auth/login` 登录。

### S3 — daemon：token 模块 + 启动所有权（**不 enforce**）
`local-token.ts`：`generateLocalToken()`（纯内存）、`publishLocalToken(token)`（同步原子 0600 + finally 清 tmp）、`removeLocalTokenFile()`。`pid.ts`：`acquireDaemonLock()`（原子 wx + stale 重试）。`boot.ts`：装配处 `ctx.localToken=generateLocalToken()`；用 `acquireDaemonLock` 替 check-then-write；**listen 成功后**同步 `publishLocalToken`（local）/ `removeLocalTokenFile`（cloud）；失败语义（上 §2）；无 shutdown unlink。

### S4 — CLI：`daemonAuthHeaders()` + 全直连点 + curl 脚本
`apps/cli/src/lib/daemon-auth.ts`（`readLocalToken()`→bearer/`{}`）；接入 `backend/http.ts:request`、`commands/sync.ts`(`withDaemonHttp`)、`commands/open.ts:38`。（`daemon-detect.ts` GET `/status` 不带。）`scripts/skybridge-sync-once.sh`：**stdin curl-config**（`read -r tok < file; printf 'header="Authorization: Bearer %s"' "$tok" | curl --config -`，保 raw JSON+jq 输出契约，不换 `owl sync run`；内建不 fork、token 不入 argv）。

### S5 — GUI main：`daemonAuthHeaders()` + 全直连点 + 传路径给窗口
main `daemon-auth.ts`；接入 `sync-ipc.ts:129/169/234/272`、`sync-auth.ts:884/896/928`。`daemon.ts` `getLocalTokenPath()`；`main/index.ts:117` 后把非密路径传 `createWindow`；`window.ts` `--daemon-token-path`。

### S6 — preload：proxied getter + 类型
`preload/args.ts` `parseDaemonTokenPath`；`preload/index.ts` `owlAPI.getDaemonToken = () => { try { return readFileSync(path,'utf8').trim()||null } catch { return null } }`（函数）。`owl-api.d.ts` 加 `getDaemonToken?: () => string|null`。

### S7 — renderer：adapter + getAuthHeaders（fresh-read）
`platform/types.ts`+`electron.ts` 加 `getDaemonToken?()`；`renderer/src/main.tsx` `getAuthHeaders` 每次 `getPlatform().getDaemonToken?.()`。web(apps/web) 零改动。

### S8 — daemon：**翻 enforcement** + web host cloud-only + /status 能力位
- `buildServer` 顶断言 `mode==='local' && !ctx.localToken` → throw。
- auth gate（cloud 逻辑前）：放行仅 `GET /status`；其余业务请求 `bearerToken`+`timingSafeEqualStr` 命中→pass 否则 401 `LOCAL_TOKEN_REQUIRED`。**`setNotFoundHandler` 亦过 auth**（未注册路径：无 token→401、有正确 token→404，与 D3 一致）。`timingSafeEqualStr`：先比字节长度再 `crypto.timingSafeEqual`（等长 Buffer，防长度不一致抛异常→500）。
- **web host cloud-only**：`server.ts:154` `registerWebHost` 与 `boot.ts:92` `assertWebRootValid` **均 gate 在 `mode==='cloud'`**；local 有 web_root → warn+ignore（不校验也不托管）。
- `owl-shared` `LOCAL_AUTH_VERSION=1`；`routes/system.ts` `/status` 回体：**恒返 `mode`**；**`pid: process.pid` + `local_auth_version` 仅 local 返**（cloud 不泄露 OS pid、免 GUI 误判 cloud 为兼容 local）。兼容语义：`>=1`=强制 v1（`Authorization: Bearer`），未来 bump 须向后兼容 v1 否则收紧精确匹配。

### S9 — GUI：旧 daemon 检测（spawn 返 handle · 验 pid · owned · tri-state · 不擅杀）
- `daemon.ts` 重构：`spawnDaemon()` 返 **`ChildProcess`**（非 boolean）；保存 owned child handle/pid，**替 `daemonStartedByGui`+`readPid()` 停止逻辑**（`stopDaemonGracefully` 用 owned pid）。
- 每次 ready 探测验 `/status` 的 `mode==='local'` + 版本兼容 + `pid`；**自 spawn 后必须 `/status.pid===child.pid`**（否则是旧 daemon 抢占端口、子进程失败——不得当自己成功）。
- `ensureDaemonRunning` 返 tri-state `ready | incompatible | failed`。`main/index.ts` normal 分支（现无条件 createWindow）改：
  - `ready` → createWindow。
  - `incompatible`（复用到不兼容 daemon）→ 主窗口前原生 `dialog`；**仅当能证明身份**（`/status` 带 pid 且存活）才提供"停止并继续"（SIGTERM 该 pid + 重拉 + 复验）；**旧 0.5.0 /status 无 pid → 只能取消**，给打包用户**具体人工步骤**（"完全退出旧版 Owl（含菜单栏/Dock）；仍在运行则在活动监视器结束 Owl 后台进程；再重启"），不提 `just stop-daemon`。
  - `failed`（spawn 失败）→ **与 incompatible 不同对话框**（不显示"停止后台服务"）。
  - 取消/`failed` → `app.quit()`（不进全请求失败主界面）。**cloud daemon 即使返回 pid 也不提供停止**。

### S10 — docs：移除旧 dev-web + PROCESS/release-note（全破坏面）
`justfile` 移除/重指旧 `dev-web`→`dev-web-cloud`。release-note 记：**破坏性变更** = 除 `GET /status` 外所有本地 API 请求需带 `Authorization: Bearer <读 nest/owl/daemon-token>`；**旧 CLI/旧 GUI/curl/第三方本地 API 集成升级前无法访问新 daemon**（须更新为带 token 或升级）；browser↔local-daemon 不再支持（用 cloud）；**升级后必须重启 daemon**。移除"local simple-POST CSRF 仍开"警示。

---

## 4. 测试矩阵（逐层）

- **core**：`localTokenPath` 拼接；`readLocalToken` trim/缺失 null。
- **daemon token/所有权**（S3/S8）：`generateLocalToken` 纯内存不写盘；`publishLocalToken` 同步原子/恒 0600/tmp finally 清/覆盖旧；`acquireDaemonLock` wx/ stale 重试/ 活 pid 拒；轮换；cloud listen 后清 stale（忽略 ENOENT）；**并发/失败矩阵**——端口已占用第二次 boot 不动第一份 token 文件、失败者不删成功者 pid 锁、local↔cloud 先后启动 stale。
- **daemon gate**（S8，harness）：local 无 token→401（GET-API 如 `GET /notes`、mutating-API 如 **`POST /notes`(是 API)**、非-API 均验）；`GET /status` `injectRaw`→200；带 token→pass；**未注册路径无 token→401、有正确 token→404**；`timingSafeEqualStr` Unicode/超长/空 token 不抛(不 500)；缺 token 构造→throw；**cloud 全路径不变**；**OPTIONS/preflight 矩阵**（验 CORS 层：Origin `null`/loopback/恶意外站 + `Access-Control-Request-Headers: authorization`；注：OPTIONS 不进 gate）。
- **web host**（S8）：**local 无 token `GET /`→401**；**local 带 token `GET /`→404/非壳**（证 gate + 不托管两者）；**cloud `GET /`→壳**（回归绿）；local 坏 web_root **不再拒启**（warn+ignore）。
- **/status 能力位**（S8）：local 返 `{mode:'local', pid, local_auth_version:1}`；**cloud 只返 `mode:'cloud'`（无 pid / 无 local_auth_version）**。
- **CLI**（S4）：`daemonAuthHeaders` 有/无文件；backend/sync/open 带 header；`/status` 探活不带。
- **GUI main**（S5）：`daemonAuthHeaders`；sync-ipc/sync-auth 带 header；`--daemon-token-path`。
- **preload**（S6）：`parseDaemonTokenPath`；`getDaemonToken()` 读/缺失 null（函数）。
- **renderer**（S7）：adapter 暴露 getter；`getAuthHeaders` fresh-read；轮换后 REST+AI SSE+events SSE 三路自动新值；web adapter 不受影响。
- **旧 daemon**（S9）：`spawnDaemon` 返 child；`/status.pid===child.pid` 才认自 spawn 成功；tri-state；incompatible+证身份→可停、无 pid→只取消+人工步骤；failed≠incompatible 对话框；cloud 不提供停止；取消/failed 不 createWindow（mock dialog/spawn/kill/status）。
- **dev-web rig**（S2）：mode 预检探 `/status.mode`，非 cloud 报错。

**基线**：core/daemon(**405→+**)/cli(**137→+**)/gui(**441→+**)+gated e2e(**29**)；`just check`（+建议新 `check-local-token-not-logged`）。

---

## 5. 手测清单（GUI 前，Claude 后台 `just dev-daemon` + API 播种）

1. CLI 正常：`owl sync run`/`owl open`/建笔记 → 成功。
2. GUI 正常：建/编辑/删、AI 流、同步条/设备/手动同步 → 无回归。
3. 切档：Settings 登录/切 profile → 成功。
4. 裸跨站被拦（curl）：`POST /sync/run` 无 token→401 `LOCAL_TOKEN_REQUIRED`；`GET /config` 无 token→401；带正确 token→200。
5. 公开面：`GET /status` 无 token→200 且 `mode/pid/local_auth_version`（local）。
6. 重启刷新：GUI 运行中 `just stop-daemon && just dev-daemon`（新 token）→ REST+`/events`+AI SSE 重连后自动新 token。
7. 旧 daemon：模拟无 `local_auth_version` /status → 主窗口前弹框；有 pid 可停+重拉，无 pid 只取消+人工步骤；取消→退出。
8. cloud dev-web：`just dev-web-cloud` → 浏览器 `/auth/login` 登录后 CRUD（验 D7 + mode 预检 + trap 清理）。

---

## 6. A4 deferred（off grace-quiesce）——本轮不做，单列到"重构一轮"。

---

## 7. 实施记录（2026-07-15，S0–S9 已实现，落本地 `main`）

**A6 核心机制（S0–S9）全部实现 + 全绿。** 基线：core **532** / cli **139** / daemon **420** / gui **455** + gated e2e 不变；`just check`（tsc -b + biome + 守卫）全绿；`just test` exit 0。

| slice | commit | 内容 |
|-------|--------|------|
| S0 | `5d6107b` | `AppContext.localToken` + `testing/build-test-server.ts` harness（local 自动带 bearer + `injectRaw`；cloud no-op）；迁移 7 pure-local 测试文件 |
| S1 | `49edbc5` | core `paths.localTokenPath()` + `readLocalToken()`（新 `config/local-token.ts`）|
| S2/S3 | `66c7d69` | daemon `local-token.ts`（内存生成 / 同步原子 0600 发布 / cloud 清 stale）+ `pid.ts` `acquireDaemonLock`（原子 wx + stale reclaim）+ boot 装配（listen 后发布 / 失败语义 / 弃 shutdown unlink）|
| S4 | `399c5c4` | CLI `daemonAuthHeaders()` + http/sync/open 全接入 + `skybridge-sync-once.sh` stdin curl（token 不落 argv）|
| S5 | `825ab66` | GUI main `daemonAuthHeaders()` + sync-ipc/sync-auth 全接入 + `--daemon-token-path` 传窗口 |
| S6 | `b2dabf7` | preload 读 0600 文件 + proxied `getDaemonToken()`（非缓存值）+ 类型/stub |
| S7 | `4071a78` | renderer adapter `getDaemonToken?()` + `getAuthHeaders` fresh-read（REST+AI SSE+events SSE 自动轮换）|
| **S8** | `601eccd` | **翻 enforcement**：local 除 `GET /status` 外全要 token（fail-closed / gate / notFoundHandler）+ web host cloud-only（server+boot）+ `/status` `mode`/local-only `pid`/`local_auth_version`（owl-shared `LOCAL_AUTH_VERSION`）+ dev-web vite mode 预检 |
| S9 | `0985a4b` | GUI 旧 daemon 检测：`spawnDaemon`→`ChildProcess`、tri-state、`/status.pid===child.pid` 证身份才 own、原生 dialog、`stopDaemonGracefully` 只 signal owned pid |

**决策落地**：D1 daemon 生成+文件 ✓ / D2 `Authorization: Bearer` ✓ / D3 除 `GET /status` 全 API+非-API ✓ / D4 fail-closed ✓ / D6 secret 不落 argv ✓ / D7 browser=cloud ✓。

**未做 / 后补**（不阻断 A6 核心）：
- **S10 剩余**：PROCESS.md 收尾 + release-note 破坏面（旧 CLI/GUI/curl/第三方本地集成需带 token；升级须重启 daemon）；`just dev-web` 完整 cloud rig（`scripts/dev-web-cloud.sh`）——用户拍板"fail-fast 先行、完整 rig 后补"，待补。
- **手测**（必做，见 §5）：GUI 正常启动零回归 + 旧 daemon 弹框流 + 重启刷新（SSE 轮换）+ 裸跨站 curl 被拦。
- 可选新守卫 `check-local-token-not-logged`（pino 已 redact authorization，belt-and-suspenders）。

---

*（v5 + 实施记录。S0–S9 已 ship；S10 docs/rig + 手测待收尾。）*
