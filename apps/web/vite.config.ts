import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Phase B (B0) — the web app reuses the Electron renderer tree wholesale
// (design §3.1, 路 A). The renderer source stays put under packages/gui; this
// app is a thin browser host that aliases `@` to it and mounts <App/>. The
// renderer's getPlatform() returns the web adapter at runtime (no window.owlAPI
// in a browser), so the same code runs against a daemon over HTTP.
const rendererSrc = fileURLToPath(new URL('../../packages/gui/src/renderer/src', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// In production the web bundle is served same-origin by the daemon (design
// §3.5 / B4). In dev the app runs on its own Vite port, so proxy the daemon's
// API surface to keep the web adapter's same-origin (relative) base URL honest
// and avoid CORS. Defaults to a local daemon on 47010; override with
// OWL_DAEMON_PORT. SSE (/events, /ai/chat) streams through the http proxy.
const daemonTarget = `http://127.0.0.1:${process.env.OWL_DAEMON_PORT ?? '47010'}`;
const API_PREFIXES = [
  '/ai',
  '/api',
  '/auth',
  '/config',
  '/conflicts',
  '/events',
  '/folders',
  '/llm',
  '/notes',
  '/parse-tag',
  '/reminders',
  '/status',
  '/sync',
  '/tags',
  '/todos',
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': rendererSrc,
    },
    // The renderer lives outside this app's node_modules; without dedupe Vite
    // can resolve a second React copy from packages/gui and break hooks.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5274,
    // The renderer source is outside apps/web — allow serving from repo root.
    fs: { allow: [repoRoot] },
    proxy: Object.fromEntries(
      API_PREFIXES.map((p) => [p, { target: daemonTarget, changeOrigin: true }]),
    ),
  },
  build: {
    outDir: 'dist',
  },
});
