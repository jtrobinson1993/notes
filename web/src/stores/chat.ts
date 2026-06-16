import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  AttachmentRef,
  ChatMessage,
  ChatReaction,
  Conversation,
  ConversationRole,
  Friend,
  GifRef,
  LinkPreview,
  ManagePolicy,
  MessagePayload,
  ReplyRef,
  SealedEpochKey,
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
  sealConversationKeyToMembers,
  sealEpochKeysTo,
  unsealConversationKey,
} from '../lib/chatCrypto';
import { connectChatSocket, disconnectChatSocket, onConnect } from '../lib/chatSocket';
import { customEmojiForText, loadCustomEmoji, registerEmbeddedEmoji, resetCustomEmoji } from '../lib/emoji/custom';
import { b64 } from '../lib/b64';
import { useSessionStore } from './session';
import { useFriendsStore } from './friends';
import { useProfileStore } from './profile';

/** Client-only view of a message: `text` is null when decryption failed.
 *  `gif`/`attachments` are decrypted embeds, if any. */
export interface ChatMessageView extends ChatMessage {
  text: string | null;
  gif?: GifRef | null;
  attachments?: AttachmentRef[];
  replyTo?: ReplyRef;
  linkPreview?: LinkPreview;
}

/** A reaction with its decrypted emoji (null if it couldn't be decrypted). */
export interface ChatReactionView extends ChatReaction {
  emoji: string | null;
}

export const HISTORY_LIMIT = 50;

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

  // Unsealed conversation keys, per epoch (convId → epoch → key); in-memory only
  // (never persisted). A group re-keys on each membership change, so we keep one
  // key per epoch and decrypt each message with the key for *its* epoch.
  const convKeys = new Map<string, Map<number, Uint8Array>>();

  function setActive(convId: string | null): void {
    activeId.value = convId;
  }

  /** True once we hold any epoch key for the conversation. */
  function hasKey(convId: string): boolean {
    return (convKeys.get(convId)?.size ?? 0) > 0;
  }
  function keyForEpoch(convId: string, epoch: number): Uint8Array | undefined {
    return convKeys.get(convId)?.get(epoch);
  }
  /** The key for the conversation's current epoch (used to encrypt new sends). */
  function currentKey(convId: string): Uint8Array | undefined {
    const conv = conversations.value.find((c) => c.id === convId);
    return conv ? keyForEpoch(convId, conv.epoch) : undefined;
  }

  /** Unseal every epoch key the server handed us into the in-memory map. */
  async function unsealEpochKeys(conv: Conversation): Promise<void> {
    const { privateKey, publicKey } = await session.getKeyPair();
    const map = convKeys.get(conv.id) ?? new Map<number, Uint8Array>();
    for (const ek of conv.epochKeys) {
      if (map.has(ek.epoch)) continue;
      try {
        map.set(ek.epoch, await unsealConversationKey(ek.sealedKey, privateKey, publicKey));
      } catch {
        // Can't unseal this epoch (shouldn't happen) → its messages stay opaque.
      }
    }
    convKeys.set(conv.id, map);
  }

  async function decryptOne(convId: string, m: ChatMessage): Promise<ChatMessageView> {
    const key = keyForEpoch(convId, m.epoch);
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
        linkPreview: payload.linkPreview,
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
    const list = await api.conversations();
    conversations.value = list;
    // Drop keys for conversations we're no longer in (e.g. removed/left).
    const live = new Set(list.map((c) => c.id));
    for (const id of [...convKeys.keys()]) if (!live.has(id)) convKeys.delete(id);
    // Unseal every (possibly new) epoch key — picks up re-keys after a membership change.
    for (const conv of list) await unsealEpochKeys(conv);
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
    const { publicKey } = await session.getKeyPair();
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
    // conversation the server returns (its epochKeys are the authoritative ones),
    // never the key we just generated.
    const conv = await api.conversationCreateDm(friend.userId, members);
    await unsealEpochKeys(conv);
    upsertConversation(conv);
    setActive(conv.id);
    await loadHistory(conv.id);
    return conv.id;
  }

  /** Create a group conversation with 2+ friends; returns its id. The group key
   *  is sealed to me + every selected friend, reusing the conv-key machinery. */
  async function openGroup(selected: Friend[]): Promise<string> {
    const { publicKey } = await session.getKeyPair();
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
    await unsealEpochKeys(conv);
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
    const convKey = generateConversationKey();
    const members: SealedMemberKey[] = [];
    for (const m of parent.members) {
      if (!m.publicKey) throw new Error('member missing public key');
      members.push({ userId: m.userId, sealedKey: await sealConversationKey(m.publicKey, convKey) });
    }
    // Idempotent server-side: an existing thread's sealedKey is authoritative.
    const thread = await api.threadCreate(parentConvId, seq, members);
    await unsealEpochKeys(thread);
    upsertConversation(thread);
    return thread.id;
  }

  // ---- Group membership management (v3 phase 2) --------------------------

  /** Generate a fresh epoch key and seal it to `members` (those with a public
   *  key). Returns the new key plus the SealedMemberKey[] to POST. */
  async function rekey(members: { userId: string; publicKey: string | null }[]) {
    const convKey = generateConversationKey();
    const withKeys = members.filter((m): m is { userId: string; publicKey: string } => !!m.publicKey);
    const keys = await sealConversationKeyToMembers(withKeys, convKey);
    return { convKey, keys };
  }

  /** Add a friend to a group, minting a new epoch. `history: 'share'` also seals
   *  every prior epoch key to the joiner so they can read the back-scroll. */
  async function addMember(convId: string, friend: Friend, history: 'share' | 'fresh'): Promise<void> {
    const conv = conversations.value.find((c) => c.id === convId);
    if (!conv) throw new Error('unknown conversation');
    if (!friend.publicKey) throw new Error('friend has no public key');
    const epoch = conv.epoch + 1;
    const { convKey, keys } = await rekey([...conv.members, friend]);

    let priorKeys: SealedEpochKey[] | undefined;
    if (history === 'share') {
      const held: { epoch: number; key: Uint8Array }[] = [];
      for (let e = 0; e <= conv.epoch; e++) {
        const k = keyForEpoch(convId, e);
        if (k) held.push({ epoch: e, key: k });
      }
      priorKeys = await sealEpochKeysTo(friend.publicKey, held);
    }

    const updated = await api.conversationAddMember(convId, { userId: friend.userId, epoch, history, keys, priorKeys });
    // The server's response carries my new-epoch key; cache it (avoids a refetch).
    convKeys.get(convId)?.set(epoch, convKey);
    await unsealEpochKeys(updated);
    upsertConversation(updated);
  }

  /** Remove a member (or, when `userId` is me, leave): mint a new epoch sealed to
   *  the remaining members so the departing member can't read anything after. */
  async function removeMember(convId: string, userId: string): Promise<void> {
    const conv = conversations.value.find((c) => c.id === convId);
    if (!conv) throw new Error('unknown conversation');
    const leaving = userId === session.user?.id;
    const remaining = conv.members.filter((m) => m.userId !== userId);
    const epoch = conv.epoch + 1;
    const { convKey, keys } = await rekey(remaining);
    await api.conversationRemoveMember(convId, userId, { epoch, keys });
    if (leaving) {
      dropConversation(convId);
    } else {
      convKeys.get(convId)?.set(epoch, convKey);
      await loadConversations(); // refresh members + my new-epoch key
    }
  }

  /** Owner sets who may manage membership. */
  async function setManagePolicy(convId: string, policy: ManagePolicy): Promise<void> {
    upsertConversation(await api.conversationSetPolicy(convId, policy));
  }

  /** Owner grants/revokes admin to another member. */
  async function setMemberRole(convId: string, userId: string, role: Exclude<ConversationRole, 'owner'>): Promise<void> {
    upsertConversation(await api.conversationSetRole(convId, userId, role));
  }

  /** Forget a conversation we've left or been removed from. */
  function dropConversation(convId: string): void {
    conversations.value = conversations.value.filter((c) => c.id !== convId);
    convKeys.delete(convId);
    const { [convId]: _m, ...restM } = messages.value;
    messages.value = restM;
    const { [convId]: _r, ...restR } = reactions.value;
    reactions.value = restR;
    if (activeId.value === convId) activeId.value = null;
  }

  /** Fetch (older, when `before` is set) history and merge decrypted views.
   *  Returns the number of messages fetched — a count below `HISTORY_LIMIT`
   *  means the conversation's start has been reached. */
  async function loadHistory(convId: string, before?: number): Promise<number> {
    const raw = await api.conversationMessages(convId, { before, limit: HISTORY_LIMIT });
    const views = await Promise.all(raw.map((m) => decryptOne(convId, m)));
    mergeMessages(convId, views);
    return raw.length;
  }

  async function sendMessage(
    convId: string,
    text: string,
    opts?: { gif?: GifRef; attachments?: AttachmentRef[]; replyTo?: ReplyRef; linkPreview?: LinkPreview },
  ): Promise<void> {
    const conv = conversations.value.find((c) => c.id === convId);
    const epoch = conv?.epoch ?? 0;
    const key = currentKey(convId);
    if (!key) throw new Error('no conversation key');
    const payload: MessagePayload = { text, sentAt: Date.now() };
    if (opts?.gif) payload.gif = opts.gif;
    if (opts?.attachments?.length) payload.attachments = opts.attachments;
    if (opts?.replyTo) payload.replyTo = opts.replyTo;
    if (opts?.linkPreview) payload.linkPreview = opts.linkPreview;
    const usedEmoji = customEmojiForText(text);
    if (usedEmoji) payload.customEmoji = usedEmoji;
    const { ciphertext, iv } = await encryptMessage(key, payload);
    const sent = await api.messageSend(convId, { ciphertext, iv, epoch });
    mergeMessages(convId, [
      { ...sent, text, gif: opts?.gif ?? null, attachments: opts?.attachments ?? [], replyTo: opts?.replyTo, linkPreview: opts?.linkPreview },
    ]);
    bumpLastSeq(convId, sent.seq);
  }

  async function decryptReactionOne(convId: string, r: ChatReaction): Promise<ChatReactionView> {
    // Reactions don't record their epoch, so try each held key (newest first) —
    // a reaction was sealed under whatever epoch was current when it was added.
    const keys = [...(convKeys.get(convId)?.entries() ?? [])].sort((x, y) => y[0] - x[0]);
    for (const [, key] of keys) {
      try {
        return { ...r, emoji: await decryptReaction(key, r.ciphertext, r.iv) };
      } catch {
        /* wrong epoch key — try the next */
      }
    }
    return { ...r, emoji: null };
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
    const key = currentKey(convId);
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
        if (!hasKey(m.conversationId)) await loadConversations();
        const view = await decryptOne(m.conversationId, m);
        mergeMessages(m.conversationId, [view]);
        bumpLastSeq(m.conversationId, m.seq);
        break;
      }
      case 'reaction': {
        const r = frame.reaction;
        if (hasKey(r.conversationId)) upsertReaction(r.conversationId, await decryptReactionOne(r.conversationId, r));
        break;
      }
      case 'conversation-updated': {
        // Membership/roles/policy or epoch changed — refetch to pick up new
        // members and any newly-sealed epoch keys.
        await loadConversations();
        break;
      }
      case 'conversation-removed': {
        dropConversation(frame.conversationId);
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
    addMember,
    removeMember,
    setManagePolicy,
    setMemberRole,
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
  const profile = useProfileStore();

  const dispatch = (frame: ServerFrame): void => {
    void chat.handleFrame(frame);
    friends.handleFrame(frame);
    // A new friend should receive my profile key; a contact's profile change
    // invalidates its cached decryption.
    if (frame.type === 'friend-accepted') void profile.distributeTo(frame.friend);
    else if (frame.type === 'profile-updated') profile.invalidate(frame.userId);
  };

  unsubConnect?.();
  unsubConnect = onConnect(() => {
    void (async () => {
      await chat.loadConversations();
      await friends.load();
      await profile.load();
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
  useProfileStore().reset();
}
