import { describe, expect, it } from 'vitest';
import { createVoiceRooms, type VoicePeerInfo } from '../src/voiceRooms.js';
import { VOICE_MAX_PARTICIPANTS } from '@notes/shared';
import type { SealedKey } from '@notes/shared';

function peer(id: string): VoicePeerInfo {
  return { userId: id, displayName: `Name-${id}`, publicKey: `pk-${id}` };
}
function sk(tag: string): SealedKey {
  return { epk: `epk-${tag}`, iv: `iv-${tag}`, ct: `ct-${tag}` };
}
/** Seal the next-epoch key to exactly the given roster (what the owner submits). */
function bundle(epoch: number, userIds: string[]): { userId: string; sealedKey: SealedKey }[] {
  return userIds.map((u) => ({ userId: u, sealedKey: sk(`${epoch}-${u}`) }));
}

describe('voiceRooms — join', () => {
  it('first joiner owns the room and is asked to rekey epoch 0 sealed to themselves', () => {
    const v = createVoiceRooms();
    const r = v.join('room', peer('a'), 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notify).toEqual([]);
    expect(r.rekey).toEqual({ authorId: 'a', epoch: 0, roster: [peer('a')] });
    expect(v.ownerOf('room')).toBe('a');
    expect(v.size('room')).toBe(1);
    expect(v.epochOf('room')).toBe(-1); // not committed until applyRekey
  });

  it('second joiner: owner stays the oldest peer; rekey covers both; existing peer notified', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    const r = v.join('room', peer('b'), 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notify).toEqual(['a']);
    expect(r.rekey.authorId).toBe('a');
    expect(r.rekey.epoch).toBe(0); // still epoch 0 — nothing committed yet
    expect(r.rekey.roster.map((p) => p.userId).sort()).toEqual(['a', 'b']);
  });

  it('rejects a duplicate join by the same user', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    expect(v.join('room', peer('a'), 2)).toEqual({ ok: false, reason: 'already-joined' });
  });

  it('rejects joins past VOICE_MAX_PARTICIPANTS', () => {
    const v = createVoiceRooms();
    for (let i = 0; i < VOICE_MAX_PARTICIPANTS; i++) expect(v.join('room', peer(`u${i}`), i).ok).toBe(true);
    expect(v.size('room')).toBe(VOICE_MAX_PARTICIPANTS);
    expect(v.join('room', peer('overflow'), 99)).toEqual({ ok: false, reason: 'full' });
  });
});

describe('voiceRooms — applyRekey', () => {
  it('commits the owner-authored bundle and fans the keys out, advancing the epoch', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    v.join('room', peer('b'), 2);
    const res = v.applyRekey('room', 'a', 0, bundle(0, ['a', 'b']));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(v.epochOf('room')).toBe(0);
    expect(res.fanout).toHaveLength(2);
    expect(v.keysFor('room', 'b')).toEqual([{ epoch: 0, sealedKey: sk('0-b') }]);
  });

  it('rejects a rekey authored by a non-owner', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    v.join('room', peer('b'), 2);
    expect(v.applyRekey('room', 'b', 0, bundle(0, ['a', 'b']))).toEqual({ ok: false, reason: 'not-owner' });
  });

  it('rejects a stale / wrong epoch', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    expect(v.applyRekey('room', 'a', 5, bundle(5, ['a']))).toEqual({ ok: false, reason: 'stale-epoch' });
    // commit epoch 0, then resubmitting 0 is stale
    v.applyRekey('room', 'a', 0, bundle(0, ['a']));
    expect(v.applyRekey('room', 'a', 0, bundle(0, ['a']))).toEqual({ ok: false, reason: 'stale-epoch' });
  });

  it('rejects a bundle that does not cover exactly the current roster', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    v.join('room', peer('b'), 2);
    expect(v.applyRekey('room', 'a', 0, bundle(0, ['a'])).ok).toBe(false); // missing b
    expect(v.applyRekey('room', 'a', 0, bundle(0, ['a', 'b', 'c'])).ok).toBe(false); // extra c
    expect(v.applyRekey('room', 'a', 0, bundle(0, ['a', 'b'])).ok).toBe(true);
  });

  it('keeps targeting committed+1 across joins before a rekey commits', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    v.applyRekey('room', 'a', 0, bundle(0, ['a'])); // commit epoch 0
    v.join('room', peer('b'), 2); // asks for epoch 1
    const res = v.applyRekey('room', 'a', 1, bundle(1, ['a', 'b']));
    expect(res.ok).toBe(true);
    expect(v.epochOf('room')).toBe(1);
    expect(v.keysFor('room', 'a').map((k) => k.epoch)).toEqual([0, 1]);
  });
});

describe('voiceRooms — leave', () => {
  it('notifies remaining peers and requests a fresh rekey over the new roster', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    v.join('room', peer('b'), 2);
    v.applyRekey('room', 'a', 0, bundle(0, ['a', 'b']));
    const r = v.leave('room', 'b', 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roomClosed).toBe(false);
    expect(r.notify).toEqual(['a']);
    expect(r.rekey).toEqual({ authorId: 'a', epoch: 1, roster: [peer('a')] });
  });

  it('promotes a new owner when the owner leaves', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    v.join('room', peer('b'), 2);
    const r = v.leave('room', 'a', 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(v.ownerOf('room')).toBe('b');
    expect(r.rekey?.authorId).toBe('b');
  });

  it('closes the room when the last peer leaves', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    const r = v.leave('room', 'a', 2);
    expect(r).toEqual({ ok: true, roomClosed: true, notify: [], rekey: null });
    expect(v.size('room')).toBe(0);
    expect(v.ownerOf('room')).toBeNull();
  });

  it('is a no-op for an unknown room or non-member', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    expect(v.leave('room', 'ghost', 2)).toEqual({ ok: false });
    expect(v.leave('nope', 'a', 2)).toEqual({ ok: false });
  });
});

describe('voiceRooms — producers & roster', () => {
  it('records a producer and reports the other peers to notify', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    v.join('room', peer('b'), 2);
    v.join('room', peer('c'), 3);
    expect(v.setProducer('room', 'a', 'prod-a').sort()).toEqual(['b', 'c']);
    const a = v.roster('room').find((p) => p.userId === 'a');
    expect(a?.producerId).toBe('prod-a');
  });

  it('roster never exposes public keys (only display name + producer)', () => {
    const v = createVoiceRooms();
    v.join('room', peer('a'), 1);
    expect(v.roster('room')).toEqual([{ userId: 'a', displayName: 'Name-a', producerId: null }]);
  });

  it('owner election breaks joinedAt ties by userId deterministically', () => {
    const v = createVoiceRooms();
    v.join('room', peer('b'), 5);
    v.join('room', peer('a'), 5); // same join time
    expect(v.ownerOf('room')).toBe('a');
  });
});
