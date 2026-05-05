# P3.4-c 设计：AI chat 笔记 id → 可跳转 pill

> 日期：2026-05-05
> 状态：shipped 2026-05-05
> 前置：P3.4-b shipped
> 后置：P3.4-d

## 1. 目标

AI 助手在聊天里频繁引用笔记 UUID。用户要能左键点开那条笔记、右键复制 id。

## 2. 作用面

| 位置 | 是否生效 |
|---|---|
| assistant 消息 markdown | ✅ |
| user 消息 | ❌（保持纯文本） |
| 编辑器 markdown preview | ❌（用户手写 UUID 不 pill 化） |
| FolderPanel / tab / 侧栏 | ❌ |

启用方式：`<MarkdownPreview linkifyNoteIds />`，默认 false。

## 3. 最终架构

**`linkifyNoteIds=true` 时激活的两个改动**：

1. **remark 插件 `remarkNoteRefs`**（`packages/gui/src/renderer/src/lib/note-id-refs.ts`）
   遍历 mdast，把三种形式的 UUID 引用全部归一为 `link { url: 'note:<uuid>' }` 节点：

   | AI 输出形式 | 插件处理 |
   |---|---|
   | 裸 UUID in text node（`see 00000000-...-0001 now`） | 分割 text 节点，插入 link |
   | 单反引号包围（`` `00000000-...-0001` `` —— AI 最常用） | 把 inlineCode 节点替换成 link |
   | 链接形式（`[标题](00000000-...-0001)`） | 重写 link.url 为 `note:...`，children 保留 |

   **跳过**：`code`（fenced 代码块）/ `linkReference`；`link` 节点不递归进 children（防嵌套 link）。

2. **`MarkdownPreview` 的 `<a>` override + `urlTransform`**
   - `urlTransform`：react-markdown v10 的 `defaultUrlTransform` 会把未知 scheme 改写为 `""`（只白名单 `https?/ircs?/mailto/xmpp`）——自定义 transform 让 `note:` 直通，其他走默认 sanitizer
   - `<a>` override：`href` 以 `note:` 开头 → 渲染 `<NoteIdPill id=... />`；其他 href 走原本的外链 / 锚点逻辑

3. **`NoteIdPill` 组件**（`packages/gui/src/renderer/src/components/NoteIdPill.tsx`）
   - 视觉：下划线 + 浅蓝（`#60a5fa`，hover `#93bbfd`），匹配 `.markdown-preview a` 风格
   - 四态：loading（浅蓝脉冲）/ ok（浅蓝带下划线可点）/ trashed（灰色删除线）/ missing（灰色 `{前8位…}`）
   - 交互：左键 → `openNoteById + navigate('/')`；右键 → shadcn ContextMenu "复制 ID"
   - Label 截 20 字；ignore children（始终显示 `getNote` 拿到的真实标题）

4. **LRU + 并发去重**（`note-id-refs.ts` 同模块）
   - 100 条 entry 的 Map，insertion order LRU
   - `pending: Map<id, Promise>`：同 id 多 pill 并发 mount 只发一次 fetch
   - 非 404 网络错误不缓存，remount 重试；Pill 的 effect 用 `.catch` 记日志防 unhandled rejection
   - 单测通过 `_resetNoteIdCachesForTest` 重置

## 4. 系统提示词约束

`packages/daemon/src/ai/system-prompt.ts` 里明确要求 AI：

- 输出**完整 UUID**（一次，可加单反引号），**不要**截短成 `00000000` 前缀
- **不要**自己写成 `[标题](uuid)` 链接 —— pill 已显示标题
- **不要**写完整 UUID 之外再回声一个短前缀

三条规则任意违反都会让 pill 行为退化（前缀无法匹配、嵌套链接 / 双份引用）。

## 5. 改动清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/gui/src/renderer/src/lib/note-id-refs.ts` | 新 | remark plugin + UUID 正则 + LRU + fetchNoteMeta + 测试重置 helper |
| `packages/gui/src/renderer/src/lib/note-id-refs.test.ts` | 新 | 13 单测：plugin 三种输入形式 + LRU 驱逐 + 并发去重 + 404/trashed/网络错误 |
| `packages/gui/src/renderer/src/components/NoteIdPill.tsx` | 新 | 组件，四态 + ContextMenu |
| `packages/gui/src/renderer/src/components/MarkdownPreview.tsx` | 改 | `linkifyNoteIds` prop + `noteAwareUrlTransform` + 组件内 `useMemo` 生成 plugins/components |
| `packages/gui/src/renderer/src/components/MarkdownPreview.test.tsx` | 新 | 3 集成测试：pill 挂载 / default off / fenced 代码块 skip |
| `packages/gui/src/renderer/src/components/ai/MessageBubble.tsx` | 改 | assistant 的 MarkdownPreview 传 `linkifyNoteIds`；顺手把 `ThinkingBlock` 改为始终默认折叠 |
| `packages/daemon/src/ai/system-prompt.ts` | 改 | UUID 输出格式规则 |

不动：daemon routes / db schema / API 形状。

## 6. 升级到方案 B 的触发

写在文档里备查；本次不做：

- 误触率（AI 频繁输出非笔记 UUID）> ~10%
- 用户反馈 "改了标题但 pill 还是旧的"（缓存 stale）
- 同一 chat 并发 fetch > 20+ 且真成性能问题

方案 B：daemon agent loop 跟踪 `referenced_note_ids`，SSE 下发结构化 meta，renderer 直接 subscribe。

## Implementation record

**Date shipped**: 2026-05-05

**最终测试**：117 / 117 gui + 150 core + 128 daemon + 119 cli = 514/514 通过。

### 本质原因：为什么改了好几轮

这个功能是 **"AI 输出格式" × "markdown 渲染管线" 的交集**，两边各有坑：

1. **react-markdown v10 的 URL sanitizer**（首发打不开 pill 的根因）
   `defaultUrlTransform` 白名单只有 `https?/ircs?/mailto/xmpp`，`note:` 被改写成 `""`，`<a>` override 看到空 href，pill 永远不渲染。必须传自定义 `urlTransform` 才让 `note:` 通过。**看文档没看到、单测没跑完整 ReactMarkdown 管线 → 漏查**。后补集成测试 `MarkdownPreview.test.tsx` 用真实 ReactMarkdown 组件跑，以后重现必失败。

2. **AI 输出不是单一形态**（第 2-3 轮的根因）
   初版插件只处理"裸 UUID in text node"，但真实 AI 会：
   - 用单反引号 `` `<uuid>` `` 包围（加视觉强调）→ 进了 inlineCode，被 skip
   - 写成 `[标题](<uuid>)` markdown link → 进了 link，被 skip
   - 截断成 8 位短前缀 `c6610469` → 正则不匹配

   前两种靠扩展插件覆盖（inlineCode 仅当整段是 UUID 时转 pill；link 仅重写 url）；第三种靠系统提示词约束。

3. **设计 doc 漏了 prompt side 的契约**
   Plan §7.4 只讨论 GUI 侧，没把"AI 必须输出什么形态的 UUID"作为 contract 显式写出来。对话 skill 级的功能必须两边都定死，否则 AI 一 drift 就出 bug。

### 教训（memory-worthy）

- react-markdown 自带 URL sanitizer，非标准 scheme 必须过 `urlTransform` —— **用自定义 href scheme 的任何 feature 都要先查这个**
- AI 输出格式是 feature 契约的一部分，对应的系统提示词约束必须和 GUI 解析器**同文档讨论**，否则 prompt drift 静默拆 feature
- 解析器覆盖面宁可过宽（多种 AI 写法都能 pill 化）也不过窄，因为 prompt 没法 100% 约束 AI

**承诺覆盖三种 AI 输入形态 + prompt 三条禁忌**，后续 AI 还想出新花样（比如写成 XML `<note id="...">` 之类），当作升级方案 B 的信号。

### 未解决但可接受

- 截短前缀目前只靠 prompt 约束，没有 GUI 兜底（兜底=维护"全 id 索引"做模糊匹配，代价大不划算）
- 标题 stale（改名后已有 bubble 不刷新）—— 方案 A 明文接受

### 后续小事

- search_notes tool description 目前不告诉 AI FTS5 语法（`react typescript` 隐式 AND / `OR` / `"phrase"` / `prefix*`）。AI 偏爱单词查询导致召回低。可加 description 优化，但不属于 P3.4-c 本体，单独 issue 处理。
