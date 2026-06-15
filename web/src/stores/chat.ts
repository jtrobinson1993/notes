import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  AttachmentRef,
  ChatMessage,
  ChatReaction,
  Conversation,
  Friend,
  GifRef,
  MessagePayload,
  ReplyRef,
  SealedMemberKey,
  ServerFrame,
} from '@notes/shared';
import { api } from '../lib/api';
import {
  decryptMessage,
  decryptReaction,
  encryptMessage,
  encryptReaction,
  generateConversationKey,
  sealConversationKey,
  unsealConversationKey,
} from '../lib/chatCrypto';
import { connectChatSocket, disconnectChatSocket, onConnect } from '../lib/chatSocket';
import { customEmojiForText, loadCustomEmoji, registerEmbeddedEmoji, resetCustomEmoji } from '../lib/emoji/custom';
import { b64 } from '../lib/b64';
import { useSessionStore } from './session';
import { useFriendsStore } from './friends';

/** Client-only view of a message: `text` is null when decryption failed.
 *  `gif`/`attachments` are decrypted embeds, if any. */
export interface ChatMessageView extends ChatMessage {
  text: string | null;
  gif?: GifRef | null;
  attachments?: AttachmentRef[];
  replyTo?: ReplyRef;
}

/** A reaction with its decrypted emoji (null if it couldn't be decrypted). */
export interface ChatReactionView extends ChatReaction {
  emoji: string | null;
}

const HISTORY_LIMIT = 50;

// A GIF's media URL is sender-controlled, so a hostile sender could embed an
// arbitrary tracking URL the recipient's client would eager-load (IP leak),
// bypassing the click-to-load model for remote media (see spec/security.md).
// Only render GIFs whose media lives on KLIPY's CDN — bounding the third-party
// leak to the one provider we already accept.
function safeGif(gif: GifRef | undefined): GifRef | null {
  if (!gif) return null;
  try {
    const u = new URL(gif.url);
    const pu = new URL(gif.previewUrl);
    const ok = (h: string) => h === 'klipy.com' || h.endsWith('.klipy.com');
    if (u.protocol === 'https:' && pu.protocol === 'https:' && ok(u.hostname) && ok(pu.hostname)) return gif;
  } catch {
    /* malformed URL → drop */
  }
  return null;
}

export const useChatStore = defineStore('chat', () => {
  const session = useSessionStore();

  const conversations = ref<Conversation[]>([]);
  const messages = ref<Record<string, ChatMessageView[]>>({});
  const reactions = ref<Record<string, ChatReactionView[]>>({});
  const activeId = ref<string | null>(null);

  // Unsealed conversation keys; in-memory only (never persisted).
  const convKeys = new Map<string, Uint8Array>();

  function setActive(convId: string | null): void {
    activeId.value = convId;
  }

  async function decryptOne(convId: string, m: ChatMessage): Promise<ChatMessageView> {
    const key = convKeys.get(convId);
    if (!key) return { ...m, text: null };
    try {
      const payload = await decryptMessage(key, m.ciphertext, m.iv);
      // Register any embedded custom emoji before the view is shown, so the
      // first render of this message already resolves its :shortcodes:.
      if (payload.customEmoji) await registerEmbeddedEmoji(payload.customEmoji);
      return {
        ...m,
        text: payload.text,
        gif: safeGif(payload.gif),
        attachments: payload.attachments ?? [],
        replyTo: payload.replyTo,
      };
    } catch {
      return { ...m, text: null };
    }
  }

  /** Merge views into a conversation, keeping ascending seq order and deduping. */
  function mergeMessages(convId: string, views: ChatMessageView[]): void {
    const existing = messages.value[convId] ?? [];
    const bySeq = new Map<number, ChatMessageView>();
    for (const v of existing) bySeq.set(v.seq, v);
    for (const v of views) bySeq.set(v.seq, v);
    messages.value = {
      ...messages.value,
      [convId]: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    };
  }

  function upsertConversation(conv: Conversation): void {
    const idx = conversations.value.findIndex((c) => c.id === conv.id);
    if (idx >= 0) conversations.value[idx] = conv;
    else conversations.value = [...conversations.value, conv];
  }

  async function loadConversations(): Promise<void> {
    const { privateKey, publicKey } = await session.getKeyPair();
    const list = await api.conversations();
    conversations.value = list;
    for (const conv of list) {
      if (convKeys.has(conv.id)) continue;
      try {
        convKeys.set(conv.id, await unsealConversationKey(conv.sealedKey, privateKey, publicKey));
      } catch {
        // Can't unseal (e.g. epoch mismatch); messages will show as undecryptable.
      }
    }
  }

  /** Open (or create) a 1:1 DM with a friend; returns the conversation id. */
  async function openDm(friend: Friend): Promise<string> {
    const existing = conversations.value.find(
      (c) => c.kind === 'dm' && c.members.some((m) => m.userId === friend.userId),
    );
    if (existing) {
      setActive(existing.id);
      await loadHistory(existing.id);
      return existing.id;
    }

    if (!friend.publicKey) throw new Error('friend has no public key');
    const { privateKey, publicKey } = await session.getKeyPair();
    const me = session.user;
    if (!me) throw new Error('not logged in');

    const convKey = generateConversationKey();
    const myPublicKeyB64 = b64(publicKey);
    const members: SealedMemberKey[] = [
      { userId: me.id, sealedKey: await sealConversationKey(myPublicKeyB64, convKey) },
      { userId: friend.userId, sealedKey: await sealConversationKey(friend.publicKey, convKey) },
    ];
    // The create endpoint is idempotent: if a DM already exists the server
    // returns it and ignores our keys. Always derive the in-memory key from the
    // conversation the server returns (its sealedKey is the authoritative one),
    // never the key we just generated.
    const conv = await api.conversationCreateDm(friend.userId, members);
    convKeys.set(conv.id, await unsealConversationKey(conv.sealedKey, privateKey, publicKey));
    upsertConversation(conv);
    setActive(conv.id);
    await loadHistory(conv.id);
    return conv.id;
  }

  /** Create a group conversation with 2+ friends; returns its id. The group key
   *  is sealed to me + every selected friend, reusing the conv-key machinery. */
  async function openGroup(selected: Friend[]): Promise<string> {
    const { privateKey, publicKey } = await session.getKeyPair();
    const me = session.user;
    if (!me) throw new Error('not logged in');
    if (selected.length < 2) throw new Error('a group needs at least two friends');

    const convKey = generateConversationKey();
    const members: SealedMemberKey[] = [
      { userId: me.id, sealedKey: await sealConversationKey(b64(publicKey), convKey) },
    ];
    for (const f of selected) {
      if (!f.publicKey) throw new Error(`${f.displayName} has no public key`);
      members.push({ userId: f.userId, sealedKey: await sealConversationKey(f.publicKey, convKey) });
    }
    const conv = await api.conversationCreateGroup(members);
    convKeys.set(conv.id, await unsealConversationKey(conv.sealedKey, privateKey, publicKey));
    upsertConversation(conv);
    setActive(conv.id);
    await loadHistory(conv.id);
    return conv.id;
  }

  /** The thread rooted on a parent message, if one exists in memory. */
  function threadFor(parentConvId: string, seq: number): Conversation | undefined {
    return conversations.value.find(
      (c) => c.kind === 'thread' && c.parentId === parentConvId && c.parentSeq === seq,
    );
  }

  /** Open (or create) the thread on a parent message; returns its conversation
   *  id. The thread key is sealed to ALL parent members, reusing the conv-key
   *  machinery. */
  async function openThread(parentConvId: string, seq: number): Promise<string> {
    const existing = threadFor(parentConvId, seq);
    if (existing) return existing.id;
    const parent = conversations.value.find((c) => c.id === parentConvId);
    if (!parent) throw new Error('unknown conversation');
    const { privateKey, publicKey } = await session.getKeyPair();
    const convKey = generateConversationKey();
    const members: SealedMemberKey[] = [];
    for (const m of parent.members) {
      if (!m.publicKey) throw new Error('member missing public key');
      members.push({ userId: m.userId, sealedKey: await sealConversationKey(m.publicKey, convKey) });
    }
    // Idempotent server-side: an existing thread's sealedKey is authoritative.
    const thread = await api.threadCreate(parentConvId, seq, members);
    convKeys.set(thread.id, await unsealConversationKey(thread.sealedKey, privateKey, publicKey));
    upsertConversation(thread);
    return thread.id;
  }

  /** Fetch (older, when `before` is set) history and merge decrypted views. */
  async function loadHistory(convId: string, before?: number): Promise<void> {
    const raw = await api.conversationMessages(convId, { before, limit: HISTORY_LIMIT });
    const views = await Promise.all(raw.map((m) => decryptOne(convId, m)));
    mergeMessages(convId, views);
  }

  async function sendMessage(
    convId: string,
    text: string,
    opts?: { gif?: GifRef; attachments?: AttachmentRef[]; replyTo?: ReplyRef },
  ): Promise<void> {
    const key = convKeys.get(convId);
    if (!key) throw new Error('no conversation key');
    const conv = conversations.value.find((c) => c.id === convId);
    const epoch = conv?.epoch ?? 0;
    const payload: MessagePayload = { text, sentAt: Date.now() };
    if (opts?.gif) payload.gif = opts.gif;
    if (opts?.attachments?.length) payload.attachments = opts.attachments;
    if (opts?.replyTo) payload.replyTo = opts.replyTo;
    const usedEmoji = customEmojiForText(text);
    if (usedEmoji) payload.customEmoji = usedEmoji;
    const { ciphertext, iv } = await encryptMessage(key, payload);
    const sent = await api.messageSend(convId, { ciphertext, iv, epoch });
    mergeMessages(convId, [
      { ...sent, text, gif: opts?.gif ?? null, attachments: opts?.attachments ?? [], replyTo: opts?.replyTo },
    ]);
    bumpLastSeq(convId, sent.seq);
  }

  async function decryptReactionOne(convId: string, r: ChatReaction): Promise<ChatReactionView> {
    const key = convKeys.get(convId);
    if (!key) return { ...r, emoji: null };
    try {
      return { ...r, emoji: await decryptReaction(key, r.ciphertext, r.iv) };
    } catch {
      return { ...r, emoji: null };
    }
  }

  function upsertReaction(convId: string, view: ChatReactionView): void {
    const list = reactions.value[convId] ?? [];
    if (list.some((r) => r.id === view.id)) return; // dedupe self-echo / refetch
    reactions.value = { ...reactions.value, [convId]: [...list, view] };
  }

  function dropReaction(convId: string, id: string): void {
    const list = reactions.value[convId];
    if (!list) return;
    reactions.value = { ...reactions.value, [convId]: list.filter((r) => r.id !== id) };
  }

  async function loadReactions(convId: string): Promise<void> {
    const raw = await api.reactions(convId);
    reactions.value = { ...reactions.value, [convId]: await Promise.all(raw.map((r) => decryptReactionOne(convId, r))) };
  }

  /** Toggle my reaction with `emoji` on a message: remove it if I already have
   *  one, otherwise add it. */
  async function toggleReaction(convId: string, seq: number, emoji: string): Promise<void> {
    const key = convKeys.get(convId);
    if (!key) return;
    const me = session.user?.id;
    const mine = (reactions.value[convId] ?? []).find((r) => r.seq === seq && r.userId === me && r.emoji === emoji);
    if (mine) {
      dropReaction(convId, mine.id);
      await api.reactionRemove(convId, mine.id);
      return;
    }
    const { ciphertext, iv } = await encryptReaction(key, emoji);
    const created = await api.reactionAdd(convId, seq, { ciphertext, iv });
    upsertReaction(convId, { ...created, emoji });
  }

  async function markRead(convId: string, seq: number): Promise<void> {
    await api.conversationRead(convId, seq);
    const idx = conversations.value.findIndex((c) => c.id === convId);
    const conv = conversations.value[idx];
    if (conv && seq > conv.lastReadSeq) {
      conversations.value[idx] = { ...conv, lastReadSeq: seq };
    }
  }

  function bumpLastSeq(convId: string, seq: number): void {
    const idx = conversations.value.findIndex((c) => c.id === convId);
    const conv = conversations.value[idx];
    if (conv && seq > conv.lastSeq) {
      conversations.value[idx] = { ...conv, lastSeq: seq };
    }
  }

  async function handleFrame(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case 'message': {
        const m = frame.message;
        // First contact with a conversation we don't have yet (e.g. a friend's
        // opening DM): fetch it so we hold its sealed key before decrypting.
        if (!convKeys.has(m.conversationId)) await loadConversations();
        const view = await decryptOne(m.conversationId, m);
        mergeMessages(m.conversationId, [view]);
        bumpLastSeq(m.conversationId, m.seq);
        break;
      }
      case 'reaction': {
        const r = frame.reaction;
        if (convKeys.has(r.conversationId)) upsertReaction(r.conversationId, await decryptReactionOne(r.conversationId, r));
        break;
      }
      case 'reaction-removed': {
        dropReaction(frame.conversationId, frame.id);
        break;
      }
      case 'read': {
        const idx = conversations.value.findIndex((c) => c.id === frame.conversationId);
        const conv = conversations.value[idx];
        // Only my own read receipts advance my unread baseline.
        if (conv && frame.userId === session.user?.id && frame.seq > conv.lastReadSeq) {
          conversations.value[idx] = { ...conv, lastReadSeq: frame.seq };
        }
        break;
      }
      default:
        break;
    }
  }

  /** Unread = highest seq minus my last-read seq (never negative). */
  function unreadCount(convId: string): number {
    const conv = conversations.value.find((c) => c.id === convId);
    if (!conv) return 0;
    return Math.max(0, conv.lastSeq - conv.lastReadSeq);
  }

  function reset(): void {
    conversations.value = [];
    messages.value = {};
    reactions.value = {};
    activeId.value = null;
    convKeys.clear();
  }

  return {
    conversations,
    messages,
    reactions,
    activeId,
    setActive,
    loadConversations,
    openDm,
    openGroup,
    openThread,
    threadFor,
    loadHistory,
    sendMessage,
    loadReactions,
    toggleReaction,
    markRead,
    handleFrame,
    unreadCount,
    reset,
  };
});

// ---------------------------------------------------------------------------
// Socket wiring: one place that dispatches every server frame to BOTH stores
// and backfills on (re)connect. The app calls startChat() after unlock and
// stopChat() on lock/logout.
// ---------------------------------------------------------------------------

let unsubConnect: (() => void) | null = null;

/** Connect the chat socket, route frames to the chat + friends stores, and
 * backfill (conversations + active history + friends) on every (re)connect. */
export function startChat(): void {
  const chat = useChatStore();
  const friends = useFriendsStore();

  const dispatch = (frame: ServerFrame): void => {
    void chat.handleFrame(frame);
    friends.handleFrame(frame);
  };

  unsubConnect?.();
  unsubConnect = onConnect(() => {
    void (async () => {
      await chat.loadConversations();
      await friends.load();
      void loadCustomEmoji();
      if (chat.activeId) {
        await chat.loadHistory(chat.activeId);
        await chat.loadReactions(chat.activeId);
      }
    })();
  });

  connectChatSocket(dispatch);
}

/** Disconnect the socket and clear in-memory chat state. */
export function stopChat(): void {
  unsubConnect?.();
  unsubConnect = null;
  disconnectChatSocket();
  resetCustomEmoji();
  useChatStore().reset();
}
