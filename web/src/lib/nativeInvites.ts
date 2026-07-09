// Friend invite orchestration (D4b) — ties the pure payload layer (invites.ts)
// to the Rust core's relay IPC. Kept out of invites.ts so that module stays
// pure/testable. The friends-store recording (adding the friend on both sides,
// processing the inbound friend-accept envelope on drain, reciprocating the
// delivery token) is deliberately NOT here yet — that's the legacy
// friends-store cutover.

import { envelopeSeal, relayInviteMint, relayInviteRedeem, relayMyDirectoryKeys } from './native';
import { buildInvite, generateInviteToken, inviteTokenHash, parseInvite } from './invites';

/** Envelope `kind` for the sealed friend-accept dropped on redeem. */
export const FRIEND_ACCEPT_KIND = 'friend-accept';

/**
 * Create a shareable friend invite: mint `hash(token)` at the relay, then
 * assemble the self-describing invite embedding my pinned directory keys.
 * `relayUrl`/`relayFp` come from the connected relay; `handle` is my handle.
 */
export async function createFriendInvite(opts: {
  handle: string;
  relayUrl: string;
  relayFp: string;
  expiresInSec?: number;
}): Promise<{ invite: string; expiresAt: number }> {
  const token = generateInviteToken();
  const expiresAt = await relayInviteMint(await inviteTokenHash(token), opts.expiresInSec);
  const keys = await relayMyDirectoryKeys();
  const invite = buildInvite({
    relayUrl: opts.relayUrl,
    relayFp: opts.relayFp,
    token,
    handle: opts.handle,
    identityPub: keys.identity_pub,
    sealingPub: keys.sealing_pub,
  });
  return { invite, expiresAt };
}

/**
 * Redeem an invite: seal a friend-accept (my handle + delivery token) to the
 * inviter's pinned sealing key and drop it through the one-time capability.
 * Resolves with the inviter's handle (to friend locally) and the relay stamp.
 * The inviter reciprocates its own delivery token on drain.
 */
export async function redeemFriendInvite(
  inviteStr: string,
  me: { handle: string; deliveryToken: string },
): Promise<{ inviterHandle: string; relayTs: number }> {
  const inv = parseInvite(inviteStr);
  const payload = Array.from(
    new TextEncoder().encode(JSON.stringify({ handle: me.handle, deliveryToken: me.deliveryToken })),
  );
  const envelope = await envelopeSeal(inv.sealingPub, FRIEND_ACCEPT_KIND, payload);
  const relayTs = await relayInviteRedeem(inv.token, envelope);
  return { inviterHandle: inv.handle, relayTs };
}
