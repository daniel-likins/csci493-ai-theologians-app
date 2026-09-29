import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: `${root}test-results`,
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1360, height: 860 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/mock-openai-server.mjs 47995',
      url: 'http://127.0.0.1:47995/health',
      cwd: root,
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/start-backend.mjs',
      url: 'http://127.0.0.1:47970/api/health',
      cwd: root,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
