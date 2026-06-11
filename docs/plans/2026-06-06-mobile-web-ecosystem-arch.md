# owl 生态扩展架构设计：网页版 + 移动端

> 状态：**讨论定稿 v6，待你通审**。起草 2026-06-06（0.5.0 公开发版后），经多轮讨论 + 三轮代码核对收敛。
> v6：锁定 v5 的 4 项决策 + 护栏——`/events` **fetch-SSE + bearer**（+ RN fetch-streaming fallback）、flush **允许切换 + pending 留本地 + `pending_count` 显示**、owner **部署预配置 profileId**、Electron **走本地 token**（`app://` 后续）。
> v5 修订（第三轮代码核对）：**`/events` 原生 EventSource 不能带 bearer**（改 fetch-based SSE / 事件 token）、
> **mutating 鉴权要覆盖 CLI/GUI main/web 共享 client**（统一 daemon auth provider）、**释放/切换前 flush 失败策略**
> （现 `switchProfile` 不主动 final-sync）、**`account_lock` owner 身份格式 + bootstrap**、配置键 **`[server].mode`→`[daemon].mode`**
> （避与 skybridge `[server].url` 混）、**Electron renderer origin 精确化**（`file://`/null 不能裸放行）、乐观并发**类型/基线**细化、
> **mobile-safe core boundary**（core 顶层有 Node-only 面）、`/health`→`/status`、页脚版本。v3/v4 修订见 git 历史。
>
> 0.5.0 之后「扩生态」方向：新增**网页版**（服务器部署，异地登录查看 + 编辑）和**移动端**（Android + iOS）。
> 决策用「采用 / 定为」措辞；最终确认项集中在 §14。各阶段开工前再各自拉独立子设计文档（沿用 P5-d 习惯）。
>
> 前置阅读：`aviary/docs/SKYBRIDGE_ARCH.md`（同步骨架）、`docs/history/P5-d-shipped.md`（per-profile 隔离）。

---

## 0. 决策摘要

| 维度 | 决策 |
|------|------|
| 总体拓扑 | **云端 daemon 作为共享后端**：1 hub（skybridge） / N 副本（daemon） / M 视图（前端） |
| 云端 daemon | **改造现有 daemon 加「部署模式」，不重建**；一个 `owl-server` 二进制三种形态 cloud/local/Electron-spawned |
| 鉴权 vs 绑定 | **`mode` 管鉴权**（local 免登录 UX / cloud 端点鉴权）；**绑定地址是正交的部署选择**（见 §3 矩阵） |
| 网页版前端 | **与 daemon 同源绑定**（Fastify 静态托管 web 包）；瘦客户端；**v1 含编辑** |
| 平台适配 | GUI 对 Electron 有硬耦合（bootstrap/IPC/baseURL）→ **Step 0 抽 platform adapter + api client**，非「feature-detect 几处」 |
| 移动端框架 | **React Native（Expo + EAS）**：真原生视图 + 一套代码统一 iOS/Android |
| 移动端演进 | **v1 在线瘦客户端 → v2 本地优先（离线）**，前向兼容（数据层走 daemon 同形接口） |
| 仓库结构 | **R1**：web 进 owl monorepo（`apps/web`）；移动单开 `owl-mobile`，共享 `@orpheus-aviary/owl-shared` |
| 排期 | **web 先行**；与 0.6.0 清理编织（见 §12） |
| 多用户 | **Model A：一实例一账号（可顺序切换的单租户）**；多账号 = 多实例；并发多租户 Model B 延后 |
| 登录模型 | **两层**：Layer 1 账号绑定（daemon↔skybridge）+ Layer 2 浏览器会话（cloud 才有，`mode` 开关） |
| 访问硬化 | **CORS allowlist + Host 校验 + mutating 端点请求认证（含 local，防 CSRF）+ bearer-in-header**；`/events` **fetch-SSE + bearer**；Electron 走**本地 token**；`GET /config` secret redaction + owner-gate（§7.6/§9） |
| 释放/切换 | **X 本人主动释放 或 空闲/TTL 自动释放**；别的账号**永不强顶**活着的 X；破坏性操作藏在认证后；**flush 失败 = 允许切换 + pending 留本地 + 显示 `pending_count`** |
| 账号锁 | **`account_lock` 旋钮** + **cloud 模式 URL 部署固定**；默认专用实例锁定；**owner = profileId，部署预配置** |
| 云端凭据 | **v1 只存内存（不落盘）**：重启需重登，**不破「daemon 不写 toml」守卫**；后续可加密落盘（增量，§7.7） |
| AI key | 由**服务你的 daemon** 持有；web/移动用云端 key + 登录 + 会话 TTL；移动 v2 同桌面（on-device 持 key） |
| 附件 | **text-first：不做附件存储/同步、不做文件/图片上传**；markdown 外链图片照常渲染；W11 移除 |
| 加密 | **TLS/反代 = 公网默认**；纯 IP 不反代 = 仅局域网/调试 opt-in；内容 E2E 推迟 |
| 发布 | `owl-server` 先 **npm**，Docker 记录后做 |

> 最终确认项见 **§14**（很少）。

---

## 1. 两个底层事实（框定一切）

**事实 A — owl 内部早就是「客户端 ↔ 服务端」，只差跨网络。**
`GUI(React，纯 fetch) → daemon(Fastify，~51 REST 端点) → core(SQLite/drizzle)`。GUI 经一层薄薄的
`lib/api.ts` 调 daemon。**daemon 本身就是现成的可查询后端**，让它跨网络 + 加鉴权即可被 web/移动当瘦客户端复用。
（注意：~85% 指**组件树**可复用；bootstrap/IPC/baseURL 仍硬耦合 Electron，需 Step 0 抽 platform adapter，见 §0/§13。）

**事实 B — skybridge server 是「哑日志仓」，不能当查询后端。**
它只存 append-only 操作日志（`changes`，payload 不透明）+ 鉴权；**没有任何**「给我文件夹 X 的笔记」类查询端点。
客户端必须把操作日志在本地重放进 SQLite 才能查询。→ **不能让 web/移动直连 skybridge**；它们背后必须有一个
materialize 了笔记的 daemon。

---

## 2. 总体架构：1 hub / N 副本(daemon) / M 视图

- **hub = skybridge server**：所有副本经它同步；**副本之间从不直连**，全在 hub 收敛。
- **副本 = 一个 daemon** = `core + SQLite(materialize 的 owl.db) + 同步引擎(内嵌 skybridge client)`。
  每个 daemon 是 skybridge 上的「一个设备」，持有**可查询**的数据。可有多个。
- **视图 = 一个前端**（GUI / 网页 / 移动 UI / CLI）：**无 key、无数据**，经 HTTP REST 连**某一个** daemon 渲染。

三条铁律：① **skybridge client 不是独立进程**，是库，嵌在每个 daemon 的同步引擎里；
② **一个前端只连一个 daemon**——连哪个就决定「数据在哪、AI key 在哪、要不要登录」；
③ **AI 调用永远由「服务你的 daemon」发起**，key 跟着 daemon 走。

```
TIER 1 — 同步 hub
  skybridge server   远程·哑日志仓(op-log)+鉴权·一个部署一个
        ▲  push / pull / SSE      （由各 daemon 内嵌的 skybridge client 发起）
        │
TIER 2 — 数据/逻辑副本（= daemon，可多个，互不直连，全经 hub 收敛）
  ├─ 桌面 local daemon          core+SQLite+sync   127.0.0.1 · 无登录UX(CORS+Host硬化) · 默认托管 web 包
  ├─ 云端 cloud daemon           core+SQLite+sync   要鉴权 · bind 见 §3 矩阵 · 托管 web 包
  └─ 手机 on-device daemon (v2)  core+SQLite+sync   进程内 · 离线
        ▲  HTTP REST（经 api.ts；前端挂到其中一个 daemon）
        │
TIER 3 — 视图/前端（无 key、无数据，只渲染）
  ├─ GUI (Electron renderer) ──→ 桌面 local daemon
  ├─ CLI ─────────────────────→ 桌面 local daemon（或 --direct 内嵌 core）
  ├─ 网页端·本地自带 ──────────→ 桌面 local daemon（浏览器开 localhost）
  ├─ 网页端·服务器 ────────────→ 云端 cloud daemon（异地浏览器，登录 + 会话 TTL）
  ├─ 移动端 v1（在线） ─────────→ 云端 cloud daemon
  └─ 移动端 v2（离线） ─────────→ 手机 on-device daemon（进程内）
```

| 组件 | 是什么 | 进程形态 | 连谁 | AI key |
|------|--------|----------|------|--------|
| **skybridge server** | 远程 hub，哑日志仓 + 鉴权 | 独立服务器进程 | 被各 daemon push/pull；不直连前端 | — |
| **skybridge client** | 说同步协议的 SDK/库 | **非独立进程，嵌在 daemon 里** | 上连 skybridge server | — |
| **daemon** | 数据/逻辑节点 = Fastify+core+同步引擎 | 独立进程，3 形态 | 上同步 skybridge；下被前端 HTTP 调 | 自己 config 的 key |
| **PC app** | Electron 壳 + GUI + 自启 local daemon + 原生便利 | 桌面应用 | 内部 GUI 连内嵌 daemon | 本地 daemon |
| **GUI** | React 前端代码（视图） | 寄居 renderer 或浏览器 | 经 api.ts（platform adapter 解析 baseURL）调某 daemon | 跟所连 daemon |
| **CLI** | 命令行工具 | 进程 | local daemon HTTP（或 --direct） | 本地 daemon |
| **移动端** | RN 原生 app | 原生应用 | v1→云端 daemon；v2→进程内 daemon | v1 云端；v2 手机本地 |
| **网页端·服务器** | 浏览器加载云端 daemon 托管的 web 包 | 浏览器标签 | 云端 daemon（同源；登录 + TTL） | 云端 daemon |
| **网页端·本地自带** | 浏览器加载本地 daemon 托管的同一份 web 包 | 浏览器标签 | 本地 daemon（同源 localhost） | 本地 daemon |

**最易混点**：①「GUI」是视图代码，「PC app」是成品，GUI 非独立进程。② 两种网页端 = **同一份 web 构建产物**，
只是连的 daemon 不同；它和 Electron renderer 也是**同一份 GUI 代码**（~85% 组件 + 一层 platform adapter）。
③「PC app 自带 daemon」「云端 daemon」是**同一份 `owl-server` 不同模式**。

---

## 3. daemon：三模式单二进制（改造现有，不重建）

现有 `@owl/daemon` 全部复用，**净新增 = 部署模式 + 鉴权/会话/硬化层**：

- **`[daemon].mode` 管鉴权**（写在 `owl_config.toml` 的 `[daemon]` 段；**与 skybridge_config.toml 的 `[server].url` 是两回事，勿混**）：`local` = 无登录 UX（仍受 §7.6 硬化）；`cloud` = 每端点强制 bearer 鉴权 + CORS allowlist。
- **绑定地址是正交的部署选择**（与鉴权解耦）：

| 部署 | mode | bind | 前置 |
|------|------|------|------|
| **公网正式** | cloud（鉴权） | **127.0.0.1** | 反代 + TLS（反代绑 `0.0.0.0:443`，daemon 只对反代可达） |
| **LAN / 调试** | cloud（鉴权） | **0.0.0.0** | 显式 opt-in，纯 IP，无反代 |
| **local / Electron** | local（无登录 UX） | **127.0.0.1** | — |

> **禁止组合：`0.0.0.0` + 免鉴权** → 启动守卫拒绝启动。

- 三种运行形态（同一二进制）：① Electron-spawned（PC app 自启，local）；② local 独立进程（浏览器开 localhost）；③ cloud（服务器、登入账号、作为 skybridge 设备同步）。
- **桌面当 LAN 服务器（彩蛋）**：桌面跑 cloud（LAN 档：`0.0.0.0` + 鉴权），手机同 wifi 直连桌面 IP，**零云部署**家用多设备访问。红线：LAN 暴露必须带鉴权。

**发布**：npm 包 `@orpheus-aviary/owl-server`（对齐 `@orpheus-aviary/skybridge-server`）——bin + `engines.node>=22`
+ **把 `apps/web` 静态构建打进包**；部署复用 `skybridge/docs/deploy/ubuntu-baota.md`，**与 skybridge 同机共存**。
Docker 镜像作为后续发布形态（记录，先不做）。

---

## 4. 网页版

**采用：瘦客户端 + 与 daemon 同源绑定。** daemon 用 Fastify 静态托管打包好的 React，「部署网页版」=「跑一个 `owl-server`」，单进程。

- **两种网页端**同源同包，只是连不同 daemon：服务器网页端（连云端 daemon，登录 + 会话 TTL）/ 本地网页端（连本地 daemon localhost）。
- **v1 含编辑**（有键盘，完整编辑、预览/代码切换）。
- **性能**：瘦客户端是「便宜」的那个——Fastify + SQLite 服务单用户，微秒级查询、~100MB 内存，与 skybridge 同机。
  「吃性能」的反向方案（浏览器内跑 WASM 同步引擎）**不采用**。
- **平台化 baseURL**（修当前实现）：`api.ts` 现在 `?? 'http://127.0.0.1:47010'`（`api.ts:81`），对 web 是反的。
  改成 **platform adapter 解析**：Electron 用注入的 `daemonUrl`；web（同源 cloud/本地浏览器）用**相对路径**；
  并补 **bearer 注入钩子**（cloud 会话 token）。这块归入 Step 0 的 api client 抽出。

---

## 5. 移动端

**采用：React Native（Expo + EAS）。** RN 渲染**真正的原生视图**（非 webview），一套 TS 出双平台，需要处可下沉
Swift/Kotlin 原生模块。「大工作量」预算花在 RN UI 打磨（gesture-handler + reanimated 做拖拽排序、键盘上浮浮动标签栏）。

**v1（在线瘦客户端）→ v2（本地优先），且前向兼容**：

- v1：移动 UI → 云端 daemon（HTTP），与网页版共用后端。上线最快，离线不可用。
- v2：手机内嵌 on-device daemon/core（`expo-sqlite`）+ 同步引擎，直连 skybridge，离线可用，手机成为**独立同步设备**（第三个副本）。
  ⚠ **不是「drizzle 切方言」那么轻**——better-sqlite3 是**同步**、expo-sqlite 是**异步**，core 的事务（`engine.ts` `sqlite.transaction(...)`）
  pervasively 同步；v2 前置需一个**「DB driver/事务抽象 + 同步引擎 sync→async 可移植性」子设计**，不止换方言（见 §15）。
- **前向兼容关键**：移动端所有数据访问走**与 daemon REST 同形状的接口**（`owl-shared` 的 api client）。
  v1 实现 = HTTP 调云端 daemon；v2 = 调进程内 on-device core。owl 数据模型本就 client-authoritative / 操作日志制
  ——**v2 本地优先才是原生终态**，v1 是过渡，数据迁移无痛（经 skybridge 收敛）。
- **但别把 v1→v2 想成「UI 零改动」**：数据访问接口同形、组件大体复用，**但离线指示 / 后台同步状态 / 冲突解决 /
  安全存储解锁会引入新的 UI 状态机分支**——是增量，不是零改。
- **v1 须避开**：UI 散落硬编码远端 URL 的 fetch、假设永远在线（无 loading/乐观态）、假设服务端权威分配 ID。

**UX 规格**（落地细化）：底部导航（笔记[浏览/文件夹/回收站 顶部切换]、提醒、待办、设置）；点笔记进编辑；
编辑切「预览/代码」（**取消桌面分屏**）；底部输入/编辑标签随键盘上浮的浮动标签栏；保存 + 返回（返回询问是否保存）；
浏览页保留搜索/标签筛选/排序/置顶；文件夹按住拖拽整理。

**提醒推送**：是**独立增量模块**（提醒数据/调度已有；推送只是投递通道 `expo-notifications` + APNs/FCM），
**延后做、低返工**；移动端注册 device id（已有）以便日后映射 push token。

**实时更新（RN 护栏）**：daemon `/events` 走 **fetch-based SSE + bearer**（§7.6）；**RN 先单独确认 fetch streaming 支持，不稳则移动 v1 改轮询或 RN 专用 SSE 客户端**——不阻塞 v1。

---

## 6. AI / LLM key 架构

**事实**（`packages/daemon/src/routes/ai.ts` + `core/src/config/index.ts`）：AI 调用由 **daemon 服务端发起**，
读自己 config 的 `[llm].api_key`（→ 回退 `aviary_config.toml`）；**客户端从不持有 key**。

- **key 由「服务你的 daemon」持有**：桌面/本地网页/CLI → 本地 key；服务器网页/移动 v1 → **云端 daemon key**；
  移动 v2 → **手机本地 key（同桌面原理，on-device daemon 持 key，存手机安全存储 `expo-secure-store`）**。
- **web/移动用云端 key 成立**，靠**登录 + 会话 TTL** 保护。AI 在 web 和移动端**架构在内**，但**排期靠后**（后续入口，不阻塞首里程碑）。
- **config 不跨设备同步**（本地偏好）——桌面 key 不会自动出现在服务器，云端 daemon 的 key **单独配**。
- **隐私链路**：prompt + 正文走「客户端 → 服务你的 daemon → provider」，云端 daemon 与 provider 见明文（E2E 推迟）。

---

## 7. 账号 / 登录 / 会话安全模型（本设计讨论最深的部分）

### 7.1 两层模型（桌面把两件事合一，云端必须拆两件）

| 层 | 是什么 | 桌面(local) | 云端(cloud) |
|----|--------|-------------|-------------|
| **Layer 1 — 账号绑定**（daemon↔skybridge） | 这台 daemon 复制哪个账号（持 token、materialize profile X） | 有（桌面登录设） | 有（首次完整登录设） |
| **Layer 2 — 浏览器会话**（browser↔daemon） | **这个浏览器**有没有权访问 daemon（每客户端一个 session token） | **没有**（无登录 UX；靠 §7.6 硬化，非「localhost 可信」） | **有**（每浏览器各自过密码门拿 session） |

由 `mode` 一个开关决定 Layer 2 开不开——**不是两份代码、不是矛盾**。
**链接 ≠ 进入**：cloud 模式链接只让你够得着登录页；密码是门，之后身份靠 session token（TTL 内不重输）。

### 7.2 Model A：一实例一账号（可顺序切换的单租户）

- **同账号、多设备**：✅ 并发多个 session（像手机+电脑同登 Gmail），daemon 服务同一 profile X，**SSE 实时广播**改动。
  **不产生 skybridge 同步冲突**（同一个 owl.db，一个副本；冲突只发生在不同副本经 skybridge 之间）。
  ⚠ 但**同库并发编辑同一笔记仍会「后写覆盖」**——daemon 已支持乐观并发 `expected_updated_at`（`notes.ts:140`），但 GUI
  `patchNote` 没传（`api.ts:168`）。**web v1 含编辑前必须定**乐观并发（传 `expected_updated_at` + 冲突提示）+ 自动保存怎么配（§14 #4）。
- **不同账号、同实例**：daemon 一次一个 active profile → 默认拒绝；要并存就**起多个实例**（不同端口，反代分发）。
- **profile 按会话引用计数激活**：同账号还有任一会话在线就保持 active，最后一个退出/TTL 过期才 quiesce
  （借来的机器退出不会踢掉你笔记本会话）。
- 真要「一 daemon 并发多账号隔离」= 并发多租户 **Model B**，net-new 工作量，**延后**。

### 7.3 释放 / 切换安全

实例绑定 X 时，**只有两条路释放**：

1. **X 本人主动释放**：以 X 登录（或本有 X 活跃会话）→ 里面选「登出 / 登出所有会话 / 切换账号」。**需 X 密码。**
2. **空闲 / TTL 自动释放**（兜底）：X 会话全过期/空闲超 grace → daemon 自动 free（无活跃会话要保护，无需密码）。

**别的账号 Y 永远不能强顶活着的 X**（堵死「知道 Y 密码就能踢 X」的 footgun）。**破坏性操作（登出所有/切换）藏在 X 的已认证 UI 里**。
配套护栏：登录门**限速 + 失败退避/锁定**（抗暴力）+ **TLS**（密码不被嗅探）；web 端做自动存草稿 + 登出前提醒兜未提交草稿。
**切换前 flush 失败策略（已定：允许切换 + pending 留本地 profile db + 明确提示）**：现 `switchProfile`（`profile-switch.ts:56`）只停后台句柄 + 等已有 sync 结束、**不主动跑最终 sync**；离线 / skybridge 失败时 flush 会失败。
**不阻止切换**（否则「离线」变成「账号退不出/切不了」，太硬）。**数据不丢**（待推送改动留在该账号本地 profile db，下次该账号 active / 后台恢复时续传），但**不保证立即上 skybridge**。
两条护栏：① **切换 UI 必须说清**「已保存内容仍在本机 X profile，等 X 下次激活/后台恢复后继续推送」；② **profile 列表显示 `pending_count`/「N 条待同步」**，否则用户会忘掉这笔账。

**决策树**（登录 Y，实例当前绑 X）：
```
同账号 (=X)              → 加一个会话，永不顶                         ✅
不同账号 (=Y):
  ├ X 已全过期/空闲释放(free) → 直接绑定 Y                            ✅
  ├ X 仍有活跃会话           → Y 顶不动；须先以 X 登录、里面选切换；或等 X 自动释放
  └ account_lock=<X>        → 拒绝，去用 Y 的实例
```

### 7.4 锁：两个正交旋钮（`account_lock` + cloud 模式 URL 部署固定）

能锁两个维度：**URL**（哪个 skybridge）和 **account**（哪个用户，account 锁天然蕴含 URL 锁）。
**cloud 模式 URL 部署时固定**（登录只填 account+密码；换 skybridge = 改配置重启）——因为让公网 daemon 由登录者填任意 URL
是 SSRF/滥用风险。**local/桌面模式 URL 登录随便填**（自己的机器）。于是「多级锁」塌成：

| 部署 | URL | `account_lock` | = 档位 |
|------|-----|----------------|--------|
| 桌面/local | 登录随便填 | — | 全开 |
| cloud · 可顺序切换账号（单租户） | 部署固定 S | `off` | 只锁 URL：在 S 上**切账号** |
| cloud · 专用（推荐默认） | 部署固定 S | `<X>` | 全锁：**即使空闲别人也绑不上** |

**开锁(`off`)支持切 account，但不支持切 URL**。**不再加更细粒度**（YAGNI，个人工具不需要 per-account ACL）。

**owner 身份格式 + bootstrap（已定：部署时预配置 owner profileId）**：`account_lock=<X>` 的 `<X>` 用 **profileId = `sha256(server_id ‖ user_id)`**（与本地 per-profile 一致），不用易变的 email。部署预配置最确定、最少竞态，契合个人工具 / 专用实例默认。**首登 claim + 一次性 setup token** 适合 SaaS 安装向导，但多一条「token 丢/泄/重用」的路径——**作为后续便利功能补，不进 Phase A 主线**。

### 7.5 数据安全不变量

无论锁不锁:**X 的数据永远安全**——Layer 2 密码门 + 「动 X 必须是 X 本人」+ profile 隔离（Y 绑上来 materialize 的是 Y 自己的库，碰不到 X 的）。
**锁保护的是「占用权 / 可用性 / AI 额度」，不是机密性。** 「不锁 + 链接泄露 + 被占」最坏是别人拿自己的 Y 占你实例资源（拉锯/薅 AI 额度），**不是泄密**。
⚠ **配了服务端 AI key 的实例，要么锁定到 owner（`account_lock=<owner>`），要么把 AI gate 在 owner 账号上**（否则 `off` 下被占者能烧你 AI 额度——唯一会真亏钱的点）。

### 7.6 跨源 / CSRF / DNS-rebinding 硬化（Phase A 必做，含 local）

**「localhost 可信」在浏览器语境不成立**：现 daemon CORS 是 `origin: true`（`server.ts:36`），**你访问的任何网页都能跨源打你本机 daemon**（CSRF / DNS rebinding）。Phase A 一并定掉：

- **CORS 改 allowlist**：只放**同源 web** + **Electron renderer origin**，其余跨源拒（不再 `origin:true`）。
- **Host 头校验**：只收 `127.0.0.1 / localhost / 已知 host`——**CORS 挡不住 simple-request 的 DNS rebinding，Host 校验才行**。
- **鉴权用 bearer-in-header，不用 cookie**：跨站页面读不到 header 里的 bearer → 基本免疫 CSRF。
- **public route allowlist**：`/status`（**实际**健康检查端点，`system.ts:6`，GUI/CLI 都依赖）等少数免鉴权，cloud 其余必鉴权。
- **同源静态托管**：web 由 daemon 自托管 → 同源 → web 不需开 CORS。**Electron renderer 是跨源到 daemon**（origin ≠ daemonUrl）——但 packaged GUI 用 `loadFile`（`window.ts:85`），Origin 是 `file://`/null，**裸放行 null 会放进任意 sandbox/data/file 上下文**。**已定：Electron/local 也走下面的本地 token、不靠 Origin**（所有合法本地调用方都能证明自己，Origin 只做辅助收敛）。`app://` 自定义协议以后做（CSP/导航语义更干净），**非 Phase A 安全前置**。
- **`/events` 实时通道 vs bearer**（**已定：fetch-based SSE + bearer header**）：现 GUI 用**原生 `EventSource`**（`EventsSubscriber.tsx:49`）订 `/events`，原生 EventSource 带不了 `Authorization` header。**不走短时事件 token**（多一套生命周期/吊销/日志泄漏面，放 query string 尤脏）。lib 用 `@microsoft/fetch-event-source`（或把现有 streamSse 扩成 GET+headers+reconnect，但成熟库省心），**不豁免 `/events`**。⚠ **RN 先单独确认 fetch streaming 支持，不稳则移动 v1 用轮询或 RN 专用 SSE 客户端**（见 §5）。
- **local 模式：无登录 UX ≠ 无请求认证**。CORS 只挡「读响应」，**挡不住跨站页面发 simple POST 触发副作用**；Host 校验对真实
  localhost 也放行。现有无 body 的 mutating 路由（`/sync/run` `sync.ts:56`、`/sync/logout-local` `sync.ts:238`，及 POST/PATCH/DELETE）
  是 CSRF 靶子。**Phase A：所有 mutating 端点（含 local）必须要求一个「非 simple」自定义 header 或本地 bearer/dev token**
  ——非 simple header 强制 preflight、被 allowlist 拦下；合法前端经 platform adapter 带上，盲跨站页面带不上。
  **这个 header/token 要由所有合法客户端携带**：CLI（`apps/cli` 的 daemon HTTP backend、`owl sync run`、`owl open`，现只带 content-type）、
  GUI main、renderer/web 共享 client——统一抽一个 **daemon auth provider**（CLI 非浏览器、加 header 是 trivial；目的是不给 CLI 留豁免缝）。
- **bearer 存储 + XSS（cloud web）**：bearer-in-header 免 CSRF，但 TTL token 要么**只存内存**（刷新即重认证、最抗持久 XSS），
  要么 `sessionStorage`（存活刷新、可被 XSS 读）——**倾向只存内存**。且现有 `MarkdownPreview.tsx:92` 用 `rehypeRaw` 渲染原始 HTML，
  **web 化后是 token 被盗风险点**：cloud web 必须**禁 raw HTML 或 sanitize + CSP + 外链策略**（Phase B）。

### 7.7 云端凭据存储（新不变量，v1 = 只存内存）

cloud 模式无 Electron main、无 OS keychain → **daemon 必须自己持有 Layer 1 的 skybridge token**。这与 P5-d 守卫
（`check-daemon-no-toml-write.sh`：daemon 不得写凭据，GUI main 才是 owner）冲突，因此是 cloud 模式的**新不变量**。

- **cloud daemon 必须自己发起登录流程（新能力）**：现有 daemon 是**被动收凭据**——`/sync/session` 假设 GUI main 已完成 skybridge
  login / registerDevice / ensureWorkspace，再注入 token/device/workspace（`session.ts:264`）。cloud 没有 GUI main，所以 **Phase A
  要让 cloud daemon 自己**：调 skybridge login → registerDevice → ensureWorkspace → 切 profile → 铸 browser session token。
  即从「被动收」升级为「主动取」。

- **v1 决策：只存内存（不落盘）**——daemon 把 token 收在**一个 credential-store 抽象**里（in-RAM 实现），**永不写盘** → P5-d「daemon 不写 toml」守卫**原封不动**。代价：服务器重启/升级后需**重登**。
- **后续若要「无人值守重启自动恢复同步」**：给同一 credential-store 加「加密文件」实现 + 启动 load + 把守卫 **scope**（local 禁写、cloud 凭据库路径放行）。**纯增量、无重写、无数据迁移**（升级后首次无存档则再登一次）。前提：token 从 v1 起就**统一收一个模块**，别散在闭包里。

---

## 8. 加密 / 部署档

- **传输加密（TLS / 反代）= 公网默认、先做**：Caddy/nginx 终止 TLS、转发到 daemon（公网正式档 daemon 绑 `127.0.0.1`，只有反代可达，见 §3 矩阵）。
- **纯 IP / 不反代 = 仅局域网 + 调试的显式 opt-in**，不作公网路径。daemon 恒明文 HTTP，TLS 与否纯是部署档之别。
- **内容 E2E（服务器静态密文）= 推迟**，独立大决策，不在本轮。
- 浏览器小坑：纯 IP 的 http 源（非 localhost）是「非安全上下文」，丢 service worker/secure cookie/通知/剪贴板等能力；网页端正式用走 TLS 档。

---

## 9. 功能工种表（按平台角色，非「阉割」）

后端 51 端点**对已认证会话开放**；UI 裁剪纯是前端「建哪些页面」的取舍，**可逆**。**但「隐藏 UI」≠「保护数据」**：`GET /config`
现在直接回 `ctx.config`（含 `llm.api_key`，`config.ts:117`）→ **cloud 模式必须默认 redact secret（api_key 等）、对 llm 读写做
owner gate、拆 public/secret config**（Phase A）；否则砍掉 web 的 key 配置 UI 也防不住经 API 读走/改掉。
桌面 = 全功能工作台；网页 = 异地「读 + 改」窗口；移动 = 随身「速记 + 一瞥 + 提醒」。

| 功能 | 桌面 | 网页 | 移动 | 说明 |
|------|:--:|:--:|:--:|------|
| 浏览/阅读、搜索/标签筛选/排序/置顶 | ✅ | ✅ | ✅ | 核心 |
| 编辑（预览/代码，无分屏） | ✅ | ✅ 完整 | ✅ 触屏优化 | 网页 v1 含编辑 |
| 文件夹 + 拖拽整理 | ✅ | ✅ | ✅ | — |
| 回收站 | ✅ | ✅ | ✅ | — |
| 提醒 | ✅ | ✅ 查看 | ⭐ 推送（延后） | 推送是移动杀手锏 |
| 待办 | ✅ | ✅ | ✅ | — |
| AI 对话 | ✅ | ✅ 架构在内·排期靠后 | ✅ 架构在内·排期靠后 | key 见 §6 |
| 设置·LLM Key 配置 | ✅ | ✂️ | ✂️ | 用云端/本地 key，不在借来机器贴 key |
| 设置·同步/账号/设备 | ✅ | 最小（登录/会话） | ✅ 最小化 | 重账号管理留桌面 |
| 设置·快捷键 | ✅ | ✂️ | ✂️ | — |
| 冲突解决 | ✅ | ⏳ 提示去桌面 | ⏳ v2 再做 | — |
| 多账号 / profile 切换 | ✅ | 见 §7.3/7.4 | ⏳ 最小 | — |
| **附件 / 图片粘贴 / 文件上传** | ❌ 不做 | ❌ | ❌ | **text-first，见 §10** |

---

## 10. text-first：不做附件（W11 移除）

**决策：owl 定位 text/markdown-first；不做附件存储/同步、不做文件/图片上传；markdown 外链图片（`![](url)`）react-markdown 照常渲染。**

- **代价≈0**：grep 证实 owl 现在**根本没有附件功能**（无附件表、GUI 无图片粘贴、daemon 无附件路由；只有同步引擎一个不丢 refs 的占位）。所以是「**不开 W11 这个坑**」而非拆已有功能，不碰 `#真实` 笔记。
- **收益**：op-log 始终很小、SQLite 不膨胀、备份便宜、**性能一般的服务器扛得住**；产品定位更清晰（快、纯文本可移植、durable）；引导文本记笔记。
- **顺带**：W11 是排期里唯一硬前置（「云端副本看不到附件」），**砍掉 → 关键路径再无卡点**（见 §12）。同步把 `0.6.0-plan.md` / `PROCESS.md` 里 W11 标为「已由 text-first 决策废弃」。

---

## 11. 仓库结构（R1）

- **网页版 → `owl/apps/web`**（进现 monorepo，workspace 直接复用 api/types/stores，与 daemon 一起部署）。「同仓库」≠「同运行时」——开发期是包，生产期其产物由 daemon 托管。
- **移动端 → 单开 `owl-mobile` 新仓**（RN/Expo 原生工具链隔离，独立发版节奏）。
- **共享 `@orpheus-aviary/owl-shared`**：web 与移动唯一真实共享面 = api client + TS 类型。

```
owl/ (现 monorepo)
  ├─ packages/{core, daemon, gui}
  ├─ packages/shared → 发布 @orpheus-aviary/owl-shared（Step 0 抽出，C 阶段发布）
  └─ apps/web                 ← 新增
owl-mobile/ (新仓)  deps: @orpheus-aviary/owl-shared
发布物：@orpheus-aviary/owl-server（daemon + 内嵌 web 包）
```

---

## 12. 排期（web 先行，与 0.6.0 编织）

生态工作不替代 0.6.0，而是把部分 0.6.0 项变成生态阶段的前置/组成。**W11 已随 text-first 移除，关键路径无硬卡点**。
**shared（platform adapter + api client/types）在 Step 0 就抽出**，让 web 第一天起就 build against shared，避免 B→C 返工。

```
Step 0 系统清理 + 抽 platform adapter（startupMode/IPC/daemonUrl/keychain/快捷键 接口 + Electron/web 两实现）
        + 抽 api client/types 成 shared 模块（platform 化 baseURL + bearer 钩子 + **fetch-based SSE 替原生 EventSource**）
   → TLS/反代（= Phase A 安全部署件）
   → A 云端 daemon：cloud 模式（端点鉴权 + CORS allowlist + Host 校验 + **mutating 端点请求认证[含 local,防 CSRF]**
        + bind 矩阵 + 启动守卫 + 两层会话 + account_lock + 云端凭据内存态
        + **daemon 自发起 login/registerDevice/ensureWorkspace** + **config secret redaction/owner-gate**）；发布 owl-server；上云
   → B 网页版：apps/web 响应式重构 GUI（依赖 Step 0 platform adapter + shared api）+ 会话 TTL + 编辑
        + **乐观并发(传 expected_updated_at)/自动保存/冲突提示** + **禁 raw HTML/sanitize+CSP + bearer 只存内存** + **profile 列表 `pending_count`**；daemon 静态托管
   → C 发布 @orpheus-aviary/owl-shared（给移动端消费；api/类型已在 Step 0 抽出，本步 = 打包发布 + 稳定 API 面）
   → D 移动 v1（在线）：RN/Expo 底部导航 + 编辑预览/代码 + 浮动标签 + 拖拽文件夹；连云端 daemon
   →（其间补 W7 冲突双向/合并，赶在 E 前）
   → E 移动 v2（离线）：**mobile-safe core boundary**（剥离 core 顶层 Node-only 面 fs/path/logger/migration/config）
        + **DB/事务 async 化**（better-sqlite3 同步→expo-sqlite 异步）+ config/logger/storage 抽象 + 同步引擎可移植
        → 离线 + 手机成独立设备 + 移动冲突 UI + AI key 同桌面
   →（后续入口）web/移动 AI 对话（云端 key）；移动提醒推送（APNs/FCM）；云端凭据加密落盘（如需无人值守）
```

软排序：W7 在移动 v2 前做好；跨账号导入 / 跨 profile 视图 / 真 24h soak / P8 池 均独立。

---

## 13. 改动放大 / 维护取舍

3 个前端有「改动放大」风险，架构专门压制它，关键在功能的**「高度」**：

- **数据/逻辑** → 沉到 **core/daemon（改一处）**：新字段/查询/端点 → 改一次，3 端都拿到。
- **API client + 类型** → 在 **owl-shared（改一处）**，web + 移动共享。
- **只有像素/视图**分平台；而 **Electron GUI 和 web 是同一份 React（~85% 组件，经 platform adapter）**，真正独立的视图树**只有移动 RN 一个**。

→ 现实放大是「**1 处逻辑 + 2 层视图（Electron/web 合一 + 移动）**」，不是 ×3。

**取舍办法**：① 铁律「厚后端、薄视图」，逻辑别写进组件；② 优先后端重的功能（跨平台白嫖），重视觉的认账各做一份；
③ **别过度抽象去统一三端视图**（如 `react-native-web` 揉三端）——会漏的过度工程，**共享线划在「视图之下」**。

---

## 14. 待你最终确认的开放项

| # | 项 | 结论 / 倾向 |
|---|----|------|
| 1 | 云端登录态重启后保留 | **已选：只存内存（不落盘）**（保「daemon 不写 toml」不变量、最简）；后续可加密落盘（增量，§7.7） |
| 2 | 移动提醒推送时机 | 倾向**延后**（v1 含本地提醒，APNs/FCM 推送排在核心之后） |
| 3 | `account_lock` 默认 + owner 身份/bootstrap | **已定**：专用默认锁定；owner = **profileId**（`sha256(server_id‖user_id)`）；bootstrap = **部署预配置**（首登 claim+setup token 作后续便利，不进 Phase A） |
| 4 | web 编辑并发模型（含实现形） | 倾向**乐观并发**：打开 note 记 `originalUpdatedAtMs`（注意 `Note.updatedAt` 现是 string、daemon 要 number ms，需对齐 + TabState 存基线），保存传它、成功用响应刷新基线、**409 拉 current + 合并提示**；配自动保存。web v1 含编辑前定 |
| 5 | cloud web token 存储 | 倾向**只存内存**（刷新即重认证，最抗持久 XSS）vs `sessionStorage`（存活刷新但 XSS 可读） |
| 6 | 释放/切换前 flush 失败策略 | **已定**：允许切换 + pending 留本地 profile db 续传 + 切换 UI 说明 + profile 列表显示 `pending_count`（数据不丢，最终一致） |
| 7 | `/events` 实时通道鉴权 | **已定**：fetch-based SSE + bearer header（不走事件 token）；RN 先验 fetch streaming，不稳则 v1 轮询/RN SSE 客户端 |
| 8 | Electron renderer 鉴权 | **已定**：Electron/local 走本地 token、不靠 Origin；`app://` 自定义协议后续（非 Phase A 前置） |

---

## 15. 留意点 / 风险

- **安全**：云端 daemon 暴露公网必须 鉴权 + TLS + 启动守卫 + §7.6 硬化（CORS allowlist / Host 校验 / bearer-in-header）；登录门抗暴力；明文 `owl.db` 在服务器（E2E 推迟）。
- **平台适配层**：GUI 对 Electron 有硬耦合——`App.tsx:15` 首屏直接读 `window.owlAPI.startupMode`（web 上会抛）、`MainApp.tsx:271` 直接订 IPC `onProfileSwitched`、`api.ts:81` baseURL 默认本机。Step 0 抽 platform adapter 是 web 能跑起来的前提，不是「feature-detect 几处」。
- **云端凭据不变量**：`check-daemon-no-toml-write.sh` 是 Electron 专属；cloud 凭据走 §7.7 内存态（不破守卫），若改加密落盘需同步更新守卫。
- **移动编辑器**：取消分屏后，预览 RN 需换 RN 版 markdown 渲染，代码模式无 CodeMirror6 需选 RN 编辑器（影响 D 工作量）。
- **local CSRF**：CORS 不挡跨站 simple POST；mutating 端点（含 local，如 `/sync/run`、`/sync/logout-local`）需自定义非 simple header / 本地 token（§7.6）。
- **config secret 暴露**：`GET /config` 含 `api_key`；cloud 需默认 redact + owner-gate + 拆 public/secret（§9）。
- **cloud 自登录**：daemon 从「被动收凭据」升级为「主动调 skybridge login/registerDevice/ensureWorkspace」（§7.7）。
- **`/events` vs bearer**（已定 fetch-SSE + bearer；RN 先验 fetch streaming）：原生 EventSource 带不了 header（§7.6/§5）。
- **客户端鉴权面**：mutating header/token 要覆盖 CLI（`owl sync run`/`owl open`）/GUI main/web；统一 daemon auth provider（§7.6）。
- **释放/切换 flush 失败**（已定 允许切换 + pending 留本地 + `pending_count` 显示）：`switchProfile` 现不主动 final-sync（§7.3/§14 #6）。
- **owner bootstrap**（已定 部署预配置 profileId）：默认锁定 + owner = profileId；setup-token 方案后续补（§7.4/§14 #3）。
- **Electron origin**（已定 走本地 token）：packaged `loadFile` → `file://`/null 不能裸放行；`app://` 后续（§7.6）。
- **web XSS → token**：`MarkdownPreview` 用 `rehypeRaw` 渲染原始 HTML + bearer 在 JS 可达存储；cloud web 需 sanitize/CSP + token 只存内存（§7.6）。
- **同库并发编辑**：同账号多 session 编辑同笔记会后写覆盖；web 编辑前定乐观并发（`expected_updated_at` 现 client 未传，§7.2/§14 #4）。
- **core 移植(v2) = 专项子设计，非「切方言」**：`@owl/core` 直接依赖 better-sqlite3（`db/index.ts:1`），同步事务（`sync/engine.ts:945/1008` `sqlite.transaction(...)`）要整体 async 化；**且 core 顶层还导出 Node-only 面**（`loadConfig/saveConfig`、migrate、logger、fs/path，`index.ts`），Expo 吃不下整个包。v2 前置单拉「**mobile-safe core boundary + DB/事务 async 化 + config/logger/storage 抽象 + 同步引擎可移植**」子设计。
- **离线冲突(v2)**：手机变独立副本后会产生 `conflict_record`，冲突 UI 要在移动端重做。

---

*（架构定稿 v6，不含代码。你通审后，各阶段再拉独立子设计文档；Phase A 云端 daemon 为首个。）*
