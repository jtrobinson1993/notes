<script setup lang="ts">
import { computed } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const props = defineProps<{ source: string }>();

const html = computed(() => DOMPurify.sanitize(marked.parse(props.source, { async: false })));
</script>

<template>
  <div class="md-preview" v-html="html" />
</template>
