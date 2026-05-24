# P5-c — 后台触发 + retry + conflict 检测 + token-mask 路 C

> 2026-05-25 收尾。**仍未发版**（0.5.0 留给 Step 18 手动验收 + 版号 bump 之后再发）。承接 [P5-b](./P5-b-shipped.md)（已 ship 内部 2026-05-24）。

## 一句话

P5-b 把跨设备多 entity 实时收敛搞通（SSE bridge + folder/conversation/tags/reminder apply）；P5-c 把它从「能 push/pull 各 entity」补全到「能后台跑、能 retry、能记冲突、能藏 token」：3 源后台触发统一进 coalescer（SSE 实时 + 5 分钟定时 + onError 退避期 10s 探针）、HTTP `withRetry` 5 次退避、`conflict_record` schema 0007 落地 + apply 端 detection hook、GUI sidebar 红点 + ConflictsPage 副本对比、token 三层防线（chmod 0600 + pino redact + CI grep）。一并清掉 P5-b 验收时遗留的 G1-G7 7 个手动 follow-up。

## 测试基线

- **干净 checkout `just test`**：**934/934**（dual e2e gated off）
  - `@owl/core`: 383（P5-b 314 → +69 P5-c：G4 +3、G5 +2、G6 +3、conflict_record 0007 schema +4、conflicts.ts helper +8、engine conflict hook +7、conflictsRecorded 初始 deepEqual +0（修原 case）、retry.ts withRetry +14、SyncConfig +4、scheduler tick path +0（daemon-side）、redact +6、logger redact +6、config chmod +2）
  - `@owl/cli`: 134（不变）
  - `@owl/daemon`: 210（P5-b 177 → +33 P5-c：sync-scheduler +3、health-probe +5、bridge-lifecycle mid-session +5、coalescer 边界 +0、conflicts routes +9、manual emit / ctx +1（implicit covered by manual route happy-path）、events :41 表驱动迁移 +0、misc +10 from D11 integration + 状态广播路径 retry tweaks）
  - `@owl/gui`: 207（P5-b 177 → +30 P5-c：G3 minDisplay +3、preload args +3、SyncStatusBar popover mask +2、conflicts-store +5、data-bus bumpConflicts +1、events-subscriber conflicts:changed +4、ConflictsNav +4、misc +8）
- **`SKYBRIDGE_E2E=1 just test-skybridge-e2e`**：**13/13**（P5-b 813 → +1 D11 gated + 0 net D14 因 D12 改 unit 留在 daemon scheduler.test）

`just check` 干净：5 个守卫 + lint + typecheck 全 pass（`skybridge-not-committed`、`core-convergence`、新增 `token-not-templated`）。

## 关键设计点变更（vs P5-b 时的预想）

- **D12 / D13 改单测**：原设计 §4 写了 D12 fake-timer e2e + D13 server 429 注入 e2e。落地时改成 daemon `scheduler.test.ts` fake timer 单测覆盖 D12 路径、core `retry.test.ts` + sse 路径覆盖 D13 retry 路径，因为：跑真实 fake clock 穿过 `runManualSync` → `runSync` → `client.pushChanges` 需要 mock 太深、维护成本远超价值。dual e2e 留 D11 + D14（真实的 in-process）。
- **conflict 检测 hook 写在 core `applyNoteChange` 里而不是 daemon**：原计划 §3 留过悬念。最终落地在 `engine.ts:maybeRecordNoteConflict`，因为这是核心 LWW 路径，daemon 没有 LWW 信息（只有 `RunSyncResult.conflictsRecorded` 计数）。daemon 仅负责把计数 > 0 翻成 `eventsBus.emit('conflicts:changed')`。
- **`losing_side` A 阶段固定 `'local'`**：B 阶段（folder / conversation conflict）才可能写 `'remote'`。当前 hook 也只在 op='update' + content 改的 case 写 — `create` / `trash` / `restore` / `delete` 一律不进 conflict_record。
- **conflict_record helper 是开放 dispatch**：`recordConflict({ entityType, ... })` 接受任意字符串，schema TEXT 字段也不带 CHECK constraint，所以 B/C 加新 entity_type / `'restored'`/`'merged'` resolution 不需要 migration。
- **token-mask 选了路 C（chmod + redact + grep guard）**：明文 toml 留着不动；safeStorage keychain 推 P5-d。理由：路 A (keychain) 改动太多 + 需要重设 token refresh 流程；路 B (整体加密 toml) 同理；路 C 足够防"日志 / UI 泄漏" + "world-readable 文件偷读"，把 0.5.0 内部 release 解锁掉再说。

## 15 个 commit（P5-c 主线）

| Step | Commit | 内容 |
|---|---|---|
| G4 | `c044e12` | `feat(skybridge): G4 mutations stamp notes/folders.device_id from local_metadata` —— mutation 路径读 `local_metadata.skybridge_device_id` 写 `notes.device_id` / `folders.device_id`，e2e D2 改本地断言；解决 P5-b §3.3 留下的 mutation 端 deviceId NULL 问题 |
| G5 | `ca9f86d` | `feat(notes): G5 createNote/updateNote trigger syncReminders synchronously` —— `/alarm` tag 出现/消失同步调 `syncReminders`，scheduler 仍兜底；e2e D10 不再依赖 scheduler tick |
| G6 | `cf19e2f` | `fix(tags): G6 drop 0-note orphan tags from default listHashtagTags branch` —— 非 frequent 分支加 JOIN + `HAVING COUNT(nt.note_id) > 0` |
| G7 | `3d72607` | `style(gui): G7 tighten folder tree row height h-7 → h-6` —— 行高与 NoteListItem 对齐 |
| G1 | `8a86b60` | `fix(gui): G1 thread daemon port through additionalArguments to preload` —— BrowserWindow `webPreferences.additionalArguments=[--daemon-port=${port}]` + preload argv 解析；renderer fallback 不动 |
| G3 | `a914e57` | `fix(gui): G3 enforce 400ms minimum display for SyncStatusBar syncing state` —— `stores/sync-status.ts` 加 `minDisplayUntilMs + setTimeout` 延迟非 syncing 切换 |
| G2 | `60faaee` | `test(skybridge): G2 integration D11 — done:true → onError → reconnect` —— 配合 skybridge `@skybridge/client@0.1.1` (`pumpStream` done:true 路径 fire `onError`)；owl 端 `sse-bridge.skybridge.e2e.ts` 双 gate（filename `.skybridge.e2e.ts` + `SKYBRIDGE_E2E=1`），D11 验证 server 优雅 shutdown → owl onError → 退避 → server 重启 → onOpen catch-up |
| Step 9 | `621910b` | `feat(skybridge): P5-c Step 9 — background sync timer` —— `[sync].interval_min` config（default 5 / `<=0` 禁用 / clamp 1 / 非法静默回退）；`sync/scheduler.ts start()` 用 `setInterval(...).unref()` 调 `runManualSync` 走 coalescer；`cli.ts:112` shutdown 序列接 stop() |
| Step 10 | `fbb356e` | `feat(skybridge): P5-c Step 10 — onError-window health probe` —— `sync/health-probe.ts` 每 10s `fetch(${serverUrl}/health, { signal: AbortSignal.timeout(3000) })` + `setInterval(...).unref()`；只在 SSE bridge 退避后启动，重连成功立即 stop；探针成功 cancel 退避计时器 + 强制重连；不改 SSE 退避序列 |
| Step 10b | `f73d052` | `feat(skybridge): P5-c Step 10b — mid-session lifecycle for SSE bridge` —— `manual.ts:187 doRunManualSync` 在 `ensureSkybridgeSession` 成功后 fire-and-forget 调 `ensureBackgroundHandles(ctx, logger)` 幂等启动 bridge + scheduler；ctx 加 `sseBridge?` / `syncScheduler?` 字段；reverse 方向（complete→incomplete stop）留 P5-d |
| Step 11 | `9d87a81` | `feat(skybridge): P5-c Step 11 — withRetry around HTTP push / pull` —— `sync/retry.ts withRetry({ maxRetries:5, backoffMs:[1000,2000,4000,8000,16000], jitterMs:500 })`，包 `client.pushChanges` + `client.pullChanges`；429 / 5xx / `NetworkError` retry；401 / 其他 4xx 立即 throw；retry 期间不翻 status；exhausted rethrow 原始错误（不包 `RetryExhaustedError`） |
| Step 12 | `29b88d4` | `feat(skybridge): P5-c Step 12 — 0007 conflict_record payload + apply-time detection` —— schema 0007 ADD COLUMN `losing_side` / `local_payload` / `remote_payload` / `local_updated_at_ms` / `remote_updated_at_ms` + `idx_conflict_unresolved` partial index；`LATEST_KNOWN_VERSION` 6→7；`sync/conflicts.ts` helper（recordConflict / listUnresolvedConflicts / countUnresolvedConflicts / ignoreConflict 软删）；`engine.applyNoteChange` 加 `ConflictSink`，op='update' + localExists + content 差异时写一行；`RunSyncResult.conflictsRecorded` |
| Step 13 | `efde1b3` | `feat(skybridge): P5-c Step 13 — conflict GUI plumbing (routes + SSE event + sidebar 红点)` —— daemon GET /conflicts + count + POST /:id/ignore；`OwlEvent` 加 `conflicts:changed`；`manual.ts` `conflictsRecorded>0` 时 emit；GUI `EventsSubscriber.tsx` 重构成 `EVENT_TYPES` 表驱动；`conflicts-store.refresh()` + `data-bus.bumpConflicts`；MainApp mount 时冷启动 fetch；ConflictsPage + ConflictsNav（count>0 显示，cap 99+） |
| Step 14 | `adfb349` | `feat(skybridge): P5-c Step 14 — token-mask defenses (路 C)` —— chmod 0600 unix-gated regression 单测；`createLogger` + `createConsoleLogger` 默认 pino redact paths（`*.token` / `*.auth.token` / `authorization` / `headers.authorization` / `req.headers.authorization`）；`scripts/check-token-not-templated.sh` CI grep 守卫 + 接进 `just check`；`core/skybridge/redact.ts redactToken` helper；GUI SyncStatusBar popover mask 单测；CLAUDE.md 补关键字 |
| Step 15 | _本 commit_ | `docs(skybridge): P5-c shipped + manual checklist M1-M8` —— `docs/plans/2026-05-24-p5-c-manual-checklist.md` 完整 M1-M8 + 通过标准 + 回归手段；`docs/history/P5-c-shipped.md` 本文件 |

## 关键不变量（P5-c 新增，编号续 P5-b 14）

15. **`conflict_record` 不进 sync_changes** — detection-time 本地状态，每台设备 LWW lose 情况不同；不 emit、不 push、不参与 sync engine。helper 设计成开放 dispatch（接受任意 `entity_type` + JSON payload），B/C 阶段加多类型不需要 migration。
16. **conflict 写入条件单一** — 仅 `applyNoteChange` 处理 `op='update'`、`localExists`、`content` 字段存在 且 内容不同 时写一行（隐含 `localTs < remoteTs`，因为 LWW gate 先 skip）；LWW skip / self-replay / create / delete / trash / restore / folder / conversation 都不写。`losing_side` A 阶段固定 `'local'`。
17. **conflict_record "忽略" 是软删** — `UPDATE SET resolved_at=now, resolution='ignored'`，**绝不 DELETE 行**。前向兼容 B 阶段「已解决历史」需求；route 二次 ignore 返回 404 而非 200（区分"已处理"vs"新处理"），不重复 emit。
18. **conflict_record schema 无 CHECK constraints** — `entity_type` / `losing_side` / `resolution` 都是 TEXT 开放 enum，校验只在 TS 层；B/C 加 `'restored' / 'merged'` 值不需要 migration。
19. **conflict 事件桥**：`@owl/core` `runSync` 通过 `RunSyncResult.conflictsRecorded` 返回计数；`@owl/daemon` `manual.ts` 在 `markSuccess` 后若 > 0 才 `ctx.eventsBus.emit({type:'conflicts:changed'})`；GUI `events-subscriber-core.ts` 收到事件后 `refreshConflicts()` + `bumpConflicts()`；payload-free，count 由 GET /conflicts/count 取。core 永远不接 `ctx.eventsBus`（保持 P5-b 不变量）。
20. **三源后台 sync 走同一 coalescer** — SSE 触发 / 定时 tick / onError 退避期探针恢复重连 / 手动 POST 全部经 `runManualSync` → P5-a F3 coalescer；不会同时打 server 两次。
21. **HTTP retry 不翻 status** — `withRetry({ maxRetries: 5 })` 期间 `sync:status_changed` 保持 `syncing`，retry 全部失败（6 attempts 都没成功）才翻 `error`；GUI 视觉上对 429 抖动免疫。retry exhaust 抛**最后一次原始**错误（`ApiError.status` 保留），不包成 `RetryExhaustedError`。
22. **SSE 重连退避 与 HTTP retry 退避 独立** — SSE 是连接级故障，HTTP 是请求级故障；两者各自策略 + 各自计时器；仅在 SSE onError 进入退避时启动 10s `/health` 探针作为副产物加速恢复（SSE backoff cap 30s 时探针有 2-3 次机会先于 SSE 自重连）。
23. **onError 退避期探针只覆盖显式 disconnect** — 不假设 SSE 长时间挂着（onError 不触发的下行卡死）能恢复；正常连接期间不探，节省 server 压力；SSE idle watchdog 留 P5-d 看真实双机数据再决定。
24. **`[sync].interval_min` 是独立 config 字段** — 不复用 `[daemon].poll_interval_min`（后者是 reminder scheduler）；缺省 5 / `<=0` 禁用 / `0 < x < 1` clamp 1 / 非法值**静默回退默认 5**（core 层不 log，loadConfig 是纯读函数）。daemon scheduler 启动时 info-log 一次 effective 值给运维看。
25. **mutation 路径填 `notes.device_id`** — P5-b 留下的 G4：`createNote/updateNote/createFolder/updateFolder` 用 `input.deviceId ?? readSkybridgeDeviceId(sqlite) ?? null`；apply 路径仍由 `ServerChange.deviceId` 填（不变）。
26. **mutation 路径触发 `syncReminders`** — `/alarm` tag 出现 / 消失时同步调 `syncReminders`；scheduler 保留作兜底，但不再是单一来源。
27. **token 不入 log / UI / world-readable file（路 C 安全模型）**：
    - 文件：`skybridge_config.toml` unix 系统 `chmod 0600`（`config.ts:177`，单测守 regression）
    - 结构化 log：`createLogger` + `createConsoleLogger` 默认 pino redact `*.token` / `*.auth.token` / `authorization` / `headers.authorization` / `req.headers.authorization` 都盖 `[REDACTED]`
    - 字符串拼接：靠 `just token-not-templated` grep 守卫（`${...token...}` / `+ ...token` 模式）拦下；pino redact 盖不住模板字符串
    - UI：sidebar `SyncStatusBar` popover 只渲染 `SyncStatusSnapshot`（无 token 字段），单测正向断言不含 `token` / `authorization` / `Bearer`
    - safeStorage keychain 加密 **不在 P5-c**，留 P5-d 与 token refresh / device pair 一起重设
28. **`withRetry` 失败抛原始错误** — 不包成 `RetryExhaustedError`；`ApiError` 保留 `.status`、`NetworkError` 保留 cause，确保 daemon `manual.ts:130` `translateSkybridgeError` / `statusForError` 能正确翻 HTTP status；retry 次数 / 间隔只进 daemon log 不进抛出错误本身。
29. **conflict losing local outbox 仍 push（接受语义）** — `runSync` 先 pull 后 push（`engine.ts:701/:741`），B 端 apply 远端覆盖本地 + 写 conflict 后，本地原 outbox 那条 pending `sync_changes` 仍会同轮 push 上 server log。其他设备靠 LWW skip 不会改写本地表，但 server log 会留这条 losing change。**P5-c 不做 outbox suppression**，留 P5-d 与 server retention 一起重审。
30. **GUI 新增 OwlEvent 必须在 `EventsSubscriber.tsx` 显式 addEventListener** — SSE EventSource 按 event name dispatch；`EVENT_TYPES` 常量数组是 source of truth，加新事件改一处（数组 + handler 分支），不会漏注册。
31. **后台 timers 必须有 stop handle + unref** — scheduler / health-probe 全部 `setInterval(...).unref()`，启动返回 `{ stop() }`，接进 `cli.ts:112` shutdown 序列；teardown 后无 dangling timers，避免 daemon hang exit / 测试残留计时器。
32. **mid-session bootstrap 单向** — daemon 运行期间 toml 从 incomplete 变 complete（首次 login + sync run）时通过 `ensureBackgroundHandles` 拉起 SSE bridge / scheduler，幂等。**反向（complete → incomplete）不在 P5-c 处理**，留 P5-d 与 logout 流程一起设计。boot 路径不变（P5-b 行为保留）。
33. **GUI conflict count 必须有冷启动 fetch** — `conflicts-store.refresh()` 在 `MainApp` mount 时拉一次 `/conflicts/count`，不依赖 `conflicts:changed` 事件触发；否则 GUI 重启后已有未解决冲突时红点不会显示。

## P5-c 故意不做的事（留 P5-d / P6）

- **safeStorage keychain 替换明文 token** — 路 A，P5-d 与 token refresh / device pair 一起重设
- **mid-session reverse（complete → incomplete）** — logout / 切账号路径 P5-d
- **conflict outbox suppression** — 现行接受语义（不变量 §29），P5-d 与 server retention 一起重审
- **conflict B 阶段（folder / conversation）** — A 阶段只覆盖 note update
- **真实双机 soak / 远程 server soak** — 本 step 所有 e2e 仍是 in-process skybridge
- **SSE idle watchdog（onError 不触发的下行卡死）** — 等真实双机数据再决定
- **attachment 通道 / snapshot 拉取 / 多 workspace 切换** — 留 P6

## 怎么跑（开发者）

```bash
# 1. skybridge 仓产 tarball（client@0.1.1）
cd ../skybridge
just pack-all

# 2. owl install
cd ../owl
just skybridge-install
just ensure-node-abi
(cd node_modules/better-sqlite3 && pnpm run install)

# 3. 起 skybridge + owl daemon + GUI 全套
just dev-skybridge

# 4. 跑自动化双 profile e2e（含 D11 + D14）
SKYBRIDGE_E2E=1 just test-skybridge-e2e
# 期望：13/13 pass

# 5. 跑 M1-M8 手动 checklist
# 见 docs/plans/2026-05-24-p5-c-manual-checklist.md

# 6. 调试完恢复
just skybridge-uninstall
just check                       # 5 个守卫 + lint + typecheck 全过
```

## 自动化验收（2026-05-25）

`SKYBRIDGE_E2E=1 just test-skybridge-e2e`：

| 用例 | 验证 | 结果 |
|---|---|---|
| D1-D10 | P5-b 基线（见 [P5-b-shipped.md](./P5-b-shipped.md)） | ✅ 10/10 |
| D11 | skybridge server 优雅 shutdown → owl client SSE done:true → onError → 退避重连 → server 重启 → onOpen catch-up sync | ✅ |
| D14 | concurrent edit：B 离线编辑 T1，A 编辑 T2>T1 push；B 后 sync → apply 远端 + 写 1 行 conflict（`losing_side='local'`，content 副本完整）；A 侧 conflict_record delta = 0 | ✅ |
| baseline | server bootstrap surface present | ✅ |

`D12 / D13` 用单测覆盖（不进 e2e）：
- D12 — 后台定时触发：`daemon/src/sync/scheduler.test.ts` fake timer 5 min tick
- D13 — HTTP retry：`core/src/sync/retry.test.ts` 6 attempts / 1-2-4-8-16s + jitter + 401 不 retry + exhaust rethrow

## 设计文档 & 后续

- 计划文档：[2026-05-24-p5-c-plan.md](../plans/2026-05-24-p5-c-plan.md)（v5 锁定）
- 手动 checklist：[2026-05-24-p5-c-manual-checklist.md](../plans/2026-05-24-p5-c-manual-checklist.md)
- 跨仓架构：`aviary/docs/SKYBRIDGE_ARCH.md`（Phase 4-c）
- skybridge 仓配套：`skybridge/PROCESS.md`（client@0.1.1 release + owl P5-c 集成）

下一步 **Step 16-aviary**（ROADMAP + SKYBRIDGE_ARCH 标 shipped）→ **Step 17-skybridge**（PROCESS.md client@0.1.1）→ **Step 18**（手动 M1-M8 全过 + 0.5.0 版号 bump + GUI + CLI tag + release + npm publish）→ **0.5.0 内部 release**。
