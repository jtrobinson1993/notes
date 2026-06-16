import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Conversation, ConversationMember, ConversationRole, Friend, ManagePolicy } from '@notes/shared';

const chat = vi.hoisted(() => ({
  addMember: vi.fn().mockResolvedValue(undefined),
  removeMember: vi.fn().mockResolvedValue(undefined),
  setMemberRole: vi.fn().mockResolvedValue(undefined),
  setManagePolicy: vi.fn().mockResolvedValue(undefined),
}));
const friendsList = vi.hoisted(() => ({ value: [] as Friend[] }));
vi.mock('../../src/stores/chat', () => ({ useChatStore: () => chat }));
vi.mock('../../src/stores/friends', () => ({ useFriendsStore: () => ({ friends: friendsList.value }) }));
vi.mock('../../src/stores/session', () => ({ useSessionStore: () => ({ user: { id: 'me' } }) }));

import ManageMembersModal from '../../src/components/ManageMembersModal.vue';

const member = (userId: string, role: ConversationRole): ConversationMember => ({
  userId, displayName: userId, publicKey: 'pk', nameColor: null, linkPreviews: false, role,
});

function makeConv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'g1', kind: 'group',
    members: [member('me', 'owner'), member('a', 'admin'), member('b', 'member')],
    sealedKey: { epk: '', iv: '', ct: '' }, epoch: 0, epochKeys: [], managePolicy: 'owner',
    myRole: 'owner', lastSeq: 0, lastReadSeq: 0, createdAt: 0, ...over,
  };
}

const stubs = { AppModal: { template: '<div><slot /></div>' } };
const mountModal = (conversation: Conversation) =>
  mount(ManageMembersModal, { props: { conversation, open: true }, global: { stubs } });
const buttonByText = (w: ReturnType<typeof mountModal>, text: string) =>
  w.findAll('button').find((b) => b.text().includes(text));

beforeEach(() => {
  vi.clearAllMocks();
  friendsList.value = [
    { userId: 'f', displayName: 'Fred', publicKey: 'pkf', online: false },
    { userId: 'b', displayName: 'b', publicKey: 'pkb', online: false }, // already a member → excluded
  ];
});

describe('ManageMembersModal — owner', () => {
  it('lists members with role badges and shows owner controls', () => {
    const w = mountModal(makeConv());
    expect(w.text()).toContain('Owner');
    expect(w.text()).toContain('Admin');
    // Add section + policy selector visible to the owner.
    expect(w.text()).toContain('Add a friend');
    expect(w.find('select').exists()).toBe(true);
    // Already-member 'b' is excluded from the add list; Fred is eligible.
    expect(w.text()).toContain('Fred');
  });

  it('adds a friend with the chosen history mode', async () => {
    const w = mountModal(makeConv());
    await buttonByText(w, 'Start fresh')!.trigger('click');
    await buttonByText(w, 'Fred')!.trigger('click');
    expect(chat.addMember).toHaveBeenCalledWith('g1', expect.objectContaining({ userId: 'f' }), 'fresh');
  });

  it('removes a non-owner member and toggles admin', async () => {
    const w = mountModal(makeConv());
    await buttonByText(w, 'Make admin')!.trigger('click'); // on member b
    expect(chat.setMemberRole).toHaveBeenCalledWith('g1', 'b', 'admin');
    // Two remove controls (admin a, member b); the last one is member b.
    const removes = w.findAll('button[title="Remove from group"]');
    expect(removes).toHaveLength(2);
    await removes[removes.length - 1]!.trigger('click');
    expect(chat.removeMember).toHaveBeenCalledWith('g1', 'b');
  });

  it('changing the policy calls setManagePolicy', async () => {
    const w = mountModal(makeConv());
    await w.get('select').setValue('open' as ManagePolicy);
    expect(chat.setManagePolicy).toHaveBeenCalledWith('g1', 'open');
  });
});

describe('ManageMembersModal — plain member under owner-only policy', () => {
  it('hides add/remove controls but still allows leaving', () => {
    const w = mountModal(makeConv({ myRole: 'member' }));
    expect(w.text()).not.toContain('Add a friend');
    expect(w.find('select').exists()).toBe(false);
    expect(w.find('button[title="Remove from group"]').exists()).toBe(false);
    expect(buttonByText(w, 'Leave')).toBeTruthy();
  });

  it('leaving calls removeMember with my own id', async () => {
    const w = mountModal(makeConv({ myRole: 'member' }));
    await buttonByText(w, 'Leave')!.trigger('click');
    expect(chat.removeMember).toHaveBeenCalledWith('g1', 'me');
  });
});
