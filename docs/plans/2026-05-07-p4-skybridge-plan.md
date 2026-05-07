# owl P4 — skybridge Phase 1+2 对接计划（框架）

日期：2026-05-07
状态：**框架级** — 动工前每个 Phase 单独拉 design doc 细化

## 定位

本文档是 owl 端 P4 的入口索引，对应 `aviary/docs/SKYBRIDGE_ARCH.md` 里 **Phase 1** 与 **Phase 2** 在 owl 仓的落地。不替代后续各 sub-phase design doc（Phase 3+ 再说）。

- **跨仓架构**：`aviary/docs/SKYBRIDGE_ARCH.md`
- **跨仓路线**：`aviary/docs/ROADMAP.md`
- **owl 当前进度**：`PROCESS.md`

## 范围（in / out）

### In — P4 要完成
- owl 内部三条写入路径（GUI / CLI 默认 / CLI `--direct`）全部收敛到同一 `core` 写入函数
- schema v4：新增 `sync_changes`（append-only 本地变更流）、`sync_cursor`（服务端游标占位）、`conflict_record`（冲突占位）
- 所有 core 写入函数在事务内追加对应 `sync_changes` 条目
- 提供 forward migration `0004_skybridge_tables.sql`（沿用 P3.2-a 的 `applyForwardMigrations` 骨架）
- 单元测试：每个 mutation 路径都验证对应 sync_changes 行被写入

### Out — 留给 P5/P6
- skybridge client HTTP 客户端与 SSE 订阅
- sync engine（push / pull / 定时 / 网络恢复触发）
- GUI 同步状态栏与 workspace 切换
- server 侧任何实现（在 `skybridge/` 仓独立推进）
- 多设备语义激活、conflict UI

## Phase 1 — daemon 入口收敛

**动机**：Phase 2 要靠"所有写入都经过 core"这个不变量来保证 `sync_changes` 被追加。Phase 1 把这个不变量写死。

**调查项**（开工第一步）：
1. GUI → daemon HTTP → core 路径完整性：当前所有 mutation endpoint 是否最终命中同一批 core 函数？列出清单。
2. CLI 默认路径（走 daemon HTTP）：同上。
3. CLI `--direct` 路径：当前实现绕过 HTTP 但是否调用 core？还是直接操作 drizzle？
4. Migration runner（P3.2-a）写入：作为 schema 升级动作，**不**经过 core，**不**入 sync_changes（schema migrations 本身不是用户数据变更）。

**改动预期**：
- 若 `--direct` 直接操作 drizzle，则抽出 `@owl/core/writes.ts`（或类似）统一封装，让 HTTP handler 和 `--direct` 都调用它
- 如果已经收敛，Phase 1 只做补测试 + 文档固化约定

**产出**：`docs/plans/2026-05-??-p4-phase1-entry-convergence-design.md`（开工时写）

## Phase 2 — 本地 change log

**schema v4 新表（字段级细节在 design doc 里定，此处只列表名与用途）**：

| 表 | 用途 |
|---|---|
| `sync_changes` | append-only 本地变更流，由 core 写入函数追加 |
| `sync_cursor` | 服务端游标占位（Phase 3 起才真正使用） |
| `conflict_record` | 冲突记录占位（Phase 5 起才真正使用） |

Phase 2 不写 sync / cursor / conflict 的业务逻辑，仅把表建起来并开始**累积** `sync_changes`。

**core 写入契约**：
- 每个 mutation core 函数在同一 transaction 内：
  1. 修改业务表（notes / folders / tags / reminders / conversations / chat_messages / ...）
  2. 向 `sync_changes` 插入一条描述本次变更的记录（`entity_type`、`entity_id`、`op`、`payload`、`created_at`、`local_seq`）
- 失败的事务两张表同时回滚，不会出现业务表改了但 change log 没记的情况

**entity/op/payload schema**：
- entity_type 与 op 的命名空间 owl 自定义（owl 管自己的，lark 将来管自己的，互不覆盖）
- payload 的 shape 仍以"能在空库 apply 重建实体"为目标，但不要求 Phase 2 就锁死最终形态 —— Phase 3 接服务端时如果发现问题，sync_changes 还没出 owl 门，可重写

**产出**：
- `docs/plans/2026-05-??-p4-phase2-change-log-design.md`（开工时写，含 schema 完整 DDL、每个 entity 的 payload schema、测试矩阵）
- `packages/core/src/db/migrations/0004_skybridge_tables.sql`
- 所有 mutation core 函数更新 + 配套测试

## 0.4.0 发版标准

- [ ] Phase 1 交付：三条写入路径走同一 core，CI 有回归测试固化此不变量
- [ ] Phase 2 交付：schema v4 上线，所有已知 mutation 路径都生成 sync_changes 记录
- [ ] 全量测试通过（当前基线 563/563）
- [ ] 手动测试（按照 `CLAUDE.md` 手动测试规范执行）：典型 CRUD 场景 sync_changes 行数正确
- [ ] 发 GitHub Release `v0.4.0` + `@orpheus-aviary/owl-cli@0.4.0`
- [ ] `~/orpheus-aviary-nest/owl/owl.sync.db`（rclone 时代遗留）不再被任何代码读写

## 开放问题（Phase 3 开工前需收敛）

- `sync_changes.payload` 格式：JSON 文本 vs 二进制（msgpack）？Phase 2 先用 JSON
- `local_seq` 分配：autoincrement vs 逻辑时钟？Phase 2 先 autoincrement
- attachment（图片等）是否进 sync_changes 还是独立通道？属 P5
- Phase 2 已积累的 sync_changes 首次上云时是否需要 replay-from-snapshot？属 P5 决定
- schema v4 之后 `owl.sync.db` 文件的移除/重命名节奏

## 非目标（再次声明）

- 不做 CRDT / OT
- 不做 P2P
- 不做端到端加密（延到 Phase 3 再评估）
- 不做自动 merge，冲突一律 Phase 5 的 UI 人工处理
