// Friend flow orchestration (D4b) — composes the now-available native handle
// source, the connected relay, and the delivery-token verifier into the two
// user-facing actions the friends UI drives: create an invite, redeem one. Kept
// separate from the pure payload layer (invites.ts) and the IPC wrappers so the
// UI stays thin.

import { relayRegisterVerifier, relayStatus, settingsGet } from './native';
import { createFriendInvite, redeemFriendInvite } from './nativeInvites';

const MY_HANDLE_KEY = 'identity.handle';

async function myHandle(): Promise<string> {
  const handle = await settingsGet(MY_HANDLE_KEY);
  if (!handle) throw new Error('no local handle — finish onboarding/migration first');
  return handle;
}

/**
 * Create a shareable friend invite (QR / link). Ensures my delivery-token
 * verifier is registered first (so a redeemer's sealed accept can actually reach
 * me), then assembles the invite from my handle + the connected relay.
 */
export async function createInvite(expiresInSec?: number): Promise<{ invite: string; expiresAt: number }> {
  const handle = await myHandle();
  const status = await relayStatus();
  if (!status.connected || !status.base_url || !status.relay_fp) {
    throw new Error('not connected to a relay');
  }
  await relayRegisterVerifier(); // friends must be able to deliver to me
  return createFriendInvite({
    handle,
    relayUrl: status.base_url,
    relayFp: status.relay_fp,
    expiresInSec,
  });
}

/**
 * Redeem a friend invite: register my verifier (and get my delivery token to
 * seal into the accept), then drop the sealed friend-accept via the invite's
 * one-time capability. The inviter reciprocates a confirm on their next drain →
 * mutual. Resolves with the inviter's handle.
 */
export async function redeemInvite(inviteStr: string): Promise<{ inviterHandle: string; relayTs: number }> {
  const handle = await myHandle();
  const deliveryToken = await relayRegisterVerifier();
  return redeemFriendInvite(inviteStr, { handle, deliveryToken });
}
