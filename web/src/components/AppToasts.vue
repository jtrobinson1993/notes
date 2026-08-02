<script setup lang="ts">
// Renders the toast queue. Mounted once, above the vault gate, so a failure
// raised before unlock is still visible. Uses the `z-tooltip` layer (the top of
// the named scale in style.css) so a toast is never clipped by a modal.
import { dismissToast, toasts } from '../lib/toast';
import IconDanger from '~icons/mynaui/danger-triangle';
import IconInfoCircle from '~icons/mynaui/info-circle';
import IconX from '~icons/mynaui/x';
</script>

<template>
  <div
    class="app-safe pointer-events-none fixed inset-x-0 bottom-0 z-tooltip flex flex-col items-center gap-2 p-4"
    role="status"
    aria-live="polite"
  >
    <TransitionGroup
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-for="t in toasts"
        :key="t.id"
        data-testid="toast"
        :data-code="t.code"
        class="pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-lg backdrop-blur"
        :class="
          t.kind === 'error'
            ? 'border-red-300 bg-red-50/95 text-red-900 dark:border-red-800/70 dark:bg-red-950/90 dark:text-red-100'
            : 'border-zinc-300 bg-white/95 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-100'
        "
      >
        <component
          :is="t.kind === 'error' ? IconDanger : IconInfoCircle"
          class="mt-0.5 h-4 w-4 shrink-0"
          :class="t.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-zinc-400'"
        />
        <div class="min-w-0 grow">
          <p class="text-sm font-medium">{{ t.message }}</p>
          <p v-if="t.hint" class="mt-0.5 text-xs opacity-80">{{ t.hint }}</p>
          <!-- The code is shown verbatim so a user can search it on the site. -->
          <p v-if="t.code" class="mt-1 font-mono text-[10px] opacity-60">{{ t.code }}</p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          class="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
          @click="dismissToast(t.id)"
        >
          <IconX class="h-3.5 w-3.5" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
