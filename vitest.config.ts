import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Run tests in random order to expose hidden order-dependent state leakage
    sequence: {
      shuffle: true,
    },
    // Global test timeout for concurrency stress tests
    testTimeout: 30000,
  },
});
