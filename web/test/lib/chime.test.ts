import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONV_MUTE_MS,
  GLOBAL_FLOOR_MS,
  clearChimeMute,
  gateChime,
  shouldChime,
  type ChimeGate,
} from '../../src/lib/chime';

describe('shouldChime', () => {
  it('never chimes for our own message', () => {
    expect(shouldChime({ fromMe: true, channelOpen: false, focused: false })).toBe(false);
    expect(shouldChime({ fromMe: true, channelOpen: true, focused: true })).toBe(false);
  });

  it('stays silent when the message lands in the open, focused channel', () => {
    expect(shouldChime({ fromMe: false, channelOpen: true, focused: true })).toBe(false);
  });

  it('chimes when the app is unfocused, even if the channel is open', () => {
    expect(shouldChime({ fromMe: false, channelOpen: true, focused: false })).toBe(true);
  });

  it('chimes when another channel is open, even while focused', () => {
    expect(shouldChime({ fromMe: false, channelOpen: false, focused: true })).toBe(true);
  });
});

describe('gateChime (per-conversation cooldown)', () => {
  let gate: ChimeGate;
  // Default: a message that deserves attention (someone else, not on-screen).
  const base = { conversationId: 'c1', fromMe: false, channelOpen: false, focused: false };

  beforeEach(() => {
    gate = { mutedUntil: new Map(), lastChimeAt: null };
  });

  it('chimes the first time a conversation needs attention', () => {
    expect(gateChime(gate, { ...base, now: 1_000 })).toBe(true);
  });

  it('mutes the conversation, then re-chimes only after the 10s window', () => {
    expect(gateChime(gate, { ...base, now: 0 })).toBe(true);
    expect(gateChime(gate, { ...base, now: 5_000 })).toBe(false); // within window
    expect(gateChime(gate, { ...base, now: 9_999 })).toBe(false);
    expect(gateChime(gate, { ...base, now: CONV_MUTE_MS })).toBe(true); // window elapsed
  });

  it('resets the window each time it actually chimes', () => {
    expect(gateChime(gate, { ...base, now: 0 })).toBe(true); // muted until 10_000
    expect(gateChime(gate, { ...base, now: CONV_MUTE_MS })).toBe(true); // muted until 20_000
    expect(gateChime(gate, { ...base, now: 15_000 })).toBe(false);
  });

  it('lifts the mute as soon as the conversation is read', () => {
    expect(gateChime(gate, { ...base, now: 0 })).toBe(true);
    expect(gateChime(gate, { ...base, now: 1_000 })).toBe(false);
    clearChimeMute(gate, 'c1');
    expect(gateChime(gate, { ...base, now: 1_001 })).toBe(true);
  });

  it('tracks conversations independently (once past the global floor)', () => {
    expect(gateChime(gate, { ...base, conversationId: 'a', now: 0 })).toBe(true);
    expect(gateChime(gate, { ...base, conversationId: 'b', now: 5_000 })).toBe(true); // other room, floor clear
    expect(gateChime(gate, { ...base, conversationId: 'a', now: 6_000 })).toBe(false); // a still muted (10s)
  });

  it('enforces a global floor across conversations', () => {
    expect(gateChime(gate, { ...base, conversationId: 'a', now: 0 })).toBe(true);
    // A different room within the floor is suppressed — and NOT marked alerted...
    expect(gateChime(gate, { ...base, conversationId: 'b', now: GLOBAL_FLOOR_MS - 1 })).toBe(false);
    expect(gate.mutedUntil.has('b')).toBe(false);
    // ...so once the floor clears, b's next message still rings.
    expect(gateChime(gate, { ...base, conversationId: 'b', now: GLOBAL_FLOOR_MS })).toBe(true);
  });

  it('never chimes nor records a mute for our own message', () => {
    expect(gateChime(gate, { ...base, fromMe: true, now: 0 })).toBe(false);
    expect(gate.mutedUntil.has('c1')).toBe(false);
  });

  it('does not chime while looking at the open, focused channel', () => {
    expect(gateChime(gate, { ...base, channelOpen: true, focused: true, now: 0 })).toBe(false);
    expect(gate.mutedUntil.has('c1')).toBe(false);
  });
});
