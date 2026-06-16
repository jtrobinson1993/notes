<script setup lang="ts">
import { TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from 'reka-ui';

/** Wraps a sidebar item and shows its label in an instant tooltip to the right
 *  on hover. Used for the collapsed rail, where item labels are hidden; pass
 *  `disabled` (e.g. when the sidebar is expanded) to suppress it. Relies on an
 *  ancestor <TooltipProvider>. */
defineProps<{ label: string; disabled?: boolean }>();
</script>

<template>
  <TooltipRoot v-if="!disabled" :delay-duration="0" disable-closing-trigger>
    <TooltipTrigger as-child>
      <slot />
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent
        side="right"
        :side-offset="8"
        class="z-tooltip select-none rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white shadow-lg dark:bg-zinc-700"
      >
        {{ label }}
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
  <slot v-else />
</template>
