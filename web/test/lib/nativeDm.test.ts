import { describe, expect, it, vi, beforeEach } from 'vitest';

const native = vi.hoisted(() => ({
  friendsList: vi.fn(),
  dmConversationId: vi.fn(),
  relaySendMessage: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

const nativeChat = vi.hoisted(() => ({ loadHistoryLocal: vi.fn() }));
vi.mock('../../src/lib/nativeChat', () => nativeChat);

import { listDms, openDm, sendDm } from '../../src/lib/nativeDm';

beforeEach(() => vi.clearAllMocks());

describe('nativeDm', () => {
  it('lists one DM per friend, resolved to its conversation id', async () => {
    native.friendsList.mockResolvedValue([
      { contact_id: 'idA', handle: 'A#1', display_name: 'Alice' },
      { contact_id: 'idB', handle: 'B#2', display_name: null },
    ]);
    native.dmConversationId.mockImplementation((id: string) => Promise.resolve(`dm:${id}`));

    const dms = await listDms();
    expect(dms).toEqual([
      { contactId: 'idA', handle: 'A#1', displayName: 'Alice', conversationId: 'dm:idA' },
      { contactId: 'idB', handle: 'B#2', displayName: null, conversationId: 'dm:idB' },
    ]);
  });

  it('opens a DM: resolves the conversation id and loads the newest local page', async () => {
    native.dmConversationId.mockResolvedValue('dm:idA');
    nativeChat.loadHistoryLocal.mockResolvedValue([{ key: 'm1' }]);

    const { conversationId, messages } = await openDm('idA', 50);
    expect(conversationId).toBe('dm:idA');
    // channel id == conversation id (DMs have no sub-channels); reset = true.
    expect(nativeChat.loadHistoryLocal).toHaveBeenCalledWith('dm:idA', 'dm:idA', 50, true);
    expect(messages).toEqual([{ key: 'm1' }]);
  });

  it('sends a text to a friend by contact id', async () => {
    native.relaySendMessage.mockResolvedValue('msg-9');
    await expect(sendDm('idA', 'hi')).resolves.toBe('msg-9');
    expect(native.relaySendMessage).toHaveBeenCalledWith('idA', 'hi');
  });
});
