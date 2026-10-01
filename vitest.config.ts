import { defineConfig } from 'vitest/config';

/** Unit tests: colocated `src/**\/*.spec.ts`, no database, no network. */
export default defineConfig({
  test: {
    root: './',
    include: ['src/**/*.spec.ts'],
    env: { NODE_ENV: 'test' },
  },
});
