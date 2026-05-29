# P5-d Phase 8 + 9 — GUI renderer 同步 tab + 守卫脚本 design

日期：2026-05-28（v4 修订 2026-05-29，依用户三轮 review findings）
状态：**已实施 2026-05-29** — 3 commits (`191fd66` / `5e4916a` / `ef6a7cd`) 落 owl main 本地，未 push。落地后基线见文末 §实施记录。
父框架：`docs/plans/2026-05-26-p5-d-design.md`（v3 锁定 2026-05-26）
对应 §：3.1.3（renderer）+ 3.2.2（守卫脚本）+ 3.2.1（toml schema 透出 UI 字段）+ 4 实施时序 Phase 8/9

## v3 → v4 关键调整

| # | 调整 | 原因 |
|---|---|---|
| A | `check-session-body-not-logged.sh` 改 **`rg -U` 多行匹配** + Change 3.5 多行泄漏自验样例 | v3 单行 regex 漏报 `ctx.logger.info(\n  { body: req.body },\n  'debug',\n);` 这种实际真实存在的多行 logger call 风格（route 既有 `routes/sync.ts:73, 105` 就是多行写法）；single-line regex 假设 logger args 单行，但实际代码并不是 |
| B | `extractSession` **与 `restoreSessionOnStartup` 可用性判断对齐**：检 `safeStorage.isEncryptionAvailable()` + 试 `decryptString` ciphertext | v3 `extractSession` 只看 `encrypted_token` 字段存在 → keychain 不可用 / ciphertext 损坏 / 跨 OS migrate 时 Settings 错误展示「已登录」，但下次冷启动 `restoreSessionOnStartup` 会实际 fail null。两套可用性判断不对齐是 latent bug，迟早 user-visible |
| C | `LoginAndOpenSessionInput` 锁 **shared 类型文件**，不允许 renderer `owl-api.d.ts` import main 模块 | v3 Change 1.4 写「re-export from main or shared duplicate」太松，renderer import main 会把 Electron / Node 全套 main 模块边界拖进 web tsconfig，编译可能挂或 type collapse；shared 是物理隔离 |

## v2 → v3 关键调整

| # | 调整 | 原因 |
|---|---|---|
| 1 | **撤掉 Commit 3「retire daemon writeSkybridgeConfig」** | skybridge server `/devices/register` 对已绑定 token 二次调用抛 409 `DEVICE_ALREADY_REGISTERED`（验证 `skybridge/packages/server/src/routes/devices.ts:60`），不是 idempotent；删 `session.ts:217, 231` 后 legacy plaintext 半启动用户首次 sync 成功但不补盘，下次冷启动会直接 sync 失败而非 RTT +2。彻底退役必须配 device-id 恢复路径（listDevices + hostname 匹配 + 边界），属独立 phase |
| 2 | **Phase 9 由 4 → 3 守卫**：撤掉 `check-no-plaintext-token-write.sh` | 与（1）联动 —— session.ts 仍持 `writeSkybridgeConfig` 调用，无法一刀切；不愿用 allow-list 弱化语义 |
| 3 | "GUI main 是唯一 toml 写入方"重述：**"GUI main 是 encrypted path 的唯一 identity/toml writer；daemon legacy plaintext bootstrap (`session.ts:201-231`) 仍是已知例外，待独立 phase 退役；`clearSkybridgeAuth` core helper 清 auth 路径合法"** | 准确反映三条 path：(a) GUI main encrypted 写；(b) daemon legacy plaintext lazy bootstrap 仍存在（v3 撤回退役决定见 row #1）；(c) `manual.ts:166 → clearSkybridgeAuth → config.ts:224` 清 auth 路径 |
| 4 | `SyncStatusResult` 提到 `src/shared/sync-status-types.ts` | main 进程不能从 renderer `lib/api.ts` 借类型；shared 是合适居所 |
| 5 | `SyncIpcReply<void>` 成功形状锁 `{ ok: true, data: undefined }` | 与泛型一致；测试 exact-match 不摇摆 |
| 6 | `SyncStatusBar.test.tsx` 增量加 `<MemoryRouter>` wrapper | `<Link>` 需 Router context |
| 7 | `check-session-body-not-logged.sh` regex 改抓 `ctx.logger.<level>` | 实际 route handler 用 `ctx.logger.info`（见 `routes/sync.ts:73, 105`），不是 `log.info` / `req.log.info` |
| 7b | `check-session-body-not-logged.sh` 不能 grep 泛词 `session` / `auth` | `routes/sync.ts:73-82, 105` 既写 `kind: 'sync-session'` 也访问 `session.config.auth?.user_id`，泛词会让守卫一上 just check 就红。改抓真敏感形态：`req.body` / `token:` / `.token` / `password:` / `.password` |
| 8 | `check-no-prod-env-token.sh` 自验文件换 `manual.ts`（非白名单 daemon 文件） | 原 plan 写 `engine.ts` 在 core，守卫只扫 `packages/daemon/src` 完全捞不到 |
| 9 | 守卫脚本数对齐：baseline **2 个 bash 守卫**（core-convergence + token-not-templated），v3 加 **3 个**（electron / prod-env-token / session-body），合计 **5 个 bash 守卫**。`just check` 子任务从 4 → 7（含 lint + typecheck 两条 pnpm 入口） | 之前混着算 "守卫"，造成 4 → 7 / 5 不一致 |
| 10 | IPC 输入类型直接复用 `LoginAndOpenSessionInput`，不另造 `LoginInput` 名字 | 之前 §types/owl-api.d.ts 段还写 `LoginInput`，落地易撞名 |

## 目标

把 P5-d 主线一在 renderer 端**收口**：用户能在 Settings 里完成 login / logout / 切换账号；把 Phase 9 的 **3 个**守卫脚本合进 `just check`。

Phase 8 完工后：

- 用户不再需要终端 `owl sync login`（CLI 0.5.0 compat 改在 Phase 16）
- `SyncStatusBar` 不再出现"请在终端运行 `owl sync login`"这类引导文案
- daemon 401 错误透出的 hint 改为"请在设置中重新登录"
- 3 个 grep 守卫（electron / prod-env-token / session-body）加入 `just check`，把 Phase 6+7 立下的不变量从约定升成代码护栏

Phase 8 + 9 是**纯叠加层**：不动 daemon route 行为（除 `manual.ts:172` 文案），不动 toml schema，不动 sync_changes / sync_cursor，**不动 session.ts lazy bootstrap 回写**。Phase 6+7 立下的所有不变量保持。

**留给后续 phase**：daemon `writeSkybridgeConfig` 完全退役 + legacy plaintext bootstrap 路径整体退役 —— 这两条捆绑做，需 device-id 恢复路径设计（`registerDevice` 409 → `listDevices` → hostname 匹配 → 恢复 id；name 冲突 / 多设备 / 用户改 name 边界都要拍板）。

## Audit 结论（baseline，2026-05-29）

### 现状一览

| 维度 | 当前状态 | Phase 8/9 需要变 |
|---|---|---|
| Settings 页 tab | `shortcuts / appearance / custom / advanced`（`SettingsPage.tsx:8`） | 加 `sync` |
| renderer ↔ main IPC | `cli:detect` / `globalShortcut:set` / migration / quit（`main/index.ts:78-101`） | 加 `sync:login` / `sync:logout` / `sync:status` |
| `window.owlAPI` 类型 | `types/owl-api.d.ts:28-48`，无 sync | 加 `sync: { login, logout, status }` |
| 同步状态 store | `stores/sync-status.ts` 仅 `SyncStatusSnapshot`（无 email / workspace_name / device_name） | **不动** — SyncSection 走 IPC 拿 status；SyncStatusBar 继续用 store |
| `SyncStatusBar` | popover 提示"在终端运行 `owl sync login`"（`SyncStatusBar.tsx:102`） | 改为"在设置中登录" + 加"管理账号"链接（`<Link to="/settings?tab=sync">`） |
| daemon 401 文案 | `'skybridge token rejected (401); re-run \`owl sync login\`'`（`packages/daemon/src/sync/manual.ts:172`） | 改为 `'skybridge token rejected (401); 请在设置中重新登录'` |
| `sync-error-message` | 不存在 | 新建 `packages/gui/src/shared/sync-error-message.ts`，main + renderer 共用 |
| `packages/gui/src/shared/` 目录 | 不存在 | 新建；`tsconfig.node.json` / `tsconfig.web.json` / `vitest.config.ts` 三处 include 都需扩展 |
| daemon `writeSkybridgeConfig` 调用 | session.ts:217 / session.ts:231（lazy device/workspace bootstrap 后回写 plaintext token round-trip）；manual.ts:166 经 `clearSkybridgeAuth` 回写（auth=undefined，安全） | **保留**（v3 撤回原 v2 「退役 session.ts 两处」决策；见 §v2 → v3 关键调整 #1）；`clearSkybridgeAuth` 路径继续合法 |
| `packages/gui/package.json` 直接 deps | 仅 `@orpheus-aviary/skybridge-client` | 加 `@orpheus-aviary/skybridge-proto`（renderer + main 直接 import `ErrorCodeValue` 类型） |
| 守卫脚本 | 2 个 bash 脚本（`check-core-convergence.sh` / `check-token-not-templated.sh`） | 加 3 个 → 共 5 个 |

### `window.owlAPI` 已有形状（仅列 Phase 8 触碰的部分）

```ts
// types/owl-api.d.ts:28
interface OwlAPI {
  daemonUrl: string;
  startupMode: StartupMode;
  // migration / cli / shortcut / quit 已有，不动
}
```

### sync-auth.ts 已暴露（Phase 7 已 ship）

```ts
// packages/gui/src/main/sync-auth.ts
loginAndOpenSession({ serverUrl, email, password }) → Promise<SyncSessionSummary>  // camelCase
logout() → Promise<void>
restoreSessionOnStartup() → Promise<SyncSessionSummary | null>
```

**新边界（v2）**：renderer ↔ main 的 IPC 输入直接对齐这套 camelCase（不在 IPC 层做 snake↔camel 转换）。`SyncSessionSummary` **不再** 作为 UI display source —— 见下文 §Single display truth。

### Single display truth（v2 锁定，v3 形状细化）

UI 已登录态的所有字段（email / server / workspace_slug / device_name）**只来自 `sync:status` IPC**。

- `sync:login` reply 类型是 `SyncIpcReply<void>`，**成功形状统一为 `{ ok: true, data: undefined }`**（与泛型 `{ ok: true; data: T }` 对齐，避免测试 exact-match 时 `{ ok: true }` 与 `{ ok: true, data: undefined }` 之间摇摆）
- renderer 收到 `{ ok: true, data: undefined }` → 立刻 `await owlAPI.sync.status()` → render 已登录态
- 同理 `sync:logout` 也只回 `{ ok: true, data: undefined }`，renderer success 路径 `await sync.status()` 拿空 session 切回未登录态
- 好处：登录态展示不再因为"summary 缺 device_name / slug 字段"被打补丁；新增展示字段只改 `sync:status` IPC 一处

### ErrorCode 全集

`@orpheus-aviary/skybridge-proto/errors.d.ts` 暴露 13 个 code：

```
INVALID_CREDENTIALS / TOKEN_MISSING / TOKEN_INVALID
DEVICE_HEADER_MISSING / DEVICE_FORBIDDEN / DEVICE_ALREADY_REGISTERED
WORKSPACE_NOT_FOUND / WORKSPACE_EXISTS
BAD_REQUEST / INVALID_PAYLOAD / BATCH_TOO_LARGE
NOT_IMPLEMENTED / INTERNAL_ERROR
```

外加 SDK `NetworkError`（fetch / abort / TCP 失败）+ sync-auth.ts 自带的 `SafeStorageUnavailableError`。`sync-error-message` 覆盖这 15 类 + unknown fallback。

### Settings sections 既有模式（复用）

四个现有 section 共用一个 `SettingRow` flex 布局 + 外层 `<div className="border border-border rounded-md divide-y divide-border">`；错误透出走 `<div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded">`。`SyncSection` 直接对齐这套模式。

### React Router

`react-router-dom@^7.1.0` + HashRouter；在 hash 后挂 query 时（`#/settings?tab=sync`），`useLocation().search === '?tab=sync'`，**`useSearchParams()` 可用**。不手写 `window.location.hash` 解析，不监听 `hashchange`。

### vitest config

`packages/gui/vitest.config.ts` 两个 project：
- `renderer`（jsdom）：`include: ['src/renderer/src/**/*.test.{ts,tsx}']`
- `main`（node）：`include: ['src/main/**/*.test.ts', 'src/preload/**/*.test.ts']`

**Phase 8 改**：把 `src/shared/**/*.test.ts` 加进 `main` project 的 include —— shared 是 node-friendly 纯函数模块，不需 jsdom，跟 main 同 environment 跑。

### 守卫脚本现状

`scripts/check-core-convergence.sh` / `scripts/check-token-not-templated.sh` 已就位；都是 `bash + rg --type ts`，失败 exit 1。Phase 9 3 个新守卫沿用同形。

### daemon 端 OWL_DAEMON_DEV_TOKEN 真实位置

不在 `session.ts`，而在：

- `packages/daemon/src/sync/dev-bootstrap.ts:85, 86, 144, 145`（双 env gate 读 + delete）
- `packages/daemon/src/cli.ts:262`（partial env 提示）

`check-no-prod-env-token.sh` 白名单 = 上述两个文件。

### daemon import('electron') 检查范围

`check-daemon-no-electron-storage.sh` 必须同时 grep：
- `from ['"]electron['"]`
- `require\(['"]electron['"]\)`
- `import\(['"]electron['"]\)`（动态 import）

## Phase 8 实施方案

切 **3 个 commit**：（1）IPC + error map；（2）Settings tab + UI 文案；（3）Phase 9 3 个守卫脚本。

> v2 曾计划在 (2) 与 (3) 之间插入「retire daemon `writeSkybridgeConfig`」commit，v3 撤回 —— 见 §v2 → v3 关键调整 #1。

### Commit 1：`sync IPC + error mapping`

#### Change 1.1 — 新建 `packages/gui/src/shared/sync-error-message.ts`

```ts
import type { ErrorCodeValue } from '@orpheus-aviary/skybridge-proto';

const API_MESSAGES: Record<ErrorCodeValue, string> = {
  INVALID_CREDENTIALS: '邮箱或密码不正确',
  TOKEN_MISSING: '登录凭证缺失，请重新登录',
  TOKEN_INVALID: '登录已失效，请重新登录',
  DEVICE_HEADER_MISSING: '设备信息缺失，请重新登录',
  DEVICE_FORBIDDEN: '当前设备无权限访问该账号',
  DEVICE_ALREADY_REGISTERED: '该设备已在此账号注册',
  WORKSPACE_NOT_FOUND: '找不到对应的工作区',
  WORKSPACE_EXISTS: '工作区已存在',
  BAD_REQUEST: '请求格式错误',
  INVALID_PAYLOAD: '请求内容不合法',
  BATCH_TOO_LARGE: '一次同步的数据量过大',
  NOT_IMPLEMENTED: '服务器尚未支持该操作',
  INTERNAL_ERROR: '服务器内部错误，请稍后重试',
};

export type SyncErrorInput =
  | { kind: 'api'; code: string }                   // SDK ApiError.code
  | { kind: 'network' }                              // SDK NetworkError
  | { kind: 'safe_storage_unavailable' }             // sync-auth SafeStorageUnavailableError
  | { kind: 'unknown'; detail?: string };

/** Map skybridge error 输入 → 中文用户文案。Single source of truth。 */
export function syncErrorMessage(input: SyncErrorInput): string {
  switch (input.kind) {
    case 'api': {
      const known = (API_MESSAGES as Record<string, string>)[input.code];
      return known ?? `同步出错（${input.code}）`;
    }
    case 'network':
      return '网络连接失败，请检查服务器地址或本机网络';
    case 'safe_storage_unavailable':
      return '系统钥匙串不可用，无法安全存储登录凭证';
    case 'unknown':
      return input.detail ? `同步出错：${input.detail}` : '同步出错';
  }
}
```

**位置选 `src/shared/` 的理由**：
- main 进程的 `sync-ipc.ts` 在 catch 路径把 SDK `ApiError.code` 转成中文 message 塞进 IPC reply
- renderer 的 `SyncSection.tsx` 收到 IPC reply 直接显示，自己再有 catch 走的 fallback 也用同一函数
- main + renderer 共享单一真相源，避免双份映射漂移

**配置改动**：
- `tsconfig.node.json` 的 `include` 追加 `src/shared/**/*.ts`
- `tsconfig.web.json` 的 `include` 追加 `src/shared/**/*.ts`
- `vitest.config.ts` 的 `main` project `include` 追加 `'src/shared/**/*.test.ts'`
- `packages/gui/package.json` `dependencies` 加 `"@orpheus-aviary/skybridge-proto": "^0.1.3"`（renderer 不靠 hoist）
- electron-vite 不需改

**测试** `shared/sync-error-message.test.ts`：13 个 ErrorCode 全枚举 + NetworkError + safe_storage_unavailable + unknown（含/不含 detail）+ 未知 code fallback `同步出错（X_NEW_CODE）`。

#### Change 1.2 — 新建 `packages/gui/src/shared/sync-status-types.ts` + `packages/gui/src/main/sync-ipc.ts`

**新文件 1**：`shared/sync-status-types.ts`

```ts
// Mirror of daemon's SyncStatusResult (packages/daemon/src/sync/manual.ts:273).
// Both renderer (lib/api.ts:419) and main (sync-ipc.ts) need this type;
// keeping it in `shared/` avoids main borrowing from renderer code.
export interface SyncStatusResult {
  configured: boolean;
  authenticated: boolean;
  server_url: string | null;
  device_id: string | null;
  workspace_id: string | null;
  pending_count: number;
  pulled_seq: number;
  pushed_seq: number;
  last_sync_at: number | null;
}
```

Phase 8 顺手把 `packages/gui/src/renderer/src/lib/api.ts:419` 的本地 `SyncStatusResult` 定义改成 `import` 自 shared，去重。daemon 的 `manual.ts:273` 留着不动（跨包是 npm boundary）。

`shared/sync-status-types.ts` 同时是 `SyncIpcReply<T>` / `SyncStatusReply` 的物理 owner（v4 上移自 `main/sync-ipc.ts`，理由见 Change 1.4：renderer `owl-api.d.ts` 不能 import main）：

```ts
// shared/sync-status-types.ts — 续上方 SyncStatusResult
export type SyncIpcReply<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

export interface SyncStatusReply {
  /**
   * Null 当：未登录 / toml 残缺 / safeStorage `isEncryptionAvailable()` 为 false /
   * ciphertext 试解密失败。判断必须与 `restoreSessionOnStartup()`
   * (`sync-auth.ts:225, 229`) 同步。
   */
  session: {
    email: string;
    server_url: string;
    workspace_id: string;
    workspace_slug: string | null;
    device_id: string;
    device_name: string;
  } | null;
  /** Null = daemon /sync/status 不可达；shape 对齐 `SyncStatusResult`。 */
  snapshot: SyncStatusResult | null;
}
```

**新文件 2**：`main/sync-ipc.ts`

```ts
import { ipcMain, safeStorage } from 'electron';
import { ApiError, NetworkError } from '@orpheus-aviary/skybridge-client';
import { readSkybridgeConfig, type SkybridgeConfig } from '@owl/core';
import { syncErrorMessage } from '../shared/sync-error-message.js';
import type {
  SyncIpcReply,
  SyncStatusReply,
  SyncStatusResult,
} from '../shared/sync-status-types.js';
import type { LoginAndOpenSessionInput } from '../shared/sync-auth-types.js';
import {
  loginAndOpenSession,
  logout,
  SafeStorageUnavailableError,
} from './sync-auth.js';
import { getDaemonUrl } from './daemon.js';

// `SyncIpcReply` / `SyncStatusReply` types live in `../shared/sync-status-types.ts`
// (renderer can't import from main; shared is the boundary). This file owns
// only the runtime handlers.

export function registerSyncIpc(): void {
  ipcMain.handle('sync:login', async (_e, input: LoginAndOpenSessionInput) =>
    safe<void>(async () => {
      await loginAndOpenSession(input);  // summary discarded — UI reads truth from sync:status
    }),
  );
  ipcMain.handle('sync:logout', async () => safe<void>(() => logout()));
  ipcMain.handle('sync:status', async () => safe<SyncStatusReply>(buildStatus));
}

async function buildStatus(): Promise<SyncStatusReply> {
  const cfg = safeReadConfig();
  const session = extractSession(cfg);

  let snapshot: SyncStatusResult | null = null;
  try {
    const res = await fetch(`${getDaemonUrl()}/sync/status`);
    if (res.ok) {
      const body = (await res.json()) as { data?: SyncStatusResult };
      snapshot = body.data ?? null;
    }
  } catch {
    // daemon down → snapshot null；session 仍可从 toml 拿
  }
  return { session, snapshot };
}

function extractSession(cfg: SkybridgeConfig | null): SyncStatusReply['session'] {
  if (!cfg?.auth?.encrypted_token) return null;       // 拒 plaintext-only toml
  const { auth, device, workspace, server } = cfg;
  if (!auth.user_id || !auth.email) return null;
  if (!device?.id || !device.name) return null;
  if (!workspace?.id) return null;
  // 与 restoreSessionOnStartup (sync-auth.ts:225, 229) 同步可用性判断：
  // (a) safeStorage 不可用 → 用户无法解密 token → Settings 不该展示已登录；
  // (b) ciphertext 损坏 / 跨 OS migrate → decryptString throw → 同样视作未登录。
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    safeStorage.decryptString(Buffer.from(auth.encrypted_token, 'base64'));
  } catch {
    return null;
  }
  return {
    email: auth.email,
    server_url: server.url,
    workspace_id: workspace.id,
    workspace_slug: workspace.slug ?? null,           // toml schema 用 slug 而非 name
    device_id: device.id,
    device_name: device.name,
  };
}

async function safe<T>(fn: () => Promise<T>): Promise<SyncIpcReply<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: false, message: syncErrorMessage({ kind: 'api', code: err.code }) };
    }
    if (err instanceof NetworkError) {
      return { ok: false, message: syncErrorMessage({ kind: 'network' }) };
    }
    if (err instanceof SafeStorageUnavailableError) {
      return { ok: false, message: syncErrorMessage({ kind: 'safe_storage_unavailable' }) };
    }
    return {
      ok: false,
      message: syncErrorMessage({
        kind: 'unknown',
        detail: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

function safeReadConfig(): SkybridgeConfig | null {
  try { return readSkybridgeConfig(); } catch { return null; }
}
```

**注意点**：
- `safe()` 是唯一捕获 SDK 错误的地方；这里不 log token；`ApiError.message` 只在 unknown fallback 用作 detail
- IPC 输入直接是 `LoginAndOpenSessionInput` (`{ serverUrl, email, password }` camelCase)，不在 IPC 层做 snake↔camel 转换
- `extractSession` 显式 narrowing 每个可空字段，不用 `!`
- 工作区展示走 `workspace.slug`（Phase 7 写入是 `${ws.tool}/${ws.name}` 形成 slug，对应 `sync-auth.ts:111`）

#### Change 1.3 — `preload/index.ts` 暴露 `owlAPI.sync`

```ts
sync: {
  login: (input: { serverUrl: string; email: string; password: string }):
    Promise<SyncIpcReply<void>> => ipcRenderer.invoke('sync:login', input),
  logout: (): Promise<SyncIpcReply<void>> => ipcRenderer.invoke('sync:logout'),
  status: (): Promise<SyncIpcReply<SyncStatusReply>> => ipcRenderer.invoke('sync:status'),
}
```

#### Change 1.4 — `types/owl-api.d.ts` 加 sync 类型

**类型来源全部锁 `packages/gui/src/shared/`**，renderer `owl-api.d.ts` 严禁 `import` `./main/*` —— 否则把 Electron / Node main 模块边界拖进 web tsconfig（`tsconfig.web.json` include 不含 `src/main`，会编译失败或 type collapse）。

具体落地：

1. **新建 `packages/gui/src/shared/sync-auth-types.ts`**（v4 新增）作为 `LoginAndOpenSessionInput` 物理 owner：

   ```ts
   /** Input shape for skybridge login. Owned by shared so both main
    *  (`sync-auth.ts`) and renderer (`owl-api.d.ts`) reference the same
    *  type without renderer reaching into main. */
   export interface LoginAndOpenSessionInput {
     serverUrl: string;
     email: string;
     password: string;
   }
   ```

2. **改 `main/sync-auth.ts`**：原本 `export interface LoginAndOpenSessionInput { … }` 改为 `export type { LoginAndOpenSessionInput } from '../shared/sync-auth-types.js';`（同名透传，main 内部调用不变）。

3. **`owl-api.d.ts` 仅 import shared**：

   ```ts
   import type { LoginAndOpenSessionInput } from '../shared/sync-auth-types.js';
   import type { SyncIpcReply, SyncStatusReply } from '../shared/sync-status-types.js';
   import type { SyncStatusResult } from '../shared/sync-status-types.js';
   // 不允许：import type { … } from '../main/sync-auth.js' / '../main/sync-ipc.js'
   ```

4. `SyncIpcReply` / `SyncStatusReply` 的物理 owner 改成 `shared/sync-status-types.ts`（v3 写在 `sync-ipc.ts` 是 main，renderer 不能引）。`main/sync-ipc.ts` 改为 `import type { SyncIpcReply, SyncStatusReply } from '../shared/sync-status-types.js';`，同名透传。

**不另造 `LoginInput` 名字**：renderer 通过 `owlAPI.sync.login(input)` 调用时直接用 `LoginAndOpenSessionInput`，preload 类型同名透传，落地不撞名。

#### Change 1.5 — `main/index.ts` whenReady 注册

```ts
import { registerSyncIpc } from './sync-ipc.js';
// …
ipcMain.handle('cli:detect', () => detectCli());
ipcMain.handle('globalShortcut:set', /* … */);
registerSyncIpc();   // ← new
```

#### Change 1.6 — `sync-ipc.test.ts`

- 用 `vi.mock('electron', ...)` 把 `ipcMain.handle` 替成捕获 handler 函数的工具，**同时 mock `safeStorage.isEncryptionAvailable` / `decryptString`** —— 直接驱动 `extractSession` 两条新路径
- mock `./sync-auth.js` 的三个 export + `SafeStorageUnavailableError`
- mock `@orpheus-aviary/skybridge-client` 暴露 `ApiError` / `NetworkError` 类
- 覆盖：
  - login 成功 → reply **exact match** `{ ok: true, data: undefined }`（**不带 summary**）
  - login throw `ApiError(INVALID_CREDENTIALS)` → `{ ok: false, message: '邮箱或密码不正确' }`
  - login throw `NetworkError` → `{ ok: false, message: '网络连接失败…' }`
  - login throw `SafeStorageUnavailableError` → `{ ok: false, message: '系统钥匙串不可用…' }`
  - login throw 普通 Error → unknown fallback（带 detail）
  - status: toml encrypted_token 全字段齐 + `isEncryptionAvailable=true` + `decryptString` 成功 → session 非 null + daemon snapshot 注入
  - status: toml legacy plaintext `[auth].token` only → session 为 null（拒）
  - status: workspace 缺 → session 为 null（不抛）
  - status: daemon `/sync/status` 不可达 → `{ session: <toml-derived>, snapshot: null }`
  - **status: encrypted_token 齐但 `isEncryptionAvailable=false`（v4 新增）** → session 为 null（与 `restoreSessionOnStartup` 对齐，不误示已登录）
  - **status: encrypted_token 齐 + `isEncryptionAvailable=true` 但 `decryptString` throw（v4 新增）** → session 为 null（ciphertext 损坏 / 跨 OS migrate 场景）

### Commit 2：`Settings 同步 tab + popover + 文案`

#### Change 2.1 — `components/settings/SyncSection.tsx`

**唯一 display truth = `sync:status` IPC**。

```tsx
type View = 'loading' | 'unauth' | { kind: 'auth'; session: NonNullable<SyncStatusReply['session']>; snapshot: SyncStatusResult | null };

export function SyncSection() {
  const [view, setView] = useState<View>('loading');
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const reply = await window.owlAPI.sync.status();
    if (!reply.ok) { setError(reply.message); return; }
    setError(null);
    setView(reply.data.session
      ? { kind: 'auth', session: reply.data.session, snapshot: reply.data.snapshot }
      : 'unauth');
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // login form submit:
  const handleLogin = async (input) => {
    setError(null); setSubmitting(true);
    const reply = await window.owlAPI.sync.login(input);   // SyncIpcReply<void>
    setSubmitting(false);
    if (!reply.ok) { setError(reply.message); return; }
    await refreshStatus();                                  // 唯一 display truth refresh
  };

  // logout button → AlertDialog confirm → sync.logout() → refreshStatus()
}
```

**未登录态**：
- shadcn `<Input>` × 3：server URL（默认 `http://127.0.0.1:8443`）/ email / password
- shadcn `<Button>` "登录"，loading 时 `<Loader2 className="animate-spin">`
- 失败：destructive 容器渲染 `error`

**已登录态**：
- 三行展示：账号 `email` / 工作区 `session.workspace_slug ?? session.workspace_id` / 当前设备 `device_name`
- "退出登录" button → AlertDialog confirm → `owlAPI.sync.logout()` → `refreshStatus()`
- "切换账号" v1 = 退出登录后用户重新填表，不引入复合操作

**数据流**：mount 时 `sync.status()` 一次拿全；login/logout button 路径 success 后 `refreshStatus()`。**不订阅 SSE** —— `SyncStatusBar` 已经订阅；SyncSection 的 snapshot 是 sticky 快照（refresh on user-driven 行为足够），不追实时 push。

#### Change 2.2 — `pages/SettingsPage.tsx` 加 tab

```ts
import { useSearchParams } from 'react-router-dom';

type SettingsTab = 'shortcuts' | 'appearance' | 'custom' | 'sync' | 'advanced';
const TABS = [
  { id: 'shortcuts', label: '快捷键' },
  { id: 'appearance', label: '外观' },
  { id: 'custom', label: '自定义' },
  { id: 'sync', label: '同步' },         // ← new
  { id: 'advanced', label: '高级' },
];

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab') as SettingsTab | null;
  const active = TABS.find((t) => t.id === requested)?.id ?? 'shortcuts';

  const onSelect = (id: SettingsTab) => {
    setSearchParams({ tab: id }, { replace: true });
  };
  // …
}
```

**HashRouter 兼容性**：react-router-dom@^7.1.0 的 HashRouter 把 `#/settings?tab=sync` 中的 `?tab=sync` 暴露成 `useLocation().search` / `useSearchParams()`；`setSearchParams` 写回 hash 也对齐，是项目里唯一稳的做法。

#### Change 2.3 — `SyncStatusBar.tsx` popover

```tsx
import { Link } from 'react-router-dom';
// …
// 替掉 :102 "owl sync login" 那句：
<PopoverDescription>
  daemon 尚未上报同步状态。如果未配置 skybridge，可在
  <Link to="/settings?tab=sync" className="underline">设置 → 同步</Link>
  中登录。
</PopoverDescription>

// 已登录任意状态额外加一行：
<Link to="/settings?tab=sync" className="text-xs text-muted-foreground hover:text-foreground">
  管理账号 →
</Link>
```

#### Change 2.4 — `packages/daemon/src/sync/manual.ts:172` 文案

```ts
// before (实际真实字符串)
'skybridge token rejected (401); re-run `owl sync login`'
// after
'skybridge token rejected (401); 请在设置中重新登录'
```

仅文案改动，不动 status code / error shape。grep `'skybridge token rejected'` 全库只此一处，无测试断言。

#### Change 2.5 — RTL tests

`SyncSection.test.tsx`：
- mock `window.owlAPI.sync` 三 method（`vi.stubGlobal`）
- 未登录态：mount → `sync.status` 返回 `{ ok: true, data: { session: null, snapshot: null } }` → 渲染 form → 输入 → click "登录" → assert `sync.login` called with `{ serverUrl, email, password }` → mock `sync.status` 返回 `{ session: <full>, snapshot: <…> }` → 切换到已登录态
- 错误回放：`sync.login` resolve `{ ok: false, message: '邮箱或密码不正确' }` → 保持未登录态 + destructive 容器
- 已登录态：渲染 email / workspace_slug / device_name → click "退出登录" → confirm → `sync.logout` called → `sync.status` 返回空 session → 切回未登录态
- safeStorage 不可用：`sync.login` 返回 `{ ok: false, message: '系统钥匙串不可用…' }` → 显示

`SettingsPage.test.tsx`：
- `<MemoryRouter initialEntries={['/settings?tab=sync']}>` → 初始 active = 'sync'
- `<MemoryRouter initialEntries={['/settings?tab=bogus']}>` → 回退 'shortcuts'
- `<MemoryRouter initialEntries={['/settings']}>` → 回退 'shortcuts'

`SyncStatusBar.test.tsx` 增量：
- **前置**：把现有 `render(<SyncStatusBar />)` 改成 `render(<MemoryRouter><SyncStatusBar /></MemoryRouter>)`，否则 `<Link>` 抛 "useNavigate must be used within a Router"
- 渲染时不再含 `'owl sync login'`
- "管理账号" 链接渲染，`to="/settings?tab=sync"`

### Commit 3：`Phase 9 guard scripts`

> v2 曾在 (2) 与 guards 之间插入 `retire daemon writeSkybridgeConfig`，v3 撤回 —— `registerDevice` 二次调用是 409 而非 idempotent，删 `session.ts:217, 231` 让 legacy 半启动用户冷启动后 sync 直接失败；正确退役要配 device-id 恢复路径（`listDevices` + hostname 匹配 + name 冲突边界），属独立 phase。
>
> 因此 Phase 9 由 4 个守卫减到 **3 个**：撤掉 `check-no-plaintext-token-write.sh`（session.ts:217/231 仍合法持 `writeSkybridgeConfig`），保留 electron / prod-env-token / session-body 三守卫。

#### Change 3.1 — `scripts/check-daemon-no-electron-storage.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
# daemon must stay electron-free; safeStorage / keychain lives in GUI main.
hits=$(rg --type ts \
  -e "from ['\"]electron['\"]" \
  -e "require\(['\"]electron['\"]\)" \
  -e "import\(['\"]electron['\"]\)" \
  packages/daemon/src \
  --glob '!**/*.test.ts' \
  --glob '!**/*.e2e.ts' \
  || true)
if [ -n "$hits" ]; then
  echo "✗ daemon src must not import electron (safeStorage belongs in GUI main only)"
  echo "$hits"
  exit 1
fi
echo "✓ daemon stays electron-free"
```

覆盖静态 `from 'electron'` + CJS `require('electron')` + 动态 `import('electron')` 三种形态。

#### Change 3.2 — `scripts/check-no-prod-env-token.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
# OWL_DAEMON_(DEV_)TOKEN must never appear in prod daemon code paths.
# Whitelist: dev-bootstrap.ts (the gated dev path) + cli.ts (the partial-env
# warning). Anywhere else is a bug that bypasses the v3 dev double-env gate.
hits=$(rg --type ts \
  -e 'OWL_DAEMON_DEV_TOKEN|OWL_DAEMON_TOKEN|OWL_ALLOW_INSECURE_DEV_TOKEN' \
  packages/daemon/src \
  --glob '!**/dev-bootstrap.ts' \
  --glob '!**/cli.ts' \
  --glob '!**/*.test.ts' \
  --glob '!**/*.e2e.ts' \
  || true)
if [ -n "$hits" ]; then
  echo "✗ daemon prod paths must not read OWL_DAEMON_(DEV_)TOKEN (only dev-bootstrap.ts + cli.ts allowed)"
  echo "$hits"
  exit 1
fi
echo "✓ no env token reads outside dev-bootstrap"
```

白名单 = `dev-bootstrap.ts` + `cli.ts`，与 §Audit 实际位置一致。

#### Change 3.3 — `scripts/check-session-body-not-logged.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
# /sync/session handler body contains plaintext token; must not be logged.
# Pino redact + check-token-not-templated.sh cover structured + templated
# leaks; this guards the route handler specifically against logging the
# raw body or any token/password field through ctx.logger.*.
#
# Multi-line is mandatory: `routes/sync.ts:73` and `:105` already write
# `ctx.logger.info(\n  { kind: 'sync-session', ... },\n  'msg',\n);` across
# multiple lines, so single-line regex would silently pass:
#
#   ctx.logger.info(
#     { body: req.body },         <- this MUST be caught
#     'debug',
#   );
#
# Strategy: rg `-U` (multiline) + `--multiline-dotall` (so `.` matches `\n`).
# `[^)]*?` already matches newlines in negated char class form, but we keep
# `--multiline-dotall` explicit so future regex tweaks using `.` don't slip.
#
# Regex notes:
#   - Existing baseline writes `ctx.logger.info({ kind: 'sync-session', ...,
#     user_id, workspace_id, device_id }, '...')` and accesses
#     `session.config.auth?.user_id`. We can NOT grep for words like
#     `session` / `auth` — those are legitimate domain vocabulary.
#   - We grep for genuinely sensitive shapes only:
#       * `req.body` — dumping the whole body
#       * `token: ` / `.token` — an explicit token field reference
#       * `password: ` / `.password` — same for password
#   - Daemon route handlers wire ctx.logger explicitly (`routes/sync.ts:73,
#     105` use `ctx.logger.info(...)`), never `log.info` / `req.log.info`.
#   - `[^)]*?` non-greedy stops at the first `)`. If a logger call contains
#     a nested function call `f()` in args, the match window is truncated
#     and a downstream leak could slip; current daemon code has no such
#     pattern in `routes/sync.ts`, but if introduced, fall back to the
#     perl-extract variant noted in the design doc §Change 3.3 alt.
file="packages/daemon/src/routes/sync.ts"
if [ ! -f "$file" ]; then
  echo "✗ expected $file"
  exit 1
fi
hits=$(rg -U --multiline-dotall \
  -e 'ctx\.logger\.[a-z]+\s*\([^)]*?\breq\.body\b' \
  -e 'ctx\.logger\.[a-z]+\s*\([^)]*?\btoken\s*:' \
  -e 'ctx\.logger\.[a-z]+\s*\([^)]*?\.token\b' \
  -e 'ctx\.logger\.[a-z]+\s*\([^)]*?\bpassword\s*:' \
  -e 'ctx\.logger\.[a-z]+\s*\([^)]*?\.password\b' \
  "$file" \
  || true)
if [ -n "$hits" ]; then
  echo "✗ /sync/session route must not log req.body / token / password via ctx.logger.*"
  echo "$hits"
  exit 1
fi
echo "✓ /sync/session body not logged"
```

只针对 `routes/sync.ts` 单文件，避免误命中 daemon 其他 sync 业务 log。**不 grep `session` / `auth`** —— 这些是合法领域词汇，会让守卫一接入 baseline 就红（`kind: 'sync-session'` / `session.config.auth?.user_id` 都会撞）。

**baseline 跑一遍验证**：手动 `bash scripts/check-session-body-not-logged.sh` 在 baseline 上必须返回 `✓`，不能命中既有 line 73-82 / 105 的合法多行 sync-session 日志。这是 Phase 9 commit 进 just check 前必跑的烟雾测试。

**Alt 备选（v4 留尾）**：若 daemon 后续在 `routes/sync.ts` logger args 里出现嵌套函数调用 `f()` 导致 `[^)]*?` 提前截断，把脚本换成 perl 提取 logger block 后扫，模板：

```bash
perl -0777 -ne '
  my $hit = 0;
  while (/ctx\.logger\.[a-z]+\s*\(/g) {
    my $start = pos($_);
    my $depth = 1; my $i = $start;
    while ($depth > 0 && $i < length($_)) {
      my $c = substr($_, $i, 1);
      $depth++ if $c eq "(";
      $depth-- if $c eq ")";
      $i++;
    }
    my $block = substr($_, $start, $i - $start - 1);
    if ($block =~ /\breq\.body\b|\btoken\s*:|\.token\b|\bpassword\s*:|\.password\b/) {
      print "leak in ctx.logger block: ", substr($block, 0, 120), "...\n";
      $hit = 1;
    }
  }
  END { exit $hit }
' "$file"
```

当前 baseline 不需要切换，但放这里便于未来一行命令换实现。

#### Change 3.4 — justfile 集成

```just
[group('lint')]
check: lint typecheck core-convergence token-not-templated \
       daemon-no-electron-storage no-prod-env-token \
       session-body-not-logged
    @echo "All checks passed."

[group('lint')]
daemon-no-electron-storage:
    bash scripts/check-daemon-no-electron-storage.sh

[group('lint')]
no-prod-env-token:
    bash scripts/check-no-prod-env-token.sh

[group('lint')]
session-body-not-logged:
    bash scripts/check-session-body-not-logged.sh
```

#### Change 3.5 — 真生效自验（不进 commit）

- 临时往 `packages/daemon/src/sync/session.ts` 加 `import { safeStorage } from 'electron'` → `just daemon-no-electron-storage` 报错；revert → 绿
- 临时往 `packages/daemon/src/sync/manual.ts` 加 `process.env.OWL_DAEMON_DEV_TOKEN` 引用（白名单外的 daemon 文件，引擎在 core 不在守卫扫描范围内）→ `just no-prod-env-token` 报错；revert → 绿
- 临时往 `packages/daemon/src/routes/sync.ts` `/sync/session` handler 加单行泄漏 `ctx.logger.info({ body: req.body })`（命中 `req.body` regex）→ `just session-body-not-logged` 报错；revert → 绿
- **多行泄漏自验（v4 新增，必跑）**：临时加下面这种实际真实风格的多行 logger，验证 `rg -U` 真生效；revert → 绿：
  ```ts
  ctx.logger.info(
    { body: req.body },
    'debug',
  );
  ```
  如果守卫漏报这条 → `rg -U` flag 没生效；这是 v3 单行 regex 漏报的 bug，v4 自验门
- **可选第三次自验**：临时加 `ctx.logger.info({ token: 'xxx' })`（命中 `token:` regex）→ 报错；revert → 绿。三类敏感 regex（req.body / token / multi-line）都活

## Phase 8 + 9 测试基线目标

| 维度 | 现 | 期望 |
|---|---|---|
| 单元（gui） | 236 | +sync-error-message ~16 / +sync-ipc ~11（v4 加 2 个 safeStorage 路径）/ +SyncSection ~8 / +SettingsPage ~3 / +SyncStatusBar ~2 ≈ **+40** → 276 |
| 单元（daemon） | 238 | 不变 |
| 单元（core / cli） | 408 / 134 | 不变 |
| 单元总 | **1016** | **≈ 1056** |
| `just check` 子任务（含 lint / typecheck / bash 守卫） | 4 | **7** |
| 其中 bash 守卫脚本 | 2 | **5** |
| dual e2e | 16/16 | 不变 |

## 不变量复检（Phase 6+7 已立，Phase 8/9 加固）

| 不变量 | Phase 8/9 处置 | 说明 |
|---|---|---|
| daemon 不读 env token | **Phase 9 守卫加固** | `check-no-prod-env-token.sh`（白名单 dev-bootstrap.ts + cli.ts） |
| daemon 不 import electron / safeStorage | **Phase 9 守卫加固** | `check-daemon-no-electron-storage.sh`（静/CJS/动态 import 三种形态） |
| GUI main 是唯一 plaintext + ciphertext 持有 | 不动 | `sync-ipc.ts` 仍在 main 包，受 Phase 7 边界 |
| **GUI main 是 encrypted path 的唯一 identity/toml writer** | 仍是契约；**部分代码护栏化** | `session.ts:201-231` 的 legacy plaintext bootstrap 仍写 toml（device/workspace + plaintext token round-trip），是已知例外；`clearSkybridgeAuth`（清 auth=undefined）路径合法；彻底退役见 §留尾独立 phase |
| atomic toml 写 = 最后一步 | 不动 | Phase 8 不写 toml |
| `restoreSessionOnStartup` 拒 plaintext | 不动 | `sync:status` IPC `extractSession` 同样拒 |
| `OWL_GUI_PARENT_PID` 闭环 | 不动 | 沿用 |
| pino redact + `check-token-not-templated.sh` | 不动 | 沿用；`check-session-body-not-logged.sh` 额外加固 |

## 风险

| 风险 | 缓解 |
|---|---|
| HashRouter + useSearchParams 边界行为不熟 | 用 react-router-dom@7 提供的 `setSearchParams` 写回 hash；RTL 用 `<MemoryRouter>` 覆盖 3 种 initialEntries |
| `sync:status` 在 daemon 启动尚未 ready 时被调 | `safe()` 把 fetch 异常吃掉，snapshot null，session 仍能从 toml 拿；`extractSession` narrowing 不抛；safeStorage 可用性 + decrypt 试一遍判活 |
| safeStorage 不可用 / ciphertext 损坏时 Settings 误示「已登录」 | v4 `extractSession` 与 `restoreSessionOnStartup` (sync-auth.ts:225, 229) 对齐：`isEncryptionAvailable=false` 或 `decryptString` throw 都回 null；测试单独 cover 这两条路径 |
| `routes/sync.ts` logger 多行调用绕过 single-line regex | v4 守卫改 `rg -U --multiline-dotall`；自验加多行泄漏样例；备选 perl-extract 实现留尾备用 |
| `sync-error-message` 漏 ErrorCode | 用 `Record<ErrorCodeValue, string>` —— SDK 升级新增 code 时 TypeScript 编译失败兜底 |
| `manual.ts:172` 文案改动影响既有 daemon 单测 | grep `'skybridge token rejected'` 全库唯一命中是 manual.ts 自己；无测试断言 |
| Phase 9 守卫误报 | 每条脚本带 `--glob '!**/*.test.ts'` + 必要的白名单 file；Change 3.5 真生效自验 |
| `sync:login` 成功 reply 与 `void` 泛型在测试 exact-match 不一致 | 锁定 `{ ok: true, data: undefined }`，`safe<void>` 显式返 `await fn()` 后 `{ ok: true, data: undefined as void }` |
| legacy plaintext + 半启动 toml 用户在新版本下的行为 | Phase 8/9 保持现状：daemon lazy bootstrap 仍写回（避免触 `DEVICE_ALREADY_REGISTERED`）；彻底退役留独立 phase |

## 切片（3 commit）

| Commit | Scope | 内容 | 验收 |
|---|---|---|---|
| 1 | `skybridge` | `shared/sync-error-message.ts` + `shared/sync-status-types.ts`（含 `SyncIpcReply` / `SyncStatusReply`）+ `shared/sync-auth-types.ts`（`LoginAndOpenSessionInput`，v4）+ `main/sync-ipc.ts`（safeStorage 试解密判活）+ `main/sync-auth.ts` 改 re-export 共享 input 类型 + preload `owlAPI.sync` + `types/owl-api.d.ts`（仅 import shared）+ main/index.ts wire + tsconfig×2 + vitest config + gui package.json 加 `skybridge-proto` dep + renderer `lib/api.ts` SyncStatusResult 改 import shared + 单测（含 v4 两条 safeStorage 路径） | `just check` + `just test` 绿 |
| 2 | `skybridge` | `components/settings/SyncSection.tsx` + `pages/SettingsPage.tsx` 加 tab + `useSearchParams` deep link + `SyncStatusBar.tsx` 改文案（含测试加 MemoryRouter wrapper）+ `manual.ts:172` 文案 + RTL 单测 | `just check` + `just test` 绿 |
| 3 | `skybridge` | 3 个新 bash 守卫脚本 + justfile 集成 + Change 3.5 真生效自验（不进 commit） | `just check` 7 子任务全过（2 lint/typecheck + 5 bash 守卫） |

## 验收清单

Phase 8：

- [ ] `just check` 7 子任务全过（lint + typecheck + 5 个 bash 守卫，Phase 9 完成后）
- [ ] **baseline 烟雾验**：在 Phase 9 commit 前手动跑 `bash scripts/check-session-body-not-logged.sh` 必须 `✓`（防 regex 误捞 `'sync-session'` / `auth?` 既有合法字符串）
- [ ] `just test` ≈ 1056/1056
- [ ] 手动：未登录态 Settings → Sync → 输入 server/email/password → "登录" → 已登录态（email / slug / device_name 渲染）
- [ ] 手动：已登录态 → "退出登录" confirm → 回到未登录态
- [ ] 手动：错误密码 → 显示"邮箱或密码不正确"
- [ ] 手动：daemon 关掉再开 Settings → snapshot 为 null 但 session 信息从 toml 仍展示
- [ ] 手动：SyncStatusBar popover 不再有 `owl sync login` 字串
- [ ] 手动：popover "管理账号" 点击 → `#/settings?tab=sync` → Settings sync tab 激活

Phase 9：

- [ ] `just check` 全绿（7 子任务，2 lint/typecheck + 5 bash 守卫）
- [ ] 每条新守卫单独 throw 一行 violation → 报错；revert → 绿（Change 3.5 自验）
- [ ] `check-session-body-not-logged.sh` baseline 跑 → `✓`（确认 regex 不误捞合法 sync-session 日志）

## 留尾（明确归后续 phase）

- Phase 10：设备管理 GUI（"我的设备"列表）
- Phase 11：watchdog
- Phase 16：CLI `owl sync login` 改文案
- **新独立 phase（v3 划出）**：daemon `writeSkybridgeConfig` 完全退役 + legacy plaintext bootstrap 整体退役。需配套 device-id 恢复路径：
  - `registerDevice` 抛 `DEVICE_ALREADY_REGISTERED` → `listDevices` → hostname 精确匹配恢复 id
  - hostname 重名 / 用户改 name / 多设备同 host 边界拍板
  - 然后才能加 `check-no-plaintext-token-write.sh` 守卫，session.ts 三步收口
  - 适合放到 0.6.x，或 0.5.0 GA 前如果 soak 暴露相关 bug 再前置

## 决议复述（来自 2026-05-28~29 当面问答 + v3 review）

| # | 决议 | v3 调整 |
|---|------|---|
| 1 | Phase 8/9 切 **3 个 commit**：IPC + 错误映射 / SyncSection + UI 文案 / 3 个守卫脚本 | v2 「4 commit + retire daemon toml writes」撤回 |
| 2 | `sync-error-message.ts` + `sync-status-types.ts` 放 `packages/gui/src/shared/`，main + renderer 共用；`tsconfig.node` / `tsconfig.web` / `vitest.config` 三处 include 同步加 `src/shared/**` | `sync-status-types.ts` v3 新增（解 `SyncStatusResult` 类型来源问题） |
| 3 | renderer 显示 email/workspace/device 字段：**`sync:status` IPC 是唯一 display truth**；`sync:login` reply 是 `SyncIpcReply<void>`；login success → renderer `await refreshStatus()` | 成功形状 v3 锁 `{ ok: true, data: undefined }`（避免测试 exact-match 摇摆） |
| 4 | SyncSection 用 `sync:status` 一次拿全；**不订阅 SSE**（SyncStatusBar 已订阅） | — |
| 5 | Settings tab deep link 用 `useSearchParams`，不手写 `window.location.hash` 解析；SyncStatusBar 用 `<Link to="/settings?tab=sync">`；`SyncStatusBar.test.tsx` 加 `<MemoryRouter>` wrapper | v3 加 Router wrapper 要求 |
| 6 | IPC 输入 camelCase（`{ serverUrl, email, password }`），对齐 `LoginAndOpenSessionInput`，不在 IPC 层做 snake↔camel 转换 | — |
| 7 | ~~Commit 3 退役 `session.ts:217, 231` writeSkybridgeConfig 调用~~ | **v3 撤回**：`/devices/register` 二次调用抛 409 `DEVICE_ALREADY_REGISTERED`（验 `skybridge/packages/server/src/routes/devices.ts:60`），不是 idempotent；删 session.ts 两处会让 legacy 用户冷启动 sync 直接失败。彻底退役需 device-id 恢复路径，留独立 phase |
| 8 | ~~`check-no-plaintext-token-write.sh` 一刀切 daemon `writeSkybridgeConfig`~~ | **v3 撤掉该守卫**：session.ts 仍合法持调用，不愿用 allow-list 弱化语义；Phase 9 留 3 守卫 |
| 9 | Phase 9 守卫白名单 = 实际真实位置：env token 守卫 = `dev-bootstrap.ts` + `cli.ts`；electron 守卫 = grep 静/CJS/动态 三种 import；**session-body 守卫 grep `ctx.logger.*` 形态**（`routes/sync.ts:73, 105` 实际用 `ctx.logger.info`） | v3 修正 logger regex 形态 |
| 10 | `manual.ts:172` 真实字符串是 `'skybridge token rejected (401); re-run \`owl sync login\`'`，after 改 `'…; 请在设置中重新登录'` | — |
| 11 | "GUI main 是唯一 toml 写入方" 重述：**"GUI main 是 encrypted path 的唯一 identity/toml writer；daemon legacy plaintext bootstrap (`session.ts:201-231`) 仍是已知例外，待独立 phase 退役；`clearSkybridgeAuth` core helper 清 auth 路径合法"** | v3 二轮再修：原 v3 "daemon 不写新身份" 与保留 session.ts lazy bootstrap 自相矛盾 |
| 12 | `check-session-body-not-logged.sh` regex 不 grep 泛词 `session` / `auth` —— 改抓真敏感形态 `req.body` / `token:` / `.token` / `password:` / `.password` | v3 二轮新增：v3 regex 会命中 `routes/sync.ts:73,82,105` 既有合法 `'sync-session'` / `session.config.auth?.user_id`，让守卫一进 just check 就红 |
| 13 | 守卫脚本数对齐：baseline **2 个 bash 守卫**，v3 加 **3 个** → 共 **5 个 bash 守卫**；`just check` 子任务（含 lint/typecheck）从 4 → 7 | v3 二轮：避免"守卫"一词在 bash 脚本 vs just check 子任务两种语义间漂移 |
| 14 | IPC 输入类型直接复用 `LoginAndOpenSessionInput`，不另造 `LoginInput` 名字 | v3 二轮：types/owl-api.d.ts 段消歧 |
| 12 | `check-no-prod-env-token.sh` 自验文件用 `packages/daemon/src/sync/manual.ts`（非白名单 daemon 文件） | v3 修正（v2 写的 `engine.ts` 在 core，守卫扫不到） |
| 13 | `check-session-body-not-logged.sh` 用 `rg -U --multiline-dotall` 多行匹配；Change 3.5 必跑多行泄漏自验 | **v4 新增**：v3 single-line regex 漏报 `ctx.logger.info(\n  { body: req.body },\n  'debug',\n);` 这类与 baseline `routes/sync.ts:73, 105` 完全同风格的多行写法 |
| 14 | `extractSession` v4 加 `safeStorage.isEncryptionAvailable()` + 试 `decryptString`，与 `restoreSessionOnStartup` (sync-auth.ts:225, 229) 同步 | **v4 新增**：v3 只看 `encrypted_token` 字段存在 → keychain 不可用 / 跨 OS migrate 时 Settings 错示「已登录」但 startup restore 实际 fail null |
| 15 | `LoginAndOpenSessionInput` / `SyncIpcReply` / `SyncStatusReply` 物理 owner 锁 `packages/gui/src/shared/`，renderer `owl-api.d.ts` 严禁 import `./main/*` | **v4 新增**：v3 Change 1.4 「re-export from main or shared duplicate」太松；renderer import main 会把 Electron / Node main 模块边界拖进 web tsconfig |

v4 锁定。等用户终审 → 开 Commit 1。

---

## Implementation record（2026-05-29）

| Commit | Scope | 内容 |
|---|---|---|
| `191fd66` | 1: IPC + 错误映射 | `shared/sync-error-message.ts` + `shared/sync-status-types.ts`（含 `SyncIpcReply` / `SyncStatusReply` / `SyncStatusResult`）+ `shared/sync-auth-types.ts`（`LoginAndOpenSessionInput`，v4 物理 owner）+ `main/sync-ipc.ts`（safeStorage 试解密判活）+ `main/sync-auth.ts` 改 import shared input + preload `owlAPI.sync` + `types/owl-api.d.ts`（仅 import shared）+ `main/index.ts` wire + tsconfig×2 + vitest config + gui `package.json` `@orpheus-aviary/skybridge-proto@^0.1.3` + renderer `lib/api.ts` `SyncStatusResult` 改 import shared + 32 单测 |
| `5e4916a` | 2: Settings tab + popover | `components/settings/SyncSection.tsx`（未登录 form / 已登录三行 + inline 退出确认）+ `pages/SettingsPage.tsx` `useSearchParams` deep link + `components/sync/SyncStatusBar.tsx` 替掉「`owl sync login`」+ "管理账号 →" link + `daemon/sync/manual.ts:172` 文案改「请在设置中重新登录」+ vitest.config react-router 别名 + dedupe + inline（解决 React 19 dup-instance useRef-null）+ 14 单测 |
| `ef6a7cd` | 3: Phase 9 守卫 | 3 个 bash 守卫（`check-daemon-no-electron-storage.sh` 三 import 形态 / `check-no-prod-env-token.sh` 白名单 dev-bootstrap+cli / `check-session-body-not-logged.sh` **`rg -U --multiline-dotall` 多行版**）+ justfile 7 子任务集成 + Change 3.5 真生效自验（含 v4 多行 leak 关键样例：`ctx.logger.info(\n  { body: req.body },\n  'debug',\n)` 必须被守卫拦下）+ SyncSection.test.tsx 一处类型拓宽（`workspace_slug: string \| null`） |

**测试基线（Phase 8+9 完成后）**：

- 单元 **1062/1062**（core 408 + cli 134 + daemon 238 + gui 282；vs 1016 +46）
- `just check` **7 子任务**全过（lint + typecheck + 5 bash 守卫）
- `SKYBRIDGE_E2E=1` 16/16（未重跑，结构未变）

**v4 设计落地一一对应**：

| v4 调整 | 落地形态 |
|---|---|
| A: `check-session-body-not-logged.sh` 多行 regex | `rg -U --multiline-dotall` + 自验加多行 leak 样例 → 守卫拦下 baseline 同款风格的多行 `ctx.logger.info(\n  { body: req.body },\n  'debug',\n);` |
| B: `extractSession` 对齐 `restoreSessionOnStartup` | `main/sync-ipc.ts:67-90`：`safeStorage.isEncryptionAvailable()` 检查 + 试 `decryptString`，任一失败 → session null。单测 2 条新路径 |
| C: `LoginAndOpenSessionInput` shared 物理 owner | `src/shared/sync-auth-types.ts`，`main/sync-auth.ts` 改 `import type`；`owl-api.d.ts` 显式禁止 import main |

**Phase 7+8+9 联合不变量**（编号续 P5-d Phase 7 44 → 45-49）：

45. **`owlAPI.sync` 是 renderer 唯一登录入口** —— 不再走终端；preload `sync.{login, logout, status}` IPC bridge，main `registerSyncIpc()` 注册三 handler，失败统一 `{ ok: false, message: <中文> }`
46. **single display truth** —— Settings 显示 identity 字段（email / workspace_slug / device_name）只从 `sync:status` IPC 读；`sync:login` 成功 reply 锁定 `{ ok: true, data: undefined }`（summary 故意丢弃），renderer 必须 `await refreshStatus()` 拿展示数据。新增展示字段时只改 `sync:status` 一处
47. **`extractSession` 与 `restoreSessionOnStartup` 同 gate** —— v4 修复：`extractSession` 检 `safeStorage.isEncryptionAvailable()` + 试 `decryptString(encrypted_token)`，任一失败回 null。Settings 永远不能比 startup restore "更乐观"
48. **shared 类型物理边界** —— `LoginAndOpenSessionInput` / `SyncIpcReply<T>` / `SyncStatusReply` / `SyncStatusResult` 全部 own 在 `packages/gui/src/shared/`；renderer `types/owl-api.d.ts` 严禁 `import ./main/*`（`tsconfig.web.json` include 不含 main，会编译 / type collapse）；main `sync-ipc.ts` import shared
49. **Phase 9 5 个 bash 守卫**（baseline 2 → 5）—— `core-convergence` / `token-not-templated` 保留；新增 `daemon-no-electron-storage`（三 import 形态）/ `no-prod-env-token`（白名单 `dev-bootstrap.ts + cli.ts`）/ `session-body-not-logged`（**多行 regex**，拦 `ctx.logger.*` 形态下的 `req.body` / `.token` / `token:` / `.password` / `password:`）。`just check` 子任务 4 → 7

**手动验收（2026-05-29，post-commit `ef6a7cd`）**：金路径 1-5 + Step 7 deep link 全过：

| Step | 验收项 | 结果 |
|---|---|---|
| 2 | SyncStatusBar 灰点 / 已同步 + popover「管理账号 →」链接 + 跳 `#/settings?tab=sync` | ✓ |
| 3 | 未登录态 form 渲染（**v4 §47 关键 invariant 现网验**：daemon 报 authenticated=true via legacy plaintext，Settings 仍展示 form）| ✓ |
| 3 | 错误密码 → 中文「邮箱或密码不正确」 | ✓ |
| 4 | 真密码 → 已登录三行（email / workspace_slug / device_name）；后端 toml 只写 `encrypted_token`；daemon log 无 token / password 泄漏 | ✓ §39 |
| 5 | inline confirm（取消 / 确认退出）+ 后端 `[auth]/[device]/[workspace]` 全清、`[server].url` 保留、`pulled_seq=482` 不动 | ✓ §37 + §3.6.2 |
| 7 | `?tab=appearance` → 外观；`?tab=bogus` / 无 `?tab` → fallback 快捷键 | ✓ |

**Step 6 跳过**（cold-start popover snapshot-null 分支）：实测要求全新 GUI 启动 + 完全没 daemon 才能触发 null snapshot；mid-session 杀 daemon 后 `useSyncStatus` zustand 已缓存 snapshot，不回 null。该分支被 `SyncStatusBar.test.tsx` v4 新增 2 条单测覆盖（不含 `owl sync login` + `<Link to="/settings?tab=sync">` 渲染）。

**手动测试中发现并修复**：`SyncSection.tsx:24` `DEFAULT_SERVER_URL = 'http://127.0.0.1:18443'` —— skybridge server 实际默认 `8443`（`skybridge/packages/server/src/config.ts`）。设计文档 v4 抄错 18443 → 落进代码 → 落进 1 个单测。已修：`SyncSection.tsx` + 设计文档全文 + `SyncSection.test.tsx` `getByDisplayValue` 用例。基线保持 1062/1062。

**正向 UX 观察**（非 bug，记录给设计参考）：登出后 form **记住上次成功登录的服务器 URL + 邮箱**，只清密码 —— `handleLogout` 后 `refreshStatus` 把 session 置 null 但不重置 form state（serverUrl 在登录态时被 `setServerUrl(session.server_url)` 写过；email 在 form 输入时被写过），登出后两值随 form state 保留。比设计文档暗示的「回退到 DEFAULT」更友好。

**Phase 8/9 留尾归属（v4 收尾时锁定）**：

- daemon `writeSkybridgeConfig` 完全退役 + legacy plaintext bootstrap 整体退役 —— 需配 device-id 恢复路径（`registerDevice` 抛 409 `DEVICE_ALREADY_REGISTERED` → `listDevices` → hostname 匹配 → 恢复 id；hostname 重名 / 用户改 name / 多设备同 host 边界拍板），适合到 Phase 11 watchdog 之后、0.5.0 GA 前
- CLI `owl sync login` 文案 `apps/cli/src/commands/sync.ts:248` 改「请使用 GUI 登录」 —— 留 Phase 16 一起
- `clearSkybridgeAuth(configPath)` 仍由 daemon `manual.ts:166` 在 401 path 调（401 self-heal 路径，不属 keychain 主线，跟 plaintext bootstrap 一起 retire）
