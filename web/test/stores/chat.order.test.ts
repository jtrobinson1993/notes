import { describe, expect, it } from 'vitest';
import { orderMessages, type ChatMessageView } from '../../src/stores/chat';

// Minimal view factory — only the fields orderMessages reads.
function view(p: Partial<ChatMessageView> & { channelId: string }): ChatMessageView {
  return {
    conversationId: p.conversationId ?? p.channelId,
    channelId: p.channelId,
    seq: p.seq ?? 0,
    senderId: 's',
    epoch: 0,
    ciphertext: '',
    iv: '',
    createdAt: p.createdAt ?? 0,
    text: p.text ?? 't',
    key: p.key,
    sortKey: p.sortKey,
  };
}

describe('orderMessages', () => {
  it('orders legacy messages by seq and dedups by (channel, seq)', () => {
    const out = orderMessages([
      view({ channelId: 'c', seq: 3, text: 'three' }),
      view({ channelId: 'c', seq: 1, text: 'one' }),
      view({ channelId: 'c', seq: 2, text: 'two' }),
      view({ channelId: 'c', seq: 2, text: 'two-edited' }), // same seq → replaces
    ]);
    expect(out.map((m) => m.text)).toEqual(['one', 'two-edited', 'three']);
  });

  it('orders v8 rows by relay_ts (sortKey) and dedups by id (key)', () => {
    const out = orderMessages([
      view({ channelId: 'c', key: 'm-b', sortKey: 200, text: 'b' }),
      view({ channelId: 'c', key: 'm-a', sortKey: 100, text: 'a' }),
      view({ channelId: 'c', key: 'm-a', sortKey: 100, text: 'a-again' }), // dupe id → replaces
      view({ channelId: 'c', key: 'm-c', sortKey: 300, text: 'c' }),
    ]);
    expect(out.map((m) => m.text)).toEqual(['a-again', 'b', 'c']);
  });

  it('breaks a sortKey tie by key (deterministic, D11 (relay_ts, id))', () => {
    const out = orderMessages([
      view({ channelId: 'c', key: 'm-z', sortKey: 5 }),
      view({ channelId: 'c', key: 'm-a', sortKey: 5 }),
    ]);
    expect(out.map((m) => m.key)).toEqual(['m-a', 'm-z']);
  });
});
