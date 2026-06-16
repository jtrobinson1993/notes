<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import IconX from '~icons/mynaui/x';

/**
 * Reusable modal for primary, blocking actions — the user shouldn't reach the
 * rest of the app until they finish or cancel. Centered with a fixed max-width
 * and capped height on desktop; full-screen on mobile. Built on reka-ui's Dialog
 * with an overlay blur.
 */
withDefaults(
  defineProps<{
    title: string;
    description?: string;
    /** Tailwind max-width class applied at the `sm:` breakpoint. */
    maxWidth?: string;
  }>(),
  { maxWidth: 'sm:max-w-md' },
);

const open = defineModel<boolean>('open', { default: false });
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-modal bg-black/40 backdrop-blur-sm" />
      <DialogContent
        class="fixed inset-0 z-modal flex flex-col bg-white shadow-xl dark:bg-zinc-900 sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-h-[80vh] sm:w-[90vw] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
        :class="maxWidth"
      >
        <div class="flex items-start gap-3 p-5 pb-3">
          <div class="min-w-0 grow">
            <DialogTitle class="text-lg font-semibold">{{ title }}</DialogTitle>
            <DialogDescription
              v-if="description"
              class="mt-1 text-sm text-zinc-500 dark:text-zinc-400"
            >
              {{ description }}
            </DialogDescription>
          </div>
          <DialogClose
            class="-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Close"
          >
            <IconX class="h-5 w-5" />
          </DialogClose>
        </div>
        <div class="min-h-0 grow overflow-y-auto px-5">
          <slot />
        </div>
        <div v-if="$slots.footer" class="flex justify-end gap-2 p-5 pt-3">
          <slot name="footer" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
