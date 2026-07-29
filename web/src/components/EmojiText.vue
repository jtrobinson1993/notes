<script setup lang="ts">
import { computed, watch } from 'vue';
import { SHORTCODE_RE, resolveEmoji, resolvePreviewEmoji } from '../lib/emoji';
import { contentEmoteUrl, emoteVersion, shortcodeNames } from '../lib/emoji/render';

// THE shared emoji renderer. Every `:shortcode:` the app shows — chat messages,
// note bodies and titles, folder names, picker tiles — goes through this one
// component, which makes it the single place where "displayed" turns into
// "cached" and the single place the per-message fetch cap can be enforced.
//
// `scope` is that contract, and it is required so no caller can forget it:
//
//   * a message/note id — CONTENT. Rendering resolves unknown emotes through
//     the core (`emote_get`), which persists them to the on-device cache, and
//     charges the id's per-message budget (lib/emoji/render.ts).
//   * `false` — BROWSING (the picker, search results). Renders only what is
//     already in the registry; never fetches, never persists. Browsing the
//     picker must not be able to fill the cache with emotes nobody sent.
//
// Unicode emoji typed as glyphs pass straight through as text. A shortcode that
// does not resolve — unknown, unreachable, or over the message's cap — stays
// literal `:text:`: content is never silently dropped.
const props = withDefaults(
  defineProps<{ text: string; scope: string | false; size?: 'inline' | 'tile' }>(),
  { size: 'inline' },
);

interface Part {
  t: 'text' | 'img';
  v: string;
  alt?: string;
}

const parts = computed<Part[]>(() => {
  void emoteVersion.value; // re-render when an emote finishes resolving
  const out: Part[] = [];
  const re = new RegExp(SHORTCODE_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  // Browsing may show a relay-hosted preview; content may not — it renders only
  // from bytes the core has cached, so a message can never bypass the cache or
  // the per-message cap just because the picker happened to surface that name.
  const resolve = props.scope === false ? resolvePreviewEmoji : resolveEmoji;
  while ((m = re.exec(props.text)) !== null) {
    const url = resolve(m[1]!);
    if (!url) continue; // unresolved shortcode → leave as text
    if (m.index > last) out.push({ t: 'text', v: props.text.slice(last, m.index) });
    out.push({ t: 'img', v: url, alt: m[1] });
    last = re.lastIndex;
  }
  if (last < props.text.length) out.push({ t: 'text', v: props.text.slice(last) });
  return out;
});

// Content only: pull down what this text needs, under the scope's budget.
watch(
  [() => props.text, () => props.scope],
  ([text, scope]) => {
    if (!scope || !text.includes(':')) return;
    for (const name of shortcodeNames(text)) {
      if (resolveEmoji(name)) continue;
      void contentEmoteUrl(name, scope);
    }
  },
  { immediate: true },
);

const imgClass = computed(() => (props.size === 'tile' ? 'emote-tile' : 'chat-emoji'));
</script>

<template><span><template v-for="(p, i) in parts" :key="i"><img
  v-if="p.t === 'img'"
  :src="p.v"
  :alt="`:${p.alt}:`"
  :title="`:${p.alt}:`"
  :class="imgClass"
  loading="lazy"
/><template v-else>{{ p.v }}</template></template></span></template>
