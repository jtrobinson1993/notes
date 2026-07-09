import { describe, expect, it, vi, beforeEach } from 'vitest';

const native = vi.hoisted(() => ({
  friendsList: vi.fn(),
  dmConversationId: vi.fn(),
  relaySendMessage: vi.fn(),
  dmMarkRead: vi.fn().mockResolvedValue(undefined),
  dmUnread: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../src/lib/native', () => native);

const nativeChat = vi.hoisted(() => ({ loadHistoryLocal: vi.fn() }));
vi.mock('../../src/lib/nativeChat', () => nativeChat);

import { listDms, openDm, sendDm } from '../../src/lib/nativeDm';

beforeEach(() => vi.clearAllMocks());

describe('nativeDm', () => {
  it('lists one DM per friend, resolved to its conversation id + unread count', async () => {
    native.friendsList.mockResolvedValue([
      { contact_id: 'idA', handle: 'A#1', display_name: 'Alice' },
      { contact_id: 'idB', handle: 'B#2', display_name: null },
    ]);
    native.dmConversationId.mockImplementation((id: string) => Promise.resolve(`dm:${id}`));
    native.dmUnread.mockImplementation((conv: string) => Promise.resolve(conv === 'dm:idA' ? 3 : 0));

    const dms = await listDms();
    expect(dms).toEqual([
      { contactId: 'idA', handle: 'A#1', displayName: 'Alice', conversationId: 'dm:idA', unread: 3 },
      { contactId: 'idB', handle: 'B#2', displayName: null, conversationId: 'dm:idB', unread: 0 },
    ]);
  });

  it('opens a DM: resolves the id, loads the newest page, and marks it read', async () => {
    native.dmConversationId.mockResolvedValue('dm:idA');
    nativeChat.loadHistoryLocal.mockResolvedValue([{ key: 'm1' }]);

    const { conversationId, messages } = await openDm('idA', 50);
    expect(conversationId).toBe('dm:idA');
    // channel id == conversation id (DMs have no sub-channels); reset = true.
    expect(nativeChat.loadHistoryLocal).toHaveBeenCalledWith('dm:idA', 'dm:idA', 50, true);
    expect(native.dmMarkRead).toHaveBeenCalledWith('dm:idA');
    expect(messages).toEqual([{ key: 'm1' }]);
  });

  it('sends a text to a friend by contact id', async () => {
    native.relaySendMessage.mockResolvedValue('msg-9');
    await expect(sendDm('idA', 'hi')).resolves.toBe('msg-9');
    expect(native.relaySendMessage).toHaveBeenCalledWith('idA', 'hi', undefined);
  });
});
