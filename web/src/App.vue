<script setup lang="ts">
import { computed, watch } from 'vue';
import { useNotesStore } from './stores/notes';
import { useProfileStore } from './stores/profile';
import { useFriendsStore } from './stores/friends';
import { useOrgStore } from './stores/organization';
import { gateState } from './lib/nativeVault';
import { teardownCallHost } from './lib/callHost';
import { resetNativeChat } from './lib/nativeChat';
import {
  nativeConversations,
  startNativeConversations,
  stopNativeConversations,
} from './lib/nativeConversations';
import { resetTagColors } from './lib/tagColors';
import { initEmoji, teardownEmoji } from './lib/emoji/session';
import NativeGate from './components/NativeGate.vue';
import NativeCallHost from './components/NativeCallHost.vue';
import KtAlarm from './components/KtAlarm.vue';
import AppToasts from './components/AppToasts.vue';

const notes = useNotesStore();
const profile = useProfileStore();
const friends = useFriendsStore();
const org = useOrgStore();

/**
 * Drop everything the master key decrypted. Called whenever the vault gate is
 * anything other than 'ready' — i.e. the vault is locked (idle re-lock, manual
 * "Sign out", a fresh boot before unlock). Decrypted state MUST NOT outlive the
 * master key: note bodies, folder/tag names, friend handles and a live call's
 * media are all plaintext derived from it. The relay mail listener is stopped by
 * `lockVault` itself (draining needs the MK-derived sealing key).
 */
function dropDecryptedState(): void {
  teardownCallHost(); // never let a call outlive the master key
  stopNativeConversations();
  resetNativeChat();
  notes.reset();
  profile.reset();
  friends.reset();
  org.reset();
  resetTagColors();
  teardownEmoji(); // emote blob: URLs are decrypted bytes; the tally is metadata
}

// The vault gate is the "signed in + unlocked" signal. When it opens, load the
// local identity so the chrome shows the handle and start the conversation
// list; when it closes, tear the decrypted world down.
watch(
  () => gateState.value,
  (s) => {
    if (s === 'ready') {
      void profile.load();
      void initEmoji(); // relay origin + usage tally + the offline emote set
      startNativeConversations(); // keep the sidebar chat list current
    } else {
      dropDecryptedState();
    }
  },
  { immediate: true },
);

// Surface total unread in the window title so new messages are visible without
// the app focused.
const totalUnread = computed(() =>
  nativeConversations.value.reduce((n, c) => n + c.unread, 0),
);
const baseTitle = document.title || 'Accord';
watch(
  totalUnread,
  (n) => {
    document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${baseTitle}` : baseTitle;
  },
  { immediate: true },
);
</script>

<template>
  <!-- Inset every page from the device safe areas (one boundary for the whole
       app, incl. the pre-unlock gate). env() insets are 0 on desktop. -->
  <div class="app-safe h-full">
    <!-- The vault wall gates everything. -->
    <NativeGate>
      <RouterView />
      <!-- Global v8 voice call panel. -->
      <NativeCallHost />
      <!-- Key-transparency hard-alarm banner (self-audit on connect). -->
      <KtAlarm />
    </NativeGate>
    <!-- Outside the gate: a failure raised before unlock must still be seen. -->
    <AppToasts />
  </div>
</template>
