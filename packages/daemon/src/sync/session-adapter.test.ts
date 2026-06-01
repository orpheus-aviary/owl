/**
 * W3 (Phase 16c) — adaptClient must forward the server's `serverTime` from
 * the real client's pull/push results into the structural `SkybridgeClientLike`
 * shape so `runSync` can refresh the HLC offset. Pre-W3 the adapter dropped it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type RealSkybridgeClient, adaptClient } from './session.js';

describe('adaptClient — serverTime passthrough (W3)', () => {
  it('forwards serverTime from pull + push results', async () => {
    const fake = {
      async pullChanges() {
        return { changes: [], hasMore: false, latestSeq: 42, serverTime: 1_700_000_000_000 };
      },
      async pushChanges() {
        return { accepted: [], duplicates: [], latestSeq: 9, serverTime: 1_700_000_000_500 };
      },
    } as unknown as RealSkybridgeClient;

    const adapted = adaptClient(fake);

    const pull = await adapted.pullChanges('ws', 0);
    assert.equal(pull.serverTime, 1_700_000_000_000);
    assert.deepEqual(pull.changes, []);
    assert.equal(pull.hasMore, false);

    const push = await adapted.pushChanges('ws', []);
    assert.equal(push.serverTime, 1_700_000_000_500);
    assert.deepEqual(push.accepted, []);
    assert.deepEqual(push.duplicates, []);
  });
});
