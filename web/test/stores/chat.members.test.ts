import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Conversation, Friend, SealedKey, SealedMemberKey } from '@notes/shared';
import { generateKeyPair, sealKey, unsealKey } from '../../src/lib/crypto';
import { b64 } from '../../src/lib/b64';
import { decryptMessage, encryptMessage, generateConversationKey } from '../../src/lib/chatCrypto';

const api = vi.hoisted(() => ({
  conversations: vi.fn(),
  conversationAddMember: vi.fn(),
  conversationRemoveMember: vi.fn(),
  conversationSetRole: vi.fn(),
  messageSend: vi.fn().mockImplementation((convId: string, body: unknown) =>
    Promise.resolve({ conversationId: convId, seq: 99, senderId: 'me', epoch: 1, ...(body as object), createdAt: 0 }),
  ),
}));
vi.mock('../../src/lib/api', () => ({ api }));
vi.mock('../../src/stores/session', async () => {
  const { generateKeyPair } = await import('../../src/lib/crypto');
  const kp = generateKeyPair();
  return { useSessionStore: () => ({ user: { id: 'me' }, getKeyPair: async () => kp }) };
});

import { useChatStore } from '../../src/stores/chat';
import { useSessionStore } from '../../src/stores/session';

const myKeyPair = () => useSessionStore().getKeyPair();
const member = (userId: string, publicKey: string) => ({
  userId, displayName: userId, publicKey, nameColor: null, linkPreviews: false, role: 'member' as const,
});

/** A 3-member group whose epoch-0 key is sealed to me. */
async function group(epoch0Key: Uint8Array): Promise<{ conv: Conversation; m2Pub: string; m3Pub: string }> {
  const { publicKey } = await myKeyPair();
  const m2Pub = b64(generateKeyPair().publicKey);
  const m3Pub = b64(generateKeyPair().publicKey);
  const sealed0 = await sealKey(publicKey, epoch0Key);
  return {
    conv: {
      id: 'g1', kind: 'group',
      members: [member('me', b64(publicKey)), member('m2', m2Pub), member('m3', m3Pub)],
      sealedKey: sealed0, epoch: 0, epochKeys: [{ epoch: 0, sealedKey: sealed0 }],
      managePolicy: 'open', myRole: 'owner', lastSeq: 0, lastReadSeq: 0, createdAt: 0,
    },
    m2Pub, m3Pub,
  };
}

const friend = (): Friend => ({ userId: 'f4', displayName: 'F', publicKey: b64(generateKeyPair().publicKey), online: false });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('addMember', () => {
  it('mints a new epoch sealed to everyone, shares prior keys, and decrypts both epochs', async () => {
    const epoch0Key = generateConversationKey();
    const { conv } = await group(epoch0Key);
    api.conversations.mockResolvedValue([conv]);
    const store = useChatStore();
    await store.loadConversations();

    const f = friend();
    // Echo back an updated conversation: my epoch-0 key plus the new epoch-1 key
    // (taken from what the store sealed to me).
    api.conversationAddMember.mockImplementation((_id: string, body: { keys: SealedMemberKey[] }) => {
      const mine = body.keys.find((k) => k.userId === 'me')!.sealedKey;
      return Promise.resolve({
        ...conv, epoch: 1,
        members: [...conv.members, member('f4', f.publicKey!)],
        epochKeys: [{ epoch: 0, sealedKey: conv.sealedKey }, { epoch: 1, sealedKey: mine }],
      });
    });

    await store.addMember('g1', f, 'share');

    const body = api.conversationAddMember.mock.calls[0][1];
    expect(body.userId).toBe('f4');
    expect(body.epoch).toBe(1);
    expect(body.history).toBe('share');
    expect(body.keys.map((k: SealedMemberKey) => k.userId).sort()).toEqual(['f4', 'm2', 'm3', 'me']);
    expect(body.priorKeys.map((k: { epoch: number }) => k.epoch)).toEqual([0]);

    // The store now holds keys for both epochs → messages from either decrypt.
    const { privateKey, publicKey } = await myKeyPair();
    const epoch1Key = await unsealKey(privateKey, publicKey, body.keys.find((k: SealedMemberKey) => k.userId === 'me')!.sealedKey);
    const e0 = await encryptMessage(epoch0Key, { text: 'old', sentAt: 0 });
    const e1 = await encryptMessage(epoch1Key, { text: 'new', sentAt: 0 });
    await store.handleFrame({ type: 'message', message: { conversationId: 'g1', seq: 1, senderId: 'm2', epoch: 0, ciphertext: e0.ciphertext, iv: e0.iv, createdAt: 0 } });
    await store.handleFrame({ type: 'message', message: { conversationId: 'g1', seq: 2, senderId: 'me', epoch: 1, ciphertext: e1.ciphertext, iv: e1.iv, createdAt: 0 } });
    expect(store.messages.g1.filter((m) => !m.system).map((m) => m.text)).toEqual(['old', 'new']);

    // Adding posts an encrypted "X joined" system message at the new epoch.
    const sent = api.messageSend.mock.calls.at(-1)![1] as { ciphertext: string; iv: string; epoch: number };
    expect(sent.epoch).toBe(1);
    const joinPayload = await decryptMessage(epoch1Key, sent.ciphertext, sent.iv);
    expect(joinPayload.system).toMatchObject({ kind: 'member-joined', userId: 'f4' });
    expect(store.messages.g1.some((m) => m.system?.kind === 'member-joined')).toBe(true);
  });

  it('omits priorKeys when starting fresh', async () => {
    const { conv } = await group(generateConversationKey());
    api.conversations.mockResolvedValue([conv]);
    const store = useChatStore();
    await store.loadConversations();
    api.conversationAddMember.mockResolvedValue({ ...conv, epoch: 1 });
    await store.addMember('g1', friend(), 'fresh');
    expect(api.conversationAddMember.mock.calls[0][1].priorKeys).toBeUndefined();
  });
});

describe('removeMember / leave', () => {
  it('re-keys only the remaining members', async () => {
    const { conv } = await group(generateConversationKey());
    api.conversations.mockResolvedValue([conv]);
    const store = useChatStore();
    await store.loadConversations();
    api.conversationRemoveMember.mockResolvedValue({ ok: true });
    api.conversations.mockResolvedValue([{ ...conv, epoch: 1, members: conv.members.filter((m) => m.userId !== 'm3') }]);

    await store.removeMember('g1', 'm3');
    const [, target, body] = api.conversationRemoveMember.mock.calls[0];
    expect(target).toBe('m3');
    expect(body.epoch).toBe(1);
    expect(body.keys.map((k: SealedMemberKey) => k.userId).sort()).toEqual(['m2', 'me']);
  });

  it('drops the conversation locally when I leave', async () => {
    const { conv } = await group(generateConversationKey());
    api.conversations.mockResolvedValue([conv]);
    const store = useChatStore();
    await store.loadConversations();
    store.setActive('g1');
    api.conversationRemoveMember.mockResolvedValue({ ok: true });

    await store.removeMember('g1', 'me');
    expect(store.conversations.find((c) => c.id === 'g1')).toBeUndefined();
    expect(store.activeId).toBeNull();
    expect(api.conversationRemoveMember.mock.calls[0][2].keys.map((k: SealedMemberKey) => k.userId).sort()).toEqual(['m2', 'm3']);
  });

  it('conversation-removed frame forgets the conversation', async () => {
    const { conv } = await group(generateConversationKey());
    api.conversations.mockResolvedValue([conv]);
    const store = useChatStore();
    await store.loadConversations();
    await store.handleFrame({ type: 'conversation-removed', conversationId: 'g1' });
    expect(store.conversations).toHaveLength(0);
  });
});
