# P3.4-d 设计：TagBar Tab/Enter 区分补全

> 日期：2026-05-06
> 状态：design（待 review）
> 前置：P3.4-c shipped
> 后置：P3.4-e

## 1. 目标

编辑区标签输入框（`TagBar.tsx`）当前只有 Enter 一种补全/提交动作。对 `/time` / `/alarm` 这种"字面量 + 参数"型 slash 命令，用户想先补出 `/time ` 再继续打 `19:00`，再 Enter 触发 picker。现在只要 Enter 就会直接打开 picker（参数无机会输入）。

**新增 Tab**：只补字面量前缀、不提交、不触发 picker。Enter 保持现状。

**Scope 仅限编辑区 TagBar**，不碰 CodeMirror 编辑器正文、不做 `[[` wikilink。

## 2. 当前行为速览

| 键 | 有 `#tag` suggestions | 有 `/cmd` frequency popup | 无 popup |
|---|---|---|---|
| Enter | `hasNavigated` → add 高亮 tag；否则 add 原文字面 `#input` | 高亮命令：有 picker → 打开 picker；无 picker → 直接 addTag | `handleEnterDirect`（匹配完整 `/cmd` 则走 picker / addTag，否则当 `#input` 加） |
| ArrowUp/Down | 高亮移动 | 同 | — |
| Esc | 关 popup + 清 input | 同 | — |
| Tab | **默认行为（焦点离开输入框）** | 同 | 同 |

## 3. 新行为

只加 Tab 一条路径；Enter / ArrowUp/Down / Esc 完全不动。

### 3.1 Tab 语义

**统一规则**：Tab = "把当前高亮候选的 `显示字面量` 替换到 input，游标放末尾，popup 关闭，不 addTag，不开 picker"。

| popup 状态 | Tab 后 input 值 | 说明 |
|---|---|---|
| hashtag suggestions 非空 | `#<selected.tagValue>` | 前缀 `#` + tag 名，**不带**尾空格（用户已选定，再按 Enter 就 add） |
| frequency popup 非空 且 selected 是 `/time` / `/alarm` | `<selected.type> ` | **带**尾空格（该空格是 `/time <date-hint>` 的参数分隔符，功能性） |
| frequency popup 非空 且 selected 是 `/daily` / `/weekly` / `/monthly` / `/yearly` | `<selected.type>` | **不带**尾空格；Enter 时由 `FREQUENCY_OPTIONS.find(o => o.type === trimmed)` 精确命中 |
| 无 popup 或候选为空 | 走默认 Tab（焦点离开） | 不拦截，不 preventDefault |

Tab 触发时：
- `preventDefault()` 防焦点跳走
- `setInput(nextValue)`
- 主动关 popup（`setSuggestions([])` / `setShowFrequency(false)` / `setHasNavigated(false)`）：Tab 语义就是"已选定"，不留候选菜单；即使 `useEffect` 会根据新 input 重新拉 hashtag 建议异步弹回来也不影响本帧 UX

**边界**：`hasNavigated=false` 时默认取第一条候选（`suggestions[0]` / `filteredFrequency[0]`）。语义："Tab = 接受最显眼的补全"，与 Enter 在无导航时走字面量提交不同。

### 3.2 Enter 不变

Enter 仍然走现有三条分支（`handleEnterWithSuggestions` / `handleEnterWithFrequency` / `handleEnterDirect`）。注意 Tab 补完之后的输入（如 `/time 19:00`）按 Enter 仍会走 `handleEnterDirect` 的 `startsWith('/time')` 分支，这条路径已有，解析 `19:00` 传给 picker，不需要改。

### 3.3 其他键不变

ArrowUp/Down 导航、Esc 关 popup+清输入、blur timer、picker 流程都不动。

## 4. 改动清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/gui/src/renderer/src/components/TagBar.tsx` | 改 | `handleKeyDown` 内加 `if (e.key === 'Tab')` 分支，新增 `handleTabComplete()` helper |
| `packages/gui/src/renderer/src/components/TagBar.test.tsx` | 新 | 单测 Tab 在 4 种 popup 状态下的行为 + Enter 未回归 |

不动：daemon / API / store / schema / 其他组件。

## 5. 测试

### 5.1 单测（`TagBar.test.tsx`）

mock `api.listTags`，用 `@testing-library/react` + `userEvent`。覆盖：

- **T1** 输入 `f`，`listTags` 返回 `[{tagType:'#', tagValue:'foo', ...}]` → Tab → input = `#foo`（**不带**尾空格），`onTagsChange` 未被调用
- **T2** 输入 `/ti` → frequency popup 显示 `/time ...` → Tab → input = `/time `（**带**尾空格），无 picker open，无 addTag
- **T3** 输入 `/da` → `/daily` → Tab → input = `/daily`（不带尾空格），无 addTag
- **T4** 无输入 / 无候选 → Tab → input 不变，默认行为（不拦截 preventDefault）—— 用 `fireEvent.keyDown` 的 `defaultPrevented` 断言
- **T5** 回归：输入 `/time` → Enter → picker 打开（确认 Tab 改动未影响 Enter 路径）
- **T6** 回归：输入 `foo` + ArrowDown + Enter → addTag 被调用（hashtag 选择回归）

Radix Popover / DateTimePicker 不进入测试（与 `MarkdownPreview.test.tsx` 对 `NoteIdPill` 的做法一致，必要时 mock `DateTimePicker` 为空壳）。

### 5.2 手动测试清单

按 owl `CLAUDE.md` 规范，完成后附在本文档 Implementation record 段，动工结束再写。

## 6. 不在本子项

- CodeMirror 正文 slash command → P6
- `[[` note-link → P6+（需先定 wikilink 语法）
- 频率补全的语料库 / ranking → 不做
- popup 关闭后 Tab 切换到"下一个 TagChip 删除按钮" 之类的焦点导航 → 按默认浏览器 Tab，不特殊处理

## 7. 开工前待确认

- [x] 规则 3.1 映射：hashtag 不带尾空格 / `/time` `/alarm` 带尾空格 / 无参命令不带尾空格（2026-05-06 敲定）
- [x] `hasNavigated=false` 时 Tab 默认取第一条（2026-05-06 敲定）

## Implementation record

> 动工日：2026-05-06

### 代码改动

- `packages/gui/src/renderer/src/components/TagBar.tsx`：加 `handleTabComplete()` helper + `handleKeyDown` 里的 `Tab` 分支
- `packages/gui/src/renderer/src/components/TagBar.test.tsx`：新 6 个单测（T1-T6）

### 测试结果

`just check`：typecheck 通过；lint 只剩 18 条 pre-existing 警告（与本子项无关）
`just test`：core 150 + daemon 128 + gui 123 + apps/cli 119 = **520 / 520 绿**（较上一阶段 514 +6）

### 手动测试：TagBar Tab/Enter

前置：
- daemon 已跑（`just dev-daemon` 后台启动，端口 47010）
- 已 seed 两条笔记：
  - 「P3.4-d TagBar Tab/Enter 手动测试笔记」—— 带 `#foo` / `#foobar` 标签（让 tag store 里有这两个 tag）
  - 「P3.4-d 测试用笔记（空标签）」—— 空标签，用作 Tab 补全主要测试对象

用户本地跑 `just dev` 拉起 GUI，打开「P3.4-d 测试用笔记（空标签）」进入编辑态，光标移到 TagBar 输入框（底部「输入标签...」）。

**H1（Tab 补全 hashtag — 字面量，不带尾空格）**
1. TagBar 输入框打字 `f` → 弹出 popup，显示 `#foo` / `#foobar` 两条建议
2. 按 `Tab` → 输入框内容应变为 `#foo`（**无尾空格**），popup 收起
3. 游标停在 `#foo` 末尾（可手动继续打字）
4. 标签没加上（tag chip 区仍为空）
5. 再按 `Enter` → `#foo` 作为 tag 添加（底部 tag chip 出现 `#foo`）

**H2（ArrowDown 后 Tab 取第二条）**
1. 清空输入框，再打 `f` → popup 再次显示 `#foo` / `#foobar`
2. `ArrowDown` → 高亮移到 `#foobar`
3. `Tab` → 输入框变为 `#foobar`，popup 收起
4. `Enter` → 添加 `#foobar` tag

**H3（Tab 补全 /time — 带尾空格，不开 picker）**
1. 清空输入框，打 `/ti` → frequency popup 显示 `/time (过期时间)` 等
2. `Tab` → 输入框变为 `/time `（**带**尾空格），popup 收起
3. **picker 不应该弹出**
4. 继续打字 `19:00` → 输入框为 `/time 19:00`
5. `Enter` → picker 弹出，且时间栏预填 `19:00`
6. 在 picker 里选个日期，确认 → `/time` tag 加上，值是选中的时间戳

**H4（Tab 补全 /daily — 无尾空格）**
1. 清空输入框，打 `/da` → frequency popup 显示 `/daily (每日)`
2. `Tab` → 输入框变为 `/daily`（**无**尾空格）
3. picker **不应该弹出**
4. `Enter` → `/daily` tag 被添加（无需参数）

**H5（Tab 无候选 — 默认焦点行为不拦截）**
1. 清空输入框（输入为空，无 popup）
2. `Tab` → 焦点应跳出输入框（按默认浏览器 Tab 语义，可能跳到下一个 focusable 元素）
3. TagBar 输入状态不变

**H6（Enter 回归验证）**
1. 光标回到输入框，打 `/time` 完整命令
2. `Enter` → picker 直接弹出（与 Tab 路径对比；本步确认 Enter 行为未被改坏）

**H7（Esc 回归验证）**
1. 打 `f`，popup 显示
2. `Esc` → popup 关、输入框清空

**清理**：
- 测试结束后用户可删除两条测试笔记（或保留）
- 用户反馈结果，Claude 决定 shipping / 回修

