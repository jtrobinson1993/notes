<script setup lang="ts">
// v8 local-first DM page (native shell only). Wraps the self-contained
// NativeChat surface in the app chrome; in the browser there is no native DM
// store, so the route redirects home.
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import NativeChat from '../components/NativeChat.vue';
import { isNative } from '../lib/native';

const router = useRouter();
onMounted(() => {
  if (!isNative) void router.replace('/');
});
</script>

<template>
  <AppLayout>
    <NativeChat v-if="isNative" />
  </AppLayout>
</template>
