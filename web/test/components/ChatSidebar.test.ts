import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ChannelInfo, Conversation, ConversationRole } from '@notes/shared';

const api = vi.hoisted(() => ({
  channelCreate: vi.fn(),
  channelRename: vi.fn(),
  channelReorder: vi.fn(),
  channelDelete: vi.fn().mockResolvedValue({ ok: true }),
  conversations: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/lib/api', () => ({ api }));

import ChatSidebar from '../../src/components/ChatSidebar.vue';
import { useChatStore } from '../../src/stores/chat';
import { useOrgStore } from '../../src/stores/organization';

function dm(): Conversation {
  return {
    id: 'd1',
    kind: 'dm',
    members: [],
    sealedKey: { epk: '', iv: '', ct: '' },
    epoch: 0,
    epochKeys: [],
    myRole: 'member',
    channels: [channel({ id: 'd1', name: 'general', isDefault: true, position: 0 })],
    lastSeq: 0,
    lastReadSeq: 0,
    createdAt: 0,
  } as Conversation;
}

const channel = (over: Partial<ChannelInfo> & { id: string; name: string }): ChannelInfo => ({
  conversationId: 'g1',
  type: 'text',
  position: 0,
  isDefault: false,
  lastSeq: 0,
  lastReadSeq: 0,
  ...over,
});

function group(role: ConversationRole = 'owner', extra: ChannelInfo[] = []): Conversation {
  return {
    id: 'g1',
    kind: 'group',
    members: [],
    sealedKey: { epk: '', iv: '', ct: '' },
    epoch: 0,
    epochKeys: [],
    myRole: role,
    channels: [
      channel({ id: 'g1', name: 'general', isDefault: true, position: 0 }),
      ...extra,
    ],
    lastSeq: 0,
    lastReadSeq: 0,
    createdAt: 0,
  } as Conversation;
}

const stubs = {
  ChannelModal: { props: ['open', 'mode', 'initialName', 'busy'], template: '<div class="channel-modal" />' },
  PinPickerModal: { props: ['open', 'conversationId'], template: '<div class="pin-picker" />' },
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.clearAllMocks();
});

describe('ChatSidebar', () => {
  it('lists channels and selects a text channel (but not a voice one)', async () => {
    const conv = group('owner', [
      channel({ id: 'c-text', name: 'random', type: 'text', position: 1 }),
      channel({ id: 'c-voice', name: 'Lounge', type: 'voice', position: 2 }),
    ]);
    const w = mount(ChatSidebar, { props: { conversation: conv, activeChannelId: 'g1' }, global: { stubs } });
    expect(w.text()).toContain('general');
    expect(w.text()).toContain('random');
    expect(w.text()).toContain('Lounge');

    const buttons = w.findAll('ul button');
    await buttons.find((b) => b.text().includes('random'))!.trigger('click');
    await buttons.find((b) => b.text().includes('Lounge'))!.trigger('click');
    const events = w.emitted('select') ?? [];
    expect(events).toContainEqual(['c-text']);
    expect(events).not.toContainEqual(['c-voice']); // voice has no text stream yet
  });

  it('shows an unread badge for an unread, non-active channel', () => {
    const conv = group('owner', [channel({ id: 'c1', name: 'random', position: 1, lastSeq: 5, lastReadSeq: 2 })]);
    const w = mount(ChatSidebar, { props: { conversation: conv, activeChannelId: 'g1' }, global: { stubs } });
    expect(w.text()).toContain('3'); // 5 - 2 unread
  });

  it('hides management affordances from a plain member', () => {
    const w = mount(ChatSidebar, { props: { conversation: group('member'), activeChannelId: 'g1' }, global: { stubs } });
    expect(w.find('[aria-label="Create channel"]').exists()).toBe(false);
    expect(w.text()).not.toContain('Edit channels');
  });

  it('exposes create + edit to a manager, and persists the collapsed state', async () => {
    const w = mount(ChatSidebar, { props: { conversation: group('admin'), activeChannelId: 'g1' }, global: { stubs } });
    expect(w.find('[aria-label="Create channel"]').exists()).toBe(true);
    expect(w.text()).toContain('Edit channels');

    await w.find('[aria-label="Hide channels"]').trigger('click');
    expect(localStorage.getItem('chat:channels:open')).toBe('0');
    expect(w.find('[aria-label="Show channels"]').exists()).toBe(true);
  });

  it('reorders an extra channel up via edit mode', async () => {
    api.channelReorder.mockResolvedValue(group('owner'));
    const conv = group('owner', [
      channel({ id: 'a', name: 'alpha', position: 1 }),
      channel({ id: 'b', name: 'bravo', position: 2 }),
    ]);
    const w = mount(ChatSidebar, { props: { conversation: conv, activeChannelId: 'g1' }, global: { stubs } });
    await w.find('footer button').trigger('click'); // enter edit mode
    await w.find('[title="Move down"]').trigger('click'); // move alpha (first extra) down
    expect(api.channelReorder).toHaveBeenCalledWith('g1', ['b', 'a']);
  });

  it('a DM shows a pins-only sidebar — no channels or edit-channels', () => {
    const w = mount(ChatSidebar, { props: { conversation: dm(), activeChannelId: 'd1' }, global: { stubs } });
    expect(w.text()).toContain('Pinned');
    expect(w.text()).not.toContain('Channels');
    expect(w.text()).not.toContain('Edit channels');
  });

  it('renders pinned items and unpins one', async () => {
    const org = useOrgStore();
    const fid = org.createFolder('Specs');
    org.pin('g1', 'folder', fid);
    const w = mount(ChatSidebar, { props: { conversation: group('owner'), activeChannelId: 'g1' }, global: { stubs } });
    expect(w.text()).toContain('Specs');
    await w.find('[title="Unpin"]').trigger('click');
    expect(org.isPinned('g1', 'folder', fid)).toBe(false);
  });

  it('reorders channels by drag-and-drop', async () => {
    api.channelReorder.mockResolvedValue(group('owner'));
    const conv = group('owner', [
      channel({ id: 'a', name: 'alpha', position: 1 }),
      channel({ id: 'b', name: 'bravo', position: 2 }),
    ]);
    const w = mount(ChatSidebar, { props: { conversation: conv, activeChannelId: 'g1' }, global: { stubs } });
    await w.find('footer button').trigger('click'); // edit mode → channels draggable
    const btns = w.findAll('ul button');
    const alpha = btns.find((b) => b.text().includes('alpha'))!;
    const bravo = btns.find((b) => b.text().includes('bravo'))!;
    await alpha.trigger('dragstart');
    await bravo.trigger('drop');
    expect(api.channelReorder).toHaveBeenCalledWith('g1', ['b', 'a']);
  });

  it('deletes a channel after confirmation', async () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const conv = group('owner', [channel({ id: 'a', name: 'alpha', position: 1 })]);
    const w = mount(ChatSidebar, { props: { conversation: conv, activeChannelId: 'g1' }, global: { stubs } });
    await w.find('footer button').trigger('click');
    await w.find('[title="Delete"]').trigger('click');
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.channelDelete).toHaveBeenCalledWith('g1', 'a');
    confirmSpy.mockRestore();
  });
});
