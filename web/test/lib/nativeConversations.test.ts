import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  isNative: true,
  conversationActivity: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

const dm = vi.hoisted(() => ({ listDms: vi.fn() }));
vi.mock('../../src/lib/nativeDm', () => dm);

const grp = vi.hoisted(() => ({ listGroups: vi.fn() }));
vi.mock('../../src/lib/nativeGroup', () => grp);

vi.mock('../../src/lib/nativeRelay', () => ({ onMailIngested: vi.fn(() => () => {}) }));

import { nativeConversations, refreshNativeConversations } from '../../src/lib/nativeConversations';

beforeEach(() => {
  vi.clearAllMocks();
  nativeConversations.value = [];
  dm.listDms.mockResolvedValue([]);
  grp.listGroups.mockResolvedValue([]);
  native.conversationActivity.mockResolvedValue([]);
});

describe('nativeConversations', () => {
  it('lists every friend + group, most recent activity first', async () => {
    dm.listDms.mockResolvedValue([
      { contactId: 'idA', handle: 'Ant#1', displayName: 'Alice', conversationId: 'dm:A', unread: 2 },
      { contactId: 'idB', handle: 'Bee#2', displayName: null, conversationId: 'dm:B', unread: 0 },
    ]);
    grp.listGroups.mockResolvedValue([
      { groupId: 'g1', name: 'Book club', conversationId: 'g1', unread: 1 },
    ]);
    native.conversationActivity.mockResolvedValue([
      { conversation_id: 'dm:A', last_ts: 10, unread: 2 },
      { conversation_id: 'g1', last_ts: 50, unread: 1 },
      { conversation_id: 'dm:B', last_ts: 30, unread: 0 },
    ]);

    await refreshNativeConversations();

    expect(nativeConversations.value.map((c) => c.key)).toEqual(['grp:g1', 'dm:idB', 'dm:idA']);
    expect(nativeConversations.value[0]).toMatchObject({
      kind: 'group',
      title: 'Book club',
      initial: 'B',
      unread: 1,
      lastTs: 50,
    });
    // The friend with no display name shows their handle.
    expect(nativeConversations.value[1]).toMatchObject({ title: 'Bee#2', initial: 'B', lastTs: 30 });
  });

  it('keeps a friend I have never messaged, ordered after the active chats by name', async () => {
    dm.listDms.mockResolvedValue([
      { contactId: 'idZ', handle: 'Zed#9', displayName: 'Zoe', conversationId: 'dm:Z', unread: 0 },
      { contactId: 'idA', handle: 'Ant#1', displayName: 'Alice', conversationId: 'dm:A', unread: 0 },
      { contactId: 'idC', handle: 'Cat#3', displayName: 'Cara', conversationId: 'dm:C', unread: 0 },
    ]);
    // Only Cara has traffic; Alice and Zoe have no messages at all (no rows).
    native.conversationActivity.mockResolvedValue([{ conversation_id: 'dm:C', last_ts: 7, unread: 0 }]);

    await refreshNativeConversations();

    expect(nativeConversations.value.map((c) => c.title)).toEqual(['Cara', 'Alice', 'Zoe']);
    expect(nativeConversations.value.map((c) => c.lastTs)).toEqual([7, 0, 0]);
  });
});
