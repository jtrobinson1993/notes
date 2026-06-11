<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const props = defineProps<{ modelValue: string; readonly?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();

const host = ref<HTMLDivElement>();
let view: EditorView | null = null;
const readonlyCompartment = new Compartment();

// Format-as-you-type: style the Markdown inline while keeping the markers.
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.5em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.3em', fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '600' },
  { tag: tags.heading4, fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: '#2563eb', textDecoration: 'underline' },
  { tag: tags.url, color: '#2563eb' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, monospace', fontSize: '0.9em', color: '#d97706' },
  { tag: tags.quote, color: '#71717a', fontStyle: 'italic' },
  { tag: tags.list, color: 'inherit' },
  { tag: tags.processingInstruction, color: '#a1a1aa' }, // the #, *, ` markers
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '15px', backgroundColor: 'transparent' },
  '.cm-content': { fontFamily: 'inherit', caretColor: 'currentColor', lineHeight: '1.65' },
  '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'currentColor' },
});

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(mdHighlight),
        theme,
        EditorView.lineWrapping,
        placeholder('Write in Markdown…'),
        readonlyCompartment.of(EditorState.readOnly.of(props.readonly ?? false)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit('update:modelValue', update.state.doc.toString());
        }),
      ],
    }),
  });
});

watch(
  () => props.modelValue,
  (value) => {
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  },
);

watch(
  () => props.readonly,
  (ro) => view?.dispatch({ effects: readonlyCompartment.reconfigure(EditorState.readOnly.of(ro ?? false)) }),
);

onBeforeUnmount(() => view?.destroy());
</script>

<template>
  <div ref="host" class="h-full min-h-0" />
</template>
