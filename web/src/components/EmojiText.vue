<script setup lang="ts">
import { computed } from 'vue';
import { SHORTCODE_RE, resolveEmoji } from '../lib/emoji';

// Renders a plain string with chat-style `:shortcode:` emoji resolved inline:
// known custom/7TV emotes become small images; unicode emoji typed directly as
// glyphs pass through as text (same model as chat messages). Unknown shortcodes
// are left as literal text.
const props = defineProps<{ text: string }>();

interface Part {
  t: 'text' | 'img';
  v: string;
  alt?: string;
}

const parts = computed<Part[]>(() => {
  const out: Part[] = [];
  const re = new RegExp(SHORTCODE_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(props.text)) !== null) {
    const url = resolveEmoji(m[1]!);
    if (!url) continue; // unknown shortcode → leave as text
    if (m.index > last) out.push({ t: 'text', v: props.text.slice(last, m.index) });
    out.push({ t: 'img', v: url, alt: m[1] });
    last = re.lastIndex;
  }
  if (last < props.text.length) out.push({ t: 'text', v: props.text.slice(last) });
  return out;
});
</script>

<template><span><template v-for="(p, i) in parts" :key="i"><img
  v-if="p.t === 'img'"
  :src="p.v"
  :alt="`:${p.alt}:`"
  class="inline-block h-[1.1em] w-[1.1em] -translate-y-px object-contain align-middle"
/><template v-else>{{ p.v }}</template></template></span></template>
