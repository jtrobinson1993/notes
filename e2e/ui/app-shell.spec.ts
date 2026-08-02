// L3 — the app shell: the side rail, opening a conversation, sending, live
// inbound delivery, and the re-lock teardown (spec/testing.md § L3).
//
// This is pure UI wiring over the core — the part the Vitest `web` project
// cannot reach, because there the IPC is mocked at `lib/native.ts` per test and
// nothing composes: the rail's ordering comes from `conversation_activity`, the
// unread badge from `dm_unread`, and the messages from `messages_page`, all of
// which have to agree with each other after a send or a drain.

import { expect, test, type Page } from '@playwright/test';
import { deliverInbound, installFakeCore, seededAccount, unimplementedCommands } from './fakeCore';

/** The rail's links, top to bottom (conversations first, then Notes + footer). */
function railOrder(page: Page): Promise<string[]> {
  return page.locator('nav a[aria-label]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('aria-label') ?? ''),
  );
}

test.afterEach(async ({ page }) => {
  expect(await unimplementedCommands(page)).toEqual([]);
});

test('the rail lists every conversation, newest activity first, with unread counts', async ({ page }) => {
  await installFakeCore(page, seededAccount);
  await page.goto('/');

  // Alice has history, Bob has none — activity order, then Notes and the footer.
  await expect.poll(() => railOrder(page)).toEqual(['Alice', 'Bob', 'Notes', 'Friends', 'Settings']);

  // One unread: Alice's inbound message. My own reply does not count.
  const alice = page.getByRole('link', { name: 'Alice' });
  await expect(alice.getByText('1', { exact: true })).toBeVisible();
});

test('opening a conversation shows its messages and clears its unread badge', async ({ page }) => {
  await installFakeCore(page, seededAccount);
  await page.goto('/');

  await page.getByRole('link', { name: 'Alice' }).click();

  // The conversation header names the friend by their display name.
  await expect(page.getByRole('main').getByText('Alice', { exact: true })).toBeVisible();
  await expect(page.getByText('first light')).toBeVisible();
  await expect(page.getByText('morning Alice')).toBeVisible();

  // Opening marked the conversation read in the core, and the rail agrees.
  const alice = page.getByRole('link', { name: 'Alice' });
  await expect(alice.getByText('1', { exact: true })).toHaveCount(0);

  // Bob's DM exists because he is a friend, and it is empty.
  await page.getByRole('link', { name: 'Bob' }).click();
  await expect(page.getByText('first light')).toHaveCount(0);
});

test('sending a message shows it, and moves that chat to the top of the rail', async ({ page }) => {
  await installFakeCore(page, seededAccount);
  await page.goto('/');

  await page.getByRole('link', { name: 'Bob' }).click();
  await page.getByTestId('draft').fill('shipping the harness');
  await page.getByTestId('send').click();

  await expect(page.getByText('shipping the harness')).toBeVisible();
  await expect(page.getByTestId('draft')).toHaveValue('');

  // The send went through the core: it is the newest activity, so Bob's DM
  // overtakes Alice's in the activity-ordered rail.
  await expect.poll(() => railOrder(page)).toEqual(['Bob', 'Alice', 'Notes', 'Friends', 'Settings']);

  // And it is in the local log, not just in the component's state: a webview
  // reload re-reads everything from the core and the message is still there.
  await page.reload();
  await expect(page.getByText('shipping the harness')).toBeVisible();
});

test('live inbound mail reaches the rail and the open conversation', async ({ page }) => {
  await installFakeCore(page, seededAccount);
  await page.goto('/');
  await page.getByRole('link', { name: 'Alice' }).click();
  await expect(page.getByText('first light')).toBeVisible();

  // The core pushes `relay:mail`; the app drains, ingests, and refreshes.
  await deliverInbound(page, 'contact-bob', 'ping from Bob');

  const bob = page.getByRole('link', { name: 'Bob' });
  await expect(bob.getByText('1', { exact: true })).toBeVisible();
  await expect.poll(() => railOrder(page)).toEqual(['Bob', 'Alice', 'Notes', 'Friends', 'Settings']);

  // A message for the conversation that is *open* renders without navigating.
  await deliverInbound(page, 'contact-alice', 'are you there');
  await expect(page.getByText('are you there')).toBeVisible();
});

test('re-locking tears the decrypted world off the screen, and unlocking rebuilds it', async ({ page }) => {
  await installFakeCore(page, seededAccount);
  await page.goto('/');
  await page.getByRole('link', { name: 'Alice' }).click();
  await expect(page.getByText('first light')).toBeVisible();

  // "Sign out" is a vault re-lock: there is no server session to end.
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page.getByRole('heading', { name: 'Unlock' })).toBeVisible();
  // Nothing derived from the master key may outlive it: no rail, no friend
  // names, no message bodies.
  await expect(page.locator('nav')).toHaveCount(0);
  await expect(page.getByText('Alice')).toHaveCount(0);
  await expect(page.getByText('first light')).toHaveCount(0);
  await expect(page.getByText('morning Alice')).toHaveCount(0);

  // It was dropped, not hidden: unlocking re-reads it all from the core.
  await page.getByPlaceholder('Password').fill(seededAccount.password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Alice' })).toBeVisible();
  await page.getByRole('link', { name: 'Alice' }).click();
  await expect(page.getByText('first light')).toBeVisible();
});

// Regression: the vault gate opens BEFORE the cold-start relay redial finishes,
// so the rail's first refresh always lost the race — `dm_conversation_id_for`
// rejects with "not connected to a relay" — and nothing retried, because drains
// only notify when they ingest something. The rail stayed empty until mail
// arrived, despite every conversation already being in the local store. Fixed
// by having the rail also refresh on `onRelayConnected`.
test('cold launch: the rail fills in once the relay redial completes', async ({ page }) => {
  await installFakeCore(page, { ...seededAccount, connected: false });
  await page.goto('/');

  await expect(page.getByRole('link', { name: 'Alice' })).toBeVisible({ timeout: 5000 });
});

// Regression: `messages_page` is a BACKWARDS pager (`relay_ts DESC`, correct for
// walking into history) and the thread rendered the array as-is, putting the
// newest message at the top. `loadHistoryLocal` now reverses for display while
// keeping the cursor on the pager's own order.
test('a conversation reads oldest at the top, newest at the bottom', async ({ page }) => {
  await installFakeCore(page, seededAccount);
  await page.goto('/');
  await page.getByRole('link', { name: 'Alice' }).click();
  await expect(page.getByText('first light')).toBeVisible();

  const thread = await page.getByRole('main').innerText();
  expect(thread.indexOf('first light')).toBeLessThan(thread.indexOf('morning Alice'));
});
