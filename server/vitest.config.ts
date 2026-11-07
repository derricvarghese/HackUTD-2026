import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
