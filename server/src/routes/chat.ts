import type { FastifyInstance } from 'fastify';
import type {
  ChannelInfo,
  ChannelType,
  ChatMessage,
  ChatReaction,
  Conversation,
  ConversationMember,
  ConversationRole,
  Friend,
  FriendInvite,
  FriendRequest,
  ProfileInfo,
  ProfileView,
  SealedEpochKey,
  SealedKey,
  SealedMemberKey,
} from '@notes/shared';
import { canManageMembers, CHANNEL_NAME_MAX, CONVERSATION_NAME_MAX, MAX_CHANNELS_PER_CONVERSATION, NAME_COLORS } from '@notes/shared';
import {
  effectiveDisplayName,
  effectiveHandle,
  type ConversationRow,
  type DB,
  type MessageRow,
  type ReactionRow,
} from '../db.js';
import type { Realtime } from '../realtime.js';
import type { Push } from '../push.js';
import { requireAuth } from '../session.js';
import { isValidHandle } from '../handles.js';
import { newId, newToken, now } from '../util.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INVITE_TTL = 24 * 60 * 60 * 1000; // 24h
const MAX_CIPHERTEXT = 64 * 1024;

function validSealedKey(s: unknown): s is SealedKey {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.epk === 'string' && o.epk.length < 256 &&
    typeof o.iv === 'string' && o.iv.length < 256 &&
    typeof o.ct === 'string' && o.ct.length < 1024
  );
}

function validWrappedKey(s: unknown): boolean {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.salt === 'string' && o.salt.length < 256 &&
    typeof o.iv === 'string' && o.iv.length < 256 &&
    typeof o.ct === 'string' && o.ct.length < 1024
  );
}

/** Validate a re-key payload: `{userId, sealedKey}[]` that covers EXACTLY the
 *  `expected` member set (no missing, extra, or duplicate). Returns the parsed
 *  list, or null on any mismatch — so the server never half-applies a re-key. */
function parseSealedMemberKeys(raw: unknown, expected: Set<string>): SealedMemberKey[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SealedMemberKey[] = [];
  const seen = new Set<string>();
  for (const m of raw) {
    if (typeof m !== 'object' || m === null) return null;
    const mm = m as Record<string, unknown>;
    if (typeof mm.userId !== 'string' || !validSealedKey(mm.sealedKey)) return null;
    if (!expected.has(mm.userId) || seen.has(mm.userId)) return null;
    seen.add(mm.userId);
    out.push({ userId: mm.userId, sealedKey: mm.sealedKey });
  }
  return seen.size === expected.size ? out : null;
}

/** Validate prior-epoch keys for a share-history join: `{epoch, sealedKey}[]`
 *  covering EXACTLY epochs 0..maxEpoch. Returns the parsed list, or null. */
function parseSealedEpochKeys(raw: unknown, maxEpoch: number): SealedEpochKey[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SealedEpochKey[] = [];
  const seen = new Set<number>();
  for (const k of raw) {
    if (typeof k !== 'object' || k === null) return null;
    const kk = k as Record<string, unknown>;
    if (typeof kk.epoch !== 'number' || !Number.isInteger(kk.epoch) || !validSealedKey(kk.sealedKey)) return null;
    if (kk.epoch < 0 || kk.epoch > maxEpoch || seen.has(kk.epoch)) return null;
    seen.add(kk.epoch);
    out.push({ epoch: kk.epoch, sealedKey: kk.sealedKey });
  }
  return seen.size === maxEpoch + 1 ? out : null;
}

function toMessage(m: MessageRow): ChatMessage {
  return {
    conversationId: m.conversation_id,
    channelId: m.channel_id,
    seq: m.seq,
    senderId: m.sender_id,
    epoch: m.epoch,
    ciphertext: m.ciphertext,
    iv: m.iv,
    createdAt: m.created_at,
    editedAt: m.edited_at ?? undefined,
  };
}

function toReaction(r: ReactionRow): ChatReaction {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    channelId: r.channel_id,
    seq: r.seq,
    userId: r.user_id,
    ciphertext: r.ciphertext,
    iv: r.iv,
    createdAt: r.created_at,
  };
}

export function chatRoutes(app: FastifyInstance, db: DB, hub: Realtime, push: Push): void {
  // Build a Conversation for a given member, including their own sealed key.
  function toConversation(conv: ConversationRow, userId: string): Conversation | null {
    const mine = db.getConversationMember(conv.id, userId);
    if (!mine) return null;
    const members: ConversationMember[] = db.listConversationMembers(conv.id).map((m) => {
      const u = db.getUser(m.user_id);
      // displayName carries the public handle; the real (E2EE) name is overlaid
      // client-side from the contact's decrypted profile.
      const handle = u ? effectiveHandle(u) : `User-${m.user_id.slice(0, 6)}`;
      return {
        userId: m.user_id,
        displayName: handle,
        handle,
        publicKey: u?.public_key ?? null,
        nameColor: u?.name_color ?? null,
        linkPreviews: !!u && u.link_previews !== 0,
        role: m.role as ConversationRole,
      };
    });
    // DM access requires current friendship — unfriending revokes access
    // (history preserved; restored on re-friend). A 1:1 thread inherits the
    // same rule (it has the same two members as its parent DM).
    if (conv.kind === 'dm' || (conv.kind === 'thread' && members.length === 2)) {
      const other = members.find((m) => m.userId !== userId);
      if (other && !db.areFriends(userId, other.userId)) return null;
    }
    const epochKeys: SealedEpochKey[] = db
      .listConversationKeysForUser(conv.id, userId)
      .map((k) => ({ epoch: k.epoch, sealedKey: JSON.parse(k.sealed_key) as SealedKey }));
    // The general channel is virtual (id === conversation id); its read cursor is
    // the member row. Extra channels (groups) come from the channels table.
    const generalLastSeq = db.getChannelMaxSeq(conv.id);
    const channels: ChannelInfo[] = [
      {
        id: conv.id,
        conversationId: conv.id,
        name: 'general',
        type: 'text',
        position: 0,
        isDefault: true,
        lastSeq: generalLastSeq,
        lastReadSeq: mine.last_read_seq,
        private: false,
        channelEpoch: 0,
        channelKeys: [],
        memberIds: [],
      },
    ];
    for (const ch of db.listChannels(conv.id)) {
      const isPrivate = ch.private !== 0;
      // A private channel is only visible to its members.
      if (isPrivate && !db.isChannelMember(ch.id, userId)) continue;
      const myChannelKeys: SealedEpochKey[] = isPrivate
        ? db.listChannelKeysForUser(ch.id, userId).map((k) => ({ epoch: k.epoch, sealedKey: JSON.parse(k.sealed_key) as SealedKey }))
        : [];
      channels.push({
        id: ch.id,
        conversationId: conv.id,
        name: ch.name,
        type: ch.type as ChannelType,
        position: ch.position,
        isDefault: false,
        lastSeq: db.getChannelMaxSeq(ch.id),
        lastReadSeq: db.getLastReadSeq(conv.id, ch.id, userId),
        private: isPrivate,
        channelEpoch: isPrivate ? (db.getChannelMember(ch.id, userId)?.epoch ?? 0) : 0,
        channelKeys: myChannelKeys,
        memberIds: isPrivate ? db.listChannelMemberIds(ch.id) : [],
      });
    }
    return {
      id: conv.id,
      kind: conv.kind as Conversation['kind'],
      members,
      name: conv.name ?? null,
      icon: conv.icon_ct ? { ciphertext: conv.icon_ct, iv: conv.icon_iv!, epoch: conv.icon_epoch! } : null,
      sealedKey: JSON.parse(mine.sealed_key) as SealedKey,
      epoch: mine.epoch,
      epochKeys,
      myRole: mine.role as ConversationRole,
      channels,
      lastSeq: generalLastSeq,
      lastReadSeq: mine.last_read_seq,
      createdAt: conv.created_at,
      parentId: conv.parent_id,
      parentSeq: conv.parent_seq,
    };
  }

  // Resolve a client-supplied channel id within a conversation. `undefined`/the
  // conversation id itself ⇒ the general channel. Returns the resolved channel
  // id, or null when the id is malformed or doesn't belong to this conversation.
  function resolveChannel(convId: string, raw: unknown, userId: string): string | null {
    if (raw === undefined || raw === null || raw === convId) return convId;
    if (typeof raw !== 'string' || !ID_RE.test(raw)) return null;
    const ch = db.getChannel(raw);
    if (!ch || ch.conversation_id !== convId) return null;
    // A private channel is only reachable by its members.
    if (ch.private !== 0 && !db.isChannelMember(raw, userId)) return null;
    return raw;
  }

  // Who should receive events for a channel: a private channel's own members,
  // otherwise (open/general) every conversation member.
  function channelAudience(convId: string, channelId: string): string[] {
    if (channelId !== convId) {
      const ch = db.getChannel(channelId);
      if (ch && ch.private !== 0) return db.listChannelMemberIds(channelId);
    }
    return db.listConversationMemberIds(convId);
  }

  // Access requires membership AND, for a DM, current friendship.
  function canAccess(convId: string, userId: string): boolean {
    const conv = db.getConversation(convId);
    if (!conv || !db.getConversationMember(convId, userId)) return false;
    if (conv.kind === 'dm') {
      const other = db.listConversationMemberIds(convId).find((u) => u !== userId);
      if (other && !db.areFriends(userId, other)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- Invites

  app.post('/api/friend-invites', { preHandler: requireAuth }, async (request) => {
    const id = newId();
    const token = newToken();
    const expiresAt = now() + INVITE_TTL;
    db.createFriendInvite({ id, token, createdBy: request.user!.id, expiresAt });
    const invite: FriendInvite = { id, token, createdAt: now(), expiresAt };
    return invite;
  });

  app.get('/api/friend-invites', { preHandler: requireAuth }, async (request) => {
    return db.listFriendInvites(request.user!.id).map(
      (i): FriendInvite => ({ id: i.id, token: i.token, createdAt: i.created_at, expiresAt: i.expires_at }),
    );
  });

  app.delete('/api/friend-invites/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const invite = db.getFriendInvite(id);
    if (!invite || invite.created_by !== request.user!.id) {
      return reply.code(404).send({ error: 'not found' });
    }
    db.deleteFriendInvite(id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- Friends

  app.post('/api/friends/redeem', { preHandler: requireAuth }, async (request, reply) => {
    const b = request.body as Record<string, unknown> | null;
    if (typeof b?.token !== 'string') return reply.code(400).send({ error: 'invalid token' });
    const invite = db.getFriendInviteByToken(b.token);
    if (!invite) return reply.code(404).send({ error: 'invite not found' });
    const me = request.user!.id;
    const owner = invite.created_by;
    if (owner === me) return reply.code(400).send({ error: 'cannot redeem your own invite' });
    if (db.areFriends(me, owner)) return reply.code(409).send({ error: 'already friends' });
    if (db.getFriendRequestBetween(me, owner)) return reply.code(409).send({ error: 'request already exists' });

    const reqId = newId();
    db.createFriendRequest({ id: reqId, fromUser: me, toUser: owner });

    const request_: FriendRequest = {
      id: reqId,
      userId: me,
      // Not contacts yet → show the handle, not the (now E2EE) real name.
      displayName: effectiveHandle(request.user!),
      handle: effectiveHandle(request.user!),
      direction: 'incoming', // from the owner's perspective
      createdAt: now(),
    };
    hub.sendToUser(owner, { type: 'friend-request', request: request_ });
    return { ok: true };
  });

  app.get('/api/friends/requests', { preHandler: requireAuth }, async (request) => {
    const me = request.user!.id;
    return db.listFriendRequests(me).map((r): FriendRequest => {
      const outgoing = r.from_user === me;
      const otherId = outgoing ? r.to_user : r.from_user;
      const other = db.getUser(otherId);
      const handle = other ? effectiveHandle(other) : `User-${otherId.slice(0, 6)}`;
      return {
        id: r.id,
        userId: otherId,
        displayName: handle, // handle until we're contacts and can decrypt the real name
        handle,
        direction: outgoing ? 'outgoing' : 'incoming',
        createdAt: r.created_at,
      };
    });
  });

  app.post('/api/friends/requests/:id/accept', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const me = request.user!.id;
    const req = db.getFriendRequest(id);
    if (!req || req.to_user !== me) return reply.code(404).send({ error: 'not found' });
    const otherId = req.from_user;
    db.addFriendPair(me, otherId);
    db.deleteFriendRequest(id);
    // Clear any reverse-direction request so it can't linger after we're friends.
    const reverse = db.getFriendRequestBetween(me, otherId);
    if (reverse) db.deleteFriendRequest(reverse.id);

    const other = db.getUser(otherId);
    const otherHandle = other ? effectiveHandle(other) : `User-${otherId.slice(0, 6)}`;
    const friend: Friend = {
      userId: otherId,
      displayName: otherHandle,
      handle: otherHandle,
      publicKey: other?.public_key ?? null,
      online: hub.isOnline(otherId),
    };
    // Push MY info to the other user.
    const myHandle = effectiveHandle(request.user!);
    hub.sendToUser(otherId, {
      type: 'friend-accepted',
      friend: {
        userId: me,
        displayName: myHandle,
        handle: myHandle,
        publicKey: request.user!.public_key,
        online: hub.isOnline(me),
      },
    });
    return friend;
  });

  app.post('/api/friends/requests/:id/decline', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const me = request.user!.id;
    const req = db.getFriendRequest(id);
    if (!req || (req.to_user !== me && req.from_user !== me)) {
      return reply.code(404).send({ error: 'not found' });
    }
    db.deleteFriendRequest(id);
    return { ok: true };
  });

  app.get('/api/friends', { preHandler: requireAuth }, async (request) => {
    const me = request.user!.id;
    return db.listFriendRows(me).map((row): Friend => {
      const u = db.getUser(row.friend_id);
      const handle = u ? effectiveHandle(u) : `User-${row.friend_id.slice(0, 6)}`;
      return {
        userId: row.friend_id,
        displayName: handle, // overlaid with the decrypted real name client-side
        handle,
        publicKey: u?.public_key ?? null,
        online: hub.isOnline(row.friend_id),
      };
    });
  });

  app.delete('/api/friends/:userId', { preHandler: requireAuth }, async (request) => {
    const me = request.user!.id;
    const { userId } = request.params as { userId: string };
    db.deleteFriendPair(me, userId);
    // Revoke profile-key access in both directions. The current blobs become
    // unreadable to each other immediately; rotation on the next profile update
    // protects future ones (the ex-friend keeps only stale plaintext).
    db.deleteProfileKeyPair(me, userId);
    return { ok: true };
  });

  // ---------------------------------------------------------------- Profile

  function profileInfo(u: {
    id: string;
    handle: string | null;
    display_name: string | null;
    name_color: string | null;
    profile_friends_only: number;
    link_previews: number;
  }): ProfileInfo {
    return {
      displayName: effectiveDisplayName(u),
      handle: effectiveHandle(u),
      nameColor: u.name_color ?? null,
      friendsOnly: u.profile_friends_only !== 0,
      linkPreviews: u.link_previews !== 0,
    };
  }

  app.get('/api/profile', { preHandler: requireAuth }, async (request) => {
    return profileInfo(request.user!);
  });

  // Public "Word#1234" handle: fetch fresh candidate options, or set the chosen one.
  app.get('/api/handle/options', { preHandler: requireAuth }, async () => {
    return { options: db.generateHandleOptions(3) };
  });

  app.put('/api/handle', { preHandler: requireAuth }, async (request, reply) => {
    const { handle } = (request.body ?? {}) as { handle?: unknown };
    if (!isValidHandle(handle)) return reply.code(400).send({ error: 'invalid handle' });
    if (!db.setUserHandle(request.user!.id, handle)) {
      return reply.code(409).send({ error: 'that handle is taken' });
    }
    return profileInfo({ ...request.user!, handle });
  });

  app.put('/api/profile', { preHandler: requireAuth }, async (request, reply) => {
    const me = request.user!.id;
    const b = request.body as Record<string, unknown> | null;
    // Both fields are optional; update whichever is present.
    if (b?.displayName !== undefined) {
      // null clears the legacy plaintext name (the real name is now E2EE in the
      // profile blob); a string sets it (kept only for backwards-compat reads).
      if (b.displayName === null) {
        db.setDisplayName(me, null);
      } else if (typeof b.displayName === 'string') {
        const trimmed = b.displayName.trim();
        if (trimmed.length < 1 || trimmed.length > 50) {
          return reply.code(400).send({ error: 'display name must be 1..50 chars' });
        }
        db.setDisplayName(me, trimmed);
      } else {
        return reply.code(400).send({ error: 'invalid display name' });
      }
    }
    if (b?.nameColor !== undefined) {
      const nc = b.nameColor;
      if (nc !== null && (typeof nc !== 'string' || !(NAME_COLORS as readonly string[]).includes(nc))) {
        return reply.code(400).send({ error: 'invalid name color' });
      }
      db.setNameColor(me, nc);
    }
    return profileInfo(db.getUser(me)!);
  });

  // Who may currently receive my encrypted profile: friends always; group
  // co-members too when visibility isn't friends-only.
  function profileRecipientAllowed(ownerId: string, recipientId: string, friendsOnly: boolean): boolean {
    if (recipientId === ownerId) return false;
    if (db.areFriends(ownerId, recipientId)) return true;
    return !friendsOnly && db.sharesConversation(ownerId, recipientId);
  }

  // The owner's own encrypted profile + the profile key wrapped under their MK,
  // so they can decrypt and edit it on any device. Null when none is set yet.
  app.get('/api/profile/data', { preHandler: requireAuth }, async (request) => {
    const p = db.getProfile(request.user!.id);
    if (!p) return { profile: null };
    return {
      profile: {
        ciphertext: p.ciphertext,
        iv: p.iv,
        epoch: p.epoch,
        ownerWrappedKey: JSON.parse(p.owner_wrapped_key) as unknown,
      },
    };
  });

  // Set (or rotate) the encrypted profile blob and the per-recipient sealed keys.
  app.put('/api/profile/data', { preHandler: requireAuth }, async (request, reply) => {
    const me = request.user!.id;
    const b = request.body as Record<string, unknown> | null;
    const ciphertext = b?.ciphertext;
    const iv = b?.iv;
    const epoch = b?.epoch;
    const ownerWrappedKey = b?.ownerWrappedKey;
    const keys = b?.keys;
    if (typeof ciphertext !== 'string' || ciphertext.length > MAX_CIPHERTEXT) {
      return reply.code(400).send({ error: 'invalid ciphertext' });
    }
    if (typeof iv !== 'string' || iv.length > 256) return reply.code(400).send({ error: 'invalid iv' });
    if (!Number.isInteger(epoch) || (epoch as number) < 0) return reply.code(400).send({ error: 'invalid epoch' });
    if (!validWrappedKey(ownerWrappedKey)) return reply.code(400).send({ error: 'invalid ownerWrappedKey' });
    if (!Array.isArray(keys)) return reply.code(400).send({ error: 'invalid keys' });

    const friendsOnly = request.user!.profile_friends_only !== 0;
    const sealed: { recipientId: string; sealedKey: string }[] = [];
    for (const k of keys as unknown[]) {
      if (typeof k !== 'object' || k === null) return reply.code(400).send({ error: 'invalid key entry' });
      const kk = k as Record<string, unknown>;
      if (typeof kk.recipientId !== 'string' || !validSealedKey(kk.sealedKey)) {
        return reply.code(400).send({ error: 'invalid key entry' });
      }
      if (!profileRecipientAllowed(me, kk.recipientId, friendsOnly)) {
        return reply.code(400).send({ error: 'recipient not permitted' });
      }
      sealed.push({ recipientId: kk.recipientId, sealedKey: JSON.stringify(kk.sealedKey) });
    }

    db.upsertProfile({ ownerId: me, ciphertext, iv, epoch: epoch as number, ownerWrappedKey: JSON.stringify(ownerWrappedKey) });
    db.replaceProfileKeys(me, epoch as number, sealed);
    hub.sendToUsers(sealed.map((s) => s.recipientId), { type: 'profile-updated', userId: me });
    return { ok: true, epoch };
  });

  // Distribute the current profile key to additional recipients (e.g. a newly
  // accepted friend) without rotating — must match the stored epoch.
  app.post('/api/profile/keys', { preHandler: requireAuth }, async (request, reply) => {
    const me = request.user!.id;
    const profile = db.getProfile(me);
    if (!profile) return reply.code(404).send({ error: 'no profile set' });
    const b = request.body as Record<string, unknown> | null;
    if (b?.epoch !== profile.epoch) return reply.code(409).send({ error: 'epoch mismatch' });
    const keys = b?.keys;
    if (!Array.isArray(keys)) return reply.code(400).send({ error: 'invalid keys' });

    const friendsOnly = request.user!.profile_friends_only !== 0;
    for (const k of keys as unknown[]) {
      if (typeof k !== 'object' || k === null) return reply.code(400).send({ error: 'invalid key entry' });
      const kk = k as Record<string, unknown>;
      if (typeof kk.recipientId !== 'string' || !validSealedKey(kk.sealedKey)) {
        return reply.code(400).send({ error: 'invalid key entry' });
      }
      if (!profileRecipientAllowed(me, kk.recipientId, friendsOnly)) {
        return reply.code(400).send({ error: 'recipient not permitted' });
      }
      db.upsertProfileKey(me, kk.recipientId, profile.epoch, JSON.stringify(kk.sealedKey));
      hub.sendToUser(kk.recipientId, { type: 'profile-updated', userId: me });
    }
    return { ok: true };
  });

  // Toggle profile visibility. Tightening to friends-only immediately revokes any
  // sealed keys held by non-friend co-members (they lose the current blob).
  app.put('/api/profile/visibility', { preHandler: requireAuth }, async (request, reply) => {
    const me = request.user!.id;
    const b = request.body as Record<string, unknown> | null;
    if (typeof b?.friendsOnly !== 'boolean') return reply.code(400).send({ error: 'invalid friendsOnly' });
    db.setProfileVisibility(me, b.friendsOnly);
    if (b.friendsOnly) db.deleteNonFriendProfileKeys(me);
    return profileInfo(db.getUser(me)!);
  });

  // Toggle link previews (opt-in, default off). The setting is exposed on each
  // ConversationMember so the sender's client can gate previews on all-members.
  app.put('/api/profile/link-previews', { preHandler: requireAuth }, async (request, reply) => {
    const me = request.user!.id;
    const b = request.body as Record<string, unknown> | null;
    if (typeof b?.enabled !== 'boolean') return reply.code(400).send({ error: 'invalid enabled' });
    db.setLinkPreviews(me, b.enabled);
    return profileInfo(db.getUser(me)!);
  });

  // Fetch another user's profile: server-visible name/color always (for a
  // contact), plus the encrypted blob + MY sealed key when I'm a recipient.
  app.get('/api/users/:id/profile', { preHandler: requireAuth }, async (request, reply) => {
    const me = request.user!.id;
    const { id } = request.params as { id: string };
    const u = db.getUser(id);
    if (!u) return reply.code(404).send({ error: 'not found' });
    if (id !== me && !db.areFriends(me, id) && !db.sharesConversation(me, id)) {
      return reply.code(403).send({ error: 'no relationship' });
    }
    const profile = db.getProfile(id);
    const myKey = profile ? db.getProfileKeyFor(id, me) : undefined;
    const view: ProfileView = {
      userId: id,
      displayName: effectiveHandle(u), // real name lives in the encrypted blob below
      handle: effectiveHandle(u),
      nameColor: u.name_color ?? null,
      encrypted:
        profile && myKey
          ? {
              ciphertext: profile.ciphertext,
              iv: profile.iv,
              epoch: profile.epoch,
              sealedKey: JSON.parse(myKey.sealed_key) as SealedKey,
            }
          : null,
    };
    return view;
  });

  // ---------------------------------------------------------- Conversations

  app.get('/api/conversations', { preHandler: requireAuth }, async (request) => {
    const me = request.user!.id;
    const out: Conversation[] = [];
    for (const conv of db.listConversationsForUser(me)) {
      const c = toConversation(conv, me);
      if (c) out.push(c);
    }
    return out;
  });

  app.post('/api/conversations/dm', { preHandler: requireAuth }, async (request, reply) => {
    const me = request.user!.id;
    const b = request.body as Record<string, unknown> | null;
    const friendId = b?.friendId;
    if (typeof friendId !== 'string') return reply.code(400).send({ error: 'invalid friendId' });
    if (friendId === me || !db.areFriends(me, friendId)) {
      return reply.code(400).send({ error: 'not a friend' });
    }
    const dmKey = me < friendId ? `${me}:${friendId}` : `${friendId}:${me}`;

    // Idempotent: an existing DM wins, provided keys are ignored.
    const existing = db.getConversationByDmKey(dmKey);
    if (existing) {
      const c = toConversation(existing, me);
      if (c) return c;
    }

    const members = b?.members;
    if (!Array.isArray(members) || members.length !== 2) {
      return reply.code(400).send({ error: 'members must be exactly {me, friend}' });
    }
    const byUser = new Map<string, SealedMemberKey>();
    for (const m of members as unknown[]) {
      if (typeof m !== 'object' || m === null) return reply.code(400).send({ error: 'invalid member' });
      const mm = m as Record<string, unknown>;
      if (typeof mm.userId !== 'string' || !validSealedKey(mm.sealedKey)) {
        return reply.code(400).send({ error: 'invalid member' });
      }
      byUser.set(mm.userId, { userId: mm.userId, sealedKey: mm.sealedKey });
    }
    if (!byUser.has(me) || !byUser.has(friendId) || byUser.size !== 2) {
      return reply.code(400).send({ error: 'members must be exactly {me, friend}' });
    }

    const convId = newId();
    try {
      const tx = db.raw.transaction(() => {
        db.createConversation({ id: convId, kind: 'dm', createdBy: me, dmKey });
        for (const mk of byUser.values()) {
          db.addConversationMember({
            conversationId: convId,
            userId: mk.userId,
            sealedKey: JSON.stringify(mk.sealedKey),
            epoch: 0,
          });
        }
      });
      tx();
    } catch {
      // UNIQUE(dm_key) race: another request created it concurrently. Re-fetch.
      const raced = db.getConversationByDmKey(dmKey);
      if (raced) {
        const c = toConversation(raced, me);
        if (c) return c;
      }
      return reply.code(409).send({ error: 'conversation conflict' });
    }
    const conv = db.getConversation(convId)!;
    return toConversation(conv, me)!;
  });

  // Create a group conversation (3+ members: me + 2 or more friends). Unlike a
  // DM, a group isn't idempotent — each call makes a distinct group. The key is
  // sealed client-side to every member, so the server only stores opaque keys.
  app.post('/api/conversations/group', { preHandler: requireAuth }, async (request, reply) => {
    const me = request.user!.id;
    const members = (request.body as Record<string, unknown> | null)?.members;
    if (!Array.isArray(members) || members.length < 3) {
      return reply.code(400).send({ error: 'a group needs at least 3 members' });
    }
    const byUser = new Map<string, SealedMemberKey>();
    for (const m of members as unknown[]) {
      if (typeof m !== 'object' || m === null) return reply.code(400).send({ error: 'invalid member' });
      const mm = m as Record<string, unknown>;
      if (typeof mm.userId !== 'string' || !validSealedKey(mm.sealedKey)) {
        return reply.code(400).send({ error: 'invalid member' });
      }
      byUser.set(mm.userId, { userId: mm.userId, sealedKey: mm.sealedKey });
    }
    if (!byUser.has(me) || byUser.size !== members.length) {
      return reply.code(400).send({ error: 'members must include you, with no duplicates' });
    }
    // Every other member must currently be a friend of the creator.
    for (const userId of byUser.keys()) {
      if (userId === me) continue;
      if (!db.areFriends(me, userId)) return reply.code(400).send({ error: 'not a friend' });
    }

    const convId = newId();
    const tx = db.raw.transaction(() => {
      db.createConversation({ id: convId, kind: 'group', createdBy: me, dmKey: null });
      for (const mk of byUser.values()) {
        db.addConversationMember({
          conversationId: convId,
          userId: mk.userId,
          sealedKey: JSON.stringify(mk.sealedKey),
          epoch: 0,
          role: mk.userId === me ? 'owner' : 'member',
        });
      }
    });
    tx();
    return toConversation(db.getConversation(convId)!, me)!;
  });

  // ---- Group membership management (v3 phase 2) ----------------------------

  // Add a member (owner or admin). Adding mints a NEW epoch: the caller re-keys,
  // sealing the new key to every current member + the joiner, and (when
  // history='share') also seals every prior epoch key to the joiner so they can
  // back-scroll. 'fresh' starts their unread at the latest seq.
  app.post('/api/conversations/:id/members', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const me = request.user!.id;
    if (!ID_RE.test(id)) return reply.code(404).send({ error: 'not found' });
    const conv = db.getConversation(id);
    if (!conv || conv.kind !== 'group') return reply.code(404).send({ error: 'not found' });
    const mine = db.getConversationMember(id, me);
    if (!mine) return reply.code(403).send({ error: 'not a member' });
    if (!canManageMembers(mine.role as ConversationRole)) {
      return reply.code(403).send({ error: 'not allowed to add members' });
    }

    const b = request.body as Record<string, unknown> | null;
    const userId = b?.userId;
    const history = b?.history;
    const epoch = b?.epoch;
    if (typeof userId !== 'string') return reply.code(400).send({ error: 'invalid userId' });
    if (history !== 'share' && history !== 'fresh') return reply.code(400).send({ error: 'invalid history' });
    if (userId === me || db.getConversationMember(id, userId)) {
      return reply.code(409).send({ error: 'already a member' });
    }
    if (!db.areFriends(me, userId)) return reply.code(400).send({ error: 'not a friend' });

    const current = db.getConversationEpoch(id);
    if (epoch !== current + 1) return reply.code(409).send({ error: 'epoch mismatch' });

    const expected = new Set([...db.listConversationMemberIds(id), userId]);
    const sealed = parseSealedMemberKeys(b?.keys, expected);
    if (!sealed) return reply.code(400).send({ error: 'keys must cover all members + the new member' });

    let prior: SealedEpochKey[] = [];
    if (history === 'share') {
      const p = parseSealedEpochKeys(b?.priorKeys, current);
      if (!p) return reply.code(400).send({ error: 'priorKeys must cover epochs 0..current' });
      prior = p;
    }

    const lastSeq = db.getMaxSeq(id);
    db.raw.transaction(() => {
      for (const k of sealed) {
        const sk = JSON.stringify(k.sealedKey);
        if (k.userId === userId) {
          db.addConversationMember({
            conversationId: id,
            userId,
            sealedKey: sk,
            epoch: epoch as number,
            role: 'member',
            lastReadSeq: history === 'fresh' ? lastSeq : 0,
            // Fresh joiners can't read pre-join messages; share joiners get the
            // prior epoch keys above, so they keep full history (floor 0).
            sinceSeq: history === 'fresh' ? lastSeq : 0,
          });
        } else {
          db.setMemberEpochKey(id, k.userId, epoch as number, sk);
        }
      }
      for (const p of prior) db.addConversationKey(id, userId, p.epoch, JSON.stringify(p.sealedKey));
    })();
    hub.sendToUsers([...expected], { type: 'conversation-updated', conversationId: id });
    return toConversation(db.getConversation(id)!, me)!;
  });

  // Remove a member, or leave when :userId is yourself. Mints a new epoch sealed
  // to the REMAINING members; the target's keys are deleted, so they keep read
  // access up to removal (via keys already unsealed in memory) but nothing after.
  app.delete('/api/conversations/:id/members/:userId', { preHandler: requireAuth }, async (request, reply) => {
    const { id, userId: target } = request.params as { id: string; userId: string };
    const me = request.user!.id;
    if (!ID_RE.test(id)) return reply.code(404).send({ error: 'not found' });
    const conv = db.getConversation(id);
    if (!conv || conv.kind !== 'group') return reply.code(404).send({ error: 'not found' });
    const mine = db.getConversationMember(id, me);
    if (!mine) return reply.code(403).send({ error: 'not a member' });
    const targetMember = db.getConversationMember(id, target);
    if (!targetMember) return reply.code(404).send({ error: 'not a member' });

    const leaving = target === me;
    if (!leaving) {
      if (!canManageMembers(mine.role as ConversationRole)) {
        return reply.code(403).send({ error: 'not allowed to remove members' });
      }
      // Admins have owner-level powers — except they can never remove the owner.
      if (targetMember.role === 'owner') return reply.code(403).send({ error: 'cannot remove the owner' });
    }

    const remainingIds = db.listConversationMemberIds(id).filter((u) => u !== target);
    if (remainingIds.length < 2) return reply.code(400).send({ error: 'a group needs at least 2 members' });

    const current = db.getConversationEpoch(id);
    const b = request.body as Record<string, unknown> | null;
    if (b?.epoch !== current + 1) return reply.code(409).send({ error: 'epoch mismatch' });
    const sealed = parseSealedMemberKeys(b?.keys, new Set(remainingIds));
    if (!sealed) return reply.code(400).send({ error: 'keys must cover the remaining members' });

    db.raw.transaction(() => {
      // Owner leaving → ownership passes to the earliest-joined remaining member.
      if (leaving && targetMember.role === 'owner') {
        const heir = db.listConversationMembers(id).find((m) => m.user_id !== target);
        if (heir) db.setConversationMemberRole(id, heir.user_id, 'owner');
      }
      db.removeConversationMember(id, target);
      for (const k of sealed) db.setMemberEpochKey(id, k.userId, current + 1, JSON.stringify(k.sealedKey));
    })();
    hub.sendToUsers(remainingIds, { type: 'conversation-updated', conversationId: id });
    hub.sendToUser(target, { type: 'conversation-removed', conversationId: id });
    return { ok: true };
  });

  // Grant/revoke admin to another member. Owners and admins can manage roles;
  // the owner's role is immutable and you can't change your own.
  app.post('/api/conversations/:id/members/:userId/role', { preHandler: requireAuth }, async (request, reply) => {
    const { id, userId: target } = request.params as { id: string; userId: string };
    const me = request.user!.id;
    if (!ID_RE.test(id)) return reply.code(404).send({ error: 'not found' });
    const conv = db.getConversation(id);
    if (!conv || conv.kind !== 'group') return reply.code(404).send({ error: 'not found' });
    const mine = db.getConversationMember(id, me);
    if (!mine || !canManageMembers(mine.role as ConversationRole)) {
      return reply.code(403).send({ error: 'not allowed to change roles' });
    }
    if (target === me) return reply.code(400).send({ error: 'cannot change your own role' });
    const targetMember = db.getConversationMember(id, target);
    if (!targetMember) return reply.code(404).send({ error: 'not a member' });
    if (targetMember.role === 'owner') return reply.code(403).send({ error: 'cannot change the owner' });
    const role = (request.body as Record<string, unknown> | null)?.role;
    if (role !== 'admin' && role !== 'member') return reply.code(400).send({ error: 'invalid role' });
    db.setConversationMemberRole(id, target, role);
    hub.sendToUsers(db.listConversationMemberIds(id), { type: 'conversation-updated', conversationId: id });
    return toConversation(db.getConversation(id)!, me)!;
  });

  // Edit a group's name and/or E2EE icon (owner/admin). `name`/`icon` are each
  // optional; pass null to clear. The icon is opaque ciphertext (encrypted under
  // the conversation key client-side).
  app.patch('/api/conversations/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const me = request.user!.id;
    if (!ID_RE.test(id)) return reply.code(404).send({ error: 'not found' });
    const conv = db.getConversation(id);
    if (!conv || conv.kind !== 'group') return reply.code(404).send({ error: 'not found' });
    const mine = db.getConversationMember(id, me);
    if (!mine || !canManageMembers(mine.role as ConversationRole)) {
      return reply.code(403).send({ error: 'not allowed to edit this group' });
    }
    const b = (request.body ?? {}) as { name?: unknown; icon?: unknown };

    if ('name' in b) {
      if (b.name !== null && typeof b.name !== 'string') return reply.code(400).send({ error: 'invalid name' });
      const trimmed = typeof b.name === 'string' ? b.name.trim() : '';
      if (trimmed.length > CONVERSATION_NAME_MAX) return reply.code(400).send({ error: 'name too long' });
      db.setConversationName(id, trimmed || null);
    }
    if ('icon' in b) {
      if (b.icon === null) {
        db.setConversationIcon(id, null);
      } else {
        const ic = b.icon as Record<string, unknown>;
        if (typeof ic.ciphertext !== 'string' || typeof ic.iv !== 'string' || typeof ic.epoch !== 'number' || !Number.isInteger(ic.epoch)) {
          return reply.code(400).send({ error: 'invalid icon' });
        }
        db.setConversationIcon(id, { ct: ic.ciphertext, iv: ic.iv, epoch: ic.epoch });
      }
    }
    hub.sendToUsers(db.listConversationMemberIds(id), { type: 'conversation-updated', conversationId: id });
    return toConversation(db.getConversation(id)!, me)!;
  });

  // Create (or return) the thread rooted on a parent message. A thread is a
  // child conversation with its own key, sealed to ALL parent members — so it
  // reuses the entire message/reaction/realtime machinery.
  app.post('/api/conversations/:id/messages/:seq/thread', { preHandler: requireAuth }, async (request, reply) => {
    const { id, seq } = request.params as { id: string; seq: string };
    const me = request.user!.id;
    const parent = db.getConversation(id);
    if (!parent) return reply.code(404).send({ error: 'not found' });
    if (!canAccess(id, me)) return reply.code(403).send({ error: 'not a member' });
    if (parent.kind === 'thread') return reply.code(400).send({ error: 'cannot thread a thread' });
    const seqNum = Number(seq);
    if (!Number.isInteger(seqNum) || seqNum < 1 || seqNum > db.getMaxSeq(id)) {
      return reply.code(400).send({ error: 'invalid seq' });
    }

    // Idempotent: one thread per parent message.
    const existing = db.getThreadByParent(id, seqNum);
    if (existing) {
      const c = toConversation(existing, me);
      if (c) return c;
    }

    // Members must be exactly the parent's members (the thread key is sealed to
    // everyone who can see the parent).
    const parentMemberIds = new Set(db.listConversationMembers(id).map((m) => m.user_id));
    const members = (request.body as Record<string, unknown> | null)?.members;
    if (!Array.isArray(members) || members.length !== parentMemberIds.size) {
      return reply.code(400).send({ error: 'members must match the parent conversation' });
    }
    const byUser = new Map<string, SealedMemberKey>();
    for (const m of members as unknown[]) {
      if (typeof m !== 'object' || m === null) return reply.code(400).send({ error: 'invalid member' });
      const mm = m as Record<string, unknown>;
      if (typeof mm.userId !== 'string' || !validSealedKey(mm.sealedKey)) {
        return reply.code(400).send({ error: 'invalid member' });
      }
      byUser.set(mm.userId, { userId: mm.userId, sealedKey: mm.sealedKey });
    }
    if (byUser.size !== parentMemberIds.size || [...byUser.keys()].some((u) => !parentMemberIds.has(u))) {
      return reply.code(400).send({ error: 'members must match the parent conversation' });
    }

    const convId = newId();
    try {
      const tx = db.raw.transaction(() => {
        db.createConversation({ id: convId, kind: 'thread', createdBy: me, dmKey: null, parentId: id, parentSeq: seqNum });
        for (const mk of byUser.values()) {
          db.addConversationMember({
            conversationId: convId,
            userId: mk.userId,
            sealedKey: JSON.stringify(mk.sealedKey),
            epoch: 0,
          });
        }
      });
      tx();
    } catch {
      // UNIQUE(parent_id, parent_seq) race: re-fetch the winner.
      const raced = db.getThreadByParent(id, seqNum);
      if (raced) {
        const c = toConversation(raced, me);
        if (c) return c;
      }
      return reply.code(409).send({ error: 'thread conflict' });
    }
    return toConversation(db.getConversation(convId)!, me)!;
  });

  app.get('/api/conversations/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const me = request.user!.id;
    if (!ID_RE.test(id)) return reply.code(404).send({ error: 'not found' });
    if (!db.getConversation(id)) return reply.code(404).send({ error: 'not found' });
    if (!canAccess(id, me)) return reply.code(403).send({ error: 'not a member' });

    const q = request.query as { before?: string; limit?: string; channelId?: string };
    const channelId = resolveChannel(id, q.channelId, me);
    if (channelId === null) return reply.code(404).send({ error: 'channel not found' });
    let limit = q.limit ? Number(q.limit) : 50;
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    if (limit > 100) limit = 100;
    let before: number | undefined;
    if (q.before !== undefined) {
      const n = Number(q.before);
      if (Number.isFinite(n)) before = n;
    }
    const sinceSeq = db.getConversationMember(id, me)?.since_seq ?? 0;
    return db.listMessages(channelId, before, limit, sinceSeq).map(toMessage);
  });

  app.post('/api/conversations/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const me = request.user!.id;
    const conv = db.getConversation(id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    if (!canAccess(id, me)) return reply.code(403).send({ error: 'not a member' });

    const b = request.body as Record<string, unknown> | null;
    if (
      typeof b?.ciphertext !== 'string' || b.ciphertext.length < 1 || b.ciphertext.length > MAX_CIPHERTEXT ||
      typeof b.iv !== 'string' || b.iv.length > 256 ||
      typeof b.epoch !== 'number' || !Number.isFinite(b.epoch)
    ) {
      return reply.code(400).send({ error: 'invalid message payload' });
    }
    const channelId = resolveChannel(id, b.channelId, me);
    if (channelId === null) return reply.code(404).send({ error: 'channel not found' });
    const row = db.insertMessage({
      id: newId(),
      conversationId: id,
      channelId,
      senderId: me,
      epoch: b.epoch,
      ciphertext: b.ciphertext,
      iv: b.iv,
    });
    const message = toMessage(row);
    // Fan out to the channel's audience (private → its members; else all members).
    const memberIds = channelAudience(id, channelId);
    hub.sendToUsers(memberIds, { type: 'message', message });
    // Background push to recipients with no live socket (content-free; see push.ts).
    push.notifyNewMessage(id, me, memberIds);
    return message;
  });

  // Edit a message in place: re-encrypt the new text client-side under the same
  // epoch key, then PATCH the ciphertext. Only the original sender may edit (the
  // DB accessor's sender_id guard enforces it — a 403 otherwise).
  app.patch('/api/conversations/:id/messages/:seq', { preHandler: requireAuth }, async (request, reply) => {
    const { id, seq } = request.params as { id: string; seq: string };
    const me = request.user!.id;
    if (!db.getConversation(id)) return reply.code(404).send({ error: 'not found' });
    if (!canAccess(id, me)) return reply.code(403).send({ error: 'not a member' });
    const seqNum = Number(seq);
    if (!Number.isInteger(seqNum)) return reply.code(400).send({ error: 'invalid seq' });

    const b = request.body as Record<string, unknown> | null;
    if (
      typeof b?.ciphertext !== 'string' || b.ciphertext.length < 1 || b.ciphertext.length > MAX_CIPHERTEXT ||
      typeof b.iv !== 'string' || b.iv.length > 256
    ) {
      return reply.code(400).send({ error: 'invalid message payload' });
    }
    const row = db.editMessage({ conversationId: id, seq: seqNum, senderId: me, ciphertext: b.ciphertext, iv: b.iv });
    if (!row) return reply.code(403).send({ error: 'not your message' });
    const message = toMessage(row);
    hub.sendToUsers(channelAudience(id, row.channel_id), { type: 'message-edited', message });
    return message;
  });

  app.post('/api/conversations/:id/read', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const me = request.user!.id;
    if (!db.getConversation(id)) return reply.code(404).send({ error: 'not found' });
    if (!canAccess(id, me)) return reply.code(403).send({ error: 'not a member' });

    const b = request.body as Record<string, unknown> | null;
    if (typeof b?.seq !== 'number' || !Number.isFinite(b.seq)) {
      return reply.code(400).send({ error: 'invalid seq' });
    }
    const channelId = resolveChannel(id, b.channelId, me);
    if (channelId === null) return reply.code(404).send({ error: 'channel not found' });
    db.setLastReadSeq(id, channelId, me, b.seq);
    hub.sendToUsers(
      channelAudience(id, channelId),
      { type: 'read', conversationId: id, channelId, userId: me, seq: b.seq },
      me,
    );
    return { ok: true };
  });

  // ---- Reactions (emoji encrypted with the conversation key) ----

  app.get('/api/conversations/:id/reactions', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const me = request.user!.id;
    if (!db.getConversation(id)) return reply.code(404).send({ error: 'not found' });
    if (!canAccess(id, me)) return reply.code(403).send({ error: 'not a member' });
    const q = request.query as { channelId?: string };
    const channelId = resolveChannel(id, q.channelId, me);
    if (channelId === null) return reply.code(404).send({ error: 'channel not found' });
    const sinceSeq = db.getConversationMember(id, me)?.since_seq ?? 0;
    return db.listReactions(channelId, 5000, sinceSeq).map(toReaction);
  });

  app.post('/api/conversations/:id/messages/:seq/reactions', { preHandler: requireAuth }, async (request, reply) => {
    const { id, seq } = request.params as { id: string; seq: string };
    const me = request.user!.id;
    if (!db.getConversation(id)) return reply.code(404).send({ error: 'not found' });
    if (!canAccess(id, me)) return reply.code(403).send({ error: 'not a member' });
    const seqNum = Number(seq);
    if (!Number.isInteger(seqNum) || seqNum < 1) return reply.code(400).send({ error: 'invalid seq' });
    const b = request.body as Record<string, unknown> | null;
    if (
      typeof b?.ciphertext !== 'string' || b.ciphertext.length < 1 || b.ciphertext.length > 4096 ||
      typeof b.iv !== 'string' || b.iv.length > 256
    ) {
      return reply.code(400).send({ error: 'invalid reaction payload' });
    }
    // The reaction's channel is the one the target message actually lives in —
    // derived server-side, never trusted from the client, so a reaction can't be
    // mis-filed into another channel.
    const target = db.getMessageBySeq(id, seqNum);
    if (!target) return reply.code(400).send({ error: 'invalid seq' });
    // Must be able to reach the target's channel (blocks reacting in a private
    // channel you're not a member of).
    if (resolveChannel(id, target.channel_id, me) === null) return reply.code(403).send({ error: 'no channel access' });
    const row = db.addReaction({
      id: newId(),
      conversationId: id,
      channelId: target.channel_id,
      seq: seqNum,
      userId: me,
      ciphertext: b.ciphertext,
      iv: b.iv,
    });
    const reaction = toReaction(row);
    hub.sendToUsers(channelAudience(id, target.channel_id), { type: 'reaction', reaction });
    return reaction;
  });

  app.delete('/api/conversations/:id/reactions/:rid', { preHandler: requireAuth }, async (request, reply) => {
    const { id, rid } = request.params as { id: string; rid: string };
    const me = request.user!.id;
    if (!db.getConversation(id)) return reply.code(404).send({ error: 'not found' });
    if (!canAccess(id, me)) return reply.code(403).send({ error: 'not a member' });
    const existing = db.getReaction(rid);
    // Scope to this conversation, and only the owner may remove (IDOR guard).
    if (!existing || existing.conversation_id !== id) return reply.code(404).send({ error: 'not found' });
    if (!db.removeReaction(rid, me)) return reply.code(403).send({ error: 'not your reaction' });
    hub.sendToUsers(channelAudience(id, existing.channel_id), {
      type: 'reaction-removed',
      conversationId: id,
      channelId: existing.channel_id,
      id: rid,
    });
    return { ok: true };
  });

  // ---- Channels (v4): create / rename / reorder / delete (groups only) -------

  // Channel management mirrors member management: groups only, and gated on the
  // same manage-members permission (owner/admin). The general channel is virtual
  // (id === conversation id) and can't be created/renamed/reordered/deleted.
  function validChannelName(s: unknown): s is string {
    return typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= CHANNEL_NAME_MAX;
  }
  function requireChannelManager(convId: string, me: string): { code: number; error: string } | null {
    const conv = db.getConversation(convId);
    if (!conv || conv.kind !== 'group') return { code: 404, error: 'not found' };
    const mine = db.getConversationMember(convId, me);
    if (!mine) return { code: 403, error: 'not a member' };
    if (!canManageMembers(mine.role as ConversationRole)) return { code: 403, error: 'not allowed to manage channels' };
    return null;
  }

  app.post('/api/conversations/:id/channels', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const me = request.user!.id;
    if (!ID_RE.test(id)) return reply.code(404).send({ error: 'not found' });
    const err = requireChannelManager(id, me);
    if (err) return reply.code(err.code).send({ error: err.error });
    const b = request.body as Record<string, unknown> | null;
    if (!validChannelName(b?.name)) return reply.code(400).send({ error: 'invalid name' });
    const type = b?.type === 'voice' ? 'voice' : 'text';
    if (b?.type !== undefined && b.type !== 'text' && b.type !== 'voice') {
      return reply.code(400).send({ error: 'invalid type' });
    }
    if (db.countChannels(id) >= MAX_CHANNELS_PER_CONVERSATION) {
      return reply.code(409).send({ error: 'too many channels' });
    }
    // A private channel ships with a sealed channel key per initial member (a
    // subset of conversation members, which must include the creator). Open
    // channels (no `private`) carry no keys and stay conversation-wide.
    const isPrivate = b?.private === true;
    const sealed: SealedMemberKey[] = [];
    if (isPrivate) {
      // Members must be a non-empty set of distinct conversation members, sealed
      // the channel key, and must include the creator.
      const convMembers = new Set(db.listConversationMemberIds(id));
      const raw = b?.members;
      if (!Array.isArray(raw) || raw.length === 0) return reply.code(400).send({ error: 'private channel needs members' });
      const ids = new Set<string>();
      for (const m of raw as unknown[]) {
        if (typeof m !== 'object' || m === null) return reply.code(400).send({ error: 'invalid member' });
        const mm = m as Record<string, unknown>;
        if (typeof mm.userId !== 'string' || !validSealedKey(mm.sealedKey)) return reply.code(400).send({ error: 'invalid member' });
        if (!convMembers.has(mm.userId) || ids.has(mm.userId)) return reply.code(400).send({ error: 'members must be distinct conversation members' });
        ids.add(mm.userId);
        sealed.push({ userId: mm.userId, sealedKey: mm.sealedKey });
      }
      if (!ids.has(me)) return reply.code(400).send({ error: 'creator must be a member' });
    }
    const channelId = newId();
    db.raw.transaction(() => {
      db.createChannel({ id: channelId, conversationId: id, name: (b!.name as string).trim(), type, position: db.nextChannelPosition(id), private: isPrivate });
      for (const mk of sealed) db.addChannelMember({ channelId, userId: mk.userId, sealedKey: JSON.stringify(mk.sealedKey), epoch: 0 });
    })();
    // Open channel → tell everyone; private → only its members.
    const audience = isPrivate ? sealed.map((m) => m.userId) : db.listConversationMemberIds(id);
    hub.sendToUsers(audience, { type: 'channels-updated', conversationId: id });
    return toConversation(db.getConversation(id)!, me)!;
  });

  app.patch('/api/conversations/:id/channels/:channelId', { preHandler: requireAuth }, async (request, reply) => {
    const { id, channelId } = request.params as { id: string; channelId: string };
    const me = request.user!.id;
    if (!ID_RE.test(id) || !ID_RE.test(channelId)) return reply.code(404).send({ error: 'not found' });
    const err = requireChannelManager(id, me);
    if (err) return reply.code(err.code).send({ error: err.error });
    const ch = db.getChannel(channelId);
    if (!ch || ch.conversation_id !== id) return reply.code(404).send({ error: 'channel not found' });
    const b = request.body as Record<string, unknown> | null;
    if (!validChannelName(b?.name)) return reply.code(400).send({ error: 'invalid name' });
    db.renameChannel(channelId, (b!.name as string).trim());
    hub.sendToUsers(db.listConversationMemberIds(id), { type: 'channels-updated', conversationId: id });
    return toConversation(db.getConversation(id)!, me)!;
  });

  app.post('/api/conversations/:id/channels/reorder', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const me = request.user!.id;
    if (!ID_RE.test(id)) return reply.code(404).send({ error: 'not found' });
    const err = requireChannelManager(id, me);
    if (err) return reply.code(err.code).send({ error: err.error });
    const order = (request.body as Record<string, unknown> | null)?.order;
    const existing = db.listChannels(id).map((c) => c.id);
    // `order` must be a permutation of exactly the conversation's extra channels.
    if (
      !Array.isArray(order) ||
      order.length !== existing.length ||
      new Set(order).size !== order.length ||
      !order.every((o) => typeof o === 'string' && existing.includes(o))
    ) {
      return reply.code(400).send({ error: 'order must permute all channels' });
    }
    db.reorderChannels(id, order as string[]);
    hub.sendToUsers(db.listConversationMemberIds(id), { type: 'channels-updated', conversationId: id });
    return toConversation(db.getConversation(id)!, me)!;
  });

  app.delete('/api/conversations/:id/channels/:channelId', { preHandler: requireAuth }, async (request, reply) => {
    const { id, channelId } = request.params as { id: string; channelId: string };
    const me = request.user!.id;
    if (!ID_RE.test(id) || !ID_RE.test(channelId)) return reply.code(404).send({ error: 'not found' });
    const err = requireChannelManager(id, me);
    if (err) return reply.code(err.code).send({ error: err.error });
    const ch = db.getChannel(channelId);
    if (!ch || ch.conversation_id !== id) return reply.code(404).send({ error: 'channel not found' });
    db.deleteChannel(channelId);
    hub.sendToUsers(channelAudience(id, channelId), { type: 'channels-updated', conversationId: id, deletedChannelId: channelId });
    return { ok: true };
  });

  // ---- Private-channel membership (v5): grant / revoke (managers) ----------
  // Grant access to a private channel: mint a NEW channel epoch, sealing the new
  // key to every current channel member + the joiner; `history:'share'` also
  // seals every prior epoch key so they can read the back-scroll.
  app.post('/api/conversations/:id/channels/:channelId/members', { preHandler: requireAuth }, async (request, reply) => {
    const { id, channelId } = request.params as { id: string; channelId: string };
    const me = request.user!.id;
    if (!ID_RE.test(id) || !ID_RE.test(channelId)) return reply.code(404).send({ error: 'not found' });
    const err = requireChannelManager(id, me);
    if (err) return reply.code(err.code).send({ error: err.error });
    const ch = db.getChannel(channelId);
    if (!ch || ch.conversation_id !== id || ch.private === 0) return reply.code(404).send({ error: 'not a private channel' });

    const b = request.body as Record<string, unknown> | null;
    const userId = b?.userId;
    const history = b?.history;
    const epoch = b?.epoch;
    if (typeof userId !== 'string') return reply.code(400).send({ error: 'invalid userId' });
    if (history !== 'share' && history !== 'fresh') return reply.code(400).send({ error: 'invalid history' });
    if (!db.getConversationMember(id, userId)) return reply.code(400).send({ error: 'not a conversation member' });
    if (db.isChannelMember(channelId, userId)) return reply.code(409).send({ error: 'already a member' });

    const current = db.getChannelEpoch(channelId);
    if (epoch !== current + 1) return reply.code(409).send({ error: 'epoch mismatch' });
    const expected = new Set([...db.listChannelMemberIds(channelId), userId]);
    const sealed = parseSealedMemberKeys(b?.keys, expected);
    if (!sealed) return reply.code(400).send({ error: 'keys must cover all members + the new member' });
    let prior: SealedEpochKey[] = [];
    if (history === 'share') {
      const p = parseSealedEpochKeys(b?.priorKeys, current);
      if (!p) return reply.code(400).send({ error: 'priorKeys must cover epochs 0..current' });
      prior = p;
    }
    db.raw.transaction(() => {
      for (const k of sealed) {
        const sk = JSON.stringify(k.sealedKey);
        if (k.userId === userId) db.addChannelMember({ channelId, userId, sealedKey: sk, epoch: epoch as number });
        else db.setChannelMemberEpochKey(channelId, k.userId, epoch as number, sk);
      }
      for (const p of prior) db.addChannelKey(channelId, userId, p.epoch, JSON.stringify(p.sealedKey));
    })();
    hub.sendToUsers([...expected], { type: 'channels-updated', conversationId: id });
    return toConversation(db.getConversation(id)!, me)!;
  });

  // Revoke a member from a private channel: mint a new epoch sealed to the
  // REMAINING members; the target's keys are deleted (future-access cut).
  app.delete('/api/conversations/:id/channels/:channelId/members/:userId', { preHandler: requireAuth }, async (request, reply) => {
    const { id, channelId, userId: target } = request.params as { id: string; channelId: string; userId: string };
    const me = request.user!.id;
    if (!ID_RE.test(id) || !ID_RE.test(channelId)) return reply.code(404).send({ error: 'not found' });
    const err = requireChannelManager(id, me);
    if (err) return reply.code(err.code).send({ error: err.error });
    const ch = db.getChannel(channelId);
    if (!ch || ch.conversation_id !== id || ch.private === 0) return reply.code(404).send({ error: 'not a private channel' });
    if (!db.isChannelMember(channelId, target)) return reply.code(404).send({ error: 'not a member' });

    const remaining = db.listChannelMemberIds(channelId).filter((u) => u !== target);
    if (remaining.length < 1) return reply.code(400).send({ error: 'a private channel needs at least one member' });
    const current = db.getChannelEpoch(channelId);
    const b = request.body as Record<string, unknown> | null;
    if (b?.epoch !== current + 1) return reply.code(409).send({ error: 'epoch mismatch' });
    const sealed = parseSealedMemberKeys(b?.keys, new Set(remaining));
    if (!sealed) return reply.code(400).send({ error: 'keys must cover the remaining members' });
    db.raw.transaction(() => {
      db.removeChannelMember(channelId, target);
      for (const k of sealed) db.setChannelMemberEpochKey(channelId, k.userId, current + 1, JSON.stringify(k.sealedKey));
    })();
    hub.sendToUsers(remaining, { type: 'channels-updated', conversationId: id });
    hub.sendToUser(target, { type: 'channels-updated', conversationId: id, deletedChannelId: channelId });
    return { ok: true };
  });
}
