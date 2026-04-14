# Trash auto-delete sticky semantics

**Date:** 2026-04-14
**Commit:** `d70428a` — `fix(trash): sticky auto-delete deadline with config-driven cleanup`
**Status:** ✅ implemented

## Problem

The level-2 trash ("即将清除") shows "N 天后清除". Before this fix:

1. `cleanupExpiredTrash` was hardcoded to 30 days — ignored the user's
   `[trash] auto_delete_days` entirely. Pre-existing bug.
2. Cleanup only ran when the reminder scheduler scanned (on startup or at
   reminder fire time). If the user had no reminders, cleanup effectively
   never happened. Pre-existing bug.
3. Even if fixed naïvely (read threshold live at scan time), changing the
   threshold produced counter-intuitive behavior: raising 7 → 30 would
   give back 23 days to trashed notes, which the user explicitly rejected.

The user's mental model for the config knob is:

> 阈值是天花板，可以往下压，不能往上抬。

## Options considered

| Option | 30→7 pulls in? | 7→30 stays put? | Complexity |
|--------|:--:|:--:|--|
| A: stateless, read threshold live at scan time | ✓ | ✗ (gives back days) | ~5 LoC |
| B: stateful `auto_delete_at`, never recomputed | ✗ (lowering has no effect) | ✓ | ~20 LoC |
| **C: stateful `auto_delete_at`, recompute on config change with `min()`** | **✓** | **✓** | **~60 LoC** |

A and B each fail one of the two constraints. **C is the minimum
satisfying both.** Chosen.

## Implementation

Core invariant: the deadline is **monotonically non-increasing**.

```sql
UPDATE notes
SET auto_delete_at = MIN(COALESCE(auto_delete_at, :ceiling), :ceiling)
WHERE trash_level = 2
```

where `:ceiling = now + threshold_days * 86_400_000`.

- Lowering the threshold → `:ceiling` is smaller than existing deadlines → `min()` pulls them in
- Raising the threshold → `:ceiling` is larger than existing deadlines → `min()` is a no-op
- NULL deadline (pre-migration data) → `COALESCE` stamps it with `:ceiling` (lazy backfill)

Triggers that run this SQL via `recomputeTrashDeadlines`:

1. Daemon startup (covers pre-migration rows)
2. `PATCH /config` when `trash` section is present

Cleanup itself (`cleanupExpiredTrash`) is now stateless w.r.t. the
threshold — it just deletes any level-2 note whose `auto_delete_at <= now`.
It runs from three independent triggers:

1. **Startup** — scheduler start
2. **Reminder scan** — piggybacks on existing reminder timer
3. **Trash-specific timer** — new `scheduleNextTrashCleanup()`, arms a
   `setTimeout` for `min(auto_delete_at)`. Clamped to 24h max to avoid
   Node's `int32` timeout overflow past ~24.8 days.

## Schema migration

First schema change in owl-ts. Implemented as idempotent `ALTER TABLE`:

```ts
function migrateSchema(sqlite) {
  const cols = sqlite.pragma('table_info(notes)');
  if (!cols.some((c) => c.name === 'auto_delete_at')) {
    sqlite.prepare('ALTER TABLE notes ADD COLUMN auto_delete_at INTEGER').run();
  }
}
```

**Debt incurred:** this sets a precedent. The next schema change should
upgrade to a proper `schema_version` + `migrations/` system instead of
extending this ad-hoc check chain.

## Validation

Daemon `PATCH /config` rejects `trash.auto_delete_days` outside `[1, 3650]`:

- **0 rejected** — 0 = instant purge, defeats the level-2 review buffer
- **3650 cap** — 10 years, pragmatic upper bound
- **GUI clamps to the same range** — defense in depth: external agents
  hitting daemon directly can't bypass the GUI clamp

## P4 open question: multi-device sync

When migration sync (P4) comes online, `auto_delete_at` is **device-local
state that must NOT be synced**. Reasons:

- Two devices can have different `auto_delete_days` settings
- If device A trashes a note, then device B pulls it — which device's
  deadline wins? There's no sensible answer
- Each device should compute its own deadline on first sight

Proposed P4 rule: exclude `auto_delete_at` from sync. On first encounter
of a level-2 trashed note from sync, the receiving device stamps its own
deadline using its local threshold.

The alternative ("sync the deadline") leads to:

- Device B inherits device A's deadline even if B has a longer threshold
- Raising threshold on B doesn't help (monotonic rule)
- Counter-intuitive for the user

**Action item:** record this in the P4 design doc when P4 starts.

## Tests

- `packages/core/src/notes/index.test.ts` — `deleteNote` level-2 stamps,
  `restoreNote` clears
- `packages/core/src/reminders/index.test.ts` — `recomputeTrashDeadlines`
  lower/raise/NULL cases + full user scenario (30→7→wait 1d→30 stays at
  6 days); `getNextTrashDeadline` empty + earliest
- `packages/daemon/src/server.test.ts` — end-to-end `PATCH /config`
  sticky scenario + validation boundary
