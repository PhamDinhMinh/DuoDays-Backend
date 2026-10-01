import { defineConfig } from 'vitest/config';

/**
 * E2E tests: the real Nest app against a throwaway mongodb-memory-server replica set
 * (started once in globalSetup). They never touch the shared Atlas database.
 */
export default defineConfig({
  test: {
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    env: { NODE_ENV: 'test' },
    // The first run downloads the MongoDB binary.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
