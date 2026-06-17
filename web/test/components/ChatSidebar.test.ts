import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ChannelInfo, Conversation, ConversationRole } from '@notes/shared';

const api = vi.hoisted(() => ({
  channelCreate: vi.fn(),
  channelRename: vi.fn(),
  channelDelete: vi.fn().mockResolvedValue({ ok: true }),
  conversations: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/lib/api', () => ({ api }));

import ChatSidebar from '../../src/components/ChatSidebar.vue';
import { useOrgStore, chKey } from '../../src/stores/organization';

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
    channels: [channel({ id: 'g1', name: 'general', isDefault: true, position: 0 }), ...extra],
    lastSeq: 0,
    lastReadSeq: 0,
    createdAt: 0,
  } as Conversation;
}
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

const stubs = {
  ChannelModal: { props: ['open', 'mode', 'initialName', 'busy'], template: '<div class="channel-modal" />' },
  PinPickerModal: { props: ['open', 'conversationId'], template: '<div class="pin-picker" />' },
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.clearAllMocks();
});

describe('ChatSidebar (unified tree)', () => {
  it('lists group channels and selects a text channel (but not a voice one)', async () => {
    const conv = group('owner', [
      channel({ id: 'c-text', name: 'random', type: 'text', position: 1 }),
      channel({ id: 'c-voice', name: 'Lounge', type: 'voice', position: 2 }),
    ]);
    const w = mount(ChatSidebar, { props: { conversation: conv, activeChannelId: 'g1' }, global: { stubs } });
    expect(w.text()).toContain('general');
    expect(w.text()).toContain('random');
    const btns = w.findAll('ul button');
    await btns.find((b) => b.text().includes('random'))!.trigger('click');
    await btns.find((b) => b.text().includes('Lounge'))!.trigger('click');
    const sel = w.emitted('select') ?? [];
    expect(sel).toContainEqual(['c-text']);
    expect(sel).not.toContainEqual(['c-voice']);
  });

  it('hides New channel from a plain member but shows folder/pin to everyone', () => {
    const member = mount(ChatSidebar, { props: { conversation: group('member'), activeChannelId: 'g1' }, global: { stubs } });
    expect(member.find('[aria-label="New channel"]').exists()).toBe(false);
    expect(member.find('[aria-label="New folder"]').exists()).toBe(true);
    expect(member.find('[aria-label="Pin a note"]').exists()).toBe(true);
    const owner = mount(ChatSidebar, { props: { conversation: group('owner'), activeChannelId: 'g1' }, global: { stubs } });
    expect(owner.find('[aria-label="New channel"]').exists()).toBe(true);
  });

  it('a DM shows a pins-only sidebar — its general channel is not listed', () => {
    const org = useOrgStore();
    org.pin('d1', 'note', 'n1');
    const w = mount(ChatSidebar, { props: { conversation: dm(), activeChannelId: 'd1' }, global: { stubs } });
    expect(w.text()).not.toContain('general');
    expect(w.find('[aria-label="New channel"]').exists()).toBe(false);
    expect(w.find('[title="Unpin"]').exists()).toBe(true); // the pinned note row
  });

  it('renders a pinned note and unpins it', async () => {
    const org = useOrgStore();
    org.pin('g1', 'note', 'n1');
    const w = mount(ChatSidebar, { props: { conversation: group('owner'), activeChannelId: 'g1' }, global: { stubs } });
    expect(w.find('[title="Unpin"]').exists()).toBe(true);
    await w.find('[title="Unpin"]').trigger('click');
    expect(org.isPinned('g1', 'note', 'n1')).toBe(false);
  });

  it('creates a chat folder (distinct from note folders)', async () => {
    const org = useOrgStore();
    vi.spyOn(globalThis, 'prompt').mockReturnValue('Docs');
    const w = mount(ChatSidebar, { props: { conversation: group('owner'), activeChannelId: 'g1' }, global: { stubs } });
    await w.find('[aria-label="New folder"]').trigger('click');
    expect(org.chatFolders('g1').map((f) => f.name)).toEqual(['Docs']);
    expect(org.sortedFolders).toEqual([]); // note folders untouched
  });

  it('deletes a channel via its hover action (manager)', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const conv = group('owner', [channel({ id: 'a', name: 'alpha', position: 1 })]);
    const w = mount(ChatSidebar, { props: { conversation: conv, activeChannelId: 'g1' }, global: { stubs } });
    await w.find('[title="Delete channel"]').trigger('click');
    expect(api.channelDelete).toHaveBeenCalledWith('g1', 'a');
  });

  it('reorders items by dragging one channel onto another (personal order)', async () => {
    const org = useOrgStore();
    const conv = group('owner', [channel({ id: 'a', name: 'alpha', position: 1 })]);
    const w = mount(ChatSidebar, { props: { conversation: conv, activeChannelId: 'g1' }, global: { stubs } });
    const btns = w.findAll('ul button');
    const alpha = btns.find((b) => b.text().includes('alpha'))!;
    const general = btns.find((b) => b.text().includes('general'))!;
    await alpha.trigger('dragstart');
    await general.trigger('drop');
    // alpha moved before general in the personal root order.
    expect(org.orderedChatItems('g1', null, [chKey('g1'), chKey('a')])).toEqual([chKey('a'), chKey('g1')]);
  });
});
