# P5-c — M1-M8 手动 UI 验收清单

> 2026-05-25。 配套 `docs/history/P5-c-shipped.md`（实施记录）+ `docs/plans/2026-05-24-p5-c-plan.md`（设计 v5）。
>
> P5-c Step 1-15 已通过自动化基线（**core 383 / daemon 210 / gui 207 / cli 134 = 934** + gated e2e **13/13**），还有 8 项视觉/集成验收靠人眼来做。M1-M8 在 0.5.0 release 前必须全过。

## 怎么准备环境

```bash
# 1. skybridge 仓产 tarball
cd ../skybridge
just pack-all

# 2. owl install + ABI 修
cd ../owl
just skybridge-install
just ensure-node-abi
(cd node_modules/better-sqlite3 && pnpm run install)

# 3. 前台跑 skybridge server + owl daemon + owl GUI（默认 :47010 profile A）
just dev-skybridge
```

二号 profile（只在 M6 / M7 需要双机；M1-M5 / M8 单端就够了）：

```bash
# 三个终端：profile B daemon + GUI 各占一个
OWL_NEST_DIR=$HOME/orpheus-aviary-nest-B just dev-daemon
OWL_NEST_DIR=$HOME/orpheus-aviary-nest-B OWL_DAEMON_PORT=47011 just dev-fast
```

清完调试残留：

```bash
just skybridge-uninstall
just check                       # 守卫不报 = manifest 干净
```

---

## M1 — G7 文件夹树行距收紧

**对应改动**：`FolderPanel.tsx` / `FolderTreeItem.tsx` 行高 `h-7 → h-6`（commit `3d72607`）。

**步骤**：

1. 启 owl GUI。
2. 任意打开有 ≥ 5 个文件夹的 nest（如果 nest 干净就先在 sidebar 顶上加 5 个 dummy）。
3. 切换 sidebar 看到文件夹树。
4. 视觉对比 sidebar 右侧 NoteList 每条 note 的行高 —— 文件夹 row 与 note row 上下间距应该接近一致，没有"文件夹比笔记胖一圈"的视感。
5. 删 dummy 文件夹。

**通过标准**：行距视觉对齐；如果还感觉文件夹 row 偏胖，量一下 DevTools `h-6` 实际 px（应为 24px）。

---

## M2 — G6 全部 trash 后 tag 消失（不再出现 0-note tag）

**对应改动**：`tags/list.ts` 非 frequent 分支加 JOIN + `HAVING COUNT(nt.note_id) > 0`（commit `cf19e2f`）。

**步骤**：

1. 创建 3 条新 note，每条带同一个 `#完全没人用` tag（GUI 编辑框内键入）。
2. 切到 sidebar TagBar 弹窗（点 tag 入口），确认 `#完全没人用` 显示在列表里。
3. 全选这 3 条 note → 移到回收站（trash）。
4. 重新打开 TagBar 弹窗。

**通过标准**：`#完全没人用` 不再出现。

**回归**：把其中 1 条从 trash 还原 → `#完全没人用` 应该回到 TagBar。

---

## M3 — G3 syncing 蓝旋至少 ~400ms 可见

**对应改动**：`stores/sync-status.ts` 加 `minDisplayUntilMs = 400ms`（commit `a914e57`）。

**步骤**：

1. 启 skybridge server + daemon + GUI（profile A）。
2. 在 owl GUI 里创建/编辑任意 note。
3. 紧接着触发 `POST /sync/run`（CLI: `owl sync run`，或 sidebar SSE bridge 自动；要 reliably 触发可手动跑 `curl -XPOST http://127.0.0.1:47010/sync/run`）。
4. 盯左下 SyncStatusBar 状态徽章。

**通过标准**：从 `markSyncing` → `markSuccess` 即便 in-memory 跑完 < 50ms，徽章上的蓝色旋转动画也能肉眼看到 ~400ms（数 1, 2）。

**对照**：去掉 G3 之前（参考 P5-b 手动验收记录），同样路径下 spinner 几乎不可见。

---

## M4 — G1 OWL_DAEMON_PORT 透传到 renderer

**对应改动**：`main/window.ts` BrowserWindow `additionalArguments` + `preload/index.ts` argv 解析（commit `8a86b60`）。

**步骤**：

1. 关掉所有现有 owl GUI 实例。
2. 起 profile B daemon：`OWL_NEST_DIR=$HOME/orpheus-aviary-nest-B just dev-daemon`（实际监听 :47011，由 `[daemon].port` 自动让路 OR `OWL_DAEMON_PORT=47011` 显式指定）。
3. 启 GUI：`OWL_NEST_DIR=$HOME/orpheus-aviary-nest-B OWL_DAEMON_PORT=47011 just dev-fast`。
4. GUI 起来后 `Cmd+Opt+I` 打开 DevTools console。
5. console 里输入：`window.owlAPI.daemonUrl`。

**通过标准**：返回 `'http://127.0.0.1:47011'`。

**回归（兜底）**：刻意不设 `OWL_DAEMON_PORT` → renderer fallback 到 `'http://127.0.0.1:47010'`（不崩溃）。

---

## M5 — 冲突页 + sidebar 红点

**对应改动**：Step 12 schema 0007 + Step 13 GUI plumbing（commit `29b88d4` + `efde1b3`）。

**步骤**：

1. 启 profile A + B（两套 daemon + 两个 GUI），都 `owl sync login` + `owl sync run` 完成 bootstrap。
2. **B 侧**先编辑一条 note（任何内容），暂时**别 sync**（关掉 SSE 自动同步：直接 quit B daemon 也行，或 ctrl-Z 暂停后台 sync 进程）。
3. **A 侧**改同一条 note，内容不同。`owl sync run` → A 上 server。
4. 重启 B daemon（或解 ctrl-Z），等 SSE bridge 自动 catch-up sync。
5. B 侧 GUI 左侧 sidebar 应该出现 `冲突` 入口（黄色 ⚠ icon），右上角红点数字 `1`。
6. 点进入 → 看到一行：左 = 本地副本（B 离线那版），右 = 远端胜出（A 那版），时间戳标注两侧 updated_at_ms。
7. 点 `忽略`。
8. sidebar `冲突` 入口消失（count → 0 自动隐藏）。
9. 直接 query DB 验证软删：`sqlite3 ~/orpheus-aviary-nest-B/owl/owl.db "SELECT id, resolved_at, resolution FROM conflict_record WHERE entity_id='<the-note-id>';"`。

**通过标准**：
- 冲突自动检测、红点显示 count、点击进入 ConflictsPage 看到 local + remote 副本与时间戳；
- 忽略后 sidebar 入口消失；
- DB 行未 DELETE（`resolved_at` 非空，`resolution='ignored'`）。

**注意**：如果 step 3 时 B 已经被 SSE 推过 A 的更新，B 本地变成 A 那版（LWW apply）— 不会写 conflict（content 一致）。要确保 B step 2 编辑后**严格离线**到 step 3 之后再上来。

---

## M6 — SSE 死时定时兜底 sync

**对应改动**：Step 9 后台定时 sync（commit `621710b`）。

**步骤**：

1. 启 profile A 全套（skybridge + daemon + GUI）。`tail -f ~/orpheus-aviary-nest/owl/logs/daemon.log` 在另一个终端。
2. 确认 A bootstrap 完成（`owl sync run` 一次，daemon.log 出现 `kind:'sync'` line）。
3. **SIGKILL skybridge server**：`pkill -9 -f 'skybridge server'`。
4. owl daemon 的 SSE bridge `onError` 后进入退避（30s cap），sidebar 切到 **离线**。
5. **不**重启 skybridge。等 5 分钟（`[sync].interval_min` 默认）。
6. 5 分钟后 daemon.log 会出现 `kind:'sync-scheduler'` 触发的一次尝试。
7. 因为 skybridge 还没回来，这次 sync 也会失败（看 daemon.log 里 `markError` / `SkybridgeServerUnreachableError`），但**有发生过**就够了。

**通过标准**：daemon.log 在 SSE 死后第 5 分钟出现一条 sync-scheduler 触发的 runSync attempt。

**对照**：去 owl_config.toml 改 `[sync].interval_min = 0`（禁用）→ 不应该看到 scheduler 触发。

---

## M7 — SSE 断后 60s 内重连成功

**对应改动**：Step 10 onError 退避期 10s `/health` 探针（commit `fbb356e`）+ Step 10b mid-session lifecycle（commit `f73d052`）。

**步骤**：

1. 与 M6 同样的起点（skybridge + daemon + GUI 都跑着，A bootstrap 完）。
2. **SIGKILL** skybridge。
3. SyncStatusBar 切到**离线**橙色。
4. **30s 内**重启 skybridge：`(cd ../skybridge && just dev)`。
5. 盯 GUI 状态栏。

**通过标准**：60s 内 SyncStatusBar 切回**已同步**蓝/灰。可能是 SSE 自身退避到点重连成功（最坏要等下一个 backoff 槽位，2/4/8/16/30s），也可能是 10s `/health` 探针先一步收到 200 OK 然后强制重连。**不强依赖看 `health-probe ok` 关键字** — 10s 探针 vs SSE 自然退避谁先成功不可预期，验「能不能 60s 内重连」就好。

**对照**：注释掉 `health-probe.ts` 里 `cancelBackoff + forceReconnect` 调用 → 必须等 SSE 退避自己重连，30s 槽位很可能 60s 内打不上。

---

## M8 — Token 不泄漏

**对应改动**：Step 14（commit `adfb349`）。

**步骤**：

1. 在 profile A 上 `owl sync login` 已经完成（toml 里有 `[auth].token`）。
2. **文件权限**：`stat -f '%Lp' ~/orpheus-aviary-nest/skybridge/skybridge_config.toml`
   - 通过：返回 `600`。
3. **日志全文 grep token**：
   ```bash
   # 把 toml 里的 token 复制出来（首 12 char 足够 — 短的也只占 8）
   TOK=$(grep '^token' ~/orpheus-aviary-nest/skybridge/skybridge_config.toml | head -1 | awk -F'"' '{print $2}' | head -c 12)
   echo "Looking for: $TOK"
   grep -F "$TOK" ~/orpheus-aviary-nest/owl/logs/*.log
   ```
   - 通过：`grep -F` 0 命中（命令 exit code = 1）。
4. **GUI sidebar popover 不显示 token**：
   - 鼠标点左下 SyncStatusBar 状态徽章。
   - 在 popover 里目视检查；浏览器 DevTools `Cmd+Opt+I` → Elements → 找到 `[data-testid="popover-content"]`，全文搜 12 字符 token 前缀。
   - 通过：popover 文本里没有 token 子串。

**通过标准**：3 条全过。

**回归**：
- 故意把 `chmodSync(filePath, 0o600)` 注释掉（不要 commit），重写 toml，再 `stat -f '%Lp'` 应该不是 `600`（macOS 默认 `644`）— 这条改回去后再测保险。
- 故意在 daemon 里加一行 `ctx.logger.info({ kind: 'debug', tok: cfg.auth.token })`，**不要** commit；重启 daemon 跑一次 sync → grep `daemon.log` 应该全是 `[REDACTED]` 而不是原 token（pino redact `*.token` 路径会盖）。
- `just token-not-templated` 守卫：在 `packages/daemon/src/sync/manual.ts` 加一行 `` logger.info(`token is ${session.token}`) ``（**不要 commit**），跑 `just token-not-templated` 应该报错。改回去。

---

## 完整通过后

把这个 doc 的 [M1] [M2] ... 每行前面 `<input type="checkbox" checked />` 一下（或在 git commit message 里记一句"P5-c M1-M8 all green"）。然后进 Step 18：

- bump `package.json` version 0.4.1 → 0.5.0（GUI + CLI 都改）
- 打 `v0.5.0` git tag
- electron-builder 出 release artifact + GitHub release
- `pnpm publish` CLI（`@owl/cli`）到 npm
