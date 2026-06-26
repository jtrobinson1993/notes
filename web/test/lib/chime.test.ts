import { describe, expect, it } from 'vitest';
import { shouldChime } from '../../src/lib/chime';

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

  it('chimes when both unfocused and a different channel is open', () => {
    expect(shouldChime({ fromMe: false, channelOpen: false, focused: false })).toBe(true);
  });
});
