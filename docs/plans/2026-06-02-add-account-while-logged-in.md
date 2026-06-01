# 插队功能：已登录态直接添加新账号（多账号 add，语义 A）

> 排期：插在 **Phase 17 之后、Phase 18 之前**（不在设计稿 §11 原路线）。
> 父设计：`2026-05-29-account-profile-isolation-design.md`（v6，§5.4.1 登录顺序 / §5.4.3 D2 step-away / §5.5 import 守卫 / §5.4.4 B7 reload 权威）。
> 状态：**已实现 + whole-repo 全绿 + 真机手测通过（2026-06-02）**。经 2 轮 review 定稿；实施记录见 §9。

## 0. 一句话

允许在**已登录账号 A 的状态下直接登录/添加另一个账号 B**：B 成为当前账号，A 降级为「已保存」条目留在侧栏列表里，随时可**免密快切**（17b）回去。**不加任何「必须先切回本地」守卫**。

## 0.1 需求反转记录（重要）

- **原始需求（用户 2026-06-02 提，已废）**：「登录守卫」——已登录某账号时**禁止**直接再登另一账号，必须先切回本地。
- **反转（用户 2026-06-02 同对话确认）**：改为**支持**在已登录态直接添加新账号（本文「语义 A」）。原「禁止 + 引导切回本地」方案**作废**，不实现任何 login guard。

## 0.2 架构事实（决定语义边界）

daemon **同一时刻只能打开一个 active profile db**（`/sync/switch` 是整库 swap，Phase 14）。所以「同时在线两个账号」在 daemon 层不存在。「多账号」= **已保存列表 + 免密快切**，不是并发会话。因此「添加 B」只有两种语义：

- **语义 A（本文采纳）**：添加 B 并**立即切到 B**，A 留在已保存列表（Gmail/Slack 模型）。
- 语义 B（不采纳）：添加 B 但 daemon 仍停在 A，B 只进列表不打开——需新增「建库但不切换」通道，收益不大，**弃**。

## 0.3 决策（D-add）

| # | 决策 |
|---|---|
| D-add-1 | 已登录态可直接登录新账号；新账号成为 active，旧账号保留为已保存条目（其 `[profiles.<旧>]` 段、token、device、workspace 全留 → 可免密快切回去，符合 D2 step-away）。 |
| D-add-2 | **无 login guard**：`loginAndOpenSession` 不校验 effective active 是否为 local。 |
| D-add-3 | **认领（claim）仅当从 local 登录时触发**。`maybeClaimLocalInto` 仅在 `prior === local` 时跑——「认领本地笔记」是唯一的 local→账号 on-ramp（§5.5），从账号 A 添加 B 时绝不弹认领（语义上你来自 A 不是 local）。 |
| D-add-4 | **失败回滚到 prior（不再一律掉回 local）**：登录中途失败时，已切库则精确回滚到 prior 账号（复用 `rollbackToPrior`），未切库则只恢复 prior 续期定时器（`reschedulePrior`）。从 local 登录失败 → 回 local（行为等价旧版）。 |
| D-add-5 | 守卫范围只在「输入凭证登录」这条路；已保存账号间 A↔B 免密快切（17b headline）**不受影响**。 |

**三处 UX 拍板（用户 2026-06-02）**：
- **入口两处**：Settings auth view 按钮（正门）+ 侧栏 popover「+ 添加账号」（快切上下文捷径）。不加第三处；若必须只留一处则留 Settings。
- **重登当前账号**：允许（等价「用密码重装当前 session / refresh token」，修坏会话有价值）；以测试锁住成功 + 失败回滚两路（§4.1）。
- **表单预填**：预填当前 `server_url`、清空 `email/password`（同服务器换号高频，server 非敏感）。

## 0.4 不变式对齐（不得打架）

- **D10b（账号同步永不写 `owl/owl.db`）**：本功能不碰 local 库。D-add-3 反而**收紧**了认领触发（只 from-local），更安全。
- **§5.4.1 / B9（先备库再 switch）**：保持。从账号添加 B 仍是「register/ensureWorkspace（remote-only）→ postSyncSwitch(B) → install」，daemon 切库前不动业务库。
- **D2（step-away 保留 token）**：旧账号 A 切走时**不 revoke、不清 token**——本就是登录新账号把 active_profile 指向 B、A 段原样留存，天然满足。
- **§5.3（device 复用）**：B 回访（`profiles/<B>` 已存在）走 `postSyncSwitch` 拿回 device_id 复用；不变。
- **§5.4.4 / B7（受控 reload）**：登录成功 main 已 `notifyProfileSwitched()`（`sync-ipc.ts:60`）→ renderer 整窗 reload 落到 B。复用，无需新机制。

## 1. 改动总览

**关键性质：无 daemon、无 core、无新 IPC 改动。** 全部落在：
- **main**：`packages/gui/src/main/sync-auth.ts` 的 `loginAndOpenSession` 多账号化（slice 1）。
- **renderer**：`SyncSection.tsx`「添加账号」入口 + `SyncStatusBar.tsx` 侧栏「+ 添加账号」行（slice 2）。

复用既有 `sync:login` IPC 与 `loginAndOpenSession` 入口；复用 sync-auth.ts 现成的 `rollbackToPrior` / `reschedulePrior` / `clearRefreshTimer` 助手。

---

## 2. Slice add-1（main）：`loginAndOpenSession` 多账号化

`sync-auth.ts:141`。现行假设「从 local 登录」（失败 unwind 一律 `bestEffortSwitchLocal()` 掉回 local，line 235；从不停 prior 续期定时器；总是评估认领）。改为 prior-感知：

### 2.1 进门捕获 prior（在动 daemon/timer 之前）

```
const prior = readEffectiveActiveProfileId();   // resolver gate，非 raw active（防 ghost）
let priorExpiresAt: number | null = null;       // catch 作用域可见，进 try 后赋值
```

- `skybridgeLogin`（remote，throw=密码错等）**仍在 try 之前**：失败时 daemon/timer 全未动，prior 会话 + 续期定时器原样 → 直接 rethrow，prior 不受损。
- `serverId` 缺失（R5，server 太老）路径**仍在 try 之前**：`bestEffortRemoteLogout(auth) + throw`，不动 prior。

### 2.2 进 try 第一件事：捕获 priorExpiresAt + 停 prior 定时器

```
try {
  priorExpiresAt = currentExpiresAt;  // prior 账号当前 access 的到期（local 无 → null）
  clearRefreshTimer();                // 停 prior 续期，避免切库窗口里 prior 的 refreshSession 把旧会话装进新库
  let switched = false;
  ...
```

> 为何在 login 成功**之后**才停定时器：若提前到 `skybridgeLogin` 前停，密码打错（最常见）会让 prior 会话失去自动续期到下次 focus/resume——回归。故停定时器与切库一起，归入 try。

### 2.3 认领仅 from-local（D-add-3）

首登分支（`profiles/<B>` 不存在）里：

```
device = await registerNewDevice(auth);
const client = createSkybridgeClient({ authContext: auth, deviceId: device.id });
workspace = await ensureOwlWorkspace(auth, device.id, client);
if (prior === LOCAL_PROFILE) {
  await maybeClaimLocalInto(client, workspace.id, profileId, auth.user.email);  // 只 from-local 才认领
}
await postSyncSwitch(profileId);
switched = true;
```

回访分支（`profiles/<B>` 已存在）不变，切库后 `switched = true`。

### 2.4 失败回滚到 prior（D-add-4）

```
} catch (err) {
  await bestEffortRemoteLogout(auth);             // 撤刚签发的 B token 家族（不变）
  if (switched) await rollbackToPrior(prior, priorExpiresAt);  // daemon 已在 B → 精确回 prior
  else reschedulePrior(prior, priorExpiresAt);    // 未切库 → 只恢复 prior 续期定时器
  throw err;
}
```

- 复用现成助手（switchToProfile 已用）：`rollbackToPrior(local)` = 切 local + setActive(local) + clearTimer；`rollbackToPrior(account)` = 切回 + `planQuickSwitch`（prior refresh 未动仍有效）+ install + reschedule。`reschedulePrior` 对 local / null 自动 no-op。
- **从 local 登录失败的回归等价性**：prior=local → `switched` 时 `rollbackToPrior(local)`（切 local），未 switched 时 `reschedulePrior(local)`（no-op）。等价旧 `bestEffortSwitchLocal()`（active_profile 本就还指向 prior，因 `writeProfileConfig` 是最后一步，失败时从未改）。

### 2.5 成功路径尾部不变

`writeProfileConfig(B, { setActive: true })` + `scheduleRefresh(auth.expiresAt)`（替换被清的 prior 定时器）。A 段原样保留 → 侧栏列表里可快切。

### 2.6 边界

| 边界 | 处置 |
|---|---|
| 从账号 A 添加 B（首登 B），B 空 + local 有笔记 | **不弹认领**（D-add-3）；B 空起步纯拉取。 |
| 从账号 A 添加 B（回访 B，`profiles/<B>` 已存在） | 切 B + device 复用；等于「凭密码切到 B」（即便 B 的 refresh 已死也能进）。 |
| 从账号 A 重登 A 自己（`profileId === prior`，prior≠local） | 允许：`existsSync(A)` true → `postSyncSwitch(A)`（自切，Phase 15 已有 switch-gate 自指豁免）→ 重装 A 会话。等于「修复当前账号会话」，无害有用。 |
| 中途失败留下 `profiles/<B>/owl.db` 孤儿（postSyncSwitch 建库后失败） | 无害：resolver 三重 gate 需 `[profiles.<B>]` 段存在，`listProfiles` 也只读 toml 段 → 孤儿 db 不入列表、不被 resolve。**pre-existing**（from-local 首登失败同此）。 |

---

## 3. Slice add-2（renderer）：「添加账号」入口

### 3.1 抽 `<LoginForm>`（presentational，SyncSection）

把 `SyncSection.tsx` unauth 分支的登录表单抽成可复用子组件 `LoginForm`：自管 `serverUrl/email/password` 内部输入态，props = `{ initialServerUrl, submitting, error, onSubmit({serverUrl,email,password}), onCancel? }`，提交仍走 `window.owlAPI.sync.login`（不变）。成功后 main 已 `notifyProfileSwitched` → 整窗 reload，表单 state 随 reload 丢弃，无需手动 refreshStatus。

**错误显示钉死一处（避免重复报错）**：**登录错误只在 `<LoginForm>` 内部显示**（`error` prop 渲染在表单里），`handleLogin` 不再写 SyncSection 顶层 `error` banner。顶层 banner（`SyncSection.tsx:104`）**仅保留给 status 拉取 / logout 错误**。两处永不显示同一条错误 → 无重复。

**server 预填（保留 line 51 既有好行为，不回退默认）**：父级 SyncSection 计算
`initialServerUrl = session?.server_url ?? snapshot?.server_url ?? DEFAULT_SERVER_URL`，传入 LoginForm 作内部 `serverUrl` 初值；`email/password` 每次 mount 起为空。
- auth-view 添加 → `session.server_url`（同服务器换号高频，**预填 server、清空 email/password**，符合 Q3 拍板）。
- unauth keychain-broken（active=账号但 session null）→ `snapshot.server_url`（不硬编码 127）。
- unauth local → `DEFAULT_SERVER_URL`（= 今日实际行为；Phase 16 reload 后本就如此，非本次回归）。
- LoginForm **绝不**在子组件里硬编码 DEFAULT 忽略 prop。

> 实现取舍：LoginForm 自管输入态而非父级全控——add 表单为条件渲染，开关 `action=add` 时随挂载/卸载天然得到「每次打开都是空 email/password + 预填 server」，无需 useEffect 同步、无需手动清字段。

### 3.2 auth view 加「添加账号」（URL `action=add` 单一真源，无本地 mode state）

**add 表单可见性 = `searchParams.get('action') === 'add'`**（URL 驱动，避免本地 state 与 URL 双真源 / useEffect 同步）。SyncSection 用 `useSearchParams`：
- auth view 账号卡片下加 `添加账号` 按钮（outline）→ onClick `setSearchParams({ tab: 'sync', action: 'add' }, { replace: true })`。
- `action==='add'` 时渲染 `<LoginForm onCancel={cancelAdd} initialServerUrl={…} />`。**说明文案 `登录另一个账号；当前账号会保留在列表中，可随时切换。` 仅在 `view.kind === 'auth'`（auth add 态）显示**——local / keychain-broken unauth 态下你本就没有「当前账号」，显示这句语义怪，故不显（unauth 态的 `action=add` 等于「表单已在」，不另加说明）。
- **取消 = 清 `action`**：`cancelAdd` → `setSearchParams({ tab: 'sync' }, { replace: true })`（保 tab、删 action，URL 不残留 add intent）。
- 切 tab 时 `SettingsPage.onSelect` 本就 `setSearchParams({ tab: id }, { replace: true })`（整体替换）→ 自动丢掉 `action`。
- unauth view（local / broken）：`action` 与否都显表单（旧行为）；`action=add` 在 local 态等于「表单已在」，无害。

### 3.3 侧栏 ProfileSwitcher 加「+ 添加账号」（受控关闭 popover）

`SyncStatusBar.tsx` 的 `ProfileSwitcher` 列表末尾加一行 `+ 添加账号`，`<Link to="/settings?tab=sync&action=add">`。**当前 Popover 非受控（`SyncStatusBar.tsx:75`），裸 Link 导航不保证关闭 popover** → 用 Radix `PopoverClose` 包住 Link：给 `ui/popover.tsx` 补一行 `export PopoverClose`（`PopoverPrimitive.Close`，data-slot），`<PopoverClose asChild><Link …/></PopoverClose>` → 点击同时导航 + 关 popover。不依赖 Link 单独关闭、也不必把 Popover 改受控。

### 3.4 文案集中

- 按钮：`添加账号` / 侧栏：`+ 添加账号`
- auth view 说明：`登录另一个账号；当前账号会保留在列表中，可随时切换。`

---

## 4. 测试计划

### 4.1 main（`sync-auth.test.ts`，复用 Phase 17 mock 基建）

- **从账号登录新账号 → 切到 B、A 段保留、不弹认领**：`readEffectiveActiveProfileId` 返回账号 A；assert `maybeClaimLocalInto`/`promptClaim` 未调用、`postSyncSwitch(B)`、`writeProfileConfig(B,{setActive})`、A 段未被改。
- **从账号登录失败 → 回滚到 A**：在 `postSyncSwitch(B)` 之后某步抛错（如 `postSyncSession` 非 2xx）；assert `bestEffortRemoteLogout`、daemon 切回 A（`postSyncSwitch(A)`）、A 会话重装、定时器重排。
- **登录前失败（密码错）不动 prior 定时器**：`skybridgeLogin` 抛 → assert 未 `clearRefreshTimer`、prior 定时器仍在。
- **从 local 登录仍认领 + 失败 unwind 到 local（回归）**：prior=local，空账号+local 有笔记 → `promptClaim` 调用；失败 → 切 local。
- **重登当前账号（`profileId === prior`，prior≠local）—— 刻意允许的行为，须锁**（`sync-auth.test.ts` 现无覆盖）：
  - 成功路径：active=A，登录 A 自己（`existsSync(A)` true）→ `postSyncSwitch(A)` 自切 + device 复用 + 重装 A 会话 + `scheduleRefresh`；assert **不抛 + `[profiles.<A>]` 段仍存在 + device/workspace 复用（沿用旧值）+ encrypted_token/encrypted_refresh_token 被本次登录结果覆盖**（重登 = 用密码重装 session/refresh，密文本就该刷新，**不**断言 A 段「整体不变」）。
  - 失败路径：同上但某步抛 → `switched` 已 true → `rollbackToPrior(A)`（回 A，会话重装），不掉 local。
- mock 增补：core mock 让 `readProfileSection(prior)` 返回 A 完整段（rollback 的 `planQuickSwitch(A)` 用）；`skybridgeRefresh` mock 覆盖 rollback refresh。

### 4.2 renderer

- **测试基建（前置）**：SyncSection 改用 `useSearchParams` → 现有 `SyncSection.test.tsx` 的 14 处裸 `render(<SyncSection />)`（line 59 起）会缺 Router context 而挂。统一改用 `MemoryRouter` 包裹（加一个 `renderWithRouter(<SyncSection />, { route })` helper，`route` 默认 `/settings?tab=sync`，add 用例传 `?tab=sync&action=add`）。
- `SyncSection.test`：auth view 渲染「添加账号」按钮；点击 → URL `action=add` → 出现 LoginForm（server 预填 session.server_url、email/password 空、说明文案显）；取消 → `action` 被清、回账号卡片。`?action=add` 初始路由 → 直接进 add 态。unauth view 仍直接显表单且**不显** auth 说明文案（回归 + §3.2）。
- `LoginForm`（独立文件）：提交调 `sync.login`、error 在表单内渲染、disabled 规则。
- `SyncStatusBar`/`ProfileSwitcher.test`：列表末尾有「+ 添加账号」行且 `to=/settings?tab=sync&action=add`。**`SyncStatusBar.test.tsx:15` 的 `vi.mock('@/components/ui/popover')` 须补 `PopoverClose` passthrough**（现 mock 无此项，用到 `<PopoverClose>` 会渲染挂）。
- owlAPI stub：**无新 IPC**，`test-setup.ts` / `MigrationDialog.test.tsx` 的 `sync.*` stub 已含 `login`，无需扩。

### 4.3 验收

`pnpm -r build` → `just check`（8 守卫 + typecheck）→ core / daemon / cli / gui 全绿（仅 gui 数变）→ gated e2e 16/16（结构未变，应保持）。

---

## 5. 手测清单（真机，隔离 nest + 真 0.1.4 server + 账号 a@local/b@local）

```
### 手动测试：已登录态添加新账号

1. 登录 a@local → 进账号态 → 预期：Settings 显 a 的三行 + 「添加账号」按钮；侧栏 popover 列表 = 本地/（a 当前）/+ 添加账号
2. Settings auth view 点「添加账号」→ 输入 b@local 登录 → 预期：整窗 reload，当前账号变 b；侧栏列表 = 本地/a(可快切)/b(当前)/+ 添加账号
3. 侧栏 popover 点 a → 预期：免密快切回 a（17b 不受影响）
4. 侧栏「+ 添加账号」→ 跳 Settings 同步 + 自动展开登录表单 → 登录第三个账号 → 预期：reload 落到新账号，a/b 都在列表
5. 账号态点「添加账号」→ 故意输错密码 → 预期：报错中文映射，仍停在当前账号（不掉回本地、续期定时器未断）
6. 账号态添加一个「local 有笔记」也不弹认领（对照：从本地态登录空账号仍弹认领）→ 预期：账号态 add 无认领弹框
7. 文件核验：`owl/owl.db` 未被任何账号同步污染（D10b）；旧账号 `[profiles.<旧>]` 段 token 原样保留
```

> rig recipe 见 `[[reference_skybridge_dev_workflow]]` / 父 brief。

---

## 6. 非目标

- 语义 B（添加但不切换、后台挂着多个 active 会话）——不做。
- 跨账号导入（A 的笔记搬进 B）——0.6+（§5.5 末）。
- 任何 login guard——已废（0.1）。
- `resetAllStores(epoch)` 免 reload 精修——仍留 0.6（§5.4.4）。

---

## 7. 切分与提交

- **slice add-1（main）**：`loginAndOpenSession` 多账号化 + 测试。scope `skybridge`。
- **slice add-2（renderer）**：`<LoginForm>` 抽取 + auth view 添加账号入口 + 侧栏「+ 添加账号」+ `PopoverClose` + 测试。scope `gui`/`skybridge`。
- **提交纪律（须先获用户授权）**：实现与验证（`pnpm -r build` + `just check` + 相关单测 + gated e2e）完成后，**先把改动与验收结果汇报给用户、等用户确认授权再 commit**——不自行「切片完成即 commit」。落 main 不 push。
- PROCESS.md（含本次 line 22 反转修订）+ 本 plan 留工作树给用户提交（[[feedback_process_doc_commit]]）。commit trailer = `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## 8. 实施前置（开工第一步）

1. **已完成**：PROCESS.md line 22 由「禁止直接再登录另一账号」反转为「支持已登录态添加新账号」，与本计划语义一致（消除冲突）。

## 9. 实施记录（2026-06-02，待用户授权 commit + 真机手测）

**slice add-1（main，已实现+测过）**：`loginAndOpenSession` 多账号化——进门捕获 `prior=readEffectiveActiveProfileId()`；login 成功后才 `clearRefreshTimer()`（捕获 `priorExpiresAt`）；首登 claim gate 收紧到 `prior===LOCAL_PROFILE`（D-add-3）；`switched` 标志 + 失败回滚 `switched ? rollbackToPrior : reschedulePrior`（复用现成助手，D-add-4）。header 注释更新（unwind 契约：回 prior 非 local）。测试 +5（多账号 add describe：从账号添加不弹认领 / 失败回滚到 prior 账号 / 密码错不停 prior 定时器 / 重登当前账号成功覆盖密文+复用 device / 重登失败回滚到自身非 local）。

**slice add-2（renderer，已实现+测过）**：
- `ui/popover.tsx` 加 `PopoverClose` 导出。
- 抽 `components/settings/LoginForm.tsx`（presentational，自管输入态，server 预填、error 内显、可选 `onCancel`）。
- `SyncSection.tsx` 改 `useSearchParams` 驱动 `?action=add`；auth view 加「添加账号」按钮 + add 态（说明文案仅 auth）；login error 改走 LoginForm（顶层 banner 仅 status/logout）；`rememberedServer = session ?? snapshot ?? DEFAULT`。
- `SyncStatusBar.tsx` ProfileSwitcher 末加「+ 添加账号」行（`PopoverClose` 包 Link → `?tab=sync&action=add`）。
- 测试：SyncSection 全render 包 `MemoryRouter`（renderSection helper）+ add describe（6）；新 `LoginForm.test`（5）；SyncStatusBar mock 补 `PopoverClose` + add-row 测试（1）+ 修 ghost/legacy 链接断言（排除 add 链接）。

**验收（whole repo 全绿）**：`pnpm -r build` ✓ · `just check`（typecheck + 6 守卫）✓ · core **519** / daemon **283** / cli **134** / gui **385**（+17）✓ · gated e2e **16/16** ✓。

**真机手测通过（2026-06-02）**：隔离 nest + 真 0.1.4 server（server_id 锚 + a@local/b@local）跑完 §5 全清单——账号态「添加账号」入口 + server 预填 + 输 b 登录整窗 reload 切到 b + a 留列表可免密快切 + 侧栏「+ 添加账号」展开表单 + 取消清 `action=add` + 错误表单内显 + 认领仅 from-local。rig 已清理。**已 commit 落 main（未 push）**。
