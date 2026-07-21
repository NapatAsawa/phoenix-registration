import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Testcontainers boots a real Postgres; give integration tests room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
