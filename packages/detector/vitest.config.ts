import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite database setup takes up to 10 s under resource contention
    // (e.g. when the full monorepo test suite runs in parallel).
    hookTimeout: 30_000,
  },
});
