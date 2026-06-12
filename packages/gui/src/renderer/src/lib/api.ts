// The owl daemon API client + wire types now live in
// @orpheus-aviary/owl-shared so web and mobile can consume the same contract.
// This module re-exports them to keep the `@/lib/api` import path stable across
// the renderer (no churn at the ~dozen call sites).
//
// Transport (base URL + auth headers) is configured once at startup:
// `main.tsx` for the app, `test-setup.ts` for tests. See the platform adapter
// (`@/platform`) for how the base URL is resolved per host.
export * from '@orpheus-aviary/owl-shared';
