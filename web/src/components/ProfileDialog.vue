<script setup lang="ts">
import { ref, watch } from 'vue';
import { useProfileStore, type ProfileEntry } from '../stores/profile';
import AppModal from './AppModal.vue';
import ChatAvatar from './ChatAvatar.vue';

const open = defineModel<boolean>('open', { default: false });
const props = defineProps<{ userId: string | null }>();

const profile = useProfileStore();
const entry = ref<ProfileEntry | null>(null);
const loading = ref(false);

watch(
  [open, () => props.userId],
  async ([o, id]) => {
    if (!o || !id) {
      entry.value = null;
      return;
    }
    loading.value = true;
    try {
      entry.value = await profile.fetch(id);
    } catch {
      entry.value = null;
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);
</script>

<template>
  <AppModal v-model:open="open" title="Profile" max-width="sm:max-w-sm">
    <div class="flex flex-col items-center gap-3 pb-6 pt-2 text-center">
      <p v-if="loading" class="py-8 text-sm text-zinc-400">Loading…</p>
      <template v-else-if="entry">
        <ChatAvatar
          :name="entry.displayName"
          :seed="userId ?? entry.displayName"
          :src="entry.data?.avatar ?? null"
          class="h-24 w-24 text-3xl"
        />
        <p
          class="text-xl font-semibold"
          :style="entry.nameColor ? { color: `var(--brand-${entry.nameColor})` } : {}"
        >
          {{ entry.displayName }}
        </p>
        <p v-if="entry.data?.bio" class="whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-300">
          {{ entry.data.bio }}
        </p>
        <p v-else class="text-sm text-zinc-400">No bio yet.</p>
      </template>
      <p v-else class="py-8 text-sm text-zinc-400">Could not load this profile.</p>
    </div>
  </AppModal>
</template>
