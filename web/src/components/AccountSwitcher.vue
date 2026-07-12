<script setup lang="ts">
// Multi-account switcher (native). Each account is its own encrypted vault;
// switching or adding one restarts the app (the relay/live-delivery tasks are
// single-session, so a fresh process is the clean way to swap them).
import { ref, watch } from 'vue';
import { accountAdd, accountList, accountSwitch, type AccountRegistry } from '../lib/native';
import AppModal from './AppModal.vue';

const open = defineModel<boolean>('open', { default: false });
const registry = ref<AccountRegistry | null>(null);
const busy = ref(false);

watch(open, async (v) => {
  if (v) registry.value = await accountList();
});

async function switchTo(id: string): Promise<void> {
  if (busy.value || id === registry.value?.active) return;
  busy.value = true;
  await accountSwitch(id); // restarts the app into that account's vault
}

async function add(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  await accountAdd(); // restarts into onboarding for a fresh account
}
</script>

<template>
  <AppModal
    v-model:open="open"
    title="Accounts"
    description="Each account has its own encrypted vault. Switching restarts the app."
    max-width="sm:max-w-sm"
  >
    <div class="space-y-2 pb-1">
      <button
        v-for="a in registry?.accounts"
        :key="a.id"
        type="button"
        data-testid="account-row"
        :disabled="busy"
        class="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm disabled:opacity-50"
        :class="
          a.id === registry?.active
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800'
        "
        @click="switchTo(a.id)"
      >
        <span class="font-medium">{{ a.label }}</span>
        <span v-if="a.id === registry?.active" class="text-xs text-blue-500">current</span>
      </button>
      <button
        type="button"
        data-testid="account-add"
        :disabled="busy"
        class="w-full rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        @click="add"
      >
        + Add account
      </button>
    </div>
  </AppModal>
</template>
