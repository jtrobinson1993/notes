// Standalone mount of the real <MarkdownEditor> for browser-driven testing of
// caret / keymap / live-preview behaviour, with NO app auth or stores. Open it
// in a browser for manual poking, or drive it with Playwright via the window
// helpers below (see ./README.md). Dev-server only — not part of the prod build.
import { createApp, h, ref } from 'vue';
import { EditorView } from '@codemirror/view';
import MarkdownEditor from '../src/components/MarkdownEditor.vue';
// Load the app's stylesheet so editor decorations (bullets, checkboxes, quotes,
// headings) render with their real CSS — needed for any layout/visual check.
import '../src/style.css';

const value = ref('- one\n- two');
const mode = ref<'live' | 'source'>('live');
const composer = ref(false);
const readout = ref('');

function view(): EditorView | null {
  const content = document.querySelector('.cm-content') as HTMLElement | null;
  return content ? EditorView.findFromDOM(content) : null;
}

// Live readout of the document + main selection, so manual testing shows exactly
// what the caret offset is at each keypress (the thing that's invisible in a
// WYSIWYG editor). Polled — cheap, and avoids reaching into the editor's guts.
setInterval(() => {
  const v = view();
  const sel = v?.state.selection.main;
  readout.value = JSON.stringify(
    { caret: sel ? sel.head : -1, anchor: sel ? sel.anchor : -1, length: value.value.length, doc: value.value },
    null,
    2,
  );
}, 80);

createApp({
  setup() {
    return () =>
      h('div', { style: 'font-family: system-ui; max-width: 760px' }, [
        h('div', { style: 'display:flex; gap:12px; align-items:center; margin-bottom:8px' }, [
          h('label', [
            'mode ',
            h(
              'select',
              { onChange: (e: Event) => (mode.value = (e.target as HTMLSelectElement).value as 'live' | 'source') },
              [h('option', { value: 'live' }, 'live'), h('option', { value: 'source' }, 'source')],
            ),
          ]),
          h('label', [
            h('input', {
              type: 'checkbox',
              onChange: (e: Event) => (composer.value = (e.target as HTMLInputElement).checked),
            }),
            ' composer (submit-on-enter)',
          ]),
        ]),
        h('div', { style: 'height: 240px; border: 1px solid #ccc; padding: 6px' }, [
          h(MarkdownEditor, {
            // key forces a remount when the mode/composer toggles flip, so the
            // editor is rebuilt with the new props (the keymap is built once).
            key: `${mode.value}:${composer.value}`,
            modelValue: value.value,
            mode: mode.value,
            submitOnEnter: composer.value,
            'onUpdate:modelValue': (v: string) => (value.value = v),
          }),
        ]),
        h('pre', { style: 'background:#f6f6f6; padding:8px; white-space:pre-wrap; word-break:break-all' }, readout.value),
      ]);
  },
}).mount('#app');

declare global {
  interface Window {
    /** Current editor document text. */
    __doc(): string;
    /** Main selection head offset (the caret), or -1 if not ready. */
    __caret(): number;
    /** Replace the whole document and optionally place the caret, then focus. */
    __setDoc(text: string, caret?: number): void;
  }
}

window.__doc = () => value.value;
window.__caret = () => view()?.state.selection.main.head ?? -1;
window.__setDoc = (text: string, caret?: number) => {
  const v = view();
  if (!v) return;
  v.dispatch({
    changes: { from: 0, to: v.state.doc.length, insert: text },
    selection: caret != null ? { anchor: caret } : undefined,
  });
  v.focus();
};
