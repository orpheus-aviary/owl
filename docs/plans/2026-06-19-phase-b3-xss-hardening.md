# Phase B3 子设计：web markdown XSS 硬化（去 rehypeRaw + 外链 noopener）

> 状态：**已实施 + 手测通过（2026-06-19，代码未提交）**。收口方式 = **web 分支去掉 `rehypeRaw`**（开放项 ⭐3 落定）。实施结果见文末 §7。
> 父设计 `docs/plans/2026-06-14-phase-b-web-design.md` §3.4 / §4(B3) / ⭐3；
> 架构 `docs/plans/2026-06-06-mobile-web-ecosystem-arch.md` §7。
> 前置：B0 ✅ B1 ✅ B2 ✅。本片之后 → B4（daemon 静态托管 + CSP）。

---

## 0. Context（为什么做）

Phase B 网页版让同一份 React renderer 跑在浏览器里，连云端 daemon 当瘦客户端。web 端的
bearer token 是**内存态、JS 可达**（⭐2 决策）。当前 `MarkdownPreview` 通过 `rehypeRaw`
（`packages/gui/src/renderer/src/components/MarkdownPreview.tsx:94`）渲染笔记里的**原始 HTML
且无 sanitize**：

- 桌面端是 local sandbox、单写者、内容皆自有 → 风险低，可接受。
- **cloud web 上**，一条含 `<script>` / `<img src=x onerror=…>` 的笔记（可能从另一台设备或另一
  账号同步而来）一旦在浏览器执行，即可 `fetch` 走内存里的 token —— **web 端最大的剩余安全洞**。

目标：在 **web 分支**关掉原始 HTML 渲染面，桌面端零回归。

---

## 1. 决策：去 rehypeRaw（不引 rehype-sanitize）

| 方案 | 取舍 | 结论 |
|------|------|------|
| **A. web 去 `rehypeRaw`** | react-markdown 默认转义原始 HTML → 注入根本不被解析执行；KaTeX/highlight/note-pill 全照常；**代价**：web 上笔记里的内联 HTML（`<details>`/`<sub>`/`<br>` 等）显示为转义文本。最简、最安全。 | **✅ 采用** |
| B. `rehype-sanitize` 白名单 | 保留 web 富 HTML、与桌面更对齐；**代价**：多一个依赖 + 末尾 sanitize 需为 KaTeX 的 MathML/span/style 与 hljs/`language-` class 维护 ~40 行 schema，且 KaTeX/highlight 升级时易碎。 | 否决 |

> **为什么去 rehypeRaw 不伤 KaTeX/highlight**：现链里 `passThrough:['math','inlineMath']`
> 只是为了让 rehypeRaw 的 stringify 不破坏 math 节点。**不挂 rehypeRaw 就没有 stringify**，
> math 节点直通 `rehypeKatex`，highlight 照常作用于 `code` 元素。这正是 react-markdown +
> remark-math + rehype-katex 的标准用法（多数项目根本不挂 rehypeRaw）。

---

## 2. 复用的现有 seam（不新增机制）

- **`getPlatform().remoteClient`**（`platform/types.ts:62`，web=`true`/electron=`false`）：
  B2 已用它门住 CAS + `beforeunload` unsaved guard，本片复用同一门做**渲染分流**，语义吻合
  （“联网瘦客户端 + 共享/不可信内容 + token 在 JS”）。**不新增 flag。**
- component 直接 `import { getPlatform } from '@/platform'` 是既有 sanctioned 模式
  （`App.tsx:5/22`）；守卫 `scripts/check-renderer-owlapi-confined.sh` 只钉 `window.owlAPI`，
  不挡此 import。
- **无新依赖**：方案 A 不引 `rehype-sanitize`；`rehype-raw` 仍保留（桌面分支用）。

---

## 3. 改动（全部在 `packages/gui/src/renderer/src/components/`）

### 3.1 `MarkdownPreview.tsx` — rehype 链按 host 分流
- `import { getPlatform } from '@/platform'`；组件体内 `const remoteClient = getPlatform().remoteClient;`
- 抽 inline prop 进 `useMemo` 后给**显式类型**，避免 TS 把数组推窄/推怪（镜像现有
  `type RemarkPlugins = Options['remarkPlugins'];`，`MarkdownPreview.tsx:14`）：
  新增 `type RehypePlugins = Options['rehypePlugins'];`，并 `useMemo<RehypePlugins>(...)`。
- `useMemo`（deps 含 `remoteClient`）：
  - **web（`remoteClient`）**：`[rehypeKatex, rehypeHighlight]` —— 无 rehypeRaw，原始 HTML 被转义成纯文本。
  - **桌面（否）**：`[[rehypeRaw, { passThrough: ['math','inlineMath'] }], rehypeKatex, rehypeHighlight]` —— **与现行字节一致**。

### 3.2 `MarkdownPreview.tsx` — 外链 `target=_blank` + `rel=noopener`（§3.4 末项，两端通用、对桌面无害）
- `<a>` override 当前结构（`MarkdownPreview.tsx:59-83`）：`a: ({ href, children, ...props }) =>`，
  body 里是 `href={href}`（`:64`）+ `onClick={...}` + `{...props}`（**spread 在最后**，`:78`）。
- **改成 spread-first / 受控-last**，使受控属性永远胜出（防桌面 raw HTML 的
  `<a rel target onclick>` 经 spread 覆盖）：把 `{...props}` 移到**最前**，受控的
  `href` / `onClick` / `target` / `rel` 放其后（等价做法：destructure 掉 props 里的 `rel`/`target`/`onClick`）。
- **外链强制 `target="_blank"` + `rel="noopener noreferrer"` 一起落地**（`rel=noopener` 单独对默认开新页/
  中键/⌘-点击/辅助技术路径语义不清，必须配 `target=_blank`）。**仅对外链**：`#` 站内锚点（onClick 已
  `preventDefault` + `scrollIntoView`）不加 `target`，避免中键把 `#frag` 开成新标签——
  `const isAnchor = href?.startsWith('#')`，`{...(isAnchor ? {} : { target: '_blank', rel: 'noopener noreferrer' })}`。
  （`note:` 链接在 `linkifyNoteIds` 时 early-return 成 `NoteIdPill`，不进 `<a>`。）
- `window.open(href, '_blank')` → `window.open(href, '_blank', 'noopener,noreferrer')`（normal-click 路径双保险）。
- 桌面仍由 `packages/gui/src/main/window.ts:69` `setWindowOpenHandler` 拦截走
  `shell.openExternal`，`target`/`rel`/第三参均无副作用。
- **单测补强**（不只靠手测查 DevTools，§3.3 落地）：
  - **DOM 断言**：渲染一条外链 → `container.querySelector('a[href="https://…"]')` 上
    `target === '_blank'` 且 `rel` 含 `noopener`/`noreferrer`；站内 `#` 锚点 → 无 `target`。
  - **行为断言**：spy `window.open`，点外链后断言以 `('<href>', '_blank', 'noopener,noreferrer')` 调用。
  - （手测里同时在新标签页验证 `window.opener === null`，见 §5。）

### 3.3 `MarkdownPreview.test.tsx` — 补 XSS + 桌面回归用例
- 顶部用 **`vi.hoisted`** mock（与 `editor-store.test.ts:9` / `useWebUnloadGuard.test.tsx:7`
  同款，避开 Vitest hoist 坑——`let` 变量会被 hoist 到 `vi.mock` 之上而踩雷）：
  ```ts
  const platformMock = vi.hoisted(() => ({ remoteClient: true }));
  vi.mock('@/platform', () => ({
    getPlatform: () => ({ remoteClient: platformMock.remoteClient }),
  }));
  ```
  `beforeEach` 复位 `platformMock.remoteClient = true`。（既有 linkify 用例默认跑 web 分支，结果不变。）
- **mock 清理**：现文件 `beforeEach` 只有 `vi.clearAllMocks()`（清调用记录、不还原实现）。本片新增
  `window.open` spy，须在 `afterEach`（或 `beforeEach`）补 `vi.restoreAllMocks()`，否则 spy 的替换实现
  会留到后续用例积灰。
- **web 分支（remoteClient=true）**：
  - 注入 `<img src=x onerror="...">` + `<script>alert(1)</script>` → 断言 `container.querySelector('img')` 与 `'script'` 均为 `null`，且字面文本出现（被转义）。
  - `$x^2$` → 断言 `container.querySelector('.katex')` 存在（KaTeX 未被误伤）。
  - 围栏代码块 → 断言 `container.querySelector('code.hljs')`（或 `.hljs`）存在（highlight 未被误伤）。
- **桌面回归（翻 `platformMock.remoteClient = false`）**：同一段 `<img>` HTML → 断言 `container.querySelector('img')` **存在**（rehypeRaw 仍在 → 桌面零回归）。

---

## 4. 不在本片范围（明确分流）

- **CSP 响应头** → 归 **B4**（daemon `@fastify/static` 同源托管时下发，届时可同源验证）。B3 跑在
  vite dev、daemon 不托管 web，CSP 头此刻无处落地；开放项 ⭐4 已定托管+CSP 进 B4。
- 桌面端渲染 / `rehype-raw` 依赖 / 其他组件：不动。

---

## 5. 验证

1. **targeted**：`pnpm --filter @owl/gui run test` —— 新增 XSS + 桌面回归 + `window.open` 用例通过；既有 gui **434** 全绿不退。（`just test` 跑全 workspace = `pnpm -r run test`，`justfile:81`，留作最终全量。）
2. `just check` —— biome + `tsc -b` + 9 守卫全绿（无新依赖、无新守卫）。
3. `pnpm run build`（root = `pnpm -r run build`，已含 `apps/web` 的 vite build，`package.json:10` + `apps/web/package.json:7`，**不必再单跑 web build**）。
4. **手动测试（GUI 变更，按 owl 规范，可选，用 B0/B1 rig）**：

   ### 手动测试：MarkdownPreview web XSS 硬化
   测试步骤（Claude 后台起 cloud daemon 并经 API 种一条笔记，内容含
   `<img src=x onerror="alert('xss')">`、`<script>alert(1)</script>`、`$x^2$`、一段围栏代码块）：
   1. `just dev-web` 打开 web → 进该笔记预览 → 预期：**无 alert 弹窗**，`<img>/<script>` 显示为转义文本，公式渲染为 KaTeX，代码块有高亮。
   2. 预览里点一条外链 → 预期：新标签打开；DevTools 查 `<a>` 有 `target="_blank"` + `rel="noopener noreferrer"`；在新标签页 console 验 `window.opener === null`（真正确认 opener 不可达）。
   3. `just dev`（桌面 Electron）打开**同一条**笔记 → 预期：原始 HTML 仍按桌面现状渲染（回归对照），外链仍走系统浏览器。
   - 用户反馈结果后再决定是否提交。

---

## 6. 提交（用户确认后）

- 单 commit，scope `gui`（跨 editor 预览 + AI chat 两处消费方）。建议信息：
  `feat(gui): web-branch markdown XSS hardening (drop rehypeRaw) + external-link noopener`
- 完成后更新 `PROCESS.md` 与 `docs/plans/2026-06-14-phase-b-web-design.md` 的 B3 行 ✅
  （PROCESS.md 编辑留工作区，按“分步提交”惯例由用户后提）。
- **同 PR 同步父计划开放项（消除分歧，免后续执行者读岔）**：父计划 §3.4 / §4(B3 行) / 开放项 ⭐3
  原写「倾向 rehype-sanitize」+「B3 含 CSP」。本片落定 = **去 rehypeRaw + CSP 移 B4** → ✅ 已于
  2026-06-19 把父计划这几处改为与本子计划一致（⭐3 标 ✅ = 去 rehypeRaw）。

---

## 7. 实施记录（2026-06-19，已实施 + 手测通过，代码未提交）

**改动**（与上 §3 完全一致，无偏离）：
- `MarkdownPreview.tsx`：`type RehypePlugins`；`const remoteClient = getPlatform().remoteClient`；
  `rehypePlugins` 进 `useMemo` —— web=`[rehypeKatex, rehypeHighlight]`，桌面=`[[rehypeRaw,{passThrough}], …]`。
  `<a>` override 改 spread-first / 受控-last；外链强制 `target="_blank"`+`rel="noopener noreferrer"`（`#` 锚点不加）；
  `window.open(href,'_blank','noopener,noreferrer')`。
- `MarkdownPreview.test.tsx`：`vi.hoisted` platform mock + `afterEach(vi.restoreAllMocks)`；+7 用例。

**自动化验证（全绿）**：
- targeted `MarkdownPreview.test.tsx` **11 pass**（4 既有 + 7 新）。
- gui 全量 **441 pass**（434 → +7，零回归）。
- `just check`（biome + `tsc -b` + 9 守卫）通过；改动两文件 0 warning。
- `pnpm run build`（含 `apps/web`）通过。

**手测（真浏览器，throwaway harness `apps/web/xss-harness.html`，测后已删）**：
直接挂真 `MarkdownPreview`（绕过登录闸，`remoteClient=true`），种 `<script>`/`<img onerror>`/内联 HTML/`$x²$`/JS 代码块/外链/`#`锚点 →
**✅ 无 alert、注入未执行、raw HTML 转义为文本、KaTeX/highlight 正常、外链 `target=_blank`+`rel=noopener noreferrer`+`window.opener===null`**。用户确认「没问题」。

**桌面端**：CAS/渲染均 `remoteClient` 门，桌面 `remoteClient=false` 仍走 rehypeRaw → 零回归（单测 `desktop keeps raw HTML` 钉死）。

**CSP**：未做，按计划归 B4（daemon 同源托管时下发）。
