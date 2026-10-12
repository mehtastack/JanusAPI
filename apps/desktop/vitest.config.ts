import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.{ts,tsx}'], environment: 'node', testTimeout: 15_000, setupFiles: ['test/setup-testing-library.ts'] },
});
