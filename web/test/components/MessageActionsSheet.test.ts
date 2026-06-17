import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageActionsSheet from '../../src/components/MessageActionsSheet.vue';

// Render the reka Dialog slots inline (no portal) and stub the nested picker so
// we can assert the action emits directly.
const passthrough = (tag = 'div') => ({ template: `<${tag}><slot /></${tag}>` });
const stubs = {
  DialogRoot: passthrough(),
  DialogPortal: passthrough(),
  DialogOverlay: true,
  DialogContent: passthrough(),
  DialogTitle: passthrough(),
  DialogDescription: passthrough(),
  EmojiPicker: true,
};

const mountSheet = (props: Record<string, unknown> = {}) =>
  mount(MessageActionsSheet, { props: { open: true, ...props }, global: { stubs } });
const byText = (w: ReturnType<typeof mountSheet>, t: string) => w.findAll('button').find((b) => b.text().includes(t));

describe('MessageActionsSheet', () => {
  it('emits the chosen action and closes', async () => {
    const w = mountSheet({ canEdit: true });
    await byText(w, 'Reply')!.trigger('click');
    expect(w.emitted('reply')).toHaveLength(1);
    expect(w.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('emits a quick reaction', async () => {
    const w = mountSheet();
    await byText(w, '👍')!.trigger('click');
    expect(w.emitted('react')?.[0]).toEqual(['👍']);
  });

  it('shows Edit only when canEdit', () => {
    expect(byText(mountSheet({ canEdit: false }), 'Edit')).toBeFalsy();
    expect(byText(mountSheet({ canEdit: true }), 'Edit')).toBeTruthy();
  });

  it('hides Open thread inside a thread', () => {
    expect(byText(mountSheet({ isThread: true }), 'Open thread')).toBeFalsy();
    expect(byText(mountSheet({ isThread: false }), 'Open thread')).toBeTruthy();
  });
});
