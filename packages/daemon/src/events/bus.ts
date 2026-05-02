import type { OwlEvent } from './types.js';

type Subscriber = (event: OwlEvent) => void;

/**
 * In-process pub/sub for daemon → GUI reverse-channel events.
 *
 * Intentionally tiny: a single `Set` of callbacks. SSE lifecycle (socket
 * open/close, keepalive, preClose flush) lives in `routes/events.ts`, so
 * this class stays focused on event dispatch alone.
 *
 * Dispatch takes a snapshot of subscribers before iterating so handlers
 * that unsubscribe (or re-subscribe) mid-dispatch don't mutate the set
 * underneath us. Handler exceptions are swallowed so one bad subscriber
 * can't break fan-out — the SSE writer is well-behaved in practice, this
 * is defence in depth.
 */
export class EventsBus {
  private readonly subscribers = new Set<Subscriber>();

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Returns the subscriber count AFTER dispatch. */
  emit(event: OwlEvent): number {
    const snapshot = [...this.subscribers];
    for (const fn of snapshot) {
      try {
        fn(event);
      } catch {
        // isolate one bad subscriber — caller logs upstream
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
