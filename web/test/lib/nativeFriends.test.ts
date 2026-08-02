import { describe, expect, it, vi, beforeEach } from 'vitest';

const native = vi.hoisted(() => ({
  relayRegisterVerifier: vi.fn(),
  relayStatus: vi.fn(),
  settingsGet: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

const invites = vi.hoisted(() => ({
  createFriendInvite: vi.fn(),
  redeemFriendInvite: vi.fn(),
}));
vi.mock('../../src/lib/nativeInvites', () => invites);

import { createInvite, redeemInvite } from '../../src/lib/nativeFriends';

beforeEach(() => vi.clearAllMocks());

describe('createInvite', () => {
  it('registers my verifier then assembles the invite from handle + relay', async () => {
    native.settingsGet.mockResolvedValue('Word#1234');
    native.relayStatus.mockResolvedValue({ connected: true, base_url: 'https://r.example', relay_fp: 'FP' });
    native.relayRegisterVerifier.mockResolvedValue('my-delivery');
    invites.createFriendInvite.mockResolvedValue({ invite: 'accord://friend?i=x', expiresAt: 1 });

    const res = await createInvite(3600);
    expect(native.relayRegisterVerifier).toHaveBeenCalled(); // reachable before inviting
    expect(invites.createFriendInvite).toHaveBeenCalledWith({
      handle: 'Word#1234',
      relayUrl: 'https://r.example',
      relayFp: 'FP',
      expiresInSec: 3600,
    });
    expect(res.invite).toBe('accord://friend?i=x');
  });

  it('errors when no local handle', async () => {
    native.settingsGet.mockResolvedValue(null);
    await expect(createInvite()).rejects.toThrow(/no local handle/);
    expect(invites.createFriendInvite).not.toHaveBeenCalled();
  });

  it('errors when not connected to a relay', async () => {
    native.settingsGet.mockResolvedValue('Word#1234');
    native.relayStatus.mockResolvedValue({ connected: false, base_url: null, relay_fp: null });
    await expect(createInvite()).rejects.toThrow(/not connected/);
    expect(native.relayRegisterVerifier).not.toHaveBeenCalled();
  });
});

describe('redeemInvite', () => {
  it('registers my verifier for reachability, then redeems with my token', async () => {
    native.settingsGet.mockResolvedValue('Me#0002');
    native.relayRegisterVerifier.mockResolvedValue('my-delivery-token');
    invites.redeemFriendInvite.mockResolvedValue({ inviterHandle: 'Inviter#0001', relayTs: 7 });

    const res = await redeemInvite('accord://friend?i=x');
    expect(native.relayRegisterVerifier).toHaveBeenCalled();
    expect(invites.redeemFriendInvite).toHaveBeenCalledWith('accord://friend?i=x', {
      handle: 'Me#0002',
      deliveryToken: 'my-delivery-token',
    });
    expect(res.inviterHandle).toBe('Inviter#0001');
  });

  it('errors when no local handle', async () => {
    native.settingsGet.mockResolvedValue(null);
    await expect(redeemInvite('x')).rejects.toThrow(/no local handle/);
    expect(invites.redeemFriendInvite).not.toHaveBeenCalled();
  });
});
