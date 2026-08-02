import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const api = vi.hoisted(() => ({
  settingGet: vi.fn().mockResolvedValue(null),
  settingPut: vi.fn().mockResolvedValue({ updatedAt: 0 }),
}));
vi.mock('../../src/lib/api', () => ({ api }));
vi.mock('../../src/stores/session', () => ({
  useSessionStore: () => ({ mk: null, user: { id: 'me' } }),
}));
// The pin picker's dialog internals aren't under test here.
vi.mock('../../src/components/PinPickerModal.vue', () => ({
  default: { name: 'PinPickerModal', template: '<div />' },
}));

import NativeChatSidebar from '../../src/components/NativeChatSidebar.vue';
import { useNotesStore } from '../../src/stores/notes';
import { useOrgStore } from '../../src/stores/organization';

const CONV = 'dm:alice';

function seedNote(id: string, title: string) {
  const notes = useNotesStore();
  notes.notes.set(id, {
    id,
    payload: { title, body: '', tags: [] },
    createdAt: 0,
    updatedAt: 0,
  });
}

function render(props: Record<string, unknown> = {}) {
  return mount(NativeChatSidebar, {
    props: { conversationId: CONV, title: 'Alice', ...props },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.clearAllMocks();
});

describe('NativeChatSidebar', () => {
  it('shows the conversation as "#chat" at the top and selects it on click', async () => {
    const w = render();
    const chat = w.get('[data-testid="chat-item"]');
    expect(chat.text()).toContain('chat');
    // With no note open, "#chat" is the active row.
    expect(chat.classes().join(' ')).toContain('font-medium');

    await chat.trigger('click');
    expect(w.emitted('select')).toHaveLength(1);
  });

  it('lists the notes pinned to this conversation and opens one on click', async () => {
    seedNote('n1', 'Campaign rules');
    useOrgStore().pin(CONV, 'note', 'n1');

    const w = render();
    const pinned = w.get('[data-testid="pinned-note"]');
    expect(pinned.text()).toContain('Campaign rules');

    await pinned.trigger('click');
    expect(w.emitted('openNote')).toEqual([['n1']]);
  });

  it('marks the open note active instead of "#chat", and unpins from the row', async () => {
    seedNote('n1', 'Campaign rules');
    const org = useOrgStore();
    org.pin(CONV, 'note', 'n1');

    const w = render({ openNoteId: 'n1' });
    expect(w.get('[data-testid="chat-item"]').classes().join(' ')).not.toContain('font-medium');
    expect(w.get('[data-testid="pinned-note"]').classes().join(' ')).toContain('font-medium');

    await w.get('button[title="Unpin"]').trigger('click');
    expect(org.isPinned(CONV, 'note', 'n1')).toBe(false);
    expect(w.find('[data-testid="pinned-note"]').exists()).toBe(false);
  });

  it("groups pins under a chat folder, and does not show another conversation's pins", async () => {
    seedNote('n1', 'Campaign rules');
    seedNote('n2', 'Someone else’s note');
    const org = useOrgStore();
    org.pin(CONV, 'note', 'n1');
    org.pin('dm:bob', 'note', 'n2');
    const folderId = org.createChatFolder(CONV, 'Reference');
    org.setChatItemFolder(CONV, 'n:n1', folderId);

    const w = render();
    expect(w.get('[data-testid="folder-row"]').text()).toContain('Reference');
    const pinned = w.findAll('[data-testid="pinned-note"]');
    expect(pinned).toHaveLength(1);
    expect(pinned[0].text()).toContain('Campaign rules');
  });
});
