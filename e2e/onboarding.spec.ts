import { expect, test } from '@playwright/test';

// No-auth smoke tests: prove the built server + SPA boot, serve the API, and
// route an unconfigured server to first-run setup. These need no WebAuthn.

test('health endpoint responds', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toEqual({ ok: true });
});

test('meta reports the app name and setup state', async ({ request }) => {
  const res = await request.get('/api/meta');
  expect(res.ok()).toBeTruthy();
  const meta = await res.json();
  expect(meta).toHaveProperty('appName');
  expect(typeof meta.needsSetup).toBe('boolean');
});

test('a fresh server routes to first-run setup and renders the bootstrap page', async ({ page, request }) => {
  // Assumes this is the first spec to touch the throwaway DATA_DIR.
  const meta = await (await request.get('/api/meta')).json();
  test.skip(meta.needsSetup === false, 'server already has a user; DATA_DIR not fresh');

  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up Notes' })).toBeVisible();
  await expect(page.getByText('Create the admin account for this server.')).toBeVisible();
});
