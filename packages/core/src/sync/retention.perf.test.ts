import { describe, it } from 'node:test';
import { createDatabase } from '../db/index.js';
import { pruneSyncedChanges } from './retention.js';

/**
 * Retention benchmark — prints, never asserts on the clock (CI jitter would
 * make a threshold flaky). Run it deliberately:
 *
 *   OWL_PERF=1 node --test 'dist/sync/retention.perf.test.js'
 *
 * Baseline recorded on the 0.6.2 dev machine, 200k rows, the indexes 0005
 * already ships (no retention-specific index — a partial index over
 * `synced_at IS NOT NULL` would be roughly a second copy of the table):
 *
 *   EXPLAIN QUERY PLAN  →  SEARCH sync_changes USING INTEGER PRIMARY KEY
 *                          (rowid>?)      ← the `local_seq > safeAfter` gate
 *   steady state (nothing prunable, walks the range):  ~5 ms
 *   full 5000-row batch deleted:                       ~4 ms
 *
 * The plan doc predicted a full SCAN at ~34 ms; adding the watermark gate
 * turned it into a rowid range search. Either way it runs at most once an hour
 * per database, well inside the noise of a sync round.
 */

const ENDPOINT = 'http://sync.example.test';
const ROWS = 200_000;
const NOW = 10_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('retention benchmark (OWL_PERF=1)', { skip: !process.env.OWL_PERF }, () => {
  it('prints prune timings at 200k rows', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    sqlite
      .prepare(
        `INSERT INTO sync_cursor (endpoint, pulled_seq, pushed_seq, updated_at)
         VALUES (?, ?, 0, 1)`,
      )
      .run(ENDPOINT, ROWS + 1);
    sqlite
      .prepare(
        `INSERT INTO local_metadata (key, value)
         VALUES ('sync_retention_safe_after_local_seq', '0')`,
      )
      .run();

    const insert = sqlite.prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at,
          client_change_id, server_seq, synced_at)
       VALUES ('dev-local', 'note', 'n1', 'update', '{}', 1, ?, ?, ?)`,
    );
    // Everything synced *inside* the retention window → steady state: the
    // subquery has to scan the whole table and finds nothing to delete.
    const fresh = NOW - DAY;
    sqlite.transaction(() => {
      for (let i = 1; i <= ROWS; i++) insert.run(`cid-${i}`, i, fresh);
    })();

    const plan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT local_seq FROM sync_changes
          WHERE local_seq > 0 AND synced_at IS NOT NULL AND synced_at < ?
            AND server_seq IS NOT NULL AND server_seq <= ?
          ORDER BY local_seq LIMIT 5000`,
      )
      .all(NOW, ROWS + 1);
    console.log('[perf] query plan:', JSON.stringify(plan));

    const t0 = performance.now();
    const steady = pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: () => NOW });
    const t1 = performance.now();
    console.log(
      `[perf] steady state (deleted=${steady.pruned ? steady.deleted : 'n/a'}): ${(t1 - t0).toFixed(1)} ms`,
    );

    // Now age every row past the window so the LIMIT stops early.
    sqlite.prepare('UPDATE sync_changes SET synced_at = ?').run(NOW - 30 * DAY);
    const t2 = performance.now();
    const batch = pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: () => NOW });
    const t3 = performance.now();
    console.log(
      `[perf] prunable batch (deleted=${batch.pruned ? batch.deleted : 'n/a'}): ${(t3 - t2).toFixed(1)} ms`,
    );

    sqlite.close();
  });
});
