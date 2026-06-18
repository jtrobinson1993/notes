import { VOICE_MAX_PARTICIPANTS } from '@notes/shared';
import type { SealedKey, SealedEpochKey, VoicePeer } from '@notes/shared';

// In-memory voice-room state machine — the signalling logic, decoupled from
// mediasoup and the HTTP/WS layer so it can be unit-tested in isolation.
//
// E2EE media-key model (see spec/voice.md): each room has a per-call media key
// distributed per **epoch**, sealed to each participant's X25519 key (reusing
// the note/channel sharing primitive). To avoid races when several people join/
// leave at once, exactly one participant — the **owner** (deterministically the
// longest-present peer) — authors every rekey: on any roster change the owner is
// asked to mint `epoch = committed + 1` sealed to the *current* roster, and the
// server fans the sealed keys out. All of this state is ephemeral (a process
// restart drops live calls), so it lives in memory only.

export interface VoicePeerInfo {
  userId: string;
  displayName: string;
  /** base64 X25519 public key — required so the owner can seal the media key to them */
  publicKey: string;
}

interface PeerState extends VoicePeerInfo {
  /** monotonic join time; with userId it deterministically orders owner election */
  joinedAt: number;
  /** the peer's mediasoup audio producer id, or null until they send mic */
  producerId: string | null;
}

interface RoomState {
  roomId: string;
  peers: Map<string, PeerState>;
  /** highest committed epoch (with keys), or -1 before the first rekey commits */
  epoch: number;
  /** epoch the owner has been asked to supply keys for, or null if none outstanding */
  pendingEpoch: number | null;
  /** committed sealed keys: epoch -> (userId -> sealed key). Ephemeral. */
  keys: Map<number, Map<string, SealedKey>>;
}

/** Who must author the next rekey, for which epoch, over which roster. The HTTP/WS
 *  layer turns this into a `voice-rekey-needed`-style request to the author. */
export interface RekeyRequest {
  authorId: string;
  epoch: number;
  roster: VoicePeerInfo[];
}

export type JoinResult =
  | { ok: false; reason: 'already-joined' | 'full' }
  | {
      ok: true;
      /** existing peers to notify with `voice-peer-joined` (excludes the joiner) */
      notify: string[];
      /** the rekey to request from the owner so the joiner gets a key */
      rekey: RekeyRequest;
    };

export type LeaveResult =
  | { ok: false }
  | {
      ok: true;
      roomClosed: boolean;
      /** remaining peers to notify with `voice-peer-left` */
      notify: string[];
      /** rekey to request (null when the room is now empty) */
      rekey: RekeyRequest | null;
    };

export type RekeyResult =
  | { ok: false; reason: 'no-room' | 'not-owner' | 'stale-epoch' | 'roster-mismatch' }
  | { ok: true; fanout: { userId: string; epoch: number; sealedKey: SealedKey }[] };

export interface VoiceRooms {
  join(roomId: string, peer: VoicePeerInfo, now: number): JoinResult;
  leave(roomId: string, userId: string, now: number): LeaveResult;
  /** Record a peer's audio producer; returns peers to notify with `voice-new-producer`. */
  setProducer(roomId: string, userId: string, producerId: string): string[];
  applyRekey(roomId: string, authorId: string, epoch: number, sealed: { userId: string; sealedKey: SealedKey }[]): RekeyResult;
  has(roomId: string, userId: string): boolean;
  ownerOf(roomId: string): string | null;
  roster(roomId: string): VoicePeer[];
  epochOf(roomId: string): number;
  /** Every committed epoch key sealed to `userId` (for the join response). */
  keysFor(roomId: string, userId: string): SealedEpochKey[];
  size(roomId: string): number;
}

export function createVoiceRooms(): VoiceRooms {
  const rooms = new Map<string, RoomState>();

  /** Owner = the longest-present peer; ties broken by userId for determinism. */
  function ownerId(room: RoomState): string | null {
    let best: PeerState | null = null;
    for (const p of room.peers.values()) {
      if (!best || p.joinedAt < best.joinedAt || (p.joinedAt === best.joinedAt && p.userId < best.userId)) {
        best = p;
      }
    }
    return best?.userId ?? null;
  }

  function rosterInfo(room: RoomState): VoicePeerInfo[] {
    return [...room.peers.values()].map((p) => ({ userId: p.userId, displayName: p.displayName, publicKey: p.publicKey }));
  }

  /** Build the rekey request for the room's next epoch over its current roster. */
  function requestRekey(room: RoomState): RekeyRequest {
    const next = room.epoch + 1;
    room.pendingEpoch = next;
    return { authorId: ownerId(room)!, epoch: next, roster: rosterInfo(room) };
  }

  function join(roomId: string, peer: VoicePeerInfo, now: number): JoinResult {
    let room = rooms.get(roomId);
    if (!room) {
      room = { roomId, peers: new Map(), epoch: -1, pendingEpoch: null, keys: new Map() };
      rooms.set(roomId, room);
    }
    if (room.peers.has(peer.userId)) return { ok: false, reason: 'already-joined' };
    if (room.peers.size >= VOICE_MAX_PARTICIPANTS) return { ok: false, reason: 'full' };

    const notify = [...room.peers.keys()];
    room.peers.set(peer.userId, { ...peer, joinedAt: now, producerId: null });
    return { ok: true, notify, rekey: requestRekey(room) };
  }

  function leave(roomId: string, userId: string, now: number): LeaveResult {
    const room = rooms.get(roomId);
    if (!room || !room.peers.has(userId)) return { ok: false };
    room.peers.delete(userId);
    if (room.peers.size === 0) {
      rooms.delete(roomId);
      return { ok: true, roomClosed: true, notify: [], rekey: null };
    }
    const notify = [...room.peers.keys()];
    return { ok: true, roomClosed: false, notify, rekey: requestRekey(room) };
  }

  function setProducer(roomId: string, userId: string, producerId: string): string[] {
    const room = rooms.get(roomId);
    const peer = room?.peers.get(userId);
    if (!room || !peer) return [];
    peer.producerId = producerId;
    return [...room.peers.keys()].filter((id) => id !== userId);
  }

  function applyRekey(
    roomId: string,
    authorId: string,
    epoch: number,
    sealed: { userId: string; sealedKey: SealedKey }[],
  ): RekeyResult {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, reason: 'no-room' };
    if (ownerId(room) !== authorId) return { ok: false, reason: 'not-owner' };
    if (epoch !== room.epoch + 1 || epoch !== room.pendingEpoch) return { ok: false, reason: 'stale-epoch' };

    // The sealed set must cover EXACTLY the current roster (no missing/extra users).
    const rosterIds = new Set(room.peers.keys());
    const sealedIds = new Set(sealed.map((s) => s.userId));
    if (sealedIds.size !== sealed.length || sealedIds.size !== rosterIds.size) return { ok: false, reason: 'roster-mismatch' };
    for (const id of sealedIds) if (!rosterIds.has(id)) return { ok: false, reason: 'roster-mismatch' };

    const byUser = new Map<string, SealedKey>();
    for (const s of sealed) byUser.set(s.userId, s.sealedKey);
    room.keys.set(epoch, byUser);
    room.epoch = epoch;
    room.pendingEpoch = null;
    return { ok: true, fanout: sealed.map((s) => ({ userId: s.userId, epoch, sealedKey: s.sealedKey })) };
  }

  function has(roomId: string, userId: string): boolean {
    return !!rooms.get(roomId)?.peers.has(userId);
  }

  function ownerOf(roomId: string): string | null {
    const room = rooms.get(roomId);
    return room ? ownerId(room) : null;
  }

  function roster(roomId: string): VoicePeer[] {
    const room = rooms.get(roomId);
    if (!room) return [];
    return [...room.peers.values()].map((p) => ({ userId: p.userId, displayName: p.displayName, producerId: p.producerId }));
  }

  function epochOf(roomId: string): number {
    return rooms.get(roomId)?.epoch ?? -1;
  }

  function keysFor(roomId: string, userId: string): SealedEpochKey[] {
    const room = rooms.get(roomId);
    if (!room) return [];
    const out: SealedEpochKey[] = [];
    for (const [epoch, byUser] of room.keys) {
      const sealedKey = byUser.get(userId);
      if (sealedKey) out.push({ epoch, sealedKey });
    }
    return out.sort((a, b) => a.epoch - b.epoch);
  }

  function size(roomId: string): number {
    return rooms.get(roomId)?.peers.size ?? 0;
  }

  return { join, leave, setProducer, applyRekey, has, ownerOf, roster, epochOf, keysFor, size };
}
