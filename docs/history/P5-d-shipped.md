# P5-d shipped — per-profile 账号隔离 + 免密快切 → owl 0.5.0

> 归档自 PROCESS.md（2026-06-06，0.5.0 发版后整理）。P5-d 跨 22 个 phase（2-23），把 owl
> 从「单账号同步」推进到「多账号 per-profile 隔离 + 免密快切」，并完成 0.5.0 公开发版。
> 每个 phase 的完整设计 + 实施记录在对应 `docs/plans/` 子设计文档的 §实施记录段（下表索引）。

## 发版结果 — owl 0.5.0（2026-06-06）

- **GitHub Release**：https://github.com/orpheus-aviary/owl/releases/tag/v0.5.0 （Latest）
- **dmg**：`Owl-0.5.0-arm64.dmg`（124M，afterPack `scripts/codesign-adhoc.mjs` ad-hoc 签名），
  sha256 `a158ebd54940fb47a7b3a9aceef5c5e87157be3390f8da29038d45105702c2ce`
- **tag**：`v0.5.0`（GUI）+ `cli-v0.5.0`（CLI），均指向 owl `594f9b5`
- **CLI npm**：`@orpheus-aviary/owl-cli@0.5.0` = latest
- **依赖**：skybridge server **0.1.4**（npm latest：proto/client/server）
- **用户可见 release notes**：`docs/history/0.5.0-release-notes.md`
- **跨仓**：aviary `94c9284`（ROADMAP 标 0.5.0 shipped）；skybridge `6c7ed5b`（部署指南）
- **最终基线**：core **528** / daemon **290** / cli **137** / gui **399** + gated e2e **25/25**；
  `just check` 8 守卫全绿。

## 父设计 + 决策权威

- **父设计**：`docs/plans/2026-05-29-account-profile-isolation-design.md`（**v6 定稿，以 §0.5 决策总账为准**）
- **模型（终态）**：`profile = (server_id, user_id)`，`profileId = sha256(server_id, user_id)` 前 32 位。
  锚点 **server_id**（skybridge 配置长随机标识，可迁移带走，换 url 不丢工作区，D11/W1）。
  每账号 `profiles/<id>/owl.db`；**local = `owl/owl.db` 原地**（D10a）。**账号同步永不写 local**（不变式）。
  导入仅「认领空账号」（D10b）。免密快切并入 0.5.0（refresh-token 带轮换，D2/W4）。
  LWW 时间戳改 server 归一化 offset + counter（W3）。

## Phase 索引 + commit 表

| Phase | 内容 | 关键 commit | 子设计 |
|---|---|---|---|
| 2-5 | skybridge SDK 三 additive API（logout/listDevices/subscribeEvents onFrame）+ npm `@next`/`latest` 0.1.3 | skybridge `220cc50`/`1f56edc`；owl `74066bb`/`41a699d` | `2026-05-26-p5-d-design.md` |
| 6-7 | daemon `POST /sync/session`(replace) + `/sync/logout-local` + 删 `/sync/login` + dev 双 env gate；GUI main `sync-auth.ts` safeStorage keychain（唯一明文+密文持有者）+ `restoreSessionOnStartup` | `90993ec`…`bfe2528`（8 个） | `2026-05-26-p5-d-design.md` |
| 8-9 | GUI Settings 同步 tab（`owlAPI.sync` 唯一登录入口）+ 中文 ErrorCode 映射 + 5 bash 守卫 | `191fd66`/`5e4916a`/`ef6a7cd` | `2026-05-28-p5-d-phase-8-9-design.md` |
| 10 | 设备列表 GUI（DevicesCard）+ daemon plaintext bootstrap 退役（`ensureSkybridgeSession` 不读 toml + `daemon-no-toml-write` 守卫，8→8 子任务） | `e8106c6`/`44427b9`/`6e9237b` | `2026-05-29-p5-d-phase-10-design.md` |
| 11 | **SSE idle watchdog**（60s 半开/下行假死检测，`SSE_IDLE_TIMEOUT_MS=60_000` + onFrame 喂狗，skybridge 零改动） | `d998d13` feat / `ca0415a` docs | `2026-06-06-sse-idle-watchdog.md` |
| 12 | profile 地基：core resolver（三入口切）+ redact globs（behavior diff=0）**已 push** | `45eef1e`/`a4c61bd`/`d15c9cd` | `2026-05-29-phase12-profile-foundation.md` |
| S | **skybridge 0.1.4 server**：server_id（db `server_meta`+config 覆盖）+ 权威时间 + refresh 轮换（replaced_by 区分 replay/invalid）+ device revoke + lazy-bind | skybridge 7 commit + `db50768` bump | skybridge `2026-05-30-phase-S-skybridge-0.1.4.md` |
| 13 | 存储+迁移（plumbing）：`localProfileDbPath()`→`owl/owl.db`(D10a) + 单一 `resolveActiveProfile()` 三重 gate + config adapter raw read-modify-write。W2 迁移 = no-op（强制留 local） | `c4da3f1`/`9b61ae0`/`f9113f7` | `2026-05-30-phase13-storage-migration.md` |
| 14 | daemon switch（plumbing）：`switchProfile` §5.4.2-bis 完整状态重建 + `SwitchGate`（串行 + swap 期 drain，mutating 请求 503） | `c4f2240`/`da3e900`/`ae7c61a` | `2026-05-31-phase14-daemon-switch.md` |
| 15 | 登录/切换/登出 + refresh（live）：`computeProfileId(server_id,user)`(D11) + `encrypted_refresh_token` + `POST /sync/switch` + GUI login per-profile(B9) + restore refresh-first + proactive 续期 timer | `eff7e1e`/`1795b90`/`c8308e4`/`133af6c`/`386388c` | `2026-05-31-phase15-login-refresh.md` |
| 插队 | 已登录态直接添加新账号（多账号 add，语义 A；登录守卫作废） | 2 slice（落 main） | `2026-06-02-add-account-while-logged-in.md` |
| 16 | import 守卫 + renderer 受控 reload(B7) + 认领空账号弹框(D10b/W6) + **W3 HLC-lite**（`0009_lww_counter.sql` + 三元 LWW `cmpLww`） | `3d19ded`/`4dfbbbe`/`e3472f9` | `2026-06-01-phase16-import-renderer-w3.md` |
| 17 | GUI 账号/设备管理：手动同步(W8) + 免密快切下拉(W4) + 移除设备(W9) + 删除账号本地副本 + 提醒仅 active 文案(W5)。+ fix setTimeout 32 位溢出（30 天续期 timer 死循环） | `58fc3f5`/`7bc2a59`/`66906c8`/`6cecd19` + `ef059b2` | `2026-06-01-phase17-gui-account-device.md` |
| 18 | 本地全链路 per-profile e2e（`profile-chain.e2e.ts` 9 用例 P0-P8，含 D10b 语义铁证），gated e2e 16→25 | `88c2987` | `2026-06-03-phase18-local-full-chain.md` |
| 19 | 阿里云 Ubuntu 部署 skybridge 0.1.4（明文 HTTP + 安全组锁源 IP + systemd）+ promote 0.1.4→latest + 真机 smoke S1-S5a | `ab4cda6`（docs） | `2026-06-03-phase19-deploy-promote-smoke.md` |
| 20 | W12 备份恢复（删不复活 + 1 条「远端胜出」预期安全）+ 网络中断 + W3 错钟（libfaketime +10d，错钟不成黑洞）。owl 零生产代码改动 | `ab4cda6`（docs） | `2026-06-04-phase20-soak-clockskew-recovery.md` |
| 21 | CLI compat 收尾（sync login 退役→跳 GUI）+ W10 switch lockfile + GUI 切换并发安全（三层正交：单实例锁 / switch mutex / 跨进程 lockfile） | `6b5d658`/`fde19b9`/`8559ed6`/`6448609`/`a675f7d` | `2026-06-05-phase21-cli-compat.md` |
| UX 批 | 待办页按创建顺序排序 + 冲突页「复制输方全文」+「打开笔记」+ 长文限高 | `9a66e6c`/`62d0591`/`29eb67d` | — |
| 22 | owl 0.5.0 bump（version.ts/gui/cli 三处 + 退役 `0.5.0-dev` + release notes） | `0ddc6a1`/`594f9b5` | — |
| 23 | 对外发版：三仓 push + tag v0.5.0/cli-v0.5.0 + GitHub Release（dmg, Latest）+ npm `owl-cli@0.5.0` | push/tag/release/publish | — |

## 基线演进（单元测试）

957（0.4.2）→ 1016（P6+7）→ 1062（P8+9）→ 1096（P10）→ ... → **core 528 / daemon 290 / cli 137 / gui 399**（0.5.0）。
gated e2e：13 → 16（P4/SDK smoke）→ **25**（P18 profile-chain +9）。`just check` 守卫：4 → 5 → 7 → **8**。

## 关键不变量（载重，编号续 P5-c §33）

**Phase 6-7（§34-44）**：daemon 生产路径不读 env token（dev 双 gate `OWL_DAEMON_DEV_TOKEN`+`OWL_ALLOW_INSECURE_DEV_TOKEN`，prod 硬 panic）；`/sync/session` replace 语义（stopBackgroundHandles→清旧→install 新→restart）；bridge-lifecycle 优先 ctx 缓存；`SkybridgeAuthSection` transitional schema（`token?`+`encrypted_token?`）；GUI main 是唯一 safeStorage 调用者（token 只在函数局部）；`loginAndOpenSession` 步骤顺序锁死（POST /sync/session 后才写 toml，满足失败 unwind 不写）；`restoreSessionOnStartup` 拒 fallback plaintext；`OWL_GUI_PARENT_PID` 10s 探测闭环；`OWL_APP_VERSION` 单源 `core/version.ts`。

**Phase 8-10（§45-54）**：`owlAPI.sync` 是 renderer 唯一登录入口；single display truth（展示字段只从 `sync:status` 读）；`extractSession` 与 `restoreSessionOnStartup` 同 gate；shared 类型物理边界（`packages/gui/src/shared/`）；5 bash 守卫；`ensureSkybridgeSession` 不读 toml（抛 `SkybridgeAuthRequiredError`）；daemon source 不写 toml（`daemon-no-toml-write` 守卫）；`persistSkybridgeIds` 由 `installSkybridgeSession` 独占；`/sync/devices` 不触发 lazy bootstrap（SDK error 必先经 `translateSkybridgeError`）；设备列表 `is_current` 由 main IPC 计算。

**Phase 12-21（profile 隔离 + 并发安全）**：profileId 锚 server_id（D11，缺 server_id 报错不回退 url-key，R5）；`resolveActiveProfile()` 三重一致 gate（active hex + `[profiles.<id>]` 段存在 + profile db 存在，缺一→legacy）；config adapter active 非 null 但 section 缺 = fail-closed throw；账号同步永不写 `owl/owl.db`（D10b 语义：`synced_at IS NULL` = pending）；切换/停用不 revoke 保 device 复用（仅完全登出/删副本才 revoke）；switchProfile throw=abort/resolve=committed；`restartDaemonCtx()`/switch 拆建必做序（scheduler.stop→stopBackgroundHandles→drainManualSync→close→`__resetInflightSync()`）；long-lived `setTimeout` 必分段（>24.8 天溢出→1ms 触发，`ef059b2`）；三层并发正交（单实例锁 A / switch mutex B（含 prompt）/ 跨进程 lockfile C（仅 critical section），mutex⊃lockfile，refresh 走 mutex 不碰 lockfile，显式 `--db` 不 gate）。

**Phase 11 watchdog**：watchdog 不依赖 close→onError；onOpen 武装 60s（`SSE_IDLE_TIMEOUT_MS`，=2×25s ping+10s）、onFrame 重置、超时 abort 僵尸+markOffline+health-probe+重连；clear 收敛到 scheduleReconnect 单一 choke-point；阈值写死非用户旋钮。

## 真机手测（隔离 nest + 真 0.1.4 server）

- Phase 10 手动 e2e 9/9；Phase 15 真机 e2e 全过（per-profile toml + profile db 生成 + local 零污染 + device 复用 + proactive 续期 + refresh 轮换 + 重启免密 restore）；Phase 16 16a/16b 真机（claim 并入 + reload + D10b 铁证）；Phase 17 全过（快切 / 移除设备 / 删副本，暴露并修 setTimeout 溢出 bug）；Phase 19 真机 smoke S1-S5a；Phase 20 W12/网络/错钟。
- **真机/部署 carry-forward**（复用必带，详见 next-session brief memory + `skybridge/docs/deploy/ubuntu-baota.md`）：profile/auth 配置在 `<nest>/skybridge/skybridge_config.toml`（chmod 0600）非 owl_config.toml；better-sqlite3 ABI 冲突（Electron vs Node，不能同跑，跑 standalone 先关 GUI + `just ensure-node-abi`）；libfaketime 注不进 Electron；标准 rig recipe 隔离 nest 种笔记。

## 0.6+ backlog（设计 §11「0.5.0 之外」+ §13 carry-forward）

- **W7** 冲突双向可见 + 手动解决/合并（赢方可见 + 「用本地版本覆盖」+ `@codemirror/merge` 2-way + `conflict_record` counter 列）
- **W11** 附件同步传播（0.5.0 = local-only，不丢 attachmentRefs）
- 跨 profile 统一视图 / 跨账号导入 / local→非空账号导入（0.5.0 只支持认领空账号 D10b）
- `resetAllStores(epoch)` 免闪烁切换（替代整窗 `location.reload()`）
- **TLS / 反代**（0.5.0 是明文 HTTP + 安全组锁源 IP；占位 Caddy 方案）
- 真·24h soak（Phase 20 T4 降范围跳过，云已拆需重部署）
- **P6 = skybridge Phase 5 多设备 GA → owl 1.0.0**
