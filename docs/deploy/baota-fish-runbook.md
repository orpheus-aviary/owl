# 云端部署 runbook：skybridge + owl-server

> 阿里云 Ubuntu + 宝塔面板 + **Node 24** + **fish** + **PM2 命令行** + **nano**。
> 明文 HTTP + 安全组锁源 IP 的个人 smoke 部署。基于 2026-07-23 实测整理，**含踩坑合集**。
> 宝塔的 PM2 图形面板实测不好用，本文全程命令行 PM2。TLS / 反代留后续（见文末）。

---

## 0. 环境与约定

- 阿里云 Ubuntu ECS + 宝塔面板；Node **v24.14.0**（宝塔路径 `/www/server/nodejs/v24.14.0/bin`）。
- **非 root**：`su` 进一个有 sudo 的管理员用户操作。
- shell = **fish**；编辑器 = **nano**。
- 两个服务**同机**：`skybridge`（:8443）+ `owl-server`（:47020）。
- 浏览器 / 手机 → `owl-server:47020`；owl-server → skybridge 走 `127.0.0.1:8443`（本机 loopback）。

**nano 保存**：粘贴内容 → `Ctrl+O` → 回车 → `Ctrl+X`。
所有 `<公网IP>` 换成服务器公网 IP；`强密码` 换成你自己的（≥12 位）。

### ⚠️ 安全前提（明文 HTTP 必读）

密码、access/refresh token 都**明文过公网**。所以：
1. 安全组 + 宝塔系统防火墙**只放行你的源 IP `/32`**，不要 `0.0.0.0/0`。
2. 仅个人 / 受信 smoke，非面向公众。
3. 正式开放前上 TLS（见文末）。

### 端口 / 数据速查

| 服务 | 端口 | 安装目录 | 数据（要备份） | 对公网 |
|---|---|---|---|---|
| skybridge | 8443 | `/www/skybridge` | `data/skybridge.db`（含 **server_id** + 账号） | 否*（走 loopback） |
| owl-server | 47020 | `/www/owl-server` | `/www/owl-nest/owl/owl.db` | **是**（锁源 IP） |

\* skybridge 8443 只在你想让**桌面版 owl app 直连同步**时才需对公网开；纯网页测试不用开。

---

## Step 0 — 预检

```fish
node -v; npm -v; which node
```
若 `node -v` 报 command not found，把宝塔的 node 持久加进 PATH：
```fish
fish_add_path /www/server/nodejs/v24.14.0/bin
node -v
```
**提前装编译工具链**（Node 24 太新，`better-sqlite3` 常需本地编译，见踩坑 3）：
```fish
sudo apt update
sudo apt install -y build-essential python3
```

---

## Phase 1 — skybridge server

```fish
# 1.1 建目录（sudo 建 + 交还当前用户，否则 npm 装 node_modules 会 EACCES）
sudo mkdir -p /www/skybridge/data /www/skybridge/logs
sudo chown -R $USER:$USER /www/skybridge
cd /www/skybridge
npm init -y
npm install @orpheus-aviary/skybridge-server        # 老包，淘宝镜像已同步，直接装

# 1.2 若报 better-sqlite3 bindings 缺失（见踩坑 3）
npm rebuild better-sqlite3
ls -l node_modules/better-sqlite3/build/Release/better_sqlite3.node   # 确认 .node 出来
```

**1.3 写配置**
```fish
nano /www/skybridge/server.toml
```
```toml
[server]
host = "0.0.0.0"
port = 8443
public_url = "http://<公网IP>:8443"

[storage]
db_path = "/www/skybridge/data/skybridge.db"
attachment_root = "/www/skybridge/data/attachments"

[logging]
level = "info"
```

**1.4 建库 + 建账号**（`--init` 打印 `server_id`，记下）
```fish
node_modules/.bin/skybridge-server --init --config /www/skybridge/server.toml
node_modules/.bin/skybridge-server --config /www/skybridge/server.toml user create --email owner@example.com --password '强密码'
node_modules/.bin/skybridge-server --config /www/skybridge/server.toml user list
```

**1.5 起服务（PM2 命令行）**
```fish
cd /www/skybridge
pm2 start node_modules/@orpheus-aviary/skybridge-server/bin/skybridge-server.js --name skybridge -- --config /www/skybridge/server.toml
pm2 save        # 快照进程列表（含 env），重启机器可恢复
```
> 注意 `--` ：它把后面的 `--config ...` 传给脚本本身，而不是 pm2。

> ### ⚠️ 部署不变量：skybridge 必须**单实例 fork**
>
> skybridge server 的 `EventBus` 是**单进程内存实现**。push 之后它只能通知
> **同一进程内**的 SSE 订阅者。一旦跑成多副本（`pm2 start -i`、cluster 模式、
> 多容器、滚动发布期间新旧并存），连到 A 副本的设备就收不到 B 副本处理的推送，
> 表现是**「对方改了这边一直不同步」** —— 和 Problem A 的症状一模一样，
> 且日志上完全看不出来，极难归因。
>
> - **禁止** `pm2 start -i <n>` / `--exec-mode cluster` / 多容器同时对同一个库。
> - 上面的 `pm2 start` 默认就是 fork 单实例，**不要加 `-i`**。
> - 每次部署后确认一次：
>   ```fish
>   pm2 describe skybridge | grep -E "exec mode|instances"
>   # 期望 exec mode : fork   /   instances : 1
>   ```
> - 进程内**探测不到**这个问题：`NODE_APP_INSTANCE` 是实例序号不是总数（单实例
>   也可能是 0），多容器场景各自都是 0。所以只能靠这条部署纪律 + 上面这次人工确认。
> - 长期解法是把 EventBus 换成 Redis / pubsub 跨进程总线，记在 skybridge 仓 backlog。

**1.6 验健康**（本机 loopback，不用开防火墙）
```fish
curl -s http://127.0.0.1:8443/v1/health         # {"ok":true,...}
curl -s http://127.0.0.1:8443/v1/server-info    # 返 server_id
```

---

## Phase 2 — owl-server

```fish
# 2.1 建目录 + 安装
sudo mkdir -p /www/owl-server /www/owl-nest/owl/logs
sudo chown -R $USER:$USER /www/owl-server /www/owl-nest
cd /www/owl-server
npm init -y

# owl-server 是新包，淘宝镜像可能还没同步（见踩坑 4）→ 只让 @orpheus-aviary 走官方源
npm install @orpheus-aviary/owl-server --@orpheus-aviary:registry=https://registry.npmjs.org
# 待淘宝镜像同步后（几小时~1 天），可直接 npm install @orpheus-aviary/owl-server

# 2.2 better-sqlite3 同样可能要重编（见踩坑 3）
npm rebuild better-sqlite3
ls -l node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

**2.3 算 owner 的 account_lock**（skybridge 必须已在跑；会提示输密码）
```fish
node_modules/.bin/owl-server compute-owner --server-url http://127.0.0.1:8443 --email owner@example.com
# → 打印一串 profileId，复制它
```
> `account_lock` = 这台实例的「主人锁」，只有它对应的账号能登录。**留空则 owl-server 拒启**（fail-closed）。详见踩坑 6。

**2.4 写配置**（先拷样例再改）
```fish
cp node_modules/@orpheus-aviary/owl-server/owl_config.toml.sample /www/owl-nest/owl/owl_config.toml
nano /www/owl-nest/owl/owl_config.toml
```
```toml
[daemon]
mode = "cloud"
bind = "0.0.0.0"
port = 47020
server_url = "http://127.0.0.1:8443"
account_lock = "上一步 compute-owner 打印的 profileId"
public_url = "http://<公网IP>:47020"

[sync]
interval_min = 5
```

**2.5 先手动冒烟验配置**（fish 用 `env` 传环境变量）
```fish
env OWL_NEST_DIR=/www/owl-nest node_modules/.bin/owl-server
```
看到 `Owl daemon running at http://0.0.0.0:47020` → `Ctrl+C` 停掉，转 PM2。
（拒启会打印原因；到 `openProfileDb` 才报 bindings 错 = 配置已过、只差 native 模块。）

**2.6 起服务（PM2 命令行，env 会被 pm2 捕获进进程）**
```fish
cd /www/owl-server
env OWL_NEST_DIR=/www/owl-nest pm2 start node_modules/@orpheus-aviary/owl-server/index.js --name owl-server
pm2 save
```
> owl-server 无启动参数；`OWL_NEST_DIR` 必须在 `pm2 start` 前用 `env` 带上，否则找不到配置拒启。
> owl-server **首次 boot 自动跑 migration**（建 owl.db），无需单独 `--init`。

---

## Phase 3 — 防火墙 + 真机测试

**3.1 放行 47020**（两处都要，锁源 IP）
- **阿里云安全组**：入方向 TCP `47020`，授权对象 `<你的公网IP>/32`。
- **宝塔系统防火墙**：同样放行 `47020`。

**3.2 本机验证**
```fish
curl -s http://127.0.0.1:47020/status                                   # 200
curl -sI http://127.0.0.1:47020/ | grep -i content-security-policy       # 严格 CSP 头
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47020/notes    # 401（无 token）
```

**3.3 手机 / 异地浏览器**（在你的源 IP 网络下）
`http://<公网IP>:47020/` → 用 owner 账号登录 → 渲染真实笔记。
顺带验收：**移动导航 UI / 软键盘浮动 TagBar / PWA 加到主屏幕**。

---

## ⚠️ 踩坑合集（实测）

1. **fish 语法**（和 bash 不同）
   - 不能 `VAR=value`：用 `set VAR value`。
   - 不能行内 `VAR=value 命令`：用 `env VAR=value 命令`。
   - **变量不按空格拆词**：`set CFG "--config x"` 会当成**一个**参数传进去 → 坏；要么写成列表 `set CFG --config x`（两个元素），要么整条命令写全。
   - `&&` `||` `|` `$(...)` 在现代 fish 都能用。

2. **`/www` 目录权限 EACCES**：非 root 下 `sudo mkdir` 建的目录 owner 是 root，直接 `npm install` 写 `node_modules` 会 EACCES。先 `sudo chown -R $USER:$USER <目录>`。

3. **better-sqlite3 在 Node 24 无预编译**（**最常踩**）：Node 24 = ABI **137**（报错含 `node-v137`），`better-sqlite3@11.10.0` 没带该 ABI 的预编译产物，淘宝镜像的二进制镜像也没有 → 装完缺 `.node`。
   - 修：先装工具链（Step 0），再 `npm rebuild better-sqlite3`，确认 `build/Release/better_sqlite3.node` 生成。
   - **skybridge 和 owl-server 各自的 node_modules 都要 rebuild 一次**。
   - 装工具链**不会**回头编译已装好的模块——必须显式 rebuild。
   - `npm rebuild` 若还没生成，强制源码编译：`env PYTHON=python3 npm rebuild better-sqlite3 --build-from-source`。
   - **每次 `npm install/update` 后**若再报 bindings 错，重跑一次 rebuild。

4. **淘宝镜像未同步新发布的包**：服务器 npm 默认走 `registry.npmmirror.com`；刚 `npm publish` 的新版本镜像要几小时~1 天才同步 → 报 404（域名是 `cdn.npmmirror.com`）。临时用 scoped 覆盖只对该 scope 走官方源：
   `npm install <pkg> --@orpheus-aviary:registry=https://registry.npmjs.org`。老包不受影响。

5. **owl-server 拒启：`OWL_NEST_DIR`**：找不到配置文件就拒启（fail-closed，不会静默降级成无鉴权）。PM2 必须在 `pm2 start` 前 `env OWL_NEST_DIR=... ` 带上。

6. **owl-server 拒启：`account_lock` 必填**：cloud 模式要求 `account_lock = '<profileId>'` 或 `'off'`，留空拒启。
   - `<profileId>`（`compute-owner` 算得）= 只有该账号能登录（**单人推荐**）。
   - `'off'` = skybridge 上任何账号都能登（先到先绑）；且此时**不能配服务端 AI key**（防别人烧额度）。

7. **两个防火墙**：宝塔「系统防火墙」≠ 阿里云「安全组」，**两处都要放**，少一个公网就不通。

8. **宝塔 PM2 图形面板不好用** → 用命令行 PM2（本文）。

---

## 运维：查看 / 重启 / 停止

```fish
pm2 list                       # 两个服务状态一览（online / errored / 重启次数）
pm2 status                     # 同上
pm2 logs owl-server            # 实时日志（拒启 / 报错看这里）
pm2 logs owl-server --lines 100  # 最近 100 行
pm2 logs skybridge

pm2 restart owl-server         # 改完配置后重启生效
pm2 stop owl-server            # 停（不删，随时可 restart）
pm2 start owl-server           # 重新起已停的
pm2 delete owl-server          # 从 PM2 移除（进程列表里删掉）

pm2 save                       # 每次增删/改动后存快照
pm2 startup                    # 生成开机自启命令（按它打印的 sudo 命令跑一次，仅需一次）
```
> 改了 `/www/owl-nest/owl/owl_config.toml` → `pm2 restart owl-server`。
> 改了 `/www/skybridge/server.toml` → `pm2 restart skybridge`。

### ⚠️ 重启 owl-server 之后**必须从网页端登录一次**

owl-server 的 skybridge 凭据是 **RAM-only**（服务器没有 keychain，refresh token 不落盘）。
进程一重启就退回 local 库、没有 session，**同步会静默停摆直到有人登录** ——
桌面端此时一切正常，只有云端这一路默默掉队。2026-08-11 就是这么发现云端漏升了两个版本的。

重启后开 `http://<公网IP>:47020` 用 owner 账号登录一次即可。自检：

```fish
curl -s http://127.0.0.1:47020/status | jq .data.sync
# {"session_installed": true, "state": "session_ready", "last_success_at": 1786...}
```

**判活要两个条件都看**：`state == "session_ready"` **且** `last_success_at` 在合理窗口内。
`session_ready` 只说明 session 装上了，不代表 skybridge 可达、也不代表最近一轮同步成功。
（`last_success_at` 是进程内计数，重启后为 `null`，这是诚实的答案而不是异常。）

忘了登录的话，daemon 会在无 session 满 10 分钟时打一条 warn，之后每小时一条：

```fish
grep session-watchdog /www/owl-nest/owl/logs/daemon.log*
# {"level":40,...,"kind":"session-watchdog","reason":"no_session","minutes":11,...}
```

---

## 更新版本

**skybridge**
```fish
cd /www/skybridge
npm install @orpheus-aviary/skybridge-server@latest
npm rebuild better-sqlite3                       # 若重装了 native 依赖
node_modules/.bin/skybridge-server --init --config /www/skybridge/server.toml   # 跑新 migration
pm2 restart skybridge
```

**owl-server**
```fish
cd /www/owl-server
npm install @orpheus-aviary/owl-server@latest --@orpheus-aviary:registry=https://registry.npmjs.org
npm rebuild better-sqlite3                        # 若重装了 native 依赖
pm2 restart owl-server                            # boot 时自动跑 migration，无需 --init
```
> migration 单向。升级前先按下面「备份」备一份 db。

---

## 删除 / 拆除

```fish
# 1. 从 PM2 移除
pm2 delete owl-server; pm2 delete skybridge
pm2 save

# 2. 删安装目录 + 数据（⚠️ 含 db / server_id / 笔记，删前先备份！）
rm -rf /www/owl-server /www/owl-nest
rm -rf /www/skybridge

# 3. 阿里云安全组 + 宝塔防火墙收回 47020（及 8443 若开过）
```
> **迁移**（非废弃）：保留 `skybridge/data/skybridge.db`（server_id 跟着走）→ 新机重部署 → 放回 db → owner/账号/工作区锚点不丢。

---

## 账号管理（skybridge）

```fish
cd /www/skybridge
set CFG --config /www/skybridge/server.toml      # fish 列表写法
node_modules/.bin/skybridge-server $CFG user create --email new@you --password '强密码'   # 加账号
node_modules/.bin/skybridge-server $CFG user list                                         # 列账号
node_modules/.bin/skybridge-server $CFG user passwd --email new@you --password '新密码'    # 改密
```
> **CLI 无 `user delete`**（只有 create/list/passwd）→ 删账号得手动改 db。且不能简单 `DELETE FROM users`：有同步历史的 device 是 `ON DELETE RESTRICT`（软删不硬删），会被外键挡住。正确顺序 = 先清该账号 workspace 下的 `changes`/`attachments`，再删 user（其余靠 CASCADE 带走 workspaces→snapshots / devices / auth_tokens / refresh_tokens）：
>
> ```fish
> pm2 stop skybridge
> cp /www/skybridge/data/skybridge.db /www/skybridge/data/skybridge.db.bak   # 先备份
> which sqlite3; or sudo apt install -y sqlite3
> set EMAIL del@example.com
> sqlite3 /www/skybridge/data/skybridge.db "SELECT id, email FROM users WHERE email='$EMAIL';"   # 先确认
> sqlite3 /www/skybridge/data/skybridge.db "PRAGMA foreign_keys=ON;
> BEGIN;
> DELETE FROM changes     WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id=(SELECT id FROM users WHERE email='$EMAIL'));
> DELETE FROM attachments WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id=(SELECT id FROM users WHERE email='$EMAIL'));
> DELETE FROM users WHERE email='$EMAIL';
> COMMIT;"
> pm2 start skybridge
> ```
>
> **连带影响**：① 若删的是某台 owl-server 的 owner，那台 owl-server 将没人能登录（`account_lock` 指向已删的 profileId）→ 给它换 owner（`compute-owner` 新账号 → 改 `account_lock` → `pm2 restart owl-server`）或停掉。② owl-server 端 `/www/owl-nest/owl/owl.db` 是本地缓存，不会自动清，彻底清理就删 `/www/owl-nest`。③ **同邮箱重建 = 新 user_id = 新 profileId**，`account_lock` 要跟着更新。

### 换 owl-server 的 owner（改 account_lock）

```fish
# 1. 为新 owner 算 profileId
cd /www/owl-server
node_modules/.bin/owl-server compute-owner --server-url http://127.0.0.1:8443 --email new-owner@example.com
# 2. 把新 profileId 填进 account_lock
nano /www/owl-nest/owl/owl_config.toml
# 3. 重启
pm2 restart owl-server
```
> 换 owner 后是**另一个 profileId → 另一份 profile 数据**（原 owner 的 owl.db 不受影响，只是新 owner 看不到）。

---

## 备份（定期）

```fish
# skybridge（sqlite WAL：冷备最稳）
pm2 stop skybridge
cp /www/skybridge/data/skybridge.db /www/backup/skybridge-(date +%F).db
pm2 start skybridge

# owl-server 数据
cp /www/owl-nest/owl/owl.db /www/backup/owl-(date +%F).db
```
> `(date +%F)` 是 fish 的命令替换（等价 bash `$(date +%F)`）。
> **`server_id` 存在 skybridge db 里** —— db 丢了 owner/工作区锚点全失效，备份必须含它。

---

## 后续：上 TLS（正式开放前必做）

明文 HTTP 仅 smoke。开放给更多人前加反代 + 域名 + 自动证书（Caddy 最省事）：
`server.toml` / `owl_config.toml` 的 `bind` 改回 `127.0.0.1`，反代 443 → 本机端口，`public_url` 改 `https://域名`，安全组只留 443。详细流程见 `skybridge/docs/deploy/ubuntu-baota.md` §11。

---

## 关联文档

- skybridge 通用部署（bash / systemd / GUI）：`skybridge/docs/deploy/ubuntu-baota.md`
- owl-server 通用部署（bash / 全局装）：`docs/deploy/owl-server-ubuntu.md`
- 本文 = 两者合一的 **BaoTa + fish + PM2 CLI 实测版**，含踩坑。
