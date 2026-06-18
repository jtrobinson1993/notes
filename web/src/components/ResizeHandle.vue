<script setup lang="ts">
// A right-edge resize grip: a wide invisible hit area with a 1px line that lights
// up blue on hover/drag. The resting 1px line is the panel's own border. The
// host must be `relative`.
defineProps<{ active?: boolean }>();
const emit = defineEmits<{ start: [PointerEvent] }>();
</script>

<template>
  <div
    class="group/rz absolute inset-y-0 right-0 z-nav w-2 translate-x-1/2 cursor-col-resize touch-none"
    title="Drag to resize"
    @pointerdown.prevent="emit('start', $event)"
  >
    <div
      class="mx-auto h-full w-px transition-colors"
      :class="active ? 'bg-blue-400' : 'bg-transparent group-hover/rz:bg-blue-400'"
    ></div>
  </div>
</template>
