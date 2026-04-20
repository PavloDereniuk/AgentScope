import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests spin up a mock OTLP HTTP server and await async
    // span exports — the 5s default is tight under parallel turbo runs.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
