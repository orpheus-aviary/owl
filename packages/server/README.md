# @orpheus-aviary/owl-server

Owl 笔记的**云端服务器**：单进程 = Fastify daemon + 内嵌 web bundle（同源托管）。异地浏览器登录后读/改笔记，账号认证由一台 skybridge server 提供。

> owl-server **只跑 cloud 模式**，缺配置文件会拒启（不会静默降级成无鉴权）。

## 安装

```bash
npm i -g @orpheus-aviary/owl-server
```

需 Node ≥ 22。`better-sqlite3` 优先用预编译产物；拉不到时回退 node-gyp（需 `build-essential python3`）。

## 快速开始

1. 先部署一台 [skybridge server](https://www.npmjs.com/package/@orpheus-aviary/skybridge-server)（账号认证）。
2. 拷贝随包发布的样例配置到 nest：
   ```bash
   export OWL_NEST_DIR=/opt/owl-nest
   mkdir -p "$OWL_NEST_DIR/owl/logs"
   cp "$(npm root -g)/@orpheus-aviary/owl-server/owl_config.toml.sample" \
      "$OWL_NEST_DIR/owl/owl_config.toml"
   ```
3. 计算 owner 的 `account_lock`，填进配置：
   ```bash
   owl-server compute-owner --server-url http://SKYBRIDGE-IP:8443 --email owner@example.com
   ```
4. 启动（默认端口 **47020**）：
   ```bash
   OWL_NEST_DIR=/opt/owl-nest owl-server
   ```
5. 浏览器打开 `http://THIS-SERVER-IP:47020/` → 登录 → 渲染真实笔记。

完整部署 / systemd / 安全组 / 升级见仓库 `docs/deploy/owl-server-ubuntu.md`。

## 配置要点

```toml
[daemon]
mode = "cloud"                              # 只能 cloud
bind = "0.0.0.0"
# port 省略 → 默认 47020
server_url = "http://SKYBRIDGE-IP:8443"     # 固定的 skybridge 地址
account_lock = "<owner-profileId>"          # 见上面 compute-owner
public_url = "http://THIS-SERVER-IP:47020"  # 本机对外 origin（驱动 Host/CORS）
# web_root 省略 → 托管包内内嵌的 web bundle
```

## License

MIT
