import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// A throwaway DATA_DIR per run — never the dev ./data (spec infra note).
const DATA_DIR = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'notes-e2e-'));
const PORT = Number(process.env.E2E_PORT ?? 4321);
const ORIGIN = `http://localhost:${PORT}`;
const WEB_DIST = fileURLToPath(new URL('./web/dist', import.meta.url));

export default defineConfig({
  testDir: './e2e',
  // The chat flow shares one server + DB, so keep runs serial and ordered.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: ORIGIN,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Enable in CI once WebKit is installed (`npm run e2e:install`).
    // { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // Build is run separately (CI builds before this); here we just serve the
  // built server, which itself serves web/dist.
  webServer: {
    command: 'node server/dist/index.js',
    url: `${ORIGIN}/api/health`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR,
      APP_ORIGIN: ORIGIN,
      APP_NAME: 'Notes E2E',
      WEB_DIST,
    },
  },
});
