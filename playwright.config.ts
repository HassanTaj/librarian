import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  retries: 0,
  forbidOnly: true,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure',
    ...(process.env.LIBRARIAN_BROWSER_EXECUTABLE ? { launchOptions: { executablePath: process.env.LIBRARIAN_BROWSER_EXECUTABLE } } : {}) },
  globalTeardown: './tests/browser/global-teardown.mjs',
  webServer: {
    command: `"${process.execPath}" tests/browser/serve.mjs`,
    url: 'http://127.0.0.1:3100/',
    reuseExistingServer: false,
    env: { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
