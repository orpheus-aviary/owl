# owl

猫头鹰笔记（TypeScript 版）—— `orpheus-aviary` 项目下的桌面笔记工具。

## 状态

当前版本 **0.2.0**（首发）。
- 仅支持 macOS Apple Silicon（arm64）
- 不含自动更新
- 未做 codesign / notarize，首次运行需绕过 Gatekeeper

## 下载安装（macOS arm64）

1. 前往 GitHub Releases 下载最新 `Owl-0.2.0-arm64.dmg`
2. 双击 dmg，把 `Owl.app` 拖进 `/Applications`
3. 在 Finder 中 **右键点击 `Owl.app` → 打开**，在弹窗中再次点"打开"
   （不要双击 — macOS 会拦截未签名应用；右键"打开"只需做一次，之后可直接启动）

## 数据目录

所有数据位于 `~/orpheus-aviary-nest/owl/`：
- `owl.db` — 笔记数据库
- `owl_config.toml` — 配置
- `logs/` — 日志（pino-roll 按天轮转）
- `daemon.pid` — 运行中的 daemon 进程号

卸载时删除 `/Applications/Owl.app` + `~/orpheus-aviary-nest/owl/` 即可。

## 开发

需要 Node ≥ 22、pnpm、macOS（dmg 打包）。

```bash
pnpm install        # 安装依赖
just check          # lint + typecheck
just test           # 跑测试（core 84 + daemon 95 + gui 49）
just dev            # 启动 Electron dev（自动起 daemon）
just dev-daemon     # 只起 daemon
just package        # 打 dmg（输出到 packages/gui/release/）
just unpackage      # 打包后恢复 Node ABI 以便再跑测试
```
