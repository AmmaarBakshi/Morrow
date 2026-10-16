import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/server/test/**/*.test.ts',
      'apps/cli/test/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
