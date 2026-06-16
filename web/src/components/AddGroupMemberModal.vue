<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Conversation, Friend } from '@notes/shared';
import { useChatStore } from '../stores/chat';
import { useFriendsStore } from '../stores/friends';
import AppModal from './AppModal.vue';
import IconUserPlus from '~icons/mynaui/user-plus';

const props = defineProps<{ conversation: Conversation }>();
const open = defineModel<boolean>('open', { default: false });

const chat = useChatStore();
const friends = useFriendsStore();

const history = ref<'share' | 'fresh'>('share');
const busy = ref('');
const error = ref('');

watch(open, (o) => {
  if (!o) {
    history.value = 'share';
    error.value = '';
    busy.value = '';
  }
});

// Friends who can be added: have a key and aren't already in the group.
const eligible = computed(() => {
  const inGroup = new Set(props.conversation.members.map((m) => m.userId));
  return [...friends.friends]
    .filter((f) => f.publicKey && !inGroup.has(f.userId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
});

const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

async function add(f: Friend) {
  if (busy.value) return;
  busy.value = f.userId;
  error.value = '';
  try {
    await chat.addMember(props.conversation.id, f, history.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'could not add member';
  } finally {
    busy.value = '';
  }
}
</script>

<template>
  <AppModal v-model:open="open" title="Add to group" description="Add a friend to this group.">
    <!-- Per-add history choice (the inviter decides what a joiner can back-scroll). -->
    <div class="sticky top-0 flex items-center justify-between gap-2 bg-white pb-3 dark:bg-zinc-900">
      <span class="text-sm text-zinc-500">When they join…</span>
      <div class="flex overflow-hidden rounded-lg border border-zinc-300 text-xs dark:border-zinc-700">
        <button class="px-2.5 py-1" :class="history === 'share' ? 'bg-blue-600 text-white' : 'text-zinc-500'" @click="history = 'share'">
          Share history
        </button>
        <button class="px-2.5 py-1" :class="history === 'fresh' ? 'bg-blue-600 text-white' : 'text-zinc-500'" @click="history = 'fresh'">
          Start fresh
        </button>
      </div>
    </div>

    <ul class="pb-2">
      <li v-for="f in eligible" :key="f.userId">
        <button
          class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
          :disabled="!!busy"
          @click="add(f)"
        >
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
            {{ initial(f.displayName) }}
          </span>
          <span class="min-w-0 grow truncate text-sm font-medium">{{ f.displayName }}</span>
          <IconUserPlus class="h-4 w-4 shrink-0 text-zinc-400" />
        </button>
      </li>
      <li v-if="!eligible.length" class="px-2 py-6 text-center text-sm text-zinc-400">
        {{ friends.friends.length ? 'All your friends are already in this group.' : 'Add friends first to invite them.' }}
      </li>
    </ul>

    <p v-if="error" class="pb-2 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
  </AppModal>
</template>
