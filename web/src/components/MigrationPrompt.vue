<script setup lang="ts">
// One-time legacy migration overlay (spec/migration.md, UI-3 "web migrant").
// Appears in the native shell once the legacy session is unlocked, until the
// pull-everything migration has completed. Re-running is safe (idempotent
// imports), so a mid-run failure just re-offers the button.
import { computed, ref, watch } from 'vue';
import { isNative, settingsGet, settingsSet } from '../lib/native';
import { runLegacyMigration, type MigrationProgress } from '../lib/migrate';
import { useSessionStore } from '../stores/session';

const DONE_KEY = 'migration.done';

const session = useSessionStore();
const status = ref<'unknown' | 'pending' | 'running' | 'done' | 'failed'>('unknown');
const progress = ref<MigrationProgress | null>(null);
const error = ref('');

const visible = computed(
  () => isNative && session.unlocked && (status.value === 'pending' || status.value === 'running' || status.value === 'failed'),
);

watch(
  () => session.unlocked,
  async (unlocked) => {
    if (!isNative || !unlocked || status.value !== 'unknown') return;
    status.value = (await settingsGet(DONE_KEY)) === '1' ? 'done' : 'pending';
  },
  { immediate: true },
);

async function migrate() {
  if (!session.mk) return;
  status.value = 'running';
  error.value = '';
  try {
    const keyPair = await session.getKeyPair();
    const summary = await runLegacyMigration(session.mk, keyPair, (p) => {
      progress.value = p;
    });
    await settingsSet(DONE_KEY, '1');
    await settingsSet('migration.summary', JSON.stringify(summary));
    status.value = 'done';
  } catch (e) {
    error.value = String(e);
    status.value = 'failed';
  }
}

const stageLabel = computed(() => {
  const p = progress.value;
  if (!p) return '';
  const counts = p.total !== null ? ` (${p.done}/${p.total})` : ` (${p.done})`;
  return `${{ notes: 'Notes', contacts: 'Friends', conversations: 'Chats', messages: 'Messages', done: 'Finishing' }[p.stage]}${counts}`;
});
</script>

<template>
  <div
    v-if="visible"
    class="fixed inset-0 z-modal flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
  >
    <div class="w-full max-w-sm space-y-4 rounded-lg border border-neutral-500/30 bg-neutral-900 p-5">
      <h2 class="text-lg font-semibold">Move your data onto this device</h2>
      <p class="text-sm opacity-70">
        Your notes and chat history will be downloaded, decrypted, and stored
        encrypted on this device. This happens once.
      </p>
      <p v-if="status === 'running'" class="text-sm" data-testid="migration-progress">
        {{ stageLabel }}
      </p>
      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
      <button
        :disabled="status === 'running'"
        class="w-full rounded bg-blue-600 px-3 py-2 font-medium text-white disabled:opacity-50"
        @click="migrate"
      >
        {{ status === 'running' ? 'Migrating…' : status === 'failed' ? 'Retry migration' : 'Start migration' }}
      </button>
    </div>
  </div>
</template>
