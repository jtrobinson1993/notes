<script setup lang="ts">
import { computed } from 'vue';
import type { AttachmentRef } from '@notes/shared';
import ChatImageGrid from './ChatImageGrid.vue';
import ChatAttachment from './ChatAttachment.vue';

/**
 * Renders a message's attachments: image attachments collapse into a single
 * `ChatImageGrid` (grid layout + shared, navigable lightbox), and any other
 * files follow as individual download chips.
 */
const props = defineProps<{ attachments: AttachmentRef[] }>();

const images = computed(() => props.attachments.filter((a) => a.type.startsWith('image/')));
const files = computed(() => props.attachments.filter((a) => !a.type.startsWith('image/')));
</script>

<template>
  <ChatImageGrid v-if="images.length" :images="images" />
  <ChatAttachment v-for="a in files" :key="a.id" :attachment="a" />
</template>
