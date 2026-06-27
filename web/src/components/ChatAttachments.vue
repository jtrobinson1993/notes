<script setup lang="ts">
import { computed } from 'vue';
import type { AttachmentRef } from '@notes/shared';
import ChatImageGrid from './ChatImageGrid.vue';
import ChatAttachment from './ChatAttachment.vue';
import ChatMedia from './ChatMedia.vue';
import { mediaKind } from '../lib/fileMeta';

/**
 * Renders a message's attachments: images collapse into a single `ChatImageGrid`
 * (grid layout + shared, navigable lightbox), audio/video play inline via
 * `ChatMedia`, and any other files follow as individual download chips.
 */
const props = defineProps<{ attachments: AttachmentRef[] }>();

const images = computed(() => props.attachments.filter((a) => a.type.startsWith('image/')));
const media = computed(() =>
  props.attachments.flatMap((a) => {
    const kind = mediaKind(a.type);
    return kind ? [{ ref: a, kind }] : [];
  }),
);
const files = computed(() =>
  props.attachments.filter((a) => !a.type.startsWith('image/') && !mediaKind(a.type)),
);
</script>

<template>
  <ChatImageGrid v-if="images.length" :images="images" />
  <ChatMedia v-for="m in media" :key="m.ref.id" :attachment="m.ref" :kind="m.kind" />
  <ChatAttachment v-for="a in files" :key="a.id" :attachment="a" />
</template>
