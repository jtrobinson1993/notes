<script setup lang="ts">
// Device-lock controls (D4 layer A) — native shell only. The policy is a
// per-device setting in the encrypted vault DB; changing it re-arms the idle
// re-locker immediately.
import { onMounted, ref } from 'vue';
import { settingsGet, settingsSet } from '../../lib/native';
import { applyRelockPolicy, lockVault } from '../../lib/nativeVault';

const policy = ref<'stay' | 'on-idle'>('stay');
const minutes = ref(15);
const busy = ref(false);

onMounted(async () => {
  policy.value = ((await settingsGet('relock.policy')) as 'stay' | 'on-idle' | null) ?? 'stay';
  minutes.value = Number((await settingsGet('relock.idleMinutes')) ?? '') || 15;
});

async function save() {
  busy.value = true;
  try {
    await settingsSet('relock.policy', policy.value);
    await settingsSet('relock.idleMinutes', String(Math.max(1, minutes.value)));
    await applyRelockPolicy();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-3">
    <div
      class="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
    >
      <div>
        <p class="text-sm">Require unlock</p>
        <p class="text-xs text-zinc-500 dark:text-zinc-400">
          Your vault stays unlocked while the app runs. Optionally re-lock it
          after a period with no activity — you'll unlock with biometrics or
          your password.
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <select
          v-model="policy"
          :disabled="busy"
          class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
          @change="save"
        >
          <option value="stay">Stay unlocked</option>
          <option value="on-idle">Lock when idle</option>
        </select>
        <template v-if="policy === 'on-idle'">
          <input
            v-model.number="minutes"
            type="number"
            min="1"
            max="480"
            :disabled="busy"
            class="w-16 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
            @change="save"
          />
          <span class="text-xs text-zinc-500 dark:text-zinc-400">min</span>
        </template>
      </div>
    </div>
    <div
      class="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
    >
      <div>
        <p class="text-sm">Lock now</p>
        <p class="text-xs text-zinc-500 dark:text-zinc-400">
          Immediately locks the local vault on this device.
        </p>
      </div>
      <button
        class="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        @click="lockVault"
      >
        Lock
      </button>
    </div>
  </div>
</template>
