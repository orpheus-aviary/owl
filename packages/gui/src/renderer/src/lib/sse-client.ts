// The SSE client now lives in @orpheus-aviary/owl-shared (host-agnostic, routes
// through the configured transport). Re-exported here so the `@/lib/sse-client`
// import path stays stable for the renderer.
export {
  type SseFrame,
  type StreamSseOptions,
  type SubscribeSseOptions,
  SseHttpError,
  parseSseBlock,
  streamSse,
  subscribeSse,
} from '@orpheus-aviary/owl-shared';
