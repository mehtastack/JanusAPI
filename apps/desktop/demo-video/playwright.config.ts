import { defineConfig } from '@playwright/test';

/** Records the product demo video. Run: npx playwright test -c demo-video (after electron-vite build). Not part of e2e. */
export default defineConfig({
  testDir: '.',
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: { actionTimeout: 15_000 },
  expect: { timeout: 15_000 },
});
