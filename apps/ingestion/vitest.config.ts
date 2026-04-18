import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    // PGlite WASM boot + migrations in beforeAll can exceed the 10s default
    // on slower hosts (notably Windows). Keep in sync with testTimeout.
    hookTimeout: 30_000,
    typecheck: {
      enabled: false,
    },
  },
});
