# P5-b D11 / D11b / D12 — manual + unit coverage matrix

> 2026-05-24. Companion to `packages/daemon/src/sync/sync.dual.e2e.ts`.
> Step 10b cut D11/D11b/D12 from the automated dual-profile e2e (design
> §8.3) because a faithful single-process automation would need two full
> daemon instances + real SSE event delivery — too much complexity for
> the marginal coverage above what unit tests already give. This doc
> records how each case is covered instead.

## D12 — SSE reconnect with backoff

**Status**: ✅ fully covered by automated unit tests.

`packages/daemon/src/sync/sse-bridge.test.ts` →
`describe('createSseBridge — reconnect with backoff (P5-b §6.2)')` —
6 tests against `FakeRealClient` with `FakeScheduler` driving:

- `onError` schedules a reconnect with exponential backoff (2/4/8/16/30s)
- reconnect attempts increment monotonically
- `onOpen` after reconnect resets retry attempt counter
- `stop()` cancels any pending reconnect
- `backoffFor(n)` table for n=0..99 (cap at 30s)
- `subscribeEvents` throw still schedules a reconnect

No skybridge install needed. Run as part of `just test-daemon`.

## D11 / D11b — SSE change-event triggers runManualSync

**Status**: ⚠ manual checklist below; piecewise unit coverage in
`sse-bridge.test.ts` for the trigger logic.

### Unit-side coverage

`sse-bridge.test.ts` →
`describe('createSseBridge — change / open handlers')`:

- `onChange` calls `runManualSync(ctx)` with the right ctx; failures of
  the sync don't crash the bridge
- `onOpen` runs catch-up `runManualSync` (so reconnect picks up changes
  missed during the offline window)
- broadcaster `markConnected` / `markOffline` fire on the right edges

What the unit tests can't prove: the full path **server emits → client
receives → bridge dispatches → sync round runs → status flips**. That
requires real fastify+SSE delivery, which is what the manual checklist
verifies once per P5-b release.

### Manual checklist — D11/D11b

Prereqs:

```bash
just skybridge-install
just dev-skybridge   # starts skybridge server + owl daemon + owl GUI
```

Or two terminals manually:

```bash
# T1
SKYBRIDGE_DEV=1 skybridge server start
# T2  (profile B, after `owl sync login` + first `owl sync run`)
OWL_NEST_DIR=$HOME/orpheus-aviary-nest-B just dev-daemon
# T3
OWL_NEST_DIR=$HOME/orpheus-aviary-nest-B OWL_DAEMON_PORT=47011 just dev
```

#### D11 — B offline → A pushes → B reconnects → catch-up sync

1. Profile A: GUI sidebar SyncStatusBar shows **已同步**
2. Profile B: kill the skybridge server with **`kill -9 <pid>`**
   (see SIGTERM caveat in Watch-outs). B's SyncStatusBar should flip to
   **离线** within ~2s
3. Profile A: create one note, observe GUI updates locally; SyncStatusBar
   stays **已同步**
4. Restart skybridge server
5. Profile B: SyncStatusBar should briefly flash **同步中** then return
   to **已同步** within `≤ backoffFor(currentAttempt) + 1s` (≤ 31s after
   the last failed retry — so possibly ~30s after server restart in the
   worst-case backoff bucket)
6. Open the note list on B — A's new note is visible

#### D11b — B online → A pushes → B applies within 100ms

1. Both profiles connected (both **已同步**)
2. Profile A: create one note
3. Profile B: observe a brief **同步中** flash followed by **已同步**
   within ~1s (the catch-up sync after the SSE `change` event)
4. The new note is visible on B without manual sync

### Watch-outs

- The owl daemon only auto-starts the SSE bridge if `skybridge_config.toml`
  has `[auth] + [device.id] + [workspace.id]` at boot (see
  `bridge-lifecycle.ts`). Half-bootstrapped configs require one
  `owl sync run` then a daemon restart.
- **`kill -9` the skybridge server, not plain `kill`** — see follow-up
  G2 in `docs/history/P5-b-shipped.md`. SIGTERM lets fastify
  gracefully close the SSE response, which surfaces to
  `@skybridge/client/sse.js` as `reader.read() → { done: true }`. That
  path silently exits the read loop **without** calling `onError`, so
  the bridge sits in zombie state forever and the GUI keeps showing
  **已同步** despite the connection being dead. SIGKILL forces a TCP
  RST, which becomes `NetworkError` → `onError` → `markOffline` as
  expected. Until skybridge client is fixed (P5-c G2), the manual test
  MUST use SIGKILL.
- **ABI ping-pong during manual test**: if you start `just dev-fast`
  for the GUI between launching the daemons, `ensure-electron-abi`
  rebuilds `better-sqlite3` to Electron's NODE_MODULE_VERSION. Any
  daemon started AFTER that point must run under Electron-as-Node:
  `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron
   packages/daemon/dist/cli.js daemon`. Daemons started before the
  rebuild keep their cached binding and continue to work as plain
  `node ... cli.js daemon`.
- **GUI is hardcoded to port 47010** — see follow-up G1. The user-facing
  GUI window will be talking to whichever daemon happens to live on
  47010, not the one you exported `OWL_DAEMON_PORT` for. During the
  manual test, treat the GUI as a **single-profile observer** and drive
  the other profile via `curl` against its `47011` daemon.
- "100ms" in design §6.2 is the **server → daemon** dispatch budget; the
  full GUI repaint roundtrip is typically 200-500ms depending on the
  status broadcaster → events bus → SSE → React render path.

## Maintenance

If you change the SSE bridge trigger logic in
`packages/daemon/src/sync/sse-bridge.ts`, **also re-run this checklist
end-to-end**. If you change the dual-profile automation, update
`sync.dual.e2e.ts` and this file's "covered" table together.
