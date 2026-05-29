# P5-d Phase 10 设计文档 — 设备列表 GUI + daemon plaintext bootstrap 退役

**日期**：2026-05-29
**前置**：[2026-05-28 Phase 8+9 design](2026-05-28-p5-d-phase-8-9-design.md) §手动验收已过 + `b984906` 18443→8443 fix
**累计待 push**：本 phase 开工前 12 commits ahead of `origin/main`，基线 1062/1062 + `just check` 7 子任务
**Phase 不变量编号续**：49 → **50-54**（Phase 7 44 / Phase 8+9 45-49）

---

## 1. 目标

owl 内部闭环的两件事：

1. **设备列表 GUI**（Settings → 同步 tab → SyncSection 内 collapsible 子卡片）
   - 只读列表：id / name / platform / app_version / last_seen_at
   - 当前设备高亮（匹配 `session.device_id`）
   - 通过 `owlAPI.sync.devices()` IPC，daemon 转发 skybridge SDK 的 `listDevices()`

2. **daemon plaintext bootstrap 整体退役**
   - daemon 不再读 toml `[auth].token` plaintext（`requireAuth` call site 移除）
   - daemon 不再 lazy registerDevice / ensureWorkspace / writeSkybridgeConfig（GUI main 是唯一写者）
   - daemon 不再在 401 调 clearSkybridgeAuth（GUI logout 负责清 toml）
   - daemon source 全面禁止任何 `writeSkybridgeConfig` / `clearSkybridgeAuth` 引用（新增 bash 守卫）

`ensureSkybridgeSession` 收缩为：只返回 `ctx.skybridgeSession`，不存在则抛 `SkybridgeAuthRequiredError`。会话只能通过 `POST /sync/session`（即 GUI main `sync-auth.ts` 链路）注入。

## 2. 显式非目标（推到 Phase 10.5+）

- **撤销其他设备 token**：skybridge server `^0.1.3` 没有 `DELETE /devices/:id` / `POST /devices/:id/revoke` 端点；SDK 也只暴露 `listDevices()` + 当前 token 的 `logout()`。要做需先升级 skybridge server + SDK，跨 3 repo + 2 npm publish，独立 Phase 10.5。Phase 10 设备列表纯只读
- **重复 device row 防御（hostname 探针）**：原 brief 「409 → listDevices → hostname 恢复」实际不触发（重装 owl → 新登录 → 新 token 未绑定 device → server 不返回 409，而是默默插入新 row）。要防御需前置 listDevices + 弹窗确认，UX 选型肥大，推后
- **CLI `owl sync login` 文案改写**：`/sync/login` daemon 路由 Phase 6 已 retire，CLI 命令已经是 404 死代码。Phase 16 一并改文案
- **`@owl/core` 删除 `clearSkybridgeAuth` / `writeSkybridgeConfig` / `requireAuth` exports**：本 phase 仅断 daemon 调用；core 暂留导出（CLI `sync config show` 仍用 `readSkybridgeConfig`，core 内 helper 互引），Phase 11+ 清

## 3. 设计

### 3.1 SDK / 数据流

skybridge-client `^0.1.3`（仓库实际固定版本，见 `packages/daemon/package.json:22` / `packages/gui/package.json:30`；验证过 `node_modules/@orpheus-aviary/skybridge-client/src/client.d.ts:53`）：

```ts
interface SkybridgeClient {
  listDevices(): Promise<ApiDevice[]>;
  // ...
}
interface ApiDevice {
  id: string;
  name: string;
  platform: string | null;
  appVersion: string | null;
  clientVersion: string | null;
  createdAt: number;
  lastSeenAt: number;
}
```

服务端路由 `GET /devices`（验证过 `skybridge/packages/server/src/routes/devices.ts:110`）返回当前 user 下全部 device 行，按 `created_at` 排序。

**daemon `RealSkybridgeClient` 结构类型需补 `listDevices`** —— `session.ts:67` 的 structural type 当前只覆盖 `registerDevice` / `ensureWorkspace` / `pushChanges` / `pullChanges` / `subscribeEvents`，缺 `listDevices`。Commit 1 必须先在该接口加：

```ts
export interface RealSkybridgeClient {
  // existing ...
  listDevices(): Promise<{
    id: string;
    name: string;
    platform: string | null;
    appVersion: string | null;
    clientVersion: string | null;
    createdAt: number;
    lastSeenAt: number;
  }[]>;
}
```

否则 `session.realClient.listDevices()` 在 daemon source 类型检查直接红。

### 3.2 daemon `GET /sync/devices`（新增）

**前置：错误翻译函数必须可复用**。当前 `translateSkybridgeError`（manual.ts:146）是 module-private，签名 `(err, configPath)`；`statusForError` / `codeForError`（manual.ts:321/331）**只识别 daemon 自己的错误类**，未翻译的 SDK 原生 `ApiError` / `NetworkError` 会落成 500 / `SKYBRIDGE_SYNC_FAILED`。如果 `/sync/devices` 直接 catch + `fail(reply, statusForError(err), ...)`，401 会被错误码成 500 + 错误消息。

**Commit 1 必须做的两件事**：
1. **去掉 401 副作用** —— Phase 10 commit 3 会删 `clearSkybridgeAuth` 调用（manual.ts:166），意味着 `translateSkybridgeError` 失去 `configPath` 的用途。**commit 1 不动 401 副作用**（仍保留 `clearSkybridgeAuth` 调用以避免跨 commit 半成品状态），但**新增导出 `translateSkybridgeError`**（保留 `configPath` 参数）
2. **`/sync/devices` 路由调用 `translateSkybridgeError(err, cfgPath)` 翻译后再交给 `statusForError` / `codeForError`**

到 commit 3 删 401 副作用时，再单独把 `configPath` 参数从 `translateSkybridgeError` 签名中拿掉（同步改两个 caller：`/sync/devices` + `doRunManualSync`）。

`packages/daemon/src/routes/sync.ts` 路由：

```ts
app.get('/sync/devices', async (_req, reply) => {
  try {
    const session = ctx.skybridgeSession;
    if (!session) {
      throw new SkybridgeAuthRequiredError(
        'skybridge session not installed; 请在设置中登录',
      );
    }
    const devices = await session.realClient.listDevices();
    ok(reply, { devices });
  } catch (err) {
    const cfgPath = skybridgeConfigPath();
    const translated = translateSkybridgeError(err, cfgPath);
    // listDevices() 自身可能抛 SDK 401（token 在 server 端被撤销 / 过期）。
    // doRunManualSync catch 块在 manual.ts:258 invalidate 的是 sync 路径；
    // 本路由不经 doRunManualSync，必须自己 invalidate 内存 session，
    // 否则 stale ctx.skybridgeSession 会继续被后续 /sync/devices /
    // /sync/run 复用（直到 daemon 重启 / 用户重登）
    if (translated instanceof SkybridgeAuthRequiredError) {
      invalidateSkybridgeSession(ctx);
    }
    fail(reply, statusForError(translated), messageForError(translated), codeForError(translated));
  }
});
```

**关键约束**：
- 不调 `ensureSkybridgeSession()` —— 防御性，避免触发不存在的"lazy 路径"（Phase 10 commit 3 后该路径已死）。直接读 `ctx.skybridgeSession`
- 失败必须先经 `translateSkybridgeError` 翻译，再交错误码 helper
- 翻译后若为 `SkybridgeAuthRequiredError`（即 SDK 抛 401 / 本路由自抛 `not installed`）则调用 `invalidateSkybridgeSession(ctx)`，与 `doRunManualSync` 行为对齐
- Wire shape 直接用 SDK 的 camelCase `ApiDevice`，**不在 daemon 转换**，留 main IPC 层处理（main 是 GUI 项目内的代码，转换更顺手）

### 3.3 shared 类型新增

`packages/gui/src/shared/sync-devices-types.ts`（新文件）：

```ts
import type { SyncIpcReply } from './sync-status-types.js';

export interface SyncDeviceEntry {
  id: string;
  name: string;
  platform: string | null;
  app_version: string | null;
  client_version: string | null;
  created_at: number;
  last_seen_at: number;
  is_current: boolean;
}

export interface SyncDevicesReply {
  devices: SyncDeviceEntry[];
}

export type SyncDevicesIpcReply = SyncIpcReply<SyncDevicesReply>;
```

字段命名沿用现有 `SyncStatusResult` 风格（snake_case），用 GUI 内部转换层把 SDK `appVersion` → `app_version`，保持 renderer 一致 shape。

### 3.4 main IPC handler

`packages/gui/src/main/sync-ipc.ts` 加 `sync:devices` handler：

```ts
ipcMain.handle('sync:devices', async () => safe<SyncDevicesReply>(buildDevices));

async function buildDevices(): Promise<SyncDevicesReply> {
  // 当前 device id 来自 sync:status 同一份 toml 探针；为了避免两个 IPC
  // 之间 race，handler 自己 extract 一次
  const cfg = safeReadConfig();
  const currentDeviceId = cfg?.device?.id ?? null;

  let res: Response;
  try {
    res = await fetch(`${getDaemonUrl()}/sync/devices`);
  } catch (err) {
    // Node 内置 fetch 失败抛 TypeError / 普通 Error（非 SDK NetworkError），
    // safe<T>() 的 NetworkError 分支只识别 SDK 类。这里显式转换，确保
    // syncErrorMessage 路径走 'network' kind（"无法连接到本地后台服务"）
    throw new NetworkError(
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err : undefined,
    );
  }
  if (!res.ok) {
    // daemon 返 401 / 503 / 500：envelope.message 已是中文（daemon
    // messageForError 经 translateSkybridgeError 翻译）；直接抛 Error 让
    // safe<T>() 的 unknown 分支用 `detail` 渲染中文
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `daemon /sync/devices returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: { devices: ApiDevice[] } };
  const apiDevices = body.data?.devices ?? [];
  return {
    devices: apiDevices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      app_version: d.appVersion,
      client_version: d.clientVersion,
      created_at: d.createdAt,
      last_seen_at: d.lastSeenAt,
      is_current: d.id === currentDeviceId,
    })),
  };
}
```

**注意**：
- `ApiDevice` 直接从 `@orpheus-aviary/skybridge-client` import（sync-auth.ts 已 import 同一个 SDK，main 进程对该 package 可见）
- `NetworkError` 也从 SDK import；显式构造避免裸 `fetch` 失败时落到 unknown 分支显示「同步出错: fetch failed」

### 3.5 preload bridge

`packages/gui/src/preload/index.ts` `sync: { ... }` 内加：

```ts
/**
 * List devices under the current skybridge user. Read-only —
 * Phase 10 has no revoke surface (server endpoint absent in SDK ^0.1.3).
 */
devices: (): Promise<SyncIpcReply<SyncDevicesReply>> => ipcRenderer.invoke('sync:devices'),
```

### 3.6 daemon plaintext bootstrap 退役（精确 diff）

**`packages/daemon/src/sync/session.ts`**

- 第 41 行删 `requireAuth` import（保留其他）
- 第 43 行删 `writeSkybridgeConfig` import
- 第 188-255 `ensureSkybridgeSession` 简化为：

```ts
export async function ensureSkybridgeSession(ctx: AppContext): Promise<SkybridgeSession> {
  const cached = ctx.skybridgeSession;
  if (!cached) {
    throw new SkybridgeAuthRequiredError(
      'skybridge session not installed; GUI must POST /sync/session first',
    );
  }
  return cached;
}
```

`SkybridgeAuthRequiredError` 已经从 `@owl/core` 导入（第 31 行）。Lazy registerDevice / ensureWorkspace / writeSkybridgeConfig 全部移除。

**`persistSkybridgeIds` 不需要新增调用** —— `installSkybridgeSession` 在 session.ts:320 已经调用过（POST /sync/session 注入会话时跑）。Commit 3 仅删除 `ensureSkybridgeSession` 第 243 行的重复调用；行为不变（local_metadata 写入 + 一次性 backfill 仍在 install 时跑），idempotent 保障。

**`packages/daemon/src/sync/manual.ts`**

- 第 33 行删 `clearSkybridgeAuth` import
- 第 146 行 `translateSkybridgeError(err, configPath)` 改签名为 `translateSkybridgeError(err)` —— 401 副作用消失后 `configPath` 参数不再使用。同步改两个 caller：
  - `doRunManualSync` manual.ts:263 → `translateSkybridgeError(err)`
  - `/sync/devices` 路由（§3.2 commit 1 引入时仍带 `cfgPath` 占位）→ `translateSkybridgeError(err)`
- 第 162-171 `translateSkybridgeError` 的 401 分支：

```ts
// 退役前
if (err.status === 401) {
  try { clearSkybridgeAuth(configPath); } catch { /* ... */ }
  return new SkybridgeAuthRequiredError('skybridge token rejected (401); 请在设置中重新登录');
}

// 退役后
if (err.status === 401) {
  // toml 由 GUI main 拥有；daemon 只把 in-memory session invalidate
  // (已由 doRunManualSync catch 块 manual.ts:258 完成)；Settings 重新
  // 登录走 POST /sync/session
  return new SkybridgeAuthRequiredError(
    'skybridge token rejected (401); 请在设置中重新登录',
  );
}
```

**`invalidateSkybridgeSession` 已就位** —— `doRunManualSync` catch 块（manual.ts:258-262）已在 401 / `SkybridgeAuthRequiredError` 上调用 `invalidateSkybridgeSession(ctx)`。Phase 10 不需新增 invalidate 调用。

**`@owl/core` exports**：本 phase 不动（`writeSkybridgeConfig` / `clearSkybridgeAuth` / `requireAuth` 仍可被 GUI main 直接 import；GUI 实际只用 `readSkybridgeConfig` + atomic-write 自己 stringify，不调 helper）。

### 3.7 bash 守卫 `daemon-no-toml-write`

新建 `scripts/check-daemon-no-toml-write.sh`：

```bash
#!/usr/bin/env bash
# Phase 10 守卫：daemon source MUST NOT call writeSkybridgeConfig /
# clearSkybridgeAuth. GUI main is the sole toml writer (Phase 7 keychain
# path); daemon plaintext bootstrap was retired in Phase 10.
#
# 白名单：仅允许 *.d.ts (类型) 和 *.test.ts / *.e2e.ts 文件
set -euo pipefail
cd "$(dirname "$0")/.."

hits=$(rg -n '\b(writeSkybridgeConfig|clearSkybridgeAuth)\s*\(' \
  packages/daemon/src \
  --type-add 'ts:*.ts' --type ts \
  --glob '!**/*.test.ts' \
  --glob '!**/*.e2e.ts' \
  --glob '!**/*.d.ts' \
  2>/dev/null || true)

if [[ -n "$hits" ]]; then
  echo "❌ daemon source calls writeSkybridgeConfig / clearSkybridgeAuth — Phase 10 retired daemon's plaintext bootstrap." >&2
  echo "$hits" >&2
  exit 1
fi
echo "✓ daemon-no-toml-write"
```

`justfile` `check` 子任务从 7 → 8（追加 `cargo run --bin check-daemon-no-toml-write` 不对，是 bash —— 改 `bash scripts/check-daemon-no-toml-write.sh`）。

实际 just check 是 shell 调用，参考现有 `daemon-no-electron-storage` / `no-prod-env-token` / `session-body-not-logged` 三个守卫的注册方式（约 justfile 现有 `check:` recipe）—— 看 justfile 现状对齐。

## 4. UX —— SyncSection 子卡片

```
┌─ 同步 ────────────────────────────────────┐
│  通过 skybridge 在多设备间同步笔记...       │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ 账号        foo@bar.com               │  │
│  │ 工作区      owl/default               │  │
│  │ 当前设备    MyLaptop (owl)            │  │
│  │                          [退出登录]    │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ ▶ 管理我的设备                        │  │  ← collapsed by default
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘

展开后：

│  ┌──────────────────────────────────────┐  │
│  │ ▼ 管理我的设备 (3)                    │  │
│  ├──────────────────────────────────────┤  │
│  │ ● MyLaptop (owl)               [当前] │  │  ← is_current 高亮
│  │   macOS · owl 0.4.2 · 创建 5-25       │  │
│  │   上次活跃 1 分钟前                    │  │
│  │ ○ OldMac (owl)                        │  │
│  │   macOS · owl 0.4.0 · 创建 4-12       │  │
│  │   上次活跃 3 天前                      │  │
│  │ ○ WorkPC (owl)                        │  │
│  │   windows · owl 0.4.1 · 创建 5-01     │  │
│  │   上次活跃 8 天前                      │  │
│  └──────────────────────────────────────┘  │
```

**UX 决策（锁定，便于测试断言）**：
- collapsed by default —— 大多数用户用单设备，避免默认 fetch
- **首次展开触发 `sync.devices()` IPC；后续展开复用组件 state 缓存**（不再 fetch）。**显式「刷新」按钮**（展开 header 右侧 icon）是唯一的 re-fetch 触发。折叠 → 展开循环不会重打 daemon
- 当前设备用绿色圆点 + `[当前]` chip，其他设备灰色圆点
- 时间用 `Intl.RelativeTimeFormat('zh-CN')`（owl 内已用）
- platform / app_version / client_version 任一为 null 时显示「未知」或省略行
- empty 状态（只有自己，0 其他设备）：仍展开渲染单行
- error 状态：渲染错误提示 + 「重试」按钮（按重试 = 显式 fetch；与 header 刷新等价）
- loading 状态：替换 list body 为 spinner + 「加载设备列表…」

只读，**Phase 10 不放任何按钮触发危险动作**。

## 5. Phase 10 不变量编号续

50. **`ensureSkybridgeSession` 不读 toml** —— 仅返回 `ctx.skybridgeSession`，不存在抛 `SkybridgeAuthRequiredError`。Phase 6 起会话只通过 `POST /sync/session` 安装；Phase 10 起 daemon 没有 fallback 路径
51. **daemon source 不写 toml** —— `writeSkybridgeConfig` / `clearSkybridgeAuth` 在 `packages/daemon/src/**/*.ts`（非 test / 非 e2e / 非 d.ts）中全部禁止；bash 守卫 `daemon-no-toml-write` 拦截
52. **`persistSkybridgeIds` 由 `installSkybridgeSession` 拥有** —— `installSkybridgeSession`（session.ts:320）在 POST /sync/session 注入时执行 `local_metadata` 写入 + 一次性 backfill。`ensureSkybridgeSession` 退役 lazy 路径后不再重复调用。Idempotent
53. **`/sync/devices` 路由不触发 lazy bootstrap** —— 直接读 `ctx.skybridgeSession`；未注入时抛 `SkybridgeAuthRequiredError` → `translateSkybridgeError` → 401 + `SKYBRIDGE_AUTH_REQUIRED`，不静默给空数组。SDK 原生 ApiError / NetworkError **必须**先经 `translateSkybridgeError` 翻译再交错误码 helper
54. **设备列表 `is_current` 由 main IPC 计算** —— 不依赖 daemon 返回，由 main 读 toml `[device].id` + SDK 返回的设备 id 对比；toml device.id 缺失则全部 false，UI 兜底渲染「无当前设备识别」字样

## 6. 测试矩阵

### 6.1 单测增量

| 文件 | 新增 case |
|---|---|
| `packages/daemon/src/sync/sync.test.ts` | `GET /sync/devices` happy path 返回 devices；未注入 session 时 401 + `SKYBRIDGE_AUTH_REQUIRED`；fake realClient.listDevices() 抛 SDK ApiError(401) → reply 401 + `SKYBRIDGE_AUTH_REQUIRED`（而非裸 500），且 `ctx.skybridgeSession` 被置 null（断言 invalidate 命中） |
| `packages/daemon/src/sync/session.ensure.test.ts`（新文件） | `ensureSkybridgeSession(ctx)` 已注入时返回 cached；`ctx.skybridgeSession === null` 时抛 `SkybridgeAuthRequiredError`；toml 文件**不存在**的情况下 ensure 仍直接抛（不读盘）—— 用 `skybridgeConfigPath()` 指向 tmp 空目录验证 |
| `packages/daemon/src/sync/session.install.test.ts` | 现有 case 不变（`installSkybridgeSession` 已经在 session.ts:320 调 `persistSkybridgeIds`，commit 3 不改 install 行为）；新增一条断言 install 后 `ctx.skybridgeSession !== null` 即可 ensure 命中 |
| `packages/daemon/src/sync/manual.translate.test.ts`（新文件） | `translateSkybridgeError` 单测：fake SDK ApiError(401) → `SkybridgeAuthRequiredError`；ApiError(500) → `SkybridgeApiError(500)`；NetworkError → `SkybridgeServerUnreachableError`；不读 / 不写任何 toml（断言 `clearSkybridgeAuth` 已不在 import 列表 —— 仅靠 §3.7 守卫 + grep daemon source 兜底） |
| `packages/gui/src/main/sync-ipc.test.ts` | `sync:devices` happy path（mock fetch 返 wire devices）；daemon 401 envelope 渲染中文；fetch reject → 显式 `NetworkError` 包装 → reply.ok=false + 「网络」中文；`is_current` 计算（toml 有 device.id / 无） |
| `packages/gui/src/renderer/.../SyncSection.test.tsx` | 子卡片 collapsed by default；首次展开触发 IPC；二次折叠 → 展开**不**触发 IPC（断言 mock 调用次数 = 1）；点刷新触发 IPC（调用次数 = 2）；渲染 device 行；`is_current` 渲染当前 chip；loading / error / empty 状态 |
| `packages/gui/src/preload/args.test.ts` | （若覆盖 preload bridge）`owlAPI.sync.devices` 存在且类型对 |

### 6.2 E2E

`SKYBRIDGE_E2E=1` 16/16 不变（结构未动）。**新增 1 个 e2e**：`packages/daemon/src/sync/skybridge-sdk-smoke.skybridge.e2e.ts` 已有 `listDevices()` smoke（第 126 行）；本 phase 不需要再加，但确认它仍绿。

### 6.3 基线目标

- 单元 **1062 → ~1085**（+~23：daemon 5 + main IPC 6 + SyncSection 8 + 杂 ~4）
- `just check` **7 → 8** 子任务（追加 `daemon-no-toml-write`）
- E2E **16/16** 保持

## 7. 切片（3 commits）

### Commit 1 — IPC plumbing（约 9 个文件）
- `packages/gui/src/shared/sync-devices-types.ts`（新）
- `packages/daemon/src/sync/session.ts`：`RealSkybridgeClient` 结构类型加 `listDevices()`（§3.1）
- `packages/daemon/src/sync/manual.ts`：**export** 现有 `translateSkybridgeError`（保留 `configPath` 参数；commit 3 再改签名）
- `packages/daemon/src/routes/sync.ts`：加 `GET /sync/devices`，catch 中先 `translateSkybridgeError` 再交错误码 helper（§3.2）
- `packages/daemon/src/sync/sync.test.ts`：+ 3 case（happy / 未注入 / SDK 401 翻译）
- `packages/gui/src/main/sync-ipc.ts`：加 `sync:devices` handler + `buildDevices`；显式 `NetworkError` 包装裸 fetch reject
- `packages/gui/src/main/sync-ipc.test.ts`：+ 5 case
- `packages/gui/src/preload/index.ts`：加 `sync.devices`
- 类型 d.ts (`packages/gui/src/renderer/src/types/owl-api.d.ts`)：补 `devices: () => ...`
- 锁定不变量 50 / 53 / 54（仅 IPC 层；plaintext bootstrap 退役留 commit 3）

Scope: `feat(skybridge): wire /sync/devices IPC + listDevices SDK bridge`

### Commit 2 — SyncSection 子卡片 GUI（约 3 个文件）
- `packages/gui/src/renderer/src/components/settings/SyncSection.tsx`：加 collapsible 子卡片 + state + 渲染
- `packages/gui/src/renderer/src/components/settings/SyncSection.test.tsx`：+ 8 case
- 视情况复用 / 新建 `Collapsible` 子组件（shadcn-ui 已有；查 package）
- 锁定不变量 54（is_current 由 main 计算，GUI 直接消费）

Scope: `feat(skybridge): Settings 设备列表子卡片（只读）`

### Commit 3 — daemon plaintext bootstrap 退役 + 守卫（约 7 个文件）
- `packages/daemon/src/sync/session.ts`：删 lazy 路径、`requireAuth` / `writeSkybridgeConfig` import；**不**新增 `persistSkybridgeIds` 调用（install 路径已有，commit 3 删除 ensure 路径的重复调用）
- `packages/daemon/src/sync/session.ensure.test.ts`（新文件）
- `packages/daemon/src/sync/manual.ts`：删 `clearSkybridgeAuth` import + 401 副作用；`translateSkybridgeError` 签名改为 `(err)` 去掉 `configPath`，同步改 `doRunManualSync` + `/sync/devices` 两个 caller
- `packages/daemon/src/sync/manual.translate.test.ts`（新文件，如已有 `manual.*.test.ts` 则合并）
- `scripts/check-daemon-no-toml-write.sh`（新）
- `justfile` `check`：7 → 8 子任务
- 现有 `packages/daemon/src/sync/sync.test.ts` 中依赖 daemon 自举 plaintext toml 的 case（`POST /sync/run` 期望 lazy bootstrap）改走 `POST /sync/session` 注入或直接 setup `ctx.skybridgeSession`
- 锁定不变量 50 / 51 / 52

Scope: `refactor(skybridge): daemon plaintext bootstrap 退役 + daemon-no-toml-write 守卫`

每 commit 完成后 `just check` + `just test` 通过；E2E 在 commit 1 + commit 3 后各跑一次。

## 8. 手动验收清单

Phase 10 完成后用户手动验：

| Step | 操作 | 预期 |
|---|---|---|
| 1 | `just dev-daemon` + `just dev` 冷启动；事先已登录态（toml 有 encrypted_token） | 登录态恢复正常，SyncStatusBar 灰点已同步；Settings 同步 tab 加载完成 |
| 2 | Settings → 同步 tab，看到「管理我的设备」collapsed 标题 | 默认折叠，标题右侧无设备数 |
| 3 | 点击展开 | 触发 IPC；先 loading；返回后渲染列表；当前设备绿点 + `[当前]` chip |
| 4 | 折叠再展开 | **不**重新 fetch，直接展示缓存（首次展开的快照）；devtools network 面板看不到新请求 |
| 5 | 刷新按钮 | 强制 re-fetch |
| 6 | 杀 daemon（手动 kill）然后展开 | error 状态 + 中文错误 + 「重试」按钮；点重试在 daemon 重启后恢复 |
| 7 | logout 状态下进入 Settings | 不再渲染子卡片（auth view 才显示） |
| 8 | （回归）冷启动 + 旧 toml 仅含 plaintext `[auth].token`（手动篡改还原） | daemon 启动后 sync 触发 → 报 `SKYBRIDGE_AUTH_REQUIRED`；不再 lazy bootstrap；GUI 提示重新登录；登录后 toml 改写为 encrypted_token |
| 9 | grep daemon.log | 无 `writeSkybridgeConfig` / `clearSkybridgeAuth` 调用痕迹 |

## 9. 风险 / 已知坑

- **Step 8 的回归路径**：旧 plaintext toml 用户重启 daemon → 第一次 sync 会失败。如果用户长期没打开 GUI（只用 CLI），他不会看到「请重新登录」提示。CLI `sync run` 返回 `SKYBRIDGE_AUTH_REQUIRED` 即可，**符合 Phase 16 计划**（CLI sync login 改文案指 GUI）
- **`SyncSection.test.tsx` 引入 collapsible** 可能命中 react-router-like 嵌套渲染问题（Phase 8+9 [[infra_gotchas]] 有 react-router vitest 配置 4 件套）。新组件若 shadcn-ui `Collapsible` 内部用 radix，vitest 配置看是否需要加 inline。预计无需，但实施时观察
- **`buildDevices` 在 main IPC 里 fetch daemon** —— main 已用 fetch 调 `/sync/status`（sync-ipc.ts:54），模式一致。**与 status handler 不同的是**：本 handler 用显式 `try/catch + NetworkError` 包装裸 fetch reject（status handler 把 fetch 失败吞为 `snapshot: null` 兜底，因为身份字段仍能从 toml 渲染；devices handler 没有 toml fallback，必须暴露 error 让 UI 渲染「重试」按钮）
- **`SyncIpcReply<SyncDevicesReply>` 的零结果**：daemon 返空数组 vs daemon 不在线 vs daemon 拒。三种状态在 UI 上区分（empty vs error vs auth-fail）—— main 把 daemon 401 envelope.message 中文化（已由 daemon `translateSkybridgeError` 翻译）；网络错误 → 显式 `NetworkError` → `syncErrorMessage({ kind: 'network' })`；空数组 → 正常渲染 0 行（理论上至少有当前设备）
- **`translateSkybridgeError` 签名跨 commit 演化**：commit 1 export 时保留 `(err, configPath)`；commit 3 改 `(err)`。两 commit 之间的中间态可编译可测，避免半成品 break main

## 10. 不在 Phase 10（汇总）

- 撤销其他设备 token（端点缺失，Phase 10.5+）
- 重复 device row 防御（UX 选型重，推后）
- CLI `owl sync login` 文案改写（Phase 16）
- core `clearSkybridgeAuth` / `writeSkybridgeConfig` / `requireAuth` exports 删除（Phase 11+）
- watchdog SSE idle 检测（Phase 11）
- 阿里云 server / 24h soak（Phase 13-15）
