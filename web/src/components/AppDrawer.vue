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
 * Reusable slide-in **drawer**, anchored full-height to the right edge — for
 * secondary, browsable panels (member lists, details) where a centered modal
 * would feel heavy. Same reka-ui Dialog foundation as `AppModal` (Escape /
 * overlay-click / close-button dismiss, focus trap), but it slides in from the
 * side and is full-screen on mobile.
 */
withDefaults(
  defineProps<{
    title: string;
    description?: string;
    /** Tailwind max-width class at the `sm:` breakpoint. */
    widthClass?: string;
  }>(),
  { widthClass: 'sm:max-w-sm' },
);

const open = defineModel<boolean>('open', { default: false });
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <!-- A light scrim to catch outside-clicks, but no blur — the chat stays
           legible behind the drawer. -->
      <DialogOverlay class="app-overlay fixed inset-0 z-drawer bg-black/20" />
      <DialogContent
        class="app-drawer app-safe fixed inset-y-0 right-0 z-drawer flex w-full flex-col bg-white shadow-xl focus:outline-none dark:bg-zinc-900"
        :class="widthClass"
      >
        <div class="flex items-start gap-3 border-b border-zinc-200 p-4 dark:border-zinc-800">
          <div class="min-w-0 grow">
            <DialogTitle class="text-lg font-semibold">{{ title }}</DialogTitle>
            <DialogDescription
              v-if="description"
              class="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400"
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
        <div class="min-h-0 grow overflow-y-auto p-4">
          <slot />
        </div>
        <div v-if="$slots.footer" class="border-t border-zinc-200 p-4 dark:border-zinc-800">
          <slot name="footer" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
