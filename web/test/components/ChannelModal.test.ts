import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ConversationMember } from '@notes/shared';
import ChannelModal from '../../src/components/ChannelModal.vue';

const stubs = {
  AppModal: { props: ['open'], template: '<div><slot /><slot name="footer" /></div>' },
  EmojiInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  EmojiText: { props: ['text'], template: '<span>{{ text }}</span>' },
};

const members: ConversationMember[] = [
  { userId: 'me', displayName: 'Me', publicKey: 'pk-me', nameColor: null, linkPreviews: false, role: 'owner' },
  { userId: 'a', displayName: 'Alice', publicKey: 'pk-a', nameColor: null, linkPreviews: false, role: 'member' },
  { userId: 'b', displayName: 'Bob', publicKey: 'pk-b', nameColor: null, linkPreviews: false, role: 'member' },
];

beforeEach(() => setActivePinia(createPinia()));

describe('ChannelModal (create)', () => {
  it('emits an open channel by default', async () => {
    const w = mount(ChannelModal, { props: { mode: 'create', open: true, members, meId: 'me' }, global: { stubs } });
    await w.find('input').setValue('random');
    await w.findAll('button').find((b) => b.text() === 'Create')!.trigger('click');
    expect(w.emitted('submit')![0]).toEqual([{ name: 'random', type: 'text', private: false, memberIds: [] }]);
  });

  it('reveals a member picker for a private channel and emits the chosen members (excluding me)', async () => {
    const w = mount(ChannelModal, { props: { mode: 'create', open: true, members, meId: 'me' }, global: { stubs } });
    await w.find('input').setValue('secret');
    // The picker is hidden until "Private channel" is toggled.
    expect(w.text()).not.toContain('Alice');
    await w.findAll('button').find((b) => b.text().includes('Private channel'))!.trigger('click');
    expect(w.text()).toContain('Alice');
    await w.findAll('button').find((b) => b.text().includes('Alice'))!.trigger('click');
    await w.findAll('button').find((b) => b.text() === 'Create')!.trigger('click');
    expect(w.emitted('submit')!.at(-1)).toEqual([{ name: 'secret', type: 'text', private: true, memberIds: ['a'] }]);
  });
});
