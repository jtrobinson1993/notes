import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway DATA_DIR per run — never the dev ./data (spec infra note).
const DATA_DIR = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'notes-e2e-'));
const PORT = Number(process.env.E2E_PORT ?? 4321);
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // The L3 UI suite (e2e/ui) drives the web app over a faked Tauri IPC and needs
  // no relay at all — it has its own config (playwright.ui.config.ts, run with
  // `npm run e2e:ui`). Keep it out of this run.
  testIgnore: '**/ui/**',
  // The specs share one relay + DB, so keep runs serial and ordered.
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
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Fake mic so getUserMedia works headlessly (voice media e2e), and
        // auto-grant the permission prompt.
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
    // Enable in CI once WebKit is installed (`npm run e2e:install`).
    // { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // Build is run separately (CI builds before this); here we do exactly what an
  // operator does — mint an identity bundle and drop it in DATA_DIR — and then
  // boot the built relay, the only server there is. The relay refuses to start
  // without one (no first-boot auto-mint; see spec/relay.md), and it ingests the
  // bundle itself, so there is no install step. `--if-missing` keeps a reused
  // E2E_DATA_DIR working: it leaves an existing bundle alone rather than minting
  // a second root and locking the relay out of its own database mid-suite.
  webServer: {
    command:
      `node server/dist/relay-cli.js init-identity --if-missing --out ${join(DATA_DIR, 'relay-identity.json')} && ` +
      'node server/dist/relay-index.js',
    url: `${ORIGIN}/api/health`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR,
      APP_ORIGIN: ORIGIN,
      // Open registration so a spec can create throwaway accounts through the
      // real signup endpoint. There is no auth bypass: every account is made
      // with the production register → challenge → signed-nonce → token flow.
      RELAY_REGISTRATION_MODE: 'public',
    },
  },
});
