import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Conversation, ConversationMember, ConversationRole } from '@notes/shared';

const chat = vi.hoisted(() => ({
  removeMember: vi.fn().mockResolvedValue(undefined),
  setMemberRole: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/stores/chat', () => ({ useChatStore: () => chat }));
vi.mock('../../src/stores/session', () => ({ useSessionStore: () => ({ user: { id: 'me' } }) }));

import ManageMembersDrawer from '../../src/components/ManageMembersDrawer.vue';

const member = (userId: string, role: ConversationRole): ConversationMember => ({
  userId, displayName: userId, publicKey: 'pk', nameColor: null, linkPreviews: false, role,
});

function makeConv(myRole: ConversationRole, over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'g1', kind: 'group',
    members: [member('me', myRole), member('a', 'admin'), member('b', 'member')],
    sealedKey: { epk: '', iv: '', ct: '' }, epoch: 0, epochKeys: [], myRole,
    lastSeq: 0, lastReadSeq: 0, createdAt: 0, ...over,
  };
}

// Render the drawer's slot inline; stub the add-friend modal.
const stubs = { AppDrawer: { template: '<div><slot /></div>' }, AddGroupMemberModal: true };
const mountDrawer = (conversation: Conversation) =>
  mount(ManageMembersDrawer, { props: { conversation, open: true }, global: { stubs } });
const byText = (w: ReturnType<typeof mountDrawer>, text: string) =>
  w.findAll('button').find((b) => b.text().includes(text));

beforeEach(() => vi.clearAllMocks());

describe('ManageMembersDrawer — owner/admin (can manage)', () => {
  it('shows the add-friend button, badges, and per-member controls', () => {
    const w = mountDrawer(makeConv('owner'));
    expect(byText(w, 'Add friend')).toBeTruthy();
    expect(w.text()).toContain('Owner');
    expect(w.text()).toContain('Admin');
    // Remove controls are X-icon buttons (one each for admin a + member b).
    expect(w.findAll('button[title="Remove from group"]')).toHaveLength(2);
    expect(byText(w, 'Leave')).toBeTruthy(); // I can leave
  });

  it('an admin (not owner) also gets the management controls', () => {
    const w = mountDrawer(makeConv('admin'));
    expect(byText(w, 'Add friend')).toBeTruthy();
    expect(w.findAll('button[title="Remove from group"]').length).toBeGreaterThan(0);
  });

  it('removing and role changes call the store; owner row has no controls', async () => {
    const w = mountDrawer(makeConv('owner'));
    await byText(w, 'Make admin')!.trigger('click'); // on member b
    expect(chat.setMemberRole).toHaveBeenCalledWith('g1', 'b', 'admin');
    const removes = w.findAll('button[title="Remove from group"]');
    await removes[removes.length - 1]!.trigger('click'); // member b is last
    expect(chat.removeMember).toHaveBeenCalledWith('g1', 'b');
  });

  it('leaving calls removeMember with my own id', async () => {
    const w = mountDrawer(makeConv('owner'));
    await byText(w, 'Leave')!.trigger('click');
    expect(chat.removeMember).toHaveBeenCalledWith('g1', 'me');
  });
});

describe('ManageMembersDrawer — plain member', () => {
  it('hides add/remove/role controls but still lets me leave', () => {
    const w = mountDrawer(makeConv('member'));
    expect(byText(w, 'Add friend')).toBeFalsy();
    expect(w.find('button[title="Remove from group"]').exists()).toBe(false);
    expect(byText(w, 'Make admin')).toBeFalsy();
    expect(byText(w, 'Leave')).toBeTruthy();
  });
});
