# P3.3 — 统一发 0.3.0（2026-05-04）

GUI `v0.3.0` (GitHub Release + `Owl-0.3.0-arm64.dmg`) 与 CLI `cli-v0.3.0` (`@orpheus-aviary/owl-cli@0.3.0` on npm) 独立渠道同日发布。

- **GUI Release**: https://github.com/orpheus-aviary/owl/releases/tag/v0.3.0
- **GUI SHA256**: `4b688343bf5f6ea8808d28305024161f64fdac5d88251fe7ab845af424c7919e`
- **CLI npm**: `npm i -g @orpheus-aviary/owl-cli`
- **Tag 策略**: `v* = GUI` / `cli-v* = CLI`，两者指向同一 commit `fabf142`，但渠道独立
- **测试**: 461/461 (core 128 + daemon 122 + gui 92 + cli 119)

## 4 个 commit 交付

| Commit | 内容 |
|---|---|
| `08e9965` | `fix(cli): resolve entry guard realpath for npm i -g symlink installs` — 入口 guard realpath 比较 + `program.version()` 运行时读 package.json + spawn-via-symlink smoke test（CLI 117 → 119） |
| `fabf142` | `chore(release): bump gui and cli to 0.3.0` |
| `24be3da` | `docs: P3.3 0.3.0 shipped — GUI v0.3.0 + CLI cli-v0.3.0` |
| `63ddf1a` | `refactor(cli): simplify bin entry guard + smoke test cleanup` — 入口 guard 加字符串相等快路径避开常见 case 的 `realpathSync` syscall + 统一 `skill export` 版本来源到 `VERSION` 常量 + 清 test 冗余 rmSync pre-block 加 `afterAll` symlink 清理 |

## Release blocker 修复详情

发布前在 npm 本地装包 smoke 中发现 `npm i -g` symlink 安装下 CLI 入口 guard 失效：

- **现象**: `owl --version` 静默 exit 0，所有命令不执行
- **根因**: `npm i -g` 装的 CLI 在 `~/.local/share/mise/...` 是 symlink，`argv[1]` 保留 symlink 路径，`import.meta.url` 已经 realpath；老 guard `file://${argv[1]} === import.meta.url` 永不成立
- **附带问题**: `program.version()` 被硬编码成 `0.3.0-dev` 与 package.json 脱节
- **修复** (commit `08e9965`): 改 `realpathSync(argv[1]) === fileURLToPath(import.meta.url)` 比较 + 运行时读 package.json 版本号（dist sibling > workspace parent）+ 新增 `apps/cli/src/bin.spawn.test.ts`（beforeAll 建 symlink → spawn node → assert `--version`/`--help` 输出）

## 发包踩坑

- npm 默认 token 不带 2FA bypass，需要 "Granular Access Token" 并勾 "Allow access to 2FA required packages"；写入 `~/.npmrc` 的 `//registry.npmjs.org/:_authToken` 成功绕过 OTP 交互
- npm registry propagation 滞后约 2-3 分钟才能 `npm view` / `npm install` 到；dry-run 说 "cannot publish over 0.3.0" 是 backend DB 已写入的证据
- `repository.url` normalize warn: `gen-publishable-manifest.mjs` 写 `https://github.com/orpheus-aviary/owl`，npm 自动加 `git+...git`。小 polish，0.3.1 再 canonical 化

## 未做（已录入 p3-plan §10 / §13）

- CI workflows `release-gui.yml` / `release-cli.yml` codify → P5
- 本地手动发布跑完整流程，下次不必重复
- Windows / Linux 构建 → P5
- codesign / notarize → P5
