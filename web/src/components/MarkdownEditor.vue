<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import ColorPalette from './ColorPalette.vue';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { extendedSyntax } from '../lib/editor/syntax';
import { livePreview } from '../lib/editor/livePreview';
import { codeBlocks } from '../lib/editor/codeBlocks';
import { attachmentResolver, type AttachmentResolver } from '../lib/editor/media';
import {
  applyColor,
  clearColor,
  cursorInFormat,
  formattingKeymap,
  insertLink,
  toggleBold,
  toggleCode,
  toggleHighlight,
  toggleItalic,
  toggleSpoilerSyntax,
  toggleStrike,
  toggleUnderline,
} from '../lib/editor/commands';
import { getLastColor, PRESET_COLORS, presetCss } from '../lib/editor/palette';

const props = defineProps<{
  modelValue: string;
  readonly?: boolean;
  mode?: 'live' | 'source';
  resolveAttachment?: AttachmentResolver;
  /** Placeholder shown when empty. */
  placeholder?: string;
  /** Chat composer mode: Enter submits (Shift+Enter inserts a newline), height
   *  auto-grows to a cap instead of filling the parent. */
  submitOnEnter?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [string]; submit: [] }>();

const host = ref<HTMLDivElement>();
let view: EditorView | null = null;
const readonlyCompartment = new Compartment();
const modeCompartment = new Compartment();

// Source mode keeps the v2 "format-as-you-type" styling: markdown styled but
// markers visible — the raw-syntax escape hatch.
const sourceHighlight = HighlightStyle.define([
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
  { tag: tags.processingInstruction, color: '#a1a1aa' },
]);

// Live mode styles mostly via decorations; keep link color for revealed syntax.
const liveHighlight = HighlightStyle.define([
  { tag: tags.link, color: '#2563eb' },
  { tag: tags.url, color: '#94a3b8' },
  { tag: tags.processingInstruction, color: '#a1a1aa' },
]);

// Notes fill their pane (height 100%); the chat composer auto-grows with content
// up to a cap, then scrolls — like a Discord/Slack message box.
const editorTheme = EditorView.theme({
  '&': props.submitOnEnter
    ? { maxHeight: '40vh', fontSize: '15px', backgroundColor: 'transparent' }
    : { height: '100%', fontSize: '15px', backgroundColor: 'transparent' },
  '.cm-content': { fontFamily: 'inherit', caretColor: 'currentColor', lineHeight: '1.65' },
  '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'currentColor' },
});

// In composer mode, Enter submits and Shift+Enter inserts a newline. Bound ahead
// of defaultKeymap so it wins for the bare Enter key.
const submitKeymap = keymap.of([
  { key: 'Enter', run: () => (emit('submit'), true) },
  { key: 'Shift-Enter', run: insertNewlineAndIndent },
]);

const md = () =>
  markdown({ base: markdownLanguage, codeLanguages: languages, extensions: extendedSyntax });

function modeExtensions(mode: 'live' | 'source') {
  return mode === 'source'
    ? [md(), syntaxHighlighting(sourceHighlight)]
    : [md(), syntaxHighlighting(liveHighlight), livePreview(), codeBlocks()];
}

// ---- selection toolbar ----------------------------------------------------

const isCoarse = matchMedia('(pointer: coarse)').matches;
const toolbarVisible = ref(false);
const toolbarPos = ref({ left: 0, top: 0 });
const paletteOpen = ref(false);
const focused = ref(false);

function updateToolbar() {
  if (!view || props.readonly || isCoarse || (props.mode ?? 'live') !== 'live') {
    toolbarVisible.value = false;
    paletteOpen.value = false;
    return;
  }
  const range = view.state.selection.main;
  // show on selection, or when the caret is inside already-formatted text
  if (range.empty && !cursorInFormat(view.state)) {
    toolbarVisible.value = false;
    paletteOpen.value = false;
    return;
  }
  const coords = view.coordsAtPos(Math.min(range.head, range.anchor));
  const hostRect = host.value?.getBoundingClientRect();
  if (!coords) {
    toolbarVisible.value = false;
    return;
  }
  if (!hostRect) {
    toolbarVisible.value = false;
    return;
  }
  // invisible anchor element tracking the selection; the Reka popover
  // positions itself against it with collision-aware flipping
  toolbarPos.value = {
    left: Math.max(0, coords.left - hostRect.left),
    top: coords.top - hostRect.top,
  };
  toolbarVisible.value = true;
}

type Cmd = (v: EditorView) => boolean;
function run(cmd: Cmd) {
  if (view) cmd(view);
  paletteOpen.value = false;
}

function pickColor(css: string) {
  if (view) applyColor(view, css);
  paletteOpen.value = false;
}

function repeatLastColor() {
  if (view) applyColor(view, getLastColor());
}

function removeColor() {
  if (view) clearColor(view);
  paletteOpen.value = false;
}

const buttons: { label: string; title: string; cmd: Cmd; cls?: string }[] = [
  { label: 'B', title: 'Bold (Mod+B)', cmd: toggleBold, cls: 'font-bold' },
  { label: 'I', title: 'Italic (Mod+I)', cmd: toggleItalic, cls: 'italic' },
  { label: 'U', title: 'Underline (Mod+U)', cmd: toggleUnderline, cls: 'underline' },
  { label: 'S', title: 'Strikethrough (Mod+Shift+X)', cmd: toggleStrike, cls: 'line-through' },
  { label: '</>', title: 'Inline code (Mod+E)', cmd: toggleCode, cls: 'font-mono text-[11px]' },
  { label: 'H', title: 'Highlight (Mod+Shift+H)', cmd: toggleHighlight },
  { label: '🔗', title: 'Link (Mod+K)', cmd: insertLink, cls: 'text-[11px]' },
  { label: '▒', title: 'Spoiler', cmd: toggleSpoilerSyntax },
];

// ---- editor lifecycle ------------------------------------------------------

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        history(),
        ...(props.submitOnEnter ? [submitKeymap] : []),
        keymap.of([...formattingKeymap, ...defaultKeymap, ...historyKeymap]),
        modeCompartment.of(modeExtensions(props.mode ?? 'live')),
        editorTheme,
        EditorView.lineWrapping,
        placeholder(props.placeholder ?? 'Write in Markdown…'),
        attachmentResolver.of(props.resolveAttachment ?? (() => Promise.resolve(null))),
        readonlyCompartment.of(EditorState.readOnly.of(props.readonly ?? false)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit('update:modelValue', update.state.doc.toString());
          if (update.selectionSet || update.docChanged || update.geometryChanged) updateToolbar();
          if (update.focusChanged) focused.value = update.view.hasFocus;
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

watch(
  () => props.mode,
  (mode) => {
    view?.dispatch({ effects: modeCompartment.reconfigure(modeExtensions(mode ?? 'live')) });
    updateToolbar();
  },
);

// Insert text at the current cursor (replacing any selection). Used by the chat
// emoji/unicode pickers to drop a :shortcode: or character into the composer.
function insertText(s: string): void {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: s }, selection: { anchor: from + s.length } });
  view.focus();
}
function focus(): void {
  view?.focus();
}

defineExpose({ insertText, focus });

onBeforeUnmount(() => view?.destroy());
</script>

<template>
  <div class="relative min-h-0" :class="submitOnEnter ? '' : 'h-full'">
    <div ref="host" class="min-h-0" :class="[submitOnEnter ? '' : 'h-full', { 'pb-10': isCoarse && !readonly }]" />

    <!-- desktop selection toolbar (Reka popover: collision-aware placement) -->
    <PopoverRoot :open="toolbarVisible">
      <PopoverAnchor
        class="pointer-events-none absolute h-px w-px"
        :style="{ left: `${toolbarPos.left}px`, top: `${toolbarPos.top}px` }"
      />
      <PopoverPortal>
        <PopoverContent
          side="top"
          align="start"
          :side-offset="6"
          :collision-padding="8"
          class="z-20 flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
          @open-auto-focus.prevent
          @close-auto-focus.prevent
          @interact-outside.prevent
          @mousedown.prevent
        >
          <button
            v-for="b in buttons"
            :key="b.title"
            :title="b.title"
            class="flex h-7 w-7 items-center justify-center rounded text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
            :class="b.cls"
            @click="run(b.cmd)"
          >
            {{ b.label }}
          </button>
          <span class="mx-0.5 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
          <button
            title="Repeat last color"
            class="h-7 w-7 rounded p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            @click="repeatLastColor"
          >
            <span class="block h-full w-full rounded-full border border-zinc-300 dark:border-zinc-600" :style="{ background: getLastColor() }" />
          </button>

          <!-- color palette: nested popover, flips/shifts when space runs out -->
          <PopoverRoot v-model:open="paletteOpen">
            <PopoverTrigger
              title="Text color"
              class="flex h-7 w-7 items-center justify-center rounded text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              A<span class="-ml-0.5 text-[10px]">▾</span>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent
                side="top"
                align="start"
                :side-offset="6"
                :collision-padding="8"
                class="z-30 w-44 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
                @open-auto-focus.prevent
                @close-auto-focus.prevent
                @mousedown.prevent
              >
                <ColorPalette removable @pick="pickColor" @remove="removeColor" />
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>

    <!-- mobile formatting bar -->
    <div
      v-if="isCoarse && !readonly && focused && (mode ?? 'live') === 'live'"
      class="absolute inset-x-0 bottom-0 z-20 flex items-center gap-1 overflow-x-auto border-t border-zinc-200 bg-white/95 px-2 py-1.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
      @mousedown.prevent
      @touchstart.stop
    >
      <button
        v-for="b in buttons"
        :key="b.title"
        :title="b.title"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded text-sm text-zinc-600 dark:text-zinc-300"
        :class="b.cls"
        @click="run(b.cmd)"
      >
        {{ b.label }}
      </button>
      <button
        v-for="p in PRESET_COLORS"
        :key="p.name"
        :title="p.name"
        class="h-6 w-6 shrink-0 rounded-full border border-zinc-300 dark:border-zinc-600"
        :style="{ background: presetCss(p) }"
        @click="pickColor(presetCss(p))"
      />
    </div>
  </div>
</template>
