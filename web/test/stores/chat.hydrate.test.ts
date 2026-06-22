import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Conversation, Friend } from '@notes/shared';
import { generateKeyPair, sealKey } from '../../src/lib/crypto';
import { b64 } from '../../src/lib/b64';
import { generateConversationKey } from '../../src/lib/chatCrypto';

const api = vi.hoisted(() => ({
  conversations: vi.fn(),
  conversationCreateDm: vi.fn(),
  conversationMessages: vi.fn().mockResolvedValue([]),
  conversationRead: vi.fn(),
  reactions: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/lib/api', () => ({ api }));

vi.mock('../../src/stores/session', async () => {
  const { generateKeyPair } = await import('../../src/lib/crypto');
  const kp = generateKeyPair();
  return { useSessionStore: () => ({ user: { id: 'me' }, getKeyPair: async () => kp }) };
});

// The profile store is mocked: 'friend' has a decrypted real name, nobody else does.
const profile = vi.hoisted(() => ({
  hydrate: vi.fn().mockResolvedValue(undefined),
  displayNameFor: vi.fn((id: string) => (id === 'friend' ? 'Real Name' : null)),
  myDisplayName: 'Me',
}));
vi.mock('../../src/stores/profile', () => ({ useProfileStore: () => profile }));

import { useChatStore } from '../../src/stores/chat';
import { useSessionStore } from '../../src/stores/session';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  profile.hydrate.mockResolvedValue(undefined);
  profile.displayNameFor.mockImplementation((id: string) => (id === 'friend' ? 'Real Name' : null));
});

/** Flush the not-awaited `void hydrateNames()` fired by upsertConversation. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('openDm hydrates display names', () => {
  it('overlays a contact\'s decrypted real name onto the new DM without a reload', async () => {
    const { publicKey } = await useSessionStore().getKeyPair();
    const convKey = generateConversationKey();
    const sealed = await sealKey(publicKey, convKey);
    const conv: Conversation = {
      id: 'c1',
      kind: 'dm',
      // The server only ever sends handles in displayName.
      members: [
        { userId: 'me', displayName: 'Me#0001', publicKey: b64(publicKey) },
        { userId: 'friend', displayName: 'Greenfinch#2051', publicKey: b64(generateKeyPair().publicKey) },
      ],
      sealedKey: sealed,
      epoch: 0,
      epochKeys: [{ epoch: 0, sealedKey: sealed }],
      managePolicy: 'owner',
      myRole: 'member',
      channels: [],
      lastSeq: 0,
      lastReadSeq: 0,
      createdAt: 0,
    } as Conversation;
    api.conversationCreateDm.mockResolvedValue(conv);

    const friend: Friend = { userId: 'friend', displayName: 'Greenfinch#2051', publicKey: b64(generateKeyPair().publicKey), online: true };
    const store = useChatStore();
    await store.openDm(friend);
    await flush();

    const member = store.conversations.find((c) => c.id === 'c1')!.members.find((m) => m.userId === 'friend')!;
    expect(profile.hydrate).toHaveBeenCalledWith(['friend']);
    expect(member.displayName).toBe('Real Name'); // not the raw handle
  });
});
