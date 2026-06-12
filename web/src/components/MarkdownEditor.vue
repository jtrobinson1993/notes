<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
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
import { customCss, getLastColor, PRESET_COLORS, presetCss } from '../lib/editor/palette';

const props = defineProps<{
  modelValue: string;
  readonly?: boolean;
  mode?: 'live' | 'source';
  resolveAttachment?: AttachmentResolver;
}>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();

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

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '15px', backgroundColor: 'transparent' },
  '.cm-content': { fontFamily: 'inherit', caretColor: 'currentColor', lineHeight: '1.65' },
  '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'currentColor' },
});

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
const customLight = ref('#dc2626');
const customDark = ref('#f87171');

function updateToolbar() {
  if (!view || props.readonly || isCoarse) {
    toolbarVisible.value = false;
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
  // anchored to the top of the clicked/selected line; CSS translateY(-100%)
  // lifts the toolbar fully above the text
  toolbarPos.value = {
    left: Math.max(4, coords.left - hostRect.left),
    top: coords.top - hostRect.top - 6,
  };
  toolbarVisible.value = true;
}

type Cmd = (v: EditorView) => boolean;
function run(cmd: Cmd) {
  if (view) cmd(view);
  paletteOpen.value = false;
}

function pickPreset(varName: string) {
  if (view) applyColor(view, `var(${varName})`);
  paletteOpen.value = false;
}

function pickCustom() {
  if (view) applyColor(view, customCss(customLight.value, customDark.value));
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
        keymap.of([...formattingKeymap, ...defaultKeymap, ...historyKeymap]),
        modeCompartment.of(modeExtensions(props.mode ?? 'live')),
        editorTheme,
        EditorView.lineWrapping,
        placeholder('Write in Markdown…'),
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
  (mode) => view?.dispatch({ effects: modeCompartment.reconfigure(modeExtensions(mode ?? 'live')) }),
);

onBeforeUnmount(() => view?.destroy());
</script>

<template>
  <div class="relative h-full min-h-0">
    <div ref="host" class="h-full min-h-0" :class="{ 'pb-10': isCoarse && !readonly }" />

    <!-- desktop selection toolbar -->
    <div
      v-if="toolbarVisible"
      class="absolute z-20 flex -translate-y-full items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
      :style="{ left: `${toolbarPos.left}px`, top: `${toolbarPos.top}px` }"
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
      <button
        title="Text color"
        class="flex h-7 w-7 items-center justify-center rounded text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
        @click="paletteOpen = !paletteOpen"
      >
        A<span class="-ml-0.5 text-[10px]">▾</span>
      </button>

      <!-- color palette popover -->
      <div
        v-if="paletteOpen"
        class="absolute bottom-full left-0 z-30 mb-1 w-44 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
      >
        <div class="mb-2 grid grid-cols-4 gap-1.5">
          <button
            v-for="p in PRESET_COLORS"
            :key="p.name"
            :title="p.name"
            class="h-7 w-7 rounded-full border border-zinc-300 hover:scale-110 dark:border-zinc-600"
            :style="{ background: presetCss(p) }"
            @click="pickPreset(p.varName)"
          />
        </div>
        <div class="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <label class="flex items-center gap-1">☀<input v-model="customLight" type="color" class="h-6 w-7 cursor-pointer" /></label>
          <label class="flex items-center gap-1">☾<input v-model="customDark" type="color" class="h-6 w-7 cursor-pointer" /></label>
          <button class="grow rounded border border-zinc-300 px-1 py-0.5 hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-700" @click="pickCustom">
            Apply
          </button>
        </div>
        <button class="mt-1.5 w-full rounded border border-zinc-300 px-1 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-700" @click="removeColor">
          Remove color
        </button>
      </div>
    </div>

    <!-- mobile formatting bar -->
    <div
      v-if="isCoarse && !readonly && focused"
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
        @click="pickPreset(p.varName)"
      />
    </div>
  </div>
</template>
