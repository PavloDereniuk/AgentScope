import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    // PGlite cold-start + 10+ SQL migrations per beforeEach can exceed
    // the default 10s on Windows when turbo runs several test packages
    // in parallel. Bumped so cold-start variance doesn't fail the suite.
    hookTimeout: 30_000,
    typecheck: {
      enabled: false,
    },
  },
});
