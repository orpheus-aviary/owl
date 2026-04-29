# P3.2-b — GUI MigrationDialog 设计

日期：2026-04-30
上级计划：`docs/plans/2026-04-20-p3-plan.md` §5.5
前置：`docs/plans/2026-04-29-p3-2-a-migration-runner-design.md`（P3.2-a migration runner，commit `38e9243`，245/245 测试）
交付目标：GUI 在启动时检测老库 / 未来库 → 弹 MigrationDialog 让用户确认后驱动 `migrateLegacyDb` → 迁移完成后无感切到主 UI；把 P3.2-a 里 sealed 的 `onProgress` hook 升级为 4 phase 实时事件。

---

## 1. 范围 & 非范围

### 1.1 本提交范围

- `packages/core/src/db/migrate.ts`：把 `MigrateOptions.onProgress` 从 sealed 升级为真实 emit（`backup` → `copy` → `fts-rebuild` → `swap` 4 phase 有序），每次 emit 后 `await setImmediate` 让出一帧；emit 用 try/catch 吞错
- `packages/core/src/db/migrate.test.ts`：+ T16（4 phase 有序 emit）、T17（已迁移库不 emit）
- `packages/core/src/db/probe.ts`：新增，`probeStartupState(dbPath)` 只读探测 `user_version` + schema 非空，返回 `StartupProbeResult`（供 GUI main 复用，避免 @owl/gui 直接 import better-sqlite3）
- `packages/core/src/db/probe.test.ts`：新增，4 场景（文件不存在 / v=LATEST / v=0 空 / v=0 非空 / v>LATEST）
- `packages/core/src/index.ts` barrel：re-export `probeStartupState` + `StartupProbeResult` 类型
- `packages/gui/src/main/migration-precheck.ts`：新增，纯映射函数 `runMigrationPrecheck(dbPath)` 调 `probeStartupState` 映射到 `StartupMode` 三态；不 import better-sqlite3
- `packages/gui/src/main/migration-precheck.test.ts`：5 场景（mock probeStartupState 测映射逻辑）
- `packages/gui/src/main/migration-ipc.ts`：新增，`registerMigrationIpc(win, dbPath)` 提供 `migration:start`（invoke）/ `migration:progress`（send）/ `migration:done` / `migration:quit` / `migration:daemon-failed`（send）五个 IPC 端点 + `mapMigrationError` 5 种 error class → `{reason, message}` 映射
- `packages/gui/src/main/migration-ipc.test.ts`：新增，7 场景覆盖 `mapMigrationError` 纯函数映射
- `packages/gui/src/main/daemon.ts`：`ensureDaemonRunning` 返回类型改 `Promise<void>` → `Promise<boolean>`（内部已有 `daemonStartedByGui = ready`，抽出来返回即可）
- `packages/gui/src/main/index.ts`：改造 `whenReady` → precheck 分流；`createWindow` 接 `{startupMode}` 可选参数；传 `webPreferences.additionalArguments: ['--startup-mode=…']` 给 preload
- `packages/gui/src/preload/index.ts`：扩展 `owlAPI`，加 `startupMode` 同步字段 + `migration.*` 方法
- `packages/gui/src/renderer/src/types/owl-api.d.ts`：新增，声明 `window.owlAPI` 完整类型（替换 `api.ts:67` 的局部声明）
- `packages/gui/src/renderer/src/pages/MigrationDialog/`：新目录，4 屏状态机（confirm / running / success / error）+ `errorCopy.ts` 文案表；success 屏支持 daemon-failed inline banner
- `packages/gui/src/renderer/src/App.tsx`：顶层按 `window.owlAPI.startupMode.mode` 分流；原 App body 抽成 `MainApp` 保留现有 HashRouter
- `packages/gui/vitest.config.ts`：改为 `projects` 配置，分 `renderer`（jsdom）与 `main`（node）两个项目
- `packages/gui/package.json`：devDeps 加 `jsdom`、`@testing-library/react`、`@testing-library/user-event`
- `MigrationDialog.test.tsx`：7 场景（M1-M7，含 daemon-failed）
- 手动真库 smoke 清单（9 条）

### 1.2 非范围（后续独立提交 / 阶段）

| 项 | 归属 |
|---|---|
| `owl migrate` 子命令 | P3.2-c |
| `owl doctor --recover`（Cmd+Q 中途强杀导致 `dbPath` 缺失 + `.old-pre-v0.3` 残留的残局恢复） | post-P3 / 0.4.0+（§10 主计划已列） |
| SSE `/events` reverse channel | P3.2-d |
| 迁移进度百分比（pct） | 签名里直接去掉 pct 参数，0.3.0 不传；未来真要加时再扩 |
| 多平台构建（Windows / Linux）下 preload additionalArguments 的兼容验证 | 0.2.1 / 0.3.0 的 CI matrix 阶段 |

### 1.3 关键不变量

1. GUI 启动时，在 `ensureDaemonRunning` **之前**决定 startup mode；老库 / 未来库场景下 daemon **永不 spawn**，由 MigrationDialog 先把控
2. `probeStartupState` 只读打开 db（`readonly: true`），不触发 `createDatabase()` 的任何写路径；新库（dbPath 不存在）直接 `mode: 'normal'`，由 daemon 启动时走 `v=0+空` 建表
3. 迁移成功 → `ensureDaemonRunning`（返回 boolean 成功指示） → 成功则 `win.destroy()` + `createWindow()` **重建**窗口（**不是 loadURL/loadFile**；因为 `webPreferences.additionalArguments` 是窗口构造级选项，单纯 reload 会让 preload 在同一个 renderer 进程里再次解析旧 argv 拿到 `migrate-required`，死循环）。新窗口无 startupMode 参数 → argv 干净 → preload 解出 `{mode:'normal'}` → 挂主 UI
4. 迁移成功但 `ensureDaemonRunning` 失败 → `migration:daemon-failed` 事件推给 renderer，MigrationDialog 在 success 屏下方加红色 banner + 「再试一次」/「退出」按钮；**不 destroy 窗口**（防止用户没地方看错误）
5. `onProgress` 每次 emit 被 try/catch 包住，renderer 侧 IPC 异常**不中断**迁移流程
6. 5 种 error class 全部落到同一个 `error` 屏幕，仅文案与按钮（重试 / 退出）按 reason 差异化
7. `@owl/gui` **不直接 import better-sqlite3**；所有 native DB 原语走 `@owl/core` export（probe、migrate、createDatabase 等）
8. 本阶段新增测试 +26（core +7、gui main +12、gui renderer +7），总计 271/271（P3.2-a 后 245 → P3.2-b 271）

---

## 2. 现状速览

### 2.1 Electron main 进程（`packages/gui/src/main/index.ts:68-80`）

现状：`app.whenReady` 里无条件 `ensureDaemonRunning` + `createWindow` + `app.on('activate', ...)`。需要插入 precheck 分流。

### 2.2 preload（`packages/gui/src/preload/index.ts`）

只通过 `contextBridge.exposeInMainWorld('owlAPI', { daemonUrl })` 暴露一个常量。需要扩展 `startupMode` + `migration` namespace。

### 2.3 renderer 入口（`main.tsx` → `App.tsx`）

单 bundle，`App.tsx:178-327` 用 `react-router-dom@7` 的 `HashRouter` 包裹整个 body（7 页 Routes + 侧栏 + DndContext）。分流点加在 `App.tsx` 顶层，在 `HashRouter` 之外；把原 body 整体搬到 `MainApp.tsx`。MigrationDialog 本身不挂 Router。

### 2.4 migrate.ts `onProgress` 现状（`packages/core/src/db/migrate.ts:137-145`）

签名带 `pct?: number` 占位但从未 emit。`MigrateOptions` 在实现里形参写成 `_options`（带下划线），表示未使用。本阶段要真正 emit 并去掉 pct 占位。注释里 sealed 的表述要改掉。

### 2.5 P3.2-a 的 error 类型

barrel 已 re-export：`MigrationRequiredError`、`IncompatibleDbError`、`MigrationBusyError`（5 种 reason）、`SourceDbCorruptionError`、`SchemaMismatchError`。`mapMigrationError` 在 main 端对它们做 `instanceof` 分派。

---

## 3. 架构

### 3.1 文件变更

```
packages/core/src/
├── db/
│   ├── migrate.ts                 [改]  onProgress 真正 emit（4 phase + setImmediate yield + try/catch）
│   ├── migrate.test.ts            [改]  + T16 / T17
│   ├── probe.ts                   [新]  probeStartupState 只读探测（只依赖 core 内已有 better-sqlite3）
│   └── probe.test.ts              [新]  5 场景（not-found / v=1 / v=0+空 / v=0+非空 / v=99）
└── index.ts                       [改]  barrel re-export probeStartupState + StartupProbeResult

packages/gui/src/main/
├── index.ts                       [改]  whenReady precheck 分流；从 window.ts import createWindow
├── window.ts                      [新]  createWindow 迁出 + 导出（含尺寸读 config / close / loadURL|loadFile）
├── daemon.ts                      [改]  ensureDaemonRunning 返回 Promise<boolean>
├── migration-precheck.ts          [新]  runMigrationPrecheck 纯映射（调 probeStartupState）+ StartupMode 类型
├── migration-precheck.test.ts     [新]  5 场景（mock probeStartupState 测映射）
├── migration-ipc.ts               [新]  registerMigrationIpc（依赖 createWindow 从 window.ts import）+ mapMigrationError
└── migration-ipc.test.ts          [新]  7 场景（mapMigrationError 5 error class + Error + 非 Error）

packages/gui/src/preload/
└── index.ts                       [改]  解析 --startup-mode= argv + 暴露 startupMode / migration.{start,onProgress,onDaemonFailed,done,quit}

packages/gui/src/renderer/src/
├── App.tsx                        [改]  顶层按 startupMode.mode 分流；原 body 抽成 MainApp（保留 HashRouter）
├── MainApp.tsx                    [新]  原 App body（含 HashRouter）整体搬过来
├── types/owl-api.d.ts             [新]  window.owlAPI 完整类型声明（含 onDaemonFailed）
├── test-setup.ts                  [新]  renderer vitest setupFiles：默认 mock window.owlAPI（含 onDaemonFailed）
└── pages/MigrationDialog/
    ├── index.tsx                  [新]  4 屏状态机容器（success 屏含 daemon-failed banner）
    ├── ConfirmScreen.tsx          [新]
    ├── RunningScreen.tsx          [新]
    ├── SuccessScreen.tsx          [新]  含 daemon-failed 分支
    ├── ErrorScreen.tsx            [新]
    ├── errorCopy.ts               [新]  reason → {title, body, hint, showRetry}
    └── MigrationDialog.test.tsx   [新]  M1-M7

packages/gui/src/renderer/src/lib/
└── api.ts                         [改]  删 line 67 局部 window.owlAPI 声明（让给 types/owl-api.d.ts）

packages/gui/
├── vitest.config.ts               [改]  改用 projects（renderer=jsdom / main=node）
└── package.json                   [改]  devDeps + jsdom / @testing-library/react / @testing-library/user-event
```

**`main/window.ts` 抽取理由**（解决 #2 循环依赖 / 不可访问）：

- 原方案 `migration-ipc.ts` 里 `createWindow()` 重建窗口，但当前 `createWindow` 是 `main/index.ts` 内部函数（line 10），`migration-ipc.ts` 无法 import
- 解决：把 `createWindow`（及其依赖的 config 读取、`ready-to-show` / `close` / `setWindowOpenHandler` / `loadURL|loadFile` 逻辑）整体搬到 `main/window.ts`，命名 export
- `main/index.ts` 和 `migration-ipc.ts` 都从 `window.ts` import，无循环

### 3.2 StartupMode 类型（GUI 侧契约）

```ts
// packages/gui/src/main/migration-precheck.ts
export type StartupMode =
  | { mode: 'normal' }
  | { mode: 'migrate-required'; dbPath: string }
  | { mode: 'incompatible'; dbPath: string; dbVersion: number; maxSupported: number };
```

preload 端从 `process.argv` 解析后用同款类型 cast，renderer 从 `window.owlAPI.startupMode` 读取。

### 3.3 `@owl/core` 的 `probeStartupState` + GUI 的 `runMigrationPrecheck`

**core 侧（只读探测）**：

```ts
// packages/core/src/db/probe.ts
import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { isSchemaEmpty } from './migrate.js';  // P3.2-a 已有内部函数

export type StartupProbeResult =
  | { kind: 'not-found' }
  | { kind: 'version'; version: number; schemaEmpty: boolean };

export function probeStartupState(dbPath: string): StartupProbeResult {
  if (!existsSync(dbPath)) return { kind: 'not-found' };
  const sqlite = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  try {
    const version = sqlite.pragma('user_version', { simple: true }) as number;
    const schemaEmpty = isSchemaEmpty(sqlite);
    return { kind: 'version', version, schemaEmpty };
  } finally {
    sqlite.close();
  }
}
```

**关键不变量**：
- `readonly: true` + `fileMustExist: true` → 不产生 `-wal` / `-shm`、不会 stamp user_version
- finally 里 close 保证锁释放 —— 后续 `migrateLegacyDb` 的 Layer 3 `locking_mode=EXCLUSIVE` 能正常获取
- `isSchemaEmpty` 保持 core 内部函数，无需 re-export

**GUI 侧（纯映射，不 import better-sqlite3）**：

```ts
// packages/gui/src/main/migration-precheck.ts
import { LATEST_KNOWN_VERSION, probeStartupState } from '@owl/core';

export function runMigrationPrecheck(dbPath: string): StartupMode {
  const probe = probeStartupState(dbPath);
  if (probe.kind === 'not-found') return { mode: 'normal' };
  if (probe.version > LATEST_KNOWN_VERSION) {
    return { mode: 'incompatible', dbPath, dbVersion: probe.version, maxSupported: LATEST_KNOWN_VERSION };
  }
  if (probe.version === 0 && !probe.schemaEmpty) {
    return { mode: 'migrate-required', dbPath };
  }
  return { mode: 'normal' };
}
```

分层好处：
- `probe.test.ts` 用真 sqlite 覆盖探测逻辑
- `migration-precheck.test.ts` 通过 `vi.mock('@owl/core', ...)` 测纯映射，不碰 native 绑定

### 3.4 `main/index.ts` 改造（伪代码）

```
app.whenReady().then(async () => {
  const precheck = runMigrationPrecheck(paths.dbPath());

  if (precheck.mode === 'normal') {
    await ensureDaemonRunning();
    createWindow();
  } else {
    createWindow({ startupMode: precheck });
    registerMigrationIpc(mainWindow!, paths.dbPath());
  }

  app.on('activate', () => {
    const existing = BrowserWindow.getAllWindows();
    if (existing.length > 0) existing[0].show();
    else createWindow();
  });
});
```

`createWindow({ startupMode }?)` 改动：

- 把 startupMode 通过 `webPreferences.additionalArguments: ['--startup-mode=' + JSON.stringify(...)]` 传给 preload
- 其余（窗口尺寸 / `ready-to-show` / `close` / `setWindowOpenHandler` / `loadURL|loadFile`）保持不变

`app.on('activate')` 分支里 `createWindow()` 无参 → 恢复常规模式（该路径只在 macOS dock 点图标时触发，此时早已是 normal mode）。

**before-quit 不变**：迁移途中 Cmd+Q → `stopDaemonGracefully()`；`daemonStartedByGui=false`（迁移期间 daemon 还没 spawn）→ 无副作用，直接 quit。残局恢复出 P3.2-b 范围（§1.2）。

### 3.5 preload 改造

```ts
import { contextBridge, ipcRenderer } from 'electron';

type StartupMode =
  | { mode: 'normal' }
  | { mode: 'migrate-required'; dbPath: string }
  | { mode: 'incompatible'; dbPath: string; dbVersion: number; maxSupported: number };

function parseStartupMode(): StartupMode {
  const prefix = '--startup-mode=';
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return { mode: 'normal' };
  try {
    return JSON.parse(arg.slice(prefix.length)) as StartupMode;
  } catch {
    return { mode: 'normal' };
  }
}

type Phase = 'backup' | 'copy' | 'fts-rebuild' | 'swap';

type MigrationStartResult =
  | { ok: true; backupPath: string; notesCount: number; elapsedMs: number }
  | { ok: false; reason: string; message: string };

contextBridge.exposeInMainWorld('owlAPI', {
  daemonUrl: 'http://127.0.0.1:47010',
  startupMode: parseStartupMode(),

  migration: {
    start: (): Promise<MigrationStartResult> => ipcRenderer.invoke('migration:start'),
    onProgress: (cb: (phase: Phase) => void): (() => void) => {
      const listener = (_: unknown, phase: Phase) => cb(phase);
      ipcRenderer.on('migration:progress', listener);
      return () => ipcRenderer.off('migration:progress', listener);
    },
    onDaemonFailed: (cb: () => void): (() => void) => {
      const listener = () => cb();
      ipcRenderer.on('migration:daemon-failed', listener);
      return () => ipcRenderer.off('migration:daemon-failed', listener);
    },
    done: (): void => ipcRenderer.send('migration:done'),
    quit: (): void => ipcRenderer.send('migration:quit'),
  },
});
```

### 3.6 migration-ipc.ts（伪代码）

`migration-ipc.ts` 从 `./window.js` import `createWindow`（§3.1 已抽出）：

```
import { createWindow } from './window.js';

ipcMain.handle('migration:start', async () => {
  try:
    result = await migrateLegacyDb(dbPath, {
      onProgress: (phase) => {
        if (!win.isDestroyed()) win.webContents.send('migration:progress', phase);
      },
    });
    return { ok: true, ...result };
  catch (err):
    return mapMigrationError(err);
});

ipcMain.on('migration:done', async () => {
  const daemonOk = await ensureDaemonRunning();
  if (!daemonOk) {
    if (!win.isDestroyed()) win.webContents.send('migration:daemon-failed');
    return;   // 窗口留着，UI 在 success 屏下方显示 banner + 重试/退出
  }
  // 成功：销毁旧窗口 + 重建。reload 方案不行，additionalArguments 留在 renderer argv
  // 里不会被刷掉，preload 重跑仍会解到 migrate-required，造成死循环
  win.destroy();
  createWindow();   // 无 startupMode 参数 → preload 拿到 {mode:'normal'} → 挂 MainApp
});

ipcMain.on('migration:quit', () => app.quit());
```

**`ensureDaemonRunning` 返回类型**（`packages/gui/src/main/daemon.ts`）：`Promise<void>` → `Promise<boolean>`。内部已有 `daemonStartedByGui = ready` 的 `ready` 就是返回值。既有调用方 `main/index.ts:69` 的 `await ensureDaemonRunning()` 忽略返回值，向后兼容。

**`mapMigrationError` 分派逻辑**（按 instanceof 链式判断）：

| err instanceof | reason | message 模板 |
|---|---|---|
| `MigrationBusyError` | `err.reason`（daemon_alive / lock_file / exclusive_lock_busy / checkpoint_busy / begin_busy） | `err.message` 原文 |
| `SourceDbCorruptionError` | `'source_db_corruption'` | `源库发现 {violations} 条孤立外键引用，无法自动修复。原库未变动。` |
| `SchemaMismatchError` | `'schema_mismatch'` | `源库 schema 不符合预期：{details}。原库未变动。` |
| `IncompatibleDbError` | `'incompatible'` | `数据库 v{dbVersion} 来自更新版本应用（本版本支持到 v{maxSupported}），请升级 Owl。` |
| 其它 `Error` | `'unknown'` | `err.message` |
| 非 Error | `'unknown'` | `String(err)` |

`mapMigrationError` 必须导出纯函数供 `migration-ipc.test.ts` 直接调用（不走 IPC，不依赖 BrowserWindow）。

### 3.7 migrate.ts `onProgress` 升级

**emit 位置**（对应 P3.2-a §3.4 的 Phase B/C 流程）：

| phase | 代码位置 | 说明 |
|---|---|---|
| `'backup'` | `wal_checkpoint(TRUNCATE)` 通过之后、`await old.backup(backupPath)` 之前 | Phase B 第一个耗时操作，>90% 时间花在这 |
| `'copy'` | `BEGIN` 语句之后、第一条 `INSERT INTO dest.*` 之前 | COPY 是 set-based，瞬完成，UI 需要看到切换 |
| `'fts-rebuild'` | FTS `delete-all` 语句之前 | 与 copy 分开以体感 |
| `'swap'` | `old.close()` 之后、第一个 `fs.renameSync` 之前 | Phase C 原子替换 |

**emit 封装**：

```ts
async function emit(opts: MigrateOptions | undefined, phase: Phase): Promise<void> {
  try { opts?.onProgress?.(phase); } catch { /* best-effort */ }
  await new Promise((r) => setImmediate(r));
}
```

`setImmediate` yield 让 IPC 消息真正刷到 renderer —— better-sqlite3 是同步的，不 yield 就会把 4 次 send 批量丢过去，renderer 收到时已经 swap 完了。

`alreadyMigrated` 分支不 emit：入口 peek `user_version === LATEST` 时直接返回 `{alreadyMigrated: true, ...}`，无任何 phase。

**注释更新**（把 sealed 改掉）：

```
Progress reporter for the GUI MigrationDialog. Emitted at 4 phase
boundaries in order: 'backup' -> 'copy' -> 'fts-rebuild' -> 'swap'.
Every call is best-effort; exceptions thrown by the callback are
swallowed so renderer-side IPC drops don't abort migration. The
runtime yields (setImmediate) after each emit to let the IPC queue
flush to the renderer (better-sqlite3 is synchronous).
```

pct 参数从签名里**去掉**（P3.2-a 留作占位但从未用；0.3.0 不传、未来真要加时再扩）。

---

## 4. MigrationDialog UI 设计

### 4.1 状态机（`pages/MigrationDialog/index.tsx`）

```ts
type Screen =
  | { kind: 'confirm' }
  | { kind: 'running'; currentPhase: Phase | null }
  | { kind: 'success'; result: MigrateResult; daemonFailed: boolean }
  | { kind: 'error'; reason: string; message: string };
```

**初始 state 决策**：

- `startupMode.mode === 'migrate-required'` → `{ kind: 'confirm' }`
- `startupMode.mode === 'incompatible'` → `{ kind: 'error', reason: 'incompatible', message: 构造文案 }`（跳过 confirm，只能退出）

**daemon-failed 流转**：success 屏 mount 时订阅 `migration.onDaemonFailed`，事件触发 → `setScreen(prev => prev.kind==='success' ? { ...prev, daemonFailed: true } : prev)`。SuccessScreen 根据 `daemonFailed` 决定是否渲染红色 banner + 「再试一次」/「退出」按钮。「再试一次」= 再次 `window.owlAPI.migration.done()`。

### 4.2 四屏

**ConfirmScreen**：

```
┌────────────────────────────────────────────┐
│ 数据库需要迁移                             │
│                                            │
│ 检测到 owl.db 使用旧格式（v0.2）。         │
│ 路径：{dbPath}                             │
│                                            │
│ 迁移将：                                   │
│ • 备份原库到 owl.db.v0.2-backup-<ts>      │
│ • 升级结构到 user_version=1                │
│   （FTS5 trigram、触发器、auto_delete_at） │
│ • 通常耗时 <1 秒                           │
│ • 失败时原库不会被破坏                     │
│                                            │
│            [ 退出 Owl ]  [ 开始迁移 ]     │
└────────────────────────────────────────────┘
```

**RunningScreen**：

```
┌────────────────────────────────────────────┐
│ 正在迁移数据库…                            │
│                                            │
│ ✓ 备份原库                                 │
│ ◐ 复制数据                                 │ ← 当前 phase 转圈
│ ○ 重建全文索引                             │
│ ○ 原子替换                                 │
└────────────────────────────────────────────┘
```

4 步列表，每步状态 `'pending' | 'active' | 'done'`。progress 回调按顺序触发，每次把收到的 phase 标 active + 前面所有 phase 标 done。迁移 Promise resolve（`ok: true`）时统一把 4 步都标 done 再切到 success（UI 看起来像 "swap 也完成了"）。

**SuccessScreen**：

```
┌────────────────────────────────────────────┐
│ ✓ 迁移成功                                 │
│                                            │
│ 已迁移 {notesCount} 条笔记，耗时 {elapsedMs} ms。
│                                            │
│ 备份已保存到：                             │
│ {backupPath}                               │
│                                            │
│                      [ 完成 ]              │
└────────────────────────────────────────────┘
```

点「完成」→ `window.owlAPI.migration.done()`。

daemon 启动失败 banner（只在 `screen.kind==='success' && screen.daemonFailed` 时渲染，插在「完成」按钮之上）：

```
⚠ 启动 daemon 失败。请查看 logs/daemon.log 后重试。
                      [ 退出 ]  [ 再试一次 ]
```

「再试一次」再次调 `window.owlAPI.migration.done()`。

**ErrorScreen**：`errorCopy.ts` 按 reason 查表：

| reason | title | body | showRetry |
|---|---|---|---|
| `daemon_alive` | 检测到 daemon 正在运行 | 另一个 Owl 进程在访问数据库。请完全关闭 Owl（菜单栏或 `kill <pid>`）后重试。 | true |
| `lock_file` | 发现残留锁文件 | `{dbPath}.migrate.lock` 存在。上次迁移可能异常退出，请手动删除后重试。 | true |
| `exclusive_lock_busy` | 数据库被占用 | 无法获取独占锁。其它进程可能持有连接，请关闭后重试。 | true |
| `checkpoint_busy` | WAL checkpoint 失败 | 同上。 | true |
| `begin_busy` | 事务启动失败 | 罕见错误，请关闭所有访问此库的进程后重试。 | true |
| `source_db_corruption` | 源库数据损坏 | 发现孤立外键引用，无法自动修复。原库未变动。请手动处理或联系维护者。 | false |
| `schema_mismatch` | 源库结构不匹配 | `{message}` | false |
| `incompatible` | 数据库版本过新 | `{message}` | false |
| `unknown` | 迁移失败 | `{message}` | true |

按钮布局：
- `showRetry=true` → `[ 退出 ]  [ 重试 ]`
- `showRetry=false` → `[ 退出 ]`（单按钮居右）

重试 → 回到 `{kind: 'running', currentPhase: null}` + 再次 invoke `migration:start`。

### 4.3 样式

- 沿用 Tailwind v4 + shadcn/ui
- 容器：`flex items-center justify-center min-h-screen bg-background`
- 卡片：`Card`（shadcn）或直接 `max-w-md rounded-lg border p-6 bg-card`
- 4 步列表：`lucide-react` 的 `Check` / `Loader2`（spin）/ `Circle` 图标
- dark theme 默认（沿用主题）
- **不用** `<Dialog>` 组件（那是 overlay），这是整个 window 的内容

### 4.4 App.tsx 顶层分流

现状 `packages/gui/src/renderer/src/App.tsx:178-327` 已用 `HashRouter`（`react-router-dom@7`）包整个 body。调整：

- 把现行 `App` 的**整个 body 不动**搬到新文件 `packages/gui/src/renderer/src/MainApp.tsx`，导出 `MainApp` —— 含 `HashRouter`、`DndContext`、侧栏、`Routes` 等
- `App.tsx` 瘦身成顶层分流：

```tsx
import { MainApp } from './MainApp';
import { MigrationDialog } from './pages/MigrationDialog';

export function App() {
  const startupMode = window.owlAPI.startupMode;
  if (startupMode.mode !== 'normal') {
    return <MigrationDialog startupMode={startupMode} />;   // 无 Router
  }
  return <MainApp />;
}
```

MigrationDialog 自身不进 Router，状态机在组件内管理。

---

## 5. 测试矩阵

### 5.1 core 新增（+7）

**`migrate.test.ts`（+2）**：

| # | 场景 | setup | 期望 |
|---|---|---|---|
| T16 | `onProgress` 4 phase 有序 emit | happy path rebuild（复用 T5 setup）+ `opts.onProgress = vi.fn()` | `spy.mock.calls.map(c => c[0])` 严格等于 `['backup','copy','fts-rebuild','swap']` |
| T17 | 已迁移库（v=LATEST）不 emit | T5 跑完后再次调用 `migrateLegacyDb` | `alreadyMigrated === true` + `spy` 零调用 |

**`probe.test.ts`（+5，5 个独立 it 块）**：

| # | 场景 | setup | 期望 |
|---|---|---|---|
| PR1 | 文件不存在 | 随机 tmp path | `{kind:'not-found'}` |
| PR2 | v=1 正常库 | `createDatabase({dbPath})` + close | `{kind:'version', version:1, schemaEmpty:false}` |
| PR3 | v=0 空库 | `new BetterSqlite3(path)` 建一个 db 但不执行 DDL + close | `{kind:'version', version:0, schemaEmpty:true}` |
| PR4 | v=0 非空 | 复用 migrate.test.ts 的 T3 setup（手工 DDL + 插 1 条笔记 + 不 set user_version） | `{kind:'version', version:0, schemaEmpty:false}` |
| PR5 | v=99 未来库 | `new BetterSqlite3(path)` + `PRAGMA user_version = 99` + close | `{kind:'version', version:99, schemaEmpty:true}` |

### 5.2 gui main 新增（+12）

**`migration-precheck.test.ts`（+5，mock probeStartupState 测纯映射）**：

```ts
vi.mock('@owl/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@owl/core')>();
  return { ...actual, probeStartupState: vi.fn() };
});
```

| # | mock 返回 | 期望 |
|---|---|---|
| P1 | `{kind:'not-found'}` | `{mode:'normal'}` |
| P2 | `{kind:'version', version:1, schemaEmpty:false}` | `{mode:'normal'}` |
| P3 | `{kind:'version', version:0, schemaEmpty:true}` | `{mode:'normal'}` |
| P4 | `{kind:'version', version:0, schemaEmpty:false}` | `{mode:'migrate-required', dbPath}` |
| P5 | `{kind:'version', version:99, schemaEmpty:false}` | `{mode:'incompatible', dbPath, dbVersion:99, maxSupported:1}` |

**`migration-ipc.test.ts`（+7，mapMigrationError 纯函数）**：

| # | 输入 | 期望 |
|---|---|---|
| E1 | `new MigrationBusyError('daemon_alive', 'msg')` | `{ok:false, reason:'daemon_alive', message:'msg'}` |
| E2 | `new MigrationBusyError('lock_file', 'msg')` | reason=`'lock_file'` |
| E3 | `new SourceDbCorruptionError(3)` | reason=`'source_db_corruption'`，message 含 `3` 与「原库未变动」 |
| E4 | `new SchemaMismatchError('/tmp/a', "missing col 'content'")` | reason=`'schema_mismatch'`，message 含 details |
| E5 | `new IncompatibleDbError('/tmp/a', 99)` | reason=`'incompatible'`，message 含 `v99` 与 `v1` |
| E6 | `new Error('boom')` | reason=`'unknown'`，message=`'boom'` |
| E7 | `"plain string"` | reason=`'unknown'`，message=`'plain string'` |

### 5.3 gui renderer 新增（+7）

**前置（新 devDeps）**：`jsdom`、`@testing-library/react`、`@testing-library/user-event`。`vitest` 4.x 已装。

**`vitest.config.ts` 拆 projects**：

```ts
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
  test: {
    projects: [
      {
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/src/**/*.test.{ts,tsx}'],
          setupFiles: ['src/renderer/src/test-setup.ts'],
        },
      },
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts'],
        },
      },
    ],
  },
});
```

`test-setup.ts` 提供默认 `window.owlAPI` mock（daemonUrl + 空 migration fns），各测试内 `beforeEach` 覆盖 `startupMode` / `migration.start` 等具体字段。

**`MigrationDialog.test.tsx`（+7，M1-M7）**：

| # | 场景 | 断言 |
|---|---|---|
| M1 | `startupMode={mode:'migrate-required', dbPath:'/tmp/a.db'}` | 渲染 ConfirmScreen；`/tmp/a.db` 文本可见；「开始迁移」button 在 DOM |
| M2 | 点「开始迁移」 | `migration.start` 被调用 1 次；UI 切到 running；4 步全 pending |
| M3 | fire 4 次 fake progress 事件 | 每次事件后对应 step 从 pending → active；前一个变 done |
| M4 | `start` resolve `{ok:true, notesCount:52, ...}` | 进 success 屏；`notesCount` 文本 52；点「完成」→ `migration.done` 被调用 |
| M5 | `start` resolve `{ok:false, reason:'daemon_alive', message:'...'}` | error 屏；daemon_alive 文案；「重试」button 可见；点它 → `migration.start` 第二次被调用 |
| M6 | `startupMode={mode:'incompatible', dbVersion:99, maxSupported:1}` | 直接 error 屏 reason=`'incompatible'`；无「重试」button；只有「退出」 |
| M7 | success 屏后 fire `migration:daemon-failed` 事件 | success 屏仍在；红色 banner + 「再试一次」/「退出」；点「再试一次」→ `migration.done` 再次被调用 |

### 5.4 手动真库 smoke（用户在 `~/orpheus-aviary-nest/owl/`）

**前置**（用户手动）：

```bash
# 独立保险：另存一份
cp ~/orpheus-aviary-nest/owl/owl.db ~/Desktop/owl-db-pre-p3-2-b.db

# 从 P3.2-a smoke 之后的 backup 还原 v=0 状态
cp ~/orpheus-aviary-nest/owl/owl.db.v0.2-backup-<ts> ~/orpheus-aviary-nest/owl/owl.db
rm -f ~/orpheus-aviary-nest/owl/owl.db-wal ~/orpheus-aviary-nest/owl/owl.db-shm
sqlite3 ~/orpheus-aviary-nest/owl/owl.db "PRAGMA user_version"   # → 0

# 确认无 daemon 跑
ps aux | grep -v grep | grep owl/daemon  # 空
```

**测试步骤**：

| # | 操作 | 预期 |
|---|---|---|
| S1 | `just dev` | 启动后 MigrationDialog confirm 页；dbPath 显示正确 |
| S2 | 点「开始迁移」 | running 页；4 步 backup → copy → fts-rebuild → swap 依次亮起（<1s） |
| S3 | success 页 | `notesCount=52`、backup 路径可复制 |
| S4 | 点「完成」 | 窗口重新加载，进入主 UI，52 条笔记可见，`#真实` 笔记可打开查看内容原样 |
| S5 | 重启 app | 直接进主 UI，无 dialog |
| S6 | 构造 `lock_file` error：再次还原 v=0 db，`touch owl.db.migrate.lock`，启动 | confirm → 开始 → error 页 reason=`lock_file` 文案清晰；点重试仍失败 |
| S7 | 手动删除 lock 后点重试 | 迁移通过、success、进主 UI |
| S8 | 构造 `incompatible`：`sqlite3 owl.db "PRAGMA user_version = 99"` 后启动 | 直接 error 页 reason=`incompatible`，无「重试」按钮，点「退出」app quit |
| S9 | 注：P3.2-a 已保证 daemon 拒启动 v=0 db，真实场景跑不出 `daemon_alive` error（daemon 自己 exit 1）；自动化测试 P1-P5 + M1-M6 已覆盖该分支，S9 不是必需步骤 | — |

**dev 模式兼容性**：`just dev` 默认由 Electron whenReady 拉起 daemon。precheck 在 ensureDaemonRunning 之前跑，不受影响。`just dev-daemon` 纯 daemon 场景不在本阶段 scope（P3.2-a 已处理 exit 1）。

---

## 6. 风险与决策

### 6.1 preload additionalArguments vs IPC 初始查询

**选 additionalArguments**：preload 进程与 main 进程隔离，无法直接共享变量。三种传法：

| 方案 | 缺点 |
|---|---|
| `additionalArguments` 传 JSON（选） | 字符串长度有平台上限，JSON 必须短（本设计 <200 字节 OK） |
| `ipcRenderer.sendSync('get-startup-mode')` | preload 需要在 IPC ready 之后才能问，renderer 首帧可能早于 IPC handler 注册 |
| 环境变量 `process.env.OWL_STARTUP_MODE` | 影响子进程（daemon），需要额外 delete 清理 |

`additionalArguments` 最干净：preload 模块 eval 时立刻可用，无异步、无 IPC 竞争。

### 6.2 better-sqlite3 在 main 进程 vs utilityProcess

**选 main 进程直接 import**：better-sqlite3 ABI 在 P3.1 已解决。引 utilityProcess 的成本（多一层 IPC、打包兼容测试、dev watch）不值得 —— 52 条笔记迁移 <1s，main 阻塞不成问题，且 backup 本身是 async（`await old.backup()`）已经让出了。

### 6.3 setImmediate vs setTimeout(0)

`setImmediate` 在 Node 事件循环里优先级明确（在当前 I/O phase 之后立即执行，早于 timer）。对 IPC 消息刷出更快、更可预期。macOS / Electron 17+ 实测 setImmediate OK。

### 6.4 renderer reload vs 销毁+重建 vs 同页条件渲染

**选 销毁+重建**：原方案 `loadURL/loadFile` 重装 renderer 有硬 bug —— `webPreferences.additionalArguments` 是 `BrowserWindow` 构造级选项，追加到 renderer `process.argv`；单纯 reload 不会改变 argv，preload 再次 eval 时依然解到 `--startup-mode=migrate-required`，会把用户弹回 Dialog 形成死循环。

| 方案 | 结论 |
|---|---|
| 同页条件渲染（renderer setState 切换） | ✗ MainApp 的 useEffect / store init 假设"daemon 已就绪"，并发性难控 |
| `loadURL/loadFile` 重装 | ✗ argv 污染导致 startupMode 永远停在老值 |
| `win.destroy()` + `createWindow()`（选） | ✓ 新 BrowserWindow → 新 renderer 进程 → 干净 argv → preload 解出 `{mode:'normal'}` |

代价：一帧白屏 + renderer 状态不保留。但此刻 renderer 只有 MigrationDialog，没有需要保留的用户状态。

### 6.5 不做 Cmd+Q 中途的残局恢复

Cmd+Q 发生在 Phase C 9a-9c 微窗口（`renameSync(dbPath → .old-pre-v0.3)` 到 `renameSync(.new → dbPath)` 之间）的概率 <1/1000，且数据仍在 `.backup` + `.old-pre-v0.3` 上。`owl doctor --recover` 的残局处理已在主 P3 计划 §10 列为 post-P3 项。本阶段 precheck 只处理 dbPath 存在的 3 种 mode。

### 6.6 MigrationDialog 不进 Router

`MainApp.tsx` 保留现有 `HashRouter`（P2-8 起已用 `react-router-dom@7` 管 7 个页面路由）。MigrationDialog 属于 app 启动前的阻断 UI，自己用 `useState` 管 4 屏状态机即可，**不挂 Router**：一是避免在 Router context 里渲染会带来的 hash 污染，二是 dialog 销毁后整窗口 destroy + recreate，新 `MainApp` 会以初始路由 `#/` 启动。

### 6.7 `@testing-library/react` + `jsdom` + `@testing-library/user-event` 依赖

查 `packages/gui/package.json:53-65` 确认当前 devDeps 仅有 `vitest` / `typescript` / `@types/react*` / `electron-vite` 等；**没有 jsdom，也没有 @testing-library/react**。本阶段新增 3 个 devDeps。

同时 `vitest.config.ts:10-12` 当前 `include` 仅覆盖 `src/renderer/src/**`。必须改为 `projects` 配置把 main 测试纳入（§5.3 已给出最终形）。

### 6.8 preload 里 `process.argv` 可用性

Electron preload 脚本在 `sandbox: false`（本项目配置）时有完整 Node `process` 对象。`additionalArguments` 的值会被追加到 `process.argv`。已在 Electron 官方文档确认（Electron 30+）。

### 6.9 销毁 + 重建后的窗口尺寸

`createWindow` 内已读 `loadConfig()` 拿窗口 `width/height`（`main/index.ts:14-20`）。销毁老窗口后 `createWindow()` 会重新读配置、回到用户上次保存的尺寸。无需手动 preserve `win.getBounds()`。

### 6.10 daemonStartedByGui 状态

迁移期间不 spawn daemon → `daemonStartedByGui = false` 全程。`migration:done` 走 `ensureDaemonRunning()` 后 `daemonStartedByGui` 正确更新为 true（若成功拉起）。`before-quit` 的 `stopDaemonGracefully` 行为自然正确。无额外改动。

### 6.11 pct 参数从 `onProgress` 签名移除

P3.2-a 签名里带 `pct?: number` 占位。本阶段 4 phase 实现都不产生 pct（COPY / FTS rebuild 是 set-based 瞬间，没有 tuple-level 进度；backup 虽然 better-sqlite3 的 `backup()` 能接 progress callback，但 52 条笔记场景走不到一次 callback）。保留占位会让 caller 期待未来有 pct 但实际永远 undefined 浪费 API surface。移除干净；未来真有大数据量 progress 再加回。

### 6.12 `ensureDaemonRunning` 返回 `Promise<boolean>`

`daemon.ts:70` 现行签名 `Promise<void>`，内部已算出 `ready: boolean`（用来设 `daemonStartedByGui`）但没返回。本阶段改为返回该布尔值。`main/index.ts:69` 原调用点 `await ensureDaemonRunning()` 忽略返回值，自然兼容。`migration:done` handler 读返回值决定是 destroy+recreate 还是推 `migration:daemon-failed` 事件。

### 6.13 `@owl/gui` 不直接 import better-sqlite3

原方案 `migration-precheck.ts` 直接 `import BetterSqlite3 from 'better-sqlite3'`，但 `packages/gui/package.json` 没把 better-sqlite3 列为直接依赖（靠 `@owl/core` 传递）。这在 pnpm workspace + hoisted link 下目前能跑，但依赖关系不清晰，未来升 `@owl/core` 的 better-sqlite3 时 `@owl/gui` 的 type/import 会被牵连。

本设计把只读探测下沉到 `@owl/core` 的 `probeStartupState`，`@owl/gui` 只调函数，不 import native 绑定。额外好处：`migration-precheck.test.ts` 可 mock `probeStartupState` 做纯映射单测，不碰真 sqlite；`probe.test.ts` 配合真库覆盖探测逻辑。

### 6.14 `mapMigrationError` 必须独立可测

原方案把 `mapMigrationError` 作为 `migration-ipc.ts` 内部私函数，测试 coverage 只能经 IPC（不易）或在 renderer 的 M5 mock 已映射结果间接覆盖（映射表本身不覆盖）。

本设计把 `mapMigrationError` 改成命名 export，`migration-ipc.test.ts` 直接调用，7 条 case 覆盖 5 个 error class + 通用 Error + 非 Error。renderer M5 与 main 端映射彻底解耦。

---

## 7. 测试计数汇总

| 包 | P3.2-a 基线 | P3.2-b 新增 | 小计 |
|---|---|---|---|
| core | 101 | +2 migrate (T16/T17) + +5 probe (PR1-PR5) = **+7** | 108 |
| daemon | 95 | 0 | 95 |
| gui.main（新 project） | 0 | +5 precheck (P1-P5) + +7 ipc (E1-E7) = **+12** | 12 |
| gui.renderer | 49 | +7 MigrationDialog (M1-M7) = **+7** | 56 |
| **合计** | **245** | **+26** | **271** |

`packages/gui` 内部用 vitest `projects` 拆 `main` / `renderer`，前者 node env 新增 12 条，后者 jsdom env 新增 7 条。

lint + typecheck 零新错误。`11 pre-existing warnings + 1 P3.2-a 的 cognitive complexity` 基线保持。

---

## 8. 接下来

1. 用户审阅本设计 → 提调整 → 同意后 commit 为 `docs(db): add P3.2-b MigrationDialog design`
2. 调 `superpowers:writing-plans` 出详细实施 plan（带 TDD checkpoints + 每步验证命令）
3. 按 plan 实施 → 每个 step 验证 → 全通过后用户确认再提交代码

**实施期间的 build 依赖顺序**（写进 plan 的验证命令段）：

- 新增 `@owl/core` export（`probeStartupState`、`StartupProbeResult`）后，`@owl/gui` 的 typecheck / test 必须先跑 `pnpm -F @owl/core build`，否则 `@owl/gui` 拿到的 `dist/index.d.ts` 是旧的，`import { probeStartupState }` typecheck 会失败
- 建议顺序：
  1. 改 `@owl/core`（probe.ts + barrel + migrate.ts onProgress）→ `pnpm -F @owl/core run lint && pnpm -F @owl/core run test && pnpm -F @owl/core run build`
  2. 改 `@owl/gui`（main / preload / renderer）→ `pnpm -F @owl/gui run lint && pnpm -F @owl/gui run test`
  3. 根级 `just check` + `just test` 全套验证

commit 信息草稿（实施后最终定）：

```
feat(gui): P3.2-b MigrationDialog

- main/index.ts: whenReady runs migration-precheck before
  ensureDaemonRunning; spawns daemon only on mode='normal'
- main/migration-precheck.ts: pure mapping from @owl/core
  probeStartupState into StartupMode three-state; no native
  better-sqlite3 import in @owl/gui
- main/migration-ipc.ts: registerMigrationIpc wiring
  migration:start (invoke) / :progress (send) / :done (destroy +
  recreate window on success, daemon-failed event on failure) /
  :quit / :daemon-failed (send); mapMigrationError maps 5
  @owl/core error classes to { reason, message } payload for
  renderer; exported for direct unit testing
- main/daemon.ts: ensureDaemonRunning return Promise<boolean>
- preload/index.ts: parse --startup-mode= from process.argv;
  expose startupMode + migration.{start,onProgress,done,quit,
  onDaemonFailed}
- renderer/App.tsx: top-level split on window.owlAPI.startupMode
- renderer/MainApp.tsx: original App body (HashRouter + DndContext
  + sidebar + Routes) moved verbatim
- renderer/pages/MigrationDialog/: 4-screen state machine
  (confirm / running / success / error) + errorCopy.ts reason
  table; success screen renders daemon-failed banner on event
- renderer/types/owl-api.d.ts: full window.owlAPI type
- core/db/migrate.ts: upgrade onProgress from sealed to emit 4
  phases (backup, copy, fts-rebuild, swap) with setImmediate
  yield after each emit and try/catch swallow; drop unused pct arg
- core/db/probe.ts: probeStartupState readonly user_version +
  schema emptiness probe
- core barrel: re-export probeStartupState + StartupProbeResult
- gui vitest.config.ts: projects split (renderer=jsdom / main=node)
- gui devDeps: + jsdom, @testing-library/react,
  @testing-library/user-event
- tests +26: migrate.test.ts T16/T17, probe.test.ts PR1-PR5,
  migration-precheck.test.ts P1-P5, migration-ipc.test.ts E1-E7,
  MigrationDialog.test.tsx M1-M7; total 271/271

Refs: docs/plans/2026-04-20-p3-plan.md §5.5
      docs/plans/2026-04-30-p3-2-b-migration-dialog-design.md
```




