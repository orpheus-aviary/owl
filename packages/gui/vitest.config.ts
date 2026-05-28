import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Absolute paths to the one-and-only React copy in this workspace —
// @testing-library/react@16 + React 19 inside vitest's jsdom environment hit
// the "Cannot read properties of null (reading 'useState')" hook dispatcher
// bug unless every react / react-dom import resolves to the same module
// instance. dedupe alone isn't enough under pnpm's strict store; explicit
// aliases close the door.
const REACT = resolve(__dirname, '../../node_modules/react');
const REACT_DOM = resolve(__dirname, '../../node_modules/react-dom');
const REACT_ROUTER = resolve(__dirname, '../../node_modules/react-router');
const REACT_ROUTER_DOM = resolve(__dirname, '../../node_modules/react-router-dom');

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
    },
  },
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: {
          alias: {
            '@': resolve(__dirname, 'src/renderer/src'),
            react: REACT,
            'react-dom': REACT_DOM,
            'react-router': REACT_ROUTER,
            'react-router-dom': REACT_ROUTER_DOM,
          },
          // P5-d Phase 8: react-router and its umbrella react-router-dom
          // both need to share the workspace React copy. Listing them in
          // dedupe + inlining via `server.deps.inline` below keeps
          // MemoryRouter from crashing with "useRef of null" inside
          // vitest's jsdom.
          dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom'],
        },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/src/**/*.test.ts', 'src/renderer/src/**/*.test.tsx'],
          setupFiles: ['src/renderer/src/test-setup.ts'],
          server: {
            deps: {
              inline: [/@testing-library\//, /^react-router(-dom)?$/],
            },
          },
        },
      },
      {
        test: {
          name: 'main',
          environment: 'node',
          // preload tests share node env + plain argv parsing helpers, no
          // electron context needed (args.ts factored out of preload/index.ts
          // for exactly this reason). P5-c G1.
          // P5-d Phase 8: `src/shared/**` joins the main project (node env,
          // no jsdom) — shared modules are pure TS / no DOM access.
          include: ['src/main/**/*.test.ts', 'src/preload/**/*.test.ts', 'src/shared/**/*.test.ts'],
        },
      },
    ],
  },
});
