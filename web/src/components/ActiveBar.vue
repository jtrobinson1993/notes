<script setup lang="ts">
// The "you are here" indicator for a sidebar item: a black (light theme) / white
// (dark theme) pill on the left edge of the screen, rounded on its right side.
// It scales up + fades in from the left edge with a bouncy curve. The parent must
// be `relative`.
defineProps<{ active: boolean }>();
</script>

<template>
  <Transition
    enter-active-class="origin-left transition duration-300 ease-[cubic-bezier(0.34,1.8,0.5,1)]"
    enter-from-class="scale-0 opacity-0"
    enter-to-class="scale-100 opacity-100"
    leave-active-class="origin-left transition duration-150 ease-in"
    leave-from-class="scale-100 opacity-100"
    leave-to-class="scale-0 opacity-0"
  >
    <span
      v-if="active"
      class="pointer-events-none absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-black dark:bg-white"
    />
  </Transition>
</template>
