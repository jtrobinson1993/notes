<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import EmojiText from './EmojiText.vue';
import { useSessionStore } from '../stores/session';
import type { Conversation, ShareAccess } from '@notes/shared';
import IconCheck from '~icons/mynaui/check';

// Bulk-share a chat-sidebar folder: grant chosen conversation members access to
// every note + private channel in the folder (and its subfolders) at once. A
// one-time recursive grant over per-object permissions (no folder permission).
const props = defineProps<{ conversation: Conversation; folderName: string }>();
const emit = defineEmits<{ share: [{ memberIds: string[]; access: ShareAccess }] }>();
const open = defineModel<boolean>('open', { default: false });
const session = useSessionStore();

const others = computed(() => props.conversation.members.filter((m) => m.userId !== session.user?.id));
const selected = ref(new Set<string>());
const access = ref<ShareAccess>('read');
const busy = ref(false);
const done = ref(false);

watch(open, (o) => {
  if (o) {
    selected.value = new Set();
    access.value = 'read';
    done.value = false;
  }
});
function toggle(id: string) {
  const next = new Set(selected.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selected.value = next;
}
async function share() {
  if (!selected.value.size || busy.value) return;
  busy.value = true;
  try {
    emit('share', { memberIds: [...selected.value], access: access.value });
    done.value = true;
    setTimeout(() => (open.value = false), 700);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppModal v-model:open="open" title="Share folder with the chat" :description="`Grant members access to every note + private channel in “${folderName}”. A one-time grant — items added later aren't shared automatically.`" max-width="sm:max-w-sm">
    <div class="flex items-center justify-between pb-2">
      <span class="text-xs font-medium text-zinc-500 dark:text-zinc-400">Grant to</span>
      <select v-model="access" class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900">
        <option value="read">Notes: can read</option>
        <option value="write">Notes: can edit</option>
      </select>
    </div>
    <ul class="space-y-0.5 pb-2">
      <li v-for="m in others" :key="m.userId">
        <button class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="toggle(m.userId)">
          <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border" :class="selected.has(m.userId) ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300 dark:border-zinc-600'">
            <IconCheck v-if="selected.has(m.userId)" class="h-3 w-3" />
          </span>
          <span class="min-w-0 grow truncate"><EmojiText :text="m.displayName" /></span>
        </button>
      </li>
      <li v-if="others.length === 0" class="px-2 py-3 text-center text-sm text-zinc-400">No other members.</li>
    </ul>
    <template #footer>
      <button class="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800" @click="open = false">Cancel</button>
      <button :disabled="!selected.size || busy" class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" @click="share">
        {{ done ? 'Shared ✓' : busy ? 'Sharing…' : 'Share' }}
      </button>
    </template>
  </AppModal>
</template>
