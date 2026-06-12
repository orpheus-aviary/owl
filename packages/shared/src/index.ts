// @orpheus-aviary/owl-shared — the wire contract + HTTP client shared by every
// owl front-end (Electron renderer, web, mobile). Mobile-safe: no Node,
// Electron, or preload-global references (enforced by the
// shared-no-node-electron guard). Step 0 keeps it private (workspace-internal);
// Phase C publishes it.

export * from './types.js';
export * from './transport.js';
export * from './client.js';
