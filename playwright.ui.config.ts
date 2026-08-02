import { defineConfig, devices } from '@playwright/test';

// L3 — the real v8 UI in a plain browser, over a FAKED Tauri IPC
// (spec/testing.md § L3). Separate from playwright.config.ts, which boots the
// relay and drives it over HTTP: this suite needs no relay at all, only the web
// app, and the two must stay independently runnable.
//
//   npm run e2e      → relay HTTP suite   (playwright.config.ts, ./e2e/*.spec.ts)
//   npm run e2e:ui   → this suite         (./e2e/ui/*.spec.ts)
//
// The app is served by the Vite dev server on 5173 — the port named in the
// shell's `devCsp` (tauri.conf.json), so the page runs under the same
// Content-Security-Policy a developer's `npm run dev:native` session does and
// Vite's HMR socket is allowed. `strictPort` + `reuseExistingServer: false`
// means a stale Vite from another worktree fails the run loudly instead of
// silently serving a different tree (check with `lsof -ti tcp:5173`).
//
// The fake core is injected with `page.addInitScript` (e2e/ui/fakeCore.ts) —
// there is no test build, dev flag or production branch involved.

const PORT = Number(process.env.E2E_UI_PORT ?? 5173);
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e/ui',
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: ORIGIN,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `@notes/shared` resolves to its build output in the web app (unlike
    // Vitest, which aliases the source), so build it before serving.
    command: `npm run build -w shared && npm run dev -w web -- --port ${PORT} --strictPort`,
    url: ORIGIN,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
