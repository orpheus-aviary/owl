import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
    },
  },
  test: {
    include: ['src/renderer/src/**/*.test.ts', 'src/renderer/src/**/*.test.tsx'],
  },
});
