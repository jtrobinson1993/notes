import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const dm = vi.hoisted(() => ({
  listDms: vi.fn(),
  openDm: vi.fn(),
  sendDm: vi.fn(),
}));
vi.mock('../../src/lib/nativeDm', () => dm);

const grp = vi.hoisted(() => ({
  listGroups: vi.fn(),
  openGroup: vi.fn(),
  sendGroup: vi.fn(),
  createGroup: vi.fn(),
  addGroupMember: vi.fn(),
}));
vi.mock('../../src/lib/nativeGroup', () => grp);

const friends = vi.hoisted(() => ({
  createInvite: vi.fn(),
  redeemInvite: vi.fn(),
}));
vi.mock('../../src/lib/nativeFriends', () => friends);

const relay = vi.hoisted(() => ({ onMailIngested: vi.fn(() => () => {}) }));
vi.mock('../../src/lib/nativeRelay', () => relay);

const nativeMod = vi.hoisted(() => ({
  relayDeleteMessage: vi.fn(),
  relayEditMessage: vi.fn(),
  relayReact: vi.fn(),
  conversationReactions: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/lib/native', () => nativeMod);

import NativeChat from '../../src/components/NativeChat.vue';

const view = (over: Record<string, unknown>) => ({ seq: 0, senderId: '', text: '', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  dm.listDms.mockResolvedValue([
    { contactId: 'idA', handle: 'A#1', displayName: 'Alice', conversationId: 'dm:A', unread: 0 },
  ]);
  dm.openDm.mockResolvedValue({ conversationId: 'dm:A', messages: [] });
  grp.listGroups.mockResolvedValue([]);
  grp.openGroup.mockResolvedValue({ conversationId: 'grp:x', messages: [] });
  relay.onMailIngested.mockReturnValue(() => {});
  nativeMod.conversationReactions.mockResolvedValue([]);
});

describe('NativeChat', () => {
  it('lists DMs on mount and subscribes to live ingest', async () => {
    const w = mount(NativeChat);
    await flushPromises();
    expect(dm.listDms).toHaveBeenCalled();
    expect(relay.onMailIngested).toHaveBeenCalled();
    expect(w.text()).toContain('Alice');
  });

  it('opens a DM and renders its messages, own on the right', async () => {
    dm.openDm.mockResolvedValue({
      conversationId: 'dm:A',
      messages: [
        view({ key: 'm1', senderId: 'idA', text: 'hi there' }),
        view({ key: 'm2', senderId: 'self', text: 'hey' }),
      ],
    });
    const w = mount(NativeChat);
    await flushPromises();
    await w.find('[data-testid="dm-row"]').trigger('click'); // the DM row (0 = add)
    await flushPromises();
    expect(dm.openDm).toHaveBeenCalledWith('idA', 50);
    expect(w.text()).toContain('hi there');
    // own message row is right-aligned (column: actions + bubble, then chips)
    const own = w.findAll('li').find((li) => li.text().includes('hey'));
    expect(own?.classes()).toContain('items-end');
  });

  it('sends a draft via sendDm and reloads', async () => {
    dm.sendDm.mockResolvedValue('msg-1');
    const w = mount(NativeChat);
    await flushPromises();
    await w.find('[data-testid="dm-row"]').trigger('click');
    await flushPromises();

    await w.find('[data-testid="draft"]').setValue('hello');
    await w.find('[data-testid="composer"]').trigger('submit');
    await flushPromises();
    expect(dm.sendDm).toHaveBeenCalledWith('idA', 'hello');
    expect((w.find('[data-testid="draft"]').element as HTMLInputElement).value).toBe('');
  });

  it('creates an invite link', async () => {
    friends.createInvite.mockResolvedValue({ invite: 'accord://friend?i=abc', expiresAt: 1 });
    const w = mount(NativeChat);
    await flushPromises();
    await w.find('[data-testid="add-friend"]').trigger('click');
    await w.find('[data-testid="make-invite"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="invite-link"]').text()).toContain('accord://friend?i=abc');
  });

  it('reacts to a message and renders the reaction chip', async () => {
    nativeMod.relayReact.mockResolvedValue(undefined);
    dm.openDm.mockResolvedValue({
      conversationId: 'dm:A',
      messages: [view({ key: 'm1', senderId: 'idA', text: 'hi there' })],
    });
    // After reacting, the reaction is present in the store.
    nativeMod.conversationReactions
      .mockResolvedValueOnce([]) // initial open
      .mockResolvedValueOnce([{ message_id: 'm1', emoji: '👍', reactor_id: 'self' }]);

    const w = mount(NativeChat);
    await flushPromises();
    await w.find('[data-testid="dm-row"]').trigger('click');
    await flushPromises();

    await w.find('[data-testid="react-msg"]').trigger('click');
    await flushPromises();
    expect(nativeMod.relayReact).toHaveBeenCalledWith('idA', 'm1', '👍', true);
    const chip = w.find('[data-testid="reaction-chip"]');
    expect(chip.text()).toContain('👍');
    expect(chip.text()).toContain('1');
  });

  it('shows an unread badge from the DM list', async () => {
    dm.listDms.mockResolvedValue([
      { contactId: 'idA', handle: 'A#1', displayName: 'Alice', conversationId: 'dm:A', unread: 4 },
    ]);
    const w = mount(NativeChat);
    await flushPromises();
    expect(w.find('[data-testid="unread-badge"]').text()).toBe('4');
  });

  it('deletes an own message via relayDeleteMessage and shows the tombstone', async () => {
    nativeMod.relayDeleteMessage.mockResolvedValue(undefined);
    dm.openDm
      .mockResolvedValueOnce({
        conversationId: 'dm:A',
        messages: [view({ key: 'm2', senderId: 'self', text: 'oops' })],
      })
      .mockResolvedValueOnce({
        conversationId: 'dm:A',
        messages: [view({ key: 'm2', senderId: 'self', text: null })], // tombstoned
      });
    const w = mount(NativeChat);
    await flushPromises();
    await w.find('[data-testid="dm-row"]').trigger('click');
    await flushPromises();

    await w.find('[data-testid="delete-msg"]').trigger('click');
    await flushPromises();
    expect(nativeMod.relayDeleteMessage).toHaveBeenCalledWith('idA', 'm2');
    expect(w.text()).toContain('Message deleted');
  });

  it('edits an own message via relayEditMessage', async () => {
    nativeMod.relayEditMessage.mockResolvedValue(undefined);
    dm.openDm
      .mockResolvedValueOnce({
        conversationId: 'dm:A',
        messages: [view({ key: 'm2', senderId: 'self', text: 'typo' })],
      })
      .mockResolvedValueOnce({
        conversationId: 'dm:A',
        messages: [view({ key: 'm2', senderId: 'self', text: 'fixed', editedAt: 5 })],
      });
    const w = mount(NativeChat);
    await flushPromises();
    await w.find('[data-testid="dm-row"]').trigger('click');
    await flushPromises();

    await w.find('[data-testid="edit-msg"]').trigger('click');
    await w.find('[data-testid="edit-input"]').setValue('fixed');
    await w.find('[data-testid="edit-form"]').trigger('submit');
    await flushPromises();
    expect(nativeMod.relayEditMessage).toHaveBeenCalledWith('idA', 'm2', 'fixed');
    expect(w.text()).toContain('fixed');
    expect(w.text()).toContain('(edited)');
  });

  it('lists groups and opens/sends to one', async () => {
    grp.listGroups.mockResolvedValue([{ groupId: 'grp:x', name: 'Team', conversationId: 'grp:x', unread: 0 }]);
    grp.openGroup.mockResolvedValue({ conversationId: 'grp:x', messages: [view({ key: 'gm1', senderId: 'idA', text: 'group hi' })] });
    grp.sendGroup.mockResolvedValue('gm2');
    const w = mount(NativeChat);
    await flushPromises();
    expect(w.text()).toContain('Team');

    await w.find('[data-testid="group-row"]').trigger('click');
    await flushPromises();
    expect(grp.openGroup).toHaveBeenCalledWith('grp:x', 50);
    expect(w.text()).toContain('group hi');
    // group messages have no DM-only react/edit/delete actions
    expect(w.find('[data-testid="react-msg"]').exists()).toBe(false);

    await w.find('[data-testid="draft"]').setValue('yo');
    await w.find('[data-testid="composer"]').trigger('submit');
    await flushPromises();
    expect(grp.sendGroup).toHaveBeenCalledWith('grp:x', 'yo');
  });

  it('creates a group', async () => {
    grp.createGroup.mockResolvedValue('grp:new');
    const w = mount(NativeChat);
    await flushPromises();
    await w.find('[data-testid="new-group"]').setValue('Squad');
    await w.find('[data-testid="new-group-form"]').trigger('submit');
    await flushPromises();
    expect(grp.createGroup).toHaveBeenCalledWith('Squad');
  });

  it('adds a friend to a group', async () => {
    grp.listGroups.mockResolvedValue([{ groupId: 'grp:x', name: 'Team', conversationId: 'grp:x', unread: 0 }]);
    grp.addGroupMember.mockResolvedValue(undefined);
    const w = mount(NativeChat);
    await flushPromises();
    await w.find('[data-testid="group-row"]').trigger('click');
    await flushPromises();
    await w.find('[data-testid="add-member-toggle"]').trigger('click');
    await w.find('[data-testid="add-member-pick"]').trigger('click'); // the one DM friend (Alice)
    await flushPromises();
    expect(grp.addGroupMember).toHaveBeenCalledWith('grp:x', 'idA');
  });

  it('redeems an invite then refreshes the DM list', async () => {
    friends.redeemInvite.mockResolvedValue({ inviterHandle: 'B#2', relayTs: 1 });
    const w = mount(NativeChat);
    await flushPromises();
    await w.find('[data-testid="add-friend"]').trigger('click');
    await w.find('textarea').setValue('accord://friend?i=xyz');
    await w.find('[data-testid="redeem"]').trigger('click');
    await flushPromises();
    expect(friends.redeemInvite).toHaveBeenCalledWith('accord://friend?i=xyz');
    expect(dm.listDms).toHaveBeenCalledTimes(2); // mount + after redeem
  });
});
