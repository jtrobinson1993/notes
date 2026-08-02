// L3 — friends: the list, and a friendship that arrives over the mailbox
// (spec/chat.md § v8 friends, D4b; spec/testing.md § L3).
//
// Friends are not a server list the UI polls: the core records them when a
// friend-accept/confirm envelope drains, and every 1:1 surface (the rail's DMs,
// the member pickers) is derived from `friends_list`. The fake queues the
// *result* of a verified handshake, so what is exercised here is the UI's half —
// that a friend recorded by a drain reaches both the friends page and the rail.

import { expect, test } from '@playwright/test';
import {
  deliverFriend,
  deliverInbound,
  installFakeCore,
  seededAccount,
  unimplementedCommands,
} from './fakeCore';

test.afterEach(async ({ page }) => {
  expect(await unimplementedCommands(page)).toEqual([]);
});

test('the friends page lists friends by display name over handle', async ({ page }) => {
  await installFakeCore(page, seededAccount);
  await page.goto('/friends');

  const alice = page.locator('li', { hasText: 'Anchor#1001' });
  // The invariant: contacts see the E2EE display name, with the public handle
  // still shown underneath — never a username, which does not exist.
  await expect(alice.getByText('Alice', { exact: true })).toBeVisible();
  await expect(alice.getByText('Anchor#1001')).toBeVisible();
  await expect(page.getByText('No friends yet', { exact: false })).toHaveCount(0);
});

test('a friend recorded by a mailbox drain shows up in the list and the rail', async ({ page }) => {
  await installFakeCore(page, seededAccount);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Alice' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Carol' })).toHaveCount(0);

  // The inviter's confirm lands, then their first message — one nudge, one
  // drain: the friendship is recorded before the message that needs it.
  await deliverFriend(page, { contactId: 'contact-carol', handle: 'Cove#3003', displayName: 'Carol' });
  await deliverInbound(page, 'contact-carol', 'we are friends now');

  const carol = page.getByRole('link', { name: 'Carol' });
  await expect(carol).toBeVisible();
  await expect(carol.getByText('1', { exact: true })).toBeVisible();

  await carol.click();
  await expect(page.getByText('we are friends now')).toBeVisible();

  await page.getByRole('link', { name: 'Friends' }).click();
  await expect(page.locator('li', { hasText: 'Cove#3003' }).getByText('Carol', { exact: true })).toBeVisible();
});

test('an invite code can be generated and is shown for sharing', async ({ page }) => {
  await installFakeCore(page, seededAccount);
  await page.goto('/friends');

  await expect(page.getByText('No active invite codes')).toBeVisible();
  await page.getByRole('button', { name: 'Generate invite code' }).click();

  // The invite is the self-describing capability blob, not an id the relay
  // resolves — it carries the relay, the pinned fingerprint and my keys.
  const code = page.locator('p.font-mono').first();
  await expect(code).toBeVisible();
  expect(await code.innerText()).toContain('accord://friend?i=');
});
