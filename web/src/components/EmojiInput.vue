<script setup lang="ts">
import { nextTick, ref, shallowRef } from 'vue';
import { loadUnicodeEmoji, type UnicodeEmoji } from '../lib/emoji/unicode';
import { rankEmoji, recordEmojiUse, type EmojiCandidate } from '../lib/emoji/usage';

// A plain text input with the same `:shortcode` emoji autocomplete as the chat
// composer — for channel and note names. Picks insert a `:name:` shortcode for
// custom/7TV emotes or the glyph for unicode (then EmojiText renders them).
const props = defineProps<{ placeholder?: string; maxlength?: number; autofocus?: boolean; readonly?: boolean; inputClass?: string; wrapperClass?: string }>();
const model = defineModel<string>({ default: '' });

const inputEl = ref<HTMLInputElement>();
const acOpen = ref(false);
const acItems = shallowRef<EmojiCandidate[]>([]);
const acIndex = ref(0);
const acFrom = ref(0);

// Same trigger as the editor: a `:` at start or after whitespace, ≥2 name chars.
const TRIGGER_RE = /(?:^|\s):([A-Za-z0-9_+-]{2,})$/;

let unicodeList: UnicodeEmoji[] | null = null;
let unicodeLoading = false;
function loadUnicode() {
  if (unicodeList || unicodeLoading) return;
  unicodeLoading = true;
  void loadUnicodeEmoji().then((l) => {
    unicodeList = l;
    if (acOpen.value) refresh();
  });
}

function refresh() {
  const el = inputEl.value;
  if (!el || props.readonly) return;
  const caret = el.selectionStart ?? model.value.length;
  const m = TRIGGER_RE.exec(model.value.slice(0, caret));
  if (!m) {
    acOpen.value = false;
    return;
  }
  loadUnicode();
  const items = rankEmoji(m[1]!, unicodeList, 8);
  if (!items.length) {
    acOpen.value = false;
    return;
  }
  acItems.value = items;
  acFrom.value = caret - m[1]!.length - 1;
  acIndex.value = 0;
  acOpen.value = true;
}

function accept(i = acIndex.value) {
  const item = acItems.value[i];
  const el = inputEl.value;
  if (!item || !el) return;
  recordEmojiUse(item.key);
  const caret = el.selectionStart ?? model.value.length;
  model.value = model.value.slice(0, acFrom.value) + item.insert + model.value.slice(caret);
  acOpen.value = false;
  const pos = acFrom.value + item.insert.length;
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(pos, pos);
  });
}

function onKeydown(e: KeyboardEvent) {
  if (!acOpen.value) return; // closed → Enter etc. fall through (e.g. form submit)
  if (e.key === 'ArrowDown') {
    acIndex.value = (acIndex.value + 1) % acItems.value.length;
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    acIndex.value = (acIndex.value - 1 + acItems.value.length) % acItems.value.length;
    e.preventDefault();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    accept();
    e.preventDefault();
  } else if (e.key === 'Escape') {
    acOpen.value = false;
    e.preventDefault();
  }
}
</script>

<template>
  <div class="relative" :class="wrapperClass">
    <input
      ref="inputEl"
      v-model="model"
      :placeholder="placeholder"
      :maxlength="maxlength"
      :autofocus="autofocus"
      :readonly="readonly"
      :class="inputClass"
      @input="refresh"
      @click="refresh"
      @keyup="refresh"
      @keydown="onKeydown"
      @blur="acOpen = false"
    />
    <ul
      v-if="acOpen"
      class="absolute left-0 top-full z-popover mt-1 max-h-56 w-64 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
    >
      <li v-for="(item, i) in acItems" :key="item.key">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm"
          :class="i === acIndex ? 'bg-zinc-100 dark:bg-zinc-700' : ''"
          @mouseenter="acIndex = i"
          @mousedown.prevent="accept(i)"
        >
          <img v-if="item.url" :src="item.url" :alt="item.label" class="h-5 w-5 shrink-0 object-contain" />
          <span v-else class="w-5 shrink-0 text-center text-lg leading-none">{{ item.char }}</span>
          <span class="min-w-0 truncate text-zinc-700 dark:text-zinc-200">{{ item.label }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
