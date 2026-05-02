/**
 * Event types broadcast over the daemon → GUI reverse channel.
 *
 * `hello` is emitted once per subscription at the moment GET /events
 * establishes, so renderers / tests can observe that the channel is live
 * before relying on downstream events.
 *
 * `open_note` is pushed by `POST /events/emit` and makes the GUI open
 * the target note's editor tab. The daemon validates the id (exists and
 * not trashed) before emitting, so subscribers can trust the payload.
 *
 * New event types should be added here and mirrored in the renderer
 * dispatcher (see `packages/gui/src/renderer/src/components/
 * events-subscriber-core.ts`). The wire contract is simply
 * `event: <type>` with `data: JSON.stringify(event)`.
 */
export type OwlEvent =
  | { type: 'hello'; server_time: number }
  | { type: 'open_note'; note_id: string };
