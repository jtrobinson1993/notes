import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ChatMessage, Conversation, Friend } from '@notes/shared';
import { generateKeyPair, sealKey } from '../../src/lib/crypto';
import { b64 } from '../../src/lib/b64';
import { decryptMessage, encryptMessage, generateConversationKey } from '../../src/lib/chatCrypto';

// The api surface the chat store touches, hoisted so the mock factory can see it.
const api = vi.hoisted(() => ({
  conversations: vi.fn(),
  conversationCreateDm: vi.fn(),
  conversationMessages: vi.fn(),
  messageSend: vi.fn(),
  conversationRead: vi.fn(),
}));
vi.mock('../../src/lib/api', () => ({ api }));

// A stable in-memory keypair stands in for the unlocked session.
vi.mock('../../src/stores/session', async () => {
  const { generateKeyPair } = await import('../../src/lib/crypto');
  const kp = generateKeyPair();
  return {
    useSessionStore: () => ({
      user: { id: 'me' },
      getKeyPair: async () => kp,
    }),
  };
});

import { useChatStore } from '../../src/stores/chat';
import { useSessionStore } from '../../src/stores/session';
import { customEmoji } from '../../src/lib/emoji/custom';

async function myKeyPair() {
  return useSessionStore().getKeyPair();
}

function convTo(myPub: Uint8Array, sealedKey: Conversation['sealedKey'], over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    kind: 'dm',
    members: [
      { userId: 'me', displayName: 'Me', publicKey: b64(myPub) },
      { userId: 'friend', displayName: 'Friend', publicKey: b64(generateKeyPair().publicKey) },
    ],
    sealedKey,
    epoch: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    createdAt: 0,
    ...over,
  };
}

function msg(over: Partial<ChatMessage>): ChatMessage {
  return { conversationId: 'c1', seq: 1, senderId: 'friend', epoch: 0, ciphertext: '', iv: '', createdAt: 0, ...over };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('openDm', () => {
  it('derives the conversation key from the SERVER-returned sealedKey, not the local one', async () => {
    const kp = await myKeyPair();
    // The server's authoritative key — different from whatever the store generates.
    const serverKey = generateConversationKey();
    const sealed = await sealKey(kp.publicKey, serverKey);
    const enc = await encryptMessage(serverKey, { text: 'authoritative', sentAt: 1 });

    api.conversationCreateDm.mockResolvedValue(convTo(kp.publicKey, sealed, { lastSeq: 1 }));
    api.conversationMessages.mockResolvedValue([msg({ seq: 1, ciphertext: enc.ciphertext, iv: enc.iv })]);

    const friend: Friend = { userId: 'friend', displayName: 'Friend', publicKey: b64(generateKeyPair().publicKey), online: true };
    const store = useChatStore();
    const id = await store.openDm(friend);

    expect(id).toBe('c1');
    // Decryptable only if the store kept the server key. The locally generated
    // key would yield text:null here.
    expect(store.messages['c1']?.[0]?.text).toBe('authoritative');
  });

  it('reuses an existing in-memory DM without re-creating it', async () => {
    const kp = await myKeyPair();
    const serverKey = generateConversationKey();
    api.conversationCreateDm.mockResolvedValue(convTo(kp.publicKey, await sealKey(kp.publicKey, serverKey)));
    api.conversationMessages.mockResolvedValue([]);
    const friend: Friend = { userId: 'friend', displayName: 'Friend', publicKey: b64(generateKeyPair().publicKey), online: true };

    const store = useChatStore();
    await store.openDm(friend);
    await store.openDm(friend);
    expect(api.conversationCreateDm).toHaveBeenCalledTimes(1);
  });
});

describe('sendMessage', () => {
  it('optimistically appends, and a WS echo of the same seq dedupes', async () => {
    const kp = await myKeyPair();
    const serverKey = generateConversationKey();
    api.conversationCreateDm.mockResolvedValue(convTo(kp.publicKey, await sealKey(kp.publicKey, serverKey), { lastSeq: 0 }));
    api.conversationMessages.mockResolvedValue([]);
    const friend: Friend = { userId: 'friend', displayName: 'Friend', publicKey: b64(generateKeyPair().publicKey), online: true };

    const store = useChatStore();
    await store.openDm(friend);

    api.messageSend.mockResolvedValue(msg({ seq: 1, senderId: 'me' }));
    await store.sendMessage('c1', 'hello');
    expect(store.messages['c1']?.find((m) => m.seq === 1)?.text).toBe('hello');

    // WS echo of the same message (same seq) must not duplicate it.
    const echo = await encryptMessage(serverKey, { text: 'hello', sentAt: 2 });
    await store.handleFrame({ type: 'message', message: msg({ seq: 1, senderId: 'me', ciphertext: echo.ciphertext, iv: echo.iv }) });
    expect(store.messages['c1']?.filter((m) => m.seq === 1)).toHaveLength(1);
  });

  it('embeds a GIF inside the encrypted payload and the optimistic view', async () => {
    const kp = await myKeyPair();
    const serverKey = generateConversationKey();
    api.conversationCreateDm.mockResolvedValue(convTo(kp.publicKey, await sealKey(kp.publicKey, serverKey), { lastSeq: 0 }));
    api.conversationMessages.mockResolvedValue([]);
    const friend: Friend = { userId: 'friend', displayName: 'Friend', publicKey: b64(generateKeyPair().publicKey), online: true };
    const store = useChatStore();
    await store.openDm(friend);

    const gif = { provider: 'klipy' as const, id: '42', url: 'https://cdn/x.webp', previewUrl: 'https://cdn/p.webp', width: 100, height: 80, title: 'Cat' };
    api.messageSend.mockResolvedValue(msg({ seq: 1, senderId: 'me' }));
    await store.sendMessage('c1', '', { gif });

    // Optimistic view carries the GIF.
    expect(store.messages['c1']?.find((m) => m.seq === 1)?.gif).toEqual(gif);

    // The GIF is inside the encrypted blob (server never sees it in the clear).
    const sentArg = api.messageSend.mock.calls[0][1] as { ciphertext: string; iv: string };
    const payload = await decryptMessage(serverKey, sentArg.ciphertext, sentArg.iv);
    expect(payload.gif).toEqual(gif);
  });

  it('embeds attachments inside the encrypted payload and the optimistic view', async () => {
    const kp = await myKeyPair();
    const serverKey = generateConversationKey();
    api.conversationCreateDm.mockResolvedValue(convTo(kp.publicKey, await sealKey(kp.publicKey, serverKey), { lastSeq: 0 }));
    api.conversationMessages.mockResolvedValue([]);
    const friend: Friend = { userId: 'friend', displayName: 'Friend', publicKey: b64(generateKeyPair().publicKey), online: true };
    const store = useChatStore();
    await store.openDm(friend);

    const att = { id: 'a1', name: 'cat.png', type: 'image/png', size: 12, key: 'AAAA', iv: 'BBBB' };
    api.messageSend.mockResolvedValue(msg({ seq: 1, senderId: 'me' }));
    await store.sendMessage('c1', 'look', { attachments: [att] });

    expect(store.messages['c1']?.find((m) => m.seq === 1)?.attachments).toEqual([att]);
    const sentArg = api.messageSend.mock.calls[0][1] as { ciphertext: string; iv: string };
    const payload = await decryptMessage(serverKey, sentArg.ciphertext, sentArg.iv);
    expect(payload.attachments).toEqual([att]);
  });

  it('embeds used custom emoji refs in the encrypted payload', async () => {
    const kp = await myKeyPair();
    const serverKey = generateConversationKey();
    api.conversationCreateDm.mockResolvedValue(convTo(kp.publicKey, await sealKey(kp.publicKey, serverKey), { lastSeq: 0 }));
    api.conversationMessages.mockResolvedValue([]);
    const friend: Friend = { userId: 'friend', displayName: 'Friend', publicKey: b64(generateKeyPair().publicKey), online: true };
    const store = useChatStore();
    await store.openDm(friend);

    const ref = { id: 'x', name: 'foo', type: 'image/png', size: 1, key: 'AAAA', iv: 'BBBB' };
    customEmoji.items = [{ name: 'foo', ref }];
    api.messageSend.mockResolvedValue(msg({ seq: 1, senderId: 'me' }));
    await store.sendMessage('c1', 'hi :foo: but not :bar:');
    customEmoji.items = [];

    const sentArg = api.messageSend.mock.calls[0][1] as { ciphertext: string; iv: string };
    const payload = await decryptMessage(serverKey, sentArg.ciphertext, sentArg.iv);
    expect(payload.customEmoji).toEqual({ foo: ref });
  });

  it('embeds a reply snapshot in the encrypted payload and the view', async () => {
    const kp = await myKeyPair();
    const serverKey = generateConversationKey();
    api.conversationCreateDm.mockResolvedValue(convTo(kp.publicKey, await sealKey(kp.publicKey, serverKey), { lastSeq: 0 }));
    api.conversationMessages.mockResolvedValue([]);
    const friend: Friend = { userId: 'friend', displayName: 'Friend', publicKey: b64(generateKeyPair().publicKey), online: true };
    const store = useChatStore();
    await store.openDm(friend);

    const replyTo = { seq: 3, senderId: 'friend', preview: 'earlier message' };
    api.messageSend.mockResolvedValue(msg({ seq: 4, senderId: 'me' }));
    await store.sendMessage('c1', 'replying', { replyTo });

    expect(store.messages['c1']?.find((m) => m.seq === 4)?.replyTo).toEqual(replyTo);
    const sentArg = api.messageSend.mock.calls[0][1] as { ciphertext: string; iv: string };
    const payload = await decryptMessage(serverKey, sentArg.ciphertext, sentArg.iv);
    expect(payload.replyTo).toEqual(replyTo);
  });

  it('drops a non-KLIPY gif url on inbound decrypt (anti-IP-harvest) but keeps a KLIPY one', async () => {
    const kp = await myKeyPair();
    const serverKey = generateConversationKey();
    api.conversations.mockResolvedValue([convTo(kp.publicKey, await sealKey(kp.publicKey, serverKey))]);
    const store = useChatStore();
    await store.loadConversations();

    const evil = { provider: 'klipy' as const, id: '1', url: 'https://evil.example/track.gif', previewUrl: 'https://evil.example/p.gif', width: 1, height: 1 };
    const good = { provider: 'klipy' as const, id: '2', url: 'https://static.klipy.com/x.webp', previewUrl: 'https://static.klipy.com/p.webp', width: 10, height: 10 };
    const e1 = await encryptMessage(serverKey, { text: '', sentAt: 1, gif: evil });
    const e2 = await encryptMessage(serverKey, { text: '', sentAt: 2, gif: good });
    await store.handleFrame({ type: 'message', message: msg({ seq: 1, ciphertext: e1.ciphertext, iv: e1.iv }) });
    await store.handleFrame({ type: 'message', message: msg({ seq: 2, ciphertext: e2.ciphertext, iv: e2.iv }) });

    expect(store.messages['c1']?.find((m) => m.seq === 1)?.gif).toBeNull();
    expect(store.messages['c1']?.find((m) => m.seq === 2)?.gif).toEqual(good);
  });
});

describe('handleFrame: inbound message for an unknown conversation', () => {
  it('loads conversations to obtain the key, then surfaces the decrypted message', async () => {
    const kp = await myKeyPair();
    const serverKey = generateConversationKey();
    const sealed = await sealKey(kp.publicKey, serverKey);
    const enc = await encryptMessage(serverKey, { text: 'surprise', sentAt: 1 });

    // The store has no key for c1 yet; the frame should trigger loadConversations.
    api.conversations.mockResolvedValue([convTo(kp.publicKey, sealed, { lastSeq: 1 })]);

    const store = useChatStore();
    expect(store.conversations).toHaveLength(0);
    await store.handleFrame({ type: 'message', message: msg({ seq: 1, ciphertext: enc.ciphertext, iv: enc.iv }) });

    expect(api.conversations).toHaveBeenCalledTimes(1);
    expect(store.conversations.map((c) => c.id)).toContain('c1');
    expect(store.messages['c1']?.[0]?.text).toBe('surprise');
  });
});

describe('markRead + unreadCount', () => {
  it('unreadCount = lastSeq - lastReadSeq, floored at 0', () => {
    const store = useChatStore();
    store.conversations = [convTo(new Uint8Array(32), { epk: '', iv: '', ct: '' }, { lastSeq: 5, lastReadSeq: 2 })];
    expect(store.unreadCount('c1')).toBe(3);
    store.conversations = [{ ...store.conversations[0]!, lastReadSeq: 9 }];
    expect(store.unreadCount('c1')).toBe(0);
  });

  it('markRead advances forward but never moves the marker backward', async () => {
    api.conversationRead.mockResolvedValue(undefined);
    const store = useChatStore();
    store.conversations = [convTo(new Uint8Array(32), { epk: '', iv: '', ct: '' }, { lastSeq: 10, lastReadSeq: 3 })];

    await store.markRead('c1', 6);
    expect(store.conversations[0]!.lastReadSeq).toBe(6);
    await store.markRead('c1', 4); // backward → ignored
    expect(store.conversations[0]!.lastReadSeq).toBe(6);
  });
});
