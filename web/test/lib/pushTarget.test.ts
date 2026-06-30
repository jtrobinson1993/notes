import { describe, expect, it } from 'vitest';
import { pushTargetUrl } from '../../src/lib/pushTarget';

describe('pushTargetUrl', () => {
  it('opens the conversation (general channel) and scrolls to the message', () => {
    // channelId === conversationId → no extra path segment.
    expect(pushTargetUrl({ type: 'message', conversationId: 'c1', channelId: 'c1', seq: 7 })).toBe(
      '/chat/c1?m=7',
    );
  });

  it('adds the channel segment when the message is in a non-general channel', () => {
    expect(pushTargetUrl({ type: 'message', conversationId: 'c1', channelId: 'ch9', seq: 3 })).toBe(
      '/chat/c1/ch9?m=3',
    );
  });

  it('opens the parent and the thread panel for a thread message', () => {
    expect(
      pushTargetUrl({ type: 'message', conversationId: 'p1', channelId: 'p1', seq: 12, threadParentSeq: 4 }),
    ).toBe('/chat/p1?thread=4&m=12');
  });

  it('routes a reaction ping to the reacted message, like a message ping', () => {
    expect(pushTargetUrl({ type: 'reaction', conversationId: 'c1', channelId: 'c1', seq: 9 })).toBe(
      '/chat/c1?m=9',
    );
    expect(pushTargetUrl({ type: 'reaction', conversationId: 'c1', channelId: 'ch9', seq: 3 })).toBe(
      '/chat/c1/ch9?m=3',
    );
    expect(
      pushTargetUrl({ type: 'reaction', conversationId: 'p1', channelId: 'p1', seq: 12, threadParentSeq: 4 }),
    ).toBe('/chat/p1?thread=4&m=12');
  });

  it('opens the conversation for a call ping', () => {
    expect(pushTargetUrl({ type: 'call', conversationId: 'c1' })).toBe('/chat/c1');
  });

  it('falls back to the app root for missing/unknown payloads', () => {
    expect(pushTargetUrl(null)).toBe('/');
    expect(pushTargetUrl(undefined)).toBe('/');
    expect(pushTargetUrl({ type: 'message' } as never)).toBe('/');
  });
});
