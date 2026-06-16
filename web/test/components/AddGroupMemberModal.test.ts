import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Conversation, ConversationMember, ConversationRole, Friend } from '@notes/shared';

const chat = vi.hoisted(() => ({ addMember: vi.fn().mockResolvedValue(undefined) }));
const friendsList = vi.hoisted(() => ({ value: [] as Friend[] }));
vi.mock('../../src/stores/chat', () => ({ useChatStore: () => chat }));
vi.mock('../../src/stores/friends', () => ({ useFriendsStore: () => ({ friends: friendsList.value }) }));

import AddGroupMemberModal from '../../src/components/AddGroupMemberModal.vue';

const member = (userId: string, role: ConversationRole = 'member'): ConversationMember => ({
  userId, displayName: userId, publicKey: 'pk', nameColor: null, linkPreviews: false, role,
});
const conv: Conversation = {
  id: 'g1', kind: 'group', members: [member('me', 'owner'), member('b')],
  sealedKey: { epk: '', iv: '', ct: '' }, epoch: 0, epochKeys: [], myRole: 'owner',
  lastSeq: 0, lastReadSeq: 0, createdAt: 0,
};

const stubs = { AppModal: { template: '<div><slot /></div>' } };
const mountModal = () => mount(AddGroupMemberModal, { props: { conversation: conv, open: true }, global: { stubs } });
const byText = (w: ReturnType<typeof mountModal>, t: string) => w.findAll('button').find((b) => b.text().includes(t));

beforeEach(() => {
  vi.clearAllMocks();
  friendsList.value = [
    { userId: 'fred', displayName: 'Fred', publicKey: 'pkf', online: false },
    { userId: 'b', displayName: 'b', publicKey: 'pkb', online: false }, // already a member → excluded
    { userId: 'nokey', displayName: 'NoKey', publicKey: null, online: false }, // no key → excluded
  ];
});

describe('AddGroupMemberModal', () => {
  it('lists only eligible friends (not members, must have a key)', () => {
    const w = mountModal();
    expect(byText(w, 'Fred')).toBeTruthy();
    expect(byText(w, 'NoKey')).toBeFalsy();
    // 'b' is already a member — not offered.
    expect(w.findAll('li').some((li) => li.text() === 'b')).toBe(false);
  });

  it('adds with share-history by default', async () => {
    const w = mountModal();
    await byText(w, 'Fred')!.trigger('click');
    expect(chat.addMember).toHaveBeenCalledWith('g1', expect.objectContaining({ userId: 'fred' }), 'share');
  });

  it('adds with fresh history when toggled', async () => {
    const w = mountModal();
    await byText(w, 'Start fresh')!.trigger('click');
    await byText(w, 'Fred')!.trigger('click');
    expect(chat.addMember).toHaveBeenCalledWith('g1', expect.objectContaining({ userId: 'fred' }), 'fresh');
  });
});
