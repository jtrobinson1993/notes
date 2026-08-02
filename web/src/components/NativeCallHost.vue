<script setup lang="ts">
// Global v8 voice call surface: mounts the call panel once (native shell only),
// starts the call wiring on mount (subscribe to rings + signaling) and tears it
// down on unmount. Shares the single call instance (callHost) with the chat
// surface's "call" button, so a placed/incoming call drives this panel.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import NativeCallPanel from './NativeCallPanel.vue';
import { callHost } from '../lib/callHost';
import { peerNameFrom } from '../lib/nativeVoiceCall';
import { friendsList, isNative, type FriendSummary } from '../lib/native';

const { state, peerId, start, stop, accept, decline, hangup } = callHost();

// Resolve the panel's peer label: peerId is a contact id (outgoing) or the
// caller's identity pubkey (incoming) — peerNameFrom maps either to a friend.
const friends = ref<FriendSummary[]>([]);
const peerName = computed(() => peerNameFrom(peerId.value, friends.value));

async function loadFriends(): Promise<void> {
  try {
    friends.value = await friendsList();
  } catch {
    /* not connected / no friends yet — panel falls back to "Unknown" */
  }
}

onMounted(() => {
  if (isNative) {
    void start();
    void loadFriends();
  }
});
onUnmounted(() => stop());
</script>

<template>
  <NativeCallPanel
    v-if="isNative"
    :state="state"
    :peer-name="peerName"
    @accept="accept"
    @decline="decline"
    @hangup="hangup"
  />
</template>
