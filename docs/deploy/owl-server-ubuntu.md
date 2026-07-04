# 部署 `@orpheus-aviary/owl-server`（Ubuntu，明文 HTTP + 锁源 IP）

> owl 网页版的云端服务器：一个进程 = Fastify daemon + 内嵌 web bundle（同源托管）。异地浏览器登录后
> 读/改笔记。**本阶段（Stage 1/2）明文 HTTP + 安全组锁源 IP；TLS/反代留 0.6**。参照 skybridge 的
> `skybridge/docs/deploy/ubuntu-baota.md`。

## 0. 前置
- **一台已部署的 skybridge server**（owl-server 靠它做账号认证）。见 `skybridge/docs/deploy/ubuntu-baota.md`。
- Ubuntu + **Node ≥ 22**（`node -v`）。`better-sqlite3` 优先用预编译产物；拉不到时回退 node-gyp，需
  `sudo apt install -y build-essential python3`。
- 一个 owl 账号（在 skybridge 上 `skybridge-server user create` 建好），作为这台服务器的 **owner**。

## 1. 安装
```bash
sudo npm i -g @orpheus-aviary/owl-server
owl-server --help 2>/dev/null; which owl-server
```

## 2. 数据目录 + 配置
owl-server 用标准 nest：`$OWL_NEST_DIR/owl/owl_config.toml`（默认 nest = `~/orpheus-aviary-nest`）。
**缺配置文件会拒启**（不会静默降级成无鉴权 local）。拷贝内置样例并填写：
```bash
export OWL_NEST_DIR=/opt/owl-nest          # 任选；systemd 里也要设同一个
mkdir -p "$OWL_NEST_DIR/owl/logs"
# 样例随包发布，路径 = 全局包内 owl_config.toml.sample（owl-server 缺配置时的报错也会打印该路径）
cp "$(npm root -g)/@orpheus-aviary/owl-server/owl_config.toml.sample" "$OWL_NEST_DIR/owl/owl_config.toml"
```
编辑 `$OWL_NEST_DIR/owl/owl_config.toml`：
```toml
[daemon]
mode = "cloud"                              # owl-server 只能 cloud（否则拒启）
bind = "0.0.0.0"                            # 对外监听
# port 省略 → 默认 47020
server_url = "http://SKYBRIDGE-IP:8443"     # 固定的 skybridge 地址
account_lock = "<owner-profileId>"          # 见第 3 步
public_url = "http://THIS-SERVER-IP:47020"  # 本机对外 origin（驱动 Host/CORS 校验）
# web_root 省略 → 托管包内内嵌的 web bundle
```

## 3. 计算 owner 的 `account_lock`
一次性登录，打印 owner profileId（随后丢弃 token），填进上面的 `account_lock`：
```bash
owl-server compute-owner --server-url http://SKYBRIDGE-IP:8443 --email owner@example.com
# 或脚本化：  printf '%s' "$PASSWORD" | owl-server compute-owner --server-url ... --email ... --password-stdin
```

## 4. 跑起来
**手动冒烟**：
```bash
OWL_NEST_DIR=/opt/owl-nest owl-server
# 期望日志：Owl daemon running at http://0.0.0.0:47020
```
**systemd**（`/etc/systemd/system/owl-server.service`）：
```ini
[Unit]
Description=owl-server
After=network.target

[Service]
Environment=OWL_NEST_DIR=/opt/owl-nest
ExecStart=/usr/bin/owl-server
Restart=on-failure
User=owl

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now owl-server
sudo journalctl -u owl-server -f
```

## 5. 验证
```bash
curl -s http://THIS-SERVER-IP:47020/status                 # 公开，200
curl -sI http://THIS-SERVER-IP:47020/ | grep -i content-security-policy   # 严格 CSP 头
curl -s -o /dev/null -w '%{http_code}\n' http://THIS-SERVER-IP:47020/notes  # 无 bearer → 401
```
浏览器开 `http://THIS-SERVER-IP:47020/` → 登录（owner 账号）→ 渲染真实笔记。

## 6. 安全（本阶段）
- **明文 HTTP**。**必须**用云安全组 / 系统防火墙把 **47020** 只放行给你的源 IP：
  ```bash
  sudo ufw allow from <YOUR-SOURCE-IP> to any port 47020 proto tcp
  ```
  （阿里云再在**安全组**放行同一条 —— 系统防火墙 ≠ 安全组，两处都要。）
- 纯 IP + http 非安全上下文：浏览器 Service Worker / secure-cookie 能力受限（当前 token 走内存态 bearer，不依赖 cookie，可接受）。
- **TLS / 反代（Caddy/nginx 443）留 0.6**。

## 7. 升级 / 拆除
```bash
sudo npm i -g @orpheus-aviary/owl-server@latest && sudo systemctl restart owl-server   # 升级
sudo systemctl disable --now owl-server && sudo rm /etc/systemd/system/owl-server.service  # 拆除
# 数据在 $OWL_NEST_DIR/owl/（owl.db 等）；备份/迁移直接拷该目录。
```
