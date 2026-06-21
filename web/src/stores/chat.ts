import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import type {
  AttachmentRef,
  ChannelInfo,
  ChannelType,
  ChatMessage,
  ChatReaction,
  Conversation,
  ConversationRole,
  Friend,
  GifRef,
  LinkPreview,
  MessagePayload,
  ReplyRef,
  SealedEpochKey,
  SealedMemberKey,
  ServerFrame,
  SystemEvent,
} from '@notes/shared';
import { api } from '../lib/api';
import {
  decryptMessage,
  decryptReaction,
  decryptText,
  encryptMessage,
  encryptReaction,
  encryptText,
  generateConversationKey,
  sealConversationKey,
  sealConversationKeyToMembers,
  sealEpochKeysTo,
  unsealConversationKey,
} from '../lib/chatCrypto';
import { connectChatSocket, disconnectChatSocket, onConnect } from '../lib/chatSocket';
import { randomJoinPhrase } from '../lib/systemMessages';
import { customEmojiForText, loadCustomEmoji, registerEmbeddedEmoji, resetCustomEmoji } from '../lib/emoji/custom';
import { loadEmojiUsage, resetEmojiUsage } from '../lib/emoji/usage';
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
  /** an inline system notice (member joined, …) rendered instead of a bubble */
  system?: SystemEvent;
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
  // Messages/reactions are keyed by CHANNEL id (the general channel's id equals
  // the conversation id, so DMs/threads key by their conversation id as before).
  const messages = ref<Record<string, ChatMessageView[]>>({});
  const reactions = ref<Record<string, ChatReactionView[]>>({});
  const activeId = ref<string | null>(null);
  // The channel the user is currently viewing in the active conversation (for
  // socket-reconnect backfill). Defaults to the general channel.
  const activeChannelId = ref<string | null>(null);

  // Unsealed conversation keys, per epoch (convId → epoch → key); in-memory only
  // (never persisted). A group re-keys on each membership change, so we keep one
  // key per epoch and decrypt each message with the key for *its* epoch.
  const convKeys = new Map<string, Map<number, Uint8Array>>();
  // v5: unsealed PRIVATE-channel keys, per epoch (channelId → epoch → key).
  // Open channels (incl. general) use the conversation key above; private
  // channels have their own keys distributed only to their members.
  const channelKeys = new Map<string, Map<number, Uint8Array>>();

  function setActive(convId: string | null, channelId?: string | null): void {
    activeId.value = convId;
    activeChannelId.value = channelId ?? convId;
  }
  function setActiveChannel(channelId: string | null): void {
    activeChannelId.value = channelId;
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

  /** Unseal my private-channel keys for a conversation into the in-memory map. */
  async function unsealChannelKeys(conv: Conversation): Promise<void> {
    const { privateKey, publicKey } = await session.getKeyPair();
    for (const ch of conv.channels ?? []) {
      if (!ch.private || !ch.channelKeys?.length) continue;
      const map = channelKeys.get(ch.id) ?? new Map<number, Uint8Array>();
      for (const ek of ch.channelKeys) {
        if (map.has(ek.epoch)) continue;
        try {
          map.set(ek.epoch, await unsealConversationKey(ek.sealedKey, privateKey, publicKey));
        } catch {
          /* can't unseal → its messages stay opaque */
        }
      }
      channelKeys.set(ch.id, map);
    }
  }

  function channelOf(convId: string, channelId: string): ChannelInfo | undefined {
    return conversations.value.find((c) => c.id === convId)?.channels?.find((ch) => ch.id === channelId);
  }
  /** Decryption key for a message: the channel key when the channel is private,
   *  otherwise the conversation key for that epoch. */
  function keyForMessage(convId: string, channelId: string, epoch: number): Uint8Array | undefined {
    return channelOf(convId, channelId)?.private ? channelKeys.get(channelId)?.get(epoch) : keyForEpoch(convId, epoch);
  }
  /** The key + epoch to encrypt a new send to a channel with. */
  function sendKeyFor(convId: string, channelId: string): { key: Uint8Array | undefined; epoch: number } {
    const ch = channelOf(convId, channelId);
    if (ch?.private) return { key: channelKeys.get(channelId)?.get(ch.channelEpoch), epoch: ch.channelEpoch };
    const conv = conversations.value.find((c) => c.id === convId);
    return { key: currentKey(convId), epoch: conv?.epoch ?? 0 };
  }

  async function decryptOne(convId: string, m: ChatMessage): Promise<ChatMessageView> {
    const key = keyForMessage(convId, m.channelId, m.epoch);
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
        system: payload.system,
      };
    } catch {
      return { ...m, text: null };
    }
  }

  /** Merge views into a channel's stream, keeping ascending seq order and
   *  deduping. Keyed by channel id (== conversation id for the general channel). */
  function mergeMessages(channelId: string, views: ChatMessageView[]): void {
    const existing = messages.value[channelId] ?? [];
    const bySeq = new Map<number, ChatMessageView>();
    for (const v of existing) bySeq.set(v.seq, v);
    for (const v of views) bySeq.set(v.seq, v);
    messages.value = {
      ...messages.value,
      [channelId]: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    };
  }

  // Decrypted group-icon data URLs, by conversation id (E2EE under the conv key).
  const groupIcons = reactive(new Map<string, string>());
  function groupIconUrl(convId: string): string | null {
    return groupIcons.get(convId) ?? null;
  }
  async function refreshGroupIcon(conv: Conversation): Promise<void> {
    if (conv.kind !== 'group' || !conv.icon) {
      groupIcons.delete(conv.id);
      return;
    }
    const key = keyForEpoch(conv.id, conv.icon.epoch);
    if (!key) return; // key not unsealed yet; a later upsert/load will retry
    try {
      groupIcons.set(conv.id, await decryptText(key, conv.icon.ciphertext, conv.icon.iv));
    } catch {
      groupIcons.delete(conv.id);
    }
  }

  function upsertConversation(conv: Conversation): void {
    const idx = conversations.value.findIndex((c) => c.id === conv.id);
    if (idx >= 0) conversations.value[idx] = conv;
    else conversations.value = [...conversations.value, conv];
    void refreshGroupIcon(conv);
    // The server only sends handles; overlay contacts' decrypted real names so a
    // freshly created/opened DM shows the right name without a full page reload.
    void hydrateNames();
  }

  /** Rename a group (owner/admin). Empty clears back to the member-derived title. */
  async function renameGroup(convId: string, name: string): Promise<void> {
    upsertConversation(await api.conversationEdit(convId, { name: name.trim() || null }));
  }
  /** Set or clear a group's E2EE icon (owner/admin). `dataUrl` null clears it. */
  async function setGroupIcon(convId: string, dataUrl: string | null): Promise<void> {
    if (!dataUrl) {
      upsertConversation(await api.conversationEdit(convId, { icon: null }));
      return;
    }
    const conv = conversations.value.find((c) => c.id === convId);
    const key = conv && keyForEpoch(convId, conv.epoch);
    if (!conv || !key) throw new Error('conversation key unavailable');
    const enc = await encryptText(key, dataUrl);
    upsertConversation(await api.conversationEdit(convId, { icon: { ciphertext: enc.ciphertext, iv: enc.iv, epoch: conv.epoch } }));
  }

  async function loadConversations(): Promise<void> {
    const list = await api.conversations();
    conversations.value = list;
    // Drop keys for conversations we're no longer in (e.g. removed/left).
    const live = new Set(list.map((c) => c.id));
    for (const id of [...convKeys.keys()]) if (!live.has(id)) convKeys.delete(id);
    // Unseal every (possibly new) epoch key — picks up re-keys after a membership change.
    for (const conv of list) {
      await unsealEpochKeys(conv);
      await unsealChannelKeys(conv);
      await refreshGroupIcon(conv); // keys are now available
    }
    void hydrateNames(); // overlay decrypted real names (server sent handles)
  }

  /** Overlay contacts' decrypted real display names onto member lists — the
   *  server only ever sends the public handle. Idempotent; re-run after a
   *  (re)load or a `profile-updated` event. Non-contacts keep their handle. */
  async function hydrateNames(): Promise<void> {
    const profile = useProfileStore();
    const meId = session.user?.id;
    const others = new Set<string>();
    for (const c of conversations.value) for (const m of c.members) if (m.userId !== meId) others.add(m.userId);
    await profile.hydrate([...others]);
    for (const c of conversations.value) {
      for (const m of c.members) {
        const real = m.userId === meId ? profile.myDisplayName : profile.displayNameFor(m.userId);
        if (real && m.displayName !== real) m.displayName = real;
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
    // Announce the join in-chat (best-effort; encrypted at the new epoch so the
    // joiner can read it). Never let a failed notice undo a successful add.
    await announceJoin(convId, friend.userId).catch(() => {});
  }

  /** Post an encrypted system message announcing a member joining. */
  async function announceJoin(convId: string, userId: string): Promise<void> {
    const conv = conversations.value.find((c) => c.id === convId);
    const key = currentKey(convId);
    if (!conv || !key) return;
    const system: SystemEvent = { kind: 'member-joined', userId, phrase: randomJoinPhrase() };
    const { ciphertext, iv } = await encryptMessage(key, { text: '', sentAt: Date.now(), system });
    // Join notices always land in the general channel.
    const sent = await api.messageSend(convId, { ciphertext, iv, epoch: conv.epoch });
    mergeMessages(convId, [{ ...sent, text: '', system }]);
    bumpLastSeq(convId, convId, sent.seq);
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

  /** Owner/admin grants or revokes admin on another member. */
  async function setMemberRole(convId: string, userId: string, role: Exclude<ConversationRole, 'owner'>): Promise<void> {
    upsertConversation(await api.conversationSetRole(convId, userId, role));
  }

  /** Drop one channel's cached messages + reactions. */
  function dropChannelState(channelId: string): void {
    const { [channelId]: _m, ...restM } = messages.value;
    messages.value = restM;
    const { [channelId]: _r, ...restR } = reactions.value;
    reactions.value = restR;
  }

  /** Forget a conversation we've left or been removed from (and all its channels). */
  function dropConversation(convId: string): void {
    const conv = conversations.value.find((c) => c.id === convId);
    for (const ch of conv?.channels ?? []) dropChannelState(ch.id);
    dropChannelState(convId); // general (in case channels[] wasn't populated)
    conversations.value = conversations.value.filter((c) => c.id !== convId);
    convKeys.delete(convId);
    if (activeId.value === convId) activeId.value = null;
  }

  // ---- Channel management (v4; groups only) -------------------------------

  async function createChannel(convId: string, name: string, type: 'text' | 'voice'): Promise<string> {
    const before = new Set((conversations.value.find((c) => c.id === convId)?.channels ?? []).map((ch) => ch.id));
    const updated = await api.channelCreate(convId, { name, type });
    upsertConversation(updated);
    // The newly created channel is the one not present before.
    return updated.channels.find((ch) => !before.has(ch.id))?.id ?? convId;
  }

  /** Create a PRIVATE channel (v5): generate a channel key, seal it to each
   *  member (a subset of conversation members, incl. me), and POST. Returns the
   *  new channel id. */
  async function createPrivateChannel(convId: string, name: string, type: ChannelType, memberIds: string[]): Promise<string> {
    const conv = conversations.value.find((c) => c.id === convId);
    if (!conv) throw new Error('unknown conversation');
    const me = session.user?.id;
    const ids = new Set([...(me ? [me] : []), ...memberIds]);
    const channelKey = generateConversationKey();
    const withKeys = conv.members.filter((m) => ids.has(m.userId) && m.publicKey) as { userId: string; publicKey: string }[];
    const keys = await sealConversationKeyToMembers(withKeys, channelKey);
    const before = new Set((conv.channels ?? []).map((ch) => ch.id));
    const updated = await api.channelCreate(convId, { name, type, private: true, members: keys });
    upsertConversation(updated);
    await unsealChannelKeys(updated);
    return updated.channels.find((ch) => !before.has(ch.id))?.id ?? convId;
  }

  /** Grant a conversation member access to a private channel: mint a new channel
   *  epoch sealed to current members + the joiner (and prior keys when sharing
   *  history so they can back-scroll). */
  async function grantChannelMember(convId: string, channelId: string, userId: string, history: 'share' | 'fresh'): Promise<void> {
    const conv = conversations.value.find((c) => c.id === convId);
    const ch = channelOf(convId, channelId);
    const joiner = conv?.members.find((m) => m.userId === userId);
    if (!conv || !ch || !joiner?.publicKey) throw new Error('cannot grant');
    const epoch = ch.channelEpoch + 1;
    const memberList = conv.members.filter((m) => ch.memberIds.includes(m.userId));
    const channelKey = generateConversationKey();
    const withKeys = [...memberList, joiner].filter((m) => m.publicKey) as { userId: string; publicKey: string }[];
    const keys = await sealConversationKeyToMembers(withKeys, channelKey);
    let priorKeys: SealedEpochKey[] | undefined;
    if (history === 'share') {
      const held: { epoch: number; key: Uint8Array }[] = [];
      for (let e = 0; e <= ch.channelEpoch; e++) {
        const k = channelKeys.get(channelId)?.get(e);
        if (k) held.push({ epoch: e, key: k });
      }
      priorKeys = await sealEpochKeysTo(joiner.publicKey, held);
    }
    const updated = await api.channelAddMember(convId, channelId, { userId, epoch, history, keys, priorKeys });
    channelKeys.get(channelId)?.set(epoch, channelKey);
    upsertConversation(updated);
    await unsealChannelKeys(updated);
  }

  /** Revoke a member from a private channel: mint a new epoch sealed to the
   *  remaining members so the removed member can't read future messages. */
  async function revokeChannelMember(convId: string, channelId: string, userId: string): Promise<void> {
    const conv = conversations.value.find((c) => c.id === convId);
    const ch = channelOf(convId, channelId);
    if (!conv || !ch) throw new Error('cannot revoke');
    const epoch = ch.channelEpoch + 1;
    const remaining = conv.members.filter((m) => ch.memberIds.includes(m.userId) && m.userId !== userId);
    const channelKey = generateConversationKey();
    const withKeys = remaining.filter((m) => m.publicKey) as { userId: string; publicKey: string }[];
    const keys = await sealConversationKeyToMembers(withKeys, channelKey);
    await api.channelRemoveMember(convId, channelId, userId, { epoch, keys });
    channelKeys.get(channelId)?.set(epoch, channelKey);
    await loadConversations();
  }

  async function renameChannel(convId: string, channelId: string, name: string): Promise<void> {
    upsertConversation(await api.channelRename(convId, channelId, name));
  }

  async function reorderChannels(convId: string, orderedIds: string[]): Promise<void> {
    upsertConversation(await api.channelReorder(convId, orderedIds));
  }

  async function deleteChannel(convId: string, channelId: string): Promise<void> {
    await api.channelDelete(convId, channelId);
    dropChannelState(channelId);
    if (activeChannelId.value === channelId) activeChannelId.value = convId;
    await loadConversations();
  }

  /** Fetch (older, when `before` is set) history for one channel and merge
   *  decrypted views. `channelId` defaults to the general channel (== convId).
   *  Returns the number of messages fetched — a count below `HISTORY_LIMIT`
   *  means the channel's start has been reached. */
  async function loadHistory(convId: string, channelId?: string, before?: number): Promise<number> {
    const chan = channelId ?? convId;
    const raw = await api.conversationMessages(convId, { before, limit: HISTORY_LIMIT, channelId: chan });
    const views = await Promise.all(raw.map((m) => decryptOne(convId, m)));
    mergeMessages(chan, views);
    return raw.length;
  }

  async function sendMessage(
    convId: string,
    channelId: string,
    text: string,
    opts?: { gif?: GifRef; attachments?: AttachmentRef[]; replyTo?: ReplyRef; linkPreview?: LinkPreview },
  ): Promise<void> {
    const { key, epoch } = sendKeyFor(convId, channelId);
    if (!key) throw new Error('no channel key');
    const payload: MessagePayload = { text, sentAt: Date.now() };
    if (opts?.gif) payload.gif = opts.gif;
    if (opts?.attachments?.length) payload.attachments = opts.attachments;
    if (opts?.replyTo) payload.replyTo = opts.replyTo;
    if (opts?.linkPreview) payload.linkPreview = opts.linkPreview;
    const usedEmoji = customEmojiForText(text);
    if (usedEmoji) payload.customEmoji = usedEmoji;
    const { ciphertext, iv } = await encryptMessage(key, payload);
    const sent = await api.messageSend(convId, { ciphertext, iv, epoch, channelId });
    mergeMessages(channelId, [
      { ...sent, text, gif: opts?.gif ?? null, attachments: opts?.attachments ?? [], replyTo: opts?.replyTo, linkPreview: opts?.linkPreview },
    ]);
    bumpLastSeq(convId, channelId, sent.seq);
  }

  /** Edit my own message's text in place. Re-encrypts under the message's own
   *  epoch key (so the same recipients can read it) and preserves the original
   *  non-text payload (gif/attachments/reply/preview). */
  async function editMessage(convId: string, channelId: string, seq: number, text: string): Promise<void> {
    const existing = (messages.value[channelId] ?? []).find((m) => m.seq === seq);
    if (!existing) throw new Error('message not found');
    if (text === existing.text) return; // no change → no API call, stays unedited
    const key = keyForMessage(convId, channelId, existing.epoch);
    if (!key) throw new Error('no channel key');
    const payload: MessagePayload = { text, sentAt: existing.createdAt };
    if (existing.gif) payload.gif = existing.gif;
    if (existing.attachments?.length) payload.attachments = existing.attachments;
    if (existing.replyTo) payload.replyTo = existing.replyTo;
    if (existing.linkPreview) payload.linkPreview = existing.linkPreview;
    const usedEmoji = customEmojiForText(text);
    if (usedEmoji) payload.customEmoji = usedEmoji;
    const { ciphertext, iv } = await encryptMessage(key, payload);
    const updated = await api.messageEdit(convId, seq, { ciphertext, iv });
    mergeMessages(channelId, [{ ...existing, ...updated, text }]);
  }

  async function decryptReactionOne(convId: string, r: ChatReaction): Promise<ChatReactionView> {
    // Reactions don't record their epoch, so try each held key (newest first) —
    // from the channel's key set (private) or the conversation's (open).
    const source = channelOf(convId, r.channelId)?.private ? channelKeys.get(r.channelId) : convKeys.get(convId);
    const keys = [...(source?.entries() ?? [])].sort((x, y) => y[0] - x[0]);
    for (const [, key] of keys) {
      try {
        return { ...r, emoji: await decryptReaction(key, r.ciphertext, r.iv) };
      } catch {
        /* wrong epoch key — try the next */
      }
    }
    return { ...r, emoji: null };
  }

  function upsertReaction(channelId: string, view: ChatReactionView): void {
    const list = reactions.value[channelId] ?? [];
    if (list.some((r) => r.id === view.id)) return; // dedupe self-echo / refetch
    reactions.value = { ...reactions.value, [channelId]: [...list, view] };
  }

  function dropReaction(channelId: string, id: string): void {
    const list = reactions.value[channelId];
    if (!list) return;
    reactions.value = { ...reactions.value, [channelId]: list.filter((r) => r.id !== id) };
  }

  async function loadReactions(convId: string, channelId?: string): Promise<void> {
    const chan = channelId ?? convId;
    const raw = await api.reactions(convId, chan);
    reactions.value = { ...reactions.value, [chan]: await Promise.all(raw.map((r) => decryptReactionOne(convId, r))) };
  }

  /** Toggle my reaction with `emoji` on a message: remove it if I already have
   *  one, otherwise add it. */
  async function toggleReaction(convId: string, channelId: string, seq: number, emoji: string): Promise<void> {
    const { key } = sendKeyFor(convId, channelId);
    if (!key) return;
    const me = session.user?.id;
    const mine = (reactions.value[channelId] ?? []).find((r) => r.seq === seq && r.userId === me && r.emoji === emoji);
    if (mine) {
      dropReaction(channelId, mine.id);
      await api.reactionRemove(convId, mine.id);
      return;
    }
    const { ciphertext, iv } = await encryptReaction(key, emoji);
    const created = await api.reactionAdd(convId, seq, { ciphertext, iv });
    upsertReaction(channelId, { ...created, emoji });
  }

  /** Patch one channel's field within a conversation (immutably, max-monotonic). */
  function patchChannelSeq(convId: string, channelId: string, field: 'lastSeq' | 'lastReadSeq', seq: number): void {
    const idx = conversations.value.findIndex((c) => c.id === convId);
    const conv = conversations.value[idx];
    if (!conv) return;
    const isGeneral = channelId === convId;
    const channels = (conv.channels ?? []).map((ch) => (ch.id === channelId && seq > ch[field] ? { ...ch, [field]: seq } : ch));
    const patch: Partial<Conversation> = { channels };
    // Mirror the general channel onto the conversation-level fields (DM/thread fast-path).
    if (isGeneral && seq > conv[field]) patch[field] = seq;
    conversations.value[idx] = { ...conv, ...patch };
  }

  async function markRead(convId: string, channelId: string, seq: number): Promise<void> {
    await api.conversationRead(convId, seq, channelId);
    patchChannelSeq(convId, channelId, 'lastReadSeq', seq);
  }

  function bumpLastSeq(convId: string, channelId: string, seq: number): void {
    patchChannelSeq(convId, channelId, 'lastSeq', seq);
  }

  async function handleFrame(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case 'message': {
        const m = frame.message;
        // First contact with a conversation we don't have yet (e.g. a friend's
        // opening DM): fetch it so we hold its sealed key before decrypting.
        if (!hasKey(m.conversationId)) await loadConversations();
        const view = await decryptOne(m.conversationId, m);
        mergeMessages(m.channelId, [view]);
        bumpLastSeq(m.conversationId, m.channelId, m.seq);
        break;
      }
      case 'message-edited': {
        const m = frame.message;
        // Edits never advance unread; just replace the message in place (same
        // seq). Skip if we can't decrypt this conversation yet.
        if (!hasKey(m.conversationId)) break;
        mergeMessages(m.channelId, [await decryptOne(m.conversationId, m)]);
        break;
      }
      case 'reaction': {
        const r = frame.reaction;
        if (hasKey(r.conversationId)) upsertReaction(r.channelId, await decryptReactionOne(r.conversationId, r));
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
      case 'channels-updated': {
        // A channel was added/renamed/reordered/deleted — refetch the list, and
        // drop any local state for a deleted channel.
        if (frame.deletedChannelId) dropChannelState(frame.deletedChannelId);
        await loadConversations();
        break;
      }
      case 'reaction-removed': {
        dropReaction(frame.channelId, frame.id);
        break;
      }
      case 'read': {
        // Only my own read receipts advance my unread baseline (per channel).
        if (frame.userId === session.user?.id) {
          patchChannelSeq(frame.conversationId, frame.channelId, 'lastReadSeq', frame.seq);
        }
        break;
      }
      default:
        break;
    }
  }

  /** A conversation's unread = the sum of its channels' unread counts. */
  function unreadCount(convId: string): number {
    const conv = conversations.value.find((c) => c.id === convId);
    if (!conv) return 0;
    const chans = conv.channels ?? [];
    // Fall back to the conversation-level cursor when channels aren't populated.
    if (chans.length === 0) return Math.max(0, conv.lastSeq - conv.lastReadSeq);
    return chans.reduce((sum, ch) => sum + Math.max(0, ch.lastSeq - ch.lastReadSeq), 0);
  }

  /** Unread across every conversation (excluding threads) — drives the browser
   *  tab title and the installed-PWA app-icon badge. */
  const totalUnread = computed(() =>
    conversations.value.filter((c) => c.kind !== 'thread').reduce((sum, c) => sum + unreadCount(c.id), 0),
  );

  function reset(): void {
    conversations.value = [];
    messages.value = {};
    reactions.value = {};
    activeId.value = null;
    activeChannelId.value = null;
    convKeys.clear();
    channelKeys.clear();
  }

  return {
    conversations,
    messages,
    reactions,
    activeId,
    activeChannelId,
    setActive,
    setActiveChannel,
    loadConversations,
    hydrateNames,
    openDm,
    openGroup,
    openThread,
    threadFor,
    addMember,
    removeMember,
    setMemberRole,
    createChannel,
    createPrivateChannel,
    grantChannelMember,
    revokeChannelMember,
    renameChannel,
    renameGroup,
    setGroupIcon,
    groupIconUrl,
    reorderChannels,
    deleteChannel,
    loadHistory,
    sendMessage,
    editMessage,
    loadReactions,
    toggleReaction,
    markRead,
    handleFrame,
    unreadCount,
    totalUnread,
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
    else if (frame.type === 'profile-updated') {
      profile.invalidate(frame.userId);
      void chat.hydrateNames(); // a contact may have changed their real name
      void friends.hydrateNames();
    }
  };

  unsubConnect?.();
  unsubConnect = onConnect(() => {
    void (async () => {
      await chat.loadConversations();
      await friends.load();
      await profile.load();
      // Profile is loaded → overlay decrypted real names over the handles.
      void chat.hydrateNames();
      void friends.hydrateNames();
      void loadCustomEmoji();
      void loadEmojiUsage();
      if (chat.activeId) {
        const chan = chat.activeChannelId ?? chat.activeId;
        await chat.loadHistory(chat.activeId, chan);
        await chat.loadReactions(chat.activeId, chan);
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
  resetEmojiUsage();
  useChatStore().reset();
  useProfileStore().reset();
}
