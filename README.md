# owl

猫头鹰笔记（TypeScript 版）—— `orpheus-aviary` 项目下的桌面笔记工具。Electron + Fastify + React，
可选接入 skybridge 做多设备 / 多账号同步。

## 状态

当前版本 **0.6.0**。
- 仅 macOS Apple Silicon（arm64）
- GUI 为 ad-hoc 签名（未 notarize），首次运行需绕过 Gatekeeper
- 无自动更新

0.6.0 主打**同步状态可视化 + 无缝切账号（无刷新）+ 冲突手动解决 / 合并**，并给本地 daemon 加了鉴权
（**破坏性变更**：升级后重启 daemon，CLI 需一起升级到 0.6.0）。完整发版说明见
`docs/history/0.6.0-release-notes.md`。

> **网页 / 移动端**：云端版 `@orpheus-aviary/owl-server`（npm）在浏览器里用同一套 skybridge 账号读写
> 笔记，与桌面版独立发布；自部署见 `docs/deploy/`。当前明文 HTTP + 锁源 IP，TLS / 反代留后续。

## 下载安装（macOS arm64）

1. 前往 GitHub Releases 下载最新 `Owl-<version>-arm64.dmg`
2. 双击 dmg，把 `Owl.app` 拖进 `/Applications`
3. Finder 里 **右键 `Owl.app` → 打开** → 弹窗再点"打开"（只需一次；macOS 会拦截 ad-hoc 签名应用）

## CLI

给 agent / 人用的笔记读写入口：

```bash
npm i -g @orpheus-aviary/owl-cli   # 提供 owl 命令；登录请在 GUI 完成（Settings → 同步）
```

## 数据目录

所有数据在 `~/orpheus-aviary-nest/owl/`：
- `owl.db` — 本地笔记库（local 工作区）
- `profiles/<id>/owl.db` — 各登录账号独立库（**账号同步永不写本地库**）
- `owl_config.toml` — 本地偏好 · `logs/` — 日志（按天轮转）

账号 / 凭证配置在 `~/orpheus-aviary-nest/skybridge/skybridge_config.toml`。
卸载：删 `/Applications/Owl.app` + `~/orpheus-aviary-nest/owl/`。

## 开发

需 Node ≥ 22、pnpm、macOS（dmg 打包）。

```bash
pnpm install        # 安装依赖
just check          # lint + typecheck + 守卫
just test           # 全部测试
just dev            # 启动 Electron dev（自动起 daemon）
just dev-daemon     # 只起 daemon
just package        # 打 dmg（输出到 packages/gui/release/）
```

结构与规范见 `CLAUDE.md`，进度见 `PROCESS.md`。
