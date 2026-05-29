# Phase 12 子设计 —— profile 地基（resolver + adapter 收口 + redact + 审计）

> 父设计：`2026-05-29-account-profile-isolation-design.md`（**v6 定稿，以其 §0.5 决策总账为准**）。
> 本文只拆 **Phase 12**。**✅ 已完成并落 main**（45eef1e/a4c61bd/d15c9cd，全套绿 + 16 e2e，behavior diff=0）。
>
> ⚠️ **2026-05-30 后续决策对本文的修订**（实现时以父设计为准）：
> - **D11**：profileId 锚点改 `server_id`（非 url）→ 本文 T1b 的 `computeProfileId(serverUrl, userId)` 是 **provisional**，Phase 15 改为 `computeProfileId(server_id, userId)`；`normalizeServerUrl` 降级为 url 存储/显示用，退出 profileId。
> - **D10a**：local 落点 = `owl/owl.db` 原地（非 `profiles/local`）→ 本文 T1a 的 `localProfileDbPath()=profiles/local/owl.db` 是 **provisional**，Phase 13 把 `local` 重映射到 `owl/owl.db`（= `paths.dbPath()`）。
> - **D2 翻转**：存的是 `encrypted_refresh_token`（非 encrypted_token）→ Phase 15 视字段名补 redact glob。
> - 以上均不影响 Phase 12 已交付的正确性（这些符号 Phase 12 内未被消费）。

---

## 0. 一句话

建立"**所有 db 路径解析**"的单一收口点（resolver），并把"**skybridge toml 读取**"的 adapter 缝钉在现有 `readSkybridgeConfig` 上。**Phase 12 全程行为保持不变（runtime behavior diff = 0）。**

---

## 1. 范围与硬性原则

- **behavior-preserving 是 Phase 12 的验收红线（指运行时行为，不是测试计数）**：
  - resolver 在"无 `active_profile` / 非法 / 目标 db 不存在"时**回退 legacy `paths.dbPath()`**（= 今天的 `owl/owl.db`）。Phase 12 的 toml 还是单 `[auth]`、无 `active_profile`、`profiles/` 目录也不存在 → resolver 永远落回 legacy → 运行时行为 0 变化。
  - adapter（= 现有 `readSkybridgeConfig`）签名、返回形状、抛错语义在 Phase 12 完全不变。
- **不做**（明确推迟）：`profiles/` 目录布局、`[profiles.X]`+`active_profile` schema、旧布局迁移(B5)、legacy-orphan guard(B8)、`readSkybridgeConfig` 内部改 active-profile 视图 → **Phase 13**；db replace dance / switch lock / rebuild 清单 → **Phase 14**。
- Phase 12 是"建 resolver 收口点 + 校准 adapter 读者清单 + 防御性 redact"的**低风险重构**。收益：Phase 13 改 schema/布局时只动 resolver 内部与 `readSkybridgeConfig` 内部，3 入口点和 ~10 个 reader caller 不再二次改。

---

## 2. 任务分解

### T0 · D8 boot 闭包审计 ✅ 已完成（2026-05-29）

结论见父文档 §5.4.2-bis。要点：原地 mutate ctx 成立（routes 经 `buildServer(ctx)` 持同一 ctx 引用、live 读 `ctx.db`）；待审三者 `eventsBus`/`toolRegistry`/`llmClientFactory` **全部不持 db**；**新发现 `ConversationStore(sqlite)` 持 sqlite → Phase 14 switch 必须 rebuild**。Phase 14 照 §5.4.2-bis 表执行。

### T1 · B6 core resolver + path/id helpers（开工第一段代码）

**1a. `paths.ts`（`packages/core/src/config/paths.ts`）新增：**
- `profilesDir()` → `<owlDir>/profiles`
- `profileDbPath(profileId)` → `profiles/<profileId>/owl.db`
- `localProfileDbPath()` → `profiles/local/owl.db`
- `dbPath()` 保留（legacy + escape hatch，降级为内部实现，不再被 3 入口直接调）

**1b. `profile/id.ts`（纯函数，可单测；消费始于 Phase 15 登录，Phase 12 仅落地+测试）—— 行为钉死：**
- `normalizeServerUrl(input): string`
  - 用 WHATWG `new URL(input)` 解析；解析失败 → `throw InvalidServerUrlError`。
  - 仅允许 `http:` / `https:`，否则 `throw InvalidServerUrlError`（**非法 URL = throw，不原样接受**）。
  - 返回 `` `${u.protocol}//${u.host}${path}` ``，其中：
    - scheme 小写（URL 解析天然小写）。
    - `u.host` = 小写 host + **显式非默认端口**；默认端口（http:80 / https:443）由 URL 解析天然剥离；owl 用 `:8443` 非默认 → 保留。
    - `path = u.pathname.replace(/\/+$/, '')`（**去尾斜杠**；root `/` → `''`；**保留** 非根 path 前缀，如 `https://h:8443/owl-sync`）。
    - **query / hash 一律丢弃**。
  - 例：`http://Example.COM:8443/` → `http://example.com:8443`；`https://x:443/api/` → `https://x/api`。
- `computeProfileId(serverUrl, userId): string`
  - `sha256( normalizeServerUrl(serverUrl) + "\n" + userId ).digest('hex').slice(0, 32)`（**Node 内置 `crypto`，sha256，hex，取前 32 位 = 128-bit**）。
  - `userId` 原样使用（server 下发的 opaque id，不归一化）。
  - **32 位是持久化目录名 + `active_profile` 存值，定稿后不可改**（改则 orphan 已有 profile）。

**1c. `profile/resolver.ts`：**
- `readActiveProfileId(): string | null` —— **raw toml parse，不走 `readSkybridgeConfig`**（后者缺 `[server].url` 抛错；读顶层 `active_profile` 不需要 server.url）。`existsSync` → `readFileSync` → smol-toml `parse` → 取顶层 `active_profile`。**任何失败（文件缺/解析错/字段缺/非 string）一律 return null，绝不抛。**
- `isValidProfileId(id): boolean` —— `/^[0-9a-f]{32}$/.test(id) || id === 'local'`（**path-escape 守卫**：拒 `/`、`..`、空、其它字符）。
- `resolveActiveProfileDbPath(): string`：
  ```
  id = readActiveProfileId()
  if id === null              → paths.dbPath()                 // legacy（Phase 12 恒走这）
  if !isValidProfileId(id)    → paths.dbPath()                 // 静默回退（防路径逃逸/脏值；core 无 logger 注入，不打 warn）
  candidate = id === 'local' ? localProfileDbPath() : profileDbPath(id)
  if existsSync(candidate)    → candidate
  else                        → paths.dbPath()                 // 目标 db 不存在 → 回退，绝不新建空库
  ```
  - **关键防御（review #4）**：即使测试/用户 toml 已塞 `active_profile`，只要目标 profile db 还不存在（Phase 13 前必然不存在）就回退 legacy → 杜绝"打开失败 / 新建空库"。

**1d. 导出（review 小修）**：`profile/id.ts`、`profile/resolver.ts` 在 `packages/core/src/index.ts`（现 `export * as paths from './config/paths.js'` 那一区，:44）补 `export`，否则 daemon/GUI/CLI 无法按现有包导入模式使用。

**测试**：resolver 四分支（无 active→legacy / 非法 id→legacy / active 但 db 不存在→legacy / active=local 且 db 存在→profiles/local）；normalize 各形态（大小写 / 尾斜杠 / 默认端口 / path 前缀 / query / 非法 URL throw）；computeProfileId 确定性 + `:8443` vs `:8443/` 同值。

### T2 · 三入口切 resolver（含 B3，旧库旁路入口收口）

逐一改调 `resolveActiveProfileDbPath()`，`paths.dbPath()` 不再被这三处直接调用：

| 入口 | 现状（已 grep 核实行号） | 改为 |
|---|---|---|
| daemon boot | `createDatabase({ dbPath: paths.dbPath() })`（`packages/daemon/src/cli.ts:62`） | `dbPath: resolveActiveProfileDbPath()` |
| GUI 启动 precheck | `const dbPath = paths.dbPath()`（`packages/gui/src/main/index.ts:73`，喂 :74 `runMigrationPrecheck(dbPath)`） | `const dbPath = resolveActiveProfileDbPath()` |
| CLI direct 默认（B3） | `dbPath = overrides.dbPath ?? paths.dbPath()`（`apps/cli/src/lib/config.ts:43`） | `overrides.dbPath ?? resolveActiveProfileDbPath()` |

- CLI `--db <path>` 仍是显式 escape hatch（`overrides.dbPath` 优先），不变。D7' 已定 CLI 只跟随 active，本 Phase 不加 `owl profile use`。
- **不算入口（review 小修）**：`packages/core/scripts/migrate.mjs:13` `const dbPath = paths.dbPath()` 是**迁移脚本**，归 **Phase 13**（迁移逻辑改造）处理，**不在 Phase 12 三入口范围**。

**测试**：三入口在无 active_profile 下解析到 legacy 路径（保证 behavior-preserving）；CLI `--db` 仍覆盖。

### T3 · B10 adapter 收口（沿用 `readSkybridgeConfig`，Phase 12 不改 caller）✅ 审计完成

**做法（review #2 低风险路）**：**不引入新 API**。指定现有 `readSkybridgeConfig(path?)`（`packages/core/src/skybridge/config.ts:118`，从 `@owl/core` 根导出）为 active-profile-view adapter；**Phase 12 不动其内部、不动任何 caller**。Phase 13 只改这一个函数的内部（解析 `active_profile` → 返回 `[profiles.<id>]` 视图，复用旧 `SkybridgeConfig` 形状 → caller 零改）。

**Phase 12 T3 是验证步骤（无生产代码改动），产物 = 审计结果记录：**

1. **bypass 审计结论 ✅（已 grep 全 packages/apps）**：所有读 skybridge toml 的点**要么经 `readSkybridgeConfig`，要么是 `profile/resolver.ts` 故意的 raw-parse**（只抽顶层 `active_profile`）——**无第三条旁路 reader**。Phase 13 改 adapter 内部即覆盖全部读侧。
2. **校正后的 `readSkybridgeConfig` reader 清单**（已逐一 grep 核实）：
   - core：`skybridge/config.ts:118`（adapter 本体；`:222` 内部 `requireAuth`/`clearSkybridgeAuth` 自调）
   - daemon：`cli.ts:153`、`sync/manual.ts:299`（经 `:296` cfgPath）、`sync/bridge-lifecycle.ts:71`（`deps ?? default`）、`sync/dev-bootstrap.ts:83`（`deps ?? default`）
   - GUI main：`sync-ipc.ts:177`、`sync-auth.ts:290`（`safeReadConfig()` 唯一 reader，被 logout `:166`/restoreSessionOnStartup `:208` 用；`cfg.*` 消费散在 `:173/184/200`，非 reader）
   - CLI：`commands/sync.ts:240`（`owl sync config show`，经 `env.readConfig ?? readSkybridgeConfig`）
   - **校正 vs §5.9 原稿**：删 `sync/session.ts:150`（内存消费 `buildClient`，全文不读 toml）；sync-auth reader 实为 `:290`（非 :173/215/...）；补 CLI `commands/sync.ts:240`。
3. **⚠️ Phase 13 写侧也要改（审计新增）**：toml 写出者 = GUI `sync-auth.ts` `serializableConfig` + 两写点（`:146` login persist / `:203` logout clear，经 `atomicWriteFile`）、core `config.ts` `writeSkybridgeConfig:192`/`clearSkybridgeAuth:220`/`removeSkybridgeConfig:229`。schema 翻新时写出形状必须与 adapter 读出形状一致。

> Phase 12 因此**不触碰任何 caller**——既解了上轮 R1（adapter 改面顾虑），也让 Phase 12 代码改动集中在 T1 resolver 新增 + T2 三入口 + T4 redact。T3 无 commit（doc-only，记录留设计稿工作树）。

### T4 · redact globs + 守卫/测试回归（精确列表）

- `packages/core/src/logger/index.ts:40-42` `DEFAULT_REDACT` 现为 `'*.auth.token'` / `'*.encrypted_token'` / `'*.auth.encrypted_token'` → **精确新增** `'*.profiles.*.encrypted_token'`、`'*.profiles.*.auth.token'`（Phase 12 无匹配项，纯防 Phase 13 漏 redact）。
- **更新 logger redact 测试**（`packages/core/src/logger/*.test.ts`）expected paths：补 `cfg.profiles.p1.encrypted_token` / `cfg.profiles.p1.auth.token` 命中 `[REDACTED]` 用例 + "不过度 redact 无关字段"用例仍绿。
- 跑 `just token-not-templated`（`scripts/check-token-not-templated.sh`）+ `SyncStatusBar.test.tsx` 等 token 测试回归。

---

## 3. 验收

- `just check`（lint + typecheck，8 子任务）全绿。
- `just test`：**当前基线测试数 + 本 Phase 新增（resolver/id/logger/adapter）测试全绿**；**SKYBRIDGE_E2E 全绿**。（不硬写计数——本 Phase 必然新增测试。）
- **运行时行为 diff = 0**（Phase 12 红线）：daemon 重启仍开同一 `owl/owl.db`；CLI direct 同库；sync push/pull 正常；`daemon.log` 无 token 泄漏。
- 手动：`just dev-daemon` 起，`owl sync status` / `owl sync config show` 与改造前一致。

---

## 4. 提交切分（建议；按"分步提交"偏好 commit 代码、PROCESS.md 留工作树）

- `feat(skybridge): add core profile path resolver + id helpers`（T1，含 index.ts 导出）
- `refactor(skybridge): route 3 db entrypoints through profile resolver`（T2）
- `chore(skybridge): verify readSkybridgeConfig reader inventory + bypass audit`（T3-1，可能纯文档/测试）
- `chore(skybridge): add profiles.* token redact globs`（T4）

（scope 用 `skybridge`；可按需合并。）

---

## 5. 风险 / 待确认

- **R1（已解）**：原"T3 改 14 caller"顾虑 —— 因沿用 `readSkybridgeConfig` 名/签名，Phase 12 **不动 caller**，改面归 Phase 13 的单函数内部。
- **R2 · resolver 跨工具读路径**：resolver 在 `@owl/core` raw-parse `skybridge/skybridge_config.toml` 顶层 `active_profile`，映射到 `owl/profiles/`。与现有 `readSkybridgeConfig`（core 读 skybridge toml）同源，无新依赖。
- **R3 · profileId 截断长度（已定 2026-05-29）**：sha256 hex 前 **32 位（128-bit）**。目录名仍短、碰撞顾虑基本消失；不上全 256-bit（太长收益小）。落盘后不可改。
- **R4 · normalizeServerUrl 丢 query/hash + 保留 path（已定 2026-05-29）**：保留 path 前缀（去尾斜杠）、丢 query/hash。**不用 `u.origin`**——它会把同 host 不同 path 的服务误合并（未来反代挂 `/owl-sync` 这类 base path 会出错）。当前纯 origin 形态不受影响。
