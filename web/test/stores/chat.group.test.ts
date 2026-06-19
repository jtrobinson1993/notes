import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Conversation } from '@notes/shared';
import { generateKeyPair, sealKey } from '../../src/lib/crypto';
import { b64 } from '../../src/lib/b64';
import { generateConversationKey } from '../../src/lib/chatCrypto';

const api = vi.hoisted(() => ({
  conversations: vi.fn(),
  conversationEdit: vi.fn(),
}));
vi.mock('../../src/lib/api', () => ({ api }));
vi.mock('../../src/stores/session', async () => {
  const { generateKeyPair } = await import('../../src/lib/crypto');
  const kp = generateKeyPair();
  return { useSessionStore: () => ({ user: { id: 'me' }, getKeyPair: async () => kp }) };
});

import { useChatStore } from '../../src/stores/chat';
import { useSessionStore } from '../../src/stores/session';

function group(myPub: Uint8Array, sealedKey: Conversation['sealedKey'], over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'g1',
    kind: 'group',
    members: [{ userId: 'me', displayName: 'Me', publicKey: b64(myPub), nameColor: null, linkPreviews: false, role: 'owner' }],
    name: null,
    icon: null,
    sealedKey,
    epoch: 0,
    epochKeys: [{ epoch: 0, sealedKey }],
    myRole: 'owner',
    channels: [],
    lastSeq: 0,
    lastReadSeq: 0,
    createdAt: 0,
    ...over,
  } as Conversation;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

/** Load a single group into a fresh store (so its epoch key is unsealed). */
async function loaded(over: Partial<Conversation> = {}) {
  const kp = await useSessionStore().getKeyPair();
  const key = generateConversationKey();
  const sealed = await sealKey(kp.publicKey, key);
  api.conversations.mockResolvedValue([group(kp.publicKey, sealed, over)]);
  const store = useChatStore();
  await store.loadConversations();
  // conversationEdit echoes back an updated conversation reusing the same key.
  api.conversationEdit.mockImplementation(async (_id: string, body: Partial<Conversation>) =>
    group(kp.publicKey, sealed, { name: body.name ?? null, icon: body.icon ?? null }),
  );
  return { store };
}

describe('chat store — group name', () => {
  it('renameGroup trims and sends the name', async () => {
    const { store } = await loaded();
    await store.renameGroup('g1', '  Squad  ');
    expect(api.conversationEdit).toHaveBeenCalledWith('g1', { name: 'Squad' });
    expect(store.conversations.find((c) => c.id === 'g1')?.name).toBe('Squad');
  });

  it('renameGroup with blank clears the name to null', async () => {
    const { store } = await loaded({ name: 'Old' });
    await store.renameGroup('g1', '   ');
    expect(api.conversationEdit).toHaveBeenCalledWith('g1', { name: null });
  });
});

describe('chat store — group icon', () => {
  it('encrypts the icon under the conv key, sends it, and decrypts it back', async () => {
    const { store } = await loaded();
    const dataUrl = 'data:image/webp;base64,Zm9vYmFy';
    await store.setGroupIcon('g1', dataUrl);
    const body = api.conversationEdit.mock.calls[0]![1] as { icon: { ciphertext: string; epoch: number } };
    expect(body.icon.epoch).toBe(0);
    expect(typeof body.icon.ciphertext).toBe('string');
    await vi.waitFor(() => expect(store.groupIconUrl('g1')).toBe(dataUrl));
  });

  it('setGroupIcon(null) clears the icon', async () => {
    const { store } = await loaded();
    await store.setGroupIcon('g1', null);
    expect(api.conversationEdit).toHaveBeenCalledWith('g1', { icon: null });
    expect(store.groupIconUrl('g1')).toBeNull();
  });
});
