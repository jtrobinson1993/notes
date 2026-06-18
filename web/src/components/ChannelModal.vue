<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import EmojiInput from './EmojiInput.vue';
import EmojiText from './EmojiText.vue';
import IconHash from '~icons/mynaui/hash';
import IconVolume from '~icons/mynaui/volume-high';
import IconLock from '~icons/mynaui/lock';
import IconCheck from '~icons/mynaui/check';
import { CHANNEL_NAME_MAX, type ChannelType, type ConversationMember } from '@notes/shared';

// Create a new channel, or rename an existing one. In rename mode the type is
// fixed; in create mode you choose the medium and (v5) whether it's private —
// a private channel is granted only to the members you pick.
const props = defineProps<{
  mode: 'create' | 'rename';
  initialName?: string;
  busy?: boolean;
  /** conversation members offered when making a private channel (excludes me) */
  members?: ConversationMember[];
  meId?: string;
}>();
const emit = defineEmits<{ submit: [{ name: string; type: ChannelType; private: boolean; memberIds: string[] }] }>();
const open = defineModel<boolean>('open', { default: false });

const name = ref(props.initialName ?? '');
const type = ref<ChannelType>('text');
const isPrivate = ref(false);
const selected = ref(new Set<string>());

const others = computed(() => (props.members ?? []).filter((m) => m.userId !== props.meId));

// Reset the form each time the modal opens.
watch(open, (o) => {
  if (o) {
    name.value = props.initialName ?? '';
    type.value = 'text';
    isPrivate.value = false;
    selected.value = new Set();
  }
});

function toggleMember(id: string) {
  const next = new Set(selected.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selected.value = next;
}

function submit() {
  const trimmed = name.value.trim();
  if (!trimmed) return;
  emit('submit', { name: trimmed, type: type.value, private: isPrivate.value, memberIds: [...selected.value] });
}
</script>

<template>
  <AppModal
    v-model:open="open"
    :title="mode === 'create' ? 'Create channel' : 'Rename channel'"
    :description="mode === 'create' ? 'Channels organize conversation into separate streams.' : undefined"
    max-width="sm:max-w-sm"
  >
    <form class="space-y-4 pb-1" @submit.prevent="submit">
      <div v-if="mode === 'create'" class="grid grid-cols-2 gap-2">
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          :class="type === 'text' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-zinc-300 dark:border-zinc-700'"
          @click="type = 'text'"
        >
          <IconHash class="h-4 w-4 shrink-0" /> Text
        </button>
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          :class="type === 'voice' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-zinc-300 dark:border-zinc-700'"
          @click="type = 'voice'"
        >
          <IconVolume class="h-4 w-4 shrink-0" /> Voice
        </button>
      </div>
      <label class="block">
        <span class="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Channel name</span>
        <EmojiInput
          v-model="name"
          autofocus
          :maxlength="CHANNEL_NAME_MAX"
          placeholder="e.g. random or :tada:"
          input-class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      <p v-if="type === 'voice' && mode === 'create'" class="text-xs text-zinc-400">
        Voice channels are placeholders for now — calling lands in a later release.
      </p>

      <!-- Private channel (create only): grant only the chosen members. -->
      <template v-if="mode === 'create'">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm"
          :class="isPrivate ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-zinc-300 dark:border-zinc-700'"
          @click="isPrivate = !isPrivate"
        >
          <IconLock class="h-4 w-4 shrink-0" />
          <span class="grow">Private channel</span>
          <span class="flex h-4 w-4 items-center justify-center rounded border" :class="isPrivate ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300 dark:border-zinc-600'">
            <IconCheck v-if="isPrivate" class="h-3 w-3" />
          </span>
        </button>
        <div v-if="isPrivate">
          <span class="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Members (you're always included)</span>
          <ul class="max-h-44 space-y-0.5 overflow-y-auto">
            <li v-for="m in others" :key="m.userId">
              <button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="toggleMember(m.userId)">
                <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border" :class="selected.has(m.userId) ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300 dark:border-zinc-600'">
                  <IconCheck v-if="selected.has(m.userId)" class="h-3 w-3" />
                </span>
                <span class="min-w-0 grow truncate"><EmojiText :text="m.displayName" /></span>
              </button>
            </li>
            <li v-if="others.length === 0" class="px-2 py-2 text-xs text-zinc-400">No other members to add.</li>
          </ul>
        </div>
      </template>
    </form>
    <template #footer>
      <button
        class="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        @click="open = false"
      >
        Cancel
      </button>
      <button
        :disabled="!name.trim() || busy"
        class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        @click="submit"
      >
        {{ mode === 'create' ? 'Create' : 'Save' }}
      </button>
    </template>
  </AppModal>
</template>
