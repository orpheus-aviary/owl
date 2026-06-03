# Phase 20 — 真机 soak + 错钟(W3) + 备份恢复(W12) + 强制场景

> 状态：**计划稿 v1（2026-06-04）**。父设计 `2026-05-29-account-profile-isolation-design.md`（§11 时序 / §13 W3·W12）。
> 前置：Phase 19 部署 + S1-S5a smoke 全过（云 server `47.99.215.39:8443` 0.1.4 在跑；mac rig `/tmp/owl-p19` 保留）。**promote 暂 park，soak 验稳后再移 latest。**
> 本 Phase 主体是真机手测 + 长跑观察；多为用户 GUI 操作 + Claude 文件/API/server 核验。**预期无 owl 生产代码改动**（除非测出 bug）。

## 0. 决策（2026-06-04）
| 项 | 选定 |
|---|---|
| W3 错钟设备造法 | **libfaketime 起第二 owl 实例**（第二隔离 nest，伪造该进程时钟偏移；不动真实系统时钟）。需 `brew install libfaketime` |
| soak 时长 | **迷你 soak（几小时）**，非严格 24h；看趋势即可，加快到发版 |
| promote | park 到 soak 全绿后 |
| TLS / `authenticated` cosmetic | 0.6 / Phase 21（本 Phase 不碰） |

## 1. Rig
- **设备1（正常钟）** = 现有 `/tmp/owl-p19` GUI（账号 A=`a@local`、B=`b@local`，端口 47019），打云 server。
- **设备2（错钟）** = 新隔离 nest `/tmp/owl-p19b`（端口 47020），daemon 在 **libfaketime** 下跑、系统钟伪造偏移，登录**同一账号 A**（本机第二 device）。仅 W3 用。
- 云 server sqlite `/home/jayncp/skybridge/data/skybridge.db`（用户侧 sqlite3 查 changes/devices/refresh_tokens）。

## 2. 测试块（执行顺序 T1→T4）

### T1 — W12 备份恢复（最自包含，先做）
**关注（§13 W12）**：旧备份覆盖 profile 库 → cursor 落后 → 重拉/冲突风暴/复活已删。
**步骤**：
1. GUI 切到 A（daemon 持 A session，active=`profiles/c11f…/owl.db`）。
2. **备份**：静默后 copy `profiles/c11f…/owl.db`(+wal/shm) → `/tmp/owl-p19-bak/A.db`。
3. A 上经 API 改动：新建 1 条、改 1 条、**删 1 条** → `POST /sync/run` 推上云（server seq 前进）。
4. GUI 切到 **本地**（释放 A 句柄）→ 用旧备份**覆盖** `profiles/c11f…/owl.db`（cursor 回退到备份时点）。
5. GUI 切回 **A** → daemon 开旧库 → 触发 sync。
**判据**：① 漏掉的 server 变更被**重拉补齐**（新建/改可见）；② **被删的笔记不复活**（delete op 正确重放）；③ 无**冲突风暴**（`conflict_record` 仅合理条数甚至 0）；④ cursor 追平 server；⑤ 本地 `owl/owl.db` 仍零污染(D10b)。

### T2 — 强制场景
1. **sync 中途杀 daemon**：`POST /sync/run` 同时 `kill -9` daemon → 重启 → 验库无损、cursor 一致、pending 不丢不重。
2. **断网**：停云 server（`systemctl stop skybridge`）→ GUI 转 offline + SSE 退避；恢复 → 自动重连、状态回正常（S6 的加强版，验数据无丢）。
**判据**：每次都能恢复到一致态，无脏写/无 cursor 跳变/无重复 apply。

### T3 — W3 错钟设备（libfaketime 第二实例）
**关注（§13 W3）**：错钟设备静默 LWW 覆盖（未来钟设备永远赢 → 成黑洞）。HLC-lite 用 **server 归一化 offset + per-device counter** 应防止之。
**步骤**：
1. `brew install libfaketime`；建 `/tmp/owl-p19b` nest（端口 47020）。
2. 设备2 daemon 在 libfaketime 下跑，钟拨到 **未来 +10 天**：`DYLD_INSERT_LIBRARIES=<libfaketime> DYLD_FORCE_FLAT_NAMESPACE=1 FAKETIME='+10d' node packages/daemon/dist/cli.js daemon`（macOS SIP：node 非系统二进制，DYLD 注入可行；不行则 fallback `faketime` 包装）。
3. 设备2 登录账号 A（注：登录需 GUI-main 注入 session；设备2 用**临时脚本**走 skybridge client `login`→`POST /sync/session` 复刻 GUI 注入，或第二个 `just dev` GUI 实例在 libfaketime 下拉起——择一，执行时定）。
4. 同步一轮（设备2 取 server 时间算 offset ≈ −10 天）。
5. **编辑竞态**：设备2（未来钟）改笔记 X；**稍后**设备1（正常钟）改同一笔记 X；两边各 sync。
**判据**：① 设备1 的**后发编辑胜出**（server 归一化时间更晚），而非被设备2 的未来钟时间戳压死 → **错钟设备不是黑洞**；② `lww_counter` 同毫秒打平有序；③ 输方进 `conflict_record`（counter 列未做/W7 留 0.6，仅验行为）。
> 若 libfaketime 在本机 DYLD 注入受阻，降级：临时改 mac 系统钟（你之前否过）或跳过真机、记 release note（16c 已有 hlc 单测）。执行时遇阻再议。

### T4 — 迷你 soak（几小时）
1. mac GUI + 云 server 挂着；周期性多账号快切 + 两边各编辑几条。
2. Claude 设**定时核查**（每 ~20-30 min）：cursor 单调、pending 归零、`conflict_record` 不异常增长、daemon.log 行数不爆、server `journalctl` 无 5xx/风暴、device 不堆积。
**判据**：观察窗口内无漂移/泄漏/崩溃/风暴；快切始终免密且各看各的。

## 3. 验收
- [ ] T1 W12：重拉补齐 + 删不复活 + 无冲突风暴 + cursor 追平 + D10b 仍净。
- [ ] T2 强制：杀进程/断网均恢复一致。
- [ ] T3 W3：错钟设备不成黑洞（后发正常编辑胜），HLC-lite 生效。
- [ ] T4 迷你 soak：观察窗口无异常。
- [ ] owl 零生产改动（除非测出 bug → 另开 fix）。
- [ ] 全绿后回 Phase 19 收尾：**promote 0.1.4→latest** + 提交部署指南/两 plan + PROCESS。

## 4. 不在本 Phase
严格 24h soak（缩为迷你）、`conflict_record` counter 列(W7→0.6)、TLS(0.6)、CLI compat(Phase 21)、0.5.0 bump+发版(Phase 22)、push 收尾(Phase 23)。

## 5. 实施记录（2026-06-04 完成）

跑在 Phase 19 的真云 server（`47.99.215.39:8443` 0.1.4）+ mac rig `/tmp/owl-p19`（账号 A=a@local/B=b@local）。多为 API + sqlite 驱动核验。

**T1 W12 备份恢复 — 通过**：A 库活体 `.backup` → 经 API 增(W12-新增)/改(笔记1)/删彻底(笔记3) + 推云 → 旧备份覆盖 A 库（cursor 回退 5）→ 切回 A 重同步。判据：① 重拉补齐（笔记1=改后、W12-新增 出现）② **删不复活**（笔记3 删除被重放，`trash — local row missing, skipped`）③ cursor 追平 9 ④ D10b 本地库仍净。**1 条冲突**（笔记1，远端胜出/本地输）—— 恢复场景的预期安全行为（远端为准 + W7 可见 + 零丢失），**非风暴**。
- **carry-forward / release notes**：从旧备份恢复后，期间在别处改过的笔记会显示为「冲突（远端胜出）」，需 review 后忽略 → 写进 0.5.0 **恢复指引**。

**T2 强制场景（网络中断）— 通过**：停云 server → daemon 报 `SKYBRIDGE_SERVER_UNREACHABLE`、离线编辑排队 pending=1、退避期 `health-probe`；起云 server → `sse connected` + `health-probe stopped` + catch-up sync 自动补推（pending→0, cursor→10）、`LWW skip` 无重复 apply、`trash skip` 无复活。（kill-mid-sync 按约定跳过：sqlite WAL 事务 + F3 coalescer 保证 + 已知 GUI 需重启限制。）

**T3 W3 错钟（libfaketime）— 通过（决定性）**：`brew install libfaketime`，DYLD 注入 node 可行（+10d 准确）。因 better-sqlite3 **Electron ABI（GUI）vs Node ABI（standalone）冲突** → 关 GUI + 切 Node ABI，跑单错钟 standalone node daemon（`/tmp/owl-p19b` 47020，`FAKETIME='+10d'`），用临时脚本走 skybridge client login→registerDevice→ensureWorkspace + `POST /sync/switch`+`/sync/session` 注入 A 会话。同步建 `server_time_offset_ms ≈ -10天` → 错钟设备编辑笔记，写入 `updated_at ≈ 真实时间（距真实 2 秒、距 +10d 整 10 天）`→ **错钟不成黑洞**。临时脚本 + nest-b 已清。

**T4 计时 soak — 降范围跳过**（用户定）：正确性已由 T1-T3 + Phase 19 S1-S5a 覆盖；最终一致性扫描全过（本地 owl.db D10b 净、profile A pending=0/conflicts=1/cursor=10、profiles A+B、无残留进程）。真·24h soak 留 0.5.0 GA 前可选补做（云 server 已拆，需重部署）。

**验收**：T1/T2/T3 通过 + owl 零生产代码改动。promote 0.1.4→latest 已在 Phase 19 §9 完成。
