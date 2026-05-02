import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventsBus } from './bus.js';
import type { OwlEvent } from './types.js';

describe('EventsBus', () => {
  it('delivers emitted events to a single subscriber', () => {
    const bus = new EventsBus();
    const received: OwlEvent[] = [];

    bus.subscribe((e) => received.push(e));

    const count = bus.emit({ type: 'open_note', note_id: 'note-1' });

    assert.equal(count, 1);
    assert.deepEqual(received, [{ type: 'open_note', note_id: 'note-1' }]);
  });

  it('fans out to every active subscriber', () => {
    const bus = new EventsBus();
    const a: OwlEvent[] = [];
    const b: OwlEvent[] = [];

    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.emit({ type: 'hello', server_time: 1 });
    bus.emit({ type: 'open_note', note_id: 'x' });

    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    assert.deepEqual(a, b);
  });

  it('stops delivering after the unsubscribe handle is called', () => {
    const bus = new EventsBus();
    const received: OwlEvent[] = [];

    const unsubscribe = bus.subscribe((e) => received.push(e));
    bus.emit({ type: 'hello', server_time: 1 });
    unsubscribe();
    bus.emit({ type: 'open_note', note_id: 'y' });

    assert.equal(received.length, 1);
    assert.equal(bus.size(), 0);
  });

  it('isolates a throwing subscriber so peers still receive the event', () => {
    const bus = new EventsBus();
    const good: OwlEvent[] = [];

    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => good.push(e));

    // emit must not throw, and the well-behaved subscriber must still fire.
    assert.doesNotThrow(() => bus.emit({ type: 'open_note', note_id: 'z' }));
    assert.equal(good.length, 1);
  });

  it('close() clears all subscribers', () => {
    const bus = new EventsBus();

    bus.subscribe(() => {});
    bus.subscribe(() => {});
    assert.equal(bus.size(), 2);

    bus.close();

    assert.equal(bus.size(), 0);
    // Emitting after close is a no-op with zero subscribers.
    assert.equal(bus.emit({ type: 'hello', server_time: 2 }), 0);
  });
});
