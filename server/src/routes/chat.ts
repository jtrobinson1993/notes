import type { FastifyInstance } from 'fastify';
import type {
  ChatMessage,
  ChatReaction,
  Conversation,
  ConversationMember,
  Friend,
  FriendInvite,
  FriendRequest,
  ProfileInfo,
  SealedKey,
  SealedMemberKey,
} from '@notes/shared';
import { NAME_COLORS } from '@notes/shared';
import {
  effectiveDisplayName,
  type ConversationRow,
  type DB,
  type MessageRow,
  type ReactionRow,
} from '../db.js';
import type { Realtime } from '../realtime.js';
import { requireAuth } from '../session.js';
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

function toMessage(m: MessageRow): ChatMessage {
  return {
    conversationId: m.conversation_id,
    seq: m.seq,
    senderId: m.sender_id,
    epoch: m.epoch,
    ciphertext: m.ciphertext,
    iv: m.iv,
    createdAt: m.created_at,
  };
}

function toReaction(r: ReactionRow): ChatReaction {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: r.seq,
    userId: r.user_id,
    ciphertext: r.ciphertext,
    iv: r.iv,
    createdAt: r.created_at,
  };
}

export function chatRoutes(app: FastifyInstance, db: DB, hub: Realtime): void {
  // Build a Conversation for a given member, including their own sealed key.
  function toConversation(conv: ConversationRow, userId: string): Conversation | null {
    const mine = db.getConversationMember(conv.id, userId);
    if (!mine) return null;
    const members: ConversationMember[] = db.listConversationMembers(conv.id).map((m) => {
      const u = db.getUser(m.user_id);
      return {
        userId: m.user_id,
        displayName: u ? effectiveDisplayName(u) : `User-${m.user_id.slice(0, 6)}`,
        publicKey: u?.public_key ?? null,
        nameColor: u?.name_color ?? null,
      };
    });
    // DM access requires current friendship — unfriending revokes access
    // (history preserved; restored on re-friend). A 1:1 thread inherits the
    // same rule (it has the same two members as its parent DM).
    if (conv.kind === 'dm' || (conv.kind === 'thread' && members.length === 2)) {
      const other = members.find((m) => m.userId !== userId);
      if (other && !db.areFriends(userId, other.userId)) return null;
    }
    return {
      id: conv.id,
      kind: conv.kind as Conversation['kind'],
      members,
      sealedKey: JSON.parse(mine.sealed_key) as SealedKey,
      epoch: mine.epoch,
      lastSeq: db.getMaxSeq(conv.id),
      lastReadSeq: mine.last_read_seq,
      createdAt: conv.created_at,
      parentId: conv.parent_id,
      parentSeq: conv.parent_seq,
    };
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
      displayName: effectiveDisplayName(request.user!),
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
      return {
        id: r.id,
        userId: otherId,
        displayName: other ? effectiveDisplayName(other) : `User-${otherId.slice(0, 6)}`,
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
    const friend: Friend = {
      userId: otherId,
      displayName: other ? effectiveDisplayName(other) : `User-${otherId.slice(0, 6)}`,
      publicKey: other?.public_key ?? null,
      online: hub.isOnline(otherId),
    };
    // Push MY info to the other user.
    hub.sendToUser(otherId, {
      type: 'friend-accepted',
      friend: {
        userId: me,
        displayName: effectiveDisplayName(request.user!),
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
      return {
        userId: row.friend_id,
        displayName: u ? effectiveDisplayName(u) : `User-${row.friend_id.slice(0, 6)}`,
        publicKey: u?.public_key ?? null,
        online: hub.isOnline(row.friend_id),
      };
    });
  });

  app.delete('/api/friends/:userId', { preHandler: requireAuth }, async (request) => {
    const { userId } = request.params as { userId: string };
    db.deleteFriendPair(request.user!.id, userId);
    return { ok: true };
  });

  // ---------------------------------------------------------------- Profile

  app.get('/api/profile', { preHandler: requireAuth }, async (request) => {
    const info: ProfileInfo = {
      displayName: effectiveDisplayName(request.user!),
      nameColor: request.user!.name_color ?? null,
    };
    return info;
  });

  app.put('/api/profile', { preHandler: requireAuth }, async (request, reply) => {
    const me = request.user!.id;
    const b = request.body as Record<string, unknown> | null;
    // Both fields are optional; update whichever is present.
    if (b?.displayName !== undefined) {
      if (typeof b.displayName !== 'string') return reply.code(400).send({ error: 'invalid display name' });
      const trimmed = b.displayName.trim();
      if (trimmed.length < 1 || trimmed.length > 50) {
        return reply.code(400).send({ error: 'display name must be 1..50 chars' });
      }
      db.setDisplayName(me, trimmed);
    }
    if (b?.nameColor !== undefined) {
      const nc = b.nameColor;
      if (nc !== null && (typeof nc !== 'string' || !(NAME_COLORS as readonly string[]).includes(nc))) {
        return reply.code(400).send({ error: 'invalid name color' });
      }
      db.setNameColor(me, nc);
    }
    const u = db.getUser(me)!;
    const info: ProfileInfo = { displayName: effectiveDisplayName(u), nameColor: u.name_color ?? null };
    return info;
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

    const q = request.query as { before?: string; limit?: string };
    let limit = q.limit ? Number(q.limit) : 50;
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    if (limit > 100) limit = 100;
    let before: number | undefined;
    if (q.before !== undefined) {
      const n = Number(q.before);
      if (Number.isFinite(n)) before = n;
    }
    return db.listMessages(id, before, limit).map(toMessage);
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
    const row = db.insertMessage({
      id: newId(),
      conversationId: id,
      senderId: me,
      epoch: b.epoch,
      ciphertext: b.ciphertext,
      iv: b.iv,
    });
    const message = toMessage(row);
    // Fan out to ALL members (including the sender's other sockets).
    hub.sendToUsers(db.listConversationMemberIds(id), { type: 'message', message });
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
    db.setLastReadSeq(id, me, b.seq);
    hub.sendToUsers(
      db.listConversationMemberIds(id),
      { type: 'read', conversationId: id, userId: me, seq: b.seq },
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
    return db.listReactions(id).map(toReaction);
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
    const row = db.addReaction({ id: newId(), conversationId: id, seq: seqNum, userId: me, ciphertext: b.ciphertext, iv: b.iv });
    const reaction = toReaction(row);
    hub.sendToUsers(db.listConversationMemberIds(id), { type: 'reaction', reaction });
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
    hub.sendToUsers(db.listConversationMemberIds(id), { type: 'reaction-removed', conversationId: id, id: rid });
    return { ok: true };
  });
}
