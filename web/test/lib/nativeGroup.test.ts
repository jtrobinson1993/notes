import { describe, expect, it, vi, beforeEach } from 'vitest';

const native = vi.hoisted(() => ({
  groupList: vi.fn(),
  groupCreate: vi.fn(),
  groupAddMember: vi.fn(),
  relaySendGroupMessage: vi.fn(),
  dmUnread: vi.fn().mockResolvedValue(0),
  dmMarkRead: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/native', () => native);

const nativeChat = vi.hoisted(() => ({ loadHistoryLocal: vi.fn() }));
vi.mock('../../src/lib/nativeChat', () => nativeChat);

import {
  addGroupMember,
  createGroup,
  listGroups,
  openGroup,
  sendGroup,
} from '../../src/lib/nativeGroup';

beforeEach(() => vi.clearAllMocks());

describe('nativeGroup', () => {
  it('lists groups with unread counts, conversation id == group id', async () => {
    native.groupList.mockResolvedValue([
      { group_id: 'grp:a', name: 'Team' },
      { group_id: 'grp:b', name: null },
    ]);
    native.dmUnread.mockImplementation((c: string) => Promise.resolve(c === 'grp:a' ? 2 : 0));
    expect(await listGroups()).toEqual([
      { groupId: 'grp:a', name: 'Team', conversationId: 'grp:a', unread: 2 },
      { groupId: 'grp:b', name: null, conversationId: 'grp:b', unread: 0 },
    ]);
  });

  it('opens a group: loads the newest page (channel == group id) + marks read', async () => {
    nativeChat.loadHistoryLocal.mockResolvedValue([{ key: 'm1' }]);
    const res = await openGroup('grp:a', 50);
    expect(nativeChat.loadHistoryLocal).toHaveBeenCalledWith('grp:a', 'grp:a', 50, true);
    expect(native.dmMarkRead).toHaveBeenCalledWith('grp:a');
    expect(res).toEqual({ conversationId: 'grp:a', messages: [{ key: 'm1' }] });
  });

  it('sends / creates / adds members through the core', async () => {
    native.relaySendGroupMessage.mockResolvedValue('m9');
    native.groupCreate.mockResolvedValue('grp:new');
    native.groupAddMember.mockResolvedValue(undefined);

    expect(await sendGroup('grp:a', 'hi')).toBe('m9');
    expect(native.relaySendGroupMessage).toHaveBeenCalledWith('grp:a', 'hi');
    expect(await createGroup('Team')).toBe('grp:new');
    expect(native.groupCreate).toHaveBeenCalledWith('Team');
    await addGroupMember('grp:a', 'contactX');
    expect(native.groupAddMember).toHaveBeenCalledWith('grp:a', 'contactX');
  });
});
