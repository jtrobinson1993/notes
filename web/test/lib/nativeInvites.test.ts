import { describe, expect, it, vi, beforeEach } from 'vitest';

const native = vi.hoisted(() => ({
  relayInviteMint: vi.fn(),
  relayInviteRedeem: vi.fn(),
  relayMyDirectoryKeys: vi.fn(),
  envelopeSeal: vi.fn(),
  settingsSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/native', () => native);

import { createFriendInvite, redeemFriendInvite, FRIEND_ACCEPT_KIND } from '../../src/lib/nativeInvites';
import { parseInvite, inviteTokenHash, buildInvite } from '../../src/lib/invites';

beforeEach(() => vi.clearAllMocks());

describe('createFriendInvite', () => {
  it('mints hash(token) and embeds my pinned keys in the invite', async () => {
    native.relayInviteMint.mockResolvedValue(1_900_000_000_000);
    native.relayMyDirectoryKeys.mockResolvedValue({ identity_pub: 'IDPUB', sealing_pub: 'SEALPUB' });

    const { invite, expiresAt } = await createFriendInvite({
      handle: 'Word#1234',
      relayUrl: 'https://relay.example',
      relayFp: 'FP',
    });
    expect(expiresAt).toBe(1_900_000_000_000);

    const parsed = parseInvite(invite);
    expect(parsed).toMatchObject({
      relayUrl: 'https://relay.example',
      relayFp: 'FP',
      handle: 'Word#1234',
      identityPub: 'IDPUB',
      sealingPub: 'SEALPUB',
    });
    // The hash minted at the relay must be hash(the embedded token) — so a
    // later redeem of that token resolves to the stored invite.
    expect(native.relayInviteMint).toHaveBeenCalledTimes(1);
    const mintedHash = native.relayInviteMint.mock.calls[0][0] as string;
    expect(mintedHash).toBe(await inviteTokenHash(parsed.token));
    // My handle is persisted so the drain can reciprocate a friend-confirm.
    expect(native.settingsSet).toHaveBeenCalledWith('identity.handle', 'Word#1234');
  });

  it('passes an explicit TTL through', async () => {
    native.relayInviteMint.mockResolvedValue(1);
    native.relayMyDirectoryKeys.mockResolvedValue({ identity_pub: 'a', sealing_pub: 'b' });
    await createFriendInvite({ handle: 'W#1', relayUrl: 'u', relayFp: 'f', expiresInSec: 3600 });
    expect(native.relayInviteMint.mock.calls[0][1]).toBe(3600);
  });
});

describe('redeemFriendInvite', () => {
  it('seals a friend-accept to the inviter and drops it via the capability', async () => {
    const invite = buildInvite({
      relayUrl: 'https://relay.example',
      relayFp: 'FP',
      token: 'TOK',
      handle: 'Inviter#0001',
      identityPub: 'IDPUB',
      sealingPub: 'SEALPUB',
    });
    native.relayMyDirectoryKeys.mockResolvedValue({ identity_pub: 'MYID', sealing_pub: 'MYSEAL' });
    native.envelopeSeal.mockResolvedValue([9, 9, 9]);
    native.relayInviteRedeem.mockResolvedValue(42);

    const res = await redeemFriendInvite(invite, { handle: 'Me#0002', deliveryToken: 'MYDELIV' });
    expect(res).toEqual({ inviterHandle: 'Inviter#0001', relayTs: 42 });

    // Sealed to the inviter's pinned sealing key, kind = friend-accept, and the
    // payload carries my handle + delivery token + sealing key (for reciprocity).
    expect(native.envelopeSeal).toHaveBeenCalledTimes(1);
    const [sealTo, kind, payload] = native.envelopeSeal.mock.calls[0];
    expect(sealTo).toBe('SEALPUB');
    expect(kind).toBe(FRIEND_ACCEPT_KIND);
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(payload as number[])))).toEqual({
      handle: 'Me#0002',
      deliveryToken: 'MYDELIV',
      sealingPub: 'MYSEAL',
    });
    // Dropped via the one-time token + the sealed envelope.
    expect(native.relayInviteRedeem).toHaveBeenCalledWith('TOK', [9, 9, 9]);
  });

  it('rejects a malformed invite before any network call', async () => {
    await expect(redeemFriendInvite('garbage', { handle: 'x', deliveryToken: 'y' })).rejects.toThrow();
    expect(native.envelopeSeal).not.toHaveBeenCalled();
    expect(native.relayInviteRedeem).not.toHaveBeenCalled();
  });
});
