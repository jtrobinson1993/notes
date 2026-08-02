// L3 — the vault wall (spec/native-app.md § the gate, spec/testing.md § L3).
//
// NativeGate is the only thing between a launch and the app, and none of it was
// covered by any automated test: the Vitest `web` project mocks
// `lib/native.ts`, so it never exercises the gate's real state machine end to
// end, and there is no browser build to drive. Here the real component runs
// against the stateful fake core, so "create a vault → it reports unlocked",
// "wrong password does not open the gate" and "onboarding persists the handle +
// relay URL" are assertions about the app, not about a stub.

import { expect, test } from '@playwright/test';
import { firstRun, installFakeCore, lockedDevice, unimplementedCommands } from './fakeCore';

const PASSWORD = 'correct horse battery staple';

test.afterEach(async ({ page }) => {
  // Harness health: if the UI reached for a command the fake doesn't implement,
  // the fake — not the app — is what needs updating.
  expect(await unimplementedCommands(page)).toEqual([]);
});

test('first run: sign up, save the recovery code, onboard, and land in the app', async ({ page }) => {
  await installFakeCore(page, firstRun);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Welcome to Accord' })).toBeVisible();
  // Sign up is the only way forward: relay-held escrow is removed and pairing is
  // unbuilt, so there is no log-in affordance to click (roadmap § Escrow —
  // removed). The explainer behind "Already have an account?" says so in words.
  await expect(page.getByTestId('login')).toHaveCount(0);
  await page.getByRole('button', { name: 'Already have an account?' }).click();
  await expect(page.getByText(/pairing step isn't built yet/)).toBeVisible();
  await page.getByRole('button', { name: '← Back' }).click();

  await page.getByTestId('signup').click();

  // Handles are generated, never typed (invariant: the handle is the only
  // identifier). One of the offered candidates is preselected.
  await expect(page.getByTestId('handle-option')).toHaveCount(4);
  const handle = (await page.getByTestId('handle-option').first().innerText()).trim();
  await page.getByTestId('handle-option').first().click();

  // The 16-character minimum and the confirmation are enforced before any
  // vault is created — the gate must not hand a weak password to the core.
  await page.getByPlaceholder('Password (min 16 characters)').fill('short');
  await page.getByPlaceholder('Confirm password').fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Password must be at least 16 characters.')).toBeVisible();

  await page.getByPlaceholder('Password (min 16 characters)').fill(PASSWORD);
  await page.getByPlaceholder('Confirm password').fill('a different password entirely');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Passwords do not match.')).toBeVisible();

  await page.getByPlaceholder('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // The recovery code the core minted is shown exactly once.
  await expect(page.getByTestId('recovery-code')).toHaveText(firstRun.recoveryCode);
  await page.getByRole('button', { name: 'I saved my recovery code' }).click();

  await page.getByPlaceholder('Display name').fill('Test User');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Unlocked but not yet onboarded: the gate stops on the join step rather than
  // opening the app.
  await expect(page.getByRole('heading', { name: 'Join with an invite' })).toBeVisible();
  await page.getByRole('button', { name: /relay address \+ code instead/ }).click();
  await page.getByPlaceholder('Relay address (https://…)').fill('https://relay.test');
  await page.getByRole('button', { name: 'Create account' }).click();

  // The app shell is up.
  await expect(page.getByRole('link', { name: 'Notes' })).toBeVisible();

  // Coherence: the vault the wizard created reports itself unlocked, and the
  // handle + relay URL it stored survive a webview reload, so the gate opens
  // straight through instead of restarting the wizard.
  await page.reload();
  await expect(page.getByRole('link', { name: 'Notes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to Accord' })).toHaveCount(0);

  // The handle the wizard claimed is the one the app now shows as mine.
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText(handle, { exact: false }).first()).toBeVisible();
});

test('a locked vault stops on the unlock wall, and a wrong password does not open it', async ({ page }) => {
  // keychain: false — the silent D3 unlock fails, so the gate falls back to the
  // password wall (the case a user actually sees a prompt in).
  await installFakeCore(page, { ...lockedDevice, keychain: false });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Unlock' })).toBeVisible();
  // Nothing the master key protects is on screen before it is supplied.
  await expect(page.getByRole('link', { name: 'Notes' })).toHaveCount(0);
  await expect(page.getByText('Alice')).toHaveCount(0);

  await page.getByPlaceholder('Password').fill('not the password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();

  // The core's own rejection is surfaced, and the wall stays up.
  await expect(page.getByText('wrong password')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unlock' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Notes' })).toHaveCount(0);

  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Notes' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Alice' })).toBeVisible();
});

test('the recovery code is a second way in, and a wrong one is refused', async ({ page }) => {
  await installFakeCore(page, { ...lockedDevice, keychain: false });
  await page.goto('/');

  await page.getByRole('button', { name: 'Use recovery code instead' }).click();
  await page.getByPlaceholder('Recovery code').fill('FAKE-CODE-9999-9999-9999-9999');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByText('wrong recovery code')).toBeVisible();

  // Case + separators are normalized by the core before comparing.
  await page.getByPlaceholder('Recovery code').fill(lockedDevice.recoveryCode.toLowerCase().replace(/-/g, ' '));
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Notes' })).toBeVisible();
});

test('a keychain-backed device unlocks silently, with no password prompt', async ({ page }) => {
  await installFakeCore(page, { ...lockedDevice, keychain: true });
  await page.goto('/');

  await expect(page.getByRole('link', { name: 'Notes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unlock' })).toHaveCount(0);
});
