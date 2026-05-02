/**
 * Pure event-dispatch helper for the daemon → GUI reverse channel.
 *
 * Kept React-free and EventSource-free so it can be unit-tested with
 * plain mocks. `EventsSubscriber` is just a thin wrapper that hooks
 * this into `EventSource.addEventListener` and `useNavigate`.
 *
 * Failures inside the handler chain (malformed payload, note deleted
 * between daemon emit and this handler, network glitch inside
 * `openNoteById`) are swallowed with a warn, because our only caller
 * invokes us via `void handleDaemonEvent(...)` from an EventSource
 * listener — anything thrown or rejected would surface as an
 * unhandled rejection. The emit side already surfaces real failures
 * to the CLI; renderer-side we just want to stay silent.
 */
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

  try {
    await handlers.openNoteById(data.note_id);
    handlers.navigate('/');
  } catch (err) {
    console.warn('[events] open_note handler failed:', err);
  }
}
