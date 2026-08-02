import { describe, expect, it, vi, beforeEach } from 'vitest';

const native = vi.hoisted(() => ({
  relayInviteMint: vi.fn(),
  relayInviteRedeem: vi.fn(),
  relayMyDirectoryKeys: vi.fn(),
  envelopeSeal: vi.fn(),
  settingsSet: vi.fn().mockResolvedValue(undefined),
  settingsGet: vi.fn().mockResolvedValue(null),
  relayRegister: vi.fn(),
  relayConnect: vi.fn(),
  relayDirectoryPublish: vi.fn().mockResolvedValue(undefined),
  relayRegisterVerifier: vi.fn().mockResolvedValue('DELIV'),
  relayRegisterFriendAccept: vi.fn().mockResolvedValue(true),
  accountSetLabel: vi.fn().mockResolvedValue(undefined),
  isNative: false,
}));
vi.mock('../../src/lib/native', () => native);

import {
  createFriendInvite,
  redeemFriendInvite,
  registerViaInvite,
  FRIEND_ACCEPT_KIND,
} from '../../src/lib/nativeInvites';
import { parseInvite, inviteTokenHash, buildInvite } from '../../src/lib/invites';
import { errorMessage } from '../../src/lib/errors';
import { resetToasts, toasts } from '../../src/lib/toast';

beforeEach(() => {
  vi.clearAllMocks();
  resetToasts();
});

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
    // Dropped via the one-time token + the sealed envelope, and the invite's
    // TOFU pin rides along so the core can check it against the KT log before
    // the envelope (which carries my delivery token) is sent — together with the
    // invite's relay fingerprint, so the core can first confirm that log belongs
    // to the relay the invite named.
    expect(native.relayInviteRedeem).toHaveBeenCalledWith('TOK', [9, 9, 9], 'Inviter#0001', 'IDPUB', 'FP');
  });

  it('surfaces a relay-identity mismatch as the catalogued error', async () => {
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
    // The core refuses: the invite names a relay identity this device is not
    // connected to, so its transparency log proves nothing about the inviter.
    native.relayInviteRedeem.mockRejectedValue('RELAY_IDENTITY_CHANGED: expected relay FP, got OTHER');

    await expect(redeemFriendInvite(invite, { handle: 'Me#0002', deliveryToken: 'MYDELIV' })).rejects.toThrow(
      errorMessage('RELAY_IDENTITY_CHANGED'),
    );
    expect(toasts.value.at(-1)).toMatchObject({ kind: 'error', code: 'RELAY_IDENTITY_CHANGED' });
  });

  it('surfaces a KT mismatch as the catalogued error and adds nobody', async () => {
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
    // The core fails closed: the log publishes a different key for that handle.
    native.relayInviteRedeem.mockRejectedValue('KT_CONTACT_KEY_MISMATCH: key-mismatch');

    await expect(redeemFriendInvite(invite, { handle: 'Me#0002', deliveryToken: 'MYDELIV' })).rejects.toThrow(
      errorMessage('KT_CONTACT_KEY_MISMATCH'),
    );
    // And the user is told, by catalogued code rather than a raw core string.
    expect(toasts.value.at(-1)).toMatchObject({ kind: 'error', code: 'KT_CONTACT_KEY_MISMATCH' });
  });

  it('rejects a malformed invite before any network call', async () => {
    await expect(redeemFriendInvite('garbage', { handle: 'x', deliveryToken: 'y' })).rejects.toThrow();
    expect(native.envelopeSeal).not.toHaveBeenCalled();
    expect(native.relayInviteRedeem).not.toHaveBeenCalled();
  });
});

describe('registerViaInvite', () => {
  const invite = buildInvite({
    relayUrl: 'https://relay.example',
    relayFp: 'INVITE-FP',
    token: 'TOK',
    handle: 'Inviter#0001',
    identityPub: 'IDPUB',
    sealingPub: 'SEALPUB',
  });

  it('anchors the signup on the invite\'s relay fingerprint', async () => {
    native.relayRegister.mockResolvedValue('Me#0002');
    native.relayMyDirectoryKeys.mockResolvedValue({ identity_pub: 'MYID', sealing_pub: 'MYSEAL' });
    native.envelopeSeal.mockResolvedValue([1, 2, 3]);

    const res = await registerViaInvite(invite, { handle: 'Me#0002', displayName: 'Me' });
    expect(res).toEqual({ handle: 'Me#0002', inviterHandle: 'Inviter#0001' });
    // The fingerprint from the invite — the one anchor the relay did not supply
    // — is handed to the core, which refuses a relay that does not match it.
    expect(native.relayRegister).toHaveBeenCalledWith(
      'https://relay.example',
      'TOK',
      'Me#0002',
      'INVITE-FP',
    );
  });

  it('keeps the anchor on the already-enrolled recovery path', async () => {
    native.relayRegister.mockRejectedValue(new Error('device already registered'));
    native.settingsGet.mockResolvedValue('Me#0002');
    native.relayConnect.mockResolvedValue(undefined);
    native.relayMyDirectoryKeys.mockResolvedValue({ identity_pub: 'MYID', sealing_pub: 'MYSEAL' });
    native.envelopeSeal.mockResolvedValue([1, 2, 3]);

    await registerViaInvite(invite);
    // Recovering an enrolled device must not drop back to trust-on-first-use.
    expect(native.relayConnect).toHaveBeenCalledWith('https://relay.example', 'INVITE-FP');
  });

  it('refuses to onboard against a relay whose identity the core rejected', async () => {
    // The core refuses before the account exists: the relay at the invite's URL
    // is not the relay the invite named.
    native.relayRegister.mockRejectedValue('RELAY_IDENTITY_CHANGED: expected relay INVITE-FP, got X');

    await expect(registerViaInvite(invite)).rejects.toThrow(errorMessage('RELAY_IDENTITY_CHANGED'));
    expect(toasts.value.at(-1)).toMatchObject({ kind: 'error', code: 'RELAY_IDENTITY_CHANGED' });
    // Never treated as the recoverable "already enrolled" case.
    expect(native.relayConnect).not.toHaveBeenCalled();
    expect(native.settingsSet).not.toHaveBeenCalled();
  });

  it('refuses a relay whose fingerprint does not bind its key', async () => {
    native.relayRegister.mockRejectedValue(
      'RELAY_IDENTITY_INVALID: the relay\'s fingerprint is not the digest of the identity key it serves',
    );
    await expect(registerViaInvite(invite)).rejects.toThrow(errorMessage('RELAY_IDENTITY_INVALID'));
    expect(toasts.value.at(-1)).toMatchObject({ kind: 'error', code: 'RELAY_IDENTITY_INVALID' });
  });
});
