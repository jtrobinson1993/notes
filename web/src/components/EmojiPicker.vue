<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent } from 'reka-ui';
import IconSmile from '~icons/mynaui/smile';
import IconSmileSolid from '~icons/mynaui/smile-solid';
import IconCloudOff from '~icons/mynaui/cloud-slash';
import EmojiText from './EmojiText.vue';
import { registerEmoteId, registerEmotePreview } from '../lib/emoji';
import { cachedEmoteUrl } from '../lib/emoji/render';
import { loadUnicodeEmoji, searchUnicode, type UnicodeEmoji } from '../lib/emoji/unicode';
import {
  candidateForKey,
  rankEmoji,
  recordEmojiUse,
  topUsed,
  type EmojiCandidate,
} from '../lib/emoji/usage';
import { emoteCachedList, emoteSearch } from '../lib/native';
import { toastError } from '../lib/toast';

// The emoji picker: relay-proxied emote search plus the offline unicode set.
//
// Two rules shape this component, both of them privacy rules:
//
//  1. **It never fetches anything itself.** Emote search is `emote_search` in
//     the Rust core, because the relay device token must not cross IPC and the
//     webview must never resolve a third-party CDN. Results arrive as URLs on
//     the relay's own origin, and `registerEmote` refuses any other origin — a
//     hostile relay handing back `cdn.example/x.webp` renders as literal text
//     instead of beaconing this device's IP.
//  2. **Browsing is not usage.** Nothing here writes to the on-device emote
//     cache: tiles render through the shared `EmojiText` with `:scope="false"`,
//     the explicit opt-out. Only content rendering (a real message or note)
//     persists an emote, so one idle scroll through the picker cannot fill the
//     cache with emotes nobody ever sent.
const emit = defineEmits<{ pick: [string] }>();
// `compact` renders a small, borderless trigger (message hover toolbars).
const props = defineProps<{ compact?: boolean }>();

type Tab = 'emotes' | 'unicode';
const SEARCH_LIMIT = 60;
const DEBOUNCE_MS = 250;

const open = ref(false);
const tab = ref<Tab>('emotes');
const query = ref('');
const loading = ref(false);
// True once search has failed and we are showing this device's cached set.
const offline = ref(false);
const emoteNames = shallowRef<string[]>([]);
let seq = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;
// One toast per opening, not one per keystroke.
let toastedThisOpen = false;

/** Ranked emote candidates: most-used first (decayed score), then relay order. */
const emoteResults = computed<EmojiCandidate[]>(() =>
  rankEmoji(query.value, null, SEARCH_LIMIT, Date.now(), emoteNames.value),
);

// "Frequently used" (any source), shown at the top when not searching. Keys
// whose emote no longer resolves drop out rather than rendering a blank tile.
const mostUsed = computed<EmojiCandidate[]>(() =>
  topUsed()
    .map((e) => candidateForKey(e.key))
    .filter((c): c is EmojiCandidate => !!c)
    .slice(0, 24),
);

async function runSearch(q: string): Promise<void> {
  const mine = ++seq;
  loading.value = true;
  try {
    const res = await emoteSearch(q.trim(), 1, SEARCH_LIMIT);
    if (mine !== seq) return; // superseded by a later keystroke
    const names: string[] = [];
    const seen = new Set<string>();
    for (const r of res.results) {
      // 7TV search returns duplicate shortcodes; the registry is keyed by name,
      // so keep the first and skip the rest instead of rendering twins.
      if (seen.has(r.name)) continue;
      // Origin-refused registrations simply do not become tiles.
      // Preview only: a browsed emote must not become content-renderable.
      if (!registerEmotePreview(r.name, r.url, r.id)) continue;
      seen.add(r.name);
      names.push(r.name);
    }
    emoteNames.value = names;
    offline.value = false;
  } catch {
    if (mine !== seq) return;
    await showCachedSet(q, mine);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

/** Offline fallback: the emotes this device already holds, so emoji keep
 *  working with no relay. These are cache reads — nothing new is stored. */
async function showCachedSet(q: string, mine: number): Promise<void> {
  offline.value = true;
  try {
    const list = await emoteCachedList();
    if (mine !== seq) return;
    const needle = q.trim().toLowerCase();
    const hits = (needle ? list.filter((e) => e.name.toLowerCase().includes(needle)) : list).slice(
      0,
      SEARCH_LIMIT,
    );
    for (const e of hits) registerEmoteId(e.name, e.id);
    emoteNames.value = hits.map((e) => e.name);
    await Promise.all(hits.map((e) => cachedEmoteUrl(e.id, e.name)));
    if (!hits.length && !needle) warnUnavailable();
  } catch {
    if (mine !== seq) return;
    emoteNames.value = [];
    warnUnavailable();
  }
}

function warnUnavailable(): void {
  if (toastedThisOpen) return;
  toastedThisOpen = true;
  toastError('EMOTE_SEARCH_UNAVAILABLE');
}

// Unicode set is lazy-loaded the first time its tab is shown (no network).
const unicodeAll = shallowRef<UnicodeEmoji[] | null>(null);
const unicodeLoading = ref(false);
const unicodeResults = computed(() =>
  unicodeAll.value ? searchUnicode(unicodeAll.value, query.value) : [],
);

async function ensureUnicode(): Promise<void> {
  if (unicodeAll.value || unicodeLoading.value) return;
  unicodeLoading.value = true;
  try {
    unicodeAll.value = await loadUnicodeEmoji();
  } finally {
    unicodeLoading.value = false;
  }
}

function choose(candidate: EmojiCandidate): void {
  recordEmojiUse(candidate.key); // picking IS usage; rendering it is what caches
  emit('pick', candidate.insert);
}

watch(query, (q) => {
  if (tab.value !== 'emotes') return;
  clearTimeout(debounce);
  debounce = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
});

watch([open, tab], ([isOpen, t]) => {
  if (!isOpen) {
    clearTimeout(debounce);
    return;
  }
  if (t === 'unicode') void ensureUnicode();
  if (t === 'emotes' && !emoteNames.value.length && !loading.value) void runSearch(query.value);
});

watch(open, (isOpen) => {
  if (isOpen) toastedThisOpen = false;
});

const tabClass = (t: Tab) =>
  t === tab.value
    ? 'bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
    : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200';
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      title="Emoji"
      data-testid="emoji-picker-trigger"
      :class="props.compact
        ? 'flex items-center rounded px-1.5 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700'
        : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-700/70'"
    >
      <IconSmile v-if="props.compact" class="h-4 w-4" />
      <IconSmileSolid v-else class="h-5 w-5" />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        side="top"
        align="end"
        :side-offset="8"
        :collision-padding="8"
        data-testid="emoji-picker"
        class="z-popover flex h-96 w-80 flex-col rounded-xl border border-zinc-200 bg-white p-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        @open-auto-focus.prevent
      >
        <div class="mb-2 flex shrink-0 items-center gap-1 text-xs">
          <button class="rounded-md px-2 py-1" :class="tabClass('emotes')" @click="tab = 'emotes'">Emotes</button>
          <button class="rounded-md px-2 py-1" :class="tabClass('unicode')" @click="tab = 'unicode'">Emoji</button>
          <span
            v-if="offline && tab === 'emotes'"
            data-testid="emoji-offline"
            class="ml-auto flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400"
            title="The relay is unreachable — showing emotes saved on this device"
          >
            <IconCloudOff class="h-3.5 w-3.5" />Offline
          </span>
        </div>
        <input
          v-model="query"
          type="text"
          data-testid="emoji-search"
          :placeholder="tab === 'emotes' ? 'Search emotes…' : 'Search emoji…'"
          class="mb-2 shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
        />

        <div class="min-h-0 grow overflow-y-auto">
          <!-- Frequently used (decayed usage, any source), only while browsing -->
          <div v-if="!query && mostUsed.length" class="mb-2">
            <p class="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">Frequently used</p>
            <div class="grid grid-cols-8 gap-1">
              <button
                v-for="c in mostUsed"
                :key="c.key"
                :title="c.label"
                data-testid="emoji-frequent"
                class="flex aspect-square items-center justify-center rounded text-xl hover:bg-zinc-100 dark:hover:bg-zinc-800"
                @click="choose(c)"
              >
                <EmojiText v-if="c.source === 'emote'" :text="c.insert" :scope="false" size="tile" />
                <template v-else>{{ c.char }}</template>
              </button>
            </div>
          </div>

          <template v-if="tab === 'emotes'">
            <p v-if="loading && !emoteResults.length" class="px-1 py-4 text-center text-xs text-zinc-400">Searching…</p>
            <p v-else-if="!emoteResults.length" class="px-1 py-4 text-center text-xs text-zinc-400">
              {{ offline ? 'No emotes saved on this device yet.' : 'No emotes found.' }}
            </p>
            <div v-else class="grid grid-cols-7 gap-1">
              <button
                v-for="c in emoteResults"
                :key="c.key"
                :title="c.label"
                data-testid="emoji-result"
                class="flex aspect-square items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
                @click="choose(c)"
              >
                <!-- scope=false: browsing must never write to the emote cache -->
                <EmojiText :text="c.insert" :scope="false" size="tile" />
              </button>
            </div>
          </template>

          <template v-else>
            <p v-if="unicodeLoading && !unicodeAll" class="px-1 py-4 text-center text-xs text-zinc-400">Loading…</p>
            <p v-else-if="!unicodeResults.length" class="px-1 py-4 text-center text-xs text-zinc-400">No emoji found.</p>
            <div v-else class="grid grid-cols-8 gap-1">
              <button
                v-for="e in unicodeResults"
                :key="e.unicode"
                :title="e.label"
                data-testid="emoji-unicode"
                class="flex aspect-square items-center justify-center rounded text-xl hover:bg-zinc-100 dark:hover:bg-zinc-800"
                @click="choose({ source: 'unicode', key: `uni:${e.unicode}`, insert: e.unicode, label: e.label, char: e.unicode })"
              >
                {{ e.unicode }}
              </button>
            </div>
          </template>
        </div>
        <p class="shrink-0 pt-1 text-center text-[10px] text-zinc-400">
          {{ tab === 'emotes' ? 'Emotes via your relay (7TV)' : 'Unicode via emojibase' }}
        </p>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
