import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ChatMessage, Conversation } from '@notes/shared';
import { generateKeyPair, sealKey } from '../../src/lib/crypto';
import { b64 } from '../../src/lib/b64';
import { encryptMessage, generateConversationKey } from '../../src/lib/chatCrypto';

const api = vi.hoisted(() => ({
  conversations: vi.fn(),
  conversationCreateDm: vi.fn(),
  conversationMessages: vi.fn(),
  messageSend: vi.fn(),
  conversationRead: vi.fn(),
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

function conv(myPub: Uint8Array, sealedKey: Conversation['sealedKey'], over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1', kind: 'dm',
    members: [
      { userId: 'me', displayName: 'Me', publicKey: b64(myPub) },
      { userId: 'friend', displayName: 'Friend', publicKey: b64(generateKeyPair().publicKey) },
    ],
    sealedKey, epoch: 0, epochKeys: [{ epoch: 0, sealedKey }], managePolicy: 'owner', myRole: 'member',
    lastSeq: 0, lastReadSeq: 0, createdAt: 0, ...over,
  };
}
function msg(over: Partial<ChatMessage>): ChatMessage {
  return { conversationId: 'c1', seq: 1, senderId: 'friend', epoch: 0, ciphertext: '', iv: '', createdAt: 0, ...over };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('loadConversations + loadHistory', () => {
  it('loads conversations, then decrypts fetched history into the store', async () => {
    const kp = await myKeyPair();
    const key = generateConversationKey();
    const enc = await encryptMessage(key, { text: 'hello there', sentAt: 1 });
    api.conversations.mockResolvedValue([conv(kp.publicKey, await sealKey(kp.publicKey, key), { lastSeq: 1 })]);
    api.conversationMessages.mockResolvedValue([msg({ seq: 1, ciphertext: enc.ciphertext, iv: enc.iv })]);

    const store = useChatStore();
    await store.loadConversations();
    expect(store.conversations.map((c) => c.id)).toEqual(['c1']);

    const count = await store.loadHistory('c1');
    expect(api.conversationMessages).toHaveBeenCalledWith('c1', { before: undefined, limit: 50 });
    expect(store.messages['c1']?.[0]?.text).toBe('hello there');
    // The fetched count drives the view's "reached start of history" detection.
    expect(count).toBe(1);
  });

  it('loadHistory passes the before cursor for older pages and returns the count', async () => {
    const kp = await myKeyPair();
    api.conversations.mockResolvedValue([conv(kp.publicKey, await sealKey(kp.publicKey, generateConversationKey()))]);
    api.conversationMessages.mockResolvedValue([]);
    const store = useChatStore();
    await store.loadConversations();
    const count = await store.loadHistory('c1', 10);
    expect(api.conversationMessages).toHaveBeenCalledWith('c1', { before: 10, limit: 50 });
    expect(count).toBe(0);
  });
});

describe('handleFrame: read receipts', () => {
  it('advances my own read baseline, ignores other users’ read frames', async () => {
    const store = useChatStore();
    store.conversations = [conv(new Uint8Array(32), { epk: '', iv: '', ct: '' }, { lastSeq: 9, lastReadSeq: 2 })];

    await store.handleFrame({ type: 'read', conversationId: 'c1', userId: 'friend', seq: 8 });
    expect(store.conversations[0]!.lastReadSeq).toBe(2); // other user → no change

    await store.handleFrame({ type: 'read', conversationId: 'c1', userId: 'me', seq: 7 });
    expect(store.conversations[0]!.lastReadSeq).toBe(7); // my own read advances

    await store.handleFrame({ type: 'read', conversationId: 'c1', userId: 'me', seq: 4 });
    expect(store.conversations[0]!.lastReadSeq).toBe(7); // never moves backward
  });
});

describe('reset', () => {
  it('clears conversations, messages, and active id', () => {
    const store = useChatStore();
    store.conversations = [conv(new Uint8Array(32), { epk: '', iv: '', ct: '' })];
    store.messages = { c1: [{ ...msg({ seq: 1 }), text: 'x' }] };
    store.setActive('c1');
    expect(store.activeId).toBe('c1');

    store.reset();
    expect(store.conversations).toEqual([]);
    expect(store.messages).toEqual({});
    expect(store.activeId).toBeNull();
  });
});
