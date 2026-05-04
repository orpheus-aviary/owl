# P3.2-d — SSE 反向通道 + `owl open`

日期：2026-05-02（v4：5/3 修复 `server.close()` 因无限 SSE 挂死的 shutdown bug）
前置：P3.2-c（CLI 核心 shipped，commit `7732efc`，404/404 测试绿）
交付目标：daemon 能把事件推送给 GUI；CLI `owl open <id>` 把编辑器 tab 焦点送到用户手边

## 0. v4 变更（shutdown 阻塞 bug 修复）

**阻塞问题**：v3 把 bus 的清理放在 `fastify.addHook('onClose', ...)`，但 Fastify 的 `onClose` 跑在 in-flight 请求 drain 之后。`GET /events` 是无限流，handler 永不返回 → `server.close()` 永远等不到 drain → 卡在 3s SIGKILL 上。现有 `/ai/chat` 无此问题（agent loop 走到 `done` 后自然 `endSse`）。

**方案**（§5.2 + §5.3 同步调整）：
- `routes/events.ts` 维护模块内 `liveReplies: Set<FastifyReply>`
- 每个 GET /events handler 在 socket close 时从 set 里移除自己
- 注册 `app.addHook('preClose', ...)`：遍历 `liveReplies` 主动 `endSse(reply)`，socket 关 → handler 随之返回 → fastify 的 drain 步骤完成 → `onClose` 才会跑到 `bus.close()`
- 不引 `forceCloseConnections: true`（会改动其它路由在途请求的行为）
- EventsBus 保持职责单一：纯 pub/sub，不管 SSE 生命周期

**测试增量**：§6.1 加 T12 —— listen → subscribe → `app.close()` 必须在 1s 内返回（证明没卡死）

## 0. v3 变更（基于第二轮 review）

**阻塞修复**：
- §6.1 daemon SSE 测试策略：去掉 `undici`（daemon `package.json` 未引，新加 devDep 过度）→ 改用 `app.listen({ port: 0 })` + Node 20+ global `fetch` + `AbortController`；`GET /events` 是无限流，`app.inject` 会阻塞，故走真端口（与 AI SSE 的有限流 inject 测试模式不同）
- §6.4 手动测试步骤 2：`owl search --text ...` → `owl search '#真实' --limit 1 --id-only`（`owl search` 是位置参数 `[query]`，无 `--text`，见 `apps/cli/src/index.ts:87`）
- §1 / §5.5 / §7 `--direct` 语义统一：`owl open` **忽略** 全局 `--direct` / `--db`，始终 http-only；daemon 不活才 `DAEMON_UNAVAILABLE`。`runOpen` 不消费 `opts.direct` / `opts.db`，`resolveConfig` 也不传 `dbPath`（open 只需读 `daemon.port`）
- §2 / §8 "严格 5 commits" 表述与用户全局指令「commit 前必须先征得确认」冲突 → 改为「按 5 phase 分批推进，**每次 commit 前先征得用户确认**」

**非阻塞修正**：
- §5.4 `handleDaemonEvent` 里 `await handlers.openNoteById(...)` 用 try/catch 包起来，console.warn 后返回，避免 `void handleDaemonEvent(...)` 放走 unhandled rejection

## v2 变更（5/3 第一轮 review）

- §5.4 GUI EventsSubscriber：`resolveDaemonBaseUrl` → `baseUrl`（实际导出见 `packages/gui/src/renderer/src/lib/api.ts:69`）
- §5.5 CLI `runOpen`：`writeResult` 参数顺序纠正为 `(data, opts)`（见 `apps/cli/src/lib/output.ts:17`）
- §5.5 CLI `index.ts` 注册：弃用编造的 `runWithCtx`，改走 `doctor`/`migrate` 模式（`resolveConfig` → 轻量 context → `runOpen`，不经 `withContext`，因为 `open` 不需要 backend）
- §5.2 `/events/emit`：`req.body as ...` → `(req.body ?? {}) as ...`（防 undefined body 500，参考 `routes/ai.ts:23`）
- §5.5 CLI `runOpen`：POST fetch / JSON 解析包 try/catch，转 `CliError('DAEMON_UNAVAILABLE' | 'HTTP_ERROR')`，避免 probe 后 daemon 挂导致顶层 UNKNOWN
- §5.3 `eventsBus` 定为**必填**；Phase 2 清单显式列出 `server.test.ts:44` / `routes/ai.test.ts:94` 两处 call site 同步改
- §7 StrictMode 风险行：`main.tsx:7` 确开着 StrictMode，描述改成「dev 瞬时双连，cleanup 保证无长期泄漏」
- §6.4 手动测试步骤 1：`just dev-daemon + just dev` → `just dev-daemon + just dev-fast`（`just dev` 依赖 `stop-daemon`，会杀掉刚启的 daemon）

## 1. 范围

**In scope**：

- daemon `events/bus.ts` — 进程内广播总线（subscribe / emit / close）
- daemon `GET /events` — SSE 长连接订阅
- daemon `POST /events/emit` — JSON 广播入口
- 事件类型 `open_note`：payload `{ note_id: string }`；daemon 在广播前 404 掉未知 / 已 trashed 的 note
- GUI 根挂载 `EventsSubscriber`，原生 `EventSource` 订阅；收到 `open_note` 调 `openNoteById(id)` + `navigate('/')`
- CLI `owl open <id>` — http-only；daemon 不活 → `DAEMON_UNAVAILABLE`
- 15s keepalive comment（`:\n\n`）防中间代理 idle timeout
- 单元测试 + 手动测试清单

**Out of scope**（P3.2-d 明确不做）：

- `config_changed` / `note_applied_external` / `reminder_fired` 等其它事件类型 — 设计保留可扩展点（`OwlEvent` 联合类型），实现只落 `open_note`
- Last-Event-ID / 回放 — `open_note` 是 fire-and-forget，客户端 offline 期间丢了就丢了
- CLI direct 模式下的 "fallback open" — `owl open` **忽略** 全局 `--direct` / `--db`，始终 http-only；daemon 不活一律抛 `DAEMON_UNAVAILABLE`（见 §5.5 实现）
- 鉴权 — localhost-only，daemon 其它路由也没加鉴权，保持一致
- 多窗口扇出复杂度 — 当前 GUI 只 1 个 BrowserWindow，bus 支持多订阅者但不额外做窗口路由

## 2. 决策快照（已确认）

| 决策 | 选择 |
|---|---|
| `/events` 协议 | GET + 原生 `EventSource`（浏览器自动重连） |
| daemon 不活时 `owl open` | 抛 `DAEMON_UNAVAILABLE`，stderr 引导「请先启动 GUI」 |
| 广播入口 | `POST /events/emit`（唯一入口，未来事件类型同一端点扩展） |
| Keepalive | 15s SSE 注释行 `:\n\n` |
| 已 trashed 的 note 能否 open | 不能 — daemon 侧 404，引导走 `owl restore` |
| 实施粒度 | 5 phase 分批推进，单 commit per phase；**每次 commit 前先征得用户确认**（遵循 `~/.claude/CLAUDE.md` 全局规约） |

## 3. 协议

### 3.1 SSE 订阅（GET /events）

**请求**：

```
GET /events HTTP/1.1
Accept: text/event-stream
```

**响应头**（复用 `initSse`，`packages/daemon/src/ai/sse.ts:24`）：

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
Access-Control-Allow-Origin: <echo>          ; 见下文 CORS 说明
Access-Control-Allow-Credentials: true
Vary: Origin
```

**响应流**：

```
event: hello
data: {"type":"hello","server_time":1714604400000}

: keepalive

event: open_note
data: {"type":"open_note","note_id":"abc123"}
```

- 建连后**立刻**发 `hello`（让测试 / renderer 确认通道就绪）
- 每 15s 发一行 SSE 注释 `:\n\n`
- 客户端断开 → daemon 侧 `req.raw.socket.on('close')` 清理订阅 + 清 keepalive timer
- 断线重连：`EventSource` 浏览器默认 3s 重连，恢复后服务端重新发 `hello`；不实现服务端 replay
- daemon 关闭时 `bus.close()` 抹订阅者；fastify `onClose` 关 socket，客户端进入自然重连（Cmd+Q 场景下 renderer 随窗口销毁）

**CORS**：`server.ts:17-20` 已 `cors({ origin: true })`，但 SSE 路由走 `reply.hijack()` 绕过了 fastify 的 onSend 链，所以 ACAO 需要在 `initSse` 里手写（现有实现已就绪，见 `packages/daemon/src/ai/sse.ts:24-42`）。EventSource GET 请求不带自定义 header，不触发 preflight，只要响应 echo `Origin` 就够。

### 3.2 广播入口（POST /events/emit）

**请求**：

```
POST /events/emit
Content-Type: application/json

{"type":"open_note","note_id":"abc123"}
```

**成功响应**（走 `response.ts` 的 `ok` 辅助，envelope 与其它路由一致）：

```
200 OK
{"success":true,"data":{"subscribers":1}}
```

**失败响应**（走 `response.ts` 的 `fail` 辅助）：

| 条件 | status | error_code | message |
|---|---|---|---|
| 缺 type / 非 `open_note` | 400 | `BAD_REQUEST` | `unknown event type` |
| 缺 `note_id` / 非 string | 400 | `BAD_REQUEST` | `note_id required` |
| note 不存在 | 404 | `NOTE_NOT_FOUND` | `note not found` |
| note 已回收（`trashLevel > 0`） | 404 | `NOTE_NOT_FOUND` | `note is in trash` |

`subscribers === 0` **不视作错误**：CLI 和 daemon 都不知道 GUI 有没有跑，让响应字段说话 —— CLI 在 stderr 发 warning，exit 0。

### 3.3 事件类型（可扩展点）

```typescript
// packages/daemon/src/events/types.ts
export type OwlEvent =
  | { type: 'hello'; server_time: number }
  | { type: 'open_note'; note_id: string };
// future:
// | { type: 'config_changed' }
// | { type: 'note_applied_external'; note_id: string };
```

广播时 `event:` 字段 = `event.type`，`data:` = 整个 event 对象（包含 `type`，避免客户端重新打包）。

## 4. 模块改动清单

```
packages/daemon/src/
├── events/                   # 新目录
│   ├── bus.ts                # EventsBus class
│   ├── bus.test.ts           # 单测
│   └── types.ts              # OwlEvent 联合类型
├── routes/
│   └── events.ts             # 新增：GET /events + POST /events/emit
├── context.ts                # 扩展：AppContext.eventsBus
├── server.ts                 # 注册 events 路由
└── cli.ts                    # 启动时 new EventsBus()，`onClose` 里 bus.close()

packages/daemon/src/routes/events.test.ts
                              # 新增：SSE + emit 集成测（真端口 `app.listen` + global fetch + AbortController，见 §6.1）

packages/gui/src/renderer/src/
├── components/
│   ├── EventsSubscriber.tsx          # 新增：mount EventSource，unmount 关
│   ├── events-subscriber-core.ts     # 新增：纯函数 handleDaemonEvent
│   └── events-subscriber-core.test.ts
└── MainApp.tsx                        # 改：在 <HashRouter> 内挂 <EventsSubscriber />

apps/cli/src/
├── commands/
│   ├── open.ts               # 新增：detectDaemon + 原生 fetch POST /events/emit
│   └── open.test.ts          # 单测（mock fetch）
└── index.ts                  # 注册 `open` 子命令
```

**不动**的：`@owl/core`（零改动）、`apps/cli/src/backend/*`（`emit` 不走 OwlBackend 抽象；参考 `apps/cli/src/commands/doctor.ts` 的小范围原生 fetch 模式，避免为单次 POST 污染接口）。

## 5. 实现细节

### 5.1 `EventsBus`

```typescript
// packages/daemon/src/events/bus.ts
import type { OwlEvent } from './types.js';

export class EventsBus {
  private subscribers = new Set<(e: OwlEvent) => void>();

  subscribe(fn: (e: OwlEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Returns subscriber count AFTER dispatch (handlers may unsub during). */
  emit(event: OwlEvent): number {
    // Snapshot tolerates handlers that unsubscribe or subscribe during dispatch.
    const snapshot = [...this.subscribers];
    for (const fn of snapshot) {
      try {
        fn(event);
      } catch {
        /* isolate one bad subscriber — caller logs upstream */
      }
    }
    return this.subscribers.size;
  }

  close(): void {
    this.subscribers.clear();
  }

  size(): number {
    return this.subscribers.size;
  }
}
```

### 5.2 `GET /events` + `POST /events/emit` 处理器

```typescript
// packages/daemon/src/routes/events.ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getNote } from '@owl/core';
import { endSse, initSse, sendSseEvent } from '../ai/sse.js';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';   // path 按现状

const KEEPALIVE_MS = 15_000;

export function registerEventsRoutes(app: FastifyInstance, ctx: AppContext) {
  // Module-local registry of currently-streaming replies. Needed because
  // Fastify's `onClose` hook runs AFTER in-flight requests drain — and a
  // hijacked SSE handler never returns on its own. `preClose` below walks
  // this set and ends each stream, unblocking `server.close()`.
  const liveReplies = new Set<FastifyReply>();

  app.get('/events', async (req, reply) => {
    initSse(reply, req);
    sendSseEvent(reply, 'hello', { type: 'hello', server_time: Date.now() });
    liveReplies.add(reply);

    const unsubscribe = ctx.eventsBus.subscribe((event) => {
      if (reply.raw.writableEnded) return;
      sendSseEvent(reply, event.type, event);
    });

    const keepalive = setInterval(() => {
      if (reply.raw.writableEnded) {
        clearInterval(keepalive);
        return;
      }
      reply.raw.write(':\n\n');
    }, KEEPALIVE_MS);

    const cleanup = () => {
      clearInterval(keepalive);
      unsubscribe();
      liveReplies.delete(reply);
      endSse(reply);
    };

    req.raw.socket.on('close', cleanup);
    // NOTE: do not return / await — hijack means fastify won't wait for
    // handler completion before flushing. Stream lives until socket close
    // OR preClose below tears it down.
  });

  // Shutdown: actively close every live SSE stream so Fastify's in-flight
  // drain can complete. Runs before `onClose` (where bus.close() happens).
  app.addHook('preClose', async () => {
    for (const reply of liveReplies) {
      try {
        endSse(reply);
      } catch {
        // best-effort; handler's socket 'close' listener will still fire
      }
    }
    liveReplies.clear();
  });

  app.post('/events/emit', async (req, reply) => {
    // `(req.body ?? {})` guards against callers that POST with no body
    // at all — without it `body.type` would crash into a 500. Mirrors
    // `routes/ai.ts:23` and `routes/notes.ts:176/210`.
    const body = (req.body ?? {}) as { type?: unknown; note_id?: unknown };

    if (body.type !== 'open_note') {
      return fail(reply, 400, 'unknown event type', 'BAD_REQUEST');
    }
    if (typeof body.note_id !== 'string' || !body.note_id) {
      return fail(reply, 400, 'note_id required', 'BAD_REQUEST');
    }

    const note = getNote(ctx.db, body.note_id);
    if (!note) {
      return fail(reply, 404, 'note not found', 'NOTE_NOT_FOUND');
    }
    if (note.trashLevel > 0) {
      return fail(reply, 404, 'note is in trash', 'NOTE_NOT_FOUND');
    }

    const subscribers = ctx.eventsBus.emit({
      type: 'open_note',
      note_id: body.note_id,
    });
    return ok(reply, { subscribers });
  });
}
```

### 5.3 `AppContext` 与启动

```typescript
// packages/daemon/src/context.ts
import type { EventsBus } from './events/bus.js';

export interface AppContext {
  // ...existing fields
  eventsBus: EventsBus;   // required, not optional
}
```

**required vs optional 决定**：`eventsBus` 作为**必填字段**。理由：
- optional 意味着 `routes/events.ts` 每次 emit 都要 `ctx.eventsBus?.emit(...)`，空值检查摊到调用点
- 现有模式（`scheduler` / `conversationStore` / `previewStore`）都是必填；保持一致
- 测试注入成本：`buildServer({...})` 两处 call site（`server.test.ts:44`、`routes/ai.test.ts:94`）加一行 `eventsBus: new EventsBus()`，机械改动

**Phase 2 必须同步改动的测试文件**（漏改会导致现有测试编译失败）：
- `packages/daemon/src/server.test.ts:44` — `buildServer({...})` 加 `eventsBus`
- `packages/daemon/src/routes/ai.test.ts:94` — 同上
- 任何将来新加的 `buildServer(...)` 调用点

**启动与关闭顺序**：

- `packages/daemon/src/cli.ts` 启动序列：`const eventsBus = new EventsBus()` 塞进 `ctx`
- `registerEventsRoutes(app, ctx)` 内部自己注册 `preClose` hook（主动 endSse 所有活跃流，见 §5.2），保证 server.close 不卡死
- `fastify.addHook('onClose', async () => { ctx.eventsBus.close(); })`：**必须在 `preClose` 之后执行**；onClose 里的 `bus.close()` 只是防御性清空 subscriber Set（实际 socket 关掉时 handler 的 `cleanup` 已经 `unsubscribe` 过了）。位置紧贴现有 `scheduler.stop()` 之后、`db.close()` 之前
- `packages/daemon/src/server.ts` 在 `registerSystemRoutes(app)` 之后加 `registerEventsRoutes(app, ctx)`

**为什么不用 `forceCloseConnections: true`**：Fastify 构造时打开这个开关会在 `app.close()` 时硬杀**所有**套接字，不止 SSE。普通 CRUD 如果有一个在途 POST 也会被斩断。本方案只针对 `/events` 路由局部生效，对 `/notes`、`/ai` 等其它路由的在途请求零影响。

### 5.4 GUI `EventsSubscriber`

**定位约束**：必须在 `<HashRouter>` 内部才能 `useNavigate()`（见 `MainApp.tsx:230`）。组件渲染 `null`。

```typescript
// packages/gui/src/renderer/src/components/EventsSubscriber.tsx
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { baseUrl } from '../lib/api';
import { openNoteById } from '../stores/editor-store';
import { handleDaemonEvent } from './events-subscriber-core';

export function EventsSubscriber(): null {
  const navigate = useNavigate();

  useEffect(() => {
    const es = new EventSource(`${baseUrl()}/events`);

    es.addEventListener('open_note', (ev: MessageEvent<string>) => {
      void handleDaemonEvent('open_note', ev.data, {
        openNoteById,
        navigate: (path) => navigate(path),
      });
    });
    // 'hello' is a health-only signal. 'error' is handled by EventSource
    // itself (auto-reconnect); no app-level retry needed.

    return () => es.close();
  }, [navigate]);

  return null;
}
```

```typescript
// packages/gui/src/renderer/src/components/events-subscriber-core.ts
/** Pure for testability — no React, no EventSource. */
export interface EventHandlers {
  openNoteById: (id: string) => Promise<void>;
  navigate: (path: string) => void;
}

export async function handleDaemonEvent(
  eventName: string,
  rawData: string,
  handlers: EventHandlers,
): Promise<void> {
  if (eventName !== 'open_note') return;
  let data: { note_id?: unknown };
  try {
    data = JSON.parse(rawData);
  } catch {
    console.warn('[events] malformed open_note payload');
    return;
  }
  if (typeof data.note_id !== 'string' || !data.note_id) {
    console.warn('[events] open_note missing note_id');
    return;
  }
  // Swallow errors here — the caller invokes us via `void handleDaemonEvent(...)`
  // from an EventSource listener, so any thrown/rejected error would become an
  // unhandled rejection and surface as a red console error. Logging is enough:
  // the failure modes (note deleted between emit and fetch, network blip) are
  // already surfaced via the CLI's error path on the emitter side.
  try {
    await handlers.openNoteById(data.note_id);
    handlers.navigate('/');
  } catch (err) {
    console.warn('[events] open_note handler failed:', err);
  }
}
```

**挂载位置**：`MainApp.tsx` `<HashRouter>` 的直接子节点，`Routes` 的兄弟：

```tsx
<HashRouter>
  <EventsSubscriber />
  {/* existing <div className="flex ..."> ... <Routes/> ... </div> */}
</HashRouter>
```

### 5.5 CLI `open` 命令

**不走 OwlBackend 抽象**（同 `doctor` / `migrate`）：emit 不是 CRUD，不需要 backend。registration 也照 `doctor`（`apps/cli/src/index.ts:252-268`）写：`resolveConfig` → 自建轻量 context → `runOpen`。**不用** `withContext` —— 那会强制 build 一个 http/direct backend，对 `open` 毫无意义。

**`--direct` 语义**：`owl open` 作为 GUI-only 动作，**显式忽略**全局 `--direct` 和 `--db`。`runOpen` 不消费这两个 flag，`resolveConfig` 也不传 `dbPath`（open 只需 `daemon.port`）。daemon 不活 → 始终 `DAEMON_UNAVAILABLE`，不 fallback 到直写（direct 无人可广播）。

```typescript
// apps/cli/src/commands/open.ts
import { CliError } from '../lib/errors.js';
import { detectDaemon } from '../lib/daemon-detect.js';
import type { OutputStreams } from '../lib/output.js';
import { writeResult } from '../lib/output.js';
import type { ResolvedConfig } from '../lib/config.js';

export interface OpenFlags {
  pretty?: boolean;
}

export interface OpenContext {
  config: ResolvedConfig;
  streams: OutputStreams;
  /** Test seam — production passes undefined and uses global fetch. */
  fetch?: typeof fetch;
}

export async function runOpen(
  noteId: string,
  flags: OpenFlags,
  ctx: OpenContext,
): Promise<void> {
  const port = ctx.config.daemonPort;
  const alive = await detectDaemon(port, ctx.fetch ? { fetch: ctx.fetch } : {});
  if (!alive) {
    throw new CliError(
      'DAEMON_UNAVAILABLE',
      'owl open requires a running GUI (daemon not reachable). Start the GUI and try again.',
    );
  }

  const doFetch = ctx.fetch ?? fetch;

  // Race condition: daemon can disappear between probe and POST (kill,
  // Cmd+Q, crash). Wrap the POST to turn ECONNREFUSED / AbortError / JSON
  // parse errors into a first-class CliError rather than bubbling as UNKNOWN.
  let res: Response;
  try {
    res = await doFetch(`http://127.0.0.1:${port}/events/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'open_note', note_id: noteId }),
    });
  } catch (err) {
    throw new CliError(
      'DAEMON_UNAVAILABLE',
      `daemon stopped responding during /events/emit: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let envelope: {
    success?: boolean;
    data?: { subscribers: number };
    error_code?: string;
    message?: string;
  };
  try {
    envelope = await res.json();
  } catch (err) {
    throw new CliError(
      'HTTP_ERROR',
      `/events/emit returned non-JSON body (${res.status}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 404 || envelope.error_code === 'NOTE_NOT_FOUND') {
    throw new CliError('NOTE_NOT_FOUND', envelope.message ?? 'note not found', {
      note_id: noteId,
    });
  }
  if (!envelope.success || !envelope.data) {
    throw new CliError('HTTP_ERROR', envelope.message ?? `/events/emit failed (${res.status})`);
  }

  const subscribers = envelope.data.subscribers;
  if (subscribers === 0) {
    ctx.streams.stderr.write(
      'warning: daemon is running but no GUI window is subscribed — note was not displayed\n',
    );
  }

  // writeResult signature is `(data, opts)` — matches lib/output.ts:17.
  writeResult(
    { opened: noteId, subscribers },
    { streams: ctx.streams, pretty: flags.pretty ?? false },
  );
}
```

**index.ts 注册**（照 doctor 模式，`apps/cli/src/index.ts:252`）：

```typescript
program
  .command('open')
  .description('Focus the GUI editor on a note by id (ignores --direct/--db; HTTP only)')
  .argument('<id>', 'note id')
  .action(async (id: string, _flags: Record<string, unknown>, cmd: Command) => {
    const opts = cmd.optsWithGlobals() as GlobalOptions;
    // Intentionally do NOT forward opts.db — `open` is a GUI-only action
    // that reads only daemon.port from config. Global --direct / --db are
    // accepted (so the root parser doesn't reject them) but ignored here.
    const config = resolveConfig(
      opts.config !== undefined ? { configPath: opts.config } : {},
    );
    await runOpen(id, { pretty: opts.pretty ?? false }, { config, streams });
  });
```

`open` 没有 own-flag（`--pretty` 来自 GlobalOptions），所以 commander action 的 `flags` 参数会是命令自身的 option 对象（空），全局 flag 通过 `optsWithGlobals()` 读取 —— 和 doctor 一致。

## 6. 测试

### 6.1 daemon 单测

**`events/bus.test.ts`**（5 例）：

| # | 内容 |
|---|---|
| T1 | `subscribe` 后 emit 被单个 handler 收到 |
| T2 | 多 handler 同 event 都收到 |
| T3 | `unsubscribe()` 后不再收 |
| T4 | handler 抛错不影响同 event 其它 handler，`emit` 不抛 |
| T5 | `close()` 清空 size = 0 |

**`routes/events.test.ts`**（7 例）：

**测试策略**：`GET /events` 是**无限流**，不会自然 end；`app.inject` 会阻塞到超时。现有 AI SSE 测试用 `inject` 只因为 `/ai/chat` 发完 `done` 就 end。这里走 **`app.listen({ port: 0, host: '127.0.0.1' })` + Node 20+ global `fetch` + `AbortController`** 读流；`ReadableStream.getReader()` 消费几个 event 后 `abort()` 切断，再 `app.close()`。**不需要**新增依赖 —— daemon `package.json` 没 undici，不加 devDep。POST 类用例（T6-T9）继续用 `app.inject`（有限响应）。

测试骨架（给 T10 示意）：

```typescript
const app = buildServer({ ...ctx, eventsBus });
await app.listen({ port: 0, host: '127.0.0.1' });
const addr = app.server.address() as { port: number };

const ac = new AbortController();
const resp = await fetch(`http://127.0.0.1:${addr.port}/events`, {
  signal: ac.signal,
  headers: { Accept: 'text/event-stream' },
});
const reader = resp.body!.getReader();
const decoder = new TextDecoder();
// read until we've seen 'event: hello' + our emitted event ...
// then:
ac.abort();
try { await reader.cancel(); } catch {}
await app.close();
```

| # | 内容 |
|---|---|
| T6 | `POST /events/emit` type 非法 → 400 `BAD_REQUEST`（inject） |
| T7 | `POST /events/emit` note_id 缺失 → 400 `BAD_REQUEST`（inject） |
| T8 | `POST /events/emit` note 不存在 → 404 `NOTE_NOT_FOUND`（inject） |
| T9 | `POST /events/emit` note trashLevel=1 → 404 `NOTE_NOT_FOUND`（前置 `deleteNote`，inject） |
| T10 | 端到端：listen → GET /events 收 `hello` → POST /events/emit（inject）→ 从 reader 收到 `open_note`；envelope `subscribers:1` |
| T11 | T10 里 `ac.abort()` 后再 POST /events/emit → envelope `subscribers:0` |
| T12 | **shutdown 不卡死**：listen → 开一个 GET /events 订阅（不 abort）→ `await app.close()` 必须在 1s 内返回（若 preClose 没主动 endSse，会等到测试超时）；reader 读到 EOF |

### 6.2 CLI 单测

**`open.test.ts`**（4 例，全部 mock `fetch`）：

| # | 内容 |
|---|---|
| C1 | daemon alive + emit 返回 subscribers=1 → stdout 含 `"opened":"x","subscribers":1`，stderr 空，exit 0 |
| C2 | daemon alive + emit 返回 subscribers=0 → stdout 仍 success，stderr 含 `warning:`，exit 0 |
| C3 | daemon 不活（detectDaemon 返回 false）→ 抛 `CliError('DAEMON_UNAVAILABLE')` |
| C4 | emit 返回 404 NOTE_NOT_FOUND → 抛 `CliError('NOTE_NOT_FOUND')`，`details.note_id` 正确 |

### 6.3 GUI 单测

**`events-subscriber-core.test.ts`**（4 例，纯函数无 DOM）：

| # | 内容 |
|---|---|
| G1 | 合法 `open_note` JSON → 调 `openNoteById(id)` + `navigate('/')` |
| G2 | 非 `open_note` eventName → no-op（handlers 未被调） |
| G3 | 坏 JSON → 不抛，handlers 未被调 |
| G4 | 缺 note_id → 不抛，handlers 未被调 |

`EventsSubscriber.tsx` 本身**不单测**（需要 mock EventSource，收益低），通过手动 smoke 覆盖。

### 6.4 手动测试清单（发版 gate）

daemon + GUI 常规 dev 下：

```
### 手动测试：P3.2-d SSE 反向通道 + owl open

测试步骤：
1. `just dev-daemon` + `just dev-fast`（`just dev` 会触发 `stop-daemon`，不适合本场景；`dev-fast` 不碰 daemon，见 `justfile:130/135`）→ 预期：两端都起来，daemon.log 无 error
2. 终端跑 `owl search '#真实' --limit 1 --id-only` 拿一个真实 note id（`owl search` 是位置参数 `[query]`，无 `--text`）
3. `owl open <id>` → 预期：GUI 自动切到编辑页（/），打开该笔记 tab；stdout JSON `opened:<id>, subscribers:1`；stderr 空；exit 0
4. GUI 继续跑，终端 `owl open does-not-exist` → 预期：exit non-zero；stderr 含 `NOTE_NOT_FOUND`
5. 先 `owl create` 建一个临时 note，`owl delete <临时 id>` 丢到回收站 → `owl open <临时 id>` → 预期：exit non-zero；stderr `NOTE_NOT_FOUND note is in trash`
6. Cmd+Q 关 GUI（daemon 随之退出）→ `owl open <id>` → 预期：exit non-zero；stderr `DAEMON_UNAVAILABLE` + 启动 GUI 提示
7. 只起 daemon（`just dev-daemon`），不起 GUI → `owl open <id>` → 预期：stdout success + subscribers:0；stderr `warning: ... no GUI window is subscribed`；exit 0
8. GUI 跑期间 `kill <daemon-pid>` 让 EventSource 进入重连，再 `just dev-daemon` 起新 daemon → 预期：renderer 自动恢复订阅（console 可能有短暂 red），再次 `owl open <id>` 仍工作
9. GUI 跑期间 `owl delete <已打开 tab 对应 note id>`（GUI tab 仍在）→ `owl open <same id>` → 预期：404 `note is in trash`，GUI tab 状态不变
```

## 7. 风险与处理

| 风险 | 评估 | 处理 |
|---|---|---|
| fastify hijack + 无限流测试 | `GET /events` 不会自然 end，`app.inject` 会阻塞；AI SSE 测试能用 inject 是因为 `/ai/chat` 有限流 | `app.listen({ port: 0 })` + global fetch + AbortController；不引 undici |
| `server.close()` 因无限 SSE 挂死 | Fastify `onClose` 在 in-flight 请求 drain 之后跑；`/events` 的 hijack handler 永不返回 → close 卡到 SIGKILL | `routes/events.ts` 维护 `liveReplies` + `preClose` 主动 `endSse`；T12 断言 close 在 1s 内返回；不启用全局 `forceCloseConnections` |
| EventSource 重连风暴 | 本地 daemon 关掉 → 浏览器每 3s 试一次，console 刷红 | 接受；GUI 关窗即停 |
| 慢消费 subscriber 撑爆 kernel buffer | `open_note` 载荷 <100 字节 | 不处理 |
| daemon 重启期间 CLI 恰好发 emit | detectDaemon 先跑；fetch 失败也 throw CliError | 保持 |
| `trashLevel` 字段 camelCase vs snake_case | `getNote()` 返回 `NoteWithTags`，是 camelCase（见 `packages/core/src/notes/index.ts:133`） | 代码里用 `note.trashLevel` |
| React StrictMode 双挂载 | `packages/gui/src/renderer/src/main.tsx:7` 确实开着 StrictMode，dev 下会瞬时双 mount | useEffect cleanup `es.close()` 保证两条连接都关；只存在一个 dev-only 的瞬时双连窗口，无长期泄漏；生产无影响 |
| CLI `--direct` 语义 | 显式 `--direct` / `--db` 被**静默忽略**（commander 层不报错，`runOpen` 不消费）；daemon 不活仍抛 `DAEMON_UNAVAILABLE` | command description 里标注；`resolveConfig` 不传 `dbPath` |
| HMR 期间 EventSource 泄漏 | useEffect cleanup `es.close()` 保证；另 vite 会整体 reload | 不处理 |
| 测试里的 `ok/fail` 签名 | `packages/daemon/src/response.ts` 现状为准；若签名不同落地时统一 | 实施 Phase 2 前先读 response.ts |

## 8. 实施步骤（5 phase，每次 commit 前先征得用户确认）

| Phase | Commit subject | 内容 | 测试增量 |
|---|---|---|---|
| P1 | `feat(daemon): P3.2-d events bus module` | `events/bus.ts` + `events/types.ts` + `events/bus.test.ts` | +5 (bus) |
| P2 | `feat(daemon): P3.2-d /events SSE + /events/emit routes` | `routes/events.ts`（含 `liveReplies` + `preClose` hook）+ 注册 + `AppContext.eventsBus`（必填）+ `cli.ts` wiring + **同步修 `server.test.ts:44` / `routes/ai.test.ts:94` 两处 `buildServer({...})` 加 `eventsBus`** + `routes/events.test.ts` | +7 (routes) |
| P3 | `feat(gui): P3.2-d events subscriber` | `components/EventsSubscriber.tsx` + `components/events-subscriber-core.ts` + 单测 + 挂到 `MainApp.tsx` | +4 (core) |
| P4 | `feat(cli): P3.2-d owl open command` | `commands/open.ts` + 注册 + `commands/open.test.ts` | +4 (cli) |
| P5 | `docs: P3.2-d shipped` | `PROCESS.md` 更新；手动测试清单签字贴在 commit body | — |

每个 phase 结束 `just check` + `just test` 必须绿；跨 phase 间无悬挂的未用 code path；本地 `just dev-daemon` 能起不崩。

## 9. 完成定义

- 全套测试绿：预计 404 + 20 ≈ 424 个（bus 5 + routes 7 + cli 4 + gui core 4）
- `just check` 零 error（pre-existing warnings 不回退）
- 第 6.4 节手动测试清单 1-9 项全过，用户签字
- `PROCESS.md` 加 P3.2-d 完成行（commit 表 + 测试数）
- `MEMORY.md` `owl rewrite` 条目更新到 P3.2-d
- `docs/plans/2026-04-20-p3-plan.md` §5 的 P3.2-d 勾选 ✅

## 10. 与 P3 规划的回扣

- `docs/plans/2026-04-20-p3-plan.md` §5.4 指定 SSE `/events` 为反向通道推荐方案 ✅
- P3.2-d 完成后，P3.2 全部 4 个子阶段（a/b/c/d）齐活，进入 **P3.3 统一发 0.3.0** 的打包与 publish 流水线
- 本设计只交付 `open_note`；`config_changed` / `note_applied_external` 等事件在 P3.4 UX 完善时按需补

---

## Implementation record（2026-05-03 shipped，5 commits `5168b60`..`c565955`）

基线：404/404（P3.2-c 后）。
完成时：**426/426 测试**（core 128 + daemon 122 + gui 73 + cli 103）。

### 5 phase commit 表

| Phase | Commit | 内容 |
|---|---|---|
| docs | `5168b60` | 设计文档 v4（含 shutdown 阻塞 bug 修复） |
| P1 | `bc0ff01` | daemon events bus 模块（`events/bus.ts` + `types.ts` + 5 单测） |
| P2 | `e634d89` | daemon `/events` SSE + `/events/emit` 路由（含 `liveReplies` + `preClose` hook 防无限流 shutdown 卡死）+ `AppContext.eventsBus` 必填 + 7 routes 测试 |
| P3 | `f635bd4` | GUI EventsSubscriber（EventSource 订阅 + `handleDaemonEvent` 纯函数 + 5 vitest 单测） |
| P4 | `c565955` | CLI `owl open <id>`（http-only，忽略 `--direct`/`--db`；daemon 不活 → DAEMON_UNAVAILABLE；subscribers=0 → stderr warning 但 exit 0）+ 5 单测 |

### 关键架构决定

- 协议：GET + 原生 `EventSource`（浏览器自动重连）；广播入口 POST `/events/emit`
- 事件类型：`OwlEvent` 联合（当前仅 `hello` + `open_note`，future `config_changed` 等可扩展）
- `EventsBus` 职责单一：纯 pub/sub + 错误隔离 + close，不管 SSE 生命周期
- SSE 生命周期归路由：`routes/events.ts` 维护 `liveReplies` Set + `preClose` hook 主动 `endSse`，防止 Fastify `onClose` 因无限流 handler 永不返回而卡死 `server.close()`（**不**启用全局 `forceCloseConnections`：会改动 CRUD 路由在途请求语义）
- 15s SSE keepalive comment `:\n\n`
- trashLevel > 0 的 note 拒 404：避免打开回收站 tab 造成用户困惑
- GUI 根订阅：`<EventsSubscriber />` 挂 `<HashRouter>` 内部，`handleDaemonEvent` 抽为纯函数方便单测；`openNoteById` reject 仅 console.warn 不 navigate，防 unhandled rejection

### 端到端 smoke（2026-05-03 本机实测）

- 真实 note id `85b846d4-...` → GUI 自动切到 `/` 并打开对应 tab，stdout `subscribers:1`、stderr 空、exit 0
- 切到第二条 note id → tab 正确切换
- 不存在的 id → `NOTE_NOT_FOUND`（exit 1）
- 软删除的 note id → `NOTE_NOT_FOUND` 且 message 含 "in trash"（exit 1）
- daemon down → `DAEMON_UNAVAILABLE`（exit 4）
- daemon up + GUI 未起 → `subscribers:0`、stderr warning、exit 0

### 踩坑笔记

- 设计稿 v1 把 bus cleanup 挂在 `onClose`，第 4 轮 review 才发现 Fastify `onClose` 在 in-flight drain 之后跑，`/events` 无限流会卡住 `server.close()`；修正为路由本地 `preClose`（v4）
- `owl search '#<tag>'` 触发 FTS5 语法错（`#` 是保留字符）；smoke 改用 `owl search 真实`
- CLI `node apps/cli/dist/index.js` 走 tsup 产物，不是 tsc；每次改 `open.ts` 需 `pnpm --filter @owl/cli run build`

### 遗留

- 其它事件类型（`config_changed` / `note_applied_external` / `reminder_fired`）按需补
- SSE 重连期间 renderer console 会闪 red —— `EventSource` 浏览器层行为，接受
