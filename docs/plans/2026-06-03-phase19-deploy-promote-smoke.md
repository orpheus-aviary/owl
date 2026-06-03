# Phase 19 — 阿里云部署 + skybridge 0.1.4 promote latest + 真机 GUI smoke

> 状态：**计划稿 v1（2026-06-03）**，待 review。父设计 `2026-05-29-account-profile-isolation-design.md`（v6，§11 时序 / §14 server 能力 / §13 W9/W12）。
> 前置：Phase 12-18 ✅（Phase 18 本地全链路 e2e commit `88c2987` 落 main 未 push）。
> 本 Phase 主体是 **部署 + 真机手测（用户 infra/hands）**；Claude 侧 = 部署指南 + 真机 smoke checklist + 数据 seed + promote 执行。**预期无 owl 生产代码改动**。

---

## 0. 范围与三项决策（2026-06-03 拍板）

设计 §11 Phase 19 = ①阿里云部署 skybridge 0.1.4 server ②promote `next → latest` ③真机 GUI login/快切 smoke。

| 决策 | 选定 | 影响 |
|---|---|---|
| **部署拓扑** | **明文 HTTP + 公网 IP**（TLS/反代后续按需再纳入） | 部署指南不含反代；靠阿里云安全组 + 宝塔防火墙**锁源 IP**兜安全；GUI 填 `http://<PUBLIC_IP>:8443` |
| **部署产物** | 尽可能完整的操作指南，目标 **Ubuntu + 宝塔面板（GUI + 终端两路径）** | 已产出 `skybridge/docs/deploy/ubuntu-baota.md` |
| **promote 时机/执行者** | **先部署 + 真机 smoke 验过，再由 Claude 跑 `just promote-latest 0.1.4`** | 公网真机验证 0.1.4 可用后才移 latest；届时用户提供 npm 2FA-bypass token |

---

## 1. 门槛核对（promote 的 owl 侧前置已满足）

- npm dist-tags 实测：proto/client/server 三包均 `latest: 0.1.3 / next: 0.1.4`。promote 目标 = 把 0.1.4 加到 latest（dist-tag move，不 republish）。
- owl daemon + gui 已 pin `@orpheus-aviary/skybridge-client/server` **exact `0.1.4`**（Phase 15）。
- Phase 18 gated e2e **25/25** 真打 0.1.4 server 全绿（in-process）。
- 设计 §11 / §14：promote「Phase 19 部署」「owl bump dep + dual/e2e pass 后」—— owl 侧条件已过，**只差公网真机验证这一道**（本 Phase 的 smoke）。

---

## 2. 交付物（Claude 侧）

| # | 交付物 | 位置 | 状态 |
|---|---|---|---|
| D1 | Ubuntu + 宝塔部署指南（明文 HTTP 版，含 Node22/native-dep/server.toml/systemd/PM2/健康检查/备份/升级/后续 TLS） | `skybridge/docs/deploy/ubuntu-baota.md` | ✅ 本次产出 |
| D2 | 真机 smoke checklist（owl GUI，对真云 server，覆盖 Phase 18 自动化上界之外） | 本文 §4 | ✅ 本次产出 |
| D3 | 数据 seed：隔离 nest + daemon API 种本地笔记，供 claim/快切测 | §4 setup（Claude 在用户 mac 上跑） | 待执行 |
| D4 | promote 执行 + 验证 | §5 | 待 smoke 绿后执行 |
| D5 | （可选 doc-only）skybridge README 版本表 latest → 0.1.4 | `skybridge/README.md` | 留 promote 后顺手 |

---

## 3. 时序（deploy → smoke → promote → verify）

```
1. 用户：照 D1 在阿里云 Ubuntu 部署 0.1.4 server（npm pin @0.1.4）
        → /v1/health 公网可达 + 记下 server_id + 建 2 个用户(a/b)
2. Claude：在用户 mac 上准备隔离 nest + 后台 daemon 种本地笔记（D3）
3. 用户：env OWL_NEST_DIR=<nest> just dev 拉 GUI，照 §4 跑 smoke
4. smoke 全绿 → 用户提供 npm 2FA-bypass token
5. Claude：cd skybridge → just promote-latest 0.1.4（temp npmrc，token 不落 repo/~/.npmrc，用完即删）
6. Claude：npm view 三包 dist-tags 确认 latest=0.1.4 → §6 验收
```

> 任一步 smoke 失败 → **不 promote**，回 §7 诊断；latest 保持 0.1.3 不动。

---

## 4. 真机 smoke checklist（owl GUI → 真云 server）

**目标**：Phase 18 e2e 跑的是 in-process core-engine；本 checklist 验 **GUI-main 编排 + 公网 WAN + 明文 HTTP** 这条 e2e 上界之外的链路：`loginAndOpenSession` 全序（claim / safeStorage 钥匙串）、免密快切、refresh 续期（**不 refresh-loop**）、多账号 add，外加真网才暴露的 offline/reconnect。

**真网相对 localhost 的新风险点**：① 公网延迟下 SSE connect/reconnect 退避 ② GUI 接受 `http://<IP>:8443` URL ③ server_id 取自真 `/v1/server-info` ④ 30 天 access 的续期定时器在真网**不复发 `ef059b2` 风暴**（setTimeout 32 位溢出）⑤ 杀 server / 断网 → markOffline → 重连。

### Setup（Claude 在用户 mac 上，自包含）

隔离 nest（**绝不碰 `~/orpheus-aviary-nest`**）+ 隔离端口 **47019**（不撞真实 daemon；若想复用默认端口须先停真 daemon）。

```bash
# 1) build —— daemon dev 跑 dist/cli.js，不 build 种不进去
just build-core && just build-daemon

# 2) 隔离 nest + 最小 owl_config.toml（空 [llm] 即可，本测不碰 AI）
mkdir -p /tmp/owl-p19/owl/logs
cat > /tmp/owl-p19/owl/owl_config.toml <<'EOF'
[daemon]
port = 47019
poll_interval_min = 5
[log]
level = "info"
[llm]
url = ""
model = ""
api_key = ""
api_format = "openai"
thinking_round_trip = true
EOF

# 3) 后台起 daemon → 种 2-3 条本地笔记 → 停 daemon
OWL_NEST_DIR=/tmp/owl-p19 node packages/daemon/dist/cli.js daemon >/tmp/owl-p19/seed.log 2>&1 &
SEED_PID=$!
sleep 2
curl -s -X POST http://127.0.0.1:47019/notes -H 'content-type: application/json' \
  -d '{"content":"# 本地笔记 1\n\nPhase 19 claim 测试"}'
curl -s -X POST http://127.0.0.1:47019/notes -H 'content-type: application/json' \
  -d '{"content":"# 本地笔记 2\n\n隔离验证"}'
kill "$SEED_PID"
```

- 用户（fish）拉 GUI：`env OWL_NEST_DIR=/tmp/owl-p19 OWL_DAEMON_PORT=47019 just dev`。GUI 登录 URL 填 `http://<PUBLIC_IP>:8443`。

### 用例

| # | 操作 | 预期 |
|---|---|---|
| **S1 首登 + claim** | Settings → 同步 → 填 `http://<PUBLIC_IP>:8443` + `a@example.com` + 密码 → 登录 | 空账号 + local 有笔记 → 弹 `ClaimAccountDialog`「并入本地笔记」；选并入 → 窗口自动 reload 进登录态，账号侧看到并入的笔记 |
| **S2 D10b 文件/server 核验** | GUI 关闭后 sqlite 核验（WAL checkpoint 后） | `profiles/<id>/owl.db` 生成且笔记数对；**`owl/owl.db` 未被账号同步污染**（`synced_at IS NOT NULL`=0 / `sync_cursor`=0 / 无 `skybridge_%` local_metadata）；toml `[profiles.<id>]` 有 server_id(=云 server_id) + 两密文 + device + workspace；server change-log 仅用户笔记上行（特殊笔记不推）；server device=1 / workspace=1 不堆积 |
| **S3 免密快切** | 侧栏 SyncStatusBar popover → ProfileSwitcher：A → 本地 → A | A↔本地切换**不重输密码**；切回 A 仍登录态、笔记正确；窗口受控 reload 无残留 |
| **S4 多账号 add + 隔离** | auth view「添加账号」(或 popover「+ 添加账号」) → 填 `b@example.com` 登录；**进 B 后手动建一条「B-only」笔记** | B 成 active（语义 A）；**B 初始为空 ——「从账号添加」不 claim local**（claim 仅 `prior===LOCAL`，sync-auth.ts:205）；A 留「已保存账号」可免密快回；快切 A↔B 验**各看各的**（A 看并入的 local 笔记、B 只看 B-only，互不串） |
| **S5a refresh 不风暴（默认 30d TTL）** | 保持 GUI 开着，观察 daemon.log（grep `sse-bridge`）+ skybridge server 日志（`journalctl -u skybridge` / PM2） | **无 250/sec install/connect 风暴**（`ef059b2` 回归）；daemon.log 无高频 session reinstall；skybridge 端无高频 `/v1/auth/refresh`。**默认 30d TTL 下短 smoke 只能验"不风暴"，验不到"临近过期才轮换"**（要真测见 S5b） |
| **S5b（可选，不在生产实例跑）refresh 轮换实测** | 在 **throwaway/测试 0.1.4 实例（或本地 server）**上把 `[auth].access_ttl_sec` 调短（如 `120`）→ 重启 → 重登 → 观察几分钟。**生产实例不碰 TTL，只跑 S5a**（避免忘改回导致该实例上之后所有会话每分钟级 refresh） | GUI 提前 60s refresh：`access_ttl_sec=120` → 约 60s 后触发。skybridge 日志见 `/v1/auth/refresh` 周期性命中（不风暴）；daemon 见 session 周期性 reinstall。**轮换本身日志看不到** —— 验证查 server sqlite：`SELECT token_family, replaced_by, revoked_at FROM refresh_tokens ORDER BY expires_at`，刷过的旧行 `replaced_by` 非空 = 已轮换（或另写「重放旧 refresh token」探针，期望 `REFRESH_REPLAYED` + 整 family 撤销）。⚠️ refresh HTTP 是 GUI-main→server，daemon.log 看不到 refresh 本体；GUI main 无独立 log 文件 |
| **S6 offline/reconnect** | 服务器停服（或断网）→ 等 → 恢复 | SyncStatusBar 转 offline（信息态，无手动重连按钮）；SSE 永久退避 `[2,4,8,16,30]s`；server 恢复后自动重连 + 状态回正常 |
| **S7 移除设备 (W9)（非 gate，需第二 device）** | **需先造一个非当前 device**：用第二隔离 nest（或第二台机）以同账号登录一次 → 回原 GUI DevicesCard「移除」该行 | 仅非当前行有「移除」；revoke 后该 device 从列表消失；当前 device 无移除按钮。**不影响 promote gate**，时间紧可跳 |
| **S8 删除账号副本 (17d)** | Settings →「已保存账号」→ 删除 B 副本（强二次确认） | **active 路径先 `postSyncSwitchStrict(local)` 硬释放句柄**：daemon 在但 switch 非 2xx → **中止删除**并恢复续期定时器；daemon 不可达(`NetworkError`) → 继续。**远端 revoke/logout 是 best-effort**（device-first/logout-last）—— **失败仍删本地副本**（sync-auth.ts:~485）。local/A 库完好；ghost 不复活 |

### Teardown
- kill 后台进程（**别用宽 pattern 误杀云 server**，云 server 在阿里云不在本机）。`rm -rf /tmp/owl-p19`。云 server 的 smoke 用户/笔记按需清或留。

> **核心**（Phase 19 必过，login/快切/refresh 在真网）：S1 / S2 / S3 / S4 / **S5a**。
> **可选**：S5b（refresh 轮换实测；放 throwaway/测试实例或本地 server，**不碰生产实例 TTL**）。
> **顺带回归**（Phase 17 已本地验过，真网再扫一遍）：S6 / S7 / S8。

---

## 5. promote-latest 步骤（smoke 全绿后，Claude 执行）

前置：§4 smoke 全绿 + 用户提供 npm **2FA-bypass + `@orpheus-aviary/*` scope** 的 granular token。

```bash
cd ../skybridge
just build && just check        # 确认干净（promote 不 republish，但先确认仓库态）
# token 写 mktemp：它会临时落磁盘，但不进 repo/~/.npmrc；trap 保证异常退出也清掉。
TMP_NPMRC=$(mktemp)
trap 'rm -f "$TMP_NPMRC"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" > "$TMP_NPMRC"
NPM_CONFIG_USERCONFIG="$TMP_NPMRC" just promote-latest 0.1.4
rm -f "$TMP_NPMRC"
# 验证
for p in proto client server; do npm view @orpheus-aviary/skybridge-$p dist-tags; done
#   → 三包均 { latest: '0.1.4', next: '0.1.4' }
```

> `just promote-latest 0.1.4` = 3 条 `npm dist-tag add @orpheus-aviary/skybridge-<pkg>@0.1.4 latest`，无 republish。
> 回滚（万一）：`npm dist-tag add ...@0.1.3 latest` 移回。
> promote 后顺手（D5，doc-only）：skybridge README 版本表 latest 列改 0.1.4。

---

## 6. 验收标准

- [ ] **部署**：阿里云 Ubuntu 跑起 0.1.4 server；`curl http://<PUBLIC_IP>:8443/v1/health` 公网可达 `{"ok":true}`；安全组 8443 锁源 IP。
- [ ] **smoke**：§4 核心 S1/S2/S3/S4/S5a 全绿（S5b 可选、S6-S8 顺带回归）；D10b 文件/server 核验通过；无 refresh 风暴。
- [ ] **promote**：三包 dist-tags `latest: 0.1.4`。
- [ ] **owl 代码**：零生产改动（Phase 19 = 部署 + 文档 + dist-tag move）。
- [ ] 交付物 D1（部署指南）、D2（checklist）落库；PROCESS.md + 本 plan 留工作树给用户提交。

---

## 7. 风险 / 回滚

| 风险 | 处置 |
|---|---|
| 明文 HTTP token/密码过公网 | 安全组 + 宝塔防火墙锁源 IP（指南 §0/§2）；后续上 TLS（§11） |
| native dep（better-sqlite3）拉不到预编译 | 指南 §1/§3：装 `build-essential python3` 兜底 |
| 宝塔防火墙 ≠ 阿里云安全组漏放 8443 | 指南 §8 排查清单 |
| smoke 暴露 GUI-main 真网 bug | 不 promote；按现象诊断（参考 Phase 17 `ef059b2` 诊断法：daemon.log 暴涨 + 同 install/connect 高频 → grep `TimeoutOverflowWarning`） |
| promote 误移 | dist-tag 可移回 0.1.3 |

---

## 8. 不在本 Phase（设计 §11 后续）

- **Phase 20**：真机 soak ≥24h（多账号快切 + 错钟设备 W3 + 备份恢复 W12 + 强制场景）。
- **Phase 21**：CLI compat（`--db` 文案 + W10 switch lockfile）。
- **Phase 22**：owl 0.5.0 bump + release notes（附件 local-only/W11、提醒仅 active/W5、备份恢复/W12）。
- **Phase 23**：收尾三仓 push clean。
- **TLS / 反代**：明文够 smoke；正式开放公网前单独纳入（指南 §11 占位）。

---

## 9. 实施记录（2026-06-04 完成）

**部署（测试环境，已拆）**：阿里云 Ubuntu ECS `47.99.215.39:8443`，Node 24，宝塔终端，安装到 `~/skybridge`（非 root 用户 `jayncp`），systemd 守护（`User=jayncp` + 相对路径 ExecStart）。`server_id = smXxhd…Fg0g`。明文 HTTP + 安全组锁源 IP。`/v1/health` 本机 + 公网（mac）均 `{"ok":true,"version":"0.1.4"}`。
- **踩坑**：① 发布包 bin 在 `bin/`（非 `dist/bin/`）；② fish 不支持 heredoc（用 nano 写 toml）；③ Node 24 无 better-sqlite3 预编译 → 现场编译（先装 `build-essential python3` 兜底）；④ owl 的 profile/auth 配置在 **`<nest>/skybridge/skybridge_config.toml`**（非 `owl/owl_config.toml`）—— 核验时一度找错文件。

**smoke S1-S5a 全过**（隔离 nest `/tmp/owl-p19` + 种 3 本地笔记）：S1 首登+claim+reload；S2 profile 库生成 + `skybridge_config.toml` 写对（active_profile + server_id 锚 + 双密文 + device/workspace）+ **D10b 本地库零污染** + 手动 sync 打通；S3 免密快切 A↔本地；S4 多账号 add（B 初始空、A 留列表、A↔B 各看各的）；S5a refresh 不风暴（3 次 `/v1/auth/refresh` 全来自快切的 refresh-first，非定时器循环）。
- **cosmetic 发现**：daemon `/sync/status` 的 `authenticated` = `Boolean(config?.auth?.token)`（`manual.ts:324`）读老顶层 `[auth].token`，per-profile 下恒 `false`（功能无碍）→ **Phase 21 顺手修**。

**promote**：2026-06-04 `npm dist-tag add …@0.1.4 latest` 三包，验证 `{latest:'0.1.4',next:'0.1.4'}`。

**正式环境**：测试环境拆除（见 `skybridge/docs/deploy/ubuntu-baota.md` §13），正式部署照该指南（已补 §12 日常运维 + §13 拆除/迁移）。TLS 留 0.6。
