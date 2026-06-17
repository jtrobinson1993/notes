<script setup lang="ts">
import { ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import IconHash from '~icons/mynaui/hash';
import IconVolume from '~icons/mynaui/volume-high';
import { CHANNEL_NAME_MAX, type ChannelType } from '@notes/shared';

// Create a new channel, or rename an existing one. In rename mode the type is
// fixed (you can't change a channel's medium); in create mode it's chosen here.
const props = defineProps<{ mode: 'create' | 'rename'; initialName?: string; busy?: boolean }>();
const emit = defineEmits<{ submit: [{ name: string; type: ChannelType }] }>();
const open = defineModel<boolean>('open', { default: false });

const name = ref(props.initialName ?? '');
const type = ref<ChannelType>('text');

// Reset the form each time the modal opens.
watch(open, (o) => {
  if (o) {
    name.value = props.initialName ?? '';
    type.value = 'text';
  }
});

function submit() {
  const trimmed = name.value.trim();
  if (!trimmed) return;
  emit('submit', { name: trimmed, type: type.value });
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
        <input
          v-model="name"
          autofocus
          :maxlength="CHANNEL_NAME_MAX"
          placeholder="e.g. random"
          class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      <p v-if="type === 'voice' && mode === 'create'" class="text-xs text-zinc-400">
        Voice channels are placeholders for now — calling lands in a later release.
      </p>
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
