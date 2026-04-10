# P1-9 设计文档：提醒页面

> 日期：2026-04-11
> 状态：已确认，待实施

## 1. 设计目标

实现提醒页面，展示未来待触发的 `/alarm` 提醒，支持时间范围筛选、周期计算、跳转编辑、删除和修改提醒时间。

**核心约束：**
- 只关注 `/alarm` 标签，`/time` 是自动删除用的，不在此页面展示
- 一个笔记可有多个 `/alarm`，以最近的未来触发时间排序
- 频率修饰符（`/daily`、`/weekly`、`/monthly`、`/yearly`）影响下次触发时间计算
- 切换页面后返回，筛选状态保持（zustand store）

## 2. API 改造

### 2.1 新增端点 `GET /reminders/alarms`

返回所有非回收站、有 `/alarm` tag 的笔记，标准 `Note[]` 格式（含完整 `tags[]` 数组）。

**不做时间过滤**——周期提醒的 base time 可能在过去，但下次触发在未来。数据量很小，过滤交给前端。

SQL 逻辑：
1. 子查询找到所有有 `/alarm` tag 且 `trash_level = 0` 的 note IDs
2. 用现有 note 查询逻辑返回完整 Note（含所有 tags）

### 2.2 前端 API 封装

```typescript
export const listAlarmNotes = () => request<Note[]>('GET', '/reminders/alarms');
```

## 3. 前端：下次触发时间计算

### 3.1 getNextOccurrence

```typescript
function getNextOccurrence(
  alarmTime: Date,
  frequency: '/daily' | '/weekly' | '/monthly' | '/yearly' | null,
  now: Date,
): Date | null {
  if (!frequency) {
    return alarmTime > now ? alarmTime : null; // 无频率：过期即不显示
  }
  // 有频率：从 baseTime 往后推，直到 > now
  const next = new Date(alarmTime);
  while (next <= now) {
    switch (frequency) {
      case '/daily':   next.setDate(next.getDate() + 1); break;
      case '/weekly':  next.setDate(next.getDate() + 7); break;
      case '/monthly': next.setMonth(next.getMonth() + 1); break;
      case '/yearly':  next.setFullYear(next.getFullYear() + 1); break;
    }
  }
  return next;
}
```

### 3.2 每个笔记的最近提醒时间

一个笔记可能有多个 `/alarm` tag，每个都独立计算 `nextOccurrence`，取最近的作为排序依据。

```typescript
function getNearestAlarm(note: Note, now: Date): { time: Date; tagId: string } | null {
  const frequency = note.tags.find(t =>
    ['/daily', '/weekly', '/monthly', '/yearly'].includes(t.tagType)
  )?.tagType as '/daily' | '/weekly' | '/monthly' | '/yearly' | undefined ?? null;

  let nearest: { time: Date; tagId: string } | null = null;
  for (const tag of note.tags) {
    if (tag.tagType !== '/alarm' || !tag.tagValue) continue;
    const next = getNextOccurrence(new Date(tag.tagValue), frequency, now);
    if (next && (!nearest || next < nearest.time)) {
      nearest = { time: next, tagId: tag.id };
    }
  }
  return nearest;
}
```

## 4. 前端：状态管理

### 4.1 reminder-store.ts（zustand）

```typescript
type TimeRange = 'today' | 'week' | 'month' | '7d' | '30d' | 'all';

interface ReminderState {
  timeRange: TimeRange;
  notes: Note[];       // API 返回的原始数据
  loading: boolean;

  setTimeRange: (range: TimeRange) => void;
  fetchReminders: () => Promise<void>;
}
```

- `timeRange` 默认 `'all'`
- 切换页面后 store 不销毁，返回时保持筛选状态
- `fetchReminders` 调用 `listAlarmNotes()`，不传时间参数

### 4.2 时间范围过滤（前端）

根据 `timeRange` 计算 `[rangeStart, rangeEnd]`：

| timeRange | rangeStart | rangeEnd |
|-----------|-----------|----------|
| today | 今天 00:00 | 今天 23:59 |
| week | 本周一 00:00 | 本周日 23:59 |
| month | 本月 1 日 00:00 | 本月末 23:59 |
| 7d | now | now + 7 天 |
| 30d | now | now + 30 天 |
| all | — | — |

过滤逻辑：`getNearestAlarm(note, now)` 的 `time` 落在 `[rangeStart, rangeEnd]` 内。

## 5. 页面布局

```
┌─────────────────────────────────────────────────────────┐
│ [今天] [本周] [本月] [7天] [30天] [*全部*]    共 N 条提醒 │
├─────────────────────────────────────────────────────────┤
│ 笔记标题                                                │
│ #工作 #重要                    ⏰ 04-17 19:00 (每周)     │
│                                          [修改] [删除]  │
│─────────────────────────────────────────────────────────│
│ 笔记标题2                                               │
│ #学习                          ⏰ 04-15 09:00            │
│                                          [修改] [删除]  │
└─────────────────────────────────────────────────────────┘
```

### 5.1 提醒卡片

每条显示：
- 笔记标题（从 content 提取 `# ` 标题）
- hashtag chips（复用 Badge 组件）
- 计算后的下次触发时间 + 频率标注（如"每周"、"每日"）
- 操作按钮：修改时间（弹出日期选择器）、删除提醒

### 5.2 交互

- **点击笔记** → 跳转编辑页（`openNoteById` + `navigate('/')`）
- **删除提醒** → 从笔记 tags 中移除该 `/alarm` tag，调用 `updateNote` → 刷新列表
- **修改提醒时间** → 弹出 Popover 日期时间选择器，确认后更新该 `/alarm` tag 的 value → 调用 `updateNote` → 刷新列表
- **空状态** → "暂无提醒" / "该时间范围内无提醒"

## 6. 验收标准

- [ ] 快捷按钮切换时间范围，列表正确过滤
- [ ] 只显示未来待触发提醒（含周期计算后的下次触发）
- [ ] 过期无频率的 alarm 不出现
- [ ] 过期有频率的 alarm 计算下次触发时间并显示
- [ ] 一个笔记多个 alarm 时，以最近的排序
- [ ] 点击笔记跳转编辑页
- [ ] 删除提醒后列表更新
- [ ] 修改提醒时间后列表重新排序
- [ ] 切换到其他页面再回来，筛选状态保持
- [ ] `just check` 零错误
