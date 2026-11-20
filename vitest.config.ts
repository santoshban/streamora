import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['backend/test/**/*.test.ts', 'plugins/*/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
