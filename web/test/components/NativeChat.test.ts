import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const dm = vi.hoisted(() => ({
  listDms: vi.fn(),
  openDm: vi.fn(),
  sendDm: vi.fn(),
}));
vi.mock('../../src/lib/nativeDm', () => dm);

const friends = vi.hoisted(() => ({
  createInvite: vi.fn(),
  redeemInvite: vi.fn(),
}));
vi.mock('../../src/lib/nativeFriends', () => friends);

const relay = vi.hoisted(() => ({ onMailIngested: vi.fn(() => () => {}) }));
vi.mock('../../src/lib/nativeRelay', () => relay);

import NativeChat from '../../src/components/NativeChat.vue';

const view = (over: Record<string, unknown>) => ({ seq: 0, senderId: '', text: '', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  dm.listDms.mockResolvedValue([
    { contactId: 'idA', handle: 'A#1', displayName: 'Alice', conversationId: 'dm:A' },
  ]);
  dm.openDm.mockResolvedValue({ conversationId: 'dm:A', messages: [] });
  relay.onMailIngested.mockReturnValue(() => {});
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
    await w.findAll('aside button')[1].trigger('click'); // the DM row (0 = add)
    await flushPromises();
    expect(dm.openDm).toHaveBeenCalledWith('idA', 50);
    expect(w.text()).toContain('hi there');
    // own message bubble is right-aligned + blue
    const own = w.findAll('li').find((li) => li.text() === 'hey');
    expect(own?.classes()).toContain('justify-end');
  });

  it('sends a draft via sendDm and reloads', async () => {
    dm.sendDm.mockResolvedValue('msg-1');
    const w = mount(NativeChat);
    await flushPromises();
    await w.findAll('aside button')[1].trigger('click');
    await flushPromises();

    await w.find('[data-testid="draft"]').setValue('hello');
    await w.find('form').trigger('submit');
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
