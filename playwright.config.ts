import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/extension',
  testMatch: '**/*.pw.ts',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'line',
  timeout: 45_000,
  expect: {
    timeout: 7_500,
  },
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
});
