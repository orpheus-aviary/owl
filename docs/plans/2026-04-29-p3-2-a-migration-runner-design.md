# P3.2-a — Schema Migration Runner（core + `just migrate`）设计

日期：2026-04-29
修订：
- v1 2026-04-29 初版
- v2 2026-04-29 对齐审查反馈 #1：显式列 / set-based FTS / async backup / 三层锁 / ATTACH 方向翻转
- v3 2026-04-29 对齐审查反馈 #2：`locking_mode=EXCLUSIVE` 取代 `BEGIN EXCLUSIVE` 做安全边界 / FTS delete-all 防重复 / 嵌套 try/finally 管连接状态 / barrel 补 exports / pid 探测自实现避免循环依赖 / FK 保持 ON + foreign_key_check 兜底
- v4 2026-04-29 对齐审查反馈 #3：`main.foreign_key_check` 源库预检（COPY 前权威检测点）/ `dest.foreign_key_check` 改 schema-qualified pragma 语法 / 锁范围措辞修正（"file swap 前一刻"不含 `old.close()`→`renameSync` 微窗口）/ T6/T11/T13 硬断言清单
- v5 2026-04-29 对齐审查反馈 #4：T9 setup 显式触发读（WAL 下空 open 不持锁）/ backup ts 毫秒精度（同秒重试不覆盖）/ 新增 `SchemaMismatchError` 入 API + barrel + script 错误分发 + T14 / 修 §3.4 §253 行遗留的"覆盖 rename"stale 表述

上级计划：`docs/plans/2026-04-20-p3-plan.md` §5.5
起点：`v0.2.0` 已发（2026-04-29），`~/orpheus-aviary-nest/owl/owl.db` 处于 `user_version=0 + 52 条笔记`
交付目标：首提交完成后 `just migrate` 能把用户真库一次性迁到 `user_version=1`，`daemon` 重启可正常工作；同时为 0.4.0+ 的未来版本向前 apply migration 打好 runner 骨架

---

## 1. 范围 & 非范围

### 1.1 本提交范围

- `@owl/core` 内新增 migration runner（含五种错误类型 + 文件锁 + 自有 pid 探测）
- `packages/core/src/db/migrations/0001_initial.sql`：当前完整 DDL + FTS5 虚表 + 3 触发器（**列顺序与真库一致**：`notes.auto_delete_at` 置末尾）
- 改造 `createDatabase()`：打开即读 `PRAGMA user_version` 并按版本分派
- 删除 `createTables()` 里的 `CREATE TABLE IF NOT EXISTS` 语义 + 删 `migrateSchema()`（幂等改由版本号保证；删除安全性依赖下方显式列清单）
- `packages/core/src/index.ts` barrel 补 re-export（`LATEST_KNOWN_VERSION` + 五种错误 + `migrateLegacyDb`）
- `packages/core/scripts/migrate.mjs`：交互式 TTY y/N 触发 rebuild
- `packages/core/scripts/copy-sql.mjs`：post-build 把 `src/db/migrations/*.sql` 复制进 `dist/`
- `justfile`：`just migrate` target
- `packages/daemon/src/cli.ts`：**(a)** 捕获迁移错误并以非零退出；**(b)** `writePid()` 时序调整——挪到 `createDatabase()` 之前，关闭 migration race window
- 单测：`migrate.test.ts` 覆盖 14 条场景

### 1.2 非范围（后续独立提交 / 阶段）

| 项 | 归属 |
|---|---|
| GUI `whenReady` precheck + MigrationDialog 模态 | P3.2-b 或与 CLI 搭完之后 |
| `owl migrate` 子命令（TTY 版与 `just migrate` 复用同一个 core 函数） | P3.2-c CLI 核心 |
| daemon/CLI direct 模式的用户引导 UX 打磨 | 与 P3.2-c CLI 合并 |
| SSE `/events` reverse channel | P3.2-d |

### 1.3 关键不变量

1. 首提交合并后，**daemon 在未迁移的老库上启动 = exit 1**；不得静默损坏数据
2. `just migrate` 跑完一次 → 用户真库 `user_version=1`、笔记数不变（52 条）、`#真实` 笔记全部原样、FTS content **和 tag** MATCH 都能命中、**无 FTS 重复 posting**（delete 后 tag token 不残留）
3. 迁移期间任何环节失败 → 原 `owl.db` 原样不动、锁释放、`.new` / `.migrate.lock` / `.old-pre-v0.3` 清理；可立即重试
4. rebuild 分支代码 0.4.0 可以整体删除（靠 `user_version` 判定没有老库了）
5. 0001 只读一次（`v==0 + 空库`分支），之后**永远不再跑 `CREATE TABLE IF NOT EXISTS`**

---

## 2. 现状速览

### 2.1 现有 DB 层结构

```
packages/core/src/
├── index.ts            barrel；当前只 export createDatabase / schema / updateFtsTagsText（需补充）
└── db/
    ├── fts.ts              createFts() + FTS_TRIGGER_{INSERT,UPDATE,DELETE}
    ├── index.test.ts
    ├── index.ts            createDatabase() + createTables() + migrateSchema() + DDL 常量
    ├── schema.ts           drizzle ORM schema（与 DDL 一一对应，按名字映射，列顺序无关）
    └── special-notes.ts    与本提交无关
```

`createDatabase()` 当前流程（`db/index.ts`）：

```
new BetterSqlite3(dbPath)
→ PRAGMA journal_mode=WAL / foreign_keys=ON / busy_timeout=5000
→ createTables()     // 6 条 CREATE TABLE IF NOT EXISTS
→ migrateSchema()    // ad-hoc ALTER 加 notes.auto_delete_at
→ createFts()        // FTS 虚表 + 3 触发器
→ drizzle 包装
```

### 2.2 用户真库状态（2026-04-29，本地核对）

```
PRAGMA user_version = 0
tables: folders | notes | tags | note_tags | local_metadata | reminder_status
        notes_fts (+ _config/_data/_docsize/_idx)
notes 行数 = 52
notes 列序（实测）：id, folder_id, trash_level, created_at, updated_at,
                  trashed_at, device_id, content_hash, content, auto_delete_at
                  ← auto_delete_at 由历史 ALTER TABLE 追加，位于末尾
```

→ 走 `v==0 + 非空` 分支触发 rebuild。

### 2.3 业务层 FTS tags_text 格式

`packages/core/src/notes/index.ts:423-424`：

```ts
const hashTags = parsedTags.filter((t) => t.tagType === '#').map((t) => t.tagValue);
updateFtsTagsText(sqlite, noteRow.rowid, hashTags.join(' '));
```

**格式**：仅 `tag_type='#'` 的 `tag_value`，空格连接。rebuild 必须精确复现以保证 tag-FTS 搜索迁移后立即可用。

### 2.4 daemon pid 现状 + 循环依赖风险

`packages/daemon/src/cli.ts`：

```
L44: const { db, sqlite } = createDatabase({ dbPath: paths.dbPath() });  ← DB 已打开
L53-63: buildServer(...)
L79-82: server.listen(...)
L83: writePid();                                                          ← pid 写入
```

DB 打开到 pid 写入之间有 ms~s 窗口。本提交把 `writePid()` 挪到 L44 之前；`createDatabase` 抛错时在 catch 里 `removePid()` 兜底。

**循环依赖限制**：`@owl/daemon/pid.ts` 已 `import { paths } from '@owl/core'`，所以 `@owl/core` 的 `migrate.ts` **不能** import daemon 的 `readPid`。`migrate.ts` 自己实现 `probeDaemonPid(dbPath)`，位置约定 `dirname(dbPath)/daemon.pid`——与 `paths.pidPath()` 的布局一致（都在 nest 目录下），但函数签名以 dbPath 为源，测试用 tmp 目录也不会意外读真用户 pid 文件。

---

## 3. 架构

### 3.1 文件变更

```
packages/core/src/
    ├── index.ts                    [改]  barrel 补 LATEST_KNOWN_VERSION / migrateLegacyDb /
    │                                     MigrationRequiredError / IncompatibleDbError /
    │                                     MigrationBusyError / SourceDbCorruptionError /
    │                                     SchemaMismatchError re-export
└── db/
    ├── migrations/
    │   └── 0001_initial.sql        [新]  完整 DDL + FTS 虚表 + 3 触发器（notes.auto_delete_at 置末尾）
    ├── migrate.ts                  [新]  runner + errors + migrateLegacyDb + probeDaemonPid
    ├── index.ts                    [改]  createDatabase 加版本分派；删 createTables/migrateSchema（合并进 runner）
    ├── fts.ts                      [保留]  createFts 函数保留供现有业务层 import；0001 SQL 里内联等价 DDL
    ├── schema.ts                   [不动]
    ├── special-notes.ts            [不动]
    └── index.test.ts               [改]  删废弃测试 + 补 FTS trigger 健在断言

packages/core/scripts/
├── copy-sql.mjs                [新]  post-build 把 src/db/migrations/*.sql 复制进 dist/db/migrations/
└── migrate.mjs                 [新]  TTY y/N 交互，调 migrateLegacyDb

packages/core/package.json      [改]  "build": "tsc && node scripts/copy-sql.mjs"

packages/daemon/src/cli.ts      [改]  (a) try/catch MigrationRequiredError/IncompatibleDbError → exit 1
                                     (b) writePid() 提前到 createDatabase() 之前，失败 removePid 兜底

justfile                        [改]  + migrate target
```

### 3.2 公共 API（从 `@owl/core` export）

```ts
export const LATEST_KNOWN_VERSION = 1;

export class MigrationRequiredError extends Error {
  readonly dbPath: string;
  readonly currentVersion: number;   // 0
  constructor(dbPath: string);
}

export class IncompatibleDbError extends Error {
  readonly dbPath: string;
  readonly dbVersion: number;
  readonly maxSupported: number;
  constructor(dbPath: string, dbVersion: number);
}

export class MigrationBusyError extends Error {
  readonly reason:
    | 'daemon_alive'          // Layer 1 探到 pid 文件 + 进程活
    | 'lock_file'             // Layer 2 文件锁已存在
    | 'exclusive_lock_busy'   // Layer 3-a locking_mode=EXCLUSIVE 触发读被拒
    | 'checkpoint_busy'       // Layer 3-b wal_checkpoint 返回 busy != 0
    | 'begin_busy';           // Layer 3-c BEGIN 仍然 BUSY（locking_mode 已持锁时理论上不应发生，留作兜底）
  constructor(reason: MigrationBusyError['reason'], message: string);
}

// Source-db 孤立引用等损坏情况
export class SourceDbCorruptionError extends Error {
  readonly violations: number;
  constructor(violations: number);
}

// 源库 schema 不符合预期（缺必要列、表缺失等）
// 注：`notes.auto_delete_at` 缺列被显式兜底（COPY 投影 NULL），不触发此错误
export class SchemaMismatchError extends Error {
  readonly dbPath: string;
  readonly details: string;   // 例如 "table 'notes' missing required column 'content'"
  constructor(dbPath: string, details: string);
}

// 老库迁移 — 由 scripts/migrate.mjs 或未来的 owl migrate 调用
// async：better-sqlite3 的 Database.backup() 返回 Promise
export interface MigrateResult {
  backupPath: string;
  notesCount: number;
  elapsedMs: number;
}
export function migrateLegacyDb(dbPath: string): Promise<MigrateResult>;

// createDatabase 签名不变（仍同步）
export function createDatabase(options: DatabaseOptions): { db: OwlDatabase; sqlite: BetterSqlite3.Database };
```

### 3.3 `createDatabase()` 版本分派

伪代码：

```
const sqlite = new BetterSqlite3(dbPath);
setPragmas(sqlite);  // WAL / foreign_keys=ON / busy_timeout=5000

const v = sqlite.pragma('user_version', { simple: true }) as number;

if (v > LATEST_KNOWN_VERSION) {
  sqlite.close();
  throw new IncompatibleDbError(dbPath, v);
}

if (v === 0) {
  if (isSchemaEmpty(sqlite)) {
    applyInitialSchema(sqlite);         // INITIAL_SQL 全文一次性 run
    sqlite.pragma(`user_version = ${LATEST_KNOWN_VERSION}`);
    // fall through 到 drizzle 包装
  } else {
    sqlite.close();
    throw new MigrationRequiredError(dbPath);
  }
} else if (v < LATEST_KNOWN_VERSION) {
  applyForwardMigrations(sqlite, v, LATEST_KNOWN_VERSION);  // 0.3.0 走不到，骨架预留
} // else v === LATEST → 直接包 drizzle

return { db: drizzle(sqlite, { schema }), sqlite };
```

**判断顺序不可调换**：`v > LATEST` 必须先于 `v == 0` 处理，否则未来版本 >= 2 的库会被误判。

**`isSchemaEmpty(sqlite)` 定义**：

```ts
function isSchemaEmpty(sqlite: BetterSqlite3.Database): boolean {
  const row = sqlite
    .prepare(`SELECT count(*) AS n FROM sqlite_master
              WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .get() as { n: number };
  return row.n === 0;
}
```

FTS 影子表（`notes_fts_config/data/docsize/idx`）也算业务表，一旦存在就视为非空。

### 3.4 `migrateLegacyDb(dbPath)` 流程

**三层锁架构**（v3 校准）：

| Layer | 机制 | 防的是 |
|---|---|---|
| 1 | `probeDaemonPid(dbPath)` — 读 `dirname(dbPath)/daemon.pid` + `kill(pid, 0)` 活性检查 | 同机 daemon 跑着时，友好提示"先关 GUI"（配合 §3.7.1 的 pid 时序提前，窗口趋近 0） |
| 2 | `owl.db.migrate.lock` 文件锁（`fs.openSync(path, 'wx')`） | 两个 `just migrate` 并发 |
| 3 | **老连接 `PRAGMA locking_mode=EXCLUSIVE` + 触发读** → 锁从触发读到 `old.close()` 全程持有，覆盖 checkpoint / backup / copy / commit（**不覆盖 `old.close()` 到 `renameSync` 之间的微窗口**——由 Layer 1+2 兜住）；叠加 `wal_checkpoint(TRUNCATE)` busy 检查 + `BEGIN` 异常兜底 | 启动中 daemon、外部进程、所有未落 pid 的竞争者 |

**Layer 3 v2 → v3 的关键变化**：原用 `BEGIN EXCLUSIVE` 只在事务内持锁，COMMIT+close 到 rename 之间仍有窗口。改成 `locking_mode=EXCLUSIVE` 后，锁从触发读到 `old.close()` 全程持有，覆盖 checkpoint / backup / copy / commit（**不覆盖**：`old.close()` → `renameSync(dbPath,...)` 之间的微窗口，由 Layer 1+2 兜住；对 Owl daemon 充分，对任意外部 SQLite 进程仅"极小窗口"）。

**架构决策**（沿用 v2）：同一个 `old` 连接持锁 + ATTACH `.new` AS dest，COPY 方向 `main.X → dest.X`。不开第二个 `next` 连接 ATTACH src。

**关键次序**（SQLite 语义）：
1. `locking_mode=EXCLUSIVE` 先于触发读
2. ATTACH 先于 `BEGIN`（SQLite 禁止 EXCLUSIVE/IMMEDIATE 事务内 ATTACH；DEFERRED 新版允许但回避安全）
3. FTS `('delete-all')` 先于 set-based INSERT

---

**完整流程**（嵌套 try/finally 管连接生命周期 + 事务状态 + attach 状态 + 文件锁 + 残留文件）：

```ts
export async function migrateLegacyDb(dbPath: string): Promise<MigrateResult> {
  // ===== Layer 1 — daemon pid 探测（自有实现，不 import daemon）=====
  if (probeDaemonPid(dbPath) !== null) {
    throw new MigrationBusyError('daemon_alive',
      'Owl daemon 正在运行，请先关闭 GUI / 停止 daemon');
  }

  // ===== Layer 2 — 独占文件锁 =====
  const lockPath = `${dbPath}.migrate.lock`;
  let lockFd: number;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
    fs.writeSync(lockFd, String(process.pid));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MigrationBusyError('lock_file',
        `发现 ${lockPath}（另一个迁移进程正在运行或上次异常退出）。手动删除后重试。`);
    }
    throw e;
  }

  const newPath = `${dbPath}.new`;

  try {                                                // outer：文件锁 + .new 残留
    // ===== Phase A — 初始化 .new（独立短连接，journal_mode=DELETE 避免 WAL sidecar）=====
    if (fs.existsSync(newPath)) fs.unlinkSync(newPath);

    const init = new BetterSqlite3(newPath);
    try {
      init.pragma('journal_mode = DELETE');
      init.pragma('foreign_keys = ON');
      init.exec(INITIAL_SQL);
      init.pragma(`user_version = ${LATEST_KNOWN_VERSION}`);
    } finally {
      init.close();                                    // 关：纯净，无 sidecar
    }

    // ===== Phase B — 锁 old，ATTACH new AS dest，COPY =====
    const startedAt = Date.now();
    const old = new BetterSqlite3(dbPath);
    let txStarted = false;
    let attached = false;

    try {                                              // mid：old 连接状态
      old.pragma('busy_timeout = 0');                  // 失败即失败
      old.pragma('foreign_keys = ON');                 // COPY 期间保持 ON，catch 源库孤立引用
      old.pragma('locking_mode = EXCLUSIVE');          // 持久排他

      // 触发锁获取 — 任一读操作都行，用 sqlite_master 最便宜且无副作用
      try {
        old.prepare('SELECT count(*) FROM sqlite_master').get();
      } catch (e) {
        if ((e as { code?: string }).code === 'SQLITE_BUSY') {
          throw new MigrationBusyError('exclusive_lock_busy',
            'cannot acquire exclusive lock — 有其它进程持有 db');
        }
        throw e;
      }
      // 从此到 old.close()：其它进程任何 open 立刻 BUSY

      // 列存在性探测
      const noteCols = old.pragma('table_info(notes)') as { name: string }[];
      const hasAutoDeleteAt = noteCols.some(c => c.name === 'auto_delete_at');
      verifyExpectedColumns(old);  // 检查 6 张表列集合，缺列即抛 SchemaMismatchError

      // 源库 FK 预检（权威检测点） —— 必须在 COPY 之前
      // 理由：COPY 阶段 FK=ON，孤立 note_tags → INSERT 会先抛 SQLITE_CONSTRAINT_FOREIGNKEY，
      //       dest 侧的 foreign_key_check 根本走不到；预检在 main 上跑，violations>0 直接抛
      //       SourceDbCorruptionError，用户看到明确错误而非 CONSTRAINT 噪声
      const mainViolations = old.pragma('main.foreign_key_check') as Array<unknown>;
      if (mainViolations.length > 0) {
        throw new SourceDbCorruptionError(mainViolations.length);
      }

      // WAL checkpoint（locking_mode=EXCLUSIVE 下理论上不会 busy，保留兜底检查）
      const ckpt = old.pragma('wal_checkpoint(TRUNCATE)') as Array<{busy:number;log:number;checkpointed:number}>;
      if (ckpt[0]?.busy !== 0) {
        throw new MigrationBusyError('checkpoint_busy', 'WAL checkpoint busy');
      }

      // 在线 backup（async，一致性快照）
      const ts = Date.now();                           // 毫秒精度：避免同秒重试时覆盖前次 backup
      const backupPath = `${dbPath}.v0.2-backup-${ts}`;
      await old.backup(backupPath);

      // ATTACH 必须在 BEGIN 之前
      old.prepare('ATTACH DATABASE ? AS dest').run(newPath);
      attached = true;

      try {
        old.exec('BEGIN');
      } catch (e) {
        if ((e as { code?: string }).code === 'SQLITE_BUSY') {
          throw new MigrationBusyError('begin_busy',
            'BEGIN busy — 罕见，locking_mode 已持锁时理论不应发生');
        }
        throw e;
      }
      txStarted = true;

      // 显式列名 COPY（顺序 FK-safe：folders/tags → notes → note_tags/reminder_status → local_metadata）
      const autoDeleteProj = hasAutoDeleteAt ? 'auto_delete_at' : 'NULL AS auto_delete_at';
      old.exec(`
        INSERT INTO dest.folders   (id,name,parent_id,position,created_at,updated_at,device_id)
          SELECT id,name,parent_id,position,created_at,updated_at,device_id FROM main.folders;
        INSERT INTO dest.tags      (id,tag_type,tag_value)
          SELECT id,tag_type,tag_value FROM main.tags;
        INSERT INTO dest.notes     (id,folder_id,trash_level,created_at,updated_at,trashed_at,device_id,content_hash,content,auto_delete_at)
          SELECT id,folder_id,trash_level,created_at,updated_at,trashed_at,device_id,content_hash,content,${autoDeleteProj}
            FROM main.notes;
        INSERT INTO dest.note_tags (note_id,tag_id)
          SELECT note_id,tag_id FROM main.note_tags;
        INSERT INTO dest.reminder_status (note_id,tag_id,fire_at,status,fired_at)
          SELECT note_id,tag_id,fire_at,status,fired_at FROM main.reminder_status;
        INSERT INTO dest.local_metadata  (key,value)
          SELECT key,value FROM main.local_metadata;
      `);

      // FK 纵深防御 —— 源库预检是权威点；这里 dest 侧复查仅防极端角落（例如 init .new
      // 阶段被外部污染）。使用 pragma `schema.foreign_key_check` 语法，
      // 不要用 table-valued `pragma_foreign_key_check('dest')`（后者不支持 schema-qualified 形式）
      const destViolations = old.pragma('dest.foreign_key_check') as Array<unknown>;
      if (destViolations.length > 0) {
        throw new SourceDbCorruptionError(destViolations.length);
      }

      // FTS 重建 —— 先 wipe 触发器写入的空 tags_text posting，再 set-based 重建
      // 关键：0001 的 notes_fts_insert trigger 会在 INSERT INTO dest.notes 时写
      //       (rowid, content, '')；不先 delete-all，set-based insert 会造成同 rowid
      //       两条 FTS posting，delete 触发器按 content+tags_text 精确擦除只能擦一条
      old.exec(`INSERT INTO dest.notes_fts(notes_fts) VALUES('delete-all')`);

      // 严格复现业务层 packages/core/src/notes/index.ts:423-424 的格式
      old.exec(`
        INSERT INTO dest.notes_fts(rowid, content, tags_text)
        SELECT n.rowid, n.content,
          COALESCE((
            SELECT GROUP_CONCAT(t.tag_value, ' ')
            FROM dest.note_tags nt JOIN dest.tags t ON nt.tag_id = t.id
            WHERE nt.note_id = n.id AND t.tag_type = '#'
          ), '')
        FROM dest.notes n;
      `);

      const notesCount = (old.prepare('SELECT count(*) AS n FROM dest.notes').get() as { n: number }).n;

      old.exec('COMMIT');
      txStarted = false;

      old.exec('DETACH DATABASE dest');
      attached = false;

      // ===== Phase C — 原子文件替换（old 已 commit 但仍持锁 → 暂不 close；rename 需要 old 关闭释放文件句柄）=====
      old.close();                                     // 释放排他锁 + 文件句柄

      const preSwapPath = `${dbPath}.old-pre-v0.3`;
      try {
        fs.renameSync(dbPath, preSwapPath);                             // 9a
        for (const suf of ['-wal', '-shm']) {                           // 9b 清旧 sidecar
          try { fs.unlinkSync(`${dbPath}${suf}`); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        }
        fs.renameSync(newPath, dbPath);                                  // 9c
      } catch (err) {
        if (fs.existsSync(preSwapPath) && !fs.existsSync(dbPath)) {
          fs.renameSync(preSwapPath, dbPath);                            // 回滚
        }
        throw err;
      }

      // 成功：删 .old-pre-v0.3，.backup 保留
      try { fs.unlinkSync(preSwapPath); } catch { /* best-effort */ }

      return { backupPath, notesCount, elapsedMs: Date.now() - startedAt };

    } catch (err) {
      // Phase B 中途抛错清理
      if (txStarted) { try { old.exec('ROLLBACK'); } catch {} }
      if (attached)  { try { old.exec('DETACH DATABASE dest'); } catch {} }
      throw err;
    } finally {
      // old.close 被 Phase C 成功路径里显式调用了；catch 分支靠这里兜
      try { old.close(); } catch {}
    }

  } finally {
    // ===== outer 清理 =====
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
    try { fs.unlinkSync(newPath); } catch { /* Phase C 成功时 newPath 已 rename 到 dbPath，ENOENT 忽略 */ }
  }
}

// ===== probeDaemonPid — 自有实现，不 import @owl/daemon =====
function probeDaemonPid(dbPath: string): number | null {
  const pidPath = join(dirname(dbPath), 'daemon.pid');
  if (!fs.existsSync(pidPath)) return null;
  const raw = fs.readFileSync(pidPath, 'utf-8').trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0);                        // 活性探测
    return pid;
  } catch {
    try { fs.unlinkSync(pidPath); } catch {}     // 清 stale
    return null;
  }
}
```

**关键 commit 点**（两段 race window 分析）：
- **Phase B COMMIT 之前**：`.new` 已有完整数据 + FTS，但 `dbPath` 未动；失败 → ROLLBACK + DETACH + close + outer finally unlink `.new`；原库完整
- **Phase B COMMIT 之后 → Phase C 9a 之前**：`.new` 已 flushed 到盘；失败 → `.new` 会被 outer finally unlink 掉（数据丢，但原库完整，可重试）
- **Phase C 9a 之后 9c 之前**：原库已 rename 到 `.old-pre-v0.3`；失败 → try/catch 自动把 `.old-pre-v0.3` rename 回 `dbPath`
- **kill -9 发生在 9a-9c 之间**：dbPath 可能不存在，但 `.old-pre-v0.3` 和 `.v0.2-backup-<ts>` 双保险仍在盘

### 3.5 `packages/core/scripts/migrate.mjs`

```js
// scripts/migrate.mjs — ESM，走 pnpm --filter @owl/core build 后的 dist
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, paths, migrateLegacyDb } from '../dist/index.js';

loadConfig();
const dbPath = paths.dbPath();

const rl = readline.createInterface({ input, output });
const ans = await rl.question(
  `将迁移 ${dbPath}\n  - 创建备份\n  - checkpoint 后原子替换\n继续？(y/N) `
);
rl.close();

if (ans.trim().toLowerCase() !== 'y') {
  console.log('已取消');
  process.exit(0);
}

try {
  const { backupPath, notesCount, elapsedMs } = await migrateLegacyDb(dbPath);
  console.log(`✓ 迁移完成：${notesCount} 条笔记，耗时 ${elapsedMs}ms`);
  console.log(`  备份：${backupPath}`);
  console.log(`  如需回滚：cp "${backupPath}" "${dbPath}" && rm -f "${dbPath}-wal" "${dbPath}-shm"`);
} catch (err) {
  console.error(`✗ 迁移失败：${err.message}`);
  if (err.name === 'MigrationBusyError') {
    console.error(`  原因：${err.reason}`);
  }
  if (err.name === 'SourceDbCorruptionError') {
    console.error(`  源库检测到 ${err.violations} 条孤立 FK 引用 — 需要先清理源库`);
  }
  if (err.name === 'SchemaMismatchError') {
    console.error(`  源库 schema 不符合预期：${err.details}`);
  }
  process.exit(1);
}
```

### 3.6 `justfile` target

```
migrate:
    pnpm --filter @owl/core build
    node packages/core/scripts/migrate.mjs
```

### 3.7 daemon CLI 改动（两处）

#### 3.7.1 writePid 时序调整（关闭 race window）

```ts
// 原 L44: const { db, sqlite } = createDatabase(...);
// 原 L83: writePid();

// 改为：
writePid();                                            // 先写 pid
let sqlite: BetterSqlite3.Database;
let db: OwlDatabase;
try {
  ({ db, sqlite } = createDatabase({ dbPath: paths.dbPath() }));
} catch (err) {
  removePid();                                          // 失败兜底
  if (err instanceof MigrationRequiredError) {
    logger.error({ dbPath: err.dbPath }, 'database requires migration');
    console.error(`\n数据库需要迁移至 v${LATEST_KNOWN_VERSION}。`);
    console.error(`请运行 \`just migrate\`（GUI 内迁移 UI 将在后续版本提供）。\n`);
    process.exit(1);
  }
  if (err instanceof IncompatibleDbError) {
    logger.error({ dbVersion: err.dbVersion, maxSupported: err.maxSupported }, 'incompatible db');
    console.error(`\n数据库来自更新版本（v${err.dbVersion}），本应用支持到 v${err.maxSupported}。`);
    console.error(`请升级应用。\n`);
    process.exit(1);
  }
  throw err;
}
// 原 L83 writePid() 删除
```

**效果**：从 `writePid` 到 `createDatabase` 完成之间无间隙；任一方向竞争都会在 Layer 1 被拦。

---

## 4. `0001_initial.sql` 内容

一份文件 = 当前 `db/index.ts` DDL + `fts.ts` 的 `FTS_TABLE` + 3 条 `FTS_TRIGGER_*`。

要点：
- 删掉所有 `IF NOT EXISTS`（runner 保证只在空库跑一次）
- **`notes` 列序按现存真库**：`id, folder_id, trash_level, created_at, updated_at, trashed_at, device_id, content_hash, content, auto_delete_at`（`auto_delete_at` 末尾）
- FTS tokenize='trigram' 与现有一致
- 结尾**不**写 `PRAGMA user_version = 1`（由 runner 在 exec 后统一 set，保持 0001 文件"只定义 schema"）

加载方式：`packages/core/src/db/migrate.ts`

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL_SQL = readFileSync(join(__dirname, 'migrations', '0001_initial.sql'), 'utf8');
```

**产物打包**：tsc 默认不带 `.sql` 进 dist。加 post-build 脚本：

```js
// packages/core/scripts/copy-sql.mjs
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url)) + '/..';
cpSync(join(root, 'src/db/migrations'), join(root, 'dist/db/migrations'), { recursive: true });
```

`package.json` 的 `"build"` 改 `"tsc && node scripts/copy-sql.mjs"`。

**electron-builder 兼容性**：`asar: false` + `node-linker=hoisted` 下 electron-builder 整包复制 `node_modules/@owl/core/dist/**`，`.sql` 不在 default ignore 列表里，自然带走。writing-plans 阶段加一步：`just package` 后 `find release/Owl-0.2.0-arm64.dmg 展开 -name "0001_initial.sql"` 核实。

---

## 5. 测试矩阵

### 5.1 `migrate.test.ts`（新）

| # | 场景 | setup | 期望 |
|---|---|---|---|
| T1 | 空库初始化 | 全新 dbPath、文件不存在 | `createDatabase()` 成功；`user_version=1`；6 张表 + FTS 虚表存在 |
| T2 | v=1 正常打开 | 跑过 T1 的库 | `createDatabase()` 成功；user_version 不变；FTS trigger 可触发 |
| T3 | v=0 老库拒绝 | 手动建 DDL（含历史列序）+ 插 1 条笔记 + 不 set user_version | `createDatabase()` 抛 `MigrationRequiredError` |
| T4 | v=2 未来库 | 手动 `PRAGMA user_version = 2` | `createDatabase()` 抛 `IncompatibleDbError` |
| T5 | rebuild happy path | T3 的库 + 2 条笔记 + 3 条 tags（含 `#`/`/time:`/`/alarm:`）+ 1 条 folder | `notesCount=2`；backup 存在；`user_version=1`；所有表数据按行等于原库；FTS content MATCH 命中；FTS tag MATCH 命中（`#` 标签）；`.new`/`.old-pre-v0.3`/`.migrate.lock` 已清理 |
| T6 | rebuild 失败回滚（Phase C） | mock Phase C 9c `renameSync` 抛错 | 抛错向上；**硬断言 5 条**：(a) 原 dbPath 可正常 `createDatabase` 打开；(b) `.new` 不存在；(c) `.migrate.lock` 不存在；(d) `.old-pre-v0.3` 不存在（或存在但数据 = 原库，说明回滚生效）；(e) backup 存在；**重试断言**：同进程再调 `migrateLegacyDb(dbPath)`（此时 mock 已移除）返回正常 Result |
| T7 | daemon 活着（Layer 1） | 写入 `<dir>/daemon.pid` = 当前 node 进程 pid | `migrateLegacyDb()` 抛 `MigrationBusyError(reason='daemon_alive')` |
| T8 | 并发迁移（Layer 2） | 预先 `fs.writeFileSync(lockPath, '99999')` | `migrateLegacyDb()` 抛 `MigrationBusyError(reason='lock_file')` |
| T9 | 外部连接持锁（Layer 3） | 在测试里开一个 BetterSqlite3 连接打开 dbPath，**并显式跑一次读**（`other.prepare('SELECT count(*) FROM sqlite_master').get()`）以真正获取 SHARED 锁——仅 `new BetterSqlite3()` 在 WAL 模式下懒加载不持锁 | `migrateLegacyDb()` 抛 `MigrationBusyError(reason='exclusive_lock_busy')` |
| T10 | auto_delete_at 缺列兜底 | 手工建不含该列的老库 | rebuild 成功；新库 `auto_delete_at` 全为 NULL |
| T11 | 源库 FK 损坏 | T3 源库 + 手动插一条 `note_tags` 引用不存在的 note_id | 抛 `SourceDbCorruptionError(violations=1)`（由 `PRAGMA main.foreign_key_check` 预检触发，非 INSERT 阶段的 `SQLITE_CONSTRAINT_FOREIGNKEY`）；**硬断言 5 条**：(a) 原 dbPath 可正常打开且数据 = 原库；(b) `.new` 不存在；(c) `.migrate.lock` 不存在；(d) `.old-pre-v0.3` 不存在；(e) backup 不存在（预检在 backup 之前抛错）；**重试断言**：先修复源库（删孤立 note_tags），再调 `migrateLegacyDb` 应返回正常 Result |
| T12 | FTS 无重复 posting | T5 跑完后，delete 一条笔记 | FTS 再搜索该笔记的 tag → 0 条命中（证明没有双 posting） |
| T13 | Phase B 中途异常状态清理 | mock COPY 里抛合成异常 | 抛错向上；**硬断言 5 条**：(a) 原 dbPath 可正常 `createDatabase` 打开且数据 = 原库；(b) `.new` 不存在；(c) `.migrate.lock` 不存在；(d) `.old-pre-v0.3` 不存在；(e) backup 存在（保留供诊断）；**重试断言**：同进程再调 `migrateLegacyDb(dbPath)`（mock 已移除）返回正常 Result，且新一次 backup 文件名不同（毫秒 ts 递增） |
| T14 | 必要列缺失（非 auto_delete_at） | 手工建源库时 `notes` 缺 `content` 列 | `migrateLegacyDb()` 抛 `SchemaMismatchError`，`details` 含 `"notes"` / `"content"`；硬断言 5 条（同 T11：原 dbPath 完整、`.new`/`.migrate.lock`/`.old-pre-v0.3` 清理、backup 不存在——verifyExpectedColumns 在 backup 之前跑） |

### 5.2 `index.test.ts`（改）

- 删除针对旧 `createTables` / `migrateSchema` 的直接测试（如有）
- 保留 / 新增："用新 runner 初始化后 insert/update note → `notes_fts` 有对应 rowid"

### 5.3 daemon 包

- `cli.test.ts`（若存在）加 1 条：模拟 `createDatabase` 抛 `MigrationRequiredError` → daemon 以 exit 1 终止 + `daemon.pid` 不存在（removePid 已跑）
- 若暂无 cli.test.ts，本提交不新增（保持范围小），留作后续

---

## 6. 真库 smoke（合并前我本地手动跑）

**前置**：GUI 关闭、daemon 未跑。

**独立手动保险**：执行前把 `~/orpheus-aviary-nest/owl/owl.db` 另存一份到 `~/Desktop/owl-db-pre-p3-2-a.db`。

```bash
# 0. 核对
sqlite3 ~/orpheus-aviary-nest/owl/owl.db "PRAGMA user_version; SELECT count(*) FROM notes;"
# 预期 0 | 52

# 1. 跑迁移
cd ~/Desktop/jayncp_mac/orpheus-aviary/owl
just migrate
# 交互输入 y
# 预期输出 "✓ 迁移完成：52 条笔记，耗时 <X>ms"

# 2. 验证
sqlite3 ~/orpheus-aviary-nest/owl/owl.db "PRAGMA user_version"          # → 1
sqlite3 ~/orpheus-aviary-nest/owl/owl.db "SELECT count(*) FROM notes"    # → 52
ls ~/orpheus-aviary-nest/owl/owl.db*
# 应看到 owl.db + owl.db.v0.2-backup-<ts>
# 不应看到 .new / .old-pre-v0.3 / .migrate.lock
# -wal / -shm 可能为 0B 或不存在，都正常

# 3. daemon 能起
just dev-daemon
curl -s localhost:47010/status | jq
curl -s localhost:47010/notes?limit=5 | jq '.data | length'              # > 0

# 4. #真实 笔记保留
curl -s "localhost:47010/notes?search=真实" | jq '.data | length'

# 5. FTS content + tag 搜索
curl -s "localhost:47010/notes?search=<content 关键词>" | jq '.data | length'  # > 0
curl -s "localhost:47010/notes?tags=<某 # tag>" | jq '.data | length'          # > 0

# 6. FTS 无重复 posting 验证
# 在 daemon 跑起来时随便 delete 一条笔记，再搜它的 tag → 不应命中
```

**回滚命令**（印在脚本输出里 + 此文档）：

```bash
cp ~/orpheus-aviary-nest/owl/owl.db.v0.2-backup-<ts> ~/orpheus-aviary-nest/owl/owl.db
rm -f ~/orpheus-aviary-nest/owl/owl.db-wal ~/orpheus-aviary-nest/owl/owl.db-shm
sqlite3 ~/orpheus-aviary-nest/owl/owl.db "PRAGMA user_version"  # 应回到 0
```

---

## 7. 风险与明示决策

### 7.1 删 `migrateSchema()` 的取舍

当前 `migrateSchema()` 只做一件事：给旧库加 `notes.auto_delete_at`。

**删掉后的语义**：
- 未迁移的老库 (`v=0 + 非空`) `createDatabase()` 直接抛错 → 不走 `migrateSchema`
- 迁移后的库 (`v=1`) 新 schema 已含 `auto_delete_at`
- 新库 (`v=0 + 空`) 0001 直接建含 `auto_delete_at` 的表

**前置条件**：`migrateSchema` 覆盖的唯一场景（老库没这一列）被 `migrateLegacyDb` 的 rebuild 吸收，但**只有 COPY 用显式列名 + 列探测兜底（`autoDeleteProj = 'NULL AS auto_delete_at'`）时才成立**。本设计 §3.4 已保证此条件。

### 7.2 三层锁取舍

原方案 "daemon.pid + SQLITE_BUSY" 在 WAL 模式下不够强（空闲连接让 checkpoint busy=0 通过、`BEGIN EXCLUSIVE` 的锁不跨 COMMIT/close）。v3 定版：

| Layer | 说明 |
|---|---|
| 1 daemon.pid（自有 probe） | 友好提示。配合 §3.7.1 pid 时序提前，窗口趋近 0 |
| 2 `owl.db.migrate.lock` 文件锁 | `fs.openSync(path, 'wx')` 原子创建。防 `just migrate` 并发 |
| 3 `locking_mode=EXCLUSIVE` + 触发读 | SQLite 本体锁，跨 old 连接整个生命周期持有，**覆盖到 file swap 前一刻**（`old.close()` 与 `fs.renameSync(dbPath,...)` 之间仍有理论微窗口，由 Layer 1+2 兜住；对 Owl daemon 充分，对任意外部 SQLite 进程仅"极小窗口"） |
| 3 兜底 | `wal_checkpoint(TRUNCATE)` busy 结果检查 + `BEGIN` 异常捕获，捕获 locking_mode 失效的边界 |

### 7.3 `0001_initial.sql` 产物打包

选 A：post-build cp 脚本，`"build": "tsc && node scripts/copy-sql.mjs"`。理由：
- tsup 为这一个 SQL 文件不值得引（monorepo 其它包还在 tsc）
- `.sql` 文件在 electron-builder `asar: false` 打包路径下自然带走（实测核实留给 writing-plans 阶段的 step）

### 7.4 备份命名里的"v0.2"字样

命名：`owl.db.v0.2-backup-<unix-ts>`。0.3.0 ship 后这段代码就会被删，保留。

### 7.5 0001 里不含 `PRAGMA user_version = 1`

**理由**：0001 在两处被执行——`createDatabase` 的 `v==0 + empty` 分支、`migrateLegacyDb` 的 Phase A。两处都在 exec 完 SQL 后**单独** set user_version，保持 0001 文件"只定义 schema、不定义版本号"。

### 7.6 未来 forward migration 骨架

`applyForwardMigrations(sqlite, fromV, toV)` 0.3.0 走不到。函数签名和文件扫描逻辑先写好：扫 `migrations/` 目录 `NNNN_*.sql`，按文件名数字排序，跑 `fromV+1 ... toV` 范围，每跑完一个 `PRAGMA user_version = N`。0.3.0 实现成"遍历但无文件可扫时直接 return"。

### 7.7 SQLite 语义不变量（代码里必须遵守）

1. **ATTACH 必须在 `BEGIN` 之前**。SQLite 禁止 EXCLUSIVE/IMMEDIATE 事务内 ATTACH
2. **`.new` 用 `journal_mode=DELETE`**。brand-new DB 走 WAL 毫无意义，还留 sidecar 干扰 rename
3. **COPY 期间 FK 保持 ON + 源库预检 + dest 侧复查**。COPY 顺序已 FK-safe；源库 `PRAGMA main.foreign_key_check` 是权威检测点（放 ATTACH/BEGIN 之前）；COMMIT 前 `PRAGMA dest.foreign_key_check` 作纵深。两处都用 schema-qualified pragma 语法，**不要**用 table-valued `pragma_foreign_key_check('<schema>')`（后者不支持 schema-qualified，会抛 `no such table`）
4. **`busy_timeout = 0` on old**。等待 = 迁移时长不可控，且掩盖真正的并发冲突
5. **`locking_mode=EXCLUSIVE` + 触发读先于 checkpoint/backup**。WAL 模式下这是持久排他文件锁，跨整个 old 连接生命周期
6. **FTS set-based INSERT 前必须 `('delete-all')`**。0001 含 `notes_fts_insert` 触发器会在 COPY notes 时用空 tags_text 预填，不 wipe 会导致双 posting + 后续 delete 触发器按 (content, tags_text) 擦除只能擦其一
7. **`probeDaemonPid(dbPath)` 自有实现，不 import `@owl/daemon`**。daemon/pid.ts 依赖 core/paths，反向 import 会循环；自有实现以 `dirname(dbPath)/daemon.pid` 为源，兼顾测试隔离

### 7.8 daemon pid 时序调整独立性

pid 提前本可以独立成一个 commit，但和本提交的 Layer 1 语义直接耦合：race window 存在时 Layer 1 有漏查可能。留在同一个 commit，审阅者看到的 migration safety envelope 完整。提交信息里单列一条 bullet 强调。

### 7.9 foreign_key_check 作为纵深防御

**权威检测点：源库预检**。在 locking_mode 获取锁之后、checkpoint / backup 之前，跑 `old.pragma('main.foreign_key_check')`——violations > 0 → 抛 `SourceDbCorruptionError`。这是用户看到明确错误（而非 `SQLITE_CONSTRAINT_FOREIGNKEY` 噪声）的唯一点。

**为什么必须预检**：COPY 期间 FK=ON，一旦 `note_tags` / `reminder_status` 有孤立引用，`INSERT SELECT` 抛 `SQLITE_CONSTRAINT_FOREIGNKEY`，事务 ROLLBACK——错误类型 + stack 与我们想传递给用户的语义脱节。预检把这类失败前移并正确归类。

**dest 侧复查（belt-and-suspenders）**：COMMIT 前再跑一次 `old.pragma('dest.foreign_key_check')`。正常情况下 violations=0（源已通过预检），此处仅防极端角落（例如 `.new` init 阶段被外部污染）。使用 schema-qualified pragma 语法，**不要**用 table-valued `pragma_foreign_key_check('dest')`（不支持 schema-qualified 形式，会抛 `SQLITE_ERROR: no such table: dest`）。

代价：两次全表 FK 扫描，对 52 条笔记 / v0.2 规模无感。

---

## 8. 接下来

1. 你审阅本设计 v3 → 有调整反馈我改 → 同意后
2. 我调 `superpowers:writing-plans` 写详细实施 plan（带 TDD checkpoints + 验证命令）
3. 按 plan 实施 → 每个 step 验证 → 全通过后**用户确认**再提交

提交信息草稿（待实施后最终定）：

```
feat(db): P3.2-a schema migration runner

- add migrations/0001_initial.sql + migrate.ts
- createDatabase dispatches on PRAGMA user_version
  (v>LATEST -> IncompatibleDbError; v=0 empty -> run 0001;
   v=0 non-empty -> MigrationRequiredError; future v<LATEST -> forward stub)
- migrateLegacyDb: 3-layer lock (self-owned pid probe / O_EXCL file lock /
  locking_mode=EXCLUSIVE + checkpoint busy + BEGIN busy fallback);
  ATTACH new AS dest; explicit-column COPY keeping FK ON with
  foreign_key_check before COMMIT; FTS delete-all then set-based
  rebuild matching business-layer tags_text format; nested try/finally
  to roll back tx / detach / close on any Phase B failure
- MigrationRequiredError + IncompatibleDbError + MigrationBusyError +
  SourceDbCorruptionError + SchemaMismatchError + barrel re-export
- daemon refuses to start on un-migrated db
- write daemon pid before opening db to close migration race window
- drop createTables IF NOT EXISTS + migrateSchema ad-hoc ALTER
- post-build copy-sql.mjs ships migrations/*.sql in dist

Refs: docs/plans/2026-04-20-p3-plan.md §5.5
      docs/plans/2026-04-29-p3-2-a-migration-runner-design.md
```
