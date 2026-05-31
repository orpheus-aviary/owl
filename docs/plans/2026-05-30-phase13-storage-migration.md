# Phase 13 子设计 —— 存储 + 迁移（schema 收口 + resolver remap + adapter 读写）

> 父设计：`2026-05-29-account-profile-isolation-design.md`（**v6 定稿，以其 §0.5 决策总账为准**）。
> 本文只拆 **Phase 13**。前置：Phase 12 已落 main（resolver/id/paths 地基 + 三入口切 resolver + redact globs，behavior diff=0）。
>
> **本 Phase 形态拍板（2026-05-30，与用户确认）**：**Plumbing only（铺轨）**——schema + resolver remap + adapter 读写双向打通，**运行时行为保持不变（behavior-preserving）**。**不**翻转 live 登录（login flip 留 Phase 15），**不**搬库（W2：`owl/owl.db` 原地留作 local）。
>
> **v2 修订（2026-05-31，用户 review 后）**：P1(a) resolver/adapter 不再各自判 gate，**统一到单一 `resolveActiveProfile()`**（existence gate 只判一次，二者共享）+ 写侧 activate guard；P2(a) 验收措辞改"reader/status 读 legacy+v2，authenticated 仍走 GUI restore / dev-bootstrap，**daemon 不自举 toml**"；P2(b) 所有 mutator 走 **raw read-modify-write**，`clearSkybridgeAuth` 只清 active profile 的 auth、**不丢 sibling profiles**。
>
> 相关决策：D10a（local=owl/owl.db 原地）、D10b（导入仅认领空账号、账号同步永不写 local）、W2（强制留 local、不搬旧库）、B5（旧库搬迁消失）、B8（legacy-orphan 降告警，推迟）、B10（adapter 沿用 `readSkybridgeConfig` 名/签名）。

---

## 0. 一句话

把 skybridge toml 从单 `[auth]` 升级到 `[profiles.<id>]` + `active_profile` 的**读 + 写双向 schema**，把 resolver 的 `local` 重映射到 `owl/owl.db`（D10a），并补齐"写出新 schema"的能力（带单测、**dormant 不 live 调用**）。**Phase 13 全程运行时行为不变**：daemon 仍开 `owl/owl.db`、CLI direct 同库、sync 正常、`readSkybridgeConfig` 仍能读 legacy。新 schema 的 live 消费（登录写 profile、profileId 锚 server_id、device 复用、refresh-token）全部留 **Phase 15**。

---

## 1. 范围与硬性原则

### 1.1 红线：behavior-preserving（运行时）

- **resolver** 在"无 `active_profile` / `local` / 非法 id / 目标 profile db 不存在"时仍回退 legacy `owl/owl.db`（Phase 12 已是此行为）。Phase 13 没有任何 live 路径会写 `profiles/<id>/owl.db`（login flip 在 15），因此 resolver 实际仍恒落 `owl/owl.db` → 运行时 0-diff。
- **adapter（`readSkybridgeConfig`）向后兼容 + 与 resolver 同 gate**（P1(a) 修订）：当且仅当 `resolveActiveProfile()` 判定有效 active profile（id 合法 **且 profile db 存在**）→ 返回该 profile 视图；**否则回退 legacy 顶层 `[auth]` 视图**（= 今天的行为）。返回形状始终是同一个 `SkybridgeConfig`，14 个 caller 零改（B10）。
- **关键不变量（P1(a) + 反向）**：resolver 决定"开哪个 db"、adapter 决定"读哪段 config"，二者**共用同一个 `resolveActiveProfile()` 三重一致 gate**（active 合法 + `[profiles.<id>]` 段存在 + profile db 存在）。任一缺失 → 二者**一起**落 legacy/local。结构上**两个方向**的裂缝都不可能：①"adapter 读账号 session、resolver 落 local db"（section 在 db 缺）②"resolver 开 profile db、adapter 读 legacy auth"（db 在 section 缺）。

> ⚠️ 区分两层"authenticated"（P2(a) 修订）：
> - **`readSkybridgeConfig` / `owl sync config show` / status** —— Phase 13 后能读 legacy **和** v2，这是"配置可读"。
> - **daemon 真的持有 session（可同步）** —— **不**来自 daemon 读 toml 自举（`session.ts:185` 起 daemon plaintext-bootstrap 已退役，`ensureSkybridgeSession` 永不读 toml），而是来自 GUI main `restoreSessionOnStartup`（仅信 `encrypted_token`，POST /sync/session 注入）或 dev-bootstrap（env-gated）。
> - 所以"legacy toml 存在"≠"daemon authenticated"。Phase 13 不改这条链。
>
> 父设计 §5.9 写的"无 active / active=local → `SkybridgeNotConfiguredError`"是 **Phase 15 后的终态语义**（彼时登录只写 profiles，'local'/缺失 才真正等于"无账号"）。**Phase 13 不引入该语义**，保持 legacy 回退，否则破坏 behavior-preserving。

### 1.2 不做（明确推迟）

| 项 | 落点 |
|---|---|
| live 登录写 profile + 创建 `profiles/<id>/owl.db` | Phase 15 |
| profileId 锚 server_id（替换 provisional `computeProfileId(url,user)`） | Phase 15（依赖 Phase S） |
| db replace dance / switch mutex / rebuild 清单 | Phase 14 |
| import 守卫（认领空账号）+ renderer reset + W3 时间戳 | Phase 16 |
| refresh-token 字段（`encrypted_refresh_token`）+ 对应 redact glob | Phase 15 |
| B8 legacy-orphan **硬** guard | 不做；降为 Phase 16 import 时的一句告警（§3.5） |
| 真正"搬旧库进 profile" | **取消**（W2） |

---

## 2. toml v2 schema（拍板：flat-fields 形态）

Phase 13 引入的磁盘形态（`~/orpheus-aviary-nest/skybridge/skybridge_config.toml`）：

```toml
active_profile = "<hex32>"          # 或 "local"；缺失 = legacy / 纯本地

# 每个登录过的账号一段（Phase 15 才会有 live 写入者；Phase 13 仅 writer 能力 + 测试）
[profiles.<hex32>]
server_id  = ""                     # Phase 15 由 server 下发填入；Phase 13 留空占位
server_url = "https://host:8443"    # 连接地址（可变；不进 profileId）
user_id    = "..."
email      = "..."
encrypted_token = "..."             # safeStorage 密文（字段名 Phase 15 视 refresh 落地再定，见 §6 R1）

[profiles.<hex32>.device]
id = "..."
name = "host (owl)"
app_version = "owl 0.5.0-dev"
client_version = "0.1.4"

[profiles.<hex32>.workspace]
id = "..."
slug = "owl/default"
```

**形态选择理由（flat-fields）**：
- 机密落 `profiles.<id>.encrypted_token`，**正好命中 Phase 12 T4 已加的 redact glob `*.profiles.*.encrypted_token`**（pino 通配符逐段匹配：`cfg`=*、`<id>`=*）→ redact 零调整。
- `device` / `workspace` 天然子表保持嵌套（与 legacy 一致）。
- adapter 映射成本极低：`server.url ← server_url`，`auth ← {user_id, email, encrypted_token}`，`device`/`workspace` 直取。

**legacy 形态**（Phase 13 仍可读、不主动改写）：顶层 `[server]` / `[auth]` / `[device]` / `[workspace]` + 无 `active_profile`。

---

## 3. 任务分解

### T1 · `paths.ts` remap（D10a）+ `resolveActiveProfile()` 统一收口（P1(a)）

**1a. `paths.ts`**：`localProfileDbPath()`：`profiles/local/owl.db`（Phase 12 provisional）→ **`owl/owl.db`**（= `dbPath()`）。
```ts
/** Local profile db = owl/owl.db in place (D10a). The never-logged-in /
 * offline workspace; account sync never writes here. */
export function localProfileDbPath(): string {
  return dbPath();  // ~/orpheus-aviary-nest/owl/owl.db
}
```
`profileDbPath(id)` / `profilesDir()` 不变。

**1b. `profile/resolver.ts` —— 抽出共享判定（会改动 Phase 12 已 ship 的文件，已与用户确认方向）**：
```ts
export interface ActiveProfile { id: string; dbPath: string; }   // id 必为 hex32（非 'local'）

/**
 * 单一 active-profile 判定 —— **三重一致 gate，只在这里判一次**：
 *   ① active_profile 合法（hex32，非 'local'/非法）
 *   ② toml 里 [profiles.<id>] 段存在
 *   ③ profile db 文件存在
 * 缺任一 → 返回 null = 用 local/legacy（owl/owl.db + 顶层 [auth] 视图）。
 * resolver（开哪个库）与 readSkybridgeConfig（读哪段 config）共用它，
 * **两个方向**的隔离裂缝都堵死（P1a + 本轮反向）：
 *   - db 存在但 section 缺 → null → 都落 legacy（不会 "profile db + legacy config"）
 *   - section 在但 db 缺 → null → 都落 legacy（不会 "account session + local db"）
 * path? 透传到 toml 读取，确保与 readSkybridgeConfig(path?) 读同一文件（P2）。
 */
export function resolveActiveProfile(path?: string): ActiveProfile | null {
  const parsed = parseTomlSafe(path);              // raw parse；任何失败返回 null，绝不抛
  const id = parsed?.active_profile;
  if (typeof id !== 'string' || id === 'local' || !isValidProfileId(id)) return null;
  if (!isPlainObject(parsed.profiles?.[id])) return null;   // ② section 必须存在（反向 split-brain）
  const p = profileDbPath(id);                     // db 路径仍 nest-relative（profiles/<id>/owl.db）
  return existsSync(p) ? { id, dbPath: p } : null; // ③ db 必须存在
}

export function resolveActiveProfileDbPath(path?: string): string {
  return resolveActiveProfile(path)?.dbPath ?? dbPath();  // legacy = owl/owl.db
}
```
- `resolveActiveProfile` 单次 raw parse 同时判 ①②③（不再经 `readActiveProfileId` 只取 id —— 否则 section 检查要二次 parse）。`readActiveProfileId(path?)` 仍保留为"只取 active_profile string"的低层 helper（**加可选 path**，P2），供仅需 id 的场景。`isValidProfileId()` 不变。
- `resolveActiveProfileDbPath()` 行为与 Phase 12 等价（无 active/section/db 时仍恒落 `owl/owl.db`），仅内部委托 `resolveActiveProfile()`。三入口（cli.ts:63 / index.ts:73 / config.ts:43）默认无 path 调用，不变。
- **path 语义（P2）**：path 仅决定读哪个 toml；db existence gate 用 `profileDbPath(id)`（nest-relative）。单测完全隔离经 `OWL_NEST_DIR` 整体重定位 nest（toml 自定义 path 与 profile db 同处一 nest），否则 gate 会去查真实 nest。
- **无 import cycle**：resolver 只 import `config/paths` + smol-toml（raw parse），不 import `skybridge/config`；后者 import resolver（见 T2）单向。

**测试**：`localProfileDbPath() === dbPath()`；`resolveActiveProfile()` 五分支（缺失→null / 'local'→null / 非法→null / hex 但 db 不存在→null / hex 且 db 存在→{id,dbPath}）；`resolveActiveProfileDbPath` 回退等价回归；**`resolveActiveProfile(customPath)` 读自定义 toml 的 active_profile（与默认 `skybridgeConfigPath()` 隔离，P2）**。

### T2 · `config.ts` adapter —— 读侧 active-profile 视图（共享 gate）+ raw-preserve 写侧

**2a. 类型（additive）**：新增 v2 raw 中间型，**不改** `SkybridgeConfig` 对外形状。
```ts
interface RawProfileSection {
  server_id?: string; server_url?: string;
  user_id?: string; email?: string; token?: string; encrypted_token?: string;
  device?: { id?: string; name?: string; app_version?: string; client_version?: string };
  workspace?: { id?: string; slug?: string };
}
```

**2b. `readSkybridgeConfig(path?)` 内部**（签名/返回形状/抛错类型不变）：
```
parsed = raw parse toml(filePath)         // filePath = readSkybridgeConfig 的 path? ?? skybridgeConfigPath()
active = resolveActiveProfile(filePath)    // ← 三重一致 gate + 同一 filePath（P1a/P2）
if active:                                 // gate 已保证 [profiles.<id>] 段存在
    section = parsed.profiles[active.id]
    if section == null:                    // 防御 fail-closed（理论不达：gate 已查；防 TOCTOU）
        throw SkybridgeNotConfiguredError  // 绝不悄悄回 legacy → 杜绝反向 split-brain
    src = { server: {url: section.server_url}, auth: {...section}, device, workspace }
else:
    src = legacy 顶层 { server, auth, device, workspace }   // 今天的实现
return assembleConfig(src)                 // 抽公共组装 + 校验，两路共用，避免漂移
```
- 抽 `assembleConfig(src)`：把现有"组装 `SkybridgeConfig` + `SkybridgeServerUrlMissingError` 校验"逻辑提成纯函数，legacy 与 profile 段共用一份。
- `active` 为 null（含 'local' / hex 但 **section 缺** / hex 但 **db 缺**）→ legacy 路径，与 resolver 同步（§1.1 三重一致 gate）。
- **反向 split-brain 已堵**：section 在 gate 里查；adapter 对 "active 非 null 但 section 取不到" 走 **fail-closed**（throw），不退 legacy。
- `requireAuth` 不变（消费返回的 `SkybridgeConfig`）。
- **次要**：`resolveActiveProfile()` 与本函数各 parse 一次 toml（每次 config-load 双 parse）。频率低，可接受；如需可让 `resolveActiveProfile` 收一个可选 pre-parsed 入参，本 Phase 不优化。

**2c. 写侧 —— 全部走 raw read-modify-write（P2(b)）+ activate guard（P1(a)）**：
- 新增内部 helper `mutateConfigFile(path, fn)`：raw parse 现有文件（容缺）→ `fn(rawObj)` 原地改 → `stringify` 后**沿用现有 `writeSkybridgeConfig` 的 full-file rewrite（`writeFileSync`）+ `chmod 600`**（P3 修正：core 端**不是** temp+rename 原子写；真 atomic 写留 Phase 15 视需要，本 Phase 不扩 scope。GUI 端的 `atomicWriteFile` 是另一条路，不在此）。**所有 mutator 经它，保证不丢 sibling profiles / 不丢 `active_profile`。**
- `writeProfileConfig(profileId, section, opts?: { setActive?: boolean }, path?)`：**先 `PROFILE_ID_RE.test(profileId)` 校验**（必须 32-hex，**拒 `'local'` 与非 hex**，防导出函数被误传脏 id → `throw InvalidProfileIdError`）→ set `profiles[profileId]=section`；`opts.setActive` → **再 `existsSync(profileDbPath(profileId))` 校验**（不存在则 `throw ProfileDbMissingError`，拒绝激活幽灵 profile）→ set `active_profile=profileId`。
- `setActiveProfile(profileId, path?)`：**先 `isValidProfileId(profileId)`**（hex 或 `'local'`，否则 `throw InvalidProfileIdError`）→ **activate guard**（`'local'` 例外，恒可激活；hex 必须 db 存在，否则 `ProfileDbMissingError`）。
- `removeProfile(profileId, path?)`：删 `profiles[profileId]`；若它是 active → `active_profile` 落 `'local'`。
- `clearSkybridgeAuth(path?)` **改为 raw-preserve**：经 `mutateConfigFile` —— 若有有效 active v2 profile → 只删该段的 auth 子字段（`encrypted_token`/`token`/`user_id`/`email`），**保留 device/workspace/server_id 及其它 profiles**；否则（legacy）→ 删顶层 `[auth]`（=今天行为）。**绝不**再走"read→legacy write"那条会拍平 profiles 的老路。
- `removeSkybridgeConfig(path?)`：仍整文件删除（test-only，语义不变）。
- **live 路径暂不调新 writer**：GUI `sync-auth.ts` `serializableConfig` + core `writeSkybridgeConfig` 仍写 legacy 形状（login flip 在 15）；本 Phase 只保证 v2 writer 存在且与 reader round-trip 对齐。新 writer export 供 Phase 15 消费（避免 dead-code lint）。

**测试**：
- adapter round-trip：①legacy → 旧视图（回归）②v2（active=hex + 段存在 + **db 存在**）→ profile 视图 ③active=hex 但 **db 不存在** → **legacy 回退**（与 resolver 同步，P1a 正向）④active=local → legacy 回退 ⑤active=hex + server_url 缺 → `SkybridgeServerUrlMissingError` ⑥**active=hex + db 存在 + `[profiles.<id>]` 段缺 → adapter 与 resolver 同步落 legacy/local**（反向 split-brain 关键用例）。
- 写侧：`writeProfileConfig`/`setActiveProfile` 传 **非 hex / `'local'`（writeProfileConfig）→ `InvalidProfileIdError`**；`writeProfileConfig` round-trip；`setActive`/`writeProfileConfig({setActive})` 对 **db 不存在** profile → `ProfileDbMissingError`；**两 profile 文件做 `clearSkybridgeAuth`/`writeProfileConfig`/`removeProfile` → 另一 profile 段 + `active_profile` 完整存活**（P2b 关键用例）；`chmod 600`。

### T3 · redact globs 收口

- Phase 12 已加 `*.profiles.*.encrypted_token`（命中 flat-fields `profiles.<id>.encrypted_token` ✓）+ `*.profiles.*.auth.token`。
- **Phase 13 结论**：flat-fields 下机密路径 = `profiles.<id>.encrypted_token` → **已覆盖，无需新增**。`*.profiles.*.auth.token` 在本形态无对应字段（防御保留，无害）。
- **Phase 15 待补**：refresh 落地若字段改名 `encrypted_refresh_token` → 补 `*.profiles.*.encrypted_refresh_token` + 测试（本文不动）。
- 回归：`just token-not-templated` + logger redact 测试保持绿。

### T4 · 迁移 / 启动（W2 简化 —— 基本 no-op）

- **首次 0.5.0 启动**：`owl/owl.db` 原地不动（它就是 local，D10a）；不创建 `profiles/`；不写 `active_profile` → resolver 落 `owl/owl.db`。**0 迁移动作、0 数据搬运、0 回滚逻辑**（B5 消失）。
- **legacy toml 处置**：Phase 13 **不主动改写** legacy toml。`readSkybridgeConfig` 经向后兼容路径仍读得出顶层 `[server]`/`[auth]`（供 `sync config show` / GUI 显示）；但 daemon 是否 authenticated 仍由 §1.1 那条链决定（GUI restore 仅信 `encrypted_token` / dev-bootstrap），**daemon 不因 legacy toml 自举 session**。账号真正重建 = Phase 15 登录翻转（再登录 = 拉账号进 `profiles/<id>`，`owl/owl.db` 降 local，W2）。
- **`migrate.mjs`（schema 版本迁移）无需改**：操作 `paths.dbPath()` = `owl/owl.db` = **local**（D10a），本就正确。账号 profile db 由 Phase 15 登录新建（生成即当前 schema）。
- **GUI precheck 已就位**：Phase 12 已把 `index.ts:73` 切 `resolveActiveProfileDbPath()` → `runMigrationPrecheck` 跑在 resolved db 上。Phase 13 resolver 仍返回 `owl/owl.db` → 行为不变；将来 active 是账号时自动迁那个库。**本文仅确认，无改动。**
- **B8 legacy-orphan**：`owl/owl.db` 含旧账号残留时仍当 local 用；风险仅在"日后认领进空账号"。**Phase 13 不做 guard**，推迟 Phase 16 import 弹框处一句告警（§3.5）。

### 3.5 不变式与告警归属（备忘，非本 Phase 代码）

- 不变式"账号同步永不写 `owl/owl.db`"：**Phase 15 起强制**。
- B8 告警"本地库含旧同步痕迹，认领进新账号会一并上传"：**Phase 16 import 弹框**触发。
- 本 Phase 不实现以上两者，仅登记归属，避免误扩 scope。

---

## 4. 验收

- `just check`（lint + typecheck + 8 守卫）全绿。
- `just test`：现有基线 + 本 Phase 新增（paths/resolver/adapter reader/writer/redact）全绿；`SKYBRIDGE_E2E=1` 全绿。
- **运行时行为 diff = 0**：
  - daemon 重启仍开 `owl/owl.db`；CLI direct 同库；sync push/pull 正常。
  - **reader 层**：`owl sync config show` 对 legacy toml 与改造前一致；手塞 v2 toml（active=hex + 段，**且 db 存在**）→ 读出 profile 视图；v2 toml 但 **profile db 不存在** → reader 回退 legacy **且** resolver 回退 `owl/owl.db`（二者同步，P1a 验收点）。
  - **authenticated 层**（P2(a)）：legacy toml **不会**让 daemon 自动 authenticated；真正 session 仍来自 GUI `restoreSessionOnStartup`（encrypted_token）或 dev-bootstrap。
  - `daemon.log` 无 token 泄漏。
- 手动：`just dev-daemon` 起，`owl sync status` / `owl sync config show` 与改造前一致。

---

## 5. 提交切分（建议；按"分步提交"偏好：commit 代码、PROCESS.md 留工作树）

- `refactor(skybridge): remap local profile db to owl/owl.db + unify resolveActiveProfile`（T1，paths + resolver 共享判定 + 测试）
- `feat(skybridge): read+write active-profile schema via shared gate (raw-preserve)`（T2，adapter 读侧 + raw-preserve writers + clearSkybridgeAuth 修 + 测试）
- （T3 本形态无需调 glob → 并入或省）

scope 用 `skybridge`。可按需合并。

---

## 6. 风险 / 待确认

- **R1 · 机密字段名**：Phase 13 沿用 `encrypted_token`（对齐 Phase 12 redact glob + legacy 映射）。Phase 15 refresh 落地若改 `encrypted_refresh_token`，需同步 writer/reader/redact/测试。**已登记，不在本 Phase。**
- **R2 · server_id 占位**：profile 段含 `server_id` 字段但 Phase 13 留空（无 live writer）。profileId 仍 provisional url-keyed；因 Phase 13 无 live profile 写入，provisional-vs-server_id 的 re-key 问题尚不触发，留 Phase 15（届时无磁盘 profile 需迁移，dev 直接生效）。
- **R3 · adapter 双形态共存**：v2 与 legacy 同一 reader 内分支，务必抽 `assembleConfig` 公共校验避免漂移；测试覆盖两路 + P1a 同 gate 边界（active 指向不存在的段 → 二者同步回退）。
- **R4 · dormant writer**：用户已选"writers gain capability + tests (NOT called live)" —— 这是 reader/writer 对称 + Phase 15 直接复用所必需，非过度；export 避免 dead-code lint。
- **R5 · version negotiation（跨仓，登记给 Phase 15）**：owl Phase 15（0.1.4 client，需 `server_id`）落在 owl 仓 **早于** 阿里云 0.1.4 部署（Phase 19）。dev 期 0.1.4 client 可能撞 0.1.3 server（login 无 server_id）。**Phase 15 应硬要求 0.1.4 server**（client 在 `server_id` 缺失时报清晰错误，**不**静默回退 provisional url-key —— 否则会铸出日后 orphan 的 url-keyed profile）。本文仅登记，落点 Phase 15 + Phase S §10。
