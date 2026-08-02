// L3 — notes: create, edit, and persistence through the core
// (spec/notes.md, spec/local-store.md § notes; spec/testing.md § L3).
//
// The notes path is local-first: the editor owns a Y.Doc, `nativeNotes` encodes
// it, and `note_save`/`notes_load_all` are the only durability there is. Vitest
// covers the store and the editor separately with the IPC mocked; nothing until
// now drove the real editor into the real save path and read it back, which is
// the only way to catch a note that renders but never persists.

import { expect, test, type Page } from '@playwright/test';
import { installFakeCore, seededAccount, unimplementedCommands } from './fakeCore';

/** An unlocked, onboarded account whose note store is empty. */
const noNotesYet = { ...seededAccount, notes: [] };

/** Wait for the editor's debounced save to reach the core. */
async function saved(page: Page): Promise<void> {
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 5000 });
}

test.afterEach(async ({ page }) => {
  expect(await unimplementedCommands(page)).toEqual([]);
});

test('a new note is created, titled and written, and persists across a route change', async ({ page }) => {
  await installFakeCore(page, noNotesYet);
  await page.goto('/');

  // With an empty store the notes page opens a fresh note for you.
  await expect(page.getByPlaceholder('Untitled')).toBeVisible();

  await page.getByPlaceholder('Untitled').fill('Harbour plans');
  await page.locator('.cm-content').click();
  await page.keyboard.type('tide tables and a spare anchor');
  await saved(page);

  // The note is in the list under its title.
  await expect(page.locator('aside').getByText('Harbour plans')).toBeVisible();

  // Route away to another surface and back: the notes store is dropped only on
  // lock, so this is the cheap regression — a route change must not lose an edit.
  await page.getByRole('link', { name: 'Friends' }).click();
  await expect(page.getByRole('heading', { name: 'Friends', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Notes' }).click();

  await expect(page.getByPlaceholder('Untitled')).toHaveValue('Harbour plans');
  await expect(page.locator('.cm-content')).toContainText('tide tables and a spare anchor');
});

test('note content survives a lock/unlock cycle — it really went to the core', async ({ page }) => {
  await installFakeCore(page, noNotesYet);
  await page.goto('/');

  await page.getByPlaceholder('Untitled').fill('Recovery drill');
  await page.locator('.cm-content').click();
  await page.keyboard.type('write the code down, once');
  await saved(page);

  // Locking drops every decrypted note from memory (App.vue → notes.reset()).
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock' })).toBeVisible();
  await expect(page.getByText('Recovery drill')).toHaveCount(0);
  await expect(page.getByText('write the code down, once')).toHaveCount(0);

  await page.getByPlaceholder('Password').fill(seededAccount.password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();

  // Reloaded from the core's store, Y.Doc and all.
  await expect(page.getByPlaceholder('Untitled')).toHaveValue('Recovery drill');
  await expect(page.locator('.cm-content')).toContainText('write the code down, once');
});

test('a second note can be created and switched between', async ({ page }) => {
  await installFakeCore(page, noNotesYet);
  await page.goto('/');

  await page.getByPlaceholder('Untitled').fill('First note');
  await saved(page);

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByPlaceholder('Untitled')).toHaveValue('');
  await page.getByPlaceholder('Untitled').fill('Second note');
  await saved(page);

  const list = page.locator('aside');
  await expect(list.getByText('First note')).toBeVisible();
  await expect(list.getByText('Second note')).toBeVisible();

  await list.getByText('First note').click();
  await expect(page.getByPlaceholder('Untitled')).toHaveValue('First note');
});
