<script setup lang="ts">
// Global v8 voice call surface: mounts the call panel once (native shell only),
// starts the call wiring on mount (subscribe to rings + signaling) and tears it
// down on unmount. Shares the single call instance (callHost) with the chat
// surface's "call" button, so a placed/incoming call drives this panel.
import { onMounted, onUnmounted } from 'vue';
import NativeCallPanel from './NativeCallPanel.vue';
import { callHost } from '../lib/callHost';
import { isNative } from '../lib/native';

const { state, peerId, start, stop, accept, decline, hangup } = callHost();

onMounted(() => {
  if (isNative) void start();
});
onUnmounted(() => stop());
</script>

<template>
  <NativeCallPanel
    v-if="isNative"
    :state="state"
    :peer-name="peerId"
    @accept="accept"
    @decline="decline"
    @hangup="hangup"
  />
</template>
