import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

// The whole native page, wired as it ships: the conversation's sidebar beside the
// messages, with a pinned note opening over them.
const native = vi.hoisted(() => ({
  isNative: true,
  conversationActivity: vi.fn().mockResolvedValue([]),
  conversationReactions: vi.fn().mockResolvedValue([]),
  relayDeleteMessage: vi.fn(),
  relayEditMessage: vi.fn(),
  relayReact: vi.fn(),
  relayGroupDeleteMessage: vi.fn(),
  relayGroupEditMessage: vi.fn(),
  relayGroupReact: vi.fn(),
  attachmentUpload: vi.fn(),
  attachmentFetch: vi.fn().mockResolvedValue([]),
  settingsGet: vi.fn().mockResolvedValue(null),
  settingsSet: vi.fn().mockResolvedValue(undefined),
  notesLoadAll: vi.fn().mockResolvedValue([]), // the page hydrates notes for its pins
  noteCreate: vi.fn(),
  noteSave: vi.fn(),
  noteDelete: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

const dm = vi.hoisted(() => ({ listDms: vi.fn(), openDm: vi.fn(), sendDm: vi.fn() }));
vi.mock('../../src/lib/nativeDm', () => dm);
const grp = vi.hoisted(() => ({
  listGroups: vi.fn(),
  openGroup: vi.fn(),
  sendGroup: vi.fn(),
  createGroup: vi.fn(),
  addGroupMember: vi.fn(),
}));
vi.mock('../../src/lib/nativeGroup', () => grp);
vi.mock('../../src/lib/nativeFriends', () => ({ createInvite: vi.fn(), redeemInvite: vi.fn() }));
vi.mock('../../src/lib/nativeRelay', () => ({ onMailIngested: vi.fn(() => () => {}) }));
vi.mock('../../src/lib/callHost', () => ({ callHost: () => ({ placeCall: vi.fn() }) }));
vi.mock('../../src/lib/api', () => ({ api: { settingGet: vi.fn(), settingPut: vi.fn() } }));

// The route the rail links to: an open DM. (Each case mounts fresh, so a plain
// holder is enough — nothing needs to react to a route change mid-test.)
const route = vi.hoisted(() => ({ query: { open: 'dm:idA' } as Record<string, unknown> }));
vi.mock('vue-router', () => ({
  useRoute: () => ({ get query() { return route.query; } }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), currentRoute: { value: { path: '/dm', query: route.query } } }),
}));

// The app chrome and the (CodeMirror-backed) editor aren't what's under test.
vi.mock('../../src/components/AppLayout.vue', () => ({
  default: { name: 'AppLayout', template: '<div><slot /></div>' },
}));
vi.mock('../../src/components/NoteEditor.vue', () => ({
  default: { name: 'NoteEditor', props: ['note', 'closable'], template: '<div data-testid="note-editor">{{ note.payload.title }}</div>' },
}));
vi.mock('../../src/components/PinPickerModal.vue', () => ({
  default: { name: 'PinPickerModal', template: '<div />' },
}));

import NativeChatPage from '../../src/pages/NativeChatPage.vue';
import { refreshNativeConversations } from '../../src/lib/nativeConversations';
import { useNotesStore } from '../../src/stores/notes';
import { useOrgStore } from '../../src/stores/organization';

beforeEach(async () => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.clearAllMocks();
  route.query = { open: 'dm:idA' };
  dm.listDms.mockResolvedValue([
    { contactId: 'idA', handle: 'Ant#1', displayName: 'Alice', conversationId: 'dm:A', unread: 0 },
  ]);
  grp.listGroups.mockResolvedValue([]);
  dm.openDm.mockResolvedValue({ conversationId: 'dm:A', messages: [] });
  native.conversationActivity.mockResolvedValue([{ conversation_id: 'dm:A', last_ts: 5, unread: 0 }]);
  await refreshNativeConversations(); // the rail's list, as the app keeps it current
});

describe('NativeChatPage', () => {
  it('shows the open chat’s sidebar (#chat + its pins) beside the messages', async () => {
    const notes = useNotesStore();
    notes.notes.set('n1', { id: 'n1', payload: { title: 'Campaign rules', body: '', tags: [] }, createdAt: 0, updatedAt: 0 });
    notes.loaded = true;
    useOrgStore().pin('dm:A', 'note', 'n1');

    const w = mount(NativeChatPage);
    await flushPromises();

    expect(w.get('[data-testid="chat-item"]').text()).toContain('chat');
    expect(w.get('[data-testid="pinned-note"]').text()).toContain('Campaign rules');
    expect(w.get('[data-testid="composer"]').exists()).toBe(true); // the messages, beside it
    expect(w.find('[data-testid="note-editor"]').exists()).toBe(false);
  });

  it('opens a pinned note over the chat, and "#chat" brings the messages back', async () => {
    const notes = useNotesStore();
    notes.notes.set('n1', { id: 'n1', payload: { title: 'Campaign rules', body: '', tags: [] }, createdAt: 0, updatedAt: 0 });
    notes.loaded = true;
    useOrgStore().pin('dm:A', 'note', 'n1');

    const w = mount(NativeChatPage);
    await flushPromises();

    await w.get('[data-testid="pinned-note"]').trigger('click');
    expect(w.get('[data-testid="note-editor"]').text()).toContain('Campaign rules');

    await w.get('[data-testid="chat-item"]').trigger('click');
    expect(w.find('[data-testid="note-editor"]').exists()).toBe(false);
  });

  it('shows no chat sidebar on the add-a-friend panel (no conversation open)', async () => {
    route.query = { add: '1' };
    const w = mount(NativeChatPage);
    await flushPromises();

    expect(w.find('[data-testid="chat-item"]').exists()).toBe(false);
    expect(w.get('[data-testid="make-invite"]').exists()).toBe(true);
  });
});
