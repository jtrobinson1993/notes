<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useChatStore } from '../stores/chat';
import { useFriendsStore } from '../stores/friends';
import AppModal from './AppModal.vue';
import IconSearch from '~icons/mynaui/search';

const open = defineModel<boolean>('open', { default: false });

const friends = useFriendsStore();
const chat = useChatStore();
const router = useRouter();

const search = ref('');
const selected = ref<Set<string>>(new Set());
const busy = ref(false);
const error = ref('');

// Reset transient state whenever the modal closes.
watch(open, (o) => {
  if (!o) {
    search.value = '';
    selected.value = new Set();
    error.value = '';
    busy.value = false;
  }
});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return [...friends.friends]
    .filter((f) => !q || f.displayName.toLowerCase().includes(q))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
});

const count = computed(() => selected.value.size);

function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

function toggle(userId: string) {
  const next = new Set(selected.value);
  if (next.has(userId)) next.delete(userId);
  else next.add(userId);
  selected.value = next;
}

async function create() {
  if (count.value === 0 || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const chosen = friends.friends.filter((f) => selected.value.has(f.userId));
    const [first] = chosen;
    if (!first) return;
    const convId = chosen.length === 1 ? await chat.openDm(first) : await chat.openGroup(chosen);
    open.value = false;
    router.push(`/chat/${convId}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'could not create chat';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppModal
    v-model:open="open"
    title="New chat"
    description="Pick a friend to message, or select several to start a group."
  >
    <div class="sticky top-0 bg-white pb-2 dark:bg-zinc-900">
      <div class="relative">
        <IconSearch class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input
          v-model="search"
          type="text"
          placeholder="Search friends…"
          class="w-full rounded-lg border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
    </div>

    <ul class="pb-2">
      <li v-for="f in filtered" :key="f.userId">
        <label
          class="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 accent-blue-600"
            :checked="selected.has(f.userId)"
            @change="toggle(f.userId)"
          />
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
            {{ initial(f.displayName) }}
          </span>
          <span class="min-w-0 grow truncate text-sm font-medium">{{ f.displayName }}</span>
        </label>
      </li>
      <li v-if="!filtered.length" class="px-2 py-6 text-center text-sm text-zinc-400">
        {{ friends.friends.length ? 'No friends match your search.' : 'No friends yet.' }}
      </li>
    </ul>

    <p v-if="error" class="pb-2 text-sm text-red-600 dark:text-red-400">{{ error }}</p>

    <template #footer>
      <button
        class="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        @click="open = false"
      >
        Cancel
      </button>
      <button
        class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!count || busy"
        @click="create"
      >
        {{ count > 1 ? `Create group (${count})` : 'Create chat' }}
      </button>
    </template>
  </AppModal>
</template>
