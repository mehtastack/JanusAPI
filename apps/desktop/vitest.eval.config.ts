import { defineConfig } from 'vitest/config';

// Opt-in live evaluation only; never part of `pnpm test`. The eval catches its own errors and always passes.
export default defineConfig({
  test: { include: ['eval/**/*.eval.ts'], environment: 'node', testTimeout: 6 * 3600_000, hookTimeout: 120_000 },
});
